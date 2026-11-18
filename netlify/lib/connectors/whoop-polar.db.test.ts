// Whoop and Polar days sealed through the real store (lib/health.ts) beside Apple Health, on Postgres with every migration.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/whoop-polar.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the health rows and life-log notes first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Whoop and Polar: sealed per source, chosen per figure, one workout counted once in the Life log line", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const H = await import("../../../lib/health");
  await qRaw(`DELETE FROM collected_items WHERE source LIKE 'life-log%'`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
  await qRaw(`DELETE FROM settings WHERE key = 'health_sources'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const today = zonedToday(new Date(), "Europe/London");
  const day = addDays(today, -1);

  const apple = H.readHealthDay({ date: day, source: "apple_health", steps: 9200, sleep_minutes: 430, workouts: [{ type: "Running", minutes: 44, distance_m: 8050, start: "07:30" }] }, { today });
  const whoop = H.readHealthDay({ date: day, source: "whoop", sleep_minutes: 450, resting_hr: 51, recovery: 68, workouts: [{ type: "running", minutes: 43, distance_m: 8034, kcal: 560, start: "07:31", elevation_m: 41 }] }, { today });
  const polar = H.readHealthDay({ date: day, source: "polar", sleep_minutes: 436, recharge: 4, steps: 11342, active_minutes: 131, workouts: [{ type: "road running", minutes: 46, distance_m: 8012, start: "07:29" }] }, { today });
  for (const d of [apple, whoop, polar]) assert.equal((await H.saveHealthDay(d)).created, true);
  assert.equal((await H.saveHealthDay(whoop)).changed, false, "a re-read changes nothing");

  const rows = await qRaw<{ source: string; label: string; ciphertext: string }>(`SELECT source, label, ciphertext FROM sensitive_blobs WHERE domain = 'health' AND day = $1::date ORDER BY source`, [day]);
  assert.deepEqual(rows.map((r) => r.source), ["apple_health", "polar", "whoop"]);
  assert.deepEqual(rows.map((r) => r.label).filter((l) => /Whoop|Polar/.test(l)), [`Health · ${day} · Polar`, `Health · ${day} · Whoop`]);
  for (const r of rows) {
    assert.match(r.ciphertext, /^enc:v1:/);
    assert.doesNotMatch(r.label + r.ciphertext, /11342|8034|450/, "no figure in the clear");
  }

  assert.deepEqual((await H.connectedSources()).filter((s) => s === "whoop" || s === "polar").sort(), ["polar", "whoop"]);
  await H.saveHealthPrefs({ sleep: "whoop", steps: "polar", workouts: "apple_health" });
  const { line } = await H.lineFor(day);
  assert.equal(line, "7h 30m sleep · 11,342 steps · 8.1k run, 41 m up · 51 bpm resting · 68% recovery", "one run, though three apps logged it");

  await H.saveHealthPrefs({ sleep: "polar" });
  assert.equal((await H.lineFor(day)).line, "7h 16m sleep · 11,342 steps · 8.1k run, 41 m up · 51 bpm resting · OK recharge", "Polar leads sleep: its recharge, and Whoop's resting heart rate fills in");
  assert.deepEqual((await H.healthSeries("recharge", day, day)).points, [{ day, value: 4 }], "Polar leads sleep: its recharge charts");
  assert.deepEqual((await H.healthSeries("recovery", day, day)).points, [], "and Whoop's score isn't shown beside it");
  await H.saveHealthPrefs({ sleep: "whoop" });
  assert.deepEqual((await H.healthSeries("recovery", day, day)).points, [{ day, value: 68 }], "Whoop leads sleep: its recovery charts");
  await assert.rejects(H.saveHealthPrefs({ weight: "whoop" }), /weight: one of withings, apple_health/);
  // Leave the database as other DB tests expect it: default choices, no health rows.
  await qRaw(`DELETE FROM settings WHERE key = 'health_sources'`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
});
