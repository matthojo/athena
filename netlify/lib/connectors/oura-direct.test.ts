// Run: npx tsx --test netlify/lib/connectors/oura-direct.test.ts
// Oura over API v2, with fetch stubbed and recorded replies (shapes as api.ouraring.com returned them, trimmed; figures made up).
import { afterEach, beforeEach, test } from "node:test";
import { readHealthDay } from "../../../lib/health";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { daysOf, openOura, ouraAdapter, ouraAuthorizationUrl, tagKind } from "./oura-direct";

type Reply = { status?: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];
const realSave = lifeTokenStore.save;
let saved: ConnectorSecrets[] = [];

beforeEach(() => {
  calls = [];
  routes = [];
  saved = [];
  lifeRetryWaits.ms = [1, 1];
  lifeTokenStore.save = async (_id, mutate) => {
    const s: ConnectorSecrets = { tokens: { refresh_token: "r1" } };
    mutate(s);
    saved.push(s);
  };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lifeTokenStore.save = realSave;
});

const C = "/v2/usercollection";
const connector = { id: "c3", name: "Oura", provider: "oura", auth_type: "oauth", url: "https://api.ouraring.com/v2", scope: "" } as Connector;
const secrets = (fresh = true): ConnectorSecrets => ({
  tokens: { access_token: "a1", refresh_token: "r1", expires_in: 86400, obtained_at: fresh ? Date.now() : Date.now() - 2 * 86400_000 },
  ownClient: { client_id: "cid", client_secret: "cs" },
});
/** Oura's paging: filter by start_date/end_date, then one document a page with next_token. */
function docs(all: Array<{ day: string }>) {
  return (url: URL) => {
    const from = url.searchParams.get("start_date")!;
    const to = url.searchParams.get("end_date")!;
    const inRange = all.filter((d) => d.day >= from && d.day <= to);
    const i = Number(url.searchParams.get("next_token") ?? 0);
    return { data: inRange.slice(i, i + 1), next_token: i + 1 < inRange.length ? String(i + 1) : null };
  };
}
const route = (p: string, all: Array<{ day: string }>) => (url: URL) => (url.pathname === `${C}/${p}` ? { body: docs(all)(url) } : undefined);

const READINESS = [
  { id: "r1", day: "2026-11-05", score: 81, temperature_deviation: -0.12, timestamp: "2026-11-05T00:00:00+00:00", contributors: {} },
  { id: "r2", day: "2026-11-06", score: 74, temperature_deviation: 0.31, timestamp: "2026-11-06T00:00:00+00:00", contributors: {} },
];
const DAILY_SLEEP = [{ id: "d1", day: "2026-11-06", score: 82, contributors: {}, timestamp: "2026-11-06T00:00:00+00:00" }];
const SLEEP = [
  {
    id: "s1",
    day: "2026-11-06",
    type: "long_sleep",
    bedtime_start: "2026-11-05T23:14:00+00:00",
    bedtime_end: "2026-11-06T07:02:00+00:00",
    time_in_bed: 28080,
    total_sleep_duration: 25260,
    efficiency: 90,
    deep_sleep_duration: 5400,
    rem_sleep_duration: 6000,
    light_sleep_duration: 13860,
    awake_time: 2820,
    lowest_heart_rate: 52,
    average_heart_rate: 58.25,
    average_hrv: 41,
    period: 0,
  },
  { id: "s2", day: "2026-11-06", type: "sleep", bedtime_start: "2026-11-06T14:00:00+00:00", bedtime_end: "2026-11-06T14:40:00+00:00", time_in_bed: 2400, total_sleep_duration: 1800, efficiency: 75, lowest_heart_rate: 60, period: 1 },
  { id: "s3", day: "2026-11-06", type: "rest", total_sleep_duration: 9000, period: 2 },
];
const ACTIVITY = [{ id: "a1", day: "2026-11-06", steps: 9876, active_calories: 512, total_calories: 2450, high_activity_time: 1200, medium_activity_time: 2400, low_activity_time: 10800, score: 88, equivalent_walking_distance: 9100 }];
const WORKOUTS = [{ id: "w1", day: "2026-11-06", activity: "cycling", calories: 410.5, distance: 18000, start_datetime: "2026-11-06T17:00:00+00:00", end_datetime: "2026-11-06T17:55:00+00:00", intensity: "moderate", source: "autodetected", label: null }];
// Sessions and enhanced tags, as /v2/usercollection/session and /enhanced_tag document them (trimmed; heart rate series left out).
const SESSIONS = [
  { id: "m1", day: "2026-11-06", start_datetime: "2026-11-06T07:30:00+00:00", end_datetime: "2026-11-06T07:40:00+00:00", type: "meditation", mood: "good", heart_rate: null, heart_rate_variability: null, motion_count: null },
  { id: "m2", day: "2026-11-06", start_datetime: "2026-11-06T22:00:00+00:00", end_datetime: "2026-11-06T22:05:00+00:00", type: "breathing", mood: null },
  { id: "m3", day: "2026-11-06", start_datetime: "2026-11-06T14:00:00+00:00", end_datetime: "2026-11-06T14:30:00+00:00", type: "nap", mood: null },
];
const TAGS = [
  { id: "t1", tag_type_code: "tag_generic_caffeine", start_time: "2026-11-06T08:10:00+00:00", end_time: null, start_day: "2026-11-06", end_day: null, comment: null, custom_name: null },
  { id: "t2", tag_type_code: "tag_generic_caffeine", start_time: "2026-11-06T15:40:00+00:00", end_time: null, start_day: "2026-11-06", end_day: null, comment: "flat white", custom_name: null },
  { id: "t3", tag_type_code: "tag_generic_alcohol", start_time: "2026-11-06T20:00:00+00:00", end_time: null, start_day: "2026-11-06", end_day: null, comment: null, custom_name: null },
  { id: "t4", tag_type_code: "tag_generic_alcohol", start_time: "2026-11-06T21:00:00+00:00", end_time: null, start_day: "2026-11-06", end_day: null, comment: null, custom_name: null },
  // A custom tag and a "no caffeine" tag count as nothing.
  { id: "t5", tag_type_code: "custom", start_time: "2026-11-06T12:00:00+00:00", start_day: "2026-11-06", custom_name: "Matcha" },
  { id: "t6", tag_type_code: "tag_generic_nocaffeine", start_time: "2026-11-05T09:00:00+00:00", start_day: "2026-11-05" },
];
const tagRoute = (url: URL) => {
  if (url.pathname !== `${C}/enhanced_tag`) return undefined;
  const from = url.searchParams.get("start_date")!;
  const to = url.searchParams.get("end_date")!;
  return { body: { data: TAGS.filter((t) => t.start_day >= from && t.start_day <= to), next_token: null } };
};
const ALL = [route("daily_readiness", READINESS), route("daily_sleep", DAILY_SLEEP), route("sleep", SLEEP), route("daily_activity", ACTIVITY), route("workout", WORKOUTS), route("session", SESSIONS), tagRoute];

test("presets: Oura sits in Health, reads only, says figures are sealed", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "oura")!;
  assert.equal(p.category, "health");
  assert.equal(p.scope, "daily workout session tag");
  assert.match(p.help, /encrypts the figures/);
  for (const t of ouraAdapter.tools(connector)) assert.equal(classifyTool("oura", t.name, t.annotations), "read");
  assert.equal(directFor(connector), ouraAdapter);
});

test("sign-in uses PKCE and the read scopes", () => {
  const url = new URL(ouraAuthorizationUrl({ clientId: "cid", redirectUri: "https://athena.example/cb", scope: "daily workout", state: "s", challenge: "ch" }));
  assert.equal(url.host, "cloud.ouraring.com");
  // An account saved with the old scope asks for sessions and tags when it signs in again.
  assert.equal(url.searchParams.get("scope"), "daily workout session tag");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("windows: a date is one day; after/before are whole local days; no window is the last 7", () => {
  assert.deepEqual(daysOf({ date: "2026-11-06" }, "Europe/London"), { from: "2026-11-06", to: "2026-11-06" });
  assert.deepEqual(daysOf({ after: "2026-11-01", before: "2026-11-07" }, "Europe/London"), { from: "2026-11-01", to: "2026-11-06" });
  const last = daysOf({}, "UTC");
  assert.equal((Date.parse(last.to) - Date.parse(last.from)) / 86400_000, 6);
  assert.throws(() => daysOf({ after: "2026-01-01", before: "2026-11-01" }, "UTC"), /62 days/);
});

test("daily_sleep: the night belongs to the morning it ends; naps counted, rest ignored; local times; User-Agent sent", async () => {
  routes = ALL;
  const acct = await openOura(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("daily_sleep", { date: "2026-11-06" })).text);
  assert.deepEqual(out.items, [
    {
      date: "2026-11-06",
      score: 82,
      total_minutes: 421,
      in_bed_minutes: 468,
      efficiency: 90,
      deep_minutes: 90,
      rem_minutes: 100,
      light_minutes: 231,
      awake_minutes: 47,
      resting_hr: 52,
      average_hr: 58.3,
      average_hrv: 41,
      bedtime: "23:14",
      wake_time: "07:02",
      naps: 1,
      nap_minutes: 30,
    },
  ]);
  // end_date goes a day late; results are kept to the asked day.
  const req = calls.find((c) => c.url.pathname === `${C}/sleep`)!.url;
  assert.equal(req.searchParams.get("start_date"), "2026-11-06");
  assert.equal(req.searchParams.get("end_date"), "2026-11-07");
  assert.ok(calls.every((c) => c.init.method === "GET" && new Headers(c.init.headers).get("user-agent")?.startsWith("Athena/")));
});

test("paging: next_token followed; days paged newest first with a cursor", async () => {
  routes = ALL;
  const acct = await openOura(connector, secrets(), "UTC");
  const out = JSON.parse((await acct.call("daily_readiness", { after: "2026-11-05", before: "2026-11-07" })).text);
  assert.deepEqual(out.items, [
    { date: "2026-11-06", score: 74, temperature_deviation: 0.31 },
    { date: "2026-11-05", score: 81, temperature_deviation: -0.12 },
  ]);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("daily_readiness") && c.url.searchParams.get("next_token") === "1").length, 1, "followed next_token");
  const one = JSON.parse((await acct.call("daily_readiness", { after: "2026-11-05", before: "2026-11-07", limit: 1 })).text);
  assert.deepEqual(one.items.map((i: { date: string }) => i.date), ["2026-11-06"]);
  const rest = JSON.parse((await acct.call("daily_readiness", { after: "2026-11-05", before: "2026-11-07", limit: 1, cursor: one.next_cursor })).text);
  assert.deepEqual(rest.items.map((i: { date: string }) => i.date), ["2026-11-05"]);
  assert.equal(rest.next_cursor, undefined);
});

test("daily_activity and workouts", async () => {
  routes = ALL;
  const acct = await openOura(connector, secrets(), "Europe/London");
  const act = JSON.parse((await acct.call("daily_activity", { date: "2026-11-06" })).text);
  assert.deepEqual(act.items[0], { date: "2026-11-06", steps: 9876, active_calories: 512, total_calories: 2450, active_minutes: 60, high_minutes: 20, medium_minutes: 40, low_minutes: 180, walking_distance_m: 9100, score: 88 });
  const w = JSON.parse((await acct.call("workouts", { date: "2026-11-06" })).text);
  assert.deepEqual(w.items[0], { date: "2026-11-06", time: "17:00", type: "cycling", minutes: 55, distance_m: 18000, kcal: 411, intensity: "moderate", source: "autodetected" });
  const empty = JSON.parse((await acct.call("workouts", { date: "2026-11-01" })).text);
  assert.deepEqual(empty.items, []);
});

test("day_summary: the day in athena_health_day's shape", async () => {
  routes = ALL;
  const out = JSON.parse((await (await openOura(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-11-06" })).text);
  assert.deepEqual(out, { date: "2026-11-06", source: "oura", sleep_minutes: 421, sleep_stages: { deep: 90, core: 231, rem: 100, awake: 47, in_bed: 468 }, steps: 9876, active_minutes: 60, resting_hr: 52, mindful_minutes: 15, caffeine_mg: 190, caffeine_last: "15:40", caffeine_after_14_mg: 95, alcohol_drinks: 2, workouts: [{ type: "cycling", minutes: 55, distance_m: 18000, kcal: 411, start: "17:00" }] });
  // Through the contract as it is: the food and mind figures pass too.
  const read = readHealthDay(out, { today: "2026-11-07" });
  assert.deepEqual([read.mindful_minutes, read.caffeine_mg, read.caffeine_last, read.caffeine_after_14_mg, read.alcohol_drinks], [15, 190, "15:40", 95, 2]);
  // Oura's light sleep is Apple's core; the breakdown passes through the contract as it is.
  assert.deepEqual(readHealthDay(out, { today: "2026-11-07" }).sleep_stages, out.sleep_stages);
  const none = JSON.parse((await (await openOura(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-10-01" })).text);
  assert.deepEqual(none, { date: "2026-10-01", source: "oura", workouts: [] });
});

test("token refresh: Basic auth, single-use refresh token rotated and saved once", async () => {
  routes = [at("/oauth/token", { token_type: "bearer", access_token: "a2", refresh_token: "r2", expires_in: 86400 }), ...ALL];
  const s = secrets(false);
  await openOura(connector, s, "UTC");
  const token = calls[0];
  assert.equal(token.url.pathname, "/oauth/token");
  assert.equal(new Headers(token.init.headers).get("authorization"), `Basic ${Buffer.from("cid:cs").toString("base64")}`);
  assert.equal(new URLSearchParams(String(token.init.body)).get("refresh_token"), "r1");
  assert.equal(saved.length, 1);
  assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "r2");
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer a2");
});

test("401 renews once then is needs_auth; 403 (membership) is needs_auth; 429 is a passing error", async () => {
  routes = [at(`${C}/daily_readiness`, { status: 401, title: "Invalid Access token" }, 401), at("/oauth/token", { error: "invalid_grant" }, 400)];
  const e401 = await openOura(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(e401), { status: "needs_auth", detail: "Sign in again" });

  routes = [at(`${C}/daily_readiness`, { status: 401 }, 401), at("/oauth/token", { access_token: "a2", refresh_token: "r2", expires_in: 86400 })];
  const again = await openOura(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(again), { status: "needs_auth", detail: "Oura didn't accept the sign-in. Sign in again" });

  routes = [at(`${C}/daily_readiness`, { status: 403, title: "Forbidden" }, 403)];
  const e403 = await openOura(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(e403), { status: "needs_auth", detail: "Oura stopped sharing your data. Check your Oura Membership is active, then sign in again." });

  routes = [at(`${C}/daily_readiness`, { status: 429 }, 429)];
  const e429 = await openOura(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(directFailure(e429)?.status, "error");
});

function at(p: string, body: unknown, status = 200) {
  return (url: URL) => (url.pathname === p ? { status, body } : undefined);
}

test("sessions and tags: mindful sessions marked, tags counted only by Oura's own codes", async () => {
  routes = ALL;
  const acct = await openOura(connector, secrets(), "Europe/London");
  const sess = JSON.parse((await acct.call("sessions", { date: "2026-11-06" })).text);
  assert.deepEqual(sess.items, [
    { date: "2026-11-06", time: "22:00", type: "breathing", minutes: 5, mindful: true },
    { date: "2026-11-06", time: "14:00", type: "nap", minutes: 30 },
    { date: "2026-11-06", time: "07:30", type: "meditation", minutes: 10, mindful: true, mood: "good" },
  ]);
  const tags = JSON.parse((await acct.call("tags", { after: "2026-11-05", before: "2026-11-07" })).text);
  assert.deepEqual(
    tags.items.map((t: Record<string, unknown>) => [t.time, t.counts_as ?? null, t.name ?? null]),
    [["21:00", "alcohol", null], ["20:00", "alcohol", null], ["15:40", "caffeine", null], ["12:00", null, "Matcha"], ["08:10", "caffeine", null], ["09:00", null, null]],
  );
  // A tag's comment is the owner's words: never passed on.
  assert.ok(!JSON.stringify(tags).includes("flat white"));
});

test("sessions and tags: a sign-in from before these permissions says to sign in again; day_summary still works", async () => {
  routes = [at(`${C}/session`, { status: 403, title: "Missing scopes" }, 403), at(`${C}/enhanced_tag`, { status: 403 }, 403), ...ALL];
  const acct = await openOura(connector, secrets(), "Europe/London");
  await assert.rejects(acct.call("sessions", { date: "2026-11-06" }), /Sign in to Oura again and allow sessions/);
  await assert.rejects(acct.call("tags", { date: "2026-11-06" }), /allow tags/);
  const out = JSON.parse((await acct.call("day_summary", { date: "2026-11-06" })).text);
  assert.equal(out.steps, 9876);
  assert.equal(out.mindful_minutes, undefined);
  assert.equal(out.caffeine_mg, undefined);
});

test("tag codes: only a plainly named caffeine or alcohol code counts", () => {
  const k = (code: string | null) => tagKind({ tag_type_code: code });
  assert.deepEqual(["tag_generic_caffeine", "tag_generic_coffee", "tag_caffeine", "caffeine"].map(k), ["caffeine", "caffeine", "caffeine", "caffeine"]);
  assert.deepEqual(["tag_generic_alcohol", "tag_alcohol", "tag_generic_wine"].map(k), ["alcohol", "alcohol", "alcohol"]);
  assert.deepEqual(["tag_generic_nocaffeine", "tag_generic_no_caffeine", "tag_alcohol_free", "tag_generic_no_alcohol", "custom", null, "tag_generic_late_meal", "tag_generic_caffeine_sensitivity"].map(k), [null, null, null, null, null, null, null, null]);
});
