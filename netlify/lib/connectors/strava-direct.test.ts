// Run: npx tsx --test netlify/lib/connectors/strava-direct.test.ts
// Strava over API v3, with fetch stubbed and recorded replies (shapes as www.strava.com returned them, trimmed; figures made up).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { exchangeStravaCode, openStrava, stravaAdapter, stravaAuthorizationUrl } from "./strava-direct";

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

const at = (p: string, body: unknown, status = 200) => (url: URL) => (url.pathname === p ? { status, body } : undefined);
const connector = { id: "c1", name: "Strava", provider: "strava", auth_type: "oauth", url: "https://www.strava.com/api/v3", scope: "" } as Connector;
const secrets = (fresh = true): ConnectorSecrets => ({
  tokens: { access_token: "a1", refresh_token: "r1", expires_in: 21600, obtained_at: fresh ? Date.now() : Date.now() - 7 * 3600_000 },
  ownClient: { client_id: "12345", client_secret: "cs" },
});

const ATHLETE = { id: 99, username: "jordan", resource_state: 2 };
const RUN = {
  resource_state: 2,
  name: "Morning Run",
  distance: 8123.4,
  moving_time: 2580,
  elapsed_time: 2702,
  total_elevation_gain: 64.2,
  type: "Run",
  sport_type: "TrailRun",
  id: 1001,
  start_date: "2026-11-06T07:12:00Z",
  start_date_local: "2026-11-06T07:12:00Z",
  timezone: "(GMT+00:00) Europe/London",
  has_heartrate: true,
  average_heartrate: 151.3,
  private: false,
  manual: false,
};
const RIDE = { ...RUN, name: "Evening Ride", id: 1002, type: "Ride", sport_type: "Ride", distance: 20510, moving_time: 3600, elapsed_time: 3900, start_date: "2026-11-06T18:30:00Z", has_heartrate: false, average_heartrate: undefined };
const OLD = { ...RUN, name: "Tuesday", id: 1000, start_date: "2026-11-03T07:00:00Z" };

test("presets: Strava sits in Health, reads only, says figures are sealed, and is reached directly", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "strava")!;
  assert.equal(p.category, "health");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.equal(p.scope, "read,activity:read_all");
  assert.match(p.help, /encrypts the figures/);
  for (const t of stravaAdapter.tools(connector)) assert.equal(classifyTool("strava", t.name, t.annotations), "read");
  assert.equal(directFor(connector), stravaAdapter);
  assert.equal(directApi(connector), true);
});

test("sign-in: comma scopes, no PKCE; the code exchange sends the client in the form", async () => {
  const url = new URL(stravaAuthorizationUrl({ clientId: "12345", redirectUri: "https://athena.example/cb", scope: "read,activity:read_all", state: "s" }));
  assert.equal(url.origin + url.pathname, "https://www.strava.com/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "read,activity:read_all");
  assert.equal(url.searchParams.get("code_challenge"), null);
  routes = [at("/oauth/token", { token_type: "Bearer", access_token: "a9", refresh_token: "r9", expires_at: Math.floor(Date.now() / 1000) + 21600, expires_in: 21600, athlete: ATHLETE })];
  const t = await exchangeStravaCode({ code: "c", client: { client_id: "12345", client_secret: "cs" } });
  assert.equal(t.access_token, "a9");
  assert.equal(t.expires_in, 21600);
  assert.equal((t as Record<string, unknown>).athlete, undefined, "the athlete profile isn't kept");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("client_secret"), "cs");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), null);
});

test("activities: one local day, local times, kcal from each activity's page, GETs only", async () => {
  routes = [
    at("/api/v3/athlete", ATHLETE),
    (url) => (url.pathname === "/api/v3/athlete/activities" ? { body: [RUN, RIDE, OLD].filter((a) => { const s = Date.parse(a.start_date) / 1000; return s > Number(url.searchParams.get("after")) && s < Number(url.searchParams.get("before")); }) } : undefined),
    at("/api/v3/activities/1001", { ...RUN, resource_state: 3, calories: 612.4 }),
    at("/api/v3/activities/1002", { ...RIDE, resource_state: 3, calories: 0 }),
  ];
  // Los Angeles: 07:12Z on the 6th is 23:12 on the 5th, so only the ride is the 6th there.
  const la = JSON.parse((await (await openStrava(connector, secrets(), "America/Los_Angeles")).call("activities", { date: "2026-11-06" })).text);
  assert.deepEqual(la.items.map((i: { name: string }) => i.name), ["Evening Ride"]);
  calls = [];
  const acct = await openStrava(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("activities", { date: "2026-11-06" })).text);
  assert.deepEqual(out.items.map((i: { name: string; time: string }) => [i.name, i.time]), [["Evening Ride", "18:30"], ["Morning Run", "07:12"]]);
  const run = out.items[1];
  assert.equal(run.type, "trail run");
  assert.equal(run.moving_minutes, 43);
  assert.equal(run.distance_m, 8123);
  assert.equal(run.elevation_m, 64);
  assert.equal(run.average_hr, 151);
  assert.equal(run.kcal, 612);
  assert.equal(run.link, "https://www.strava.com/activities/1001");
  assert.equal(out.items[0].kcal, undefined, "zero calories is left out");
  assert.equal(out.items[0].average_hr, undefined);
  assert.equal(out.count, 2);
  assert.equal(out.moving_minutes, 103);
  const list = calls.find((c) => c.url.pathname.endsWith("/athlete/activities"))!.url;
  assert.equal(list.searchParams.get("before"), String(Date.parse("2026-11-07T00:00:00Z") / 1000));
  assert.ok(calls.every((c) => c.init.method === "GET"));
});

test("paging: a full page of 50 asks for the next; cursor carries the page", async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ...RUN, id: 2000 + i, start_date: new Date(Date.parse("2026-10-01T08:00:00Z") + i * 3600_000).toISOString() }));
  routes = [
    at("/api/v3/athlete", ATHLETE),
    (url) => (url.pathname === "/api/v3/athlete/activities" ? { body: url.searchParams.get("page") === "1" ? many : [{ ...RUN, id: 3000, start_date: "2026-10-04T08:00:00Z" }] } : undefined),
    (url) => (url.pathname.startsWith("/api/v3/activities/") ? { body: { calories: 100 } } : undefined),
  ];
  const acct = await openStrava(connector, secrets(), "UTC");
  const first = JSON.parse((await acct.call("activities", { after: "2026-10-01", before: "2026-11-01", limit: 20 })).text);
  assert.equal(first.items.length, 20);
  assert.ok(first.next_cursor);
  assert.match(first.note, /first 10/);
  assert.equal(calls.filter((c) => c.url.pathname.startsWith("/api/v3/activities/")).length, 10, "calories read for at most 10");
  calls = [];
  const second = JSON.parse((await acct.call("activities", { after: "2026-10-01", before: "2026-11-01", cursor: first.next_cursor })).text);
  assert.equal(calls.find((c) => c.url.pathname.endsWith("/athlete/activities"))!.url.searchParams.get("page"), "2");
  assert.deepEqual(second.items.map((i: { link: string }) => i.link), ["https://www.strava.com/activities/3000"]);
  assert.equal(second.next_cursor, undefined);
  assert.equal((await acct.call("activities", { cursor: "nope" })).isError, true);
});

test("day_summary: the day in athena_health_day's shape, oldest first", async () => {
  routes = [at("/api/v3/athlete", ATHLETE), at("/api/v3/athlete/activities", [RIDE, RUN]), at("/api/v3/activities/1001", { calories: 612 }), at("/api/v3/activities/1002", {})];
  const out = JSON.parse((await (await openStrava(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-11-06" })).text);
  assert.deepEqual(out, {
    date: "2026-11-06",
    source: "strava",
    workouts: [
      { type: "trail run", minutes: 43, distance_m: 8123, kcal: 612, start: "07:12", name: "Morning Run", elevation_m: 64 },
      { type: "ride", minutes: 60, distance_m: 20510, start: "18:30", name: "Evening Ride", elevation_m: 64 },
    ],
  });
});

test("token refresh: an expired token is renewed in the form, rotated, and saved sealed once", async () => {
  routes = [
    (url, init) => (url.pathname === "/oauth/token" ? { body: { token_type: "Bearer", access_token: "a2", refresh_token: "r2", expires_at: Math.floor(Date.now() / 1000) + 21600, expires_in: 21600, _form: String(init.body) } } : undefined),
    (url, init) => (url.pathname === "/api/v3/athlete" && new Headers(init.headers).get("authorization") === "Bearer a2" ? { body: ATHLETE } : undefined),
  ];
  const s = secrets(false);
  await openStrava(connector, s, "UTC");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "r1");
  assert.equal(form.get("client_id"), "12345");
  assert.equal(saved.length, 1);
  assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "r2");
  assert.equal((s.tokens as { access_token: string }).access_token, "a2");
});

test("a 401 renews once; a second 401 is needs_auth, with no figures in the message", async () => {
  routes = [at("/api/v3/athlete", { message: "Authorization Error", errors: [{ resource: "Athlete", field: "access_token", code: "invalid" }] }, 401), at("/oauth/token", { access_token: "a2", refresh_token: "r2", expires_in: 21600 })];
  const error = await openStrava(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(calls.filter((c) => c.url.pathname === "/oauth/token").length, 1);
  assert.deepEqual(directFailure(error), { status: "needs_auth", detail: "Strava didn't accept the sign-in. Sign in again" });
  assert.equal(stravaAdapter.accountProblem(error), true);
});

test("a missing permission, a refused app and Strava's limit each say what to do", async () => {
  routes = [at("/api/v3/athlete", ATHLETE), at("/api/v3/athlete/activities", { message: "Authorization Error", errors: [{ resource: "AccessToken", field: "activity:read_permission", code: "missing" }] }, 401), at("/oauth/token", { access_token: "a2", refresh_token: "r2", expires_in: 21600 })];
  const acct = await openStrava(connector, secrets(), "UTC");
  const error = await acct.call("activities", {}).catch((e) => e);
  assert.deepEqual(directFailure(error), { status: "needs_auth", detail: "Strava didn't let Athena see your activities. Sign in again and leave every box ticked." });

  routes = [at("/oauth/token", { message: "Bad Request", errors: [{ resource: "Application", field: "client_id", code: "invalid" }] }, 400)];
  const refused = await openStrava(connector, secrets(false), "UTC").catch((e) => e);
  assert.equal(directFailure(refused)?.status, "needs_auth");
  assert.match(directFailure(refused)!.detail, /Client ID and Client Secret under Edit/);

  calls = [];
  routes = [at("/api/v3/athlete", { message: "Rate Limit Exceeded" }, 429)];
  const limited = await openStrava(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(limited), { status: "error", detail: "Strava is limiting how often Athena can ask. Try again in 15 minutes." });
  assert.equal(calls.filter((c) => c.url.pathname === "/api/v3/athlete").length, 3, "429 retried twice");
});

test("an unticked activity box on Strava's consent page is caught at sign-in", async () => {
  routes = [at("/oauth/token", { access_token: "a9", refresh_token: "r9", expires_in: 21600, scope: "read" })];
  const error = await exchangeStravaCode({ code: "c", client: { client_id: "1", client_secret: "s" } }).catch((e) => e);
  assert.equal(directFailure(error)?.status, "needs_auth");
});
