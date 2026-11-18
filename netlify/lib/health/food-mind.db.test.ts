// Food, drink and mind on the real path: the Shortcut's POST through /api (capture key), sealed in Postgres,
// merged with Oura per the owner's choice, on the Day, in the chart, and State of Mind filling mood for Patterns
// only on a day the owner left blank.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/health/food-mind.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the health, days and settings rows it uses first.
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

test("Food, drink and mind: sealed from the Shortcut, merged with Oura, on the Day, and mood only where the owner left none", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { createApiKey } = await import("../../../lib/api-keys");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const H = await import("../../../lib/health");
  const { getDay, patchDay } = await import("../../../lib/days");
  const { loadPatternDays } = await import("../../../lib/patterns-data");

  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
  await qRaw(`DELETE FROM settings WHERE key = 'health_sources'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const today = zonedToday(new Date(), "Europe/London");
  const yesterday = addDays(today, -1);
  const before = addDays(today, -2);
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const { token: capture } = await createApiKey("iPhone", "capture");

  // ---- refused: nothing written ----
  for (const bad of [{ water_ml: "2 pints" }, { kcal: -1 }, { caffeine_mg: "95\n95", caffeine_times: "08:00" }, { mood_valence: 3 }, { caffein_mg: 95 }]) {
    assert.equal((await call("POST", "/health/day", bad, capture)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await qRaw(`SELECT 1 FROM sensitive_blobs WHERE domain = 'health'`)).length, 0);

  // ---- the Shortcut's fold, as Text fields with units and one sample per line ----
  const fold = {
    kcal: "450 kcal\n700 kcal\n800 kcal",
    last_meal: `${yesterday} 08:05\n${yesterday} 13:00\n${yesterday} 20:15`,
    water_ml: "0.8 L\n1,000 ml",
    caffeine_mg: "95 mg\n95 mg\n95 mg",
    caffeine_times: "07:30\n11:00\n15:40",
    alcohol_drinks: "1\n1",
    mindful_minutes: "600 s",
    mood_valence: "0.4",
    mood_labels: "Calm\nGrateful",
  };
  let r = await call("POST", "/health/day", fold, capture);
  assert.equal(r.status, 200, r.text);
  assert.ok(!/1950|1,950|285|1800/.test(r.text), "the answer carries no figures");
  const [row] = await qRaw<{ label: string; ciphertext: string }>(`SELECT label, ciphertext FROM sensitive_blobs WHERE domain = 'health'`);
  assert.equal(row.label, `Health · ${yesterday} · Apple Health`);
  assert.match(row.ciphertext, /^enc:v1:/);
  assert.ok(!/kcal|caffeine|Calm|1950/.test(row.ciphertext), "sealed at rest");

  // ---- on the Day: the brief's figures, the body line untouched ----
  let day = (await getDay(yesterday, { tz: "Europe/London" }))!;
  const h = day.health as unknown as Record<string, unknown> & Parameters<typeof H.foodLine>[0] & { line: string | null };
  assert.deepEqual(
    [h.kcal, h.caffeine_mg, h.caffeine_last, h.caffeine_after_14_mg, h.alcohol_drinks, h.water_ml, h.mindful_minutes, h.last_meal, h.mood_valence, h.mood_labels],
    [1950, 285, "15:40", 95, 2, 1800, 10, "20:15", 0.4, ["Calm", "Grateful"]],
  );
  assert.equal(H.foodLine(h), "1,950 kcal · 3 coffees, last 15:40 · 2 drinks · 1.8 L water · 10 min mindful");
  assert.equal(day.health!.line, null, "no body figures, no body line");
  // Ask without a health question doesn't open it at all.
  assert.equal((await getDay(yesterday, { tz: "Europe/London", health: false }))!.health, undefined);

  // ---- Oura sends coffee tags and meditation; Apple Health wins until the owner picks Oura ----
  await H.saveHealthDay({ date: yesterday, source: "oura", caffeine_mg: 190, caffeine_last: "10:00", caffeine_after_14_mg: 0, mindful_minutes: 25 }, { tz: "Europe/London" });
  day = (await getDay(yesterday, { tz: "Europe/London" }))!;
  assert.deepEqual([(day.health as unknown as Record<string, unknown>).caffeine_mg, (day.health as unknown as Record<string, unknown>).mindful_minutes], [285, 10]);
  r = await call("PUT", "/health/sources", { nutrition: "oura", mind: "oura" }, "master-token-for-tests");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.prefs.nutrition, "oura");
  assert.equal((await call("PUT", "/health/sources", { nutrition: "strava" }, "master-token-for-tests")).status, 400);
  day = (await getDay(yesterday, { tz: "Europe/London" }))!;
  const o = day.health as unknown as Record<string, unknown>;
  assert.deepEqual([o.caffeine_mg, o.caffeine_last, o.mindful_minutes, o.kcal, o.mood_valence], [190, "10:00", 25, 1950, 0.4], "Oura's figures; Apple Health fills what Oura lacks");
  await call("PUT", "/health/sources", { nutrition: "apple_health", mind: "apple_health" }, "master-token-for-tests");

  // ---- the chart ----
  r = await call("GET", `/health/series?field=kcal&from=${addDays(today, -6)}&to=${today}`, undefined, "master-token-for-tests");
  assert.deepEqual(r.json.points, [{ day: yesterday, value: 1950 }]);
  assert.equal((await call("GET", `/health/series?field=kcal`, undefined, capture)).status, 401);

  // ---- State of Mind: fills a blank day for Patterns, never the owner's own, and never writes the day ----
  await call("POST", "/health/day", { date: before, mood_valence: -0.8 }, capture);
  await patchDay(yesterday, { mood: 2 }, { tz: "Europe/London" });
  const pd = await loadPatternDays(before, yesterday, "Europe/London");
  assert.equal(pd.find((d) => d.date === yesterday)!.mood, 2, "the owner's mood wins");
  assert.equal(pd.find((d) => d.date === before)!.mood, 1, "State of Mind fills a blank day");
  assert.equal((await getDay(before, { tz: "Europe/London" }))!.mood, undefined, "Health's mood is never stored as the owner's");
  const y = pd.find((d) => d.date === yesterday)!;
  assert.deepEqual([y.caffeine_late_mg, y.drinks, y.water_ml, y.mindful_minutes, y.last_meal], [95, 2, 1800, 10, 20.25]);
});
