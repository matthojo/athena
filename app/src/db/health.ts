/**
 * Health for the Library's Health page and Settings → Health: each day's
 * merged figures (GET /api/health/days) and which source each figure comes
 * from (GET/PUT /api/health/sources). lib/health.ts on the server has the
 * rules; nothing here is cached on the device.
 */

import { isSampleMode, request } from "./api";

export type HealthSource = "apple_health" | "strava" | "oura" | "withings" | "whoop" | "polar" | "manual" | "athena_checkin";
export type HealthChoice = "sleep" | "steps" | "weight" | "workouts" | "nutrition" | "mind";
export type HealthPrefs = Record<HealthChoice, HealthSource>;

export const SOURCE_NAMES: Record<HealthSource, string> = { apple_health: "Apple Health", strava: "Strava", oura: "Oura", withings: "Withings", whoop: "Whoop", polar: "Polar", manual: "Added by hand", athena_checkin: "Check-ins" };

export interface Workout {
  type: string;
  minutes: number;
  distance_m?: number;
  kcal?: number;
  start?: string;
  name?: string;
  elevation_m?: number;
  route?: string;
}

export interface SleepStages {
  deep?: number;
  core?: number;
  rem?: number;
  awake?: number;
  in_bed?: number;
  asleep_unspecified?: number;
}

export interface HealthDay {
  date: string;
  sleep_minutes?: number;
  sleep_stages?: SleepStages;
  steps?: number;
  active_minutes?: number;
  resting_hr?: number;
  recovery?: number;
  recharge?: number;
  workouts?: Workout[];
  weight_kg?: number;
  kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  water_ml?: number;
  caffeine_mg?: number;
  caffeine_last?: string;
  caffeine_after_14_mg?: number;
  alcohol_drinks?: number;
  last_meal?: string;
  mindful_minutes?: number;
  mood_valence?: number;
  mood_labels?: string[];
}

export interface HealthDays {
  today: string;
  days: HealthDay[];
  prefs: HealthPrefs;
}

export interface HealthSources {
  prefs: HealthPrefs;
  connected: HealthSource[];
  can_send: Record<HealthChoice, HealthSource[]>;
}

export const DEFAULT_PREFS: HealthPrefs = { sleep: "oura", steps: "apple_health", weight: "withings", workouts: "apple_health", nutrition: "apple_health", mind: "apple_health" };
const CAN_SEND: HealthSources["can_send"] = {
  sleep: ["oura", "whoop", "polar", "withings", "apple_health"],
  steps: ["apple_health", "oura", "polar", "withings"],
  weight: ["withings", "apple_health"],
  workouts: ["apple_health", "strava", "whoop", "polar", "oura"],
  nutrition: ["apple_health", "oura"],
  mind: ["apple_health", "oura"],
};

let samplePrefs: HealthPrefs = { ...DEFAULT_PREFS };

export async function loadHealthDays(from: string, to: string): Promise<HealthDays> {
  if (isSampleMode()) {
    const s = sampleHealth(to);
    return { ...s, days: withSampleManual(s.days).filter((d) => d.date >= from && d.date <= to), prefs: samplePrefs };
  }
  return request<HealthDays>(`/health/days?from=${from}&to=${to}`);
}

export async function loadHealthSources(): Promise<HealthSources> {
  if (isSampleMode()) return { prefs: samplePrefs, connected: ["apple_health", "strava", "oura", "withings"], can_send: CAN_SEND };
  return request<HealthSources>("/health/sources");
}

export async function saveHealthSources(patch: Partial<HealthPrefs>): Promise<HealthSources> {
  if (isSampleMode()) {
    samplePrefs = { ...samplePrefs, ...patch };
    return loadHealthSources();
  }
  return request<HealthSources>("/health/sources", { method: "PUT", body: JSON.stringify(patch) });
}

// ---------- Logged by hand (GET/PUT/DELETE /api/health/manual) ----------

/** What can be typed in for a day: the figures, as the server reads them (lib/health.ts). */
export type ManualHealth = Omit<HealthDay, "date" | "sleep_stages" | "caffeine_last" | "caffeine_after_14_mg" | "last_meal" | "mood_labels">;

const MANUAL_KEY = "athena.sample.manualHealth";
function sampleManual(): Record<string, ManualHealth> {
  try {
    const v = JSON.parse(localStorage.getItem(MANUAL_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ManualHealth>) : {};
  } catch {
    return {};
  }
}
function saveSampleManual(all: Record<string, ManualHealth>): void {
  try {
    localStorage.setItem(MANUAL_KEY, JSON.stringify(all));
  } catch {
    // Private mode: it lasts as long as the page.
  }
}

/** What was typed in for a day, or null. */
export async function loadManualHealth(date: string): Promise<ManualHealth | null> {
  if (isSampleMode()) return sampleManual()[date] ?? null;
  return (await request<{ figures: ManualHealth | null }>(`/health/manual?date=${date}`)).figures;
}

/** Replace what was typed in for a day. It wins over every app for the figures it has. */
export async function saveManualHealth(date: string, figures: ManualHealth): Promise<void> {
  if (isSampleMode()) {
    saveSampleManual({ ...sampleManual(), [date]: figures });
    return;
  }
  await request("/health/manual", { method: "PUT", body: JSON.stringify({ date, ...figures }) });
}

/** Take out what was typed in for a day; the apps' figures show again. */
export async function clearManualHealth(date: string): Promise<void> {
  if (isSampleMode()) {
    const all = sampleManual();
    delete all[date];
    saveSampleManual(all);
    return;
  }
  await request(`/health/manual?date=${date}`, { method: "DELETE" });
}

/** Sample mode: the made-up days with what was typed in laid over them, as the server merges them. */
function withSampleManual(days: HealthDay[]): HealthDay[] {
  const manual = sampleManual();
  const out = days.map((d) => (manual[d.date] ? { ...d, ...manual[d.date], workouts: [...(manual[d.date].workouts ?? []), ...(d.workouts ?? [])] } : d));
  for (const [date, f] of Object.entries(manual)) if (!out.some((d) => d.date === date)) out.push({ date, ...f });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Sample days, for sample mode ----------

/** Food, drink and mind as the Shortcut sends them. */
export type FoodMind = Pick<HealthDay, "kcal" | "protein_g" | "carbs_g" | "fat_g" | "water_ml" | "caffeine_mg" | "caffeine_last" | "caffeine_after_14_mg" | "alcohol_drinks" | "last_meal" | "mindful_minutes" | "mood_valence" | "mood_labels">;

/** The day from the brief (connectors-research-2, Batch A): yesterday in sample mode. */
export const SAMPLE_FOOD_DAY: FoodMind = { kcal: 1950, caffeine_mg: 285, caffeine_last: "15:40", caffeine_after_14_mg: 95, alcohol_drinks: 2, water_ml: 1800, mindful_minutes: 10, last_meal: "20:15", protein_g: 96, carbs_g: 212, fat_g: 71 };

const GOOD_LABELS = [["Calm"], ["Content", "Grateful"], ["Happy"], ["Hopeful", "Calm"]];
const LOW_LABELS = [["Stressed"], ["Tired"], ["Irritated"], ["Drained"]];

/** A believable day of food, coffee, drinks and mindful minutes: the same every time for the same date. */
export function sampleFood(date: string): FoodMind {
  let seed = [...date].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 2147483647, 11) || 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 5 || dow === 6;
  const cups = rand() < 0.15 ? 1 : rand() < 0.6 ? 2 : 3;
  const late = cups === 3 && rand() > 0.35;
  const out: FoodMind = {
    kcal: Math.round((weekend ? 2250 : 1950) + (rand() - 0.5) * 500),
    protein_g: Math.round(80 + rand() * 40),
    carbs_g: Math.round(190 + rand() * 80),
    fat_g: Math.round(60 + rand() * 30),
    water_ml: Math.round((1300 + rand() * 1100) / 50) * 50,
    caffeine_mg: cups * 95,
    caffeine_last: late ? `${14 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 6) * 10).padStart(2, "0")}` : `${10 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 6) * 10).padStart(2, "0")}`,
    caffeine_after_14_mg: late ? 95 : 0,
    last_meal: `${19 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 4) * 15).padStart(2, "0")}`,
  };
  const drinks = weekend ? Math.floor(rand() * 4) : rand() > 0.8 ? 1 : 0;
  if (drinks) out.alcohol_drinks = drinks;
  if (rand() > 0.45) out.mindful_minutes = [5, 10, 10, 15, 20][Math.floor(rand() * 5)];
  if (rand() > 0.3) {
    out.mood_valence = Math.round((0.3 + (rand() - 0.45) * 1.1) * 100) / 100;
    const pool = out.mood_valence >= 0 ? GOOD_LABELS : LOW_LABELS;
    out.mood_labels = pool[Math.floor(rand() * pool.length)];
  }
  return out;
}

const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
};

/** Google's encoded polyline, as Strava sends a route. */
function encode(points: Array<[number, number]>): string {
  let out = "";
  let prev: [number, number] = [0, 0];
  for (const p of points) {
    for (let k = 0; k < 2; k++) {
      let v = Math.round(p[k] * 1e5) - Math.round(prev[k] * 1e5);
      v = v < 0 ? ~(v << 1) : v << 1;
      while (v >= 0x20) {
        out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      out += String.fromCharCode(v + 63);
    }
    prev = p;
  }
  return out;
}

/** A wobbly loop by the river, a few km round. */
function sampleRoute(size: number, rand: () => number): string {
  const pts: Array<[number, number]> = [];
  const wobble = rand() * 2;
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    const r = size * (0.01 + 0.003 * Math.sin(3 * t + wobble) + 0.002 * Math.cos(5 * t));
    pts.push([51.5 + r * Math.sin(t) * 0.62, -0.12 + r * Math.cos(t) * 1.4]);
  }
  return encode(pts);
}

/** A steady, made-up year: the same every time for the same day. */
export function sampleHealth(today: string): { today: string; days: HealthDay[] } {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const days: HealthDay[] = [];
  let weight = 74.6;
  for (let i = 730; i >= 1; i--) {
    const date = addDays(today, -i);
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (rand() < 0.04) continue;
    const day: HealthDay = {
      date,
      sleep_minutes: Math.round(420 + (weekend ? 35 : 0) + (rand() - 0.5) * 80 - (i < 60 ? 0 : 10)),
      steps: Math.round((weekend ? 10500 : 7600) + (rand() - 0.5) * 5200),
      resting_hr: Math.round(54 - (730 - i) / 365 + (rand() - 0.5) * 4),
    };
    // Stages for the last few months, as a watch would give them: about 18% deep, 23% REM, the rest core.
    if (i <= 120 && day.sleep_minutes) {
      const deep = Math.round(day.sleep_minutes * (0.15 + rand() * 0.07));
      const rem = Math.round(day.sleep_minutes * (0.2 + rand() * 0.07));
      const awake = Math.round(12 + rand() * 25);
      day.sleep_stages = { deep, rem, core: day.sleep_minutes - deep - rem, awake, in_bed: day.sleep_minutes + awake + Math.round(rand() * 15) };
    }
    if (dow === 2 || dow === 4 || (dow === 6 && rand() > 0.3)) {
      const long = dow === 6;
      day.workouts = [
        {
          type: "run",
          minutes: long ? 62 + Math.round(rand() * 20) : 28 + Math.round(rand() * 8),
          distance_m: long ? 11000 + Math.round(rand() * 3000) : 5000 + Math.round(rand() * 900),
          start: long ? "08:40" : "07:05",
          name: long ? "Long run, river path" : undefined,
          elevation_m: long ? 140 + Math.round(rand() * 60) : 30 + Math.round(rand() * 20),
          route: sampleRoute(long ? 1.6 : 1, rand),
        },
      ];
    }
    if (i <= 120) Object.assign(day, i === 1 ? SAMPLE_FOOD_DAY : sampleFood(date));
    if (dow === 1 && rand() > 0.4) day.workouts = [...(day.workouts ?? []), { type: "yoga", minutes: 30, start: "18:30" }];
    weight += (rand() - 0.55) * 0.18;
    if (dow === 1 || dow === 5) day.weight_kg = Math.round(weight * 10) / 10;
    days.push(day);
  }
  return { today, days };
}
