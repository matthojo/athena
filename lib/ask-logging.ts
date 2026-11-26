/**
 * Logging from a sentence: "I spent £4 on coffee", "slept 7 hours", "watched
 * Perfect Days last night", "electricity meter reads 12345". The pure parts,
 * shared by Ask's tools (lib/assistant-logging.ts), the MCP server
 * (netlify/lib/mcp/logging.ts) and the app's confirm card
 * (app/src/components/ask-confirm.ts), so it imports nothing with a database.
 *
 * The model reads the sentence into a tool's fields; these check the fields
 * and make the card the owner confirms. Nothing here saves: in Ask the app
 * saves when the owner taps, through the same routes as the manual-entry
 * forms.
 */
import { addDays } from "./dates";
import { MONEY_CATEGORIES, type MoneyCategory } from "./day-types";
import { MG_PER_COFFEE, type HealthFigures, type Workout } from "./health-line";
import { FUELS, READING_UNITS, parseAmount, toKwh, type MeterFuel, type MeterReading, type ReadingUnit } from "./manual-entry";

/** A tool's field the model got wrong: the message says what to fix, in words it can act on. */
export class LogInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "LogInputError";
  }
}

/** What a day's entry can be when it's added by hand (lib/days.ts MANUAL_ENTRY_KINDS). */
export const LOG_ENTRY_KINDS = ["watched", "listened", "read", "played", "other"] as const;
export type LogEntryKind = (typeof LOG_ENTRY_KINDS)[number];

/** The same limits as the forms (lib/money.ts, lib/meter-readings.ts, lib/health.ts). */
const SPEND_DAYS_BACK = 800;
const HEALTH_DAYS_BACK = 400;
const MAX_MINOR = 100_000_000;

/** The figures Ask can log: what the Health page's form covers (components/health-log-sheet.ts). */
export type LoggedHealth = Pick<HealthFigures, "sleep_minutes" | "steps" | "weight_kg" | "resting_hr" | "workouts" | "water_ml" | "caffeine_mg" | "alcohol_drinks" | "kcal" | "mindful_minutes">;

export type LogCard =
  /** log_spending: a payment for the Money page's "Added by hand" (POST /api/life/spending). */
  | { kind: "log_spending"; date: string; amount: number; currency: string; category: MoneyCategory; merchant?: string }
  /**
   * log_health: only the figures the owner said. The tap reads what was typed in for the day and lays these
   * over it (mergeHealth), so nothing typed before is lost (PUT /api/health/manual replaces the day whole).
   */
  | { kind: "log_health"; date: string; figures: LoggedHealth; keeps: string[] }
  /** log_day_entry: something watched, heard, read or played (POST /api/days/:date/entries). */
  | { kind: "log_entry"; date: string; entry: { kind: LogEntryKind; title: string; subtitle?: string; minutes?: number } }
  /** log_meter_reading: a reading for House (POST /api/life/readings), with what was used since the one before. */
  | { kind: "log_reading"; date: string; fuel: MeterFuel; value: number; unit: ReadingUnit; since?: { date: string; kwh: number } };

const obj = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A number as the model sends it: a number, or text like "9,200" or "7.5". */
function number(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "").trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new LogInputError(`${what}: a number, 0 or more`);
  return n;
}

function within(n: number | undefined, what: string, min: number, max: number, places = 0): number | undefined {
  if (n === undefined) return undefined;
  if (n < min || n > max) throw new LogInputError(`${what}: between ${min} and ${max}`);
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** The day: YYYY-MM-DD, today when left out, never ahead of today. */
function day(v: unknown, today: string, back: number): string {
  const date = v === undefined || v === null || v === "" ? today : v;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new LogInputError("date: YYYY-MM-DD");
  if (date > today) throw new LogInputError("date: that day hasn't happened yet");
  if (date < addDays(today, -back)) throw new LogInputError(`date: at most ${back} days back`);
  return date;
}

const SYMBOLS: Record<string, string> = { "£": "GBP", $: "USD", "€": "EUR" };

/** "£4", "4.50", "€12,50", 4 → minor units and the currency it was in. A bare number is the owner's own pounds unless currency says otherwise. */
export function readSpendAmount(amount: unknown, currency?: unknown): { amount: number; currency: string } {
  const text = typeof amount === "number" ? amount.toFixed(2) : typeof amount === "string" ? amount.trim() : "";
  const symbol = Object.keys(SYMBOLS).find((s) => text.includes(s));
  const given = typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : null;
  if (given && !/^[A-Z]{3}$/.test(given)) throw new LogInputError("currency: three capital letters, like GBP");
  const minor = parseAmount(text.replace(/\b(GBP|USD|EUR|p)\b/gi, "").trim());
  if (minor === null) throw new LogInputError("amount: what was spent, like £4.50");
  if (minor > MAX_MINOR) throw new LogInputError("amount: at most 1,000,000");
  return { amount: minor, currency: given ?? (symbol ? SYMBOLS[symbol] : "GBP") };
}

/** log_spending's fields as the card. */
export function spendingCard(raw: unknown, ctx: { today: string }): Extract<LogCard, { kind: "log_spending" }> {
  const o = obj(raw);
  const { amount, currency } = readSpendAmount(o.amount, o.currency);
  const category = o.category === undefined || o.category === "" ? "general" : o.category;
  if (typeof category !== "string" || !(MONEY_CATEGORIES as readonly string[]).includes(category)) throw new LogInputError(`category: one of ${MONEY_CATEGORIES.join(", ")}`);
  const merchant = clean(o.what, 120);
  return { kind: "log_spending", date: day(o.date, ctx.today, SPEND_DAYS_BACK), amount, currency, category: category as MoneyCategory, ...(merchant ? { merchant } : {}) };
}

/** log_health's fields (in the words people use: hours, litres, coffees, km) as the figures Athena keeps. */
export function readLoggedHealth(raw: unknown): LoggedHealth {
  const o = obj(raw);
  const out: LoggedHealth = {};
  const sleep = within(number(o.sleep_hours, "sleep_hours"), "sleep_hours", 0, 24, 2);
  if (sleep !== undefined) out.sleep_minutes = Math.round(sleep * 60);
  const steps = within(number(o.steps, "steps"), "steps", 0, 200_000);
  if (steps !== undefined) out.steps = steps;
  const weight = within(number(o.weight_kg, "weight_kg"), "weight_kg", 20, 400, 1);
  if (weight !== undefined) out.weight_kg = weight;
  const hr = within(number(o.resting_hr, "resting_hr"), "resting_hr", 20, 250);
  if (hr !== undefined) out.resting_hr = hr;
  const water = within(number(o.water_litres, "water_litres"), "water_litres", 0, 20, 3);
  if (water !== undefined) out.water_ml = Math.round(water * 1000);
  const coffees = within(number(o.coffees, "coffees"), "coffees", 0, 30);
  if (coffees !== undefined) out.caffeine_mg = coffees * MG_PER_COFFEE;
  const drinks = within(number(o.alcohol_drinks, "alcohol_drinks"), "alcohol_drinks", 0, 50, 1);
  if (drinks !== undefined) out.alcohol_drinks = drinks;
  const kcal = within(number(o.kcal, "kcal"), "kcal", 0, 20_000);
  if (kcal !== undefined) out.kcal = kcal;
  const mindful = within(number(o.mindful_minutes, "mindful_minutes"), "mindful_minutes", 0, 1440);
  if (mindful !== undefined) out.mindful_minutes = mindful;
  if (o.workout !== undefined && o.workout !== null) {
    const w = obj(o.workout);
    const type = clean(w.type, 60).toLowerCase();
    if (!type) throw new LogInputError('workout.type: like "run", "walk", "ride", "swim", "strength", "yoga"');
    const minutes = within(number(w.minutes, "workout.minutes"), "workout.minutes", 1, 1440);
    if (minutes === undefined) throw new LogInputError("workout.minutes: how long it took");
    const km = within(number(w.km, "workout.km"), "workout.km", 0, 1000, 2);
    out.workouts = [{ type, minutes, ...(km ? { distance_m: Math.round(km * 1000) } : {}) }];
  }
  if (!Object.keys(out).length) throw new LogInputError("Give at least one figure the owner said: sleep_hours, steps, weight_kg, resting_hr, workout, water_litres, coffees, alcohol_drinks, kcal or mindful_minutes");
  return out;
}

const sameWorkout = (a: Workout, b: Workout) => a.type === b.type && a.minutes === b.minutes && (a.distance_m ?? 0) === (b.distance_m ?? 0);

/**
 * What was typed in for the day with the new figures laid over it: only the figures the owner said change, the
 * rest stay. A workout is added to the day's, unless it's the same one again. Only the
 * figures the Health page's form covers are carried over, so what's sent back is what the form would send.
 */
export function mergeHealth(before: Partial<HealthFigures> | null | undefined, figures: LoggedHealth): LoggedHealth {
  const out: Record<string, unknown> = {};
  for (const k of HEALTH_ORDER) if (before?.[k] !== undefined && before[k] !== null) out[k] = before[k];
  Object.assign(out, figures);
  if (figures.workouts) {
    const had = before?.workouts ?? [];
    out.workouts = [...had, ...figures.workouts.filter((w) => !had.some((h) => sameWorkout(h, w)))];
  }
  return out as LoggedHealth;
}

/** log_health's card: the figures said, and which of the day's typed-in figures stay as they are. */
export function healthCard(raw: unknown, ctx: { today: string }, before: Partial<HealthFigures> | null): Extract<LogCard, { kind: "log_health" }> {
  const date = day(obj(raw).date, ctx.today, HEALTH_DAYS_BACK);
  const figures = readLoggedHealth(raw);
  const keeps = HEALTH_ORDER.filter((k) => before?.[k] !== undefined && (k === "workouts" ? !!before.workouts?.length : figures[k] === undefined)).map((k) => HEALTH_NAMES[k]);
  return { kind: "log_health", date, figures, keeps };
}

/** log_day_entry's fields as the card. */
export function entryCard(raw: unknown, ctx: { today: string }): Extract<LogCard, { kind: "log_entry" }> {
  const o = obj(raw);
  if (!(LOG_ENTRY_KINDS as readonly unknown[]).includes(o.kind)) throw new LogInputError(`kind: one of ${LOG_ENTRY_KINDS.join(", ")}`);
  const title = clean(o.title, 300);
  if (!title) throw new LogInputError("title: what it was, like the film's or album's name");
  const subtitle = clean(o.subtitle, 300);
  const minutes = within(number(o.minutes, "minutes"), "minutes", 1, 1440);
  return { kind: "log_entry", date: day(o.date, ctx.today, SPEND_DAYS_BACK), entry: { kind: o.kind as LogEntryKind, title, ...(subtitle ? { subtitle } : {}), ...(minutes ? { minutes } : {}) } };
}

/** log_meter_reading's fields as the card; `since` when the last reading of that meter, in the same unit, is earlier and lower. */
export function readingCard(raw: unknown, ctx: { today: string }, readings: MeterReading[] = []): Extract<LogCard, { kind: "log_reading" }> {
  const o = obj(raw);
  if (!(FUELS as readonly unknown[]).includes(o.fuel)) throw new LogInputError("fuel: electricity or gas");
  const fuel = o.fuel as MeterFuel;
  const unit = o.unit === undefined || o.unit === null || o.unit === "" ? "kwh" : o.unit;
  if (!(READING_UNITS as readonly unknown[]).includes(unit)) throw new LogInputError(`unit: one of ${READING_UNITS.join(", ")}`);
  if (fuel === "electricity" && unit !== "kwh") throw new LogInputError("unit: an electricity meter reads in kWh");
  const value = within(number(o.value, "value"), "value", 0, 1e9, 3);
  if (value === undefined) throw new LogInputError("value: the number on the meter");
  const date = day(o.date, ctx.today, SPEND_DAYS_BACK);
  const before = readings.filter((r) => r.fuel === fuel && r.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const used = before && before.unit === unit && value >= before.value ? Math.round(toKwh(value - before.value, unit as ReadingUnit)) : null;
  return { kind: "log_reading", date, fuel, value, unit: unit as ReadingUnit, ...(used !== null && before ? { since: { date: before.date, kwh: used } } : {}) };
}

// ---------- What the card says ----------

const HEALTH_ORDER = ["sleep_minutes", "steps", "workouts", "weight_kg", "resting_hr", "water_ml", "caffeine_mg", "alcohol_drinks", "kcal", "mindful_minutes"] as const satisfies ReadonlyArray<keyof LoggedHealth>;
const HEALTH_NAMES: Record<(typeof HEALTH_ORDER)[number], string> = {
  sleep_minutes: "sleep",
  steps: "steps",
  workouts: "workouts",
  weight_kg: "weight",
  resting_hr: "resting heart rate",
  water_ml: "water",
  caffeine_mg: "coffee",
  alcohol_drinks: "drinks",
  kcal: "calories",
  mindful_minutes: "mindful minutes",
};

const whole = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const hm = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
const plural = (n: number, one: string, many: string) => `${whole(n)} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Sleep 7h", "9,200 steps", "Run 30 min, 5 km": one figure as the card shows it. */
export function healthFigureWords(figures: LoggedHealth): string[] {
  const out: string[] = [];
  for (const k of HEALTH_ORDER) {
    const v = figures[k];
    if (v === undefined) continue;
    if (k === "workouts") for (const w of figures.workouts ?? []) out.push(`${cap(w.type)} ${w.minutes} min${w.distance_m ? `, ${whole(w.distance_m / 1000)} km` : ""}`);
    else if (k === "sleep_minutes") out.push(`Sleep ${hm(v as number)}`);
    else if (k === "steps") out.push(plural(v as number, "step", "steps"));
    else if (k === "weight_kg") out.push(`${whole(v as number)} kg`);
    else if (k === "resting_hr") out.push(`Resting heart rate ${v}`);
    else if (k === "water_ml") out.push(`Water ${whole((v as number) / 1000)} l`);
    else if (k === "caffeine_mg") out.push(plural(Math.round((v as number) / MG_PER_COFFEE), "coffee", "coffees"));
    else if (k === "alcohol_drinks") out.push(plural(v as number, "drink", "drinks"));
    else if (k === "kcal") out.push(`${whole(v as number)} kcal`);
    else out.push(`${v} min mindful`);
  }
  return out;
}

/** "Fri 13 Nov": absolute, so a card read again next week still says the right day. */
export function cardDay(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)).replace(",", "") : date;
}

export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const CATEGORY: Record<MoneyCategory, string> = {
  eating_out: "Eating out",
  takeaway: "Takeaway",
  groceries: "Groceries",
  transport: "Transport",
  shopping: "Shopping",
  bills: "Bills",
  entertainment: "Going out",
  holidays: "Holidays",
  personal_care: "Personal care",
  general: "Other",
};
export const categoryName = (c: MoneyCategory) => CATEGORY[c];

const ENTRY_WORD: Record<LogEntryKind, string> = { watched: "Watched", listened: "Listened", read: "Read", played: "Played", other: "Added" };
const UNIT_WORD: Record<ReadingUnit, string> = { kwh: "kWh", m3: "m³", ft3: "hundred ft³" };
export const readingValue = (value: number, unit: ReadingUnit) => `${value.toLocaleString("en-GB", { maximumFractionDigits: 3 })} ${UNIT_WORD[unit]}`;

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What each logging card says (lib/assistant-confirm.ts confirmWords): title, the line under it, the button, its name for screen readers. */
export function logWords(card: LogCard): { title: string; meta: string; action: string; label: string } {
  const when = cardDay(card.date);
  if (card.kind === "log_spending") {
    const amount = formatMoney(card.amount, card.currency);
    const what = card.merchant || CATEGORY[card.category];
    return { title: `${amount} · ${what}`, meta: `${CATEGORY[card.category]} · ${when} · Money`, action: "Add", label: `Add spending: ${amount} on ${what}, ${when}` };
  }
  if (card.kind === "log_health") {
    const said = healthFigureWords(card.figures);
    const keeps = card.keeps.length ? `keeps your ${list(card.keeps)}` : "Health";
    return { title: said.join(" · "), meta: `${when} · ${keeps}`, action: "Save", label: `Log health for ${when}: ${said.join(", ")}` };
  }
  if (card.kind === "log_entry") {
    const e = card.entry;
    const detail = [ENTRY_WORD[e.kind], e.subtitle, e.minutes ? `${e.minutes} min` : "", when].filter(Boolean).join(" · ");
    return { title: e.title, meta: detail, action: "Add", label: `Add to ${when}: ${ENTRY_WORD[e.kind].toLowerCase()} ${e.title}` };
  }
  const meter = card.fuel === "electricity" ? "Electricity" : "Gas";
  const reading = readingValue(card.value, card.unit);
  const since = card.since ? ` · ${whole(card.since.kwh)} kWh since ${cardDay(card.since.date)}` : "";
  return { title: `${meter} meter: ${reading}`, meta: `${when}${since}`, action: "Add", label: `Add ${card.fuel === "electricity" ? "an" : "a"} ${meter.toLowerCase()} meter reading: ${reading}, ${when}` };
}
