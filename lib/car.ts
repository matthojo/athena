/**
 * The owner's car: pure shapes and rules, shared by the server and the app.
 * No I/O here (lib/car-sync.ts runs the sync; netlify/lib/car-api.ts calls
 * the two government APIs).
 *
 * Two sources, field names from their published specs:
 *  - DVLA Vehicle Enquiry (VES v1.2.0): POST /v1/vehicles. make, colour,
 *    yearOfManufacture, taxStatus/taxDueDate, motStatus/motExpiryDate.
 *  - DVSA MOT History (OpenAPI 1.0.0): GET /v1/trade/vehicles/registration/{reg}.
 *    VehicleWithMotResponse (motTests[] with defects[]) or
 *    NewRegVehicleResponse (motTestDueDate).
 *
 * A registration number is personal data: it lives sealed in the `car`
 * settings row (lib/car-store.ts), goes only to those two APIs, and never
 * into a renewal's name, a push or a log line.
 */
import { addDays, daysBetween } from "./dates";

// ---------- DVLA Vehicle Enquiry ----------

export const VES_TAX_STATUSES = ["Not Taxed for on Road Use", "SORN", "Taxed", "Untaxed"] as const;
export const VES_MOT_STATUSES = ["No details held by DVLA", "No results returned", "Not valid", "Valid"] as const;

export interface VesVehicle {
  make: string | null;
  colour: string | null;
  year: number | null;
  fuel: string | null;
  tax_status: string | null;
  tax_due: string | null;
  mot_status: string | null;
  mot_expiry: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: unknown): string | null => (typeof v === "string" && DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A VES 200 answer → what Athena keeps. Null when it isn't one (no registrationNumber). */
export function readVes(raw: unknown): VesVehicle | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.registrationNumber !== "string") return null;
  return {
    make: text(r.make),
    colour: text(r.colour),
    year: Number.isInteger(r.yearOfManufacture) ? (r.yearOfManufacture as number) : null,
    fuel: text(r.fuelType),
    tax_status: text(r.taxStatus),
    tax_due: date(r.taxDueDate),
    mot_status: text(r.motStatus),
    mot_expiry: date(r.motExpiryDate),
  };
}

// ---------- DVSA MOT History ----------

export type DefectType = "ADVISORY" | "DANGEROUS" | "FAIL" | "MAJOR" | "MINOR" | "NON SPECIFIC" | "SYSTEM GENERATED" | "USER ENTERED";

export interface MotTest {
  /** The day it was completed, YYYY-MM-DD (completedDate is a date-time). */
  date: string;
  result: "PASSED" | "FAILED";
  expiry: string | null;
  /** In miles, converted from KM; null when it wasn't read. */
  miles: number | null;
  defects: Array<{ type: DefectType | null; text: string; dangerous: boolean }>;
}

export interface MotHistory {
  make: string | null;
  model: string | null;
  colour: string | null;
  fuel: string | null;
  /** First MOT, for a vehicle too new to have had one (NewRegVehicleResponse). */
  first_due: string | null;
  recall: "Yes" | "No" | "Unknown" | "Unavailable" | null;
  /** Newest first. */
  tests: MotTest[];
}

const KM_TO_MILES = 0.621371;

/** A MOT History 200 answer (either shape) → what Athena keeps. Null when it isn't one. */
export function readMot(raw: unknown): MotHistory | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.hasOutstandingRecall !== "string") return null;
  const tests: MotTest[] = [];
  for (const t of Array.isArray(r.motTests) ? (r.motTests as Array<Record<string, unknown>>) : []) {
    const day = date(t?.completedDate);
    if (!day || (t.testResult !== "PASSED" && t.testResult !== "FAILED")) continue;
    const n = typeof t.odometerValue === "string" ? Number(t.odometerValue) : NaN;
    const read = t.odometerResultType === "READ" && Number.isFinite(n) && n > 0;
    tests.push({
      date: day,
      result: t.testResult,
      expiry: date(t.expiryDate),
      miles: read ? Math.round(t.odometerUnit === "KM" ? n * KM_TO_MILES : n) : null,
      defects: (Array.isArray(t.defects) ? (t.defects as Array<Record<string, unknown>>) : [])
        .filter((d) => text(d?.text))
        .map((d) => ({ type: (text(d.type) as DefectType | null) ?? null, text: text(d.text)!, dangerous: d.dangerous === true })),
    });
  }
  tests.sort((a, b) => b.date.localeCompare(a.date));
  const recall = ["Yes", "No", "Unknown", "Unavailable"].includes(r.hasOutstandingRecall as string) ? (r.hasOutstandingRecall as MotHistory["recall"]) : null;
  return { make: text(r.make), model: text(r.model), colour: text(r.primaryColour), fuel: text(r.fuelType), first_due: date(r.motTestDueDate), recall, tests };
}

// ---------- registrations ----------

/** "ab12 cde" → "AB12CDE". Null when it can't be a UK registration (2 to 8 letters and digits, with both). */
export function normaliseRegistration(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const r = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return r.length >= 2 && r.length <= 8 && /[A-Z]/.test(r) && /[0-9]/.test(r) ? r : null;
}

/** "AB12CDE" → "AB12 CDE" for showing to the owner (current-style plates; others as they are). */
export function showRegistration(reg: string): string {
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(reg) ? `${reg.slice(0, 4)} ${reg.slice(4)}` : reg;
}

// ---------- a vehicle, as stored ----------

export interface CarVehicle {
  /** Athena's own id: what renewals, nudges and the app use. Never the registration. */
  id: string;
  registration: string;
  added_on: string;
  /** The day of the last successful read; the sync reads each vehicle once a day. */
  fetched_on: string | null;
  ves: VesVehicle | null;
  mot: MotHistory | null;
  /** The Life admin items the sync keeps in step, by what they track. */
  assets: { mot?: string; tax?: string };
  /** The last read's trouble in the owner's words ("DVLA has no vehicle with that registration."). */
  problem?: string | null;
}

export interface CarState {
  vehicles: CarVehicle[];
}

export const EMPTY_CAR: CarState = { vehicles: [] };

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
/** Makes that read wrong in title case. */
const MAKES: Record<string, string> = { BMW: "BMW", MG: "MG", DS: "DS", MINI: "MINI", KIA: "Kia", "MERCEDES-BENZ": "Mercedes-Benz", VOLKSWAGEN: "Volkswagen", VW: "VW" };
const makeName = (m: string) => MAKES[m.toUpperCase()] ?? titleCase(m);

/** "Ford Focus", else "Blue Ford", else "Your car". Never the registration. */
export function vehicleLabel(v: Pick<CarVehicle, "ves" | "mot">): string {
  const make = v.mot?.make ?? v.ves?.make;
  const model = v.mot?.model;
  if (make && model) return `${makeName(make)} ${titleCase(model)}`;
  const colour = v.ves?.colour ?? v.mot?.colour;
  if (make) return colour ? `${titleCase(colour)} ${makeName(make)}` : makeName(make);
  return "Your car";
}

/** When the MOT runs out: the latest date either source gives. */
export function motDue(v: Pick<CarVehicle, "ves" | "mot">): string | null {
  const dates = [
    v.ves?.mot_status === "Valid" || v.ves?.mot_status === "Not valid" ? v.ves.mot_expiry : null,
    ...(v.mot?.tests ?? []).filter((t) => t.result === "PASSED").map((t) => t.expiry),
    v.mot && !v.mot.tests.length ? v.mot.first_due : null,
  ].filter((d): d is string => !!d);
  return dates.sort().pop() ?? null;
}

/** When the tax is due, from DVLA only. None while it's SORN or off the road. */
export function taxDue(v: Pick<CarVehicle, "ves">): string | null {
  const s = v.ves?.tax_status;
  return s === "Taxed" || s === "Untaxed" ? v.ves!.tax_due : null;
}

// ---------- renewals in Life admin ----------

export type CarWhat = "mot" | "tax";

export interface WantedRenewal {
  what: CarWhat;
  name: string;
  renews_on: string;
  provider: string;
}

/** The note on each renewal Athena keeps. Says the dates come from the record, not the owner. */
export const RENEWAL_NOTE = "Athena keeps this date in step with the government record once a day.";
/** The briefing mentions these on the day itself; the car nudges speak at about 30 and 7 days. */
export const RENEWAL_REMIND_DAYS = [0];

/** The renewals a vehicle should have: "Ford Focus MOT", "Ford Focus tax". */
export function wantedRenewals(v: CarVehicle, label = vehicleLabel(v)): WantedRenewal[] {
  const out: WantedRenewal[] = [];
  const mot = motDue(v);
  if (mot) out.push({ what: "mot", name: `${label} MOT`, renews_on: mot, provider: v.mot ? "DVSA" : "DVLA" });
  const tax = taxDue(v);
  if (tax) out.push({ what: "tax", name: `${label} tax`, renews_on: tax, provider: "DVLA" });
  return out;
}

/** Two cars with the same label get the start of their registration, so their renewals can be told apart. */
export function vehicleLabels(vehicles: CarVehicle[]): Map<string, string> {
  const base = vehicles.map((v) => vehicleLabel(v));
  return new Map(vehicles.map((v, i) => [v.id, base.filter((b) => b === base[i]).length > 1 ? `${base[i]} (${v.registration.slice(0, 4)})` : base[i]]));
}

// ---------- the vehicle card ----------

/** "Nearside front tyre worn close to legal limit/worn on edge (5.2.3 (e))" → "Left front tyre worn close to the legal limit or worn on edge". */
export function plainAdvisory(raw: string): string {
  let s = raw
    .replace(/\s*\((?:\d+(?:\.\d+)*\s*(?:\([a-z]+\)\s*)*(?:\([ivx]+\)\s*)*)\)\s*/gi, " ")
    .replace(/\bnearside\b/gi, "left")
    .replace(/\boffside\b/gi, "right")
    .replace(/\bn\/s\b/gi, "left")
    .replace(/\bo\/s\b/gi, "right")
    // DVSA joins alternatives with a slash ("worn close to legal limit/worn on edge"): say "or".
    .replace(/(\w)\s*\/\s*(?=\w)/g, "$1 or ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/close to legal limit/i, "close to the legal limit");
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : raw;
}

export interface DueLine {
  /** YYYY-MM-DD, or null when nothing says. */
  on: string | null;
  /** Negative once it has passed. */
  days: number | null;
  /** The source's own words ("Valid", "Taxed", "SORN"), or null without DVLA. */
  status: string | null;
}

export interface CarCard {
  id: string;
  registration: string;
  label: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  year: number | null;
  fuel: string | null;
  mot: DueLine;
  tax: DueLine;
  last_test: { date: string; result: "PASSED" | "FAILED"; miles: number | null } | null;
  /** Readings, oldest first, for the trend line. */
  mileage: Array<{ date: string; miles: number }>;
  /** Miles a year from the first reading to the last, when there are two a year or more apart. */
  miles_a_year: number | null;
  /** From the latest test: advisories and minor defects, in plain words. */
  advisories: string[];
  recall: boolean;
  fetched_on: string | null;
  problem: string | null;
  /** Which sources this card had. */
  sources: { dvla: boolean; mot: boolean };
}

export function carCard(v: CarVehicle, today: string, label = vehicleLabel(v)): CarCard {
  const mot = motDue(v);
  const tax = taxDue(v);
  const latest = v.mot?.tests[0] ?? null;
  const mileage = (v.mot?.tests ?? [])
    .filter((t): t is MotTest & { miles: number } => t.miles !== null)
    .map((t) => ({ date: t.date, miles: t.miles }))
    .reverse();
  const first = mileage[0];
  const last = mileage[mileage.length - 1];
  const span = first && last ? daysBetween(first.date, last.date) : 0;
  const perYear = span >= 330 && last.miles >= first.miles ? Math.round(((last.miles - first.miles) / span) * 365.25 / 100) * 100 : null;
  return {
    id: v.id,
    registration: v.registration,
    label,
    make: v.ves?.make ?? v.mot?.make ?? null,
    model: v.mot?.model ?? null,
    colour: v.ves?.colour ?? v.mot?.colour ?? null,
    year: v.ves?.year ?? null,
    fuel: v.ves?.fuel ?? v.mot?.fuel ?? null,
    mot: { on: mot, days: mot ? daysBetween(today, mot) : null, status: v.ves?.mot_status ?? null },
    tax: { on: tax, days: tax ? daysBetween(today, tax) : null, status: v.ves?.tax_status ?? null },
    last_test: latest ? { date: latest.date, result: latest.result, miles: latest.miles } : null,
    mileage,
    miles_a_year: perYear,
    advisories: [...new Set((latest?.defects ?? []).filter((d) => d.type === "ADVISORY" || d.type === "MINOR").map((d) => plainAdvisory(d.text)))],
    recall: v.mot?.recall === "Yes",
    fetched_on: v.fetched_on,
    problem: v.problem ?? null,
    sources: { dvla: !!v.ves, mot: !!v.mot },
  };
}

// ---------- nudges ----------

/** What the car nudge reads: one line per date, no registration. */
export interface CarDue {
  vehicle_id: string;
  label: string;
  what: CarWhat;
  due: string;
}

export function carDues(state: CarState): CarDue[] {
  const labels = vehicleLabels(state.vehicles);
  return state.vehicles.flatMap((v) => wantedRenewals(v, labels.get(v.id)).map((r) => ({ vehicle_id: v.id, label: labels.get(v.id)!, what: r.what, due: r.renews_on })));
}

/** Which nudge a date is in for: about 30 days out (8 to 30), then the last week (0 to 7). */
export function carNudgeStage(today: string, due: string): 30 | 7 | null {
  const n = daysBetween(today, due);
  if (n < 0 || n > 30) return null;
  return n <= 7 ? 7 : 30;
}

/** The nudge key: a new date (renewed) is a new key, so the old card goes and nothing more is said until it's close again. */
export const carNudgeKey = (d: Pick<CarDue, "vehicle_id" | "what" | "due">, stage: 30 | 7) => `car:${d.vehicle_id}:${d.what}:${d.due}:${stage}`;
export const carNudgePrefix = (vehicleId: string, what?: CarWhat) => `car:${vehicleId}:${what ? `${what}:` : ""}`;

/** When a stage's card leaves Home: the 30-day one when the last week starts, the 7-day one the day after it's due. */
export function carNudgeEnds(due: string, stage: 30 | 7): string {
  return stage === 30 ? addDays(due, -7) : addDays(due, 1);
}
