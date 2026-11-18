/**
 * Health: one day's sleep, steps, activity, resting heart rate, workouts and
 * weight, from Apple Health (the iPhone Shortcut, POST /api/health/day) and
 * from health accounts a collection reads (Strava, Oura, Withings, Whoop,
 * Polar, through
 * the runner's athena_health_day). SECURITY.md §1 has the rules.
 *
 * Storage. Each (day, source) is one row in sensitive_blobs (domain
 * 'health', migration 0028 adds `day` and `source`): the figures as JSON,
 * sealed under the data key (lib/data-box.ts). The label is the day and the
 * source's name, never a figure. The database refuses a health day that
 * isn't sealed. A write without the key is refused, never stored readable.
 * Saving the same day and source again merges field by field (what's sent
 * replaces what was there, what isn't sent is kept), so repeats change
 * nothing.
 *
 * Charts. healthSeries() opens a range of days in the Function and returns
 * one value per day, merged across sources. Figures never go into the
 * metrics table, a note title, a log line or a run summary.
 *
 * The Life log. Each day note gets one line under a "Health" heading, at the
 * top: "7h 40m sleep · 9,200 steps · 5k run · 52 bpm resting", merged across
 * sources. Athena writes it whenever a source saves the day, and puts it
 * back whenever a Life log run saves the day (runner.ts), so a run never
 * writes or drops it. Ask leaves it out unless the question is about health
 * (withoutHealth, isHealthQuestion).
 */
import { touchDays } from "./day-touch";
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText, currentKeyId, sealedKeyId } from "./data-box";
import { addDays, isValidDate, zonedToInstant, zonedToday } from "./dates";
import { getOwnerTimeZone, q, qRaw, sealer } from "./db";
import { dayTitle } from "./youtube-takeout";
import { asleepMinutes, healthLine, workoutKind, type HealthFigures, type Workout } from "./health-line";
import { looksLikeStages, readStages, StagesError, StagesWithoutTimes } from "./sleep-stages";

// ---------- The shape ----------

export const HEALTH_SOURCES = ["apple_health", "strava", "oura", "withings", "whoop", "polar", "manual", "athena_checkin"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];
export const SOURCE_NAMES: Record<HealthSource, string> = { apple_health: "Apple Health", strava: "Strava", oura: "Oura", withings: "Withings", whoop: "Whoop", polar: "Polar", manual: "Added by hand", athena_checkin: "Check-ins" };
/**
 * Figures the owner typed in on the Health page: for anyone without a
 * supported app or device, or to put right a day one got wrong. Never a
 * connector, so never a choice in Settings: what's typed in wins over every
 * app for the figures it has (mergeSources), and the apps fill the rest.
 */
export const MANUAL_HEALTH: HealthSource = "manual";
/**
 * The owner's answers in a morning or evening check-in (lib/checkins.ts): energy, stress and the
 * words for how they feel. Athena writes it whole from the day's check-ins; nothing else sends it.
 */
export const CHECKIN_HEALTH: HealthSource = "athena_checkin";
export const isHealthSource = (s: unknown): s is HealthSource => typeof s === "string" && (HEALTH_SOURCES as readonly string[]).includes(s);

export type { HealthFigures, Workout } from "./health-line";

export interface HealthDay extends HealthFigures {
  /** YYYY-MM-DD in the owner's time zone. */
  date: string;
  source: HealthSource;
}

/** How far back a day may be: a year and a bit, so an account's history can be filled in. */
export const MAX_DAYS_BACK = 400;
export const MAX_WORKOUTS = 20;

/** A request a person or a collection got wrong: the message says what to fix. */
export class HealthInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "HealthInputError";
  }
}

const NUMERIC: Record<Exclude<keyof HealthFigures, "workouts" | "sleep_stages" | "caffeine_last" | "last_meal" | "mood_labels">, { min: number; max: number; places: number; what: string }> = {
  sleep_minutes: { min: 0, max: 1440, places: 0, what: "minutes asleep" },
  steps: { min: 0, max: 200_000, places: 0, what: "steps" },
  active_minutes: { min: 0, max: 1440, places: 0, what: "active minutes" },
  resting_hr: { min: 20, max: 250, places: 0, what: "beats per minute" },
  recovery: { min: 0, max: 100, places: 0, what: "percent" },
  recharge: { min: 1, max: 6, places: 0, what: "(1 very poor to 6 very good)" },
  weight_kg: { min: 20, max: 400, places: 1, what: "kilograms" },
  kcal: { min: 0, max: 20_000, places: 0, what: "kcal" },
  protein_g: { min: 0, max: 1000, places: 0, what: "grams" },
  carbs_g: { min: 0, max: 2000, places: 0, what: "grams" },
  fat_g: { min: 0, max: 1000, places: 0, what: "grams" },
  water_ml: { min: 0, max: 20_000, places: 0, what: "ml" },
  caffeine_mg: { min: 0, max: 3000, places: 0, what: "mg" },
  caffeine_after_14_mg: { min: 0, max: 3000, places: 0, what: "mg" },
  alcohol_drinks: { min: 0, max: 50, places: 1, what: "drinks" },
  mindful_minutes: { min: 0, max: 1440, places: 0, what: "minutes" },
  mood_valence: { min: -1, max: 1, places: 2, what: "(−1 very unpleasant to 1 very pleasant)" },
  energy: { min: 1, max: 5, places: 0, what: "(1 drained to 5 full of energy)" },
  stress: { min: 1, max: 5, places: 0, what: "(1 not at all to 5 very)" },
};
/** Times of day: one, or a list (each sample's Start Date), of which the latest counts. */
const TIMES = ["caffeine_last", "last_meal"] as const;
/** Sent beside caffeine_mg's samples, one time per sample: Athena works out caffeine_last and caffeine_after_14_mg. Not stored. */
const CAFFEINE_TIMES = "caffeine_times";
/** Hour from which caffeine counts as "after 2pm". */
export const LATE_CAFFEINE_HOUR = 14;
/**
 * Units a figure may come in, to its own unit: Health sends water in litres
 * or fl oz on some phones, energy in kJ, and a mindful session as a
 * duration. A figure with no unit is taken as already in its own.
 */
const UNITS: Partial<Record<keyof typeof NUMERIC, Record<string, number>>> = {
  water_ml: { ml: 1, l: 1000, cl: 10, "fl oz": 29.5735, floz: 29.5735, oz: 29.5735 },
  kcal: { kcal: 1, cal: 1, kj: 1 / 4.184 },
  mindful_minutes: { min: 1, mins: 1, m: 1, s: 1 / 60, sec: 1 / 60, h: 60, hr: 60 },
  protein_g: { g: 1 },
  carbs_g: { g: 1 },
  fat_g: { g: 1 },
  caffeine_mg: { mg: 1, g: 1000 },
  caffeine_after_14_mg: { mg: 1, g: 1000 },
};
/** The Shortcut's parallel lists, read with sleep_stages (lib/sleep-stages.ts). */
const STAGE_LISTS = ["sleep_durations", "sleep_starts", "sleep_ends"];
const FIELDS = ["date", "source", ...Object.keys(NUMERIC), "sleep_stages", ...STAGE_LISTS, "workouts", ...TIMES, CAFFEINE_TIMES, "mood_labels"];

/** What to change in the Shortcut when the night can't be read. */
export const STAGES_FIX = "In the Shortcut, send sleep_stages as the Stages text (Settings → From your iPhone → Health, step 3).";

/**
 * A number as Shortcuts or an API sends it: a number, or text like "9,200",
 * "52 bpm" or "7.5". Commas are thousands separators. Anything else is refused.
 */
function num(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    const m = raw.trim().replace(/(\d),(?=\d{3}\b)/g, "$1").match(/^(-?\d+(?:\.\d+)?)\s*[a-z%]*$/i);
    if (!m) throw new HealthInputError(`${name}: send a number, not ${JSON.stringify(raw.slice(0, 40))}`);
    n = Number(m[1]);
  } else throw new HealthInputError(`${name}: send a number`);
  if (!Number.isFinite(n)) throw new HealthInputError(`${name}: send a number`);
  return n;
}

/**
 * How a figure sent as several samples (Find Health Samples without Group By,
 * so the Shortcut sends "12\n10\n104\n…") becomes one: counts are added up,
 * readings are averaged.
 */
const COMBINE: Record<keyof typeof NUMERIC, "sum" | "mean"> = {
  sleep_minutes: "sum",
  steps: "sum",
  active_minutes: "sum",
  resting_hr: "mean",
  recovery: "mean",
  recharge: "mean",
  weight_kg: "mean",
  kcal: "sum",
  protein_g: "sum",
  carbs_g: "sum",
  fat_g: "sum",
  water_ml: "sum",
  caffeine_mg: "sum",
  caffeine_after_14_mg: "sum",
  alcohol_drinks: "sum",
  mindful_minutes: "sum",
  mood_valence: "mean",
  energy: "mean",
  stress: "mean",
};

/** A number in one of the units a figure takes ("1.8 L", "600 s", "0:10:00"), in the figure's own unit. */
function measure(raw: unknown, name: keyof typeof NUMERIC): number | undefined {
  const units = UNITS[name];
  if (!units || typeof raw !== "string") return num(raw, name);
  const text = raw.trim().replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (!text) return undefined;
  const clock = name === "mindful_minutes" ? text.match(/^(\d+):(\d{2})(?::(\d{2}))?$/) : null;
  if (clock) return clock[3] !== undefined ? Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3]) / 60 : Number(clock[1]) + Number(clock[2]) / 60;
  const m = text.match(/^(-?\d+(?:\.\d+)?)\s*([a-z][a-z .]*)?$/i);
  if (!m) return num(raw, name);
  const unit = (m[2] ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!unit) return Number(m[1]);
  const k = units[unit] ?? units[unit.replace(/s$/, "")];
  if (k === undefined) throw new HealthInputError(`${name}: ${JSON.stringify(raw.slice(0, 40))} isn't in a unit Athena knows (${Object.keys(units).join(", ")})`);
  return Number(m[1]) * k;
}

/** A field as a list: a JSON array, or text with one value per line. Null for a single value. */
const listOf = (raw: unknown): unknown[] | null => (Array.isArray(raw) ? raw : typeof raw === "string" && /[\r\n]/.test(raw.trim()) ? raw.split(/\r?\n/) : null);

/** A figure that may arrive as a list: a JSON array, or text with one value per line. */
function figure(raw: unknown, name: keyof typeof NUMERIC): number | undefined {
  const parts = listOf(raw);
  if (!parts) return measure(raw, name);
  const ns = parts.map((p) => measure(typeof p === "string" ? p.trim() : p, name)).filter((n): n is number => n !== undefined);
  if (!ns.length) return undefined;
  const total = ns.reduce((a, b) => a + b, 0);
  return COMBINE[name] === "sum" ? total : total / ns.length;
}

function inRange(n: number | undefined, name: string, r: { min: number; max: number; places: number; what: string }): number | undefined {
  if (n === undefined) return undefined;
  if (n < r.min || n > r.max) throw new HealthInputError(`${name}: ${n} is outside ${r.min} to ${r.max} ${r.what}`);
  const f = 10 ** r.places;
  return Math.round(n * f) / f;
}

const WORKOUT_FIELDS = ["type", "minutes", "distance_m", "kcal", "start", "name", "elevation_m", "route"];

/** "07:05", "7:05", "07:05:31" or an ISO time ("2026-11-06T07:05:00+00:00", read as written) → "07:05". */
function readStart(raw: unknown, at: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const m = typeof raw === "string" ? raw.trim().match(/(?:^|T|\s)(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HealthInputError(`${at}.start: a time like "07:05"`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function readWorkouts(raw: unknown): Workout[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HealthInputError("workouts: send a list");
  if (raw.length > MAX_WORKOUTS) throw new HealthInputError(`workouts: at most ${MAX_WORKOUTS} a day`);
  return raw.map((w, i) => {
    const o = (w ?? {}) as Record<string, unknown>;
    const at = `workouts[${i}]`;
    for (const k of Object.keys(o)) if (!WORKOUT_FIELDS.includes(k)) throw new HealthInputError(`${at}: unknown field ${k}`);
    const type = typeof o.type === "string" ? o.type.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) : "";
    if (!type) throw new HealthInputError(`${at}: give its type, like "run"`);
    const minutes = inRange(num(o.minutes, `${at}.minutes`), `${at}.minutes`, { min: 1, max: 1440, places: 0, what: "minutes" });
    if (minutes === undefined) throw new HealthInputError(`${at}: give its minutes`);
    const distance = inRange(num(o.distance_m, `${at}.distance_m`), `${at}.distance_m`, { min: 0, max: 1_000_000, places: 0, what: "metres" });
    const kcal = inRange(num(o.kcal, `${at}.kcal`), `${at}.kcal`, { min: 0, max: 20_000, places: 0, what: "kcal" });
    const elevation = inRange(num(o.elevation_m, `${at}.elevation_m`), `${at}.elevation_m`, { min: 0, max: 20_000, places: 0, what: "metres" });
    const start = readStart(o.start, at);
    const name = typeof o.name === "string" ? o.name.replace(/[\u0000-\u001f\u007f“”"·]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (o.route !== undefined && o.route !== null && (typeof o.route !== "string" || o.route.length > 8000 || !/^[\x3f-\x7e]*$/.test(o.route))) throw new HealthInputError(`${at}.route: an encoded polyline`);
    const route = typeof o.route === "string" && o.route ? o.route : undefined;
    return {
      type,
      minutes,
      ...(distance ? { distance_m: distance } : {}),
      ...(kcal !== undefined ? { kcal } : {}),
      ...(start ? { start } : {}),
      ...(name ? { name } : {}),
      ...(elevation ? { elevation_m: elevation } : {}),
      ...(route ? { route } : {}),
    };
  });
}

/**
 * Check one day as the Shortcut or a collection sends it. `date` defaults to
 * yesterday in the owner's zone (what a morning Shortcut means); `source`
 * defaults to `defaults.source`. Unknown fields are refused, so a misspelt
 * one ("step") is caught rather than dropped.
 */
export function readHealthDay(raw: unknown, ctx: { today: string; source?: HealthSource }): HealthDay {
  return readHealthDayNoting(raw, ctx).day;
}

/**
 * readHealthDay, plus what was left out and why. Stage names with no times
 * (an older Shortcut put the samples in sleep_minutes) can't make a night:
 * the rest of the day is still saved, and `skipped` says what to change.
 */
export function readHealthDayNoting(raw: unknown, ctx: { today: string; source?: HealthSource }): { day: HealthDay; skipped: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HealthInputError("Send the day's figures as JSON");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new HealthInputError(`Unknown field ${k}. Fields: ${FIELDS.join(", ")}`);
  const date = o.date === undefined || o.date === "" ? addDays(ctx.today, -1) : o.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isValidDate(date)) throw new HealthInputError("date: YYYY-MM-DD");
  if (date > ctx.today) throw new HealthInputError(`date: ${date} hasn't happened yet`);
  if (date < addDays(ctx.today, -MAX_DAYS_BACK)) throw new HealthInputError(`date: at most ${MAX_DAYS_BACK} days back`);
  const source = o.source === undefined || o.source === "" ? ctx.source : o.source;
  if (!isHealthSource(source) || source === CHECKIN_HEALTH) throw new HealthInputError(`source: one of ${HEALTH_SOURCES.filter((s) => s !== CHECKIN_HEALTH).join(", ")}`);
  const day: HealthDay = { date, source };
  const skipped: string[] = [];
  // Stage samples in sleep_minutes (the owner's Shortcut, 7 Nov) are read as the breakdown.
  let stagesRaw = o.sleep_stages;
  let stagesField = "sleep_stages";
  if (looksLikeStages(o.sleep_minutes) && (stagesRaw === undefined || stagesRaw === null || stagesRaw === "")) {
    stagesRaw = o.sleep_minutes;
    stagesField = "sleep_minutes";
  }
  for (const [k, r] of Object.entries(NUMERIC) as Array<[keyof typeof NUMERIC, (typeof NUMERIC)[keyof typeof NUMERIC]]>) {
    if (k === "sleep_minutes" && stagesField === "sleep_minutes") continue;
    const v = inRange(figure(o[k], k), k, r);
    if (v !== undefined) day[k] = v;
  }
  const lists = STAGE_LISTS.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== "");
  if ((stagesRaw === undefined || stagesRaw === null || stagesRaw === "") && lists) throw new HealthInputError(`sleep_stages: send the stage names (each sample's Value) with ${STAGE_LISTS.filter((k) => o[k] !== undefined).join(" and ")}`);
  if (stagesRaw !== undefined && stagesRaw !== null && stagesRaw !== "") {
    try {
      const stages = readStages(stagesRaw, { durations: o.sleep_durations ?? undefined, starts: o.sleep_starts ?? undefined, ends: o.sleep_ends ?? undefined }, stagesField);
      if (Object.keys(stages).length) {
        day.sleep_stages = stages;
        const asleep = asleepMinutes(stages);
        if (day.sleep_minutes === undefined && asleep !== undefined) day.sleep_minutes = asleep;
      }
    } catch (e) {
      if (e instanceof StagesWithoutTimes) skipped.push(`Sleep wasn't saved: Athena got the stage names but not their times. ${STAGES_FIX}`);
      else if (e instanceof StagesError) throw new HealthInputError(`${e.message} ${STAGES_FIX}`);
      else throw e;
    }
  }
  const workouts = readWorkouts(o.workouts);
  if (workouts) day.workouts = workouts;
  readFoodAndMind(o, day);
  if (!Object.keys(day).some((k) => k !== "date" && k !== "source")) {
    if (skipped.length) throw new HealthInputError(skipped[0]);
    throw new HealthInputError("Send at least one figure: sleep_minutes, sleep_stages, steps, active_minutes, resting_hr, recovery, recharge, workouts, weight_kg, kcal, water_ml, caffeine_mg, alcohol_drinks, mindful_minutes or mood_valence");
  }
  return { day, skipped };
}

/** The latest of one time or a list of them ("15:40", or each sample's Start Date, one per line). */
function latestTime(raw: unknown, name: string): string | undefined {
  const parts = listOf(raw) ?? [raw];
  const times = parts.map((p) => readStart(typeof p === "string" ? p.trim() : p, name)).filter((x): x is string => !!x);
  return times.sort().pop();
}

/**
 * The times of day, State of Mind's labels, and caffeine worked out from its
 * samples: with caffeine_times (one per caffeine_mg sample), the last cup's
 * time and what was taken from 14:00 on, unless they were sent themselves.
 */
function readFoodAndMind(o: Record<string, unknown>, day: HealthDay): void {
  for (const k of TIMES) {
    const t = latestTime(o[k], k);
    if (t) day[k] = t;
  }
  const times = o[CAFFEINE_TIMES];
  if (times !== undefined && times !== null && times !== "") {
    const mgs = listOf(o.caffeine_mg) ?? (o.caffeine_mg === undefined || o.caffeine_mg === "" ? [] : [o.caffeine_mg]);
    const at = listOf(times) ?? [times];
    if (mgs.length !== at.length) throw new HealthInputError(`${CAFFEINE_TIMES}: send one time per caffeine_mg sample (${at.length} ${at.length === 1 ? "time" : "times"} for ${mgs.length} ${mgs.length === 1 ? "sample" : "samples"})`);
    let late = 0;
    at.forEach((t, i) => {
      const hhmm = readStart(typeof t === "string" ? t.trim() : t, `${CAFFEINE_TIMES}[${i}]`);
      const mg = measure(typeof mgs[i] === "string" ? (mgs[i] as string).trim() : mgs[i], "caffeine_mg") ?? 0;
      if (hhmm && Number(hhmm.slice(0, 2)) >= LATE_CAFFEINE_HOUR) late += mg;
      if (hhmm && mg > 0 && day.caffeine_last === undefined) day.caffeine_last = hhmm;
      else if (hhmm && mg > 0 && hhmm > day.caffeine_last!) day.caffeine_last = hhmm;
    });
    if (day.caffeine_after_14_mg === undefined) day.caffeine_after_14_mg = inRange(late, "caffeine_after_14_mg", NUMERIC.caffeine_after_14_mg);
  }
  const labels = o.mood_labels;
  if (labels !== undefined && labels !== null && labels !== "") {
    const list = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(/[\r\n,]+/) : null;
    if (!list || list.some((l) => typeof l !== "string")) throw new HealthInputError("mood_labels: send words, like \"Calm\" or \"Grateful\"");
    const clean = [...new Set((list as string[]).map((l) => l.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
    if (clean.length) day.mood_labels = clean;
  }
}

/** A source's day after a second save: what's sent replaces, what isn't is kept. */
export function mergeSave(before: HealthFigures, incoming: HealthFigures): HealthFigures {
  const out: HealthFigures = { ...before };
  for (const [k, v] of Object.entries(incoming)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// ---------- Across sources ----------

/**
 * Which source the owner believes for each figure (Settings → Health). One
 * source per figure: two are never added together. When the chosen source
 * has nothing for a day (the ring was charging), the next one in FALLBACK
 * that has the figure is used. Resting heart rate follows sleep; active
 * minutes follow steps.
 */
export const CHOICES = ["sleep", "steps", "weight", "workouts", "nutrition", "mind"] as const;
export type HealthChoice = (typeof CHOICES)[number];
export type HealthPrefs = Record<HealthChoice, HealthSource>;
export const DEFAULT_PREFS: HealthPrefs = { sleep: "oura", steps: "apple_health", weight: "withings", workouts: "apple_health", nutrition: "apple_health", mind: "apple_health" };
/** The sources that can send each figure, in the order they're tried after the owner's choice. */
export const CAN_SEND: Record<HealthChoice, HealthSource[]> = {
  sleep: ["oura", "whoop", "polar", "withings", "apple_health"],
  steps: ["apple_health", "oura", "polar", "withings"],
  weight: ["withings", "apple_health"],
  workouts: ["apple_health", "strava", "whoop", "polar", "oura"],
  // Oura's tags (coffee, alcohol) and its meditation and breathing sessions.
  nutrition: ["apple_health", "oura"],
  mind: ["apple_health", "oura"],
};
const FIGURE_CHOICE: Record<keyof typeof NUMERIC, HealthChoice> = {
  sleep_minutes: "sleep",
  resting_hr: "sleep",
  recovery: "sleep",
  recharge: "sleep",
  steps: "steps",
  active_minutes: "steps",
  weight_kg: "weight",
  kcal: "nutrition",
  protein_g: "nutrition",
  carbs_g: "nutrition",
  fat_g: "nutrition",
  water_ml: "nutrition",
  caffeine_mg: "nutrition",
  caffeine_after_14_mg: "nutrition",
  alcohol_drinks: "nutrition",
  mindful_minutes: "mind",
  mood_valence: "mind",
  energy: "mind",
  stress: "mind",
};
/** What goes with a figure, from the same source: the last cup's time with the caffeine, the last meal with the kcal, the labels with the mood. */
const COMPANIONS: Partial<Record<keyof typeof NUMERIC, Array<"caffeine_last" | "last_meal" | "mood_labels">>> = { caffeine_mg: ["caffeine_last"], kcal: ["last_meal"], mood_valence: ["mood_labels"] };

/** Saved choices, checked: anything unknown falls back to the default. */
export function readPrefs(raw: unknown): HealthPrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_PREFS };
  for (const c of CHOICES) {
    const v = o[c];
    if (isHealthSource(v) && CAN_SEND[c].includes(v)) out[c] = v;
  }
  return out;
}

/** Choices as an older caller or saved setting may have them: food and mind came later, and default when missing. */
export type GivenPrefs = Omit<HealthPrefs, "nutrition" | "mind"> & Partial<Pick<HealthPrefs, "nutrition" | "mind">>;

/** The order a figure is looked for in: what the owner typed in, their chosen app, the other apps that send it, then the rest. */
const order = (choice: HealthChoice, given: GivenPrefs): HealthSource[] => {
  const first = given[choice] ?? DEFAULT_PREFS[choice];
  return [...new Set<HealthSource>([MANUAL_HEALTH, first, ...CAN_SEND[choice], ...HEALTH_SOURCES])];
};

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** How far apart two starts may be and still be one workout. */
export const START_SLACK_MINUTES = 5;

/**
 * The same workout from two places: the same kind, and starting within
 * START_SLACK_MINUTES of each other. Without both start times: within 15%
 * (or 5 minutes) of each other's length.
 */
export function sameWorkout(a: Workout, b: Workout): boolean {
  if (workoutKind(a.type) !== workoutKind(b.type)) return false;
  if (a.start && b.start) return Math.abs(minutesOf(a.start) - minutesOf(b.start)) <= START_SLACK_MINUTES;
  return Math.abs(a.minutes - b.minutes) <= Math.max(5, 0.15 * Math.max(a.minutes, b.minutes));
}

/**
 * One day's figures from every source that sent some. Each figure comes from
 * one source (the owner's choice, else the next that has it). Workouts are
 * joined: one per workout, the chosen source's version first, with what it
 * lacks (Strava's name, climb and route, a start time) filled from its twin;
 * a workout only one source saw is kept.
 */
export function mergeSources(days: Array<HealthFigures & { source: HealthSource }>, prefs: GivenPrefs = DEFAULT_PREFS): HealthFigures {
  const out: HealthFigures = {};
  for (const k of Object.keys(NUMERIC) as Array<keyof typeof NUMERIC>) {
    for (const s of order(FIGURE_CHOICE[k], prefs)) {
      const d = days.find((x) => x.source === s);
      const v = d?.[k];
      if (v !== undefined) {
        out[k] = v;
        for (const c of COMPANIONS[k] ?? []) if (d![c] !== undefined) (out as Record<string, unknown>)[c] = Array.isArray(d![c]) ? [...(d![c] as string[])] : d![c];
        break;
      }
    }
  }
  // Words for how the owner feels can come without a mood score (a check-in's): the first source with some.
  if (out.mood_labels === undefined) {
    const d = order("mind", prefs).map((s) => days.find((x) => x.source === s)).find((x) => x?.mood_labels?.length);
    if (d) out.mood_labels = [...d.mood_labels!];
  }
  // The breakdown is the same night as sleep_minutes: from the same app, never mixed.
  for (const s of order("sleep", prefs)) {
    const d = days.find((x) => x.source === s);
    if (d?.sleep_minutes === undefined) continue;
    if (d.sleep_stages && Object.keys(d.sleep_stages).length) out.sleep_stages = { ...d.sleep_stages };
    break;
  }
  // Whoop's recovery score and Polar's recharge describe the same night: keep only the one from the app chosen first.
  if (out.recovery !== undefined && out.recharge !== undefined) {
    const first = order("sleep", prefs).find((s) => days.some((d) => d.source === s && (d.recovery !== undefined || d.recharge !== undefined)));
    if (days.find((d) => d.source === first)?.recovery !== undefined) delete out.recharge;
    else delete out.recovery;
  }
  const workouts: Workout[] = [];
  for (const s of order("workouts", prefs)) {
    const taken = new Set<Workout>();
    for (const w of days.find((d) => d.source === s)?.workouts ?? []) {
      const twin = workouts.find((x) => !taken.has(x) && sameWorkout(x, w));
      if (!twin) {
        const copy = { ...w };
        workouts.push(copy);
        taken.add(copy);
        continue;
      }
      taken.add(twin);
      for (const f of ["distance_m", "kcal", "start", "name", "elevation_m", "route"] as const) {
        if (twin[f] === undefined && w[f] !== undefined) (twin as unknown as Record<string, unknown>)[f] = w[f];
      }
    }
  }
  workouts.sort((a, b) => (a.start && b.start ? minutesOf(a.start) - minutesOf(b.start) : 0));
  if (workouts.length) out.workouts = workouts;
  return out;
}

// ---------- The line (lib/health-line.ts, shared with the app) ----------

export { caffeinePhrase, foodLine, litres, valenceMood, valenceWord } from "./health-line";
export { asleepMinutes, deepNote, healthLine, hoursMinutes, kilos, stagesLine, stagesWords, workoutKind, workoutLine, workoutPhrase } from "./health-line";

// ---------- In the day note ----------

export const HEALTH_HEADING = "## Health";

/**
 * A body without its Health section (the heading and everything up to the
 * next heading). `only` keeps a section whose line isn't a health line, so a
 * note of the owner's own with a "Health" heading is left alone.
 */
function stripSection(body: string, only?: (line: string | null) => boolean): string {
  const out: string[] = [];
  let inside = false;
  const lines = body.split("\n");
  for (const [i, l] of lines.entries()) {
    if (l.trim() === HEALTH_HEADING && (!only || only(lineIn(lines.slice(i).join("\n"))))) {
      inside = true;
      continue;
    }
    if (inside && /^#{1,6}\s/.test(l)) inside = false;
    if (!inside) out.push(l);
  }
  return out.join("\n").replace(/^\s*\n/, "").replace(/\n{3,}/g, "\n\n");
}

/** The line in a body's Health section, if it has one. */
export function lineIn(body: string): string | null {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim() === HEALTH_HEADING);
  if (at < 0) return null;
  const line = lines.slice(at + 1).find((l) => l.trim());
  return line && !/^#{1,6}\s/.test(line) ? line.trim() : null;
}

/** The body with `line` as its Health section, at the top; null takes the section out. Everything else is left as it was. */
export function withHealthLine(body: string, line: string | null): string {
  const rest = stripSection(body).trim();
  if (!line) return rest === body.trim() ? body : rest;
  const next = `${HEALTH_HEADING}\n${line}${rest ? `\n\n${rest}` : ""}`;
  return next.trim() === body.trim() ? body : next;
}

/** One health phrase, as healthLine writes them. */
const KIND = String.raw`(?:HIIT|[a-z]{2,24}(?: [a-z]{2,12})?)`;
const WORKOUT = String.raw`(?:“[^”\n]{1,60}” )?(?:[\d.,]+ ?(?:k|km|m) ${KIND}|\d+ min ${KIND}|\d+h(?: \d+m)? ${KIND})(?:, [\d,]+ m up)?`;
const SEGMENT = String.raw`(?:\d+h(?: \d+m)?|\d+m) sleep(?: \((?:\d+h(?: \d+m)?|\d+m) deep\))?|[\d,]+ steps?|\d+ bpm resting|\d{1,3}% recovery|(?:very poor|poor|compromised|OK|good|very good) recharge|\d+(?:\.\d)? kg|${WORKOUT}`;
const RUN = new RegExp(String.raw`(?:#+\s*)?(?:Health\s*[:\n]?\s*)?(?:${SEGMENT})(?:\s*·\s*(?:${SEGMENT}))+`, "g");
const LABELLED = new RegExp(String.raw`(?:#+\s*)?Health\s*[:\n]?\s*(?:${SEGMENT})`, "g");
const WHOLE = new RegExp(String.raw`^(?:${SEGMENT})(?: · (?:${SEGMENT}))*$`);

/** A line healthLine could have written. */
export const isHealthLine = (line: string | null): boolean => !!line && WHOLE.test(line.trim());

/**
 * Text for Ask, a collection's search or anything else that shouldn't carry
 * health: the Health section goes, and so does a health line inside a
 * flattened snippet ("Health 7h 40m sleep · 9,200 steps").
 */
export function withoutHealth(text: string): string {
  if (!text) return text;
  const stripped = text.includes(HEALTH_HEADING) ? stripSection(text, isHealthLine) : text;
  return stripped.replace(RUN, "").replace(LABELLED, "").replace(/^\s+/, "");
}

/** A question about the owner's health, sleep or exercise: Ask may then read the Health lines. */
export function isHealthQuestion(text: string): boolean {
  return /\b(food|ate|eat(s|en|ing)?|meals?|calories|kcal|protein|carbs?|diet\w*|coffees?|caffeine|espresso|tea|alcohol\w*|drink(s|ing)?|drank|booze|wine|beers?|water|hydrat\w*|meditat\w*|mindful\w*|breath\w*|state of mind|health(y)?|sleep(s|ing)?|slept|asleep|steps?|walk(s|ed|ing)?|run(s|ning)?|ran|jog\w*|workouts?|work(ed)? out|exercis\w*|gym|training|heart ?rate|bpm|resting|weigh(t|ed|s)?|kg|kilos?|fitness|active|activity|swim\w*|rides?|rode|cycl\w*|yoga|hiit|strava|oura|withings|whoop|polar|recovery|strain)\b/i.test(text);
}

// ---------- Storing ----------

interface Row {
  day: string;
  source: HealthSource;
  ciphertext: string;
}

const label = (date: string, source: HealthSource) => `Health · ${date} · ${SOURCE_NAMES[source]}`;

export interface SaveResult {
  date: string;
  source: HealthSource;
  /** First save for this day and source. */
  created: boolean;
  /** False when the same figures were sent again. */
  changed: boolean;
  /** What happened to the day note's line: written, unchanged, or skipped (the day was archived or deleted). */
  life_log: "written" | "unchanged" | "skipped";
}

/** Seal and save one source's day, then refresh that day's Life log line. The only way health figures are written. */
export async function saveHealthDay(day: HealthDay, opts: { now?: Date; tz?: string; lifeLogSource?: string } = {}): Promise<SaveResult> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const tz = opts.tz ?? (await getOwnerTimeZone());
  const [prev] = await qRaw<{ ciphertext: string }>(
    `SELECT ciphertext FROM sensitive_blobs WHERE domain = 'health' AND source = $1 AND day = $2::date`,
    [day.source, day.date],
  );
  const { date: _d, source: _s, ...incoming } = day;
  const before: HealthFigures | null = prev ? JSON.parse(openStrict(prev.ciphertext)) : null;
  const figures = before ? mergeSave(before, incoming) : incoming;
  const changed = !before || JSON.stringify(before) !== JSON.stringify(figures) || sealedKeyId(prev.ciphertext) !== currentKeyId();
  if (changed) {
    await qRaw(
      `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
       VALUES ('health', $1, $2, $3::timestamptz, $4::date, $5)
       ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, label = EXCLUDED.label, recorded_at = EXCLUDED.recorded_at`,
      [label(day.date, day.source), sealText(JSON.stringify(figures)), zonedToInstant(day.date, "12:00", tz).toISOString(), day.date, day.source],
    );
  }
  const life_log = await refreshLifeLog(day.date, day.source, { now: opts.now ?? new Date(), tz, source: opts.lifeLogSource });
  return { date: day.date, source: day.source, created: !before, changed, life_log };
}

/**
 * The day's check-in figures (CHECKIN_HEALTH), replaced whole: what a check-in no longer says is
 * gone. Nothing to say takes the row out. Unchanged figures write nothing.
 */
export async function setCheckinHealthDay(date: string, figures: Pick<HealthFigures, "energy" | "stress" | "mood_labels">, opts: { now?: Date; tz?: string } = {}): Promise<"saved" | "removed" | "unchanged"> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const clean = Object.fromEntries(Object.entries(figures).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as HealthFigures;
  const before = await readSourceDay(date, CHECKIN_HEALTH);
  if (JSON.stringify(before ?? {}) === JSON.stringify(clean)) return "unchanged";
  const tz = opts.tz ?? (await getOwnerTimeZone());
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = $1 AND day = $2::date`, [CHECKIN_HEALTH, date]);
  if (Object.keys(clean).length) {
    await saveHealthDay({ ...clean, date, source: CHECKIN_HEALTH }, { now: opts.now, tz });
    return "saved";
  }
  await refreshLifeLog(date, CHECKIN_HEALTH, { now: opts.now ?? new Date(), tz });
  return "removed";
}

/** One source's figures for a day as saved, or null (the Health page's form opens with what was typed in before). */
export async function readSourceDay(date: string, source: HealthSource): Promise<HealthFigures | null> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'health' AND source = $1 AND day = $2::date`, [source, date]);
  return row ? (JSON.parse(openStrict(row.ciphertext)) as HealthFigures) : null;
}

/**
 * What the owner typed in for a day, replaced whole: a figure left out of
 * the form is gone, not kept (unlike an app's resend, which merges).
 */
export async function replaceManualHealthDay(day: HealthDay, opts: { now?: Date; tz?: string } = {}): Promise<SaveResult> {
  if (day.source !== MANUAL_HEALTH) throw new HealthInputError("source: manual");
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = $1 AND day = $2::date`, [MANUAL_HEALTH, day.date]);
  return saveHealthDay(day, opts);
}

/** Take out everything typed in for a day; the apps' figures show again. False when there was nothing. */
export async function clearManualHealthDay(date: string, opts: { now?: Date; tz?: string } = {}): Promise<boolean> {
  const gone = await qRaw<{ id: string }>(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = $1 AND day = $2::date RETURNING id`, [MANUAL_HEALTH, date]);
  if (!gone.length) return false;
  await refreshLifeLog(date, MANUAL_HEALTH, { now: opts.now ?? new Date(), tz: opts.tz ?? (await getOwnerTimeZone()) });
  return true;
}

/** Every source's figures for each day in [from, to], opened. Days that won't open are left out and counted. */
export async function readHealthDays(from: string, to: string): Promise<{ days: Map<string, Array<HealthFigures & { source: HealthSource }>>; unreadable: number }> {
  const rows = await qRaw<Row>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, source, ciphertext FROM sensitive_blobs
     WHERE domain = 'health' AND day BETWEEN $1::date AND $2::date ORDER BY day`,
    [from, to],
  );
  const days = new Map<string, Array<HealthFigures & { source: HealthSource }>>();
  let unreadable = 0;
  for (const r of rows) {
    try {
      const f = JSON.parse(openStrict(r.ciphertext)) as HealthFigures;
      days.set(r.day, [...(days.get(r.day) ?? []), { ...f, source: r.source }]);
    } catch {
      unreadable++;
    }
  }
  return { days, unreadable };
}

// ---------- The owner's choices ----------

const PREFS_KEY = "health_sources";

export async function loadHealthPrefs(): Promise<HealthPrefs> {
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [PREFS_KEY]);
  return readPrefs(row?.value);
}

/** Save the owner's choices, then rewrite the recent Life log lines so they read from the new sources. */
export async function saveHealthPrefs(raw: unknown, opts: { now?: Date; tz?: string; days?: number } = {}): Promise<HealthPrefs> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(o)) {
    if (!(CHOICES as readonly string[]).includes(k)) throw new HealthInputError(`Unknown figure ${k}. Figures: ${CHOICES.join(", ")}`);
    if (!isHealthSource(v) || !CAN_SEND[k as HealthChoice].includes(v)) throw new HealthInputError(`${k}: one of ${CAN_SEND[k as HealthChoice].join(", ")}`);
  }
  const prefs = { ...(await loadHealthPrefs()), ...(o as Partial<HealthPrefs>) };
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PREFS_KEY, JSON.stringify(prefs)],
  );
  if (dataKeyConfigured()) {
    const tz = opts.tz ?? (await getOwnerTimeZone());
    const now = opts.now ?? new Date();
    const today = zonedToday(now, tz);
    const { days } = await readHealthDays(addDays(today, -(opts.days ?? 30)), today);
    for (const [date, sources] of days) await refreshLifeLog(date, sources[0].source, { now, tz, prefs });
  }
  return prefs;
}

/** Which sources Athena has heard from or can read: the owner picks among these. */
export async function connectedSources(): Promise<HealthSource[]> {
  const rows = await qRaw<{ source: string }>(
    `SELECT DISTINCT source FROM sensitive_blobs WHERE domain = 'health' AND day IS NOT NULL
     UNION SELECT DISTINCT provider FROM connectors WHERE provider = ANY($1::text[])`,
    [HEALTH_SOURCES],
  );
  const have = new Set(rows.map((r) => r.source));
  return HEALTH_SOURCES.filter((s) => have.has(s));
}

export const SERIES = ["sleep_minutes", "steps", "active_minutes", "resting_hr", "recovery", "recharge", "weight_kg", "workout_minutes", "kcal", "water_ml", "caffeine_mg", "caffeine_after_14_mg", "alcohol_drinks", "mindful_minutes", "mood_valence", "energy", "stress"] as const;
export type SeriesField = (typeof SERIES)[number];

/** One merged value per day that has one, oldest first: what a chart draws. workout_minutes is the day's workouts added up. */
export async function healthSeries(field: SeriesField, from: string, to: string): Promise<{ points: Array<{ day: string; value: number }>; unreadable: number }> {
  const [{ days, unreadable }, prefs] = await Promise.all([readHealthDays(from, to), loadHealthPrefs()]);
  const points: Array<{ day: string; value: number }> = [];
  for (const [day, sources] of days) {
    const m = mergeSources(sources, prefs);
    const value = field === "workout_minutes" ? (m.workouts?.length ? m.workouts.reduce((n, w) => n + w.minutes, 0) : undefined) : m[field];
    if (value !== undefined) points.push({ day, value });
  }
  return { points, unreadable };
}

/**
 * The line for one day from what's stored, or null with nothing stored.
 * `complete` is false when a source's figures wouldn't open (a deploy
 * without the key): then the note's own line is better kept than replaced.
 */
export async function lineFor(date: string, prefs?: HealthPrefs): Promise<{ line: string | null; complete: boolean }> {
  const [{ days, unreadable }, p] = await Promise.all([readHealthDays(date, date), prefs ?? loadHealthPrefs()]);
  return { line: healthLine(mergeSources(days.get(date) ?? [], p)), complete: unreadable === 0 };
}

/**
 * Every day in [from, to] with figures, merged, for the Health page: each
 * figure with the source it came from. Oldest first.
 */
export async function healthDays(from: string, to: string): Promise<{ days: Array<{ date: string } & HealthFigures>; prefs: HealthPrefs; unreadable: number }> {
  const [{ days, unreadable }, prefs] = await Promise.all([readHealthDays(from, to), loadHealthPrefs()]);
  return { days: [...days].map(([date, sources]) => ({ date, ...mergeSources(sources, prefs) })), prefs, unreadable };
}

/**
 * What a Life log run saves for a day, with the Health line put back (from
 * what's stored, merged across sources). A Health section the run wrote
 * itself is dropped: figures only come from athena_health_day.
 */
export async function keepHealthLine(previous: string, next: string, date: string): Promise<string> {
  const { line, complete } = await lineFor(date);
  return withHealthLine(next, complete ? line : (line ?? lineIn(previous)));
}

/**
 * Where a day note goes before any Life log exists: the plain "life-log"
 * source, the one a first Life log gets unless it's given a label. A Life
 * log under another source takes these days over (adoptHealthDays).
 */
export const HOLDER_SOURCE = "life-log";

/**
 * Which Life log a day's line goes into: the one given (a Life log run's
 * own), else the Life log that reads an account of this source, else the
 * oldest. With no Life log yet, HOLDER_SOURCE: the day note is made now and
 * the first Life log run over that day fills in around the line.
 */
async function lifeLogSource(source: HealthSource, given?: string): Promise<string> {
  if (given) return given;
  const [row] = await qRaw<{ source: string }>(
    `SELECT c.source FROM collections c
     WHERE c.recipe = 'life-log'
     ORDER BY EXISTS (SELECT 1 FROM connectors k WHERE k.id = ANY(c.connector_ids) AND k.provider = $1) DESC, c.created_at
     LIMIT 1`,
    [source],
  );
  return row?.source ?? HOLDER_SOURCE;
}

/**
 * A Life log under its own source ("life-log-personal") taking over a day
 * note the health save made before any Life log existed, so the day stays
 * one note. Nothing happens when a Life log owns HOLDER_SOURCE itself.
 */
export async function adoptHealthDay(source: string, externalId: string): Promise<boolean> {
  if (source === HOLDER_SOURCE || !/^life-log-\d{4}-\d{2}-\d{2}$/.test(externalId)) return false;
  const moved = await qRaw<{ record_id: string }>(
    `UPDATE collected_items ci SET source = $1
     WHERE ci.source = $2 AND ci.kind = 'note' AND ci.external_id = $3
       AND NOT EXISTS (SELECT 1 FROM collections WHERE source = $2)
       AND NOT EXISTS (SELECT 1 FROM collected_items x WHERE x.source = $1 AND x.kind = 'note' AND x.external_id = $3)
     RETURNING ci.record_id`,
    [source, HOLDER_SOURCE, externalId],
  );
  if (!moved.length) return false;
  await qRaw(`UPDATE notes SET source = $2 WHERE id = $1 AND source = $3`, [moved[0].record_id, source, HOLDER_SOURCE]);
  return true;
}

/**
 * Days replace the Life log's day notes (owner decision, 7 Nov 2026): a
 * day's health is opened from its sealed rows whenever the day is read
 * (lib/days.ts), so nothing is written into a note. The day is marked
 * changed so devices pick it up.
 */
async function refreshLifeLog(date: string, _healthSource: HealthSource, ctx: { now: Date; tz: string; source?: string; prefs?: HealthPrefs }): Promise<SaveResult["life_log"]> {
  const { line, complete } = await lineFor(date, ctx.prefs);
  if (!complete) return "skipped";
  await touchDays([date]);
  return line ? "written" : "unchanged";
}

/**
 * After a key rotation: re-seal health days still under an old key. The
 * backfill re-seals every sensitive_blobs day row itself (lib/encryption.ts
 * ENCRYPTED); this does health alone. In id order with a cursor, so rows
 * that won't open are counted and passed, never in the way of the rest.
 */
export async function resealHealth(budgetMs = 5_000): Promise<{ resealed: number; failed: number }> {
  const kid = currentKeyId();
  const report = { resealed: 0, failed: 0 };
  if (!kid) return report;
  const started = Date.now();
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await qRaw<{ id: string; ciphertext: string }>(
      `SELECT id::text AS id, ciphertext FROM sensitive_blobs WHERE domain = 'health' AND day IS NOT NULL AND ciphertext NOT LIKE $1 AND id > $2::uuid ORDER BY id LIMIT 200`,
      [`enc:v1:${kid}:%`, after],
    );
    if (!rows.length) return report;
    for (const r of rows) {
      if (Date.now() - started > budgetMs) return report;
      try {
        const sealed = sealText(openStrict(r.ciphertext));
        await qRaw(`UPDATE sensitive_blobs SET ciphertext = $3 WHERE id = $1::uuid AND ciphertext = $2`, [r.id, r.ciphertext, sealed]);
        report.resealed++;
      } catch {
        report.failed++;
      }
    }
    after = rows[rows.length - 1].id;
  }
}
