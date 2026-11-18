// Run: npx tsx --test lib/house.test.ts
// House's figures: the heatmap, baseload, peak share, year on year, the takeaways, household bills and house admin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "./dates";
import type { HomeDayFigures } from "./money";
import type { RegularPayment } from "./recurring";
import { baseload, billTypeOf, dailySeries, homeMonths, houseAdmin, householdBills, houseEnergy, isHouseItem, latestAndTypical, monthSeries, monthlyTakeaway, peakShare, weekHeatmap, weekHours, yearOnYear } from "./house";
import { priceDay, type DayCost, type TariffStore } from "./tariff";

/** A day: 0.1 kWh a half hour overnight, 0.2 in the day, 0.8 from 16:00 to 19:00. */
const shape = (night = 0.1) => Array.from({ length: 48 }, (_, i) => (i < 12 ? night : i >= 32 && i < 38 ? 0.8 : 0.2));
const day = (hh: number[], gas?: number): HomeDayFigures => ({ kwh: Math.round(hh.reduce((s, v) => s + v, 0) * 1000) / 1000, half_hours: hh, ...(gas !== undefined ? { gas_kwh: gas } : {}) });

function days(from: string, n: number, make: (date: string, i: number) => HomeDayFigures): Map<string, HomeDayFigures> {
  const m = new Map<string, HomeDayFigures>();
  for (let i = 0; i < n; i++) m.set(addDays(from, i), make(addDays(from, i), i));
  return m;
}

test("heatmap: the last seven days with half hours, 48 a row, its maximum; the busiest and quietest hours", () => {
  const m = days("2026-10-20", 10, (_, i) => day(shape().map((v, j) => (j === 38 && i === 9 ? 1.5 : v))));
  m.set("2026-10-31", { gas_kwh: 20 }); // gas only: no row
  const map = weekHeatmap(m);
  assert.deepEqual(map.days, ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
  assert.equal(map.cells.length, 7);
  assert.ok(map.cells.every((r) => r.length === 48));
  assert.equal(map.max, 1.5);
  const h = weekHours(map)!;
  assert.ok(h.busiest >= 16 && h.busiest <= 19, `busiest ${h.busiest}`);
  assert.ok(h.quietest < 6);
});

test("baseload: the median overnight minimum, held all day, in kWh and pounds a year", () => {
  // 0.05 kWh a half hour overnight on most nights (100 W), one night with a dryer running.
  const m = days("2026-10-01", 30, (_, i) => day(shape(i === 3 ? 0.6 : 0.05)));
  const b = baseload(m, 25)!;
  assert.equal(b.kw, 0.1);
  assert.equal(b.kwh_day, 2.4);
  assert.equal(b.kwh_year, 876);
  assert.equal(b.cost_year_p, 876 * 25);
  assert.equal(b.days, 30);
  const used = m.get("2026-10-02")!.kwh!;
  assert.equal(b.share, Math.round((2.4 / used) * 100) / 100);
  assert.equal(baseload(new Map([["2026-10-01", { gas_kwh: 4 }]])), null, "gas only: no baseload");
});

test("peak share 16:00–19:00, and on a time-of-use tariff the share in its cheap hours", () => {
  const m = days("2026-11-01", 3, () => day(shape()));
  const total = shape().reduce((s, v) => s + v, 0);
  const p = peakShare(m)!;
  assert.equal(p.peak, Math.round(((6 * 0.8) / total) * 100) / 100);
  assert.equal(p.cheap, undefined, "no tariff: no cheap hours");
  const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const tou: TariffStore = {
    fetched_on: "2026-11-04",
    account: "A-1234ABCD",
    agreements: [{ fuel: "electricity", tariff: "E-1R-GO-C", product: "GO", from: "2026-11-01T00:00:00Z", to: null, unit: ["01", "02", "03"].flatMap((d) => [[s(`2026-11-${d}T00:00:00Z`), s(`2026-11-${d}T00:30:00Z`), 28], [s(`2026-11-${d}T00:30:00Z`), s(`2026-11-${d}T05:30:00Z`), 8], [s(`2026-11-${d}T05:30:00Z`), s(`2026-11-${d}T23:59:59Z`) + 1, 28]] as Array<[number, number, number]>), standing: [[s("2026-11-01T00:00:00Z"), 0, 50]] }],
  };
  const costs = new Map<string, DayCost>([...m].map(([d, f]) => [d, priceDay(d, f, tou, "UTC")]));
  const q = peakShare(m, costs)!;
  assert.equal(q.cheap, Math.round(((10 * 0.1) / total) * 100) / 100, "00:30–05:30 at 0.1 a half hour");
});

test("year on year: this month's kWh a day against the same month last year; months oldest first with their costs", () => {
  const m = new Map<string, HomeDayFigures>();
  for (let i = 0; i < 30; i++) m.set(addDays("2025-11-01", i), { kwh: 8, gas_kwh: 20 });
  for (let i = 0; i < 9; i++) m.set(addDays("2026-11-01", i), { kwh: 8, gas_kwh: 27.6 });
  for (let i = 0; i < 31; i++) m.set(addDays("2026-10-01", i), { kwh: 7, gas_kwh: 15 });
  const months = monthSeries(homeMonths(m), new Map());
  assert.deepEqual(months.map((x) => x.month), ["2025-11", "2026-10", "2026-11"]);
  assert.equal(months[2].gas!.per_day, 27.6);
  const yoy = yearOnYear(months);
  assert.deepEqual(yoy.find((y) => y.fuel === "gas"), { month: "2026-11", fuel: "gas", per_day: 27.6, last_year: 20, change: 0.38 });
  assert.equal(yoy.find((y) => y.fuel === "electricity")!.change, 0);
  assert.equal(monthlyTakeaway(months, yoy), "38% more gas a day than November last year.");
  // No year before: against last month, and the heating named only when gas goes up in autumn.
  const recent = months.slice(1);
  assert.equal(monthlyTakeaway(recent, yearOnYear(recent)), "84% more gas a day than October, as the heating comes on.");
});

test("a month's cost shows only when every day of it was priced", () => {
  const m = days("2026-10-01", 31, () => ({ kwh: 10 }));
  const costs = new Map<string, DayCost>([...m.keys()].map((d) => [d, { electricity: { unit_p: 250, standing_p: 50, total_p: 300, slots: [], rates: [] } }]));
  assert.equal(monthSeries(homeMonths(m), costs)[0].electricity!.cost_p, 31 * 300);
  costs.delete("2026-10-10");
  assert.equal(monthSeries(homeMonths(m), costs)[0].electricity!.cost_p, undefined);
});

test("today: the latest day against a usual day, and the half hour it is now; the 30 days end at the latest reading", () => {
  const m = days("2026-10-01", 40, (_, i) => day(shape().map((v) => (i === 39 ? v * 1.5 : v))));
  const now = new Date("2026-11-10T18:40:00Z");
  const t = latestAndTypical(m, now, "UTC")!;
  assert.equal(t.date, "2026-11-09");
  assert.equal(t.now_slot, 37);
  assert.equal(t.typical[36], 0.8);
  const e = houseEnergy({ days: m, months: homeMonths(m), tariff: null, today: "2026-11-10", now, tz: "UTC" })!;
  assert.equal(e.takeaways.today, "Yesterday: 18.0 kWh, 50% more than a usual day.");
  assert.equal(e.daily.length, 30);
  assert.equal(e.daily.at(-1)!.date, "2026-11-09");
  assert.equal(e.daily.at(-1)!.peak!.slot, 32);
  assert.equal(e.daily.at(-1)!.cost, undefined, "no tariff, no cost");
  assert.deepEqual(e.rates, {});
  assert.deepEqual(e.fuels, ["electricity"]);
  assert.match(e.takeaways.peak, /^\d+% of your electricity is used between 16:00 and 19:00\.$/);
  assert.equal(houseEnergy({ days: new Map(), months: [], tariff: null, today: "2026-11-10", now, tz: "UTC" }), null);
  assert.equal(dailySeries(new Map(), new Map()).length, 0);
});

// ---------- Bills ----------

const reg = (name: string, key: string, monthly: number, extra: Partial<RegularPayment> = {}): RegularPayment => ({
  key,
  name,
  kind: "bill",
  cadence: "monthly",
  category: "bills",
  currency: "GBP",
  last_on: "2026-11-01",
  last_amount: monthly,
  usual_amount: monthly,
  next_on: "2026-12-01",
  times: 6,
  confidence: 0.9,
  monthly,
  recent: [],
  ...extra,
});

test("bills detector: household bills by payee, in the order a household thinks of them, with a monthly total", () => {
  assert.equal(billTypeOf("hackney council"), "council_tax");
  assert.equal(billTypeOf("thames water"), "water");
  assert.equal(billTypeOf("octopus energy"), "energy");
  assert.equal(billTypeOf("e on next"), "energy");
  assert.equal(billTypeOf("hyperoptic"), "broadband");
  assert.equal(billTypeOf("giffgaff"), "phone");
  assert.equal(billTypeOf("tv licensing"), "tv_licence");
  assert.equal(billTypeOf("foxtons lettings"), "housing");
  assert.equal(billTypeOf("nationwide mortgage"), "housing");
  assert.equal(billTypeOf("homeserve"), "insurance");
  for (const not of ["spotify", "netflix", "puregym", "patreon", "car insurance"]) assert.equal(billTypeOf(not), null, not);
  const r = householdBills([
    reg("Spotify", "spotify", 1199, { kind: "subscription", category: "entertainment" }),
    reg("Thames Water", "thames water", 4150),
    reg("Hackney Council", "hackney council", 16800),
    reg("TV Licensing", "tv licensing", 1413, { cadence: "yearly", last_amount: 16950, monthly: 1413 }),
    reg("Foxtons Lettings", "foxtons lettings", 185000),
  ]);
  assert.deepEqual(r.items.map((b) => b.type), ["housing", "council_tax", "water", "tv_licence"]);
  assert.deepEqual(r.monthly, { currency: "GBP", amount: 185000 + 16800 + 4150 + 1413 });
  assert.equal(r.items[3].last_amount, 16950, "the last amount as paid; the monthly share beside it");
  assert.deepEqual(householdBills([]), { items: [], monthly: null });
});

// ---------- House admin ----------

test("house admin: the Home kind, and policies and guarantees about the house; never the car or the passport; soonest first", () => {
  const items = [
    { kind: "home", name: "Boiler service", provider: "", renews_on: "2027-01-10" },
    { kind: "insurance", name: "Home insurance", provider: "", renews_on: "2026-12-01" },
    { kind: "warranty", name: "Washing machine", provider: "", renews_on: "2028-03-01" },
    { kind: "other", name: "Gas safety check", provider: "", renews_on: null },
    { kind: "insurance", name: "Car insurance", provider: "", renews_on: "2026-11-20" },
    { kind: "passport", name: "Passport", provider: "", renews_on: "2030-01-01" },
    { kind: "warranty", name: "Laptop", provider: "", renews_on: "2027-05-01" },
    { kind: "subscription", name: "Netflix", provider: "", renews_on: "2026-11-15" },
    { kind: "insurance", name: "Pet insurance for the dog", provider: "", notes: "keeps the house calm", renews_on: "2027-02-01" },
  ];
  assert.deepEqual(houseAdmin(items).map((a) => a.name), ["Home insurance", "Boiler service", "Washing machine", "Gas safety check"]);
  assert.equal(isHouseItem({ kind: "other", name: "Chimney sweep" }), true);
  assert.equal(isHouseItem({ kind: "warranty", name: "Kettle", notes: "kitchen appliance guarantee" }), true, "the words can be in the notes");
});
