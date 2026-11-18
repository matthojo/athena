// Run: npx tsx --test app/src/db/sample-house.test.ts
// Energy moved from Money to House: Money's months carry spending only; House has the energy, its cost and the bills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleHouse, sampleMoney } from "./sample-life";

test("Money without Energy: months of spending, and no home figures at all", async () => {
  const m = await sampleMoney();
  assert.ok(m.months.length > 6);
  assert.equal("home" in m, false);
  assert.doesNotMatch(JSON.stringify(m), /kwh|gas_kwh|electricity/i);
});

test("House in sample mode: all four parts believable, priced at a tariff that changed", async () => {
  const h = await sampleHouse();
  const e = h.energy!;
  assert.equal(h.costs, "priced");
  assert.deepEqual(e.fuels, ["electricity", "gas"]);
  assert.equal(e.today!.half_hours.length, 48);
  assert.equal(e.heatmap.days.length, 7);
  assert.equal(e.daily.length, 30);
  assert.ok(e.months.length >= 12, "a year and more of months");
  assert.ok(e.yoy.length >= 1, "this month against last year's");
  assert.ok(e.baseload!.kwh_year > 300 && e.baseload!.kwh_year < 2000);
  assert.equal(e.rates.electricity!.time_of_use, true);
  assert.ok(e.peak!.cheap !== undefined, "a time-of-use tariff's cheap hours");
  for (const [k, v] of Object.entries(e.takeaways)) assert.ok(v.length > 10, `${k}: ${v}`);
  assert.deepEqual(new Set(h.bills.items.map((b) => b.type)), new Set(["housing", "council_tax", "energy", "water", "broadband", "phone", "tv_licence", "insurance"]));
  assert.ok(!h.bills.items.some((b) => /spotify|netflix|gym/i.test(b.name)));
});
