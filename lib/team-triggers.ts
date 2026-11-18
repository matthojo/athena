/**
 * When Team assistants run (docs/team.md): the reminders job calls
 * queueTeamRuns every 5 minutes, next to routines.
 *
 * - Schedule triggers use routines' slot maths (lib/routines.ts dueSlot): on
 *   chosen weekdays at a time in the owner's zone; a slot missed by more than
 *   RUN_WINDOW_MINUTES is skipped. Each slot is claimed once in the trigger's
 *   own row (`last_slot`), so overlapping passes never run it twice.
 * - Event triggers match new `team_events` rows (lib/team-events.ts) against
 *   their EventFilter. Each event is claimed once (`processed_at`) before it's
 *   matched, so a row is only ever looked at by one pass.
 *
 * Every event that matches one assistant in a pass goes into one batched run
 * (the events' ids in `team_runs.event_ids`): 30 Linear issues at once make
 * one run, one conversation and one nudge. A schedule slot is its own run.
 *
 * A match becomes a queued `team_runs` row; the background function
 * (netlify/functions/team-run.ts) runs it.
 *
 * Things the owner does (a save, a gift idea, a tagged note) don't wait for
 * the pass (owner, 15 Nov: "Yes, at once for my own actions"): startTeamEvent
 * claims that one event, queues its runs and hands them off straight away.
 * Collected items stay on the pass, where batching matters. Paused assistants and triggers
 * don't fire, nor do triggers on events from before they were made.
 */
import { aiConfigured } from "./ai";
import { qRaw, tx } from "./db";
import { dueSlot } from "./routines";
import { listAssistants } from "./team";
import { enqueueTeamRun, handOffTeamRun, runLabel, teamOrigin } from "./team-run";
import { emitTeamEvent, type TeamEventFacets, type TeamEventRow } from "./team-events";
import type { EventFilter, EventSource, TeamAssistant, TeamRun, TeamTrigger } from "./team-types";

/** Events looked at in one pass. */
export const EVENTS_PER_PASS = 200;

const lower = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");
/** "gift-idea", "gift_idea" and "Gift idea" are one action. */
const actionKey = (s: unknown) => lower(s).replace(/[\s-]+/g, "_");

/** Whether an event is one this filter waits for. Pure. */
export function matchesFilter(f: EventFilter, ev: Pick<TeamEventRow, "kind" | "facets">): boolean {
  if (f.source !== ev.kind) return false;
  const facets = ev.facets ?? {};
  if (f.connector && lower(f.connector) !== lower(facets.connector)) return false;
  // "An email arrives" is anything email set off: a kept email, and the delivery, booking, date, renewal or alert it became.
  if (f.kind && lower(f.kind) !== lower(facets.kind) && !(lower(f.kind) === "email" && facets.email === true)) return false;
  if (f.savedAction && actionKey(f.savedAction) !== actionKey(facets.savedAction)) return false;
  if (f.tag) {
    const tags = Array.isArray(facets.tags) ? facets.tags.map(lower) : [];
    if (!tags.includes(lower(f.tag.replace(/^#/, "")))) return false;
  }
  if (f.match && !lower(facets.title).includes(lower(f.match))) return false;
  return true;
}

/** The schedule slot a trigger should run for now, or null. Pure. */
export function dueTriggerSlot(t: TeamTrigger, a: Pick<TeamAssistant, "paused">, now: Date, tz: string): Date | null {
  if (t.kind !== "schedule" || !t.time || !t.days.length) return null;
  return dueSlot({ days: t.days, time: t.time, paused: t.paused || a.paused, last_slot: t.last_slot, created_at: t.created_at }, now, tz);
}

/** Which assistants' event triggers an event fires, each assistant once (its first matching trigger). Pure. */
export function eventMatches(ev: Pick<TeamEventRow, "kind" | "facets" | "created_at">, assistants: TeamAssistant[]): Array<{ assistant: TeamAssistant; trigger: TeamTrigger }> {
  const out: Array<{ assistant: TeamAssistant; trigger: TeamTrigger }> = [];
  for (const a of assistants) {
    if (a.paused) continue;
    const t = a.triggers.find((t) => t.kind === "event" && !t.paused && t.event && Date.parse(t.created_at) <= Date.parse(ev.created_at) && matchesFilter(t.event, ev));
    if (t) out.push({ assistant: a, trigger: t });
  }
  return out;
}

/** Claim a schedule slot for one run: false when another pass has it, or the trigger was paused or removed meanwhile. */
export async function claimTriggerSlot(id: string, slot: Date): Promise<boolean> {
  const rows = await qRaw<{ id: string }>(
    `UPDATE team_triggers SET last_slot = $2::timestamptz, last_fired_at = now()
      WHERE id = $1::uuid AND NOT paused AND (last_slot IS NULL OR last_slot < $2::timestamptz) RETURNING id`,
    [id, slot.toISOString()],
  );
  return rows.length > 0;
}

/** Take the oldest unprocessed events, marking them processed: each is matched by one pass only. */
export async function claimEvents(limit = EVENTS_PER_PASS): Promise<TeamEventRow[]> {
  const rows = await qRaw<{ id: string | number; kind: TeamEventRow["kind"]; ref_id: string | null; ref_kind: string | null; facets: TeamEventRow["facets"] | null; created_at: string | Date }>(
    `UPDATE team_events SET processed_at = now()
      WHERE id IN (SELECT id FROM team_events WHERE processed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, ref_id, ref_kind, facets, created_at`,
    [limit],
  );
  return rows
    .map((r) => ({ id: String(r.id), kind: r.kind, ref_id: r.ref_id, ref_kind: r.ref_kind, facets: r.facets ?? {}, created_at: new Date(r.created_at).toISOString() }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Group a pass's events by assistant, oldest first: one batch per assistant, with the trigger its first event fired. Pure. */
export function batchByAssistant(events: TeamEventRow[], assistants: TeamAssistant[]): Array<{ assistant: TeamAssistant; trigger: TeamTrigger; triggers: Set<string>; events: TeamEventRow[] }> {
  const out = new Map<string, { assistant: TeamAssistant; trigger: TeamTrigger; triggers: Set<string>; events: TeamEventRow[] }>();
  for (const ev of events) {
    for (const { assistant, trigger } of eventMatches(ev, assistants)) {
      const b = out.get(assistant.id) ?? { assistant, trigger, triggers: new Set<string>(), events: [] };
      b.triggers.add(trigger.id);
      b.events.push(ev);
      out.set(assistant.id, b);
    }
  }
  return [...out.values()];
}

/** One pass: claim due schedule slots and new events. A slot is one run; an assistant's matching events are one run together. Returns the runs queued. */
export async function queueTeamRuns(now: Date, tz: string): Promise<TeamRun[]> {
  const assistants = await listAssistants();
  const queued: TeamRun[] = [];
  for (const a of assistants) {
    for (const t of a.triggers) {
      const slot = dueTriggerSlot(t, a, now, tz);
      if (slot && (await claimTriggerSlot(t.id, slot))) queued.push(await enqueueTeamRun(a.id, { triggerId: t.id, label: runLabel(t, []) }));
    }
  }
  const events = await claimEvents();
  if (!events.length) return queued;
  for (const b of batchByAssistant(events, assistants)) {
    await qRaw(`UPDATE team_triggers SET last_fired_at = now() WHERE id = ANY($1::uuid[])`, [[...b.triggers]]);
    queued.push(await enqueueTeamRun(b.assistant.id, { triggerId: b.trigger.id, eventIds: b.events.map((e) => e.id), label: runLabel(b.trigger, b.events) }));
  }
  return queued;
}

type EventRowRaw = { id: string | number; kind: TeamEventRow["kind"]; ref_id: string | null; ref_kind: string | null; facets: TeamEventRow["facets"] | null; created_at: string | Date };

/**
 * Something the owner did: keep its event, and if it fires an assistant, run it now rather than at the next pass.
 * The event is claimed and its runs queued in one transaction, so a pass can't take it as well and nothing runs
 * twice; if that fails, it rolls back and the event waits for the pass. A run whose hand-off fails stays queued for
 * the pass to hand off (reminders.ts). Never throws: a save must not fail because an assistant couldn't start.
 * Returns the runs queued here.
 */
export async function startTeamEvent(
  kind: EventSource,
  refId: string | null,
  refKind: string | null,
  facets: TeamEventFacets = {},
  opts: { origin?: string; fetchImpl?: typeof fetch } = {},
): Promise<TeamRun[]> {
  const id = await emitTeamEvent(kind, refId, refKind, facets);
  const origin = opts.origin ?? teamOrigin();
  if (!id || !origin || !aiConfigured()) return [];
  let queued: TeamRun[] = [];
  try {
    const assistants = await listAssistants();
    // Nobody waits for this kind of thing: the pass marks it seen.
    if (!assistants.some((a) => !a.paused && a.triggers.some((t) => t.kind === "event" && !t.paused && t.event?.source === kind))) return [];
    queued = await tx(async (run) => {
      const [r] = await run<EventRowRaw>(
        `UPDATE team_events SET processed_at = now() WHERE id = $1::bigint AND processed_at IS NULL RETURNING id, kind, ref_id, ref_kind, facets, created_at`,
        [id],
      );
      if (!r) return [];
      const ev: TeamEventRow = { id: String(r.id), kind: r.kind, ref_id: r.ref_id, ref_kind: r.ref_kind, facets: r.facets ?? {}, created_at: new Date(r.created_at).toISOString() };
      const out: TeamRun[] = [];
      for (const b of batchByAssistant([ev], assistants)) {
        await run(`UPDATE team_triggers SET last_fired_at = now() WHERE id = ANY($1::uuid[])`, [[...b.triggers]]);
        out.push(await enqueueTeamRun(b.assistant.id, { triggerId: b.trigger.id, eventIds: [ev.id], label: runLabel(b.trigger, [ev]) }, run));
      }
      return out;
    });
  } catch (error) {
    console.error("Athena team: couldn't start an event's runs now; the next pass will", (error as Error)?.message?.slice(0, 120));
    return [];
  }
  for (const r of queued) {
    try {
      await handOffTeamRun(origin, r.id, opts.fetchImpl);
    } catch (error) {
      console.error("Athena team: couldn't hand off a run now; the next pass will", (error as Error)?.message?.slice(0, 120));
    }
  }
  return queued;
}
