// Run: npx tsx --test netlify/lib/travel-key.test.ts
// travelKey's order: the key stored in Sources, then the old environment variable, then nothing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearTravelKeys, knownTravelKey, primeTravelKeys, travelKey } from "./travel-key";

const env = (k: Record<string, string>) => (name: string) => k[name];
const ENV = env({ ATHENA_GOOGLE_ROUTES_KEY: "env-google", ATHENA_TFL_KEY: "env-tfl", ATHENA_RDM_KEY: "env-rdm" });

beforeEach(() => clearTravelKeys());

test("a stored key comes first, for each service", async () => {
  const stored = async () => ({ "google-routes": "stored-google", tfl: "stored-tfl", "national-rail": "stored-rdm" });
  assert.equal(await travelKey("google-routes", { env: ENV, stored }), "stored-google");
  assert.equal(await travelKey("tfl", { env: ENV, stored }), "stored-tfl");
  assert.equal(await travelKey("national-rail", { env: ENV, stored }), "stored-rdm");
});

test("no stored key: the environment's, trimmed, so existing deploys keep working", async () => {
  const stored = async () => ({ tfl: "stored-tfl" });
  assert.equal(await travelKey("google-routes", { env: ENV, stored }), "env-google");
  assert.equal(await travelKey("national-rail", { env: env({ ATHENA_RDM_KEY: "  env-rdm \n" }), stored }), "env-rdm");
  assert.equal(await travelKey("tfl", { env: ENV, stored }), "stored-tfl");
});

test("neither: null, and a blank stored key doesn't hide the environment's", async () => {
  assert.equal(await travelKey("tfl", { env: env({}), stored: async () => ({}) }), null);
  assert.equal(await travelKey("tfl", { env: env({ ATHENA_TFL_KEY: "   " }), stored: async () => ({}) }), null);
  assert.equal(await travelKey("tfl", { env: ENV, stored: async () => ({ tfl: "  " }) }), "env-tfl");
});

test("a store that fails counts as no stored key, never an error", async () => {
  const stored = async () => {
    throw new Error("no database");
  };
  assert.equal(await travelKey("google-routes", { env: ENV, stored }), "env-google");
  assert.equal(await travelKey("google-routes", { env: env({}), stored }), null);
});

test("knownTravelKey answers without waiting: the environment's, or none before the store's been read", () => {
  assert.equal(knownTravelKey("tfl", { env: ENV }), true);
  assert.equal(knownTravelKey("tfl", { env: env({}) }), false);
});

test("the real store, with no database: the environment still counts and the read is remembered", async () => {
  const logged: unknown[][] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    await primeTravelKeys();
    assert.equal(await travelKey("tfl", { env: ENV }), "env-tfl");
    assert.equal(await travelKey("tfl", { env: env({}) }), null);
  } finally {
    console.error = err;
  }
  assert.ok(logged.length <= 1, "the failed read is remembered, not retried on every call");
});
