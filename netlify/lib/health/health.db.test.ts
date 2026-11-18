// Real path for health: the real /api function (capture key, the Shortcut's POST, the chart), the runner's athena_health_day
// and Life log save (AthenaWriter), and Postgres with every migration applied (0028 included).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/health/health.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector, Life log and health rows first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
const KEY = "22".repeat(32);
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = KEY;
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Health: sealed by the Shortcut and the tool, charted, one line on each Day, never a note", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { AthenaWriter } = await import("../connectors/runner");
  const { qRaw, archiveEntity, getNote } = await import("../../../lib/db");
  const { createApiKey } = await import("../../../lib/api-keys");
  const { zonedToday, addDays } = await import("../../../lib/dates");
  const H = await import("../../../lib/health");
  const { getDay } = await import("../../../lib/days");
  const lineOn = async (date: string) => (await getDay(date, { tz: "Europe/London" }))!.health?.line ?? null;
  const notes = async () => (await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM notes`))[0].n;

  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const now = new Date();
  const today = zonedToday(now, "Europe/London");
  const yesterday = addDays(today, -1);
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const routes = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return JSON.parse(await res.text());
  };

  const { token: capture } = await createApiKey("iPhone", "capture");
  const shortcut = { steps: "9,200", sleep_minutes: 460, resting_hr: 52 };

  // ---- the Shortcut: a capture key, and nothing else, opens it ----
  assert.equal((await call("POST", "/health/day", shortcut)).status, 401);
  assert.equal((await call("POST", "/health/day", shortcut, "athc_" + "x".repeat(43))).status, 401);
  for (const bad of [{ step: 9000 }, { steps: "lots" }, { date: addDays(today, 1), steps: 1 }, { resting_hr: 400 }, {}]) {
    assert.equal((await call("POST", "/health/day", bad, capture)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await qRaw(`SELECT 1 FROM sensitive_blobs WHERE domain = 'health'`)).length, 0, "nothing written by a refused request");

  // No Life log needed: the day gets its line from the sealed row, and no note is written (Days, lib/days.ts).
  const before = await notes();
  let r = await call("POST", "/health/day", shortcut, capture);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.date, yesterday);
  assert.equal(r.json.source, "apple_health");
  assert.equal(r.json.created, true);
  assert.equal(r.json.life_log, "written");
  assert.equal(await lineOn(yesterday), "7h 40m sleep · 9,200 steps · 52 bpm resting");
  assert.equal(await notes(), before, "no note");
  assert.match(r.json.message, /^Saved health for \w+day \d+ \w+\.$/);
  assert.ok(!/9,?200|460|52/.test(r.text.replace(yesterday, "")), "the answer carries no figures");

  // Sealed at rest: the label names the day and source only, and the database refuses plaintext.
  const [row] = await qRaw<{ label: string; ciphertext: string; source: string }>(`SELECT label, ciphertext, source FROM sensitive_blobs WHERE domain = 'health'`);
  assert.equal(row.label, `Health · ${yesterday} · Apple Health`);
  assert.match(row.ciphertext, /^enc:v1:/);
  assert.ok(!row.ciphertext.includes("9200") && !row.ciphertext.includes("steps"));
  await assert.rejects(
    qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, day, source) VALUES ('health', 'x', '{"steps":1}', $1::date, 'oura')`, [yesterday]),
  );
  assert.equal((await qRaw(`SELECT 1 FROM sensitive_blobs WHERE source = 'oura'`)).length, 0, "plaintext refused by the database");

  // Same again: nothing changes.
  r = await call("POST", "/health/day", shortcut, capture);
  assert.equal(r.json.changed, false);
  assert.equal((await qRaw(`SELECT 1 FROM sensitive_blobs WHERE domain = 'health'`)).length, 1);
  // The Shortcut's workout, as its Format Date step sends the start.
  r = await call("POST", "/health/day", { workouts: [{ type: "Running", minutes: 28, start: "07:02" }] }, capture);
  assert.equal(r.json.changed, true);

  // ---- a Life log, and Strava through the runner's tool ----
  const yt = await routes("POST", "/connectors", { provider: "youtube", name: "YouTube", account_label: "personal", client_id: "1-yt.apps.googleusercontent.com", client_secret: "GOCSPX-yt" });
  const life = await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [yt.id], schedule: "daily", run_at: "23:30" });
  const C = await import("../../../lib/connectors");
  const collection = (await C.getCollection(life.id))!;
  const writer = new AthenaWriter(collection, "00000000-0000-0000-0000-000000000000", { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0 } as never, now, "Europe/London");
  assert.ok(!writer.tools.some((t) => t.name === "athena_health_day"), "only offered with a health account");
  writer.healthSources = ["strava"];
  assert.ok(writer.tools.some((t) => t.name === "athena_health_day"));
  const run = { date: yesterday, source: "strava", workouts: [{ type: "Run", minutes: 27, distance_m: 5000, kcal: 380, start: "07:04", name: "Hill reps", elevation_m: 84, route: "_p~iF~ps|U_ulLnnqC" }] };
  const saved = await writer.run("athena_health_day", run);
  assert.deepEqual(JSON.parse(saved), { saved: true, date: yesterday, source: "strava", changed: true });
  await assert.rejects(writer.run("athena_health_day", { ...run, source: "oura" }), /doesn't read oura/);
  await assert.rejects(writer.run("athena_health_day", { date: yesterday, source: "strava", steps: 1, step: 2 }), /Unknown field step/);

  // The day's line: one run merged from both sources, read from the sealed rows; still no note.
  const LINE = "7h 40m sleep · 9,200 steps · “Hill reps” 5k run, 84 m up · 52 bpm resting";
  assert.equal(await lineOn(yesterday), LINE);
  assert.equal(await notes(), before);
  assert.ok((await getDay(yesterday, { tz: "Europe/London" }))!.entries.some((e) => e.kind === "workout" && e.title === "Hill reps"), "Strava's run is the day's workout");

  // ---- a chart reads it back: the app's token, never a capture key ----
  assert.equal((await call("GET", "/health/series?field=steps", undefined, capture)).status, 401);
  r = await call("GET", `/health/series?field=steps&from=${addDays(today, -6)}&to=${today}`, undefined, "master-token-for-tests");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.points, [{ day: yesterday, value: 9200 }]);
  r = await call("GET", `/health/series?field=workout_minutes`, undefined, "master-token-for-tests");
  assert.deepEqual(r.json.points, [{ day: yesterday, value: 28 }], "Apple Health's minutes, not 28 + 27");
  assert.equal((await call("GET", `/health/series?field=mood`, undefined, "master-token-for-tests")).status, 400);

  // ---- a Life log run writes the day's entries: health stays out of them ----
  await writer.run("athena_day_entry", { date: yesterday, entries: [{ kind: "watched", source: "trakt", external_id: "h-1", title: "Severance", subtitle: "S2E3 · Who Is Alive?" }] });
  const plain = (await getDay(yesterday, { tz: "Europe/London", health: false, places: false }))!;
  assert.deepEqual(plain.entries.map((e) => e.title), ["Severance"], "what Ask sees by default: no health, no workouts");
  assert.equal(plain.health, undefined);
  assert.equal(await lineOn(yesterday), LINE);

  // ---- weight on the day of a weigh-in, and the owner's choice of source ----
  await H.saveHealthDay({ date: yesterday, source: "withings", weight_kg: 72.4, steps: 11000 }, { now, tz: "Europe/London" });
  await H.saveHealthDay({ date: yesterday, source: "oura", sleep_minutes: 430, resting_hr: 50 }, { now, tz: "Europe/London" });
  assert.equal(await lineOn(yesterday), "7h 10m sleep · 9,200 steps · “Hill reps” 5k run, 84 m up · 50 bpm resting · 72.4 kg", "Oura's sleep and Withings' weight by default");
  assert.equal((await call("GET", "/health/sources", undefined, capture)).status, 401);
  r = await call("GET", "/health/sources", undefined, "master-token-for-tests");
  assert.deepEqual(r.json.prefs, { sleep: "oura", steps: "apple_health", weight: "withings", workouts: "apple_health", nutrition: "apple_health", mind: "apple_health" });
  assert.deepEqual(r.json.connected, ["apple_health", "strava", "oura", "withings"]);
  assert.equal((await call("PUT", "/health/sources", { sleep: "strava" }, "master-token-for-tests")).status, 400);
  r = await call("PUT", "/health/sources", { sleep: "apple_health", steps: "withings" }, "master-token-for-tests");
  assert.equal(r.status, 200, r.text);
  assert.equal(await lineOn(yesterday), "7h 40m sleep · 11,000 steps · “Hill reps” 5k run, 84 m up · 52 bpm resting · 72.4 kg", "read from the new sources, never added");
  r = await call("GET", `/health/days?from=${addDays(today, -6)}&to=${today}`, undefined, "master-token-for-tests");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.days.length, 1);
  assert.equal(r.json.days[0].steps, 11000);
  assert.equal(r.json.days[0].workouts[0].route, "_p~iF~ps|U_ulLnnqC");
  await call("PUT", "/health/sources", { sleep: "oura", steps: "apple_health" }, "master-token-for-tests");
  await H.saveHealthDay({ date: yesterday, source: "oura", sleep_minutes: 460, resting_hr: 52 }, { now, tz: "Europe/London" });
  await H.saveHealthDay({ date: yesterday, source: "withings", weight_kg: 72.4 }, { now, tz: "Europe/London" });
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = 'withings'`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'health' AND source = 'oura'`);

  // A day the run writes first gets the line too, once the Shortcut sends it.
  await writer.run("athena_day_entry", { date: addDays(today, -2), entries: [{ kind: "watched", source: "trakt", external_id: "h-2", title: "Slow Horses", subtitle: "S4E1" }] });
  r = await call("POST", "/health/day", { date: addDays(today, -2), steps: 4100 }, capture);
  assert.equal(r.json.life_log, "written");
  assert.equal(await lineOn(addDays(today, -2)), "4,100 steps", "no weigh-in, no weight");

  // ---- no key here (a deploy preview): refused, never stored readable ----
  delete process.env.ATHENA_DATA_KEY;
  r = await call("POST", "/health/day", { steps: 1 }, capture);
  assert.equal(r.status, 503);
  process.env.ATHENA_DATA_KEY = KEY;

  // ---- a key rotation re-seals health days ----
  process.env.ATHENA_DATA_KEY_PREVIOUS = KEY;
  process.env.ATHENA_DATA_KEY = "33".repeat(32);
  const re = await H.resealHealth();
  assert.equal(re.failed, 0);
  assert.ok(re.resealed >= 3);
  delete process.env.ATHENA_DATA_KEY_PREVIOUS;
  assert.deepEqual((await H.healthSeries("steps", yesterday, yesterday)).points, [{ day: yesterday, value: 9200 }]);
  process.env.ATHENA_DATA_KEY = KEY;
});
