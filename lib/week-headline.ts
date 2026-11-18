/**
 * The week (or month) in review's headline (app/src/views/days-recap.ts) and
 * the Sunday push (netlify/functions/reminders.ts §4b), from rules
 * rather than a model. Owner decisions 2026-11-08: people seen, places and
 * trips, what got done, and health, habits and mood come before media. Media
 * only makes the headline when nothing else happened. No AI.
 *
 * Pure and DOM-free so it runs under `npx tsx --test`. Each signal becomes a
 * candidate clause with a weight; the three heaviest win (at most one per
 * kind, two for work), then read in page order: people, places, done,
 * health. Mood, when the owner set it on enough days, leads the line.
 */

export type Period = "week" | "month";

export interface WeekSignals {
  period: Period;
  /** Seen in person (lunch, coffee, a visit). First names are enough. */
  seen: string[];
  /** Calls and video calls, people not already in `seen`. */
  caughtUp: string[];
  /** Trips that happened in the period. */
  trips: { place: string; days?: number }[];
  /** Places other than home, work and the commute that were new this period. */
  newPlaces: string[];
  todosDone: number;
  meetings: number;
  decisions: number;
  /** Goals that moved forward. */
  goalsMoved: string[];
  workouts: number;
  /** Running distance across the period, in km. */
  runKm?: number;
  /** Average sleep a night, in minutes. */
  sleepAvg?: number;
  /** Habit days kept out of habit days due. */
  habitsKept?: number;
  habitsDue?: number;
  /** One mood per day, null when the owner didn't set one. */
  moods: (number | null)[];
  media: { show?: string; film?: string; artist?: string; book?: string };
}

export type Source = "mood" | "people" | "places" | "done" | "health" | "media" | "none";

export interface Headline {
  text: string;
  /** What the line was built from, in order. Not shown (the caption came out, 2026-11-08); the tests read it. */
  from: Source[];
}

type Kind = "people" | "places" | "done" | "health" | "media";
interface Clause {
  kind: Kind;
  weight: number;
  text: string;
  /** Order within a kind on the page: goals, to-dos, meetings, decisions. */
  at: number;
}

const ORDER: Kind[] = ["people", "places", "done", "health", "media"];
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const num = (n: number) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(Math.round(n)));
const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
export function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const names = (xs: string[]) => (xs.length <= 3 ? joinList(xs) : `${xs.slice(0, 2).join(", ")} and ${count(xs.length - 2, "other")}`);

const MOOD_LEAD: Record<Period, string[]> = {
  week: ["", "A rough week", "A hard week", "A steady week", "A good week", "A great week"],
  month: ["", "A rough month", "A hard month", "A steady month", "A good month", "A great month"],
};

/** Mood leads only when it was set on at least two days (a week) or a quarter of the days (a month). */
function moodLead(s: WeekSignals): string | null {
  const set = s.moods.filter((m): m is number => typeof m === "number" && m >= 1 && m <= 5);
  const need = s.period === "week" ? 2 : Math.ceil(s.moods.length / 4);
  if (set.length < need || !set.length) return null;
  return MOOD_LEAD[s.period][Math.round(set.reduce((a, b) => a + b, 0) / set.length)];
}

function clauses(s: WeekSignals): Clause[] {
  const out: Clause[] = [];
  const month = s.period === "month";
  const push = (kind: Kind, weight: number, text: string) => out.push({ kind, weight, text, at: out.length });

  // People and places
  if (s.seen.length) push("people", 80 + s.seen.length * 5, `time with ${names(s.seen)}`);
  else if (s.caughtUp.length) push("people", 50 + s.caughtUp.length * 3, `${s.caughtUp.length === 1 ? "a catch-up" : "catch-ups"} with ${names(s.caughtUp)}`);
  if (s.trips.length === 1) {
    const t = s.trips[0];
    push("places", 100, t.days && t.days > 1 ? `${num(t.days)} days in ${t.place}` : `a trip to ${t.place}`);
  } else if (s.trips.length > 1) push("places", 100, `trips to ${joinList(s.trips.map((t) => t.place))}`);
  else if (s.newPlaces.length) push("places", 40, s.newPlaces.length === 1 ? `a first visit to ${s.newPlaces[0]}` : `${count(s.newPlaces.length, "new place")}`);

  // What got done. Thresholds scale for a month.
  const k = month ? 4 : 1;
  if (s.goalsMoved.length) push("done", 60, s.goalsMoved.length === 1 ? `${s.goalsMoved[0]} moved on` : `${count(s.goalsMoved.length, "goal")} moved on`);
  if (s.todosDone >= 3 * k) push("done", 30 + Math.min(s.todosDone / k, 20) * 2, `${count(s.todosDone, "to-do")} done`);
  if (s.meetings >= 8 * k) push("done", 35 + Math.min(s.meetings / k, 20), count(s.meetings, "meeting"));
  if (s.decisions >= 1) push("done", 25 + s.decisions * 5, count(s.decisions, "decision"));

  // Health and habits
  if (s.workouts >= 2 * k) push("health", 35 + Math.min(s.workouts / k, 7) * 3, count(s.workouts, "workout"));
  if (s.habitsDue && s.habitsDue >= 7 && (s.habitsKept ?? 0) / s.habitsDue >= 0.85) push("health", 30, "habits kept almost every day");
  if (s.sleepAvg && s.sleepAvg < 390) push("health", 28, "short nights");
  else if (s.sleepAvg && s.sleepAvg >= 480) push("health", 18, "long nights");

  // Media: weighted low, and dropped below unless nothing else made it.
  if (s.media.show) push("media", 10, `the ${s.media.show} finale`.replace(/^the the /i, "the "));
  if (s.media.artist) push("media", 9, `a lot of ${s.media.artist}`);
  if (s.media.film) push("media", 8, s.media.film);
  if (s.media.book) push("media", 7, s.media.book);
  return out;
}

const MAX_LEN = 96;

export function weekHeadline(s: WeekSignals): Headline {
  const all = clauses(s);
  const life = all.filter((c) => c.kind !== "media");
  const pool = (life.length ? life : all).sort((a, b) => b.weight - a.weight);
  const picked: Clause[] = [];
  for (const c of pool) {
    const same = picked.filter((p) => p.kind === c.kind).length;
    if (same >= (c.kind === "done" ? 2 : 1)) continue;
    picked.push(c);
    if (picked.length === 3) break;
  }
  picked.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.at - b.at);

  const lead = moodLead(s);
  const quiet = s.period === "week" ? "A quiet week" : "A quiet month";
  const compose = (cs: Clause[]) => {
    const body = joinList(cs.map((c) => c.text));
    if (!body) return lead ?? quiet;
    return lead ? `${lead}: ${body}` : body[0].toUpperCase() + body.slice(1);
  };
  while (compose(picked).length > MAX_LEN && picked.length > 1) picked.pop();
  const text = compose(picked);

  const from: Source[] = [];
  if (lead) from.push("mood");
  for (const c of picked) if (!from.includes(c.kind)) from.push(c.kind);
  if (!from.length) from.push("none");
  return { text, from };
}
