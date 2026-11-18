// Run: npx tsx --test netlify/lib/connectors/polar-direct.test.ts
// Polar AccessLink v3, with fetch stubbed and recorded replies (shapes as www.polaraccesslink.com returned them, trimmed; figures made up).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { CAN_SEND, healthLine, mergeSources, readHealthDay, readPrefs } from "../../../lib/health";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { durationMinutes, exchangePolarCode, openPolar, polarAdapter, polarAuthorizationUrl } from "./polar-direct";

type Reply = { status?: number; body?: unknown };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  routes = [];
  lifeRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${init.method ?? "GET"} ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const V3 = "/v3";
const at = (p: string, body: unknown, status = 200, method = "GET") => (url: URL, init: RequestInit) => (url.pathname === `${V3}${p}` && (init.method ?? "GET") === method ? { status, body } : undefined);
const connector = { id: "c1", name: "Polar", provider: "polar", auth_type: "oauth", url: "https://www.polaraccesslink.com/v3", scope: "" } as Connector;
const secrets = (): ConnectorSecrets => ({
  tokens: { access_token: "pa1", token_type: "bearer", expires_in: 31535999, obtained_at: Date.now(), x_user_id: 4021 },
  ownClient: { client_id: "pc", client_secret: "ps" },
});

// A road run at 07:05 on the watch, an hour ahead of UTC (Paris), and a strength session that evening.
const RUN = { id: "Wr8n4OOq", upload_time: "2026-11-06T07:58:12Z", polar_user: "https://www.polaraccesslink.com/v3/users/4021", device: "Polar Pacer Pro", start_time: "2026-11-06T07:05:00", start_time_utc_offset: 60, duration: "PT45M30S", calories: 512, distance: 8012.4, heart_rate: { average: 149, maximum: 172 }, training_load: 96.2, sport: "RUNNING", has_route: true, detailed_sport_info: "ROAD_RUNNING" };
const GYM = { ...RUN, id: "Kd29xQ1a", start_time: "2026-11-06T18:30:00", duration: "PT50M", distance: undefined, calories: 310, sport: "OTHER", detailed_sport_info: "STRENGTH_TRAINING", has_route: false };
const OLD = { ...RUN, id: "Zz000001", start_time: "2026-10-20T07:00:00" };
const DAY_ACTIVITY = { start_time: "2026-11-06T00:00:00", end_time: "2026-11-07T00:00:00", active_duration: "PT2H11M", inactive_duration: "PT14H3M", daily_activity: 104.2, calories: 2512, active_calories: 812, steps: 11342, inactivity_alert_count: 1, distance_from_steps: 8432.1 };
const NIGHT = { polar_user: "https://www.polaraccesslink.com/v3/users/4021", date: "2026-11-06", sleep_start_time: "2026-11-05T23:31:02+01:00", sleep_end_time: "2026-11-06T06:58:40+01:00", device_id: "1111AAAA", continuity: 3.1, continuity_class: 3, light_sleep: 14820, deep_sleep: 5160, rem_sleep: 5940, unrecognized_sleep_stage: 240, sleep_score: 81, total_interruption_duration: 2700, sleep_charge: 3, sleep_goal: 28800 };
const RECHARGE = { polar_user: "https://www.polaraccesslink.com/v3/users/4021", date: "2026-11-06", heart_rate_avg: 54, beat_to_beat_avg: 1110, heart_rate_variability_avg: 48, breathing_rate_avg: 14.2, nightly_recharge_status: 4, ans_charge: 2.3, ans_charge_status: 3 };

test("presets: Polar sits in Health, reads only, says figures are sealed, and is reached directly", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "polar")!;
  assert.equal(p.category, "health");
  assert.equal(p.scope, "accesslink.read_all");
  assert.match(p.help, /encrypts the figures/);
  for (const t of polarAdapter.tools(connector)) assert.equal(classifyTool("polar", t.name, t.annotations), "read");
  assert.equal(directFor(connector), polarAdapter);
  assert.equal(directApi(connector), true);
  for (const c of ["sleep", "steps", "workouts"] as const) assert.ok(CAN_SEND[c].includes("polar"), c);
  assert.equal(readPrefs({ steps: "polar" }).steps, "polar");
});

test("durations: ISO 8601 as Polar writes it", () => {
  assert.equal(durationMinutes("PT2H44M45S"), 165);
  assert.equal(durationMinutes("PT45M"), 45);
  assert.equal(durationMinutes("PT3600.000S"), 60);
  assert.equal(durationMinutes("P1D"), undefined);
  assert.equal(durationMinutes(undefined), undefined);
});

test("sign-in: Basic auth at polarremote.com, then the owner is registered; 409 means already registered", async () => {
  const url = new URL(polarAuthorizationUrl({ clientId: "pc", redirectUri: "https://athena.example/cb", scope: "", state: "s" }));
  assert.equal(url.origin + url.pathname, "https://flow.polar.com/oauth2/authorization");
  assert.equal(url.searchParams.get("scope"), "accesslink.read_all");
  assert.equal(url.searchParams.get("code_challenge"), null);
  routes = [
    (u) => (u.hostname === "polarremote.com" && u.pathname === "/v2/oauth2/token" ? { body: { access_token: "pa9", token_type: "bearer", expires_in: 31535999, x_user_id: 4021 } } : undefined),
    at("/users", { "polar-user-id": 4021, "member-id": "athena-4021", "first-name": "M" }, 200, "POST"),
  ];
  const t = await exchangePolarCode({ code: "c", redirectUri: "https://athena.example/cb", client: { client_id: "pc", client_secret: "ps" } });
  assert.equal(t.access_token, "pa9");
  assert.equal((t as Record<string, unknown>).x_user_id, 4021);
  assert.equal((t as Record<string, unknown>)["first-name"], undefined, "the profile isn't kept");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), `Basic ${Buffer.from("pc:ps").toString("base64")}`);
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get("redirect_uri"), "https://athena.example/cb");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { "member-id": "athena-4021" });
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer pa9");

  routes = [(u) => (u.hostname === "polarremote.com" ? { body: { access_token: "pa9", x_user_id: 4021 } } : undefined), at("/users", { message: "already" }, 409, "POST")];
  assert.equal((await exchangePolarCode({ code: "c", redirectUri: "r", client: { client_id: "pc", client_secret: "ps" } })).access_token, "pa9");

  routes = [(u) => (u.hostname === "polarremote.com" ? { body: { access_token: "pa9", x_user_id: 4021 } } : undefined), at("/users", { message: "consents" }, 403, "POST")];
  const consent = await exchangePolarCode({ code: "c", redirectUri: "r", client: { client_id: "pc", client_secret: "ps" } }).catch((e) => e);
  assert.deepEqual(directFailure(consent), { status: "needs_auth", detail: "Polar needs you to accept its data sharing terms. Open Polar Flow, accept them, then sign in again." });

  routes = [(u) => (u.hostname === "polarremote.com" ? { status: 400, body: { error: "invalid_client" } } : undefined)];
  const bad = await exchangePolarCode({ code: "c", redirectUri: "r", client: { client_id: "pc", client_secret: "ps" } }).catch((e) => e);
  assert.match(directFailure(bad)!.detail, /Client ID and Secret under Edit/);
});

const reads = () => [
  at("/users/activities/2026-11-06", DAY_ACTIVITY),
  (u: URL, i: RequestInit) => (u.pathname.startsWith(`${V3}/users/activities/`) && (i.method ?? "GET") === "GET" ? { status: 204 } : undefined),
  (u: URL) => (u.pathname === `${V3}/users/activities` ? { body: [DAY_ACTIVITY, { ...DAY_ACTIVITY, start_time: "2026-11-05T00:00:00", steps: 6021, active_duration: "PT58M" }] } : undefined),
  at("/exercises", [GYM, RUN, OLD]),
  at("/users/sleep/2026-11-06", NIGHT),
  at("/users/sleep", { nights: [NIGHT, { ...NIGHT, date: "2026-11-05", sleep_start_time: "2026-11-04T23:10:00+01:00", sleep_end_time: "2026-11-05T06:40:00+01:00" }] }),
  at("/users/nightly-recharge", { recharges: [RECHARGE] }),
  at("/users/nightly-recharge/2026-11-06", RECHARGE),
  (u: URL) => (u.pathname.startsWith(`${V3}/users/nightly-recharge/`) || u.pathname.startsWith(`${V3}/users/sleep/`) ? { status: 404, body: { status: 404, message: "Not found" } } : undefined),
];

test("exercises: the watch's local start and offset, read as the owner's local time; only GETs", async () => {
  routes = reads();
  const acct = await openPolar(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("exercises", { date: "2026-11-06" })).text);
  assert.deepEqual(out.items.map((i: { time: string; type: string }) => [i.time, i.type]), [["17:30", "strength training"], ["06:05", "road running"]]);
  assert.deepEqual(out.items[1], { date: "2026-11-06", time: "06:05", type: "road running", minutes: 46, distance_m: 8012, kcal: 512, average_hr: 149, max_hr: 172, training_load: 96.2 });
  assert.ok(calls.every((c) => (c.init.method ?? "GET") === "GET"));
  assert.ok(calls.every((c) => c.url.hostname === "www.polaraccesslink.com"));
});

test("activity and sleep: windows by local day, newest first, paged by date", async () => {
  routes = reads();
  const acct = await openPolar(connector, secrets(), "Europe/London");
  const act = JSON.parse((await acct.call("daily_activity", { after: "2026-11-05", before: "2026-11-07" })).text);
  assert.deepEqual(act.items.map((i: { date: string; steps: number }) => [i.date, i.steps]), [["2026-11-06", 11342], ["2026-11-05", 6021]]);
  assert.equal(act.items[0].active_minutes, 131);
  const q = calls.find((c) => c.url.pathname === `${V3}/users/activities`)!.url;
  assert.equal(q.searchParams.get("from"), "2026-11-05");
  assert.equal(q.searchParams.get("to"), "2026-11-06");
  const one = JSON.parse((await acct.call("daily_activity", { after: "2026-11-05", before: "2026-11-07", limit: 1 })).text);
  assert.ok(one.next_cursor, "a second page for the 5th");
  calls = [];
  await acct.call("daily_activity", { after: "2026-11-05", before: "2026-11-07", limit: 1, cursor: one.next_cursor });
  assert.equal(calls[0].url.searchParams.get("to"), "2026-11-05");

  const sleep = JSON.parse((await acct.call("sleep", { date: "2026-11-06" })).text);
  assert.equal(sleep.items.length, 1);
  assert.deepEqual(sleep.items[0], { date: "2026-11-06", total_minutes: 436, deep_minutes: 86, rem_minutes: 99, light_minutes: 247, interrupted_minutes: 45, score: 81, sleep_charge: 3, continuity: 3.1, bedtime: "22:31", wake_time: "05:58", recharge_status: 4, ans_charge: 2.3, sleeping_hr: 54, hrv_ms: 48, breathing_rate: 14.2 });
});

test("day_summary: the day in athena_health_day's shape, accepted as it is; a day with nothing says so", async () => {
  routes = reads();
  const acct = await openPolar(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("day_summary", { date: "2026-11-06" })).text);
  assert.deepEqual(out, {
    date: "2026-11-06",
    source: "polar",
    sleep_minutes: 436,
    sleep_stages: { deep: 86, core: 247, rem: 99, asleep_unspecified: 4, awake: 45, in_bed: 448 },
    recharge: 4,
    steps: 11342,
    active_minutes: 131,
    workouts: [
      { type: "road running", minutes: 46, distance_m: 8012, kcal: 512, start: "06:05" },
      { type: "strength training", minutes: 50, kcal: 310, start: "17:30" },
    ],
  });
  assert.equal(readHealthDay(out, { today: "2026-11-07" }).steps, 11342);
  assert.deepEqual(readHealthDay(out, { today: "2026-11-07" }).sleep_stages, out.sleep_stages, "stages: light is core, unrecognised is unstaged, interruptions are awake");
  assert.equal(readHealthDay(out, { today: "2026-11-07" }).recharge, 4, "recovery (Nightly Recharge) is saved, not just read");
  routes = reads();
  const empty = JSON.parse((await acct.call("day_summary", { date: "2026-11-01" })).text);
  assert.deepEqual(empty, { date: "2026-11-01", source: "polar", workouts: [] });
});

test("the pull model: open, list, read each item, then commit; the answer is days, not figures", async () => {
  const base = `${V3}/users/4021`;
  const flow: string[] = [];
  routes = [
    ...reads(),
    (u, i) => {
      const m = i.method ?? "GET";
      const key = `${m} ${u.pathname}`;
      if (!u.pathname.startsWith(base)) return undefined;
      flow.push(key);
      if (key === `POST ${base}/exercise-transactions`) return { status: 201, body: { "transaction-id": 122, "resource-uri": `https://www.polaraccesslink.com${base}/exercise-transactions/122` } };
      if (key === `GET ${base}/exercise-transactions/122`) return { body: { exercises: [`https://www.polaraccesslink.com${base}/exercise-transactions/122/exercises/56`, `https://www.polaraccesslink.com${base}/exercise-transactions/122/exercises/57`] } };
      if (key === `GET ${base}/exercise-transactions/122/exercises/56`) return { body: { id: 56, "start-time": "2026-11-03T07:05:00", "start-time-utc-offset": 60, duration: "PT45M", calories: 500 } };
      if (key === `GET ${base}/exercise-transactions/122/exercises/57`) return { body: { id: 57, "start-time": "2026-11-06T23:40:00", "start-time-utc-offset": 0, duration: "PT30M" } };
      if (key === `PUT ${base}/exercise-transactions/122`) return { status: 200 };
      if (key === `POST ${base}/activity-transactions`) return { status: 201, body: { "transaction-id": 9, "resource-uri": "x" } };
      if (key === `GET ${base}/activity-transactions/9`) return { body: { "activity-log": [`https://www.polaraccesslink.com${base}/activity-transactions/9/activities/1`] } };
      if (key === `GET ${base}/activity-transactions/9/activities/1`) return { body: { id: 1, date: "2026-11-04", "active-steps": 9000, calories: 2100 } };
      if (key === `PUT ${base}/activity-transactions/9`) return { status: 200 };
      return undefined;
    },
  ];
  const acct = await openPolar(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("changed_days", {})).text);
  assert.deepEqual(out, { items: ["2026-11-03", "2026-11-04", "2026-11-06"] }, "dates only: no figures from the transaction");
  assert.deepEqual(flow, [
    `POST ${base}/exercise-transactions`,
    `GET ${base}/exercise-transactions/122`,
    `GET ${base}/exercise-transactions/122/exercises/56`,
    `GET ${base}/exercise-transactions/122/exercises/57`,
    `PUT ${base}/exercise-transactions/122`,
    `POST ${base}/activity-transactions`,
    `GET ${base}/activity-transactions/9`,
    `GET ${base}/activity-transactions/9/activities/1`,
    `PUT ${base}/activity-transactions/9`,
  ]);
  // Committed: the day's figures still come from the endpoints that can be read again.
  const again = JSON.parse((await acct.call("day_summary", { date: "2026-11-06" })).text);
  assert.equal(again.steps, 11342);
});

test("the pull model: nothing new (204) opens nothing; a failed read leaves the transaction uncommitted", async () => {
  const base = `${V3}/users/4021`;
  routes = [...reads(), (u, i) => (u.pathname.startsWith(base) && i.method === "POST" ? { status: 204 } : undefined)];
  const acct = await openPolar(connector, secrets(), "UTC");
  assert.deepEqual(JSON.parse((await acct.call("changed_days", {})).text), { items: [] });
  assert.ok(!calls.some((c) => c.init.method === "PUT"));

  calls = [];
  routes = [
    ...reads(),
    at("/users/4021/exercise-transactions", { "transaction-id": 122 }, 201, "POST"),
    at("/users/4021/exercise-transactions/122", { exercises: [`https://www.polaraccesslink.com${base}/exercise-transactions/122/exercises/56`] }),
    at("/users/4021/exercise-transactions/122/exercises/56", { message: "busy" }, 503),
  ];
  const error = await acct.call("changed_days", {}).catch((e) => e);
  assert.deepEqual(directFailure(error), { status: "error", detail: "Polar is having trouble right now. Try again in a few minutes." });
  assert.ok(!calls.some((c) => c.init.method === "PUT"), "never committed, so Polar offers the same items next time");

  calls = [];
  routes = [...reads(), at("/users/4021/exercise-transactions", { "transaction-id": 122 }, 201, "POST"), at("/users/4021/exercise-transactions/122", { exercises: ["https://evil.example/v3/users/4021/x"] })];
  await acct.call("changed_days", {}).catch(() => undefined);
  assert.ok(!calls.some((c) => c.url.hostname === "evil.example"), "only links on AccessLink are followed");
  assert.ok(!calls.some((c) => c.init.method === "PUT"));

  calls = [];
  routes = [...reads(), (u, i) => (u.pathname.startsWith(base) && i.method === "POST" ? { status: 404, body: {} } : undefined)];
  const gone = JSON.parse((await acct.call("changed_days", {})).text);
  assert.deepEqual(gone.items, []);
  assert.match(gone.note, /day_summary/);
});

test("merging: Polar's run and Apple Health's run are one workout; Polar can lead sleep and steps", () => {
  const apple = { source: "apple_health" as const, steps: 10900, sleep_minutes: 430, workouts: [{ type: "HKWorkoutActivityTypeRunning", minutes: 46, distance_m: 8000, start: "06:04" }] };
  const polar = { source: "polar" as const, sleep_minutes: 436, recharge: 5, steps: 11342, workouts: [{ type: "road running", minutes: 46, distance_m: 8012, kcal: 512, start: "06:05" }, { type: "strength training", minutes: 50, start: "17:30" }] };
  const m = mergeSources([apple, polar], readPrefs({ sleep: "polar", steps: "polar", workouts: "apple_health" }));
  assert.equal(m.workouts?.length, 2, "one run, not two");
  assert.equal(m.workouts![0].kcal, 512, "Polar's kcal filled in");
  assert.equal(m.steps, 11342, "never added: 11,342, not 22,242");
  assert.equal(healthLine(m), "7h 16m sleep · 11,342 steps · 8k run · 50 min strength · good recharge");
  // With Whoop too, the night's recovery comes from the sleep choice only: never both.
  const whoop = { source: "whoop" as const, sleep_minutes: 450, recovery: 68 };
  assert.equal(mergeSources([apple, polar, whoop], readPrefs({ sleep: "polar" })).recovery, undefined);
  assert.equal(mergeSources([apple, polar, whoop], readPrefs({ sleep: "polar" })).recharge, 5);
  const w = mergeSources([apple, polar, whoop], readPrefs({ sleep: "whoop" }));
  assert.deepEqual([w.recovery, w.recharge], [68, undefined]);
  assert.match(healthLine(w)!, /· 68% recovery$/);
});

test("a 401 is needs_auth at once (Polar has no refresh token), with no figures in the message", async () => {
  routes = [(u) => (u.pathname.startsWith(`${V3}/users/activities/`) ? { status: 401, body: { status: 401, errorType: "Unauthorized" } } : undefined)];
  const error = await openPolar(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(error), { status: "needs_auth", detail: "Polar didn't accept the sign-in. Sign in again" });
  assert.equal(polarAdapter.accountProblem(error), true);
  assert.ok(!calls.some((c) => c.url.hostname === "polarremote.com"), "no renewal attempted");

  calls = [];
  routes = [(u) => (u.pathname.startsWith(`${V3}/users/activities/`) ? { status: 429, body: {} } : undefined)];
  const limited = await openPolar(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(limited), { status: "error", detail: "Polar is limiting how often Athena can ask right now. Try again in 15 minutes." });
  assert.equal(calls.length, 3, "429 retried twice");
});
