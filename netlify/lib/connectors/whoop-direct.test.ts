// Run: npx tsx --test netlify/lib/connectors/whoop-direct.test.ts
// Whoop over API v2, with fetch stubbed and recorded replies (shapes as api.prod.whoop.com returned them, trimmed; figures made up).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { mergeSources, readHealthDay, healthLine, CAN_SEND, readPrefs, isHealthLine as H_isLine, withoutHealth as withoutHealthText } from "../../../lib/health";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { exchangeWhoopCode, openWhoop, whoopAdapter, whoopAuthorizationUrl } from "./whoop-direct";

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

const API = "/developer/v2";
const at = (p: string, body: unknown, status = 200) => (url: URL) => (url.pathname === `${API}${p}` || url.pathname === p ? { status, body } : undefined);
const connector = { id: "c1", name: "Whoop", provider: "whoop", auth_type: "oauth", url: "https://api.prod.whoop.com/developer/v2", scope: "" } as Connector;
const secrets = (fresh = true): ConnectorSecrets => ({
  tokens: { access_token: "a1", refresh_token: "r1", expires_in: 3600, obtained_at: fresh ? Date.now() : Date.now() - 2 * 3600_000 },
  ownClient: { client_id: "wc", client_secret: "ws" },
});
const page = (records: unknown[], next_token: string | null = null) => ({ records, next_token });

// Night ending Friday 6 November, 06:52 London; a nap that afternoon.
const NIGHT = {
  id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
  cycle_id: 93845,
  user_id: 10129,
  start: "2026-11-05T22:48:01.000Z",
  end: "2026-11-06T06:52:12.000Z",
  timezone_offset: "+00:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 29051000,
      total_awake_time_milli: 2051000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 14105000,
      total_slow_wave_sleep_time_milli: 6630000,
      total_rem_sleep_time_milli: 6265000,
      sleep_cycle_count: 4,
      disturbance_count: 9,
    },
    respiratory_rate: 15.62,
    sleep_performance_percentage: 91,
    sleep_consistency_percentage: 82,
    sleep_efficiency_percentage: 92.94,
  },
};
const NAP = { ...NIGHT, id: "1b1d8c4e-0000-4000-8000-000000000001", start: "2026-11-06T13:10:00.000Z", end: "2026-11-06T13:40:00.000Z", nap: true, score: { stage_summary: { total_light_sleep_time_milli: 1500000 } } };
const EARLIER = { ...NIGHT, id: "aa000000-0000-4000-8000-000000000002", start: "2026-11-04T23:00:00.000Z", end: "2026-11-05T07:00:00.000Z" };
const RECOVERY = { cycle_id: 93845, sleep_id: NIGHT.id, user_id: 10129, score_state: "SCORED", score: { user_calibrating: false, recovery_score: 68, resting_heart_rate: 51.4, hrv_rmssd_milli: 61.82, spo2_percentage: 96.2, skin_temp_celsius: 33.7 } };
const RUN = {
  id: "ecfc6a15-4661-442f-a9a4-f160dd7af111",
  user_id: 10129,
  start: "2026-11-06T07:31:20.000Z",
  end: "2026-11-06T08:14:05.000Z",
  timezone_offset: "+00:00",
  sport_name: "running",
  score_state: "SCORED",
  score: { strain: 11.84, average_heart_rate: 148, max_heart_rate: 171, kilojoule: 2343.9, percent_recorded: 100, distance_meter: 8034.2, altitude_gain_meter: 41.3, altitude_change_meter: 2 },
};
const LIFT = { ...RUN, id: "ecfc6a15-4661-442f-a9a4-f160dd7af222", start: "2026-11-06T17:30:00.000Z", end: "2026-11-06T18:15:00.000Z", sport_name: "weightlifting", score: { strain: 8.1, kilojoule: 1046 } };

test("presets: Whoop sits in Health, reads only, says figures are sealed, and is reached directly", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "whoop")!;
  assert.equal(p.category, "health");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.equal(p.scope, "read:sleep read:workout read:recovery read:cycles offline");
  assert.match(p.help, /encrypts the figures/);
  for (const t of whoopAdapter.tools(connector)) assert.equal(classifyTool("whoop", t.name, t.annotations), "read");
  assert.equal(directFor(connector), whoopAdapter);
  assert.equal(directApi(connector), true);
  assert.ok(CAN_SEND.sleep.includes("whoop") && CAN_SEND.workouts.includes("whoop"));
  assert.equal(readPrefs({ sleep: "whoop" }).sleep, "whoop");
  assert.equal(readPrefs({ weight: "whoop" }).weight, "withings", "Whoop can't be chosen for weight");
});

test("sign-in: space scopes with offline, no PKCE; the code exchange sends the client in the form", async () => {
  const url = new URL(whoopAuthorizationUrl({ clientId: "wc", redirectUri: "https://athena.example/cb", scope: "", state: "x".repeat(43) }));
  assert.equal(url.origin + url.pathname, "https://api.prod.whoop.com/oauth/oauth2/auth");
  assert.equal(url.searchParams.get("scope"), "read:sleep read:workout read:recovery read:cycles offline");
  assert.equal(url.searchParams.get("code_challenge"), null);
  routes = [at("/oauth/oauth2/token", { access_token: "a9", refresh_token: "r9", expires_in: 3600, scope: "offline read:sleep", token_type: "bearer" })];
  const t = await exchangeWhoopCode({ code: "c", redirectUri: "https://athena.example/cb", client: { client_id: "wc", client_secret: "ws" } });
  assert.equal(t.access_token, "a9");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("client_secret"), "ws");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("redirect_uri"), "https://athena.example/cb");
  // Without offline WHOOP gives no refresh token: say so at sign-in, not an hour later.
  routes = [at("/oauth/oauth2/token", { access_token: "a9", expires_in: 3600 })];
  const error = await exchangeWhoopCode({ code: "c", redirectUri: "r", client: { client_id: "wc", client_secret: "ws" } }).catch((e) => e);
  assert.equal(directFailure(error)?.status, "needs_auth");
});

test("sleep: each night on the morning it ends, joined to its recovery; the window is local", async () => {
  routes = [at("/recovery", page([RECOVERY])), at("/activity/sleep", page([NAP, NIGHT, EARLIER]))];
  const acct = await openWhoop(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("sleep", { date: "2026-11-06" })).text);
  assert.equal(out.items.length, 2, "the night and the nap; the 5th's night is left out");
  const night = out.items.find((i: { nap?: boolean }) => !i.nap);
  assert.equal(night.date, "2026-11-06");
  assert.equal(night.total_minutes, 450);
  assert.equal(night.in_bed_minutes, 484);
  assert.equal(night.performance, 91);
  assert.equal(night.recovery, 68);
  assert.equal(night.resting_hr, 51);
  assert.equal(night.hrv_ms, 62);
  assert.equal(night.bedtime, "22:48");
  assert.equal(night.wake_time, "06:52");
  const sleepCall = calls.find((c) => c.url.pathname === `${API}/activity/sleep`)!.url;
  assert.equal(sleepCall.searchParams.get("start"), "2026-11-05T00:00:00.000Z", "a day early, so a night that started the evening before is found");
  assert.equal(sleepCall.searchParams.get("end"), "2026-11-07T00:00:00.000Z");
  assert.equal(sleepCall.searchParams.get("limit"), "25");
  assert.ok(calls.every((c) => (c.init.method ?? "GET") === "GET"));
});

test("paging: next_token is followed inside a call, and handed back as a cursor when the limit is reached", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...RUN, id: `w${i}`, start: new Date(Date.parse("2026-11-06T20:00:00Z") - i * 3600_000).toISOString(), end: new Date(Date.parse("2026-11-06T20:30:00Z") - i * 3600_000).toISOString() }));
  routes = [
    at("/recovery", page([])),
    (url) => (url.pathname === `${API}/activity/workout` ? { body: url.searchParams.get("nextToken") === "t2" ? page([LIFT]) : page(many, "t2") } : undefined),
  ];
  const acct = await openWhoop(connector, secrets(), "UTC");
  const first = JSON.parse((await acct.call("workouts", { after: "2026-11-01", before: "2026-11-07", limit: 26 })).text);
  assert.equal(first.items.length, 26, "two pages joined");
  assert.equal(first.next_cursor, undefined);
  const small = JSON.parse((await acct.call("workouts", { after: "2026-11-01", before: "2026-11-07", limit: 10 })).text);
  assert.equal(small.items.length, 10);
  assert.ok(small.next_cursor);
  calls = [];
  const second = JSON.parse((await acct.call("workouts", { after: "2026-11-01", before: "2026-11-07", cursor: small.next_cursor })).text);
  assert.equal(calls[0].url.searchParams.get("nextToken"), "t2");
  assert.equal(second.items[0].type, "weightlifting");
  assert.equal((await acct.call("workouts", { cursor: "nope" })).isError, true);
});

test("workouts: sport, start, minutes, strain, distance, climb and kcal from kilojoules", async () => {
  routes = [at("/recovery", page([])), at("/activity/workout", page([LIFT, RUN]))];
  const out = JSON.parse((await (await openWhoop(connector, secrets(), "Europe/London")).call("workouts", { date: "2026-11-06" })).text);
  assert.deepEqual(out.items[1], { date: "2026-11-06", time: "07:31", type: "running", minutes: 43, strain: 11.8, distance_m: 8034, elevation_m: 41, kcal: 560, average_hr: 148, max_hr: 171 });
});

test("day_summary: the day in athena_health_day's shape, accepted as it is", async () => {
  routes = [at("/recovery", page([RECOVERY])), at("/activity/sleep", page([NAP, NIGHT])), at("/activity/workout", page([LIFT, RUN]))];
  const out = JSON.parse((await (await openWhoop(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-11-06" })).text);
  assert.deepEqual(out, {
    date: "2026-11-06",
    source: "whoop",
    sleep_minutes: 450,
    sleep_stages: { deep: 111, core: 235, rem: 104, awake: 34, in_bed: 484 },
    resting_hr: 51,
    recovery: 68,
    workouts: [
      { type: "running", minutes: 43, distance_m: 8034, kcal: 560, start: "07:31", elevation_m: 41 },
      { type: "weightlifting", minutes: 45, kcal: 250, start: "17:30" },
    ],
  });
  const day = readHealthDay(out, { today: "2026-11-07" });
  assert.equal(day.source, "whoop");
  assert.equal(day.recovery, 68, "recovery is saved, not just read");
  assert.equal(day.workouts?.length, 2);
});

test("merging: Whoop's run and Apple Health's run are one workout; the line counts it once", () => {
  const apple = { source: "apple_health" as const, steps: 9200, workouts: [{ type: "HKWorkoutActivityTypeRunning", minutes: 44, distance_m: 8050, start: "07:30" }] };
  const whoop = { source: "whoop" as const, sleep_minutes: 450, resting_hr: 51, recovery: 68, workouts: [{ type: "running", minutes: 43, distance_m: 8034, kcal: 560, start: "07:31", elevation_m: 41 }, { type: "weightlifting", minutes: 45, start: "17:30" }] };
  const strava = { source: "strava" as const, workouts: [{ type: "run", minutes: 43, distance_m: 8040, start: "07:33", name: "Canal loop" }] };
  const m = mergeSources([apple, whoop, strava], readPrefs({ sleep: "whoop", workouts: "apple_health" }));
  assert.equal(m.workouts?.length, 2, "one run, not three");
  assert.equal(m.workouts![0].distance_m, 8050, "the chosen source's version");
  assert.equal(m.workouts![0].name, "Canal loop", "Strava's name filled in");
  assert.equal(m.workouts![0].elevation_m, 41, "Whoop's climb filled in");
  assert.equal(m.sleep_minutes, 450);
  assert.equal(healthLine(m), "7h 30m sleep · 9,200 steps · “Canal loop” 8.1k run, 41 m up · 45 min strength · 51 bpm resting · 68% recovery");
  assert.equal(H_isLine(healthLine(m)), true, "the note's Health line is still recognised");
  assert.equal(withoutHealthText(`Health 7h 30m sleep · 68% recovery`), "", "Ask doesn't see it unless asked about health");
  const whoopFirst = mergeSources([apple, whoop], readPrefs({ workouts: "whoop" }));
  assert.equal(whoopFirst.workouts?.length, 2);
  assert.equal(whoopFirst.workouts![0].distance_m, 8034);
});

test("token refresh: an expired token is renewed in the form with scope=offline, rotated, and saved once", async () => {
  routes = [
    at("/oauth/oauth2/token", { access_token: "a2", refresh_token: "r2", expires_in: 3600, token_type: "bearer" }),
    (url, init) => (url.pathname === `${API}/recovery` && new Headers(init.headers).get("authorization") === "Bearer a2" ? { body: page([]) } : undefined),
  ];
  const s = secrets(false);
  await openWhoop(connector, s, "UTC");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "r1");
  assert.equal(form.get("scope"), "offline");
  assert.equal(form.get("client_id"), "wc");
  assert.equal(saved.length, 1);
  assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "r2");
});

test("a 401 renews once; a second 401 is needs_auth, with no figures in the message", async () => {
  routes = [at("/recovery", { message: "Authorization was not valid" }, 401), at("/oauth/oauth2/token", { access_token: "a2", refresh_token: "r2", expires_in: 3600 })];
  const error = await openWhoop(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(calls.filter((c) => c.url.pathname === "/oauth/oauth2/token").length, 1);
  assert.deepEqual(directFailure(error), { status: "needs_auth", detail: "Whoop didn't accept the sign-in. Sign in again" });
  assert.equal(whoopAdapter.accountProblem(error), true);
});

test("a refused app, a missing scope and Whoop's limit each say what to do; errors carry no figures", async () => {
  routes = [at("/oauth/oauth2/token", { error: "invalid_client" }, 401)];
  const refused = await openWhoop(connector, secrets(false), "UTC").catch((e) => e);
  assert.equal(directFailure(refused)?.status, "needs_auth");
  assert.match(directFailure(refused)!.detail, /Client ID and Secret under Edit/);

  routes = [at("/recovery", page([])), at("/activity/sleep", { message: "scope" }, 403)];
  const acct = await openWhoop(connector, secrets(), "UTC");
  const scope = await acct.call("sleep", {}).catch((e) => e);
  assert.deepEqual(directFailure(scope), { status: "needs_auth", detail: "Whoop didn't let Athena read that. Sign in again and allow everything Athena asks for." });

  calls = [];
  routes = [at("/recovery", { message: "Too Many Requests" }, 429)];
  const limited = await openWhoop(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(limited), { status: "error", detail: "Whoop is limiting how often Athena can ask right now. Try again in a few minutes." });
  assert.equal(calls.length, 3, "429 retried twice");
  assert.doesNotMatch(JSON.stringify([directFailure(refused), directFailure(scope), directFailure(limited)]), /\d{2,}/);
});
