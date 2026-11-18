/**
 * Meter readings typed in by hand, on the Library's House page: for a home
 * whose supplier or meter Athena can't read (anything but Octopus, or no
 * smart meter at all). The owner reads the meter now and then; the use
 * between two readings is spread evenly over the days between them
 * (lib/manual-entry.ts readingDays) and kept as the home's days under
 * source 'manual', so House's charts, Days' home line and Ask read them
 * like a smart meter's (without the half hours, which only a smart meter has).
 *
 * Storage. The list itself is one sealed row: domain 'home', source
 * 'readings', on a fixed day no home window reaches (like the tariff and
 * the regular payments), skipped by readDays. The worked-out days are
 * rebuilt from the list on every change: a day no pair of readings covers
 * any more is deleted. A smart meter's day wins over a typed one for the
 * same fuel (lib/money.ts readHomeDays).
 */
import { randomUUID } from "node:crypto";
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { addDays } from "./dates";
import { AthenaInputError, qRaw } from "./db";
import { FUELS, READING_UNITS, readingDays, type MeterFuel, type MeterReading, type ReadingUnit } from "./manual-entry";
import { MANUAL_SOURCE, saveHomeDays } from "./money";

export type { MeterReading };
export const READINGS_SOURCE = "readings";
const READINGS_DAY = "2000-01-02";
export const MAX_READINGS = 1000;
const MAX_DAYS_BACK = 800;

export async function loadReadings(): Promise<MeterReading[]> {
  const [row] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'home' AND source = $1 AND day = $2::date`, [READINGS_SOURCE, READINGS_DAY]);
  if (!row) return [];
  const o = JSON.parse(openStrict(row.ciphertext)) as { readings?: MeterReading[] };
  return (o.readings ?? []).sort((a, b) => b.date.localeCompare(a.date) || a.fuel.localeCompare(b.fuel));
}

async function saveReadings(readings: MeterReading[], tz: string): Promise<void> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(
    `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
     VALUES ('home', 'Meter readings', $1, now(), $2::date, $3)
     ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, recorded_at = EXCLUDED.recorded_at`,
    [sealText(JSON.stringify({ readings })), READINGS_DAY, READINGS_SOURCE],
  );
  // The worked-out days, rebuilt whole.
  const days = readingDays(readings);
  const keep = [...days.keys()];
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'home' AND source = $1 AND NOT (day = ANY($2::date[]))`, [MANUAL_SOURCE, keep]);
  await saveHomeDays(MANUAL_SOURCE, days, { tz });
}

/** Check one reading as the app sends it. */
export function readReading(raw: unknown, ctx: { today: string }): Omit<MeterReading, "id"> {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) throw new AthenaInputError("Send the reading as JSON: fuel, date, value");
  if (!(FUELS as readonly unknown[]).includes(o.fuel)) throw new AthenaInputError("fuel: electricity or gas");
  const fuel = o.fuel as MeterFuel;
  const date = o.date === undefined || o.date === "" ? ctx.today : o.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new AthenaInputError("date: YYYY-MM-DD");
  if (date > ctx.today) throw new AthenaInputError("date: that day hasn't happened yet");
  if (date < addDays(ctx.today, -MAX_DAYS_BACK)) throw new AthenaInputError(`date: at most ${MAX_DAYS_BACK} days back`);
  const value = typeof o.value === "string" ? Number(o.value) : o.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) throw new AthenaInputError("value: the number on the meter");
  const unit = o.unit === undefined || o.unit === "" ? "kwh" : o.unit;
  if (!(READING_UNITS as readonly unknown[]).includes(unit)) throw new AthenaInputError(`unit: one of ${READING_UNITS.join(", ")}`);
  if (fuel === "electricity" && unit !== "kwh") throw new AthenaInputError("unit: an electricity meter reads in kWh");
  return { fuel, date, value: Math.round(value * 1000) / 1000, unit: unit as ReadingUnit };
}

/** Add a reading (one a fuel a day: a second on the same day replaces the first). Answers with the list. */
export async function addReading(raw: unknown, ctx: { today: string; tz: string }): Promise<MeterReading[]> {
  const r = readReading(raw, ctx);
  const have = await loadReadings();
  const rest = have.filter((x) => !(x.fuel === r.fuel && x.date === r.date));
  if (rest.length >= MAX_READINGS) throw new AthenaInputError(`At most ${MAX_READINGS} readings`);
  const next = [...rest, { id: randomUUID(), ...r }];
  await saveReadings(next, ctx.tz);
  return loadReadings();
}

/** Take a reading out. Null when there was none with that id. */
export async function removeReading(id: string, ctx: { tz: string }): Promise<MeterReading[] | null> {
  const have = await loadReadings();
  const next = have.filter((x) => x.id !== id);
  if (next.length === have.length) return null;
  await saveReadings(next, ctx.tz);
  return loadReadings();
}
