// Run: npx tsx --test netlify/lib/connectors/withings-direct.test.ts
// Withings over its Public API, with fetch stubbed and recorded replies (shapes as wbsapi.withings.net returned them, trimmed; figures made up).
import { afterEach, beforeEach, test } from "node:test";
import { readHealthDay } from "../../../lib/health";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { exchangeWithingsCode, openWithings, withingsAdapter, withingsAuthorizationUrl } from "./withings-direct";

type Reply = { status?: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, form: URLSearchParams, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; form: URLSearchParams; init: RequestInit }> = [];
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
    const form = new URLSearchParams(String(init.body ?? ""));
    calls.push({ url, form, init });
    for (const r of routes) {
      const reply = r(url, form, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${url.pathname} ${form.get("action")}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lifeTokenStore.save = realSave;
});

const ok = (body: unknown) => ({ body: { status: 0, body } });
const action = (path: string, name: string, reply: (form: URLSearchParams, init: RequestInit) => Reply) => (url: URL, form: URLSearchParams, init: RequestInit) =>
  url.pathname === path && form.get("action") === name ? reply(form, init) : undefined;
const connector = { id: "c4", name: "Withings", provider: "withings", auth_type: "oauth", url: "https://wbsapi.withings.net", scope: "" } as Connector;
const secrets = (fresh = true): ConnectorSecrets => ({
  tokens: { access_token: "a1", refresh_token: "r1", expires_in: 10800, obtained_at: fresh ? Date.now() : Date.now() - 4 * 3600_000 },
  ownClient: { client_id: "cid", client_secret: "cs" },
});

/** Two weigh-ins on the 6th (London), one on the 2nd; units as Withings sends them (value × 10^unit). */
const GROUPS = [
  { grpid: 1, attrib: 0, date: Date.parse("2026-11-06T07:05:00Z") / 1000, category: 1, measures: [{ value: 78450, type: 1, unit: -3 }, { value: 182, type: 6, unit: -1 }, { value: 14280, type: 8, unit: -3 }, { value: 6120, type: 76, unit: -2 }, { value: 62, type: 11, unit: 0 }] },
  { grpid: 2, attrib: 0, date: Date.parse("2026-11-06T21:40:00Z") / 1000, category: 1, measures: [{ value: 7912, type: 1, unit: -2 }] },
  { grpid: 3, attrib: 0, date: Date.parse("2026-11-02T07:00:00Z") / 1000, category: 1, measures: [{ value: 79000, type: 1, unit: -3 }] },
];
function getmeas(form: URLSearchParams): Reply {
  const from = Number(form.get("startdate"));
  const to = Number(form.get("enddate"));
  const all = GROUPS.filter((g) => g.date >= from && g.date <= to);
  const offset = Number(form.get("offset") ?? 0);
  const page = all.slice(offset, offset + 2);
  return ok({ updatetime: 1794000000, timezone: "Europe/London", measuregrps: page, more: offset + 2 < all.length ? 1 : 0, offset: offset + 2 });
}
const ACTIVITY = [
  { date: "2026-11-06", timezone: "Europe/London", brand: 18, is_tracker: true, steps: 11234, distance: 8450.5, elevation: 12, soft: 7200, moderate: 1800, intense: 900, active: 2700, calories: 480.2, totalcalories: 2390.7, hr_average: 71, hr_min: 50, hr_max: 162 },
  { date: "2026-11-05", timezone: "Europe/London", steps: 6000, active: 600 },
];
const SLEEP = [
  { id: 9, timezone: "Europe/London", model: 32, startdate: Date.parse("2026-11-05T23:30:00Z") / 1000, enddate: Date.parse("2026-11-06T06:50:00Z") / 1000, date: "2026-11-06", data: { total_sleep_time: 24600, total_timeinbed: 26400, sleep_efficiency: 0.93, sleep_score: 79, deepsleepduration: 4800, lightsleepduration: 14400, remsleepduration: 5400, wakeupcount: 2, wakeupduration: 1800, hr_average: 57, hr_min: 49 } },
  { id: 10, timezone: "Europe/London", model: 16, startdate: Date.parse("2026-11-06T13:00:00Z") / 1000, enddate: Date.parse("2026-11-06T13:30:00Z") / 1000, date: "2026-11-06", data: { total_sleep_time: 1500 } },
];
/** ymd actions, one row a page, to exercise more/offset. */
const ymd = (rows: Array<{ date: string }>, key: string) => (form: URLSearchParams) => {
  const inRange = rows.filter((r) => r.date >= form.get("startdateymd")! && r.date <= form.get("enddateymd")!);
  const offset = Number(form.get("offset") ?? 0);
  return ok({ [key]: inRange.slice(offset, offset + 1), more: offset + 1 < inRange.length, offset: offset + 1 });
};
const ALL = [action("/measure", "getmeas", getmeas), action("/v2/measure", "getactivity", ymd(ACTIVITY, "activities")), action("/v2/sleep", "getsummary", ymd(SLEEP, "series"))];

test("presets: Withings sits in Health, reads only, says figures are sealed", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "withings")!;
  assert.equal(p.category, "health");
  assert.equal(p.scope, "user.metrics,user.activity,user.sleepevents");
  assert.match(p.help, /encrypts the figures/);
  for (const t of withingsAdapter.tools(connector)) assert.equal(classifyTool("withings", t.name, t.annotations), "read");
  assert.equal(directFor(connector), withingsAdapter);
});

test("sign-in: Withings' authorize2 page, comma scopes; requesttoken with the client secret, envelope unwrapped", async () => {
  const url = new URL(withingsAuthorizationUrl({ clientId: "cid", redirectUri: "https://athena.example/cb", scope: "user.metrics,user.activity,user.sleepevents", state: "s" }));
  assert.equal(url.origin + url.pathname, "https://account.withings.com/oauth2_user/authorize2");
  assert.equal(url.searchParams.get("scope"), "user.metrics,user.activity,user.sleepevents");
  routes = [action("/v2/oauth2", "requesttoken", () => ok({ userid: 363, access_token: "a9", refresh_token: "r9", expires_in: 10800, scope: "user.metrics,user.activity", csrf_token: "x", token_type: "Bearer" }))];
  const t = await exchangeWithingsCode({ code: "c", redirectUri: "https://athena.example/cb", client: { client_id: "cid", client_secret: "cs" } });
  assert.equal(t.access_token, "a9");
  assert.equal((t as Record<string, unknown>).userid, undefined, "nothing else from the reply is kept");
  const f = calls[0].form;
  assert.deepEqual([f.get("action"), f.get("grant_type"), f.get("client_id"), f.get("client_secret"), f.get("code"), f.get("redirect_uri")], ["requesttoken", "authorization_code", "cid", "cs", "c", "https://athena.example/cb"]);
});

test("body_measures: units applied, local times, newest first, more/offset paged by cursor", async () => {
  routes = ALL;
  const acct = await openWithings(connector, secrets(), "Europe/London");
  const out = JSON.parse((await acct.call("body_measures", { after: "2026-11-01", before: "2026-11-07" })).text);
  assert.deepEqual(out.items, [
    { date: "2026-11-06", time: "21:40", weight_kg: 79.12 },
    { date: "2026-11-06", time: "07:05", weight_kg: 78.45, fat_ratio: 18.2, fat_mass_kg: 14.28, muscle_mass_kg: 61.2, heart_pulse: 62 },
  ]);
  assert.ok(out.next_cursor);
  const more = JSON.parse((await acct.call("body_measures", { after: "2026-11-01", before: "2026-11-07", cursor: out.next_cursor })).text);
  assert.deepEqual(more.items, [{ date: "2026-11-02", time: "07:00", weight_kg: 79 }]);
  const req = calls.filter((c) => c.form.get("action") === "getmeas").at(-1)!;
  assert.equal(req.form.get("offset"), "2");
  assert.equal(req.form.get("meastypes"), "1,5,6,8,11,76,77,88");
  assert.equal(req.form.get("category"), "1");
  assert.equal(new Headers(req.init.headers).get("authorization"), "Bearer a1");
});

test("only read actions leave Athena, each to its documented host and path", async () => {
  routes = ALL;
  const acct = await openWithings(connector, secrets(), "Europe/London");
  for (const t of withingsAdapter.tools(connector)) await acct.call(t.name, t.name === "day_summary" ? { date: "2026-11-06" } : {});
  const sent = new Set(calls.map((c) => `${c.url.host}${c.url.pathname} ${c.form.get("action")}`));
  assert.deepEqual([...sent].sort(), ["wbsapi.withings.net/measure getmeas", "wbsapi.withings.net/v2/measure getactivity", "wbsapi.withings.net/v2/sleep getsummary"]);
});

test("daily_activity and daily_sleep: ymd windows, offset paging, the night kept over a nap", async () => {
  routes = ALL;
  const acct = await openWithings(connector, secrets(), "Europe/London");
  const act = JSON.parse((await acct.call("daily_activity", { after: "2026-11-05", before: "2026-11-07" })).text);
  assert.deepEqual(act.items.map((i: { date: string; steps: number }) => [i.date, i.steps]), [["2026-11-06", 11234], ["2026-11-05", 6000]]);
  assert.deepEqual(act.items[0], { date: "2026-11-06", steps: 11234, distance_m: 8451, floors: 12, active_minutes: 45, light_minutes: 120, moderate_minutes: 30, intense_minutes: 15, active_calories: 480, total_calories: 2391, average_hr: 71, min_hr: 50, max_hr: 162 });
  const req = calls.filter((c) => c.form.get("action") === "getactivity");
  assert.deepEqual(req.slice(-2).map((c) => [c.form.get("startdateymd"), c.form.get("enddateymd"), c.form.get("offset")]), [["2026-11-05", "2026-11-06", null], ["2026-11-05", "2026-11-06", "1"]]);
  const sleep = JSON.parse((await acct.call("daily_sleep", { date: "2026-11-06" })).text);
  assert.deepEqual(sleep.items, [{ date: "2026-11-06", total_minutes: 410, in_bed_minutes: 440, efficiency: 93, score: 79, deep_minutes: 80, light_minutes: 240, rem_minutes: 90, wakeups: 2, awake_minutes: 30, resting_hr: 49, average_hr: 57, bedtime: "23:30", wake_time: "06:50" }]);
});

test("day_summary: the day in athena_health_day's shape, the day's last weigh-in", async () => {
  routes = ALL;
  const out = JSON.parse((await (await openWithings(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-11-06" })).text);
  assert.deepEqual(out, { date: "2026-11-06", source: "withings", sleep_minutes: 410, sleep_stages: { deep: 80, core: 240, rem: 90, awake: 30, in_bed: 440 }, steps: 11234, active_minutes: 45, resting_hr: 49, weight_kg: 79.12 });
  assert.deepEqual(readHealthDay(out, { today: "2026-11-07" }).sleep_stages, out.sleep_stages);
  const none = JSON.parse((await (await openWithings(connector, secrets(), "Europe/London")).call("day_summary", { date: "2026-10-01" })).text);
  assert.deepEqual(none, { date: "2026-10-01", source: "withings" });
});

test("token refresh: requesttoken with grant refresh_token, rotated and saved once", async () => {
  routes = [action("/v2/oauth2", "requesttoken", () => ok({ userid: 363, access_token: "a2", refresh_token: "r2", expires_in: 10800, token_type: "Bearer" })), ...ALL];
  const s = secrets(false);
  await openWithings(connector, s, "UTC");
  const f = calls[0].form;
  assert.deepEqual([f.get("action"), f.get("grant_type"), f.get("refresh_token"), f.get("client_secret")], ["requesttoken", "refresh_token", "r1", "cs"]);
  assert.equal(saved.length, 1);
  assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "r2");
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer a2");
});

test("status 401 in a 200 renews once, then is needs_auth; 601 retried then a passing error; odd statuses say only the code", async () => {
  const bad = (url: URL, form: URLSearchParams) => (form.get("action") === "getactivity" ? { body: { status: 401, body: {}, error: "XRequestID: Not provided invalid_token" } } : undefined);
  routes = [bad, action("/v2/oauth2", "requesttoken", () => ok({ access_token: "a2", refresh_token: "r2", expires_in: 10800 }))];
  const e = await openWithings(connector, secrets(), "UTC").catch((x) => x);
  assert.equal(calls.filter((c) => c.form.get("action") === "requesttoken").length, 1);
  assert.deepEqual(directFailure(e), { status: "needs_auth", detail: "Withings didn't accept the sign-in. Sign in again" });
  assert.equal(withingsAdapter.accountProblem(e), true);

  routes = [action("/v2/oauth2", "requesttoken", () => ({ body: { status: 503, body: {}, error: "Invalid Params: invalid refresh_token" } }))];
  const refused = await openWithings(connector, secrets(false), "UTC").catch((x) => x);
  assert.equal(directFailure(refused)?.status, "needs_auth");

  calls = [];
  routes = [(url, form) => (form.get("action") === "getactivity" ? { body: { status: 601, body: {} } } : undefined)];
  const busy = await openWithings(connector, secrets(), "UTC").catch((x) => x);
  assert.equal(calls.length, 3);
  assert.deepEqual(directFailure(busy), { status: "error", detail: "Withings is limiting how often Athena can ask right now. Try again in a few minutes." });

  routes = [(url, form) => (form.get("action") === "getactivity" ? ok({ activities: [] }) : form.get("action") === "getsummary" ? { body: { status: 293, body: {} } } : undefined)];
  const acct = await openWithings(connector, secrets(), "UTC");
  const odd = await acct.call("daily_sleep", {});
  assert.deepEqual(odd, { text: "Withings refused that (status 293)", isError: true });
});
