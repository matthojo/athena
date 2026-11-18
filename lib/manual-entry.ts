/**
 * Typing things in by hand: the pure parts shared by the server, the app and
 * sample mode. Anything Athena logs from a connector (spending, health,
 * energy, what was watched or read) can also be added by hand, for someone
 * whose bank, meter or app Athena can't connect to.
 *
 *  - parseAmount: "£4.50", "12", "1,200.00" → minor units.
 *  - Meter readings: the owner reads the meter now and then; the use between
 *    two readings is spread evenly over the days between them
 *    (readingDays), which become the home's days like a smart meter's,
 *    under source 'manual'.
 */

/** "£4.50", "4,50", "1,200", "12" → 450, 450, 120000, 1200. null for anything that isn't an amount above 0. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[£$€\s]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const minor = Math.round(Number(s) * 100);
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

// ---------- Meter readings ----------

export const FUELS = ["electricity", "gas"] as const;
export type MeterFuel = (typeof FUELS)[number];
/** Gas meters read in cubic metres (newer ones) or hundreds of cubic feet (older imperial ones). */
export const READING_UNITS = ["kwh", "m3", "ft3"] as const;
export type ReadingUnit = (typeof READING_UNITS)[number];

export interface MeterReading {
  id: string;
  fuel: MeterFuel;
  /** YYYY-MM-DD: the day it was read. The use between two readings is spread over the days from the first up to the day before the second. */
  date: string;
  /** What the meter shows. */
  value: number;
  unit: ReadingUnit;
}

/**
 * kWh from a gas meter's volume, as a supplier's bill works it out: volume
 * (m³) × correction factor 1.02264 × calorific value 39.5 MJ/m³ ÷ 3.6.
 * An imperial meter counts hundreds of cubic feet: × 2.83 for m³.
 */
export const M3_TO_KWH = (1.02264 * 39.5) / 3.6;
export const FT3_TO_M3 = 2.83;

export function toKwh(value: number, unit: ReadingUnit): number {
  if (unit === "m3") return value * M3_TO_KWH;
  if (unit === "ft3") return value * FT3_TO_M3 * M3_TO_KWH;
  return value;
}

/** The most days one pair of readings is spread over: a reading a year after the last still counts. */
export const MAX_SPREAD_DAYS = 400;

const dayMs = 86_400_000;
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
const plus = (d: string, n: number) => new Date(at(d) + n * dayMs).toISOString().slice(0, 10);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Each day's kWh by fuel from the readings: between two readings of a fuel,
 * the difference (in kWh) spread evenly over the days from the first reading
 * up to the day before the second. A meter that went backwards (a new meter,
 * a typing slip) leaves that stretch empty rather than guessing. Two
 * readings in different units don't make a stretch either.
 */
export function readingDays(readings: MeterReading[]): Map<string, { kwh?: number; gas_kwh?: number }> {
  const out = new Map<string, { kwh?: number; gas_kwh?: number }>();
  for (const fuel of FUELS) {
    const list = readings.filter((r) => r.fuel === fuel).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const days = Math.round((at(b.date) - at(a.date)) / dayMs);
      if (days <= 0 || days > MAX_SPREAD_DAYS || a.unit !== b.unit || b.value < a.value) continue;
      const each = toKwh(b.value - a.value, a.unit) / days;
      for (let n = 0; n < days; n++) {
        const d = plus(a.date, n);
        const row = out.get(d) ?? {};
        if (fuel === "electricity") row.kwh = r3(each);
        else row.gas_kwh = r3(each);
        out.set(d, row);
      }
    }
  }
  return out;
}

/** The use between each reading and the one before it, for the list on House: "212 kWh over 31 days". */
export function readingGaps(readings: MeterReading[]): Map<string, { kwh: number; days: number } | null> {
  const out = new Map<string, { kwh: number; days: number } | null>();
  for (const fuel of FUELS) {
    const list = readings.filter((r) => r.fuel === fuel).sort((a, b) => a.date.localeCompare(b.date));
    list.forEach((b, i) => {
      const a = list[i - 1];
      if (!a) return out.set(b.id, null);
      const days = Math.round((at(b.date) - at(a.date)) / dayMs);
      out.set(b.id, days > 0 && a.unit === b.unit && b.value >= a.value ? { kwh: Math.round(toKwh(b.value - a.value, a.unit) * 10) / 10, days } : null);
    });
  }
  return out;
}
