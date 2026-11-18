// Where the owner is, for web searches (lib/region.ts, lib/profile.ts readOwnerRegion): read only from what they wrote.
// Run: npx tsx --test lib/region.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRegion, regionLine, searchLocation } from "./region";
import { readOwnerRegion } from "./profile";
import type { Fact } from "./memory";

test("a Region answer reads as a country, a currency and a language; the city comes from Home town", () => {
  const uk = readRegion("United Kingdom, GBP, English", "Leeds");
  assert.deepEqual([uk.country, uk.currency, uk.language, uk.city], ["GB", "GBP", "en-GB", "Leeds"]);
  assert.deepEqual(searchLocation(uk), { type: "approximate", country: "GB", city: "Leeds" });
  assert.deepEqual(searchLocation(uk, "Europe/London"), { type: "approximate", country: "GB", city: "Leeds", timezone: "Europe/London" }, "the owner's time zone goes with a place");
  assert.equal(searchLocation(uk, "not a zone")?.timezone, undefined);
  assert.equal(regionLine(uk), "Leeds, United Kingdom · GBP · English");
  // Short forms and other separators.
  assert.equal(readRegion("UK").country, "GB");
  assert.equal(readRegion("US").currency, "USD");
  assert.deepEqual([readRegion("the Netherlands · € · Dutch").currency, readRegion("the Netherlands · € · Dutch").language], ["EUR", "nl-NL"]);
  assert.equal(readRegion("Germany").country, "DE", "not an old code that shares the name");
  // What the owner gave wins over the country's usual.
  const ch = readRegion("Switzerland, EUR");
  assert.deepEqual([ch.country, ch.currency, ch.language], ["CH", "EUR", "de-CH"]);
  assert.equal(readRegion("United Kingdom", "Leeds, West Yorkshire").city, "Leeds", "the town, not its county");
});

test("no country, no place: never guessed from a currency, a city or anything else", () => {
  const gbp = readRegion("GBP", "Leeds");
  assert.deepEqual([gbp.country, gbp.currency, gbp.city], [null, "GBP", null], "a city alone could be anywhere");
  assert.equal(searchLocation(gbp), null);
  assert.equal(searchLocation(gbp, "Europe/London"), null, "a time zone never places a search on its own");
  assert.equal(regionLine(gbp), "");
  const narnia = readRegion("Narnia, GBP");
  assert.deepEqual(narnia.unread, ["Narnia"]);
  assert.equal(searchLocation(readRegion("")), null);
});

const fact = (key: string, value: string, extra: Partial<Fact> = {}): Fact =>
  ({ id: key, subject_kind: "me", subject_id: null, key, value, source: "manual", confidence: null, observed_at: "2026-11-01T10:00:00Z", superseded_at: null, archived_at: null, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", ...extra }) as Fact;

test("the owner's profile: Region and Home town, current values only", () => {
  assert.equal(readOwnerRegion([fact("Home town", "Leeds")]), null, "Home town alone isn't a Region");
  const r = readOwnerRegion([fact("region", "UK"), fact("Home town", "Leeds"), fact("Region", "France", { superseded_at: "2026-11-02T00:00:00Z" })]);
  assert.deepEqual(searchLocation(r), { type: "approximate", country: "GB", city: "Leeds" });
  assert.equal(readOwnerRegion([fact("Region", "enc:v1:xyz")]), null, "sealed under another key: unread");
});

test("the three dropdowns: every choice reads back, and a country fills the other two", async () => {
  const { composeRegion, readRegion, regionChoices, regionDefaults, regionParts } = await import("./region");
  const { countries, currencies, languages } = regionChoices();
  assert.ok(countries.length > 200 && currencies.length > 100 && languages.length > 30);
  assert.ok(countries.some((c) => c.code === "GB" && c.name === "United Kingdom"));
  assert.ok(currencies.some((c) => c.code === "GBP"));
  assert.deepEqual(regionDefaults("GB"), { currency: "GBP", language: "en" });
  assert.deepEqual(regionDefaults("FR"), { currency: "EUR", language: "fr" });
  assert.equal(composeRegion({ country: "GB", currency: "GBP", language: "en" }), "United Kingdom, GBP, English");
  assert.deepEqual(regionParts("United Kingdom, GBP, English"), { country: "GB", currency: "GBP", language: "en" });
  // A country with a currency and language that aren't its usual ones stays as chosen.
  const odd = composeRegion({ country: "PT", currency: "GBP", language: "en" });
  const r = readRegion(odd);
  assert.equal(r.country, "PT");
  assert.equal(r.currency, "GBP");
  assert.equal(r.language, "en-PT");
  // Every country and every language round-trips through the stored answer.
  for (const c of countries) assert.equal(regionParts(composeRegion({ country: c.code })).country, c.code, c.name);
  for (const l of languages) assert.equal(regionParts(composeRegion({ country: "GB", currency: "GBP", language: l.code })).language, l.code, l.name);
  for (const c of currencies) assert.equal(regionParts(composeRegion({ country: "GB", currency: c.code, language: "en" })).currency, c.code, c.code);
  assert.equal(composeRegion({}), "");
});
