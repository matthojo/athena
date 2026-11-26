/**
 * The week (or month) in review's model (views/days-recap.ts), from what the
 * app loads: the period's Days, interactions, commitments, trips, event
 * records, and the server's extras (lib/week-review.ts: goals moved on,
 * events with a person at a place, places known before). Pure and DOM-free,
 * so it runs under `npx tsx --test`. It works like this:
 *
 *  - Seen: logged catch-ups (in person, calls) plus calendar events with a
 *    named person at a place that period. Meetings, messages and emails
 *    aren't catch-ups: meetings count under What got done.
 *  - Goals moved on: from the server's goal progress log.
 *  - Mood: a tile in Health and habits with a strip of the period's days.
 *
 * From the old weekly review (#/week, retired 2026-11): what's still open
 * and who to catch up with, for the period holding today; renewals in
 * Looking ahead; and decisions counted on the day they were made.
 */

import { addDays, alsoSort, capital, list, monthName, plural, shortDate, weekStart, weekdayShort } from "../components/day-words";
import { upcomingOccurrences, zonedToday } from "../../../lib/dates";
import type { Day, DayArt, DayEntry, Mood } from "../db/days-app";
import type { Asset, AthenaEvent, Commitment, Interaction, Person, Trip } from "../types";
import { DEFAULT_CATCH_UP } from "./format";
import { ASSET_META } from "./memory-meta";
import { num, weekHeadline, type Headline, type Period, type WeekSignals } from "./week-headline";

// ---------- The model ----------

export interface PersonSeen {
  id: string;
  name: string;
  /** "In person", "Call", "Lunch with Priya": how the latest time went. */
  how: string;
  inPerson: boolean;
  /** Days seen, newest first. */
  dates: string[];
  summary: string;
  where?: string;
}

export interface PlaceVisit {
  name: string;
  dates: string[];
  minutes: number;
  isNew: boolean;
}

export interface TripCard {
  place: string;
  from: string;
  to: string;
  days: number;
  bits: string[];
}

export interface DoneItem {
  title: string;
  date: string;
  person?: string;
  note?: string;
}

export interface GoalMove {
  title: string;
  progress: number;
  delta: number;
  target: string;
}

export interface HealthDay {
  date: string;
  sleep?: number;
  steps?: number;
  mood?: Mood;
  workout?: string;
  future: boolean;
}

export interface HabitRow {
  name: string;
  /** One per day: true done, false missed, null not due or still to come. */
  days: (boolean | null)[];
  kept: number;
  due: number;
}

export interface AheadItem {
  date: string;
  title: string;
  kind: "event" | "deadline" | "birthday" | "travel" | "due" | "renewal";
  detail?: string;
}

/** A to-do still open, from the old weekly review's "Still open". */
export interface OpenItem {
  title: string;
  kind: Commitment["kind"];
  due?: string;
  overdue: boolean;
  /** "For Priya", "Waiting on Mum". */
  relation?: string;
  commitment: Commitment;
}

/** Someone you keep in touch with who's past their catch-up. */
export interface CatchUp {
  id: string;
  name: string;
  /** Days since you last spoke; null when never logged. */
  since: number | null;
}

export interface ShelfItem {
  kind: "watched" | "read" | "listened";
  title: string;
  sub: string;
  art?: DayArt;
  url?: string;
  weight: number;
}

export interface WeekLink {
  title: string;
  url: string;
  host: string;
  via: string;
}

/** One cell of the Mood tile's strip. */
export interface MoodCell {
  date: string;
  mood: Mood | null;
  future: boolean;
  /** "M" for a week's Monday, "14" for a month's day. */
  label: string;
  /** "Mon 2 Nov: Good", "Tue 3 Nov: not set". */
  title: string;
}

export interface MoodSummary {
  cells: MoodCell[];
  /** Days with a mood, up to today. */
  set: number;
  /** The rounded average, null with none set. */
  average: Mood | null;
}

export interface WeekModel {
  period: Period;
  from: string;
  to: string;
  today: string;
  sofar: boolean;
  headline: Headline;
  people: PersonSeen[];
  places: PlaceVisit[];
  trips: TripCard[];
  todos: DoneItem[];
  meetings: DoneItem[];
  decisions: DoneItem[];
  goals: GoalMove[];
  health: HealthDay[];
  workouts: { type: string; minutes: number; km?: number; date: string }[];
  habits: HabitRow[];
  /** Takeaways and rides in the period, in words ("Two takeaways and a ride"), or null with none. */
  nights: string | null;
  mood: MoodSummary;
  ahead: AheadItem[];
  /** Still open, soonest due first: only for the period holding today, else empty. */
  open: OpenItem[];
  openTally: { overdue: number; forOthers: number; waiting: number };
  /** Past their catch-up, longest first: only for the period holding today. */
  catchUps: CatchUp[];
  shelf: ShelfItem[];
  links: WeekLink[];
  signals: WeekSignals;
}

// ---------- Inputs ----------

/** An event with a named person at a place, from GET /api/week-review. */
export interface SeenEvent {
  id: string;
  title: string;
  date: string;
  people: { id: string; name: string }[];
  place: string;
}

/** A goal's move in the period, from GET /api/week-review. */
export interface GoalMoveIn {
  title: string;
  target: string;
  was: number;
  now: number;
}

export interface ReviewInput {
  period: Period;
  from: string;
  to: string;
  today: string;
  /** The zone dates are read in (the device's). */
  tz: string;
  days: Day[];
  /** Sample mode adds `how` and `where`; real interactions don't have them. */
  interactions: (Interaction & { how?: string; where?: string })[];
  seenEvents: SeenEvent[];
  commitments: Commitment[];
  goalMoves: GoalMoveIn[];
  trips: Trip[];
  events: AthenaEvent[];
  /** Places seen in the eight weeks before; null when unknown (no "First visit" badges). */
  knownPlaces: Set<string> | null;
  /** People, for Catch up with; left out, there are none. */
  people?: Person[];
  /** Life admin, for renewals in Looking ahead. */
  assets?: Asset[];
}

// ---------- Helpers ----------

const ROUTINE = new Set(["home", "work"]);
const inRange = (d: string, from: string, to: string) => d >= from && d <= to;
const firstName = (name: string) => (/^(Mum|Dad)$/.test(name) ? name : name.replace(/^Dr\.?\s+/, "").split(/\s+/)[0]);

/** How a catch-up went, by channel. Meetings, messages and emails aren't catch-ups. */
export const CATCH_UP: Partial<Record<Interaction["channel"], string>> = { in_person: "In person", call: "Call", other: "Caught up" };

export function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function avg(xs: (number | undefined | null)[]): number | undefined {
  const set = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return set.length ? Math.round(set.reduce((a, b) => a + b, 0) / set.length) : undefined;
}

// ---------- Seen ----------

/**
 * Who the owner saw or caught up with between `from` and `end`: logged
 * catch-ups (in person, calls, other) and calendar events with a named person
 * at a place. Seeing someone beats a call: the card says how you last saw
 * them in person. One row per person, in person first, then most often.
 * Names are first names unless two people share one.
 */
export function peopleSeen(interactions: ReviewInput["interactions"], events: SeenEvent[], from: string, end: string, tz: string): PersonSeen[] {
  const byId = new Map<string, PersonSeen>();
  const add = (id: string, name: string, date: string, inPerson: boolean, how: string, summary: string, where?: string) => {
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { id, name, how, inPerson, dates: [date], summary, where });
      return;
    }
    if (!prev.dates.includes(date)) prev.dates.push(date);
    if (inPerson && !prev.inPerson) Object.assign(prev, { how, inPerson: true, summary, where });
    else if (inPerson && prev.inPerson && !prev.where && where && prev.dates[0] === date) prev.where = where;
  };
  const sorted = [...interactions].sort((a, b) => b.at.localeCompare(a.at));
  for (const i of sorted) {
    const how = CATCH_UP[i.channel];
    if (!how || i.archived_at) continue;
    const date = zonedToday(new Date(i.at), tz);
    if (!inRange(date, from, end)) continue;
    for (const p of i.people) add(p.id, p.name, date, i.channel === "in_person", i.how ?? how, i.summary, i.where);
  }
  for (const e of [...events].sort((a, b) => b.date.localeCompare(a.date))) {
    if (!inRange(e.date, from, end) || !e.place) continue;
    for (const p of e.people) add(p.id, p.name, e.date, true, e.title, "", e.place);
  }
  const out = [...byId.values()];
  for (const p of out) p.dates.sort((a, b) => b.localeCompare(a));
  const firsts = new Map<string, number>();
  for (const p of out) firsts.set(firstName(p.name), (firsts.get(firstName(p.name)) ?? 0) + 1);
  for (const p of out) if (firsts.get(firstName(p.name)) === 1) p.name = firstName(p.name);
  return out.sort((a, b) => Number(b.inPerson) - Number(a.inPerson) || b.dates.length - a.dates.length || b.dates[0].localeCompare(a.dates[0]) || a.name.localeCompare(b.name));
}

// ---------- Mood ----------

const MOOD_WORDS = ["", "Awful", "Low", "Okay", "Good", "Great"];
export const moodName = (m: Mood | null | undefined) => (m ? MOOD_WORDS[m] : null);

/** The Mood tile's strip: one cell per day of the period, the average and how many days were set. */
export function moodStrip(days: Pick<HealthDay, "date" | "mood" | "future">[], period: Period): MoodSummary {
  const cells = days.map((d) => {
    const mood = d.mood ?? null;
    const when = `${weekdayShort(d.date)} ${shortDate(d.date)}`;
    return {
      date: d.date,
      mood,
      future: d.future,
      label: period === "week" ? weekdayShort(d.date).slice(0, 1) : String(Number(d.date.slice(8))),
      title: d.future ? `${when}: still to come` : `${when}: ${mood ? MOOD_WORDS[mood].toLowerCase() : "not set"}`,
    };
  });
  const set = cells.filter((c) => c.mood && !c.future).map((c) => c.mood!);
  const average = set.length ? (Math.round(set.reduce((a, b) => a + b, 0) / set.length) as Mood) : null;
  return { cells, set: set.length, average };
}

// ---------- The whole model ----------

const NOT_MEETINGS = new Set(["birthday", "anniversary", "deadline"]);

export function buildModel(raw: ReviewInput): WeekModel {
  const { from, to, today, period, tz } = raw;
  const end = to > today ? today : to;
  const all = datesOf(from, to);
  const byDate = new Map(raw.days.map((d) => [d.date, d]));
  const dayDate = (iso: string) => zonedToday(new Date(iso), tz);
  const period_days = raw.days.filter((d) => inRange(d.date, from, end));

  const people = peopleSeen(raw.interactions, raw.seenEvents, from, end, tz);

  // Places: everything but home and work, most visited first.
  const places = new Map<string, PlaceVisit>();
  for (const d of period_days) {
    for (const p of d.places) {
      if (ROUTINE.has(p.name.toLowerCase())) continue;
      const v = places.get(p.name) ?? { name: p.name, dates: [], minutes: 0, isNew: raw.knownPlaces ? !raw.knownPlaces.has(p.name) : false };
      if (!v.dates.includes(d.date)) v.dates.push(d.date);
      v.minutes += p.minutes ?? 0;
      places.set(p.name, v);
    }
  }
  const placeList = [...places.values()].sort((a, b) => b.dates.length - a.dates.length || Number(b.isNew) - Number(a.isNew) || a.name.localeCompare(b.name));

  // Trips that overlap the period.
  const trips: TripCard[] = raw.trips
    .filter((t) => !t.archived_at && t.starts_on && t.ends_on && t.starts_on <= end && t.ends_on >= from)
    .map((t) => ({
      place: t.title,
      from: t.starts_on!,
      to: t.ends_on!,
      days: Math.round((Date.parse(t.ends_on!) - Date.parse(t.starts_on!)) / 86_400_000) + 1,
      bits: t.bookings.filter((b) => !b.archived_at).map((b) => b.title),
    }));

  // What got done: commitments done in the period, timed calendar events (not the ones counted as seeing someone), goals that moved on.
  const done = raw.commitments.filter((c) => !c.archived_at && c.status === "done" && c.done_at && inRange(dayDate(c.done_at), from, end));
  const byDone = (a: DoneItem, b: DoneItem) => b.date.localeCompare(a.date);
  const todos = done.filter((c) => c.kind !== "decision").map((c) => ({ title: c.title, date: dayDate(c.done_at!), person: c.person ? firstName(c.person.name) : undefined })).sort(byDone);
  const decisions = decisionsIn(raw.commitments, from, end, dayDate);
  const seenIds = new Set(raw.seenEvents.map((e) => e.id));
  const meetings: DoneItem[] = [];
  for (const d of period_days) for (const e of d.events) if (!seenIds.has(e.id) && (e.kind === "meeting" || (e.starts_at && !NOT_MEETINGS.has(e.kind)))) meetings.push({ title: e.title, date: d.date });
  const goals = raw.goalMoves.filter((g) => g.now > g.was).map((g) => ({ title: g.title, progress: g.now, delta: g.now - g.was, target: g.target }));

  // Health and habits, day by day.
  const health: HealthDay[] = all.map((date) => {
    const d = byDate.get(date);
    const w = d?.health?.workouts?.[0];
    return { date, sleep: d?.health?.sleep_minutes, steps: d?.health?.steps, mood: d?.mood, workout: w ? w.type : undefined, future: date > today };
  });
  const workouts = period_days.flatMap((d) => (d.health?.workouts ?? []).map((w) => ({ type: w.type, minutes: w.minutes, km: w.distance_m ? w.distance_m / 1000 : undefined, date: d.date })));
  const habitNames: string[] = [];
  for (const d of period_days) for (const e of d.entries) if (e.kind === "habit" && !habitNames.includes(e.title)) habitNames.push(e.title);
  // Takeaways and rides (from receipt emails, lib/receipts.ts): counted, never totalled.
  const nightsN = { takeaway: 0, ride: 0 };
  for (const d of period_days) for (const e of d.entries) if (e.kind === "other") {
    const sort = alsoSort(e);
    if (sort === "takeaway" || sort === "ride") nightsN[sort]++;
  }
  const some = (n: number, one: string) => (n ? (n === 1 ? `a ${one}` : plural(n, one)) : "");
  const nights = nightsN.takeaway || nightsN.ride ? capital(list([some(nightsN.takeaway, "takeaway"), some(nightsN.ride, "ride")])) : null;
  const habits: HabitRow[] = habitNames.map((name) => {
    const days = all.map((date) => {
      if (date > today) return null;
      const e = byDate.get(date)?.entries.find((x) => x.kind === "habit" && x.title === name);
      return e ? (e.count ?? 1) > 0 : null;
    });
    return { name, days, kept: days.filter((x) => x === true).length, due: days.filter((x) => x !== null).length };
  });

  // Looking ahead: the next week (two for a month) from the later of the period's end and today.
  const aheadFrom = addDays(to > today ? to : today, 1);
  const aheadDays = period === "week" ? 6 : 13;
  const aheadTo = addDays(aheadFrom, aheadDays);
  const ahead: AheadItem[] = [];
  const live = raw.events.filter((e) => !e.archived_at && e.rsvp !== "declined");
  for (const o of upcomingOccurrences(live, aheadFrom, aheadDays, tz)) {
    const k = o.event.kind;
    ahead.push({ date: o.occurs_on, title: o.event.title, kind: k === "birthday" || k === "anniversary" ? "birthday" : k === "deadline" ? "deadline" : "event" });
  }
  for (const c of raw.commitments) if (!c.archived_at && c.status === "open" && c.due_on && inRange(c.due_on, aheadFrom, aheadTo)) ahead.push({ date: c.due_on, title: c.title, kind: "due", detail: c.person ? firstName(c.person.name) : undefined });
  for (const t of raw.trips) {
    if (t.archived_at || !t.starts_on || !inRange(t.starts_on, aheadFrom, aheadTo)) continue;
    const go = t.bookings.find((b) => !b.archived_at && (b.kind === "flight" || b.kind === "train"));
    ahead.push({ date: t.starts_on, title: `${t.title}, ${t.ends_on ? `until ${shortDate(t.ends_on)}` : "away"}`, kind: "travel", detail: go?.title });
  }
  for (const a of raw.assets ?? []) {
    if (a.archived_at || !a.renews_on || !inRange(a.renews_on, aheadFrom, aheadTo)) continue;
    const verb = ASSET_META[a.kind]?.verb ?? "renews";
    ahead.push({ date: a.renews_on, title: a.name, kind: "renewal", detail: verb === "due" ? "Due" : verb === "expires" ? "Expires" : "Renews" });
  }
  const order = (k: AheadItem["kind"]) => ["travel", "birthday", "event", "deadline", "renewal", "due"].indexOf(k);
  ahead.sort((a, b) => a.date.localeCompare(b.date) || order(a.kind) - order(b.kind));

  // Media: one cover per show, album, film or book, the most played first; links are the entries' own addresses.
  const shelf = new Map<string, ShelfItem>();
  const links: WeekLink[] = [];
  const linked = new Set<string>();
  for (const d of period_days) {
    for (const e of d.entries) {
      if (e.url && !linked.has(e.url) && (e.kind === "saved" || e.kind === "posted" || (e.kind === "listened" && !e.art))) {
        linked.add(e.url);
        links.push({ title: e.kind === "listened" && e.subtitle ? `${e.title}, ${e.subtitle}` : e.title, url: e.url, host: host(e.url), via: e.kind === "posted" ? "Posted" : e.kind === "saved" ? "Saved" : "Listened" });
      }
      if ((e.kind !== "watched" && e.kind !== "read" && e.kind !== "listened") || !e.art) continue;
      const key = `${e.kind}:${e.group ?? e.title}`;
      const s = shelf.get(key) ?? { kind: e.kind, title: e.group ?? e.title, sub: "", art: e.art, url: e.url, weight: 0 };
      s.weight += e.count ?? 1;
      s.url ??= e.url;
      s.sub = shelfSub(e, s.weight);
      shelf.set(key, s);
    }
  }
  const shelfList = [...shelf.values()].sort((a, b) => b.weight - a.weight).slice(0, period === "week" ? 8 : 12);

  // The headline's inputs.
  const listened = shelfList.filter((s) => s.kind === "listened");
  const watched = shelfList.filter((s) => s.kind === "watched");
  const read = shelfList.find((s) => s.kind === "read");
  const signals: WeekSignals = {
    period,
    seen: people.filter((p) => p.inPerson).map((p) => p.name),
    caughtUp: people.filter((p) => !p.inPerson).map((p) => p.name),
    trips: trips.map((t) => ({ place: t.place, days: t.days })),
    newPlaces: placeList.filter((p) => p.isNew).map((p) => p.name),
    todosDone: todos.length,
    meetings: meetings.length,
    decisions: decisions.length,
    goalsMoved: goals.map((g) => g.title),
    workouts: workouts.length,
    runKm: workouts.reduce((a, w) => a + (w.km ?? 0), 0) || undefined,
    sleepAvg: avg(health.map((h) => h.sleep)),
    habitsKept: habits.reduce((a, h) => a + h.kept, 0),
    habitsDue: habits.reduce((a, h) => a + h.due, 0),
    moods: health.filter((h) => !h.future).map((h) => h.mood ?? null),
    media: { show: watched[0]?.title, artist: listened[0]?.sub.split(" · ")[0], book: read?.title },
  };

  return {
    period,
    from,
    to,
    today,
    sofar: to >= today,
    headline: weekHeadline(signals),
    people,
    places: placeList,
    trips,
    todos,
    meetings,
    decisions,
    goals,
    health,
    workouts,
    habits,
    nights,
    mood: moodStrip(health, period),
    ahead,
    ...(to >= today && from <= today ? { ...stillOpen(raw.commitments, today), catchUps: catchUpsDue((raw.people ?? []).filter((p) => !people.some((x) => x.id === p.id)), today) } : { open: [], openTally: { overdue: 0, forOthers: 0, waiting: 0 }, catchUps: [] }),
    shelf: shelfList,
    links: links.slice(0, period === "week" ? 5 : 8),
    signals,
  };
}

/**
 * Decisions in the period: on the day they were closed, or, for one still
 * marked open (decisions logged before they were recorded as done), the day
 * it was made. Dropped ones aren't decisions. One per title.
 */
export function decisionsIn(items: Commitment[], from: string, end: string, dayDate: (iso: string) => string): DoneItem[] {
  const seen = new Set<string>();
  const out: DoneItem[] = [];
  for (const c of items) {
    if (c.kind !== "decision" || c.archived_at || c.status === "dropped") continue;
    const at = c.status === "done" && c.done_at ? c.done_at : c.created_at;
    const date = dayDate(at);
    if (!inRange(date, from, end) || seen.has(c.title)) continue;
    seen.add(c.title);
    out.push({ title: c.title, date, person: c.person ? firstName(c.person.name) : undefined, note: c.notes || undefined });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** What's still open, soonest due first (undated newest first), and the old page's tally of it. */
export function stillOpen(items: Commitment[], today: string): { open: OpenItem[]; openTally: WeekModel["openTally"] } {
  const open = items
    .filter((c) => c.status === "open" && c.kind !== "decision" && !c.archived_at)
    .sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || b.created_at.localeCompare(a.created_at))
    .map((c) => {
      const who = c.person ? firstName(c.person.name) : null;
      const relation = c.kind === "i_owe" && who ? `For ${who}` : c.kind === "waiting_on" ? (who ? `Waiting on ${who}` : "Waiting on someone") : undefined;
      return { title: c.title, kind: c.kind, due: c.due_on ?? undefined, overdue: !!c.due_on && c.due_on < today, relation, commitment: c };
    });
  return {
    open,
    openTally: { overdue: open.filter((o) => o.overdue).length, forOthers: open.filter((o) => o.kind === "i_owe").length, waiting: open.filter((o) => o.kind === "waiting_on").length },
  };
}

/** People you keep in touch with who are past their catch-up (60 days unless set), longest first, at most six. */
export function catchUpsDue(people: Person[], today: string): CatchUp[] {
  const now = Date.parse(`${today}T12:00:00Z`);
  return people
    .filter((p) => !p.archived_at && p.keep_in_touch)
    .map((p) => ({ id: p.id, name: p.name, since: p.last_contacted_at ? Math.floor((now - Date.parse(p.last_contacted_at)) / 86_400_000) : null, every: p.catch_up_days ?? DEFAULT_CATCH_UP }))
    .filter((p) => p.since === null || p.since > p.every)
    .sort((a, b) => (b.since ?? Infinity) - (a.since ?? Infinity) || a.name.localeCompare(b.name))
    .slice(0, 6)
    .map(({ id, name, since }) => ({ id, name, since }));
}

function shelfSub(e: DayEntry, n: number): string {
  if (e.kind === "listened") return `${e.subtitle ?? "Album"} · ${n} ${n === 1 ? "play" : "plays"}`;
  if (e.kind === "watched") return e.group ? `${n} ${n === 1 ? "episode" : "episodes"}` : `Film${e.subtitle ? ` · ${e.subtitle}` : ""}`;
  return (e.subtitle ?? "Book").split(" · ")[0];
}

/** "This week", "Week of 26 Oct", "October 2026". */
export function reviewTitle(period: Period, from: string, today: string): string {
  return period === "week" ? (from === weekStart(today) ? "This week" : `Week of ${shortDate(from)}`) : monthName(from.slice(0, 7));
}

// ---------- Habits: what held ----------

const HELD_AT = 5;

/**
 * When one habit was done, in heldLine's words: "every day", "every
 * weekday", "on six days", "on one day". Empty when it wasn't done at all,
 * so nothing reads as missed. Month in review's bars use it too.
 */
export function heldWhen(r: HabitRow, from?: string): string {
  if (r.kept <= 0) return "";
  // Without a start date, the first day is a Monday.
  const isWeekday = (i: number) => {
    if (!from) return i % 7 < 5;
    const dow = new Date(`${addDays(from, i)}T12:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5;
  };
  if (r.days.length > 0 && r.days.every((x) => x === true)) return "every day";
  const weekdays = r.days.map((_, i) => i).filter(isWeekday);
  if (weekdays.length >= 5 && weekdays.every((i) => r.days[i] === true) && r.kept === weekdays.length) return "every weekday";
  return `on ${r.kept === 1 ? "one day" : `${num(r.kept)} days`}`;
}

/**
 * What held, by name, in place of a percentage: "Evening walk every weekday. Read 20 pages on six days." A habit
 * held when it was done on five or more days of a week (five in seven of a
 * month's days). Rows keep their order, four at most by name. When none held, the most-done one or
 * two are named with their days, so the line still says what happened; with
 * nothing done at all it's empty. Never a score, never what was missed.
 * `from` is the date of each row's first day (a Monday for a week).
 */
export function heldLine(rows: HabitRow[], from?: string): string {
  const words = (r: HabitRow): string => `${r.name} ${heldWhen(r, from)}`;
  const need = (r: HabitRow) => Math.max(HELD_AT, Math.ceil((r.days.length * HELD_AT) / 7));
  const held = rows.filter((r) => r.kept >= need(r));
  const shown = held.length ? held.slice(0, 4) : [...rows].filter((r) => r.kept > 0).sort((a, b) => b.kept - a.kept).slice(0, 2);
  const lines = shown.map((r) => `${words(r)}.`);
  const more = held.length - shown.length;
  if (held.length && more > 0) lines.push(`${capital(num(more))} more held too.`);
  return lines.join(" ");
}
