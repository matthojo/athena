// Run: npx tsx --test lib/api-keys.test.ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cachedFor, macEqual, matchKey, storedForm, useDue, type Stored } from "./api-keys";

const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);
const TOKEN = `athk_${"x".repeat(43)}`;
const OTHER = `athk_${"y".repeat(43)}`;

const saved = { key: process.env.ATHENA_DATA_KEY, previous: process.env.ATHENA_DATA_KEY_PREVIOUS };
afterEach(() => {
  for (const [name, value] of [["ATHENA_DATA_KEY", saved.key], ["ATHENA_DATA_KEY_PREVIOUS", saved.previous]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function entry(token: string, id = "11111111-1111-4111-8111-111111111111"): Stored {
  const form = storedForm(token);
  assert.ok(form, "a data key is set");
  return { id, label: "Test", scope: "full", created_at: "2026-11-01T00:00:00.000Z", last_used_at: null, ...form };
}

test("a new key is stored as an HMAC under the data key, marked v2 with the key's id, and verifies", () => {
  process.env.ATHENA_DATA_KEY = KEY_A;
  delete process.env.ATHENA_DATA_KEY_PREVIOUS;
  const e = entry(TOKEN);
  assert.equal(e.v, 2);
  assert.match(e.kid!, /^[0-9a-f]{8}$/);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(e.hash, createHash("sha256").update(TOKEN).digest("hex"), "not a plain hash");
  assert.equal(matchKey([e], TOKEN)?.key.id, e.id);
  assert.equal(matchKey([e], TOKEN)?.stale, false);
  assert.equal(matchKey([e], OTHER), null, "another token");
});

test("an entry from before (a plain SHA-256, no v2) is refused, even for the right token", () => {
  process.env.ATHENA_DATA_KEY = KEY_A;
  const legacy: Stored = { id: "22222222-2222-4222-8222-222222222222", label: "Old", scope: "full", created_at: "2026-01-01T00:00:00.000Z", last_used_at: null, hash: createHash("sha256").update(TOKEN).digest("hex") };
  assert.equal(matchKey([legacy], TOKEN), null);
  assert.equal(matchKey([{ ...legacy, v: 1, kid: entry(OTHER).kid }], TOKEN), null, "a version that isn't 2");
  // An entry someone wrote with a hash they chose, but under no data key Athena holds, doesn't open either.
  assert.equal(matchKey([{ ...legacy, v: 2, kid: "00000000" }], TOKEN), null);
});

test("without ATHENA_DATA_KEY no key is made and none is accepted", () => {
  process.env.ATHENA_DATA_KEY = KEY_A;
  const e = entry(TOKEN);
  delete process.env.ATHENA_DATA_KEY;
  assert.equal(storedForm(TOKEN), null);
  assert.equal(matchKey([e], TOKEN), null);
  process.env.ATHENA_DATA_KEY_PREVIOUS = KEY_A;
  assert.equal(matchKey([e], TOKEN), null, "a previous key alone isn't enough");
});

test("rotation: a key made under the previous data key still verifies and is marked to store again; once the old key is gone it doesn't", () => {
  process.env.ATHENA_DATA_KEY = KEY_A;
  delete process.env.ATHENA_DATA_KEY_PREVIOUS;
  const old = entry(TOKEN);
  process.env.ATHENA_DATA_KEY = KEY_B;
  process.env.ATHENA_DATA_KEY_PREVIOUS = KEY_A;
  const hit = matchKey([old], TOKEN);
  assert.equal(hit?.key.id, old.id);
  assert.equal(hit?.stale, true);
  const again = { ...old, ...storedForm(TOKEN)! };
  assert.notEqual(again.kid, old.kid);
  assert.equal(matchKey([again], TOKEN)?.stale, false, "stored again under the current key");
  delete process.env.ATHENA_DATA_KEY_PREVIOUS;
  assert.equal(matchKey([old], TOKEN), null, "the old key removed: an entry still under it no longer opens");
  assert.equal(matchKey([again], TOKEN)?.key.id, old.id);
});

test("MACs are compared in constant time, against every usable entry", () => {
  process.env.ATHENA_DATA_KEY = KEY_A;
  const list = [entry(OTHER, "33333333-3333-4333-8333-333333333333"), entry(TOKEN), entry(OTHER, "44444444-4444-4444-8444-444444444444")];
  const compared: string[] = [];
  const hit = matchKey(list, TOKEN, (a, b) => (compared.push(a), macEqual(a, b)));
  assert.equal(hit?.key.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(compared.length, 3, "every entry is compared, not only up to the match");
  const mac = list[1].hash;
  assert.equal(macEqual(mac, mac), true);
  assert.equal(macEqual(mac, list[0].hash), false);
  assert.equal(macEqual(mac, mac.slice(0, 62)), false, "a different length is false, not a throw");
  assert.equal(macEqual("not hex", mac), false);
});

test("the key list is kept for its time, read again after, and forgotten on a change", async () => {
  let reads = 0;
  const c = cachedFor(10_000, async () => ++reads);
  assert.equal(await c.get(1_000), 1);
  assert.equal(await c.get(10_999), 1, "within ten seconds: the kept copy");
  assert.equal(await c.get(11_000), 2, "after: read again");
  c.forget();
  assert.equal(await c.get(11_001), 3, "a key made or removed: read again at once");
  let fail = true;
  const flaky = cachedFor(10_000, async () => {
    if (fail) throw new Error("no database");
    return "ok";
  });
  await assert.rejects(flaky.get(0));
  fail = false;
  assert.equal(await flaky.get(1), "ok", "a failed read isn't kept");
});

test("a key's use is written at most once a minute", () => {
  const seen = new Map<string, number>();
  assert.equal(useDue(seen, "a", 0), true);
  assert.equal(useDue(seen, "a", 59_999), false);
  assert.equal(useDue(seen, "b", 30_000), true, "each key on its own");
  assert.equal(useDue(seen, "a", 60_000), true);
});
