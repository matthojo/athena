/**
 * When flows start (lib/flow-types.ts FlowTrigger). The reminders job calls
 * queueFlowRuns every 5 minutes, beside Team's pass (lib/team-triggers.ts);
 * the owner's own actions start their flows at once (startFlowEvent).
 *
 * - schedule: routines' slot maths (lib/routines.ts dueSlot), on chosen
 *   weekdays at a time in the owner's zone.
 * - event: new `team_events` rows matched against the trigger's EventFilter
 *   (Team's matchesFilter). Flows claim events with their own column
 *   (`flow_claimed_at`, migration 0081), so Team and flows each see every
 *   event once and neither takes one from the other. A flow run by an
 *   assistant gets all its matching events in a pass together in one run, as
 *   Team batches; a plain flow starts one run per event, at most
 *   FLOW_RUNS_PER_PASS a pass, and the rest wait for the next pass.
 * - before/event: `minutes` before a timed event on the calendar; with
 *   `withPeople`, only events with at least one person from People.
 * - before/date: `days` before a date (a birthday, a deadline, a renewal) at
 *   `at` in the owner's zone.
 *
 * Every fire (a schedule slot, one event's "before", one date's "before",
 * one flow's run for one event) is
 * claimed once per flow in `flow_trigger_fires`, so overlapping passes never
 * start it twice. A fire more than RUN_WINDOW_MINUTES late is skipped, never
 * run late in a burst (a "before" is never run after the event started), and
 * nothing fires for a time or an event from before the flow was made.
 *
 * The engine (FlowSource, FlowStarter) and the stores are passed in: the
 * database versions are in lib/flow-triggers-db.ts.
 */
import { addDays, zonedParts, zonedToInstant, zonedToday } from "./dates";
import { dueSlot, parseTime, RUN_WINDOW_MINUTES, scheduleWords } from "./routines";
import { fromAgent, matchesFilter } from "./team-triggers";
import { runLabel } from "./team-run";
import type { TeamEventRow } from "./team-events";
import type { FlowSource, FlowStarter, FlowTrigger } from "./flow-types";
import { triggerGives } from "./flow-trigger-gives";

/** What each trigger gives later steps: the one list (lib/flow-trigger-gives.ts, pure so the app can read it too). */
export { triggerGives };

/** Events read in one pass, as Team's. */
export const FLOW_EVENTS_PER_PASS = 200;
/**
 * The most runs a plain flow (no assistant) starts from events in one pass.
 * Its other matching events stay unclaimed and come round in the next pass,
 * 5 minutes later, so a burst of 30 emails becomes 10 runs, then 10, then 10.
 */
export const FLOW_RUNS_PER_PASS = 10;
/** The furthest ahead a "before an event" trigger looks: a week. */
export const MAX_BEFORE_MINUTES = 7 * 24 * 60;
/** The furthest ahead a "before a date" trigger looks: a year. */
export const MAX_BEFORE_DAYS = 366;
/** A "before" right at the start (0 minutes) may still fire this late. */
const AT_START_GRACE_MINUTES = 10;
const MIN = 60_000;

type ActiveFlow = Awaited<ReturnType<FlowSource["listActive"]>>[number];

// ---------- what the stores give ----------

/** A timed event on the calendar, one occurrence. */
export interface TimedItem {
  id: string;
  title: string;
  /** UTC instant it starts. */
  starts_at: string;
  /** People from People linked to it (attendees Athena knows). */
  people: Array<{ id: string; name: string }>;
}

/** A dated thing on one local day: an event occurrence (a birthday, a deadline) or a renewal. */
export interface DatedItem {
  /** Where it lives: an `events` row or a life-admin `assets` row. */
  source: "event" | "renewal";
  id: string;
  title: string;
  /** The event's kind ("birthday", "deadline"…), or "renewal". */
  kind: string;
  /** The local day it falls on, YYYY-MM-DD. */
  date: string;
  /** A birthday's or anniversary's person. */
  person?: { id: string; name: string } | null;
  /** A renewal's provider. */
  company?: string | null;
  /** The age turned, or the anniversary's number, when known. */
  years?: number | null;
}

export interface FlowClaims {
  /** Claim one fire for one flow: false when another pass has it. */
  fire(flowId: string, key: string, at: Date): Promise<boolean>;
  /** Give a fire back, when its run couldn't be started: the next pass may try again in the window. */
  release(flowId: string, key: string): Promise<void>;
  /**
   * Read the oldest events flows haven't finished with, without marking them.
   * Each flow claims each event as a fire (`event:<id>`), so overlapping
   * passes, and an owner action, never start one flow on one event twice.
   */
  pending(limit: number): Promise<TeamEventRow[]>;
  /** Mark events finished with: every flow they match has had them. */
  seen(ids: string[]): Promise<void>;
  /** Read one event flows haven't finished with (an owner action), without marking it, or null. */
  event(id: string): Promise<TeamEventRow | null>;
  /** Drop fires that can't come round again. */
  prune?(now: Date): Promise<number>;
}

export interface FlowCalendar {
  /** Timed occurrences starting in [from, to], declined, archived and back-filled ones left out. */
  timed(from: Date, to: Date): Promise<TimedItem[]>;
  /** Events and renewals that fall on any of these local days. */
  dated(dates: string[]): Promise<DatedItem[]>;
}

export interface FlowTriggerDeps {
  source: FlowSource;
  starter: FlowStarter;
  /** The owner's zone. */
  tz: string;
  claims: FlowClaims;
  calendar: FlowCalendar;
  /** More values from the record an event points at (a renewal's company and date). Optional. */
  items?: (ev: TeamEventRow) => Promise<Record<string, unknown>>;
}

export interface QueuedFlowRun {
  flow_id: string;
  run_id: string;
  label: string;
}

// ---------- what a trigger gives later steps ----------

const lower = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** Only the keys the trigger gives, and only those with a value. Pure. */
export function pickValues(trigger: FlowTrigger, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key } of triggerGives(trigger)) {
    const x = raw[key];
    if (x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length)) continue;
    out[key] = x;
  }
  return out;
}

// ---------- when each kind is due (pure) ----------

const createdBy = (flow: Pick<ActiveFlow, "created_at">, at: Date) => Date.parse(flow.created_at) <= at.getTime();
const matches = (title: string, match: string | undefined) => !match?.trim() || title.toLowerCase().includes(match.trim().toLowerCase());
const clampInt = (n: unknown, lo: number, hi: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo);
const safeTime = (s: string) => {
  try {
    return parseTime(s);
  } catch {
    return null;
  }
};

/** A schedule trigger's slot due now, or null. Pure. */
export function dueSchedule(t: Extract<FlowTrigger, { kind: "schedule" }>, flow: Pick<ActiveFlow, "created_at">, now: Date, tz: string): Date | null {
  const time = safeTime(t.time);
  if (!time || !t.days?.length) return null;
  return dueSlot({ days: t.days, time, paused: false, last_slot: null, created_at: flow.created_at }, now, tz);
}

/** How late a "before an event" may fire: never after the event starts, and never more than the run window. */
const beforeEventWindow = (minutes: number) => Math.min(RUN_WINDOW_MINUTES, minutes > 0 ? minutes : AT_START_GRACE_MINUTES) * MIN;

/** The span of start times a pass must read for "before an event" triggers, or null when there are none. Pure. */
export function timedRange(triggers: FlowTrigger[], now: Date): { from: Date; to: Date } | null {
  const mins = triggers.flatMap((t) => (t.kind === "before" && t.what === "event" ? [clampInt(t.minutes, 0, MAX_BEFORE_MINUTES)] : []));
  if (!mins.length) return null;
  return { from: new Date(now.getTime() - AT_START_GRACE_MINUTES * MIN), to: new Date(now.getTime() + Math.max(...mins) * MIN) };
}

/** The events a "before an event" trigger fires for now. Pure. */
export function dueBeforeEvent(t: Extract<FlowTrigger, { kind: "before"; what: "event" }>, flow: Pick<ActiveFlow, "created_at">, items: TimedItem[], now: Date): Array<{ item: TimedItem; at: Date; key: string }> {
  const minutes = clampInt(t.minutes, 0, MAX_BEFORE_MINUTES);
  const out: Array<{ item: TimedItem; at: Date; key: string }> = [];
  for (const item of items) {
    const start = Date.parse(item.starts_at);
    if (!Number.isFinite(start)) continue;
    if (t.withPeople && !item.people.length) continue;
    if (!matches(item.title, t.match)) continue;
    const at = new Date(start - minutes * MIN);
    const late = now.getTime() - at.getTime();
    if (late < 0 || late > beforeEventWindow(minutes)) continue;
    if (!createdBy(flow, at)) continue;
    out.push({ item, at, key: `before-event:${item.id}:${new Date(start).toISOString()}` });
  }
  return out;
}

/** The local days a pass must read for "before a date" triggers: each trigger's `days` on from yesterday and today. Pure. */
export function datedDays(triggers: FlowTrigger[], now: Date, tz: string): string[] {
  const today = zonedToday(now, tz);
  const out = new Set<string>();
  for (const t of triggers) {
    if (t.kind !== "before" || t.what !== "date") continue;
    const days = clampInt(t.days, 0, MAX_BEFORE_DAYS);
    out.add(addDays(addDays(today, -1), days));
    out.add(addDays(today, days));
  }
  return [...out].sort();
}

/** The dated things a "before a date" trigger fires for now. Pure. */
export function dueBeforeDate(t: Extract<FlowTrigger, { kind: "before"; what: "date" }>, flow: Pick<ActiveFlow, "created_at">, items: DatedItem[], now: Date, tz: string): Array<{ item: DatedItem; at: Date; key: string }> {
  const time = safeTime(t.at);
  if (!time) return [];
  const days = clampInt(t.days, 0, MAX_BEFORE_DAYS);
  const kind = lower(t.eventKind);
  const out: Array<{ item: DatedItem; at: Date; key: string }> = [];
  for (const item of items) {
    // Renewals only when asked for by name: "before a date" on its own means the calendar.
    if (kind ? lower(item.kind) !== kind : item.source !== "event") continue;
    if (!matches(item.title, t.match)) continue;
    const at = zonedToInstant(addDays(item.date, -days), time, tz);
    const late = now.getTime() - at.getTime();
    if (late < 0 || late > RUN_WINDOW_MINUTES * MIN) continue;
    if (!createdBy(flow, at)) continue;
    out.push({ item, at, key: `before-date:${item.source}:${item.id}:${item.date}` });
  }
  return out;
}

/** One of an assistant's job flows: one of its triggers, made a flow (lib/team-flows.ts). Pure. */
export const isJobFlow = (f: Pick<ActiveFlow, "assistant_id"> & { origin?: string }): boolean => !!f.assistant_id && (f.origin === "trigger" || f.origin === "shared");

/**
 * Which flows' event triggers an event fires. An assistant's job flows are its triggers, and an event fired each
 * assistant once (its first matching trigger): so it fires only the first of each assistant's job flows that
 * match. Pure.
 */
export function flowsForEvent(ev: Pick<TeamEventRow, "kind" | "facets" | "created_at" | "processed_at">, flows: ActiveFlow[]): ActiveFlow[] {
  const jobs = new Set<string>();
  return flows.filter((f) => {
    if (f.trigger.kind !== "event" || !f.trigger.event || !createdBy(f, new Date(ev.created_at)) || !matchesFilter(f.trigger.event, ev)) return false;
    // An imported flow, or an imported assistant's job, doesn't start on what an agent made (team-triggers.ts fromAgent).
    if (f.origin === "shared" && fromAgent(ev)) return false;
    if (!isJobFlow(f)) return true;
    // Claimed by Team's pass before this job flow was made: the trigger it was moved from had it.
    if (ev.processed_at && f.handed_at && Date.parse(ev.processed_at) < Date.parse(f.handed_at)) return false;
    if (jobs.has(f.assistant_id!)) return false;
    jobs.add(f.assistant_id!);
    return true;
  });
}

/**
 * A pass's events grouped by flow, oldest first. An assistant's job flows go together, as its triggers did: every
 * event that matched any of them in the pass is one batch, run by the job flow its first event fired. Pure.
 */
export function batchByFlow(events: TeamEventRow[], flows: ActiveFlow[]): Array<{ flow: ActiveFlow; events: TeamEventRow[] }> {
  const out = new Map<string, { flow: ActiveFlow; events: TeamEventRow[] }>();
  for (const ev of [...events].sort((a, b) => Number(a.id) - Number(b.id))) {
    for (const flow of flowsForEvent(ev, flows)) {
      const key = isJobFlow(flow) ? `job:${flow.assistant_id}` : flow.id;
      const b = out.get(key) ?? { flow, events: [] };
      b.events.push(ev);
      out.set(key, b);
    }
  }
  return [...out.values()];
}

// ---------- values and labels (pure) ----------

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : null);
const hhmm = (iso: string, tz: string) => {
  const p = zonedParts(new Date(iso), tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const clip = (s: string, max = 60) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** A schedule slot's values. Pure. */
export function scheduleValues(slot: Date, tz: string): Record<string, unknown> {
  return { date: zonedToday(slot, tz), time: slot.toISOString() };
}

/** A "before an event" fire's values. Pure. */
export function beforeEventValues(item: TimedItem): Record<string, unknown> {
  return { event: { id: item.id, title: item.title }, people: item.people.map((p) => ({ id: p.id, name: p.name })), starts_at: new Date(item.starts_at).toISOString(), title: item.title };
}

/** A "before a date" fire's values. Pure. */
export function beforeDateValues(item: DatedItem): Record<string, unknown> {
  if (item.source === "renewal") return { item: item.title, company: item.company ? { id: null, name: item.company } : null, renewal_date: item.date, title: item.title };
  return { event: { id: item.id, title: item.title }, person: item.person ?? null, date: item.date, years: item.years ?? null, title: item.title };
}

/** What events give: the newest one's values, and how many came in (1 for a plain flow's run). Pure. */
export function eventValues(events: TeamEventRow[]): Record<string, unknown> {
  const ev = events[events.length - 1];
  if (!ev) return { count: 0 };
  const f = ev.facets ?? {};
  const title = str(f.title);
  const tags = Array.isArray(f.tags) ? f.tags.join(", ") : null;
  return {
    item: ev.ref_id ? { id: ev.ref_id, kind: ev.ref_kind, title } : null,
    title,
    website: str(f.host),
    tags,
    count: events.length,
  };
}

/** What set a run off, in words. Pure. */
export function fireLabel(trigger: FlowTrigger, fire: { slot?: Date; timed?: TimedItem; dated?: DatedItem; events?: TeamEventRow[] }, tz: string): string {
  if (trigger.kind === "schedule") return scheduleWords({ days: trigger.days, time: safeTime(trigger.time) ?? trigger.time });
  if (fire.events?.length) return runLabel(null, fire.events);
  if (fire.timed) return `Before “${clip(fire.timed.title)}” at ${hhmm(fire.timed.starts_at, tz)}`;
  if (fire.dated && trigger.kind === "before" && trigger.what === "date") {
    const days = clampInt(trigger.days, 0, MAX_BEFORE_DAYS);
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    return `“${clip(fire.dated.title)}” ${when}`;
  }
  return "Run now";
}

// ---------- a pass ----------

async function startOne(deps: Pick<FlowTriggerDeps, "starter">, flow: ActiveFlow, start: Parameters<FlowStarter["start"]>[1], out: QueuedFlowRun[]): Promise<boolean> {
  const id = await deps.starter.start(flow.id, start);
  if (id) out.push({ flow_id: flow.id, run_id: id, label: start.label });
  return !!id;
}

/** Claim a fire, start its run, and give the claim back when the start throws, so a later pass in the window can try. */
async function fireOnce(deps: FlowTriggerDeps, flow: ActiveFlow, key: string, at: Date, start: Parameters<FlowStarter["start"]>[1], out: QueuedFlowRun[]): Promise<void> {
  if (!(await deps.claims.fire(flow.id, key, at))) return;
  try {
    await startOne(deps, flow, start, out);
  } catch (error) {
    console.error("Athena flows: couldn't start a run; the next pass may", (error as Error)?.message?.slice(0, 120));
    await deps.claims.release(flow.id, key).catch(() => undefined);
  }
}

/** Does this flow get a pass's events together (run by an assistant) or one run each (plain)? */
export const batchesEvents = (flow: Pick<ActiveFlow, "assistant_id">) => !!flow.assistant_id;

/**
 * Start the runs a set of events gives. An assistant's flow gets its events
 * together in one run; a plain flow gets one run per event, oldest first, at
 * most `cap`. Each (flow, event) is claimed as a fire first. Returns the ids
 * of events a plain flow left for later (over its cap, or a start that
 * failed), which must stay unclaimed.
 */
async function startEventRuns(deps: Pick<FlowTriggerDeps, "starter" | "items" | "claims">, events: TeamEventRow[], flows: ActiveFlow[], out: QueuedFlowRun[], tz: string, cap: number): Promise<Set<string>> {
  const left = new Set<string>();
  const key = (e: TeamEventRow) => `event:${e.id}`;
  const now = new Date();
  for (const { flow, events: evs } of batchByFlow(events, flows)) {
    if (batchesEvents(flow)) {
      const mine: TeamEventRow[] = [];
      for (const e of evs) if (await deps.claims.fire(flow.id, key(e), now)) mine.push(e);
      if (!mine.length) continue;
      try {
        const last = mine[mine.length - 1];
        const more = deps.items ? await deps.items(last).catch(() => ({})) : {};
        const values = pickValues(flow.trigger, { ...eventValues(mine), ...more });
        await startOne(deps, flow, { label: fireLabel(flow.trigger, { events: mine }, tz), values, event_ids: mine.map((e) => e.id) }, out);
      } catch (error) {
        // An assistant's batch isn't retried: its events are marked seen, as Team's are.
        console.error("Athena flows: couldn't start an event's run", (error as Error)?.message?.slice(0, 120));
      }
      continue;
    }
    let started = 0;
    for (const e of evs) {
      if (started >= cap) {
        left.add(e.id);
        continue;
      }
      if (!(await deps.claims.fire(flow.id, key(e), now))) continue;
      try {
        const more = deps.items ? await deps.items(e).catch(() => ({})) : {};
        const values = pickValues(flow.trigger, { ...eventValues([e]), ...more });
        await startOne(deps, flow, { label: fireLabel(flow.trigger, { events: [e] }, tz), values, event_ids: [e.id] }, out);
        started++;
      } catch (error) {
        console.error("Athena flows: couldn't start an event's run; the next pass may", (error as Error)?.message?.slice(0, 120));
        await deps.claims.release(flow.id, key(e)).catch(() => undefined);
        left.add(e.id);
      }
    }
  }
  return left;
}

/**
 * One pass: due schedule slots, "before" fires and new events become runs.
 * A slot or a "before" is one run. An assistant's flow gets its matching
 * events together in one run; a plain flow gets one run per event, at most
 * FLOW_RUNS_PER_PASS, and its other events stay unclaimed for the next pass.
 * Returns the runs started.
 */
export async function queueFlowRuns(deps: FlowTriggerDeps, now: Date): Promise<QueuedFlowRun[]> {
  const { tz } = deps;
  const flows = await deps.source.listActive();
  const out: QueuedFlowRun[] = [];

  for (const flow of flows) {
    const t = flow.trigger;
    if (t.kind !== "schedule") continue;
    const slot = dueSchedule(t, flow, now, tz);
    if (slot) await fireOnce(deps, flow, `schedule:${slot.toISOString()}`, slot, { label: fireLabel(t, { slot }, tz), values: pickValues(t, scheduleValues(slot, tz)), slot: slot.toISOString() }, out);
  }

  const triggers = flows.map((f) => f.trigger);
  const range = timedRange(triggers, now);
  if (range) {
    const items = await deps.calendar.timed(range.from, range.to);
    for (const flow of flows) {
      const t = flow.trigger;
      if (t.kind !== "before" || t.what !== "event") continue;
      for (const { item, at, key } of dueBeforeEvent(t, flow, items, now)) {
        await fireOnce(deps, flow, key, at, { label: fireLabel(t, { timed: item }, tz), values: pickValues(t, beforeEventValues(item)), slot: at.toISOString() }, out);
      }
    }
  }

  const days = datedDays(triggers, now, tz);
  if (days.length) {
    const items = await deps.calendar.dated(days);
    for (const flow of flows) {
      const t = flow.trigger;
      if (t.kind !== "before" || t.what !== "date") continue;
      for (const { item, at, key } of dueBeforeDate(t, flow, items, now, tz)) {
        await fireOnce(deps, flow, key, at, { label: fireLabel(t, { dated: item }, tz), values: pickValues(t, beforeDateValues(item)), slot: at.toISOString() }, out);
      }
    }
  }

  // Events are marked seen even when no flow waits for them, so the queue doesn't grow; only the ones a
  // plain flow left for later stay.
  const events = await deps.claims.pending(FLOW_EVENTS_PER_PASS);
  if (events.length) {
    const left = await startEventRuns(deps, events, flows, out, tz, FLOW_RUNS_PER_PASS);
    const done = events.filter((e) => !left.has(e.id)).map((e) => e.id);
    if (done.length) await deps.claims.seen(done);
  }

  await deps.claims.prune?.(now).catch(() => 0);
  return out;
}

/**
 * Something the owner did (a save, a tagged note): start the flows it fires
 * now rather than at the next pass. Each flow claims the event as a fire
 * first, so a pass that reads it too can't start it again. Never throws: a save must not fail because a flow
 * couldn't start. Returns the runs started.
 */
export async function startFlowEvent(deps: Pick<FlowTriggerDeps, "source" | "starter" | "claims" | "items"> & { tz?: string }, eventId: string): Promise<QueuedFlowRun[]> {
  const out: QueuedFlowRun[] = [];
  try {
    const flows = await deps.source.listActive();
    // Nobody waits for events: leave it for the pass, which marks it seen.
    if (!flows.some((f) => f.trigger.kind === "event")) return out;
    const ev = await deps.claims.event(eventId);
    if (!ev) return out;
    // One event: one run per flow at most. A start that failed leaves it for the pass to try again.
    const left = await startEventRuns(deps, [ev], flows, out, deps.tz ?? "UTC", 1);
    // Marked seen only when a flow took it: one that matched nothing now is left for the pass, which may know more
    // (an assistant's trigger that moved to its flow since).
    if (!left.size && out.length) await deps.claims.seen([ev.id]);
  } catch (error) {
    console.error("Athena flows: couldn't start an event's flows now", (error as Error)?.message?.slice(0, 120));
  }
  return out;
}

export type { ActiveFlow };
