/**
 * Build the snapshot the rules read (ProactiveInput) from Athena's own
 * tables. Only what a switched-on rule could use right now is read: people
 * and notes for meetings near their prep or follow-up window, sleep in the
 * morning, habits and goals when their rules are on. Sent mail comes from
 * the caller (netlify/lib/proactive/mail.ts reads the connected mailboxes).
 */
import { getConnectionsDetailed, notDeclined, listEvents, type AthenaEvent } from "../db";
import { listCommitments, listGoals, listInteractions } from "../memory";
import { loadCommute, meetingPeople, HARD_DAY_NIGHTS } from "../briefing-run";
import { tubeLine } from "../travel-day";
import { addDays, upcomingOccurrences, zonedParts, zonedToday } from "../dates";
import { getPatterns } from "../patterns-data";
import { loadWorkingHours } from "../scheduling";
import { loadHealthPrefs, mergeSources, readHealthDays } from "../health";
import { habitDays } from "../own-habits";
import { dayMainSpot } from "../places-visits";
import { placeStop } from "../static-map";
import { isEncryptedPlaceholder } from "../encrypted";
import { estimateFor, travelModeFor } from "./travel";
import { eveningFree, loadTonight, rankTonight } from "../watch-tonight";
import type { InputEvent, ProactiveInput, SentThread, TravelMode } from "./types";
import { inWorkingHours, type ProactivePrefs } from "./gate";
import { loadCarState } from "../car-store";
import { carDues } from "../car";

const HOUR = 3_600_000;
const readable = (s: string | null | undefined): s is string => !!s && !isEncryptedPlaceholder(s);

/** An event is a backfill when it was added after it happened (an import of history). */
const addedAfter = (created_at: string, starts_at: string) => Date.parse(created_at) > Date.parse(starts_at) + HOUR;

async function eventDetail(e: AthenaEvent, starts_at: string, near: boolean, now: Date): Promise<InputEvent> {
  const base: InputEvent = { id: e.id, title: e.title, starts_at, ends_at: null, people: [], place: null, backfilled: addedAfter(e.created_at, starts_at) };
  const links = await getConnectionsDetailed("event", e.id).catch(() => null);
  const all = links ? [...links.outgoing, ...links.backlinks] : [];
  const place = all.find((c) => c.kind === "place" && readable(c.title));
  base.place = place ? { id: place.id, name: place.title } : null;
  const hasPeople = !!(e.person_id && e.kind !== "birthday") || all.some((c) => c.kind === "person");
  base.solo = !hasPeople;
  if (!hasPeople || !near) return base;
  const people = await meetingPeople(e).catch(() => []);
  const since = new Date(now.getTime() - 14 * 24 * HOUR);
  base.people = await Promise.all(
    people.map(async (p) => {
      // The last time you met (a meeting, call or in person) is "what was agreed"; email and messages are "recent mail".
      const recent = await listInteractions({ personId: p.id, limit: 20 }).catch(() => []);
      const id = (p as { id?: string }).id ?? null;
      const met = recent.filter((i) => (i.channel === "meeting" || i.channel === "call" || i.channel === "in_person") && readable(i.summary)).sort((a, b) => Date.parse(String(b.at)) - Date.parse(String(a.at)))[0];
      return {
        id,
        name: p.name,
        last_contacted_at: p.last_contacted_at,
        last_summary: met ? { at: new Date(met.at).toISOString(), text: met.summary } : null,
        recent_mail: recent
          .filter((i) => (i.channel === "email" || i.channel === "message") && readable(i.summary) && Date.parse(String(i.at)) >= since.getTime())
          .map((i) => ({ at: new Date(i.at).toISOString(), channel: i.channel as "email" | "message", text: i.summary })),
      };
    }),
  );
  // The notes from the last time: notes linked to the event or its people, newest first.
  // (Briefing pages mention every event of their day: those are left out.)
  const isNote = (c: { kind: string; title: string; subtitle: string }) => c.kind === "note" && c.subtitle !== "daily" && readable(c.title);
  // updated_at can arrive as a Date from the driver, not a string: normalise before sorting.
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ""));
  const notes = all.filter(isNote).map((c) => ({ id: c.id, title: c.title, at: iso(c.updated_at) }));
  for (const p of base.people.slice(0, 2)) {
    if (!p.id) continue;
    const pl = await getConnectionsDetailed("person", p.id).catch(() => null);
    for (const c of pl ? [...pl.outgoing, ...pl.backlinks] : []) if (isNote(c)) notes.push({ id: c.id, title: c.title, at: iso(c.updated_at) });
  }
  base.last_notes = [...new Map(notes.map((n) => [n.id, n])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 2);
  return base;
}

export interface LoadOptions {
  now: Date;
  tz: string;
  prefs: ProactivePrefs;
  /** Rules muted or switched off aren't loaded for. */
  live: (rule: keyof ProactivePrefs["rules"]) => boolean;
  sent?: () => Promise<SentThread[]>;
  /** A live journey planner (netlify/lib/proactive/directions.ts liveRoute); null falls back to the estimate. */
  route?: (from: { lat: number; lng: number }, to: { lat: number; lng: number }, arriveBy: Date, key: string, mode: TravelMode) => Promise<{ minutes: number; mode: TravelMode; source: "tfl" | "google"; rechecked?: boolean } | null | "no_key">;
  closed?: Set<string>;
  /** Already read by the caller (reminders.ts), declined ones left out. */
  events?: AthenaEvent[];
}

export async function loadProactiveInput(o: LoadOptions): Promise<ProactiveInput> {
  const { now, tz } = o;
  const today = zonedToday(now, tz);
  const t = now.getTime();
  const [hours, events] = await Promise.all([loadWorkingHours(), o.events ? Promise.resolve(o.events) : listEvents().then((es) => es.filter(notDeclined))]);
  const working = { days: hours.days, start: hours.start, end: hours.end };

  // Timed occurrences from yesterday to a week on.
  const occ = upcomingOccurrences(events.filter((e) => e.kind !== "birthday" && e.kind !== "anniversary"), addDays(today, -1), 9, tz).filter((x) => x.starts_at);
  const wantsNear = o.live("meeting_prep") || o.live("after_meeting");
  const input: InputEvent[] = [];
  for (const x of occ) {
    const s = Date.parse(x.starts_at!);
    if (!readable(x.event.title)) continue;
    const isToday = zonedToday(new Date(s), tz) === today;
    // Near: the 30-minute push's window and the prep window, or ended within the hour (an hour-long default).
    const near = wantsNear && s - t < 35 * 60_000 && s - t > -3 * HOUR;
    if (isToday || near) input.push(await eventDetail(x.event, x.starts_at!, near, now));
    else input.push({ id: x.event.id, title: x.event.title, starts_at: x.starts_at!, ends_at: null, people: [], place: null, backfilled: addedAfter(x.event.created_at, x.starts_at!) });
  }

  const [todos, goals] = await Promise.all([
    listCommitments({ status: "open", kinds: ["todo", "i_owe", "waiting_on"], limit: 200 }).catch(() => []),
    o.live("weekly_plan") ? listGoals(50).catch(() => []) : Promise.resolve([]),
  ]);

  // Sleep, for the morning day plan only. Never leaves the server in a push.
  let sleep: ProactiveInput["sleep"] = null;
  if (o.live("day_plan")) {
    const [health, hp] = await Promise.all([readHealthDays(addDays(today, -HARD_DAY_NIGHTS), today).catch(() => null), loadHealthPrefs().catch(() => undefined)]);
    if (health) {
      const on = (d: string) => {
        const s = health.days.get(d);
        return s?.length ? mergeSources(s, hp) : null;
      };
      const nights: number[] = [];
      const recoveries: number[] = [];
      for (let d = addDays(today, -HARD_DAY_NIGHTS); d < today; d = addDays(d, 1)) {
        const f = on(d);
        if (f?.sleep_minutes) nights.push(f.sleep_minutes);
        if (typeof f?.recovery === "number") recoveries.push(f.recovery);
      }
      const last = on(today);
      sleep = { last_minutes: last?.sleep_minutes ?? null, last_recovery: typeof last?.recovery === "number" ? last.recovery : null, nights, recoveries };
    }
  }

  // Drift, once a day in the first half hour of the working day (it's heavy, and a work nudge):
  // habits over eight weeks, each due day done or not; workouts and timed events on those days;
  // and each habit's own line from Patterns.
  let habits: ProactiveInput["habits"] = [];
  let past: ProactiveInput["past"];
  const startMin = Number(working.start.slice(0, 2)) * 60 + Number(working.start.slice(3, 5));
  const nowMin = zonedParts(now, tz).hour * 60 + zonedParts(now, tz).minute;
  if (o.live("drift") && inWorkingHours(now, tz, working) && nowMin < startMin + 30) {
    const from = addDays(today, -56);
    const [list, health, hp, patterns] = await Promise.all([
      habitDays(from, addDays(today, -1), today).catch(() => []),
      readHealthDays(from, addDays(today, -1)).catch(() => null),
      loadHealthPrefs().catch(() => undefined),
      getPatterns({ window: 90, now }).catch(() => null),
    ]);
    habits = list.map((h, i) => {
      const skip = new Set([...(h.not_due ?? []), ...(h.open ?? [])]);
      const marks = [...h.done.map((d) => ({ date: d, done: true })), ...h.missed.filter((d) => !skip.has(d)).map((d) => ({ date: d, done: false }))].sort((a, b) => a.date.localeCompare(b.date));
      const pattern = patterns?.patterns.find((p) => p.factor_kind === "habit" && p.factor_name?.toLowerCase() === h.name.toLowerCase() && p.sure >= 2)?.line ?? null;
      return { id: `${h.source}:${h.name}`.slice(0, 120) || String(i), name: h.name, marks, pattern };
    });
    past = {};
    for (let d = from; d < today; d = addDays(d, 1)) {
      const s = health?.days.get(d);
      const workouts = s?.length ? (mergeSources(s, hp).workouts ?? []).map((w) => w.type) : [];
      past[d] = { workouts, events: [] };
    }
    for (const e of events) {
      if (!e.starts_at || e.recurrence !== "none" || !readable(e.title)) continue;
      const d = zonedToday(new Date(e.starts_at), tz);
      if (past[d]) past[d].events.push({ title: e.title, time: `${String(zonedParts(new Date(e.starts_at), tz).hour).padStart(2, "0")}:${String(zonedParts(new Date(e.starts_at), tz).minute).padStart(2, "0")}` });
    }
  }

  // Leave by: the next event today at a Place, within 90 minutes, from where the owner has been today (or yesterday).
  // A live planner when one is set up (o.route, netlify/lib/proactive/directions.ts), else the distance estimate.
  const travel: ProactiveInput["travel"] = {};
  if (o.live("leave_by")) {
    const next = input.filter((e) => e.place && Date.parse(e.starts_at) > t && Date.parse(e.starts_at) - t <= 90 * 60_000).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    if (next?.place) {
      const [here, there] = await Promise.all([
        dayMainSpot(today, tz).then((s) => s ?? dayMainSpot(addDays(today, -1), tz)).catch(() => null),
        placeStop(next.place.id).catch(() => null),
      ]);
      const from = here?.town ? `around ${here.town}, where you've been today` : "where you've been today";
      // The event's own way of travelling, else the owner's usual (Settings → Notifications).
      const mode = travelModeFor(o.prefs, next.id);
      const answer = here && there && o.route ? await o.route(here, there, new Date(next.starts_at), `${next.id}:${next.starts_at}`, mode).catch(() => null) : null;
      const route = answer && answer !== "no_key" ? answer : null;
      // A drive is only ever timed by Google with traffic: without a key it has no estimate (and is never timed as public transport).
      const noKey = answer === "no_key" || (mode === "drive" && !o.route);
      const est = !route && !noKey && here && there ? estimateFor(mode, here, there) : null;
      if (route) travel[next.id] = { minutes: route.minutes, mode: route.mode, from, source: route.source, ...(route.rechecked ? { rechecked: true } : {}) };
      else if (noKey) travel[next.id] = { minutes: 0, mode: "drive", from, source: "none" };
      else if (est) {
        // By public transport, the briefing's own check of the owner's usual TfL lines (their journey history).
        const lines = est.mode === "transit" ? await loadCommute(today).catch(() => []) : [];
        travel[next.id] = { minutes: est.minutes, mode: est.mode, from, disruption: tubeLine(lines), source: "estimate" };
      }
    }
  }

  // Mail is only read when awaiting reply could speak: in working hours.
  const sent = o.live("awaiting_reply") && o.sent && inWorkingHours(now, tz, working) ? await o.sent().catch(() => []) : [];

  // Something to watch tonight: only in its window, from the owner's own list and taste.
  let tonight: ProactiveInput["tonight"];
  if (o.live("watch_tonight") && nowMin >= 17 * 60 && nowMin < 20 * 60) {
    const free = eveningFree(input.filter((e) => zonedToday(new Date(e.starts_at), tz) === today), today, tz);
    tonight = { free, picks: free ? await loadTonight().then(({ candidates, taste }) => rankTonight(candidates, taste, { now }), () => []) : [] };
  }

  // The car's MOT and tax dates, as the daily sync left them (lib/car-store.ts). Labels and dates only.
  const cars = o.live("car") ? await loadCarState().then(carDues, () => []) : [];

  return {
    ...(tonight ? { tonight } : {}),
    ...(cars.length ? { cars } : {}),
    now,
    tz,
    today,
    working,
    events: input,
    sent,
    todos: todos.map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind as "todo" | "i_owe" | "waiting_on",
      due_on: c.due_on,
      person_id: c.person_id,
      person_name: c.person?.name ?? null,
      // Added already overdue by more than a week: imported history, not a live to-do.
      backfilled: !!c.due_on && c.due_on < addDays(zonedToday(new Date(c.created_at), tz), -7),
    })).filter((c) => readable(c.title)),
    goals: goals.filter((g) => g.status === "active" && readable(g.title)).map((g) => ({ id: g.id, title: g.title, progress: g.progress, period: g.period, due_on: g.due_on })),
    sleep,
    habits,
    ...(past ? { past } : {}),
    travel,
    closed: o.closed ?? new Set(),
  };
}
