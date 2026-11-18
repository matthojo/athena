// Run: npx tsx --test netlify/lib/connectors/octopus-tariffs.test.ts
// House's costs on the real path, with Octopus stubbed at fetch: the account (with the key), then each
// agreement's prices (public, no key), then the meter's days priced at them.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/life-recorded";
import { lifeRetryWaits } from "./lifelog-b-http";
import { readOctopusTariffs } from "./octopus-direct";
import { octopusAddress } from "../../../lib/presets/octopus-meters";
import { homeDays } from "../../../lib/money";
import { houseEnergy, homeMonths } from "../../../lib/house";
import { priceDay } from "../../../lib/tariff";

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
});
afterEach(() => F.unstub());

const ADDRESS = octopusAddress(JSON.stringify({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, gas: { mprn: "1234567890", serial: "G4A12345678" }, account: { number: "a-1234abcd" } }));

/** GET /v1/accounts/{n}/ as Octopus gives it, cut to what's read: an old home, an export meter, and a variable tariff then a time-of-use one. */
const ACCOUNT = {
  number: "A-1234ABCD",
  properties: [
    { moved_out_at: "2022-05-01T00:00:00Z", electricity_meter_points: [{ mpan: "1900000000001", agreements: [{ tariff_code: "E-1R-OLD-19-01-01-C", valid_from: "2019-01-01T00:00:00Z", valid_to: "2022-05-01T00:00:00Z" }] }], gas_meter_points: [] },
    {
      moved_out_at: null,
      address_line_1: "2 New Road",
      postcode: "EF3 4GH",
      electricity_meter_points: [
        { mpan: "1200012345678", is_export: false, agreements: [{ tariff_code: "E-1R-VAR-22-11-01-C", valid_from: "2025-01-01T00:00:00Z", valid_to: "2026-11-04T00:00:00Z" }, { tariff_code: "E-1R-GO-VAR-22-10-14-C", valid_from: "2026-11-04T00:00:00Z", valid_to: null }] },
        { mpan: "1300012345678", is_export: true, agreements: [{ tariff_code: "E-1R-OUTGOING-FIX-12M-19-05-13-C", valid_from: "2025-01-01T00:00:00Z", valid_to: null }] },
      ],
      gas_meter_points: [{ mprn: "1234567890", agreements: [{ tariff_code: "G-1R-VAR-22-11-01-C", valid_from: "2025-01-01T00:00:00Z", valid_to: null }] }],
    },
  ],
};

const page = (results: unknown[], next: string | null = null) => ({ count: results.length, next, previous: null, results });

/** The GO tariff's half-hourly prices, one page per day, as Octopus pages them (newest first). */
function goRates(url: URL) {
  const from = new Date(url.searchParams.get("period_from")!);
  const out: unknown[] = [];
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d < new Date("2026-11-08T00:00:00Z"); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    out.push(
      { value_exc_vat: 26.1, value_inc_vat: 27.42, valid_from: `${day}T05:30:00Z`, valid_to: `${new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10)}T00:30:00Z`, payment_method: null },
      { value_exc_vat: 8.1, value_inc_vat: 8.5, valid_from: `${day}T00:30:00Z`, valid_to: `${day}T05:30:00Z`, payment_method: null }
    );
  }
  return page(out.reverse());
}

function octopus() {
  F.stub((url, init) => {
    if (url.host !== "api.octopus.energy") return undefined;
    const auth = new Headers(init.headers).get("authorization");
    const p = url.pathname;
    if (p === "/v1/accounts/A-1234ABCD/") return auth ? { body: ACCOUNT } : { status: 401, body: F.OCTOPUS_UNAUTH };
    if (auth) throw new Error(`The key went to a public price endpoint: ${p}`);
    if (p === "/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/")
      return { body: page([{ value_inc_vat: 26.5, valid_from: "2026-10-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }, { value_inc_vat: 27.9, valid_from: "2026-10-01T00:00:00Z", valid_to: null, payment_method: "NON_DIRECT_DEBIT" }, { value_inc_vat: 24.5, valid_from: "2025-01-01T00:00:00Z", valid_to: "2026-10-01T00:00:00Z", payment_method: "DIRECT_DEBIT" }]) };
    if (p === "/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standing-charges/") return { body: page([{ value_inc_vat: 51.37, valid_from: "2025-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }]) };
    if (p === "/v1/products/GO-VAR-22-10-14/electricity-tariffs/E-1R-GO-VAR-22-10-14-C/standard-unit-rates/") return { body: goRates(url) };
    if (p === "/v1/products/GO-VAR-22-10-14/electricity-tariffs/E-1R-GO-VAR-22-10-14-C/standing-charges/") return { body: page([{ value_inc_vat: 49.8, valid_from: "2026-11-04T00:00:00Z", valid_to: null, payment_method: null }]) };
    if (p === "/v1/products/VAR-22-11-01/gas-tariffs/G-1R-VAR-22-11-01-C/standard-unit-rates/") return { body: page([{ value_inc_vat: 5.93, valid_from: "2026-10-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }, { value_inc_vat: 6.24, valid_from: "2025-01-01T00:00:00Z", valid_to: "2026-10-01T00:00:00Z", payment_method: "DIRECT_DEBIT" }]) };
    if (p === "/v1/products/VAR-22-11-01/gas-tariffs/G-1R-VAR-22-11-01-C/standing-charges/") return { body: page([{ value_inc_vat: 33.56, valid_from: "2025-01-01T00:00:00Z", valid_to: null, payment_method: "DIRECT_DEBIT" }]) };
    return { status: 404, body: F.OCTOPUS_NOT_FOUND };
  });
}

test("account, then agreements, then rates: the meter's days come out priced, across a tariff change", async () => {
  octopus();
  const store = (await readOctopusTariffs(ADDRESS, { token: "sk_live_x" }, "2026-11-07"))!;
  assert.equal(store.account, "A-1234ABCD");
  assert.equal(store.fetched_on, "2026-11-07");
  assert.deepEqual(
    store.agreements.map((a) => [a.fuel, a.product]),
    [["electricity", "VAR-22-11-01"], ["electricity", "GO-VAR-22-10-14"], ["gas", "VAR-22-11-01"]],
    "the old home's tariff and the export meter's are left out"
  );
  // The key went only with the account; every price call carried just the product and tariff codes and the dates.
  const paths = F.calls.map((c) => c.url.pathname);
  assert.equal(paths.filter((p) => p.startsWith("/v1/accounts/")).length, 1);
  for (const c of F.calls.filter((x) => x.url.pathname.startsWith("/v1/products/"))) {
    assert.equal(new Headers(c.init.headers).get("authorization"), null);
    assert.deepEqual([...c.url.searchParams.keys()].sort(), ["page_size", "period_from", "period_to"]);
  }

  // The meter's readings (fixtures as the consumption endpoint gives them), grouped into days and priced.
  const electric = [...F.octopusDay("2026-11-03"), ...F.octopusDay("2026-11-05")].map((r) => ({ start: r.interval_start, kwh: r.consumption }));
  const gas = F.octopusDay("2026-11-05", () => 0.5).map((r) => ({ start: r.interval_start, kwh: r.consumption }));
  const days = homeDays(electric, gas, "UTC");
  const before = priceDay("2026-11-03", days.get("2026-11-03")!, store, "UTC");
  const after = priceDay("2026-11-05", days.get("2026-11-05")!, store, "UTC");
  const kwh = days.get("2026-11-03")!.kwh!;
  assert.equal(before.electricity!.standing_p, 51.37);
  assert.equal(before.electricity!.unit_p, Math.round(kwh * 26.5 * 100) / 100, "the variable tariff, at the direct debit price");
  assert.equal(after.electricity!.standing_p, 49.8, "the new tariff's standing charge");
  assert.equal(after.electricity!.rates[2], 8.5, "01:00 on the time-of-use tariff");
  assert.equal(after.electricity!.rates[36], 27.42);
  assert.ok(after.electricity!.unit_p < before.electricity!.unit_p, "the same day's use costs less with its cheap hours");
  assert.deepEqual(after.gas, { unit_p: Math.round(24 * 5.93 * 100) / 100, standing_p: 33.56, total_p: Math.round((24 * 5.93 + 33.56) * 100) / 100 });

  // And House draws them: priced days, current prices, a time-of-use tariff's cheap hours.
  const e = houseEnergy({ days, months: homeMonths(days), tariff: store, today: "2026-11-06", now: new Date("2026-11-06T02:00:00Z"), tz: "UTC" })!;
  assert.equal(e.rates.electricity!.time_of_use, true);
  assert.equal(e.rates.electricity!.unit_p, 8.5);
  assert.equal(e.rates.gas!.unit_p, 5.93);
  assert.ok(e.daily.find((d) => d.date === "2026-11-05")!.cost!.electricity!.total_p > 0);
  assert.ok(e.today!.cheap?.some(Boolean));
});

test("no account number: nothing is asked of Octopus; a refused key is said in words", async () => {
  octopus();
  const plain = octopusAddress(JSON.stringify({ electricity: { mpan: "1200012345678", serial: "21L1234567" } }));
  assert.equal(await readOctopusTariffs(plain, { token: "sk_live_x" }, "2026-11-07"), null);
  assert.equal(F.calls.length, 0);
  await assert.rejects(readOctopusTariffs(ADDRESS, {}, "2026-11-07"), /API key/);
});
