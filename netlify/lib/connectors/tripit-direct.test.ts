// Run: npx tsx --test netlify/lib/connectors/tripit-direct.test.ts
// TripIt, with fetch stubbed: the OAuth 1.0 signature against the spec's own example, the sign-in handshake,
// trips and their bookings read from replies in TripIt's shapes (fixtures/tripit.ts), and refusals.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { beginTripItSignIn, exchangeTripItToken, oauth1Header, openTripIt, tripitAdapter } from "./tripit-direct";
import * as T from "./fixtures/tripit";

type Reply = { status?: number; body?: unknown; raw?: string };
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
      if (reply) return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }
    throw new TypeError(`fetch failed: ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = (init: RequestInit) => String((init.headers as Record<string, string>).Authorization);
const field = (header: string, k: string) => decodeURIComponent(new RegExp(`${k}="([^"]*)"`).exec(header)?.[1] ?? "");
const client = { client_id: "consumer-key", client_secret: "consumer-secret" };
const connector = { id: "t1", name: "TripIt", provider: "tripit", auth_type: "oauth", url: "https://api.tripit.com/v1", scope: "" } as Connector;
const secrets = (): ConnectorSecrets => ({ ownClient: client, tokens: { access_token: "access-token", token_secret: "access-secret", token_type: "oauth1" } as never });

const API = (url: URL, init: RequestInit): Reply | undefined => {
  if (url.host !== "api.tripit.com" || !url.pathname.startsWith("/v1/")) return undefined;
  assert.equal(init.method, "GET");
  if (field(auth(init), "oauth_token") !== "access-token") return { status: 401, raw: "<Response><Error><code>401</code></Error></Response>" };
  if (url.pathname === "/v1/get/profile/format/json") return { body: T.TRIPIT_PROFILE };
  if (url.pathname.startsWith("/v1/list/trip/past/false/")) return { body: T.TRIPIT_UPCOMING };
  if (url.pathname.startsWith("/v1/list/trip/past/true/")) return { body: T.TRIPIT_PAST };
  return undefined;
};

test("the OAuth 1.0 signature matches the spec's worked example (OAuth Core 1.0, Appendix A.5)", () => {
  const header = oauth1Header(
    "GET",
    "http://photos.example.net/photos?file=vacation.jpg&size=original",
    { consumerKey: "dpf43f3p2l4k3l03", consumerSecret: "kd94hf93k423kf44", token: "nnch734d00sl2jdk", tokenSecret: "pfkkdhi9sl3r4s00" },
    {},
    { now: 1191242096_000, nonce: "kllo9940pd9333jh" },
  );
  assert.equal(field(header, "oauth_signature"), "tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  assert.match(header, /^OAuth realm="https:\/\/api\.tripit\.com\/", /);
});

test("preset: TripIt sits in the new Places and travel group, with its own app's API key and secret", () => {
  assert.deepEqual(CONNECTOR_CATEGORIES.find((c) => c.id === "travel"), { id: "travel", label: "Places and travel" });
  const p = CONNECTOR_PRESETS.find((x) => x.id === "tripit")!;
  assert.equal(p.category, "travel");
  assert.equal(p.auth, "oauth");
  assert.equal(p.needsOwnClient, true);
  assert.deepEqual(p.clientFields, { id: "API key", secret: "API secret" });
  assert.equal(directApi({ provider: "tripit", auth_type: "oauth" }), true);
  assert.equal(directFor(connector), tripitAdapter);
  for (const t of tripitAdapter.tools(connector)) assert.equal(classifyTool("tripit", t.name, t.annotations), "read");
});

test("sign-in: a signed request token, TripIt's consent page with Athena's state on the callback, then the access token", async () => {
  routes = [
    (url, init) => (url.href === "https://api.tripit.com/oauth/request_token" && init.method === "POST" ? { raw: "oauth_token=req-token&oauth_token_secret=req-secret" } : undefined),
    (url, init) =>
      url.href === "https://api.tripit.com/oauth/access_token" && init.method === "POST" && field(auth(init), "oauth_token") === "req-token" ? { raw: "oauth_token=access-token&oauth_token_secret=access-secret" } : undefined,
  ];
  const begun = await beginTripItSignIn({ client, redirectUri: "https://athena.test/api/connectors/oauth/callback", state: "st4te" });
  const page = new URL(begun.url);
  assert.equal(page.origin + page.pathname, "https://www.tripit.com/oauth/authorize");
  assert.equal(page.searchParams.get("oauth_token"), "req-token");
  assert.equal(page.searchParams.get("oauth_callback"), "https://athena.test/api/connectors/oauth/callback?state=st4te");
  assert.equal(field(auth(calls[0].init), "oauth_consumer_key"), "consumer-key");
  assert.equal(field(auth(calls[0].init), "oauth_signature_method"), "HMAC-SHA1");

  const tokens = await exchangeTripItToken({ code: "req-token", verifier: begun.verifier, client });
  assert.deepEqual(tokens, { access_token: "access-token", token_type: "oauth1", token_secret: "access-secret" });
  // A callback for some other request token is refused before anything is sent.
  const n = calls.length;
  const err = await exchangeTripItToken({ code: "other", verifier: begun.verifier, client }).catch((e) => e);
  assert.match(directFailure(err)!.detail, /doesn't match/);
  assert.equal(calls.length, n);
});

test("sign-in: a wrong API key or secret says so", async () => {
  routes = [(url) => (url.pathname === "/oauth/request_token" ? { status: 401, raw: "" } : undefined)];
  const err = await beginTripItSignIn({ client, redirectUri: "https://athena.test/cb", state: "s" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "TripIt refused Athena's app. Check the API key and secret under Edit, then sign in again." });
});

test("list_trips: upcoming trips with each flight, stay and car, local times in their own zones, and no prices", async () => {
  routes = [API];
  const acct = await openTripIt(connector, secrets(), "Europe/London");
  const r = JSON.parse((await acct.call("list_trips", {})).text);
  assert.equal(r.count, 1);
  const trip = r.trips[0];
  assert.deepEqual([trip.name, trip.destination, trip.start_date, trip.end_date, trip.link], ["Lisbon, November 2026", "Lisbon", "2026-11-20", "2026-11-23", "https://www.tripit.com/app/trips/330001"]);
  assert.deepEqual(
    trip.bookings.map((b: Record<string, unknown>) => [b.kind, b.title, b.start_local, b.start_tz, b.end_local ?? null]),
    [
      ["flight", "TP 1351", "2026-11-20T07:10", "Europe/London", "2026-11-20T09:45"],
      ["hotel", "Memmo Alfama", "2026-11-20T15:00", "Europe/Lisbon", "2026-11-23T11:00"],
      ["car", "Hertz", "2026-11-21T09:00", "Europe/Lisbon", "2026-11-22T18:00"],
      ["flight", "TP 1358", "2026-11-23T18:30", "Europe/Lisbon", "2026-11-23T21:05"],
    ],
  );
  assert.deepEqual(trip.bookings[0], {
    id: "tripit:air:440001:550001",
    kind: "flight",
    title: "TP 1351",
    provider: "TAP Air Portugal",
    reference: "XK7P2Q",
    segment: "TP 1351",
    start_local: "2026-11-20T07:10",
    start_tz: "Europe/London",
    start_place: "LHR T2",
    start_city: "London",
    end_local: "2026-11-20T09:45",
    end_tz: "Europe/Lisbon",
    end_place: "LIS T1",
    end_city: "Lisbon",
    seat: "22C",
    trip_destination: "Lisbon",
  });
  assert.equal(trip.bookings[1].provider, "Booking.com");
  assert.equal(trip.bookings[1].reference, "HTL998");
  assert.ok(!/£|€|total_cost|212\.40|540\.00/.test(JSON.stringify(r)), "no prices reach the tool's answer");
  // Every API call was a signed GET to api.tripit.com.
  for (const c of calls) {
    assert.equal(c.init.method, "GET");
    assert.equal(c.url.host, "api.tripit.com");
    assert.match(auth(c.init), /oauth_signature="/);
  }
});

test("list_trips: past trips, a train with coach and seat, one object given as an object rather than a list", async () => {
  routes = [API];
  const acct = await openTripIt(connector, secrets(), "UTC");
  const r = JSON.parse((await acct.call("list_trips", { when: "past" })).text);
  assert.deepEqual(r.trips.map((t: { name: string }) => t.name), ["Paris", "Rome"]);
  assert.deepEqual(r.trips[0].bookings[0], {
    id: "tripit:rail:440010:550010",
    kind: "train",
    title: "Eurostar 9014",
    provider: "Eurostar",
    reference: "EUR42Z",
    start_local: "2026-10-30T08:01",
    start_tz: "Europe/London",
    start_place: "London St Pancras International",
    start_city: "London",
    end_local: "2026-10-30T11:20",
    end_tz: "Europe/Paris",
    end_place: "Paris Gare du Nord",
    end_city: "Paris",
    seat: "Coach 7 seat 61",
    trip_destination: "Paris",
  });
  assert.match(calls.at(-1)!.url.pathname, /^\/v1\/list\/trip\/past\/true\/include_objects\/true\/page_num\/1\/page_size\/25\/format\/json$/);
});

test("paging: past trips page by TripIt's page_num, and next_cursor goes until max_page", async () => {
  routes = [(url, init) => (url.pathname.includes("/past/true/") ? { body: { ...T.TRIPIT_PAST, page_num: url.pathname.match(/page_num\/(\d+)/)![1], max_page: "2" } } : API(url, init))];
  const acct = await openTripIt(connector, secrets(), "UTC");
  const first = JSON.parse((await acct.call("list_trips", { when: "past" })).text);
  assert.equal(first.next_cursor, "2");
  const second = JSON.parse((await acct.call("list_trips", { when: "past", cursor: first.next_cursor })).text);
  assert.equal(second.next_cursor, undefined);
  assert.match(calls.at(-1)!.url.pathname, /page_num\/2\//);
});

test("a revoked or expired sign-in is needs_auth; no app saved says where to add it", async () => {
  routes = [API];
  const s = secrets();
  (s.tokens as { access_token: string }).access_token = "revoked";
  const err = await openTripIt(connector, s, "UTC").catch((e) => e);
  assert.equal(tripitAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "TripIt signed Athena out. Sign in again." });
  const noApp = await openTripIt(connector, { tokens: secrets().tokens }, "UTC").catch((e) => e);
  assert.match(directFailure(noApp)!.detail, /No TripIt app is saved/);
  const notYet = await openTripIt(connector, { ownClient: client }, "UTC").catch((e) => e);
  assert.equal(directFailure(notYet)!.detail, "Not signed in yet");
});
