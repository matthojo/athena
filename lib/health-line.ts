/**
 * The words of a day's Health line, shared by the server (lib/health.ts, the
 * Life log) and the app (the Health page), so both say it the same way.
 * Pure: no figures are stored or sent from here.
 */
export interface Workout {
  type: string;
  minutes: number;
  distance_m?: number;
  kcal?: number;
  /** Local start time, "HH:MM": how the same workout is matched across sources. */
  start?: string;
  /** Strava's name for it ("Lunch loop"). */
  name?: string;
  elevation_m?: number;
  /** Strava's route as an encoded polyline, drawn on the Health page. */
  route?: string;
}

/**
 * The night in minutes per stage, Apple's names: deep, core (light), REM,
 * awake, in_bed (the whole time in bed) and asleep_unspecified (asleep with
 * no stage, from an app that doesn't stage). Asleep is deep + core + REM +
 * unspecified; awake and in bed never count as sleep.
 */
export interface SleepStages {
  deep?: number;
  core?: number;
  rem?: number;
  awake?: number;
  in_bed?: number;
  asleep_unspecified?: number;
}

export const STAGE_KEYS = ["deep", "core", "rem", "awake", "in_bed", "asleep_unspecified"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** Minutes asleep in a breakdown, or undefined with no sleep in it. */
export function asleepMinutes(s: SleepStages): number | undefined {
  const n = (s.deep ?? 0) + (s.core ?? 0) + (s.rem ?? 0) + (s.asleep_unspecified ?? 0);
  return n > 0 ? n : undefined;
}

/** " (1h 25m deep)" after the hours slept, on a night with deep sleep; "" otherwise. */
export const deepNote = (s: SleepStages | undefined): string => (s?.deep ? ` (${hoursMinutes(s.deep)} deep)` : "");

/** "1h 25m deep · 1h 50m REM": the two stages people ask about, or null without them. */
export function stagesLine(s: SleepStages | undefined): string | null {
  if (!s) return null;
  const parts = [s.deep ? `${hoursMinutes(s.deep)} deep` : "", s.rem ? `${hoursMinutes(s.rem)} REM` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Every stage in words, for Ask: "1h 25m deep · 4h 25m core · 1h 50m REM · 20m awake · 8h 10m in bed". */
export function stagesWords(s: SleepStages | undefined): string | null {
  if (!s) return null;
  const name: Record<StageKey, string> = { deep: "deep", core: "core", rem: "REM", awake: "awake", in_bed: "in bed", asleep_unspecified: "asleep, no stage" };
  const order: StageKey[] = ["deep", "core", "rem", "asleep_unspecified", "awake", "in_bed"];
  const parts = order.filter((k) => s[k]).map((k) => `${hoursMinutes(s[k]!)} ${name[k]}`);
  return parts.length ? parts.join(" · ") : null;
}

/** One source's figures for one day. Every figure is optional; at least one is sent. */
export interface HealthFigures {
  sleep_minutes?: number;
  /** The same night by stage, from the source sleep_minutes came from. */
  sleep_stages?: SleepStages;
  steps?: number;
  active_minutes?: number;
  resting_hr?: number;
  /** Whoop's recovery score for the night ending that morning, 0–100. */
  recovery?: number;
  /** Polar's Nightly Recharge status for that night, 1 (very poor) to 6 (very good). */
  recharge?: number;
  workouts?: Workout[];
  weight_kg?: number;
  // Food, drink and mind (Apple Health, or Oura for mindful minutes and tags).
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  water_ml?: number;
  caffeine_mg?: number;
  /** Local time of the day's last caffeine, "HH:MM". */
  caffeine_last?: string;
  /** Caffeine taken from 14:00 on. */
  caffeine_after_14_mg?: number;
  alcohol_drinks?: number;
  /** Local time of the last dietary-energy sample, "HH:MM". */
  last_meal?: string;
  mindful_minutes?: number;
  /** Apple's State of Mind daily mood, −1 (very unpleasant) to 1 (very pleasant). */
  mood_valence?: number;
  /** Its labels ("Calm", "Grateful"). */
  mood_labels?: string[];
  /** How much energy the owner said they had, 1 (drained) to 5 (full of energy): a check-in's answer. */
  energy?: number;
  /** How stressed the owner said they felt, 1 (not at all) to 5 (very): a check-in's answer. */
  stress?: number;
}

/** About one cup of brewed coffee, in mg: how caffeine becomes "3 coffees". */
export const MG_PER_COFFEE = 95;

/** 1800 → "1.8 L", 450 → "450 ml". */
export const litres = (ml: number) => (ml >= 1000 ? `${oneDecimal(ml / 1000)} L` : `${Math.round(ml)} ml`);

/** "3 coffees, last 15:40", or "40 mg caffeine" for less than half a cup. */
export function caffeinePhrase(f: Pick<HealthFigures, "caffeine_mg" | "caffeine_last">): string {
  if (!f.caffeine_mg) return "";
  const cups = Math.round(f.caffeine_mg / MG_PER_COFFEE);
  const last = f.caffeine_last ? `, last ${f.caffeine_last}` : "";
  return cups >= 1 ? `${cups} ${cups === 1 ? "coffee" : "coffees"}${last}` : `${Math.round(f.caffeine_mg)} mg caffeine${last}`;
}

/**
 * The day's food, drink and mind line: "1,950 kcal · 3 coffees, last 15:40 ·
 * 2 drinks · 1.8 L water · 10 min mindful". `mindful: false` leaves the
 * mindful minutes to the Mind strip. Null when there's nothing to say.
 */
export function foodLine(f: HealthFigures, opts: { mindful?: boolean } = {}): string | null {
  const parts = [
    f.kcal ? `${thousands(f.kcal)} kcal` : "",
    caffeinePhrase(f),
    f.alcohol_drinks ? `${oneDecimal(f.alcohol_drinks)} ${f.alcohol_drinks === 1 ? "drink" : "drinks"}` : "",
    f.water_ml ? `${litres(f.water_ml)} water` : "",
    opts.mindful !== false && f.mindful_minutes ? `${Math.round(f.mindful_minutes)} min mindful` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Valence as a word, Apple's own scale: very unpleasant … very pleasant. */
export function valenceWord(v: number): string {
  if (v <= -0.6) return "Very unpleasant";
  if (v <= -0.2) return "Unpleasant";
  if (v < -0.05) return "Slightly unpleasant";
  if (v <= 0.05) return "Neutral";
  if (v < 0.2) return "Slightly pleasant";
  if (v < 0.6) return "Pleasant";
  return "Very pleasant";
}

/** State of Mind on Athena's 1–5 mood scale (−1 → 1 Rough, 1 → 5 Great), for a day the owner left blank. */
export const valenceMood = (v: number): number => Math.min(5, Math.max(1, Math.round(3 + 2 * v)));

const KINDS: Array<[RegExp, string]> = [
  [/run|jog/i, "run"],
  [/walk/i, "walk"],
  [/hik/i, "hike"],
  [/swim/i, "swim"],
  [/ride|cycl|bik|spin/i, "ride"],
  [/row/i, "row"],
  [/yoga/i, "yoga"],
  [/pilates/i, "pilates"],
  [/hiit|interval/i, "HIIT"],
  [/strength|weight|lift|crossfit|functional/i, "strength"],
];

/** "Running", "TrailRun", "HKWorkoutActivityTypeCycling" → "run", "run", "ride". Something else keeps its own name, lowercased. */
export function workoutKind(type: string): string {
  for (const [re, kind] of KINDS) if (re.test(type)) return kind;
  const own = type
    .replace(/^HKWorkoutActivityType/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return own && own.length <= 24 ? own : "workout";
}

const thousands = (n: number) => Math.round(n).toLocaleString("en-GB");
const oneDecimal = (n: number) => (Math.round(n * 10) / 10).toString();

/** 460 → "7h 40m", 420 → "7h", 45 → "45m". */
export function hoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** "5k run", "12 km ride", "1,500 m swim", "45 min yoga". */
export function workoutPhrase(w: Workout): string {
  const kind = workoutKind(w.type);
  const d = w.distance_m ?? 0;
  if (d >= 100) {
    if (kind === "swim") return `${thousands(d)} m swim`;
    if (kind === "run") return d >= 1000 ? `${oneDecimal(d / 1000)}k run` : `${thousands(d)} m run`;
    if (d >= 1000) return `${d >= 10_000 ? Math.round(d / 1000) : oneDecimal(d / 1000)} km ${kind}`;
  }
  return w.minutes >= 90 ? `${hoursMinutes(w.minutes)} ${kind}` : `${w.minutes} min ${kind}`;
}

/** Strava's own names ("Morning Run", "Lunch Ride") say nothing the line doesn't. */
const DEFAULT_NAME = /^(?:morning|lunch|afternoon|evening|night)\s+[a-z ]+$/i;

/** A workout in the line: "“Hill reps” 5k run, 84 m up". Strava's name only when it's the owner's own; the climb from 20 m. */
export function workoutLine(w: Workout): string {
  const name = w.name && !DEFAULT_NAME.test(w.name) ? `“${w.name}” ` : "";
  const climb = w.elevation_m && w.elevation_m >= 20 ? `, ${thousands(w.elevation_m)} m up` : "";
  return `${name}${workoutPhrase(w)}${climb}`;
}

/** Polar's own words for Nightly Recharge statuses 1 to 6. */
export const RECHARGE = ["very poor", "poor", "compromised", "OK", "good", "very good"] as const;

/** 72.4 → "72.4 kg", 80 → "80 kg". */
export const kilos = (kg: number) => `${oneDecimal(kg)} kg`;

/**
 * The day's one line: sleep (with deep sleep when the night has stages: "7h 40m sleep (1h 25m deep)"), steps, each workout, resting heart rate,
 * recovery (Whoop's score or Polar's recharge), and weight on a day with a weigh-in. Null when there's nothing to say.
 */
export function healthLine(f: HealthFigures): string | null {
  const parts = [
    f.sleep_minutes ? `${hoursMinutes(f.sleep_minutes)} sleep${deepNote(f.sleep_stages)}` : "",
    f.steps ? `${thousands(f.steps)} ${f.steps === 1 ? "step" : "steps"}` : "",
    ...(f.workouts ?? []).map(workoutLine),
    f.resting_hr ? `${f.resting_hr} bpm resting` : "",
    f.recovery !== undefined ? `${f.recovery}% recovery` : "",
    f.recharge && RECHARGE[f.recharge - 1] ? `${RECHARGE[f.recharge - 1]} recharge` : "",
    f.weight_kg ? kilos(f.weight_kg) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

