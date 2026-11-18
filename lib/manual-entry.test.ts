// Run: npx tsx --test lib/manual-entry.test.ts
// Typing things in by hand: spending, health, meter readings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { M3_TO_KWH, parseAmount, readingDays, readingGaps, toKwh, type MeterReading } from "./manual-entry";
import { dayHome, homeLine, manualDayFigures, mergeHome, mergeMoney, readManualPayment } from "./money";
import { mergeSources, readHealthDay } from "./health";

test("parseAmount reads amounts the way people type them", () => {
  assert.equal(parseAmount("4.50"), 450);
  assert.equal(parseAmount("£4.50"), 450);
  assert.equal(parseAmount(" 12 "), 1200);
  assert.equal(parseAmount("4,50"), 450);
  assert.equal(parseAmount("1,200"), 120000);
  assert.equal(parseAmount("1,200.99"), 120099);
  assert.equal(parseAmount("0"), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("4.505"), null);
  assert.equal(parseAmount("-3"), null);
});

const today = "2026-11-14";

test("readManualPayment checks a payment and fills in the day and time", () => {
  assert.deepEqual(readManualPayment({ amount: 450, merchant: "  Coffee  ", category: "eating_out" }, { today, nowTime: "09:12" }), {
    date: today,
    time: "09:12",
    amount: 450,
    currency: "GBP",
    category: "eating_out",
    merchant: "Coffee",
  });
  // An earlier day without a time: midday.
  assert.equal(readManualPayment({ amount: 100, date: "2026-11-10" }, { today, nowTime: "09:12" }).time, "12:00");
  assert.equal(readManualPayment({ amount: 100 }, { today }).category, "general");
  assert.throws(() => readManualPayment({ amount: 0 }, { today }), /amount/);
  assert.throws(() => readManualPayment({ amount: 4.5 }, { today }), /amount/);
  assert.throws(() => readManualPayment({ amount: 100, date: "2026-11-15" }, { today }), /hasn't happened/);
  assert.throws(() => readManualPayment({ amount: 100, category: "rent" }, { today }), /category/);
  assert.throws(() => readManualPayment({ amount: 100, currency: "gbp" }, { today }), /currency/);
  assert.throws(() => readManualPayment({ amount: 100, time: "25:00" }, { today }), /time/);
  assert.throws(() => readManualPayment(null, { today }), /JSON/);
});

test("hand-added payments make a day like a bank's, and merge with one", () => {
  const manual = manualDayFigures([
    { id: "b", time: "18:00", amount: 1200, currency: "GBP", category: "eating_out", merchant: "Pizza" },
    { id: "a", time: "08:30", amount: 300, currency: "GBP", category: "eating_out" },
  ]);
  assert.equal(manual.spent, 1500);
  assert.equal(manual.count, 2);
  assert.deepEqual(manual.categories, { eating_out: 1500 });
  assert.deepEqual(manual.payments.map((p) => p.id), ["a", "b"]);
  const bank = { currency: "GBP", spent: 2000, count: 1, categories: { groceries: 2000 }, payments: [{ time: "12:00", amount: 2000, category: "groceries" as const, merchant: "Waitrose" }] };
  const both = mergeMoney([bank, manual])!;
  assert.equal(both.spent, 3500);
  assert.equal(both.count, 3);
  assert.deepEqual(both.payments.map((p) => p.time), ["08:30", "12:00", "18:00"]);
});

test("figures typed in win over every app, and the apps fill the rest", () => {
  const merged = mergeSources([
    { source: "oura", sleep_minutes: 420, steps: 9000 },
    { source: "apple_health", steps: 8000, water_ml: 1500 },
    { source: "manual", sleep_minutes: 480, weight_kg: 72.4 },
  ]);
  assert.equal(merged.sleep_minutes, 480);
  assert.equal(merged.weight_kg, 72.4);
  assert.equal(merged.steps, 8000);
  assert.equal(merged.water_ml, 1500);
});

test("a workout typed in joins the apps' and isn't counted twice", () => {
  const merged = mergeSources([
    { source: "apple_health", workouts: [{ type: "run", minutes: 30, start: "07:00" }] },
    { source: "manual", workouts: [{ type: "run", minutes: 31 }, { type: "yoga", minutes: 20 }] },
  ]);
  assert.equal(merged.workouts?.length, 2);
});

test("readHealthDay takes source manual", () => {
  assert.equal(readHealthDay({ date: "2026-11-13", source: "manual", steps: 5000 }, { today }).source, "manual");
});

const reading = (id: string, fuel: MeterReading["fuel"], date: string, value: number, unit: MeterReading["unit"] = "kwh"): MeterReading => ({ id, fuel, date, value, unit });

test("readingDays spreads the use between two readings over the days between them", () => {
  const days = readingDays([reading("a", "electricity", "2026-11-01", 1000), reading("b", "electricity", "2026-11-11", 1080)]);
  assert.equal(days.size, 10);
  assert.equal(days.get("2026-11-01")?.kwh, 8);
  assert.equal(days.get("2026-11-10")?.kwh, 8);
  // The day of the second reading starts the next stretch: nothing yet.
  assert.equal(days.has("2026-11-11"), false);
});

test("readingDays turns a gas meter's volume into kWh, and skips what it can't trust", () => {
  const gas = readingDays([reading("a", "gas", "2026-11-01", 500, "m3"), reading("b", "gas", "2026-11-03", 510, "m3")]);
  assert.equal(gas.get("2026-11-01")?.gas_kwh, Math.round(5 * M3_TO_KWH * 1000) / 1000);
  assert.ok(Math.abs(toKwh(1, "ft3") - 2.83 * M3_TO_KWH) < 1e-9);
  // Backwards (a new meter, a slip), or a change of unit: no stretch.
  assert.equal(readingDays([reading("a", "electricity", "2026-11-01", 1000), reading("b", "electricity", "2026-11-05", 900)]).size, 0);
  assert.equal(readingDays([reading("a", "gas", "2026-11-01", 500, "m3"), reading("b", "gas", "2026-11-05", 600, "kwh")]).size, 0);
  // One reading alone says nothing yet.
  assert.equal(readingDays([reading("a", "gas", "2026-11-01", 500, "m3")]).size, 0);
});

test("readingGaps says what was used since the reading before", () => {
  const gaps = readingGaps([reading("a", "electricity", "2026-11-01", 1000), reading("b", "electricity", "2026-11-11", 1080), reading("c", "gas", "2026-11-11", 3)]);
  assert.equal(gaps.get("a"), null);
  assert.deepEqual(gaps.get("b"), { kwh: 80, days: 10 });
  assert.equal(gaps.get("c"), null);
});

test("a smart meter's day wins over one worked out from readings, fuel by fuel", () => {
  const hh = Array<number>(48).fill(0.2);
  const merged = mergeHome([
    { source: "manual", kwh: 8, gas_kwh: 20 },
    { source: "octopus", kwh: 9.6, half_hours: hh },
  ]);
  assert.equal(merged.kwh, 9.6);
  assert.equal(merged.half_hours, hh);
  assert.equal(merged.gas_kwh, 20);
});

test("a day from readings has a home line without hours", () => {
  assert.equal(homeLine({ kwh: 8 }), "8.0 kWh");
  assert.equal(homeLine({ kwh: 8, gas_kwh: 21.3 }), "8.0 kWh · gas 21.3 kWh");
  assert.deepEqual(dayHome({ kwh: 8.04 }), { line: "8.0 kWh", kwh: 8 });
});
