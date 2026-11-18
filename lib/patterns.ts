/**
 * Patterns: things that tend to go together in the owner's own days, said
 * plainly ("You sleep 40 min longer on days you do yoga").
 *
 * Pure: no database, no clock, no logging. The server opens the sealed days
 * (lib/patterns-data.ts) and hands them here; sample mode and the tests use
 * the same code. Shared by the server and the PWA, so it imports nothing.
 *
 * How a pattern is found, for one outcome (sleep, deep sleep, mood, steps,
 * resting heart rate) and one factor (a workout kind, a late meeting, a
 * busy calendar, a place, a lot of watching, a tag, the weekend, a short
 * night, a long run, caffeine after 2pm, a drink, a late meal, more water,
 * a mindful session, a long commute, podcasts, listening):
 *  1. Split the window's days into days with the factor and days without.
 *     A day where the factor can't be known (no calendar, no places that
 *     day) is on neither side.
 *  2. Read the outcome on the right day: the night after for sleep, the next
 *     morning for resting heart rate, the same day for mood and steps, and
 *     the day after for "the day after" pairs.
 *  3. Keep it only with at least MIN_SIDE days on each side, a difference
 *     big enough to notice (MEANINGFUL) and a permutation test that says it
 *     is unlikely to be chance, corrected for how many pairs were tried
 *     (Benjamini–Hochberg).
 *  4. Rank by size × how sure, one per factor and outcome, a handful in all.
 *
 * It finds things that go together. It never says one causes the other,
 * and the words never give advice.
 */

export const OUTCOMES = ["sleep", "deep", "mood", "steps", "resting_hr"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);

export const WINDOWS = [30, 90, 365] as const;
export type PatternWindow = (typeof WINDOWS)[number];
export const isWindow = (v: unknown): v is PatternWindow => WINDOWS.includes(Number(v) as PatternWindow);

/** At least this many days on each side. */
export const MIN_SIDE = 8;
/** At most this many patterns come back. */
export const MAX_PATTERNS = 6;
/** The false discovery rate the kept patterns are held to. */
export const FDR = 0.05;
/** Shuffles per test. */
export const PERMUTATIONS = 2000;

/** The smallest difference worth saying, in each outcome's own units, and the smallest standardised size. */
export const MEANINGFUL: Record<Outcome, number> = { sleep: 15, deep: 6, mood: 0.35, steps: 900, resting_hr: 1.5 };
export const MIN_EFFECT = 0.35;

/** One day as the engine reads it. Leave a field out when it isn't known for that day. */
export interface PatternDay {
  date: string;
  /** Minutes asleep the night that ended this morning. */
  sleep?: number;
  /** Minutes of deep sleep that night. */
  deep?: number;
  /** 1 (Rough) to 5 (Great). */
  mood?: number;
  steps?: number;
  resting_hr?: number;
  /** The day's workouts ([] on a day with health but none). Workout kinds as lib/health-line.ts workoutKind says them: "run", "yoga". */
  workouts?: Array<{ kind: string; minutes: number; distance_m?: number }>;
  /** Local start hour (0–23.99) of each meeting: a timed event with someone else on it, not a solo appointment ([] when the calendar is known and empty). */
  meetings?: number[];
  /** Names of the places visited ([] when places are known and there were none). */
  places?: string[];
  /** Minutes of watching (films, shows, videos). */
  watch_minutes?: number;
  /** The owner's own tags for the day ("alcohol-free"), when Athena has any. */
  tags?: string[];
  /** Caffeine from 2pm on, mg (0 on a day with caffeine known and none late). */
  caffeine_late_mg?: number;
  /** Alcoholic drinks (0 on a day with food and drink known and none). */
  drinks?: number;
  /** Local hour (0–23.99) of the day's last meal. */
  last_meal?: number;
  water_ml?: number;
  /** Mindful minutes (0 on a day with mind known and none). */
  mindful_minutes?: number;
  /** Each habit logged that day, done or not (Habitify, Todoist, Loop: lib/habits.ts). */
  habits?: Record<string, boolean>;
  /** Spent eating out and on takeaways, minor units (lib/money.ts). Only when the owner turned Money on. */
  eating_out?: number;
  /** Share of the day's electricity used 18:00–23:00, 0–1 (lib/money.ts). Only when the owner turned Home on. */
  home_evening?: number;
  /** Minutes on TfL journeys (0 on a day inside the journey history with none). */
  commute_minutes?: number;
  /** Minutes of podcasts (Overcast), only on days where every episode's minutes are known. */
  podcast_minutes?: number;
  /** Minutes listening to music and podcasts, only once music minutes have come in. */
  listen_minutes?: number;
}

export type FactorKind = "workout" | "any_workout" | "long_run" | "late_meeting" | "busy_calendar" | "place" | "watching" | "weekend" | "short_sleep" | "tag" | "caffeine_late" | "drinks" | "late_meal" | "water" | "mindful" | "habit" | "eating_out" | "home_evening" | "commute" | "podcasts" | "listening";

export interface Factor {
  /** "workout:yoga", "place:Dishoom", "weekend". */
  key: string;
  kind: FactorKind;
  /** The workout kind, place or tag; the threshold for busy_calendar (meetings), watching (minutes) and short_sleep (minutes). */
  name?: string;
  amount?: number;
  /** Which days it's true on (only days where it can be known are in the map). */
  on: Map<string, boolean>;
  /** Same-day only (the weekend, a short night): no "the day after". */
  sameDayOnly?: boolean;
  /** Not paired with sleep (a short night against sleep says nothing). */
  noSleep?: boolean;
  /** Only these outcomes, at these lags (food, drink and mind: the pairings in connectors-research-2's table). */
  pairs?: Partial<Record<Outcome, Lag[]>>;
}

export type Lag = 0 | 1;

/** How sure: 1 a hint, 2 fairly sure, 3 sure. */
export type Sure = 1 | 2 | 3;

export interface Pattern {
  /** factor|outcome|lag: stable, so a digest can tell new from changed. */
  id: string;
  factor: string;
  factor_kind: FactorKind;
  factor_name?: string;
  outcome: Outcome;
  /** 0: the same day (mood, steps) or the natural pairing (the night after for sleep, the next morning for heart rate). 1: the day after. */
  lag: Lag;
  /** With minus without, in the outcome's units (minutes, steps, bpm, mood steps). */
  diff: number;
  with_avg: number;
  without_avg: number;
  n_with: number;
  n_without: number;
  /** Days with the factor whose outcome is on the pattern's side of the usual (for mood: Good or Great, or Low or Rough). */
  beat: number;
  /** The same count among the days without, for mood's evidence. */
  beat_without: number;
  sure: Sure;
  score: number;
  /** The factor's days in the window: a day page shows the pattern when its date is here. */
  dates: string[];
  /** "You sleep 40 min longer on days you do yoga". */
  line: string;
  /** "Longer than usual on 14 of 21 days you do yoga". */
  evidence: string;
}

export interface FindOptions {
  /** The last day counted (the owner's today). */
  today: string;
  window: PatternWindow | number;
  /** Only these outcomes. */
  outcomes?: Outcome[];
  max?: number;
  /** Leave place factors out (Ask, unless the question is about places). */
  places?: boolean;
}

// ---------- Dates ----------

const DAY_MS = 86_400_000;
const t = (date: string) => Date.parse(`${date}T12:00:00Z`);
export function addDays(date: string, n: number): string {
  return new Date(t(date) + n * DAY_MS).toISOString().slice(0, 10);
}
const isWeekend = (date: string) => {
  const d = new Date(t(date)).getUTCDay();
  return d === 0 || d === 6;
};

// ---------- Numbers ----------

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1);
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
}
const median = (xs: number[]) => quantile(xs, 0.5);

/** A small seeded generator (mulberry32), so the same days always give the same answer. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Two-sided permutation test on the difference in means: how often shuffled
 * labels give a difference at least as large. (k + 1) / (n + 1), so never 0.
 */
export function permutationP(a: number[], b: number[], seed: number, rounds = PERMUTATIONS): number {
  const all = [...a, ...b];
  const n = a.length;
  const total = all.reduce((x, y) => x + y, 0);
  const observed = Math.abs(mean(a) - mean(b));
  const rand = rng(seed);
  const pool = all.slice();
  let k = 0;
  for (let r = 0; r < rounds; r++) {
    // A partial Fisher–Yates: only the first n need shuffling.
    let sumA = 0;
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rand() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
      sumA += pool[i];
    }
    const d = Math.abs(sumA / n - (total - sumA) / (pool.length - n));
    if (d >= observed - 1e-9) k++;
  }
  return (k + 1) / (rounds + 1);
}

/** Benjamini–Hochberg adjusted values, in the input's order. */
export function adjustBH(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const out = new Array<number>(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, i] = order[r];
    min = Math.min(min, (p * m) / (r + 1));
    out[i] = min;
  }
  return out;
}

// ---------- Factors ----------

const LONG_RUN_M = 10_000;
const LONG_RUN_MIN = 60;
const LATE_HOUR = 18;
/** The newer factors (habits, eating out, evenings at home) need this many days where they're known, not just MIN_SIDE a side. */
export const MIN_KNOWN = 20;
/** An evening at home: at least half the day's electricity used 18:00–23:00. */
const HOME_EVENING = 0.5;
/** Places on more days than this share are the backdrop (home, work), not a factor. */
const EVERYDAY_SHARE = 0.8;
/** A meal from this hour on is a late one. */
const LATE_MEAL_HOUR = 20;
/** A long commute is never under this many minutes. */
const LONG_COMMUTE_MIN = 60;

/** Every factor the days can support, each known only where it can be. */
export function factorsOf(days: PatternDay[]): Factor[] {
  const out: Factor[] = [];
  const add = (f: Omit<Factor, "on">, pick: (d: PatternDay) => boolean | undefined) => {
    const on = new Map<string, boolean>();
    for (const d of days) {
      const v = pick(d);
      if (v !== undefined) on.set(d.date, v);
    }
    out.push({ ...f, on });
  };
  const health = days.filter((d) => d.workouts);
  const kinds = new Map<string, number>();
  for (const d of health) for (const k of new Set(d.workouts!.map((w) => w.kind))) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  for (const [kind, n] of kinds) {
    if (n < MIN_SIDE || kind === "workout") continue;
    add({ key: `workout:${kind}`, kind: "workout", name: kind }, (d) => (d.workouts ? d.workouts.some((w) => w.kind === kind) : undefined));
  }
  if (kinds.size > 1) add({ key: "any_workout", kind: "any_workout" }, (d) => (d.workouts ? d.workouts.length > 0 : undefined));
  add({ key: "long_run", kind: "long_run" }, (d) =>
    d.workouts ? d.workouts.some((w) => w.kind === "run" && ((w.distance_m ?? 0) >= LONG_RUN_M || w.minutes >= LONG_RUN_MIN)) : undefined,
  );

  const cal = days.filter((d) => d.meetings);
  if (cal.some((d) => d.meetings!.length)) {
    add({ key: "late_meeting", kind: "late_meeting" }, (d) => (d.meetings ? d.meetings.some((h) => h >= LATE_HOUR) : undefined));
    // Busy: the top quarter of days with meetings, at least 4.
    const counts = cal.map((d) => d.meetings!.length).filter((n) => n > 0);
    const busy = Math.max(4, Math.ceil(quantile(counts, 0.75)));
    add({ key: "busy_calendar", kind: "busy_calendar", amount: busy }, (d) => (d.meetings ? d.meetings.length >= busy : undefined));
  }

  const placed = days.filter((d) => d.places);
  const visits = new Map<string, number>();
  for (const d of placed) for (const p of new Set(d.places)) visits.set(p, (visits.get(p) ?? 0) + 1);
  for (const [name, n] of visits) {
    if (n < MIN_SIDE || n > placed.length * EVERYDAY_SHARE) continue;
    add({ key: `place:${name}`, kind: "place", name }, (d) => (d.places ? d.places.includes(name) : undefined));
  }

  const watched = days.filter((d) => d.watch_minutes !== undefined);
  if (watched.some((d) => d.watch_minutes! > 0)) {
    // Two hours if there are enough such days, else one.
    const lots = watched.filter((d) => d.watch_minutes! >= 120).length >= MIN_SIDE ? 120 : 60;
    add({ key: "watching", kind: "watching", amount: lots }, (d) => (d.watch_minutes === undefined ? undefined : d.watch_minutes >= lots));
  }

  const tags = new Map<string, number>();
  for (const d of days) for (const g of new Set(d.tags ?? [])) tags.set(g, (tags.get(g) ?? 0) + 1);
  const tagged = days.some((d) => d.tags);
  for (const [name, n] of tags) {
    if (n < MIN_SIDE) continue;
    add({ key: `tag:${name}`, kind: "tag", name }, (d) => (tagged ? (d.tags ?? []).includes(name) : undefined));
  }

  // Food, drink and mind (Apple Health, Oura's tags and sessions): known only on days that have them.
  // Each is tried only against what it can plausibly touch, the same night or the next day (connectors-research-2, "New Patterns factors").
  if (days.some((d) => (d.caffeine_late_mg ?? 0) > 0)) add({ key: "caffeine_late", kind: "caffeine_late", pairs: { sleep: [0], deep: [0], resting_hr: [0] } }, (d) => (d.caffeine_late_mg === undefined ? undefined : d.caffeine_late_mg > 0));
  if (days.some((d) => (d.drinks ?? 0) > 0)) add({ key: "drinks", kind: "drinks", pairs: { deep: [0], resting_hr: [0], mood: [1] } }, (d) => (d.drinks === undefined ? undefined : d.drinks > 0));
  if (days.some((d) => d.last_meal !== undefined && d.last_meal >= LATE_MEAL_HOUR)) add({ key: "late_meal", kind: "late_meal", amount: LATE_MEAL_HOUR, pairs: { sleep: [0], deep: [0] } }, (d) => (d.last_meal === undefined ? undefined : d.last_meal >= LATE_MEAL_HOUR));
  const watered = days.filter((d) => d.water_ml !== undefined).map((d) => d.water_ml!);
  if (watered.length >= MIN_SIDE * 2) {
    // More water: the owner's own top half, to the 100 ml.
    const plenty = Math.max(500, Math.round(quantile(watered, 0.5) / 100) * 100);
    add({ key: "water", kind: "water", amount: plenty, pairs: { mood: [1], steps: [1] } }, (d) => (d.water_ml === undefined ? undefined : d.water_ml >= plenty));
  }
  if (days.some((d) => (d.mindful_minutes ?? 0) > 0)) add({ key: "mindful", kind: "mindful", pairs: { mood: [0, 1], resting_hr: [0] } }, (d) => (d.mindful_minutes === undefined ? undefined : d.mindful_minutes > 0));

  // Habits, eating out and evenings at home (lib/habits.ts, lib/money.ts): only with MIN_KNOWN days where they can be known.
  const known = (pick: (d: PatternDay) => boolean | undefined) => {
    const v = days.map(pick).filter((x) => x !== undefined);
    return v.length >= MIN_KNOWN && v.filter(Boolean).length >= MIN_SIDE && v.filter((x) => !x).length >= MIN_SIDE;
  };
  const habitNames = new Set(days.flatMap((d) => Object.keys(d.habits ?? {})));
  for (const name of habitNames) {
    const pick = (d: PatternDay) => (d.habits && name in d.habits ? d.habits[name] : undefined);
    if (known(pick)) add({ key: `habit:${name}`, kind: "habit", name, pairs: { mood: [0, 1], sleep: [0] } }, pick);
  }
  const ateOut = (d: PatternDay) => (d.eating_out === undefined ? undefined : d.eating_out > 0);
  if (known(ateOut)) add({ key: "eating_out", kind: "eating_out", pairs: { sleep: [0], steps: [1], mood: [0] } }, ateOut);
  const homeEvening = (d: PatternDay) => (d.home_evening === undefined ? undefined : d.home_evening >= HOME_EVENING);
  if (known(homeEvening)) add({ key: "home_evening", kind: "home_evening", pairs: { sleep: [0] } }, homeEvening);

  // Commute, podcasts and listening (lib/tfl-csv.ts, lib/overcast-opml.ts): the pairings in connectors-research-2's table, same day or that night.
  // A long commute: the owner's top quarter of commuting days, to the quarter hour, an hour at least. Weekends are on neither side, so this isn't weekdays against weekends.
  const commuted = days.filter((d) => (d.commute_minutes ?? 0) > 0).map((d) => d.commute_minutes!);
  if (commuted.length >= MIN_SIDE) {
    const long = Math.max(LONG_COMMUTE_MIN, Math.round(quantile(commuted, 0.75) / 15) * 15);
    const pick = (d: PatternDay) => (d.commute_minutes === undefined || isWeekend(d.date) ? undefined : d.commute_minutes >= long);
    if (known(pick)) add({ key: "commute", kind: "commute", amount: long, pairs: { steps: [0], mood: [0], sleep: [0] } }, pick);
  }
  const lots = (pick: (d: PatternDay) => number | undefined, more: number, less: number) =>
    days.filter((d) => (pick(d) ?? 0) >= more).length >= MIN_SIDE ? more : less;
  const podcastMin = lots((d) => d.podcast_minutes, 60, 30);
  const podcasts = (d: PatternDay) => (d.podcast_minutes === undefined ? undefined : d.podcast_minutes >= podcastMin);
  if (known(podcasts)) add({ key: "podcasts", kind: "podcasts", amount: podcastMin, pairs: { mood: [0] } }, podcasts);
  const listenMin = lots((d) => d.listen_minutes, 120, 60);
  const listening = (d: PatternDay) => (d.listen_minutes === undefined ? undefined : d.listen_minutes >= listenMin);
  if (known(listening)) add({ key: "listening", kind: "listening", amount: listenMin, pairs: { mood: [0] } }, listening);

  add({ key: "weekend", kind: "weekend", sameDayOnly: true }, (d) => isWeekend(d.date));

  const slept = days.filter((d) => d.sleep !== undefined).map((d) => d.sleep!);
  if (slept.length >= MIN_SIDE * 2) {
    // A short night: the owner's own bottom quarter, to the quarter hour, between 5 and 7 hours.
    const under = Math.min(420, Math.max(300, Math.round(quantile(slept, 0.25) / 15) * 15));
    add({ key: "short_sleep", kind: "short_sleep", amount: under, sameDayOnly: true, noSleep: true }, (d) => (d.sleep === undefined ? undefined : d.sleep < under));
  }
  return out;
}

/** The day an outcome is read from, for a factor on `date`: sleep and heart rate come from the next morning. */
function outcomeDay(date: string, outcome: Outcome, lag: Lag, sameDay: boolean): string {
  const natural = !sameDay && (outcome === "sleep" || outcome === "deep" || outcome === "resting_hr") ? 1 : 0;
  return addDays(date, natural + lag);
}

/** Which lags each outcome is tried at: mood and steps also "the day after". */
const LAGS: Record<Outcome, Lag[]> = { sleep: [0], deep: [0], mood: [0, 1], steps: [0, 1], resting_hr: [0] };

// ---------- Words ----------

const VERB: Record<string, string> = {
  run: "run",
  walk: "go for a walk",
  hike: "go hiking",
  swim: "swim",
  ride: "cycle",
  row: "row",
  yoga: "do yoga",
  pilates: "do pilates",
  HIIT: "do HIIT",
  strength: "do strength training",
};

/** "40 min", "1h 5m". */
export function minutesWords(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r - h * 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}
const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const thousands = (n: number) => Math.round(n).toLocaleString("en-GB");

interface Phrases {
  /** "on days you do yoga" */
  on: string;
  /** "the day after you do yoga" */
  after: string;
  /** For the evidence: "days you do yoga", "days after you do yoga". */
  days: string;
  daysAfter: string;
}

function phrases(f: Pick<Factor, "kind" | "name" | "amount">): Phrases {
  const verb = (k: string) => VERB[k] ?? `do ${k}`;
  switch (f.kind) {
    case "workout": {
      const v = verb(f.name!);
      return { on: `on days you ${v}`, after: `the day after you ${v}`, days: `days you ${v}`, daysAfter: `days after you ${v}` };
    }
    case "any_workout":
      return { on: "on days you work out", after: "the day after you work out", days: "days you work out", daysAfter: "days after you work out" };
    case "long_run":
      return { on: "on days you go for a long run", after: "the day after a long run", days: "days with a long run", daysAfter: "days after a long run" };
    case "late_meeting":
      return { on: "on days with a meeting after 6pm", after: "the day after a meeting after 6pm", days: "days with a meeting after 6pm", daysAfter: "days after a late meeting" };
    case "busy_calendar":
      return { on: `on days with ${f.amount} or more meetings`, after: `the day after ${f.amount} or more meetings`, days: `days with ${f.amount} or more meetings`, daysAfter: `days after ${f.amount} or more meetings` };
    case "place":
      return { on: `on days you go to ${f.name}`, after: `the day after you go to ${f.name}`, days: `days at ${f.name}`, daysAfter: `days after ${f.name}` };
    case "watching": {
      const a = f.amount === 60 ? "an hour" : `${(f.amount ?? 120) / 60} hours`;
      return { on: `on days with ${a} or more of watching`, after: `the day after ${a} or more of watching`, days: `days with ${a} or more of watching`, daysAfter: `days after a lot of watching` };
    }
    case "tag":
      return { on: `on ${f.name} days`, after: `the day after a ${f.name} day`, days: `${f.name} days`, daysAfter: `days after a ${f.name} day` };
    case "caffeine_late":
      return { on: "on days you have caffeine after 2pm", after: "the day after late caffeine", days: "days with caffeine after 2pm", daysAfter: "days after late caffeine" };
    case "drinks":
      return { on: "on days you have a drink", after: "the day after a drink", days: "days with a drink", daysAfter: "days after a drink" };
    case "late_meal":
      return { on: "on days you eat after 8pm", after: "the day after a late meal", days: "days you eat after 8pm", daysAfter: "days after a late meal" };
    case "water": {
      const ml = f.amount ?? 1500;
      const w = ml >= 1000 ? `${Math.round(ml / 100) / 10} L` : `${ml} ml`;
      return { on: `on days you drink ${w} of water or more`, after: `the day after you drink ${w} of water or more`, days: `days with ${w} of water or more`, daysAfter: `days after you drink ${w} of water or more` };
    }
    case "mindful":
      return { on: "on days with a mindful session", after: "the day after a mindful session", days: "days with a mindful session", daysAfter: "days after a mindful session" };
    case "habit":
      return { on: `on days you tick off “${f.name}”`, after: `the day after you tick off “${f.name}”`, days: `days you tick off “${f.name}”`, daysAfter: `days after “${f.name}”` };
    case "eating_out":
      return { on: "on days you eat out or get a takeaway", after: "the day after you eat out", days: "days you eat out", daysAfter: "days after eating out" };
    case "home_evening":
      return { on: "on evenings at home", after: "the day after an evening at home", days: "evenings at home", daysAfter: "days after an evening at home" };
    case "commute": {
      const a = f.amount === 60 ? "an hour" : minutesWords(f.amount ?? 60);
      return { on: `on days with ${a} or more of commuting`, after: `the day after ${a} or more of commuting`, days: `days with ${a} or more of commuting`, daysAfter: `days after a long commute` };
    }
    case "podcasts":
    case "listening": {
      const m = f.amount ?? 60;
      const a = m === 60 ? "an hour" : m % 60 ? `${m} min` : `${m / 60} hours`;
      const what = f.kind === "podcasts" ? "podcasts" : "listening";
      return { on: `on days with ${a} or more of ${what}`, after: `the day after ${a} or more of ${what}`, days: `days with ${a} or more of ${what}`, daysAfter: `days after a lot of ${what}` };
    }
    case "weekend":
      return { on: "at weekends", after: "at weekends", days: "weekend days", daysAfter: "weekend days" };
    case "short_sleep": {
      const n = minutesWords(f.amount ?? 390).replace(" min", "m");
      return { on: `after a night under ${n}`, after: `after a night under ${n}`, days: `days after a night under ${n}`, daysAfter: `days after a night under ${n}` };
    }
  }
}

/** The size of a pattern as a card's big figure: "+40 min", "−2 bpm", "+2,600"; mood has a word, not a number. Rounded as the line rounds it. */
export function patternFigure(p: Pick<Pattern, "outcome" | "diff">): { figure: string; unit: string } {
  const abs = Math.abs(p.diff);
  const sign = p.diff > 0 ? "+" : "−";
  switch (p.outcome) {
    case "sleep":
      return { figure: `${sign}${minutesWords(abs >= 20 ? roundTo(abs, 5) : abs)}`, unit: "sleep" };
    case "deep":
      return { figure: `${sign}${minutesWords(abs >= 15 ? roundTo(abs, 5) : abs)}`, unit: "deep sleep" };
    case "steps":
      return { figure: `${sign}${thousands(roundTo(abs, 100))}`, unit: "steps" };
    case "resting_hr":
      return { figure: `${sign}${Math.max(1, Math.round(abs))} bpm`, unit: "resting heart rate" };
    case "mood":
      return { figure: p.diff > 0 ? "Better" : "Lower", unit: "mood" };
  }
}

/** Short names for a card: the factor ("Yoga", "Weekends"), and its two groups ("Yoga days" against "Other days"). */
export function patternLabels(p: Pick<Pattern, "factor_kind" | "factor_name" | "lag">): { factor: string; with: string; without: string } {
  const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
  const name = p.factor_name ? cap(p.factor_name) : "";
  const factor: Record<FactorKind, string> = {
    workout: name,
    any_workout: "Workouts",
    long_run: "Long runs",
    late_meeting: "Meetings after 6pm",
    busy_calendar: "Busy calendar",
    place: name,
    watching: "Lots of watching",
    weekend: "Weekends",
    short_sleep: "Short nights",
    tag: name,
    caffeine_late: "Caffeine after 2pm",
    drinks: "Drinks",
    late_meal: "Late meals",
    water: "Water",
    mindful: "Mindful minutes",
    habit: name,
    eating_out: "Eating out",
    home_evening: "Evenings at home",
    commute: "Long commutes",
    podcasts: "Podcasts",
    listening: "Listening",
  };
  const days: Record<FactorKind, string> = {
    workout: `${name} days`,
    any_workout: "Workout days",
    long_run: "Long-run days",
    late_meeting: "Late-meeting days",
    busy_calendar: "Busy days",
    place: `${name} days`,
    watching: "Days with lots of watching",
    weekend: "Weekends",
    short_sleep: "After short nights",
    tag: `${name} days`,
    caffeine_late: "Late-caffeine days",
    drinks: "Days with a drink",
    late_meal: "Late-meal days",
    water: "More-water days",
    mindful: "Mindful days",
    habit: "Days done",
    eating_out: "Eating-out days",
    home_evening: "Evenings in",
    commute: "Long-commute days",
    podcasts: "Days with lots of podcasts",
    listening: "Days with lots of listening",
  };
  if (p.factor_kind === "weekend") return { factor: factor.weekend, with: "Weekends", without: "Weekdays" };
  if (p.factor_kind === "commute") return { factor: factor.commute, with: days.commute, without: "Other weekdays" };
  return { factor: factor[p.factor_kind], with: p.lag ? `Days after` : days[p.factor_kind], without: "Other days" };
}

/** The pattern in one plain line, and its evidence. */
export function patternWords(p: Pick<Pattern, "factor_kind" | "factor_name" | "outcome" | "lag" | "diff" | "beat" | "beat_without" | "n_with" | "n_without"> & { amount?: number }): { line: string; evidence: string } {
  const ph = phrases({ kind: p.factor_kind, name: p.factor_name, amount: p.amount });
  const up = p.diff > 0;
  const when = p.lag ? ph.after : ph.on;
  const days = p.lag ? ph.daysAfter : ph.days;
  const abs = Math.abs(p.diff);
  const of = `${p.beat} of ${p.n_with} ${days}`;
  switch (p.outcome) {
    case "sleep": {
      const amt = minutesWords(abs >= 20 ? roundTo(abs, 5) : abs);
      return { line: `You sleep ${amt} ${up ? "longer" : "less"} ${when}`, evidence: `${up ? "Longer" : "Shorter"} than usual on ${of}` };
    }
    case "deep": {
      const amt = minutesWords(abs >= 15 ? roundTo(abs, 5) : abs);
      return { line: `You get ${amt} ${up ? "more" : "less"} deep sleep ${when}`, evidence: `${up ? "More" : "Less"} than usual on ${of}` };
    }
    case "mood":
      return {
        line: `Your mood is ${up ? "better" : "lower"} ${when}`,
        evidence: `${up ? "Good or Great" : "Low or Rough"} on ${of}`,
      };
    case "steps": {
      const amt = thousands(roundTo(abs, 100));
      return { line: `You walk ${amt} ${up ? "more" : "fewer"} steps ${when}`, evidence: `${up ? "More" : "Fewer"} than usual on ${of}` };
    }
    case "resting_hr": {
      const amt = Math.max(1, Math.round(abs));
      const morning = p.factor_kind === "weekend" ? when : ph.after.replace(/^the day after/, "the morning after");
      return { line: `Your resting heart rate is ${amt} bpm ${up ? "higher" : "lower"} ${morning}`, evidence: `${up ? "Higher" : "Lower"} than usual on ${of}` };
    }
  }
}

/** The quiet "how sure" scale, in words. */
export const SURE_WORDS: Record<Sure, string> = { 1: "A hint so far", 2: "Fairly sure", 3: "Sure" };

// ---------- Finding them ----------

interface Tested {
  factor: Factor;
  outcome: Outcome;
  lag: Lag;
  a: number[];
  b: number[];
  dates: string[];
  p: number;
  diff: number;
  effect: number;
  meaningful: boolean;
}

const value = (d: PatternDay | undefined, o: Outcome): number | undefined => (d ? d[o] : undefined);

/**
 * The patterns in the window ending on `today`: at most `max`, strongest
 * first. Nothing comes back when there's too little to go on.
 */
export function findPatterns(all: PatternDay[], opts: FindOptions): Pattern[] {
  const from = addDays(opts.today, -(opts.window - 1));
  const byDate = new Map(all.map((d) => [d.date, d]));
  // Factor days are the window's; an outcome may land on the day after (still never past today).
  const days = all.filter((d) => d.date >= from && d.date <= opts.today);
  const outcomes = opts.outcomes ?? [...OUTCOMES];
  const factors = factorsOf(days).filter((f) => opts.places !== false || f.kind !== "place");

  const tested: Tested[] = [];
  for (const f of factors) {
    for (const outcome of outcomes) {
      if (f.noSleep && (outcome === "sleep" || outcome === "deep")) continue;
      if (f.pairs && !f.pairs[outcome]) continue;
      for (const lag of f.pairs?.[outcome] ?? LAGS[outcome]) {
        if (lag && f.sameDayOnly) continue;
        const a: number[] = [];
        const b: number[] = [];
        const dates: string[] = [];
        for (const [date, has] of f.on) {
          const at = outcomeDay(date, outcome, lag, !!f.sameDayOnly);
          if (at > opts.today) continue;
          const v = value(byDate.get(at), outcome);
          if (has) dates.push(date);
          if (v === undefined) continue;
          (has ? a : b).push(v);
        }
        if (a.length < MIN_SIDE || b.length < MIN_SIDE) continue;
        const diff = mean(a) - mean(b);
        const sd = Math.sqrt(((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2));
        const effect = sd > 0 ? Math.abs(diff) / sd : 0;
        const meaningful = Math.abs(diff) >= MEANINGFUL[outcome] && effect >= MIN_EFFECT;
        // Only meaningful pairs are worth the shuffles; the rest still count towards the correction.
        const p = meaningful ? permutationP(a, b, hash(`${f.key}|${outcome}|${lag}|${a.length}|${b.length}`)) : 1;
        tested.push({ factor: f, outcome, lag, a, b, dates: dates.sort(), p, diff, effect, meaningful });
      }
    }
  }
  if (!tested.length) return [];
  const q = adjustBH(tested.map((x) => x.p));

  const kept: Pattern[] = [];
  tested.forEach((x, i) => {
    if (!x.meaningful || q[i] > FDR) return;
    const minN = Math.min(x.a.length, x.b.length);
    const sure: Sure = q[i] <= 0.002 && minN >= 20 ? 3 : q[i] <= 0.01 && minN >= 12 ? 2 : 1;
    const up = x.diff > 0;
    let beat: number;
    let beatWithout: number;
    if (x.outcome === "mood") {
      const side = (v: number) => (up ? v >= 4 : v <= 2);
      beat = x.a.filter(side).length;
      beatWithout = x.b.filter(side).length;
    } else {
      const usual = median(x.b);
      beat = x.a.filter((v) => (up ? v > usual : v < usual)).length;
      beatWithout = x.b.filter((v) => (up ? v > usual : v < usual)).length;
    }
    const base = {
      factor_kind: x.factor.kind,
      ...(x.factor.name ? { factor_name: x.factor.name } : {}),
      outcome: x.outcome,
      lag: x.lag,
      diff: Math.round(x.diff * 10) / 10,
      beat,
      beat_without: beatWithout,
      n_with: x.a.length,
      n_without: x.b.length,
    };
    const words = patternWords({ ...base, amount: x.factor.amount });
    kept.push({
      id: `${x.factor.key}|${x.outcome}|${x.lag}`,
      factor: x.factor.key,
      ...base,
      with_avg: Math.round(mean(x.a) * 10) / 10,
      without_avg: Math.round(mean(x.b) * 10) / 10,
      sure,
      score: Math.round(x.effect * (1 - q[i]) * Math.min(1, Math.sqrt(minN / 20)) * 1000) / 1000,
      dates: x.dates,
      ...words,
    });
  });

  // One per factor and outcome (the stronger lag), two per factor, strongest first.
  kept.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
  const out: Pattern[] = [];
  const pairs = new Set<string>();
  const perFactor = new Map<string, number>();
  for (const p of kept) {
    const pair = `${p.factor}|${p.outcome}`;
    if (pairs.has(pair) || (perFactor.get(p.factor) ?? 0) >= 2) continue;
    pairs.add(pair);
    perFactor.set(p.factor, (perFactor.get(p.factor) ?? 0) + 1);
    out.push(p);
    if (out.length >= (opts.max ?? MAX_PATTERNS)) break;
  }
  return out;
}

// ---------- Where they show ----------

/** The patterns about one outcome, for a Health card (sleep's card also takes deep sleep). */
export function forOutcome(patterns: Pattern[], ...outcomes: Outcome[]): Pattern[] {
  return patterns.filter((p) => outcomes.includes(p.outcome));
}

/** The strongest pattern a day fits (its date is one of the factor's days), or null. */
export function fitsDay(patterns: Pattern[], date: string): Pattern | null {
  return patterns.find((p) => p.dates.includes(date)) ?? null;
}

// ---------- The weekly digest ----------

export type DigestChange = "new" | "stronger" | "weaker";

export interface WeeklyDigest {
  /** The Monday of the week it covers. */
  week_of: string;
  window: number;
  /** The top new or changed patterns, at most three. */
  items: Array<{ change: DigestChange; pattern: Pattern }>;
  /** Patterns that held last week and don't now (ids and lines only). */
  faded: Array<{ id: string; line: string }>;
}

const mondayOf = (date: string) => addDays(date, -((new Date(t(date)).getUTCDay() + 6) % 7));

/** What changed between last week's patterns and this week's: new first, then those whose size moved by a quarter or more. */
export function digestOf(now: Pattern[], before: Pattern[], today: string, window: number): WeeklyDigest {
  const prev = new Map(before.map((p) => [p.id, p]));
  const items: WeeklyDigest["items"] = [];
  for (const p of now) {
    const was = prev.get(p.id);
    if (!was) items.push({ change: "new", pattern: p });
    else if (Math.abs(p.diff) >= Math.abs(was.diff) * 1.25 || p.sure > was.sure) items.push({ change: "stronger", pattern: p });
    else if (Math.abs(p.diff) <= Math.abs(was.diff) * 0.75 || p.sure < was.sure) items.push({ change: "weaker", pattern: p });
  }
  const rank: Record<DigestChange, number> = { new: 0, stronger: 1, weaker: 2 };
  items.sort((x, y) => rank[x.change] - rank[y.change] || y.pattern.score - x.pattern.score);
  const ids = new Set(now.map((p) => p.id));
  return {
    week_of: mondayOf(today),
    window,
    items: items.slice(0, 3),
    faded: before.filter((p) => !ids.has(p.id)).map((p) => ({ id: p.id, line: p.line })),
  };
}
