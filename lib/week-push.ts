/**
 * The Sunday push (netlify/functions/reminders.ts §4b) is the Week in
 * review's own headline: the same signals, read on the server, through the
 * same rules (lib/week-headline.ts). So the push and the page agree.
 *
 * `weekSignals` mirrors how app/src/lib/week-review.ts buildModel fills
 * WeekSignals, from the same shapes the app loads: the week's Days,
 * catch-ups, events with a person at a place, done to-dos and decisions,
 * goals moved on, trips and the places known before. It is pure, so the
 * tests can hold it to the page (app/src/lib/week-review.test.ts).
 *
 * Nothing overdue or still open goes in: the headline never mentions what's
 * late, and neither does the push (docs/notes/affection-2026-11.md, "Don't do").
 */

import { addDays, zonedToday, zonedToInstant } from "./dates";
import type { Day } from "./day-types";
import { weekHeadline, type Period, type WeekSignals } from "./week-headline";

export interface PushInteraction {
  at: string;
  channel: string;
  archived_at?: string | null;
  people: { id: string; name: string }[];
}

export interface PushCommitment {
  title: string;
  kind: string;
  status: string;
  done_at: string | null;
  created_at: string;
  archived_at?: string | null;
}

export interface PushTrip {
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  archived_at?: string | null;
}

export interface PushSeenEvent {
  id: string;
  date: string;
  place: string;
  people: { id: string; name: string }[];
}

export interface WeekFacts {
  period: Period;
  from: string;
  to: string;
  today: string;
  tz: string;
  days: Pick<Day, "date" | "places" | "health" | "mood" | "entries" | "events">[];
  interactions: PushInteraction[];
  seenEvents: PushSeenEvent[];
  commitments: PushCommitment[];
  goalMoves: { title: string; was: number; now: number }[];
  trips: PushTrip[];
  knownPlaces: Set<string> | null;
}

const ROUTINE = new Set(["home", "work"]);
const CATCH_UP = new Set(["in_person", "call", "other"]);
const NOT_MEETINGS = new Set(["birthday", "anniversary", "deadline"]);
const inRange = (d: string, from: string, to: string) => d >= from && d <= to;
const firstName = (name: string) => (/^(Mum|Dad)$/.test(name) ? name : name.replace(/^Dr\.?\s+/, "").split(/\s+/)[0]);

function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function avg(xs: (number | undefined | null)[]): number | undefined {
  const set = xs.filter((x): x is number => typeof x === "number" && x > 0);
  return set.length ? Math.round(set.reduce((a, b) => a + b, 0) / set.length) : undefined;
}

/** Who was seen in person and who was caught up with, as the page's people cards name them. */
function people(f: WeekFacts, end: string): { name: string; inPerson: boolean }[] {
  const byId = new Map<string, { name: string; inPerson: boolean; dates: string[] }>();
  const add = (id: string, name: string, date: string, inPerson: boolean) => {
    const prev = byId.get(id);
    if (!prev) return void byId.set(id, { name, inPerson, dates: [date] });
    if (!prev.dates.includes(date)) prev.dates.push(date);
    if (inPerson) prev.inPerson = true;
  };
  for (const i of [...f.interactions].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!CATCH_UP.has(i.channel) || i.archived_at) continue;
    const date = zonedToday(new Date(i.at), f.tz);
    if (!inRange(date, f.from, end)) continue;
    for (const p of i.people) add(p.id, p.name, date, i.channel === "in_person");
  }
  for (const e of [...f.seenEvents].sort((a, b) => b.date.localeCompare(a.date))) {
    if (!inRange(e.date, f.from, end) || !e.place) continue;
    for (const p of e.people) add(p.id, p.name, e.date, true);
  }
  const out = [...byId.values()];
  for (const p of out) p.dates.sort((a, b) => b.localeCompare(a));
  const firsts = new Map<string, number>();
  for (const p of out) firsts.set(firstName(p.name), (firsts.get(firstName(p.name)) ?? 0) + 1);
  for (const p of out) if (firsts.get(firstName(p.name)) === 1) p.name = firstName(p.name);
  return out.sort((a, b) => Number(b.inPerson) - Number(a.inPerson) || b.dates.length - a.dates.length || b.dates[0].localeCompare(a.dates[0]) || a.name.localeCompare(b.name));
}

/** The headline's signals for a week (or month), as the page builds them. */
export function weekSignals(f: WeekFacts): WeekSignals {
  const { from, to, today, period, tz } = f;
  const end = to > today ? today : to;
  const all = datesOf(from, to);
  const byDate = new Map(f.days.map((d) => [d.date, d]));
  const dayDate = (iso: string) => zonedToday(new Date(iso), tz);
  const periodDays = f.days.filter((d) => inRange(d.date, from, end));
  const seen = people(f, end);

  const places = new Map<string, { isNew: boolean; dates: Set<string> }>();
  for (const d of periodDays)
    for (const p of d.places) {
      if (ROUTINE.has(p.name.toLowerCase())) continue;
      const v = places.get(p.name) ?? { isNew: f.knownPlaces ? !f.knownPlaces.has(p.name) : false, dates: new Set<string>() };
      v.dates.add(d.date);
      places.set(p.name, v);
    }
  const newPlaces = [...places]
    .sort(([an, a], [bn, b]) => b.dates.size - a.dates.size || Number(b.isNew) - Number(a.isNew) || an.localeCompare(bn))
    .filter(([, v]) => v.isNew)
    .map(([name]) => name);

  const trips = f.trips
    .filter((t) => !t.archived_at && t.starts_on && t.ends_on && t.starts_on <= end && t.ends_on >= from)
    .map((t) => ({ place: t.title, days: Math.round((Date.parse(t.ends_on!) - Date.parse(t.starts_on!)) / 86_400_000) + 1 }));

  const todosDone = f.commitments.filter((c) => !c.archived_at && c.status === "done" && c.kind !== "decision" && c.done_at && inRange(dayDate(c.done_at), from, end)).length;
  const decided = new Set<string>();
  for (const c of f.commitments) {
    if (c.kind !== "decision" || c.archived_at || c.status === "dropped") continue;
    const date = dayDate(c.status === "done" && c.done_at ? c.done_at : c.created_at);
    if (inRange(date, from, end)) decided.add(c.title);
  }
  const seenIds = new Set(f.seenEvents.map((e) => e.id));
  let meetings = 0;
  for (const d of periodDays) for (const e of d.events) if (!seenIds.has(e.id) && (e.kind === "meeting" || (e.starts_at && !NOT_MEETINGS.has(e.kind)))) meetings++;

  const health = all.map((date) => ({ date, sleep: byDate.get(date)?.health?.sleep_minutes, mood: byDate.get(date)?.mood, future: date > today }));
  const workouts = periodDays.flatMap((d) => d.health?.workouts ?? []);

  // Habits: one row per habit; a day counts when it has an entry (done, or skipped with a count of 0).
  const habitNames: string[] = [];
  for (const d of periodDays) for (const e of d.entries) if (e.kind === "habit" && !habitNames.includes(e.title)) habitNames.push(e.title);
  let habitsKept = 0;
  let habitsDue = 0;
  for (const name of habitNames)
    for (const date of all) {
      if (date > today) continue;
      const e = byDate.get(date)?.entries.find((x) => x.kind === "habit" && x.title === name);
      if (!e) continue;
      habitsDue++;
      if ((e.count ?? 1) > 0) habitsKept++;
    }

  // Media: one cover per show, album or book, the most played first (only ones with art, as on the shelf).
  const shelf = new Map<string, { kind: string; title: string; sub: string; weight: number }>();
  for (const d of periodDays)
    for (const e of d.entries) {
      if ((e.kind !== "watched" && e.kind !== "read" && e.kind !== "listened") || !e.art) continue;
      const key = `${e.kind}:${e.group ?? e.title}`;
      const s = shelf.get(key) ?? { kind: e.kind, title: e.group ?? e.title, sub: "", weight: 0 };
      s.weight += e.count ?? 1;
      if (e.kind === "listened") s.sub = e.subtitle ?? "Album";
      shelf.set(key, s);
    }
  const shelfList = [...shelf.values()].sort((a, b) => b.weight - a.weight).slice(0, period === "week" ? 8 : 12);

  return {
    period,
    seen: seen.filter((p) => p.inPerson).map((p) => p.name),
    caughtUp: seen.filter((p) => !p.inPerson).map((p) => p.name),
    trips,
    newPlaces,
    todosDone,
    meetings,
    decisions: decided.size,
    goalsMoved: f.goalMoves.filter((g) => g.now > g.was).map((g) => g.title),
    workouts: workouts.length,
    runKm: workouts.reduce((a, w) => a + (w.distance_m ? w.distance_m / 1000 : 0), 0) || undefined,
    sleepAvg: avg(health.map((h) => h.sleep)),
    habitsKept,
    habitsDue,
    moods: health.filter((h) => !h.future).map((h) => h.mood ?? null),
    media: { show: shelfList.find((s) => s.kind === "watched")?.title, artist: shelfList.find((s) => s.kind === "listened")?.sub, book: shelfList.find((s) => s.kind === "read")?.title },
  };
}

/** Monday of the week holding `date`. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

/**
 * The week's headline, read from the database: the text the Sunday push
 * sends and the page shows at the top of the same week.
 */
export async function weekPushHeadline(today: string, tz: string): Promise<{ text: string; monday: string }> {
  const [{ getDay }, { listInteractions, listCommitments }, { listTrips }, { weekReviewExtras }, { q }] = await Promise.all([
    import("./days"),
    import("./memory"),
    import("./trips"),
    import("./week-review"),
    import("./db"),
  ]);
  const from = mondayOf(today);
  const to = addDays(from, 6);
  const end = to > today ? today : to;
  const since = zonedToInstant(addDays(from, -1), "00:00", tz);
  const until = zonedToInstant(addDays(end, 2), "00:00", tz);
  const [days, interactions, done, decisions, trips, extras] = await Promise.all([
    Promise.all(datesOf(from, end).map((d) => getDay(d, { tz }).catch(() => null))),
    listInteractions({ since, until, limit: 500 }),
    listCommitments({ status: "done", doneSince: since, limit: 500 }),
    q<PushCommitment>(
      `SELECT title, kind, status, done_at, created_at, archived_at FROM commitments
       WHERE kind = 'decision' AND archived_at IS NULL AND (created_at >= $1 OR done_at >= $1)`,
      [since.toISOString()],
    ),
    listTrips({ today }),
    weekReviewExtras(from, to, tz),
  ]);
  const signals = weekSignals({
    period: "week",
    from,
    to,
    today,
    tz,
    days: days.filter((d): d is Day => !!d),
    interactions,
    seenEvents: extras.seen,
    commitments: [...done.filter((c) => c.kind !== "decision"), ...decisions],
    goalMoves: extras.goals,
    trips,
    knownPlaces: new Set(extras.known_places),
  });
  return { text: weekHeadline(signals).text, monday: from };
}
