// Run: npx tsx --test lib/tariff.test.ts
// Pricing a day at the tariff: the standing charge, a change of price mid-month, time of use, two-rate meters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementAt, cheapSlots, currentRates, electricityRateAt, pence, priceDay, productOf, rateAt, ratesOf, slotStarts, unitPrice, type Rate, type TariffStore } from "./tariff";

const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const flat = (kwh: number) => Array<number>(48).fill(kwh);

/** Electricity at 24p then 26p from 15 Oct; a 50p standing charge then 52p; gas 6p with 30p standing. */
const store: TariffStore = {
  fetched_on: "2026-11-09",
  account: "A-1234ABCD",
  agreements: [
    { fuel: "electricity", tariff: "E-1R-VAR-22-11-01-C", product: "VAR-22-11-01", from: "2025-01-01T00:00:00Z", to: null, unit: [[s("2025-01-01T00:00:00Z"), s("2026-10-15T00:00:00Z"), 24], [s("2026-10-15T00:00:00Z"), 0, 26]], standing: [[s("2025-01-01T00:00:00Z"), s("2026-10-15T00:00:00Z"), 50], [s("2026-10-15T00:00:00Z"), 0, 52]] },
    { fuel: "gas", tariff: "G-1R-VAR-22-11-01-C", product: "VAR-22-11-01", from: "2025-01-01T00:00:00Z", to: null, unit: [[s("2025-01-01T00:00:00Z"), 0, 6]], standing: [[s("2025-01-01T00:00:00Z"), 0, 30]] },
  ],
};

test("product codes come out of tariff codes", () => {
  assert.equal(productOf("E-1R-AGILE-FLEX-22-11-25-C"), "AGILE-FLEX-22-11-25");
  assert.equal(productOf("G-1R-VAR-22-11-01-N"), "VAR-22-11-01");
  assert.equal(productOf("E-2R-VAR-22-11-01-A"), "VAR-22-11-01");
});

test("rates: direct debit wins over the other price; open-ended to; oldest first", () => {
  const r = ratesOf([
    { value_inc_vat: 27.5, valid_from: "2026-10-01T00:00:00Z", valid_to: null, payment_method: "NON_DIRECT_DEBIT" },
    { value_inc_vat: 26, valid_from: "2026-10-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" },
    { value_inc_vat: 24, valid_from: "2026-07-01T00:00:00Z", valid_to: "2026-10-01T00:00:00Z", payment_method: "DIRECT_DEBIT" },
  ]);
  assert.deepEqual(r, [[s("2026-07-01T00:00:00Z"), s("2026-10-01T00:00:00Z"), 24], [s("2026-10-01T00:00:00Z"), 0, 26]]);
  assert.equal(rateAt(r, s("2026-06-30T23:00:00Z")), null, "before the first price: none");
  assert.equal(rateAt(r, s("2026-08-01T00:00:00Z")), 24);
  assert.equal(rateAt(r, s("2027-08-01T00:00:00Z")), 26);
});

test("a day is its kWh at the unit rate plus one day's standing charge", () => {
  const c = priceDay("2026-10-01", { half_hours: flat(0.25), kwh: 12, gas_kwh: 30 }, store, "Europe/London");
  assert.equal(c.electricity!.unit_p, 288, "12 kWh at 24p");
  assert.equal(c.electricity!.standing_p, 50);
  assert.equal(c.electricity!.total_p, 338);
  assert.equal(c.electricity!.slots.length, 48);
  assert.deepEqual(c.gas, { unit_p: 180, standing_p: 30, total_p: 210 });
});

test("a price change in the middle of the month: days either side price at their own rate", () => {
  const before = priceDay("2026-10-14", { half_hours: flat(0.25) }, store, "Europe/London");
  const after = priceDay("2026-10-15", { half_hours: flat(0.25) }, store, "Europe/London");
  assert.equal(before.electricity!.total_p, 288 + 50);
  assert.equal(after.electricity!.total_p, 312 - 1 + 52, "two half hours still at 24p");
  // The change lands at midnight UTC: in October that's 01:00 in London, so the day's first two half hours are still at the old price.
  const day = priceDay("2026-10-15", { half_hours: flat(0.25) }, store, "Europe/London").electricity!;
  assert.deepEqual(day.rates.slice(0, 3), [24, 24, 26]);
});

test("a tariff switch: each fuel's agreement covers its own dates; no agreement, no price", () => {
  const switched: TariffStore = {
    ...store,
    agreements: [
      { ...store.agreements[0], to: "2026-11-01T00:00:00Z" },
      { fuel: "electricity", tariff: "E-1R-FIX-12M-26-10-C", product: "FIX-12M-26-10", from: "2026-11-01T00:00:00Z", to: null, unit: [[s("2026-11-01T00:00:00Z"), 0, 20]], standing: [[s("2026-11-01T00:00:00Z"), 0, 45]] },
    ],
  };
  assert.equal(agreementAt(switched, "electricity", s("2026-10-31T12:00:00Z"))!.product, "VAR-22-11-01");
  assert.equal(agreementAt(switched, "electricity", s("2026-11-02T12:00:00Z"))!.product, "FIX-12M-26-10");
  assert.equal(priceDay("2026-11-05", { half_hours: flat(0.5) }, switched, "UTC").electricity!.total_p, 24 * 20 + 45);
  assert.deepEqual(priceDay("2026-11-05", { gas_kwh: 10 }, switched, "UTC"), {}, "gas with no gas agreement stays unpriced");
  assert.deepEqual(priceDay("2024-06-01", { half_hours: flat(0.5) }, store, "UTC"), {}, "before any agreement: unpriced, never a cost that's too low");
});

/** Cheap 00:30–05:30 at 8p, 28p otherwise, for a week. */
function touStore(): TariffStore {
  const unit: Rate[] = [];
  for (let d = 1; d <= 7; d++) {
    const day = `2026-11-0${d}`;
    unit.push([s(`${day}T00:00:00Z`), s(`${day}T00:30:00Z`), 28], [s(`${day}T00:30:00Z`), s(`${day}T05:30:00Z`), 8], [s(`${day}T05:30:00Z`), s(`2026-11-0${d + 1}T00:00:00Z`), 28]);
  }
  return { ...store, agreements: [{ fuel: "electricity", tariff: "E-1R-GO-VAR-22-10-14-C", product: "GO-VAR-22-10-14", from: "2026-11-01T00:00:00Z", to: null, unit, standing: [[s("2026-11-01T00:00:00Z"), 0, 50]] }] };
}

test("time of use: each half hour at its own price, and the cheap hours found", () => {
  const t = touStore();
  const hh = flat(0.1);
  hh[2] = 2; // 01:00, cheap: an overnight charge
  hh[36] = 2; // 18:00, peak
  const c = priceDay("2026-11-03", { half_hours: hh }, t, "UTC").electricity!;
  assert.equal(c.rates[2], 8);
  assert.equal(c.rates[36], 28);
  assert.equal(c.slots[2], 16);
  assert.equal(c.slots[36], 56);
  // 10 cheap slots (one of them 2 kWh, nine 0.1) and 38 at 28p (one of them 2 kWh, 37 at 0.1).
  const expected = 2 * 8 + 9 * 0.1 * 8 + 2 * 28 + 37 * 0.1 * 28;
  assert.equal(c.unit_p, Math.round(expected * 100) / 100);
  const cheap = cheapSlots(c.rates);
  assert.equal(cheap.filter(Boolean).length, 10, "00:30 to 05:30");
  assert.equal(cheap[0], false);
  assert.equal(cheap[1], true);
  assert.deepEqual(cheapSlots(flat(24)).filter(Boolean), [], "a flat tariff has no cheap hours");
  const now = currentRates(t, "2026-11-03", new Date("2026-11-03T02:00:00Z"), "UTC").electricity!;
  assert.equal(now.time_of_use, true);
  assert.equal(now.unit_p, 8);
  assert.deepEqual([now.low_p, now.high_p], [8, 28]);
  assert.equal(now.average_p, Math.round(((10 * 8 + 38 * 28) / 48) * 100) / 100);
});

test("a two-rate meter charges its night rate 00:30–07:30 UTC", () => {
  const two: TariffStore = { ...store, agreements: [{ fuel: "electricity", tariff: "E-2R-VAR-22-11-01-C", product: "VAR-22-11-01", from: "2026-01-01T00:00:00Z", to: null, unit: [[s("2026-01-01T00:00:00Z"), 0, 30]], night: [[s("2026-01-01T00:00:00Z"), 0, 12]], standing: [[s("2026-01-01T00:00:00Z"), 0, 50]] }] };
  assert.equal(electricityRateAt(two, s("2026-11-03T00:00:00Z")), 30);
  assert.equal(electricityRateAt(two, s("2026-11-03T00:30:00Z")), 12);
  assert.equal(electricityRateAt(two, s("2026-11-03T07:00:00Z")), 12);
  assert.equal(electricityRateAt(two, s("2026-11-03T07:30:00Z")), 30);
});

test("a clock-change day still has 48 local half hours, each at its real instant", () => {
  const starts = slotStarts("2026-10-25", "Europe/London");
  assert.equal(starts.length, 48);
  assert.equal(starts[0], s("2026-10-24T23:00:00Z"));
  assert.equal(starts[24], s("2026-10-25T12:00:00Z"));
});

test("words: pence and unit prices", () => {
  assert.equal(pence(38.4), "38p");
  assert.equal(pence(142), "£1.42");
  assert.equal(unitPrice(24.5), "24.5p");
  assert.equal(unitPrice(8), "8p");
});
