// The Days mood style, the same on every device: GET/PUT /api/settings through the real /api function, kept in Postgres.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/day-prefs.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readMoodStyle } from "./day-prefs";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("readMoodStyle: only Moons, Levels or Faces; anything else is Moons", () => {
  assert.equal(readMoodStyle("faces"), "faces");
  assert.equal(readMoodStyle("levels"), "levels");
  assert.equal(readMoodStyle("Faces"), "moons");
  assert.equal(readMoodStyle(null), "moons");
  assert.equal(readMoodStyle(3), "moons");
});

test("mood style: chosen on one device, read on another", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM settings WHERE key = 'days_mood_style'`);
  const call = async (method: string, body?: unknown) => {
    const res = await api(new Request("https://athena.test/api/settings", { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, json: await res.json() };
  };
  // Nothing chosen yet: Moons.
  let r = await call("GET");
  assert.equal(r.status, 200);
  assert.equal(r.json.mood_style, "moons");
  // The phone picks Faces; the laptop reads Faces.
  r = await call("PUT", { mood_style: "faces" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { mood_style: "faces" });
  assert.equal((await call("GET")).json.mood_style, "faces");
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'days_mood_style'`);
  assert.equal(row.value, "faces");
  // A wrong style is refused and changes nothing; the time zone still saves on its own, leaving the style alone.
  r = await call("PUT", { mood_style: "stars" });
  assert.equal(r.status, 400);
  r = await call("PUT", { timezone: "Europe/London" });
  assert.equal(r.status, 200);
  assert.equal((await call("GET")).json.mood_style, "faces");
  assert.equal((await call("PUT", {})).status, 400);
});
