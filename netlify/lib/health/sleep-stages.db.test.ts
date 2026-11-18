// Real path for sleep stages: the real /api function, a capture key, the Shortcut's POST /api/health/day as the
// owner's iPhone sent it on 7 Nov and as the new steps send it, sealed in Postgres with every migration applied,
// read back merged through /api/health/days and a Day.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/health/sleep-stages.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the health rows first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Sleep stages: the owner's payload saves, the new Shortcut's stages are sealed and read back", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { createApiKey } = await import("../../../lib/api-keys");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const { getDay } = await import("../../../lib/days");

  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
  await qRaw(`DELETE FROM settings WHERE key = 'health_sources'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const today = zonedToday(new Date(), "Europe/London");
  const yesterday = addDays(today, -1);
  const call = async (method: string, path: string, body: string | undefined, token: string) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body }), {} as never);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const { token: capture } = await createApiKey("iPhone", "capture");

  // ---- 7 Nov: the samples in the sleep_minutes Number field. Was a 400; now the day saves and says what to change. ----
  const owner = JSON.stringify({ steps: 9213.0, sleep_minutes: "Deep\nCore\nREM\nCore\nAwake\nCore\nIn Bed\nDeep\nCore\nREM\nCore\nAwake\nCore", resting_hr: 52 });
  let r = await call("POST", "/health/day", owner, capture);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.created, true);
  assert.match(r.json.message, /^Saved health for \w+day \d+ \w+\. Sleep wasn't saved: Athena got the stage names but not their times\. In the Shortcut, send sleep_stages as the Stages text/);
  assert.equal(r.json.skipped.length, 1);
  let day = await getDay(yesterday, { tz: "Europe/London" });
  assert.equal(day?.health?.steps, 9213);
  assert.equal(day?.health?.sleep_minutes, undefined, "no sleep made up from names alone");

  // Nothing but the names: a plain 400 that writes nothing new.
  r = await call("POST", "/health/day", JSON.stringify({ date: addDays(today, -2), sleep_minutes: "Deep\nCore\nREM" }), capture);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /stage names but not their times\. In the Shortcut/);
  assert.equal((await qRaw(`SELECT 1 FROM sensitive_blobs WHERE domain = 'health'`)).length, 1);

  // ---- the new steps: one "Value,Start Date,End Date" line per sample, iPhone In Bed around the Watch's stages ----
  const at = (d: string, hm: string) => `${Number(d.slice(8))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)} at ${hm}`;
  const eve = addDays(yesterday, -1);
  const stages = [
    `In Bed,${at(eve, "23:20")},${at(yesterday, "07:10")}`,
    `Core,${at(eve, "23:35")},${at(yesterday, "00:20")}`,
    `Deep,${at(yesterday, "00:20")},${at(yesterday, "01:45")}`,
    `Core,${at(yesterday, "01:45")},${at(yesterday, "03:00")}`,
    `REM,${at(yesterday, "03:00")},${at(yesterday, "04:00")}`,
    `Awake,${at(yesterday, "04:00")},${at(yesterday, "04:20")}`,
    `Core,${at(yesterday, "04:20")},${at(yesterday, "06:00")}`,
    `REM,${at(yesterday, "06:00")},${at(yesterday, "06:50")}`,
    `Core,${at(yesterday, "06:40")},${at(yesterday, "07:00")}`, // a second app, overlapping REM
  ].join("\n");
  r = await call("POST", "/health/day", JSON.stringify({ steps: 9213, sleep_stages: stages, resting_hr: 52 }), capture);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.skipped, undefined);
  assert.match(r.json.message, /^Saved health for \w+day \d+ \w+\.$/);
  assert.ok(!/deep|REM|85|110/i.test(r.text.replace(yesterday, "")), "the answer carries no figures");

  // Sealed: one row for the day and source, nothing readable.
  const rows = await qRaw<{ label: string; ciphertext: string }>(`SELECT label, ciphertext FROM sensitive_blobs WHERE domain = 'health'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].ciphertext, /^enc:v1:/);
  assert.ok(!/deep|core|rem|in_bed/i.test(rows[0].ciphertext));

  // Read back: the Health page and the Day.
  const full = process.env.MCP_BEARER_TOKEN!;
  r = await call("GET", `/health/days?from=${yesterday}&to=${yesterday}`, undefined, full);
  assert.equal(r.status, 200, r.text);
  const want = { core: 230, deep: 85, rem: 110, awake: 20, in_bed: 470 };
  assert.deepEqual(r.json.days[0].sleep_stages, want);
  assert.equal(r.json.days[0].sleep_minutes, 425, "asleep: deep + core + REM");
  assert.equal(r.json.days[0].steps, 9213);
  day = await getDay(yesterday, { tz: "Europe/London" });
  assert.deepEqual(day?.health?.sleep_stages, want);
  assert.equal(day?.health?.line, "7h 5m sleep (1h 25m deep) · 9,213 steps · 52 bpm resting", "deep sleep on the line (owner, 7 Nov)");
  // A capture key can't read them.
  assert.equal((await call("GET", `/health/days?from=${yesterday}&to=${yesterday}`, undefined, capture)).status, 401);

  // Sending the same night again changes nothing.
  r = await call("POST", "/health/day", JSON.stringify({ steps: 9213, sleep_stages: stages, resting_hr: 52 }), capture);
  assert.equal(r.json.changed, false);
});
