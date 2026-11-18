// Run: npx tsx --test netlify/lib/connectors/live-travel-direct.test.ts
// "Check connection" for Google Maps routes, TfL and National Rail: one small read-only call each, fetch stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_FROM, CHECK_TO, checkTravelKey, liveTravelAdapter, TFL_CHECK_URL, TravelKeyError } from "./live-travel-direct";
import { directFor } from "./direct";
import { GOOGLE_ROUTES_URL } from "../proactive/directions";
import { RDM_BOARD_URL } from "../live-travel";
import { presetFor } from "../../../lib/connector-presets";
import { TRAVEL_KEY_PROVIDERS } from "../../../lib/presets/live-travel";

function stub(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { f, calls };
}

const KEY = "sekret-travel-key-123";

test("Google: one walking route between two fixed points, key in a header, asking only for the duration", async () => {
  const { f, calls } = stub(200, { routes: [{ duration: "120s" }] });
  await checkTravelKey("google-routes", KEY, f);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOGLE_ROUTES_URL);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Goog-Api-Key"], KEY);
  assert.equal(headers["X-Goog-FieldMask"], "routes.duration");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { origin: { location: { latLng: CHECK_FROM } }, destination: { location: { latLng: CHECK_TO } }, travelMode: "WALK" });
  assert.ok(calls[0].init.signal, "the check has a timeout");
  assert.ok(!calls[0].url.includes(KEY), "the key isn't in the address");
});

test("TfL: one line's status, a GET with the app key", async () => {
  const { f, calls } = stub(200, []);
  await checkTravelKey("tfl", KEY, f);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, TFL_CHECK_URL);
  assert.deepEqual([...u.searchParams.keys()], ["app_key"]);
  assert.equal(u.searchParams.get("app_key"), KEY);
  assert.equal(calls[0].init.method ?? "GET", "GET");
});

test("National Rail: one row of King's Cross's board, key in the x-apikey header", async () => {
  const { f, calls } = stub(200, { trainServices: [] });
  await checkTravelKey("national-rail", KEY, f);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, `${RDM_BOARD_URL}/KGX`);
  assert.equal(u.searchParams.get("numRows"), "1");
  assert.equal((calls[0].init.headers as Record<string, string>)["x-apikey"], KEY);
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].init.method ?? "GET", "GET");
});

test("a refused key asks the owner to fix it, and the message never holds the key", async () => {
  for (const [kind, status] of [["google-routes", 400], ["google-routes", 403], ["tfl", 401], ["national-rail", 403]] as const) {
    const err = await checkTravelKey(kind, KEY, stub(status).f).then(() => null, (e) => e);
    assert.ok(err instanceof TravelKeyError, `${kind} ${status}`);
    assert.equal(err.owner, true);
    assert.ok(!err.message.includes(KEY));
    assert.deepEqual(liveTravelAdapter.failure(err)?.status, "needs_auth");
    assert.equal(liveTravelAdapter.accountProblem(err), true);
  }
  const busy = await checkTravelKey("tfl", KEY, stub(503).f).then(() => null, (e) => e);
  assert.equal(busy.owner, false);
  assert.equal(liveTravelAdapter.failure(busy)?.status, "error");
  const empty = await checkTravelKey("tfl", "  ", stub().f).then(() => null, (e) => e);
  assert.equal(empty.owner, true);
});

test("each preset is a paste-a-key travel source Athena reads itself: no tools, no recipe", () => {
  for (const id of TRAVEL_KEY_PROVIDERS) {
    const p = presetFor(id);
    assert.equal(p.id, id);
    assert.equal(p.category, "travel");
    assert.equal(p.auth, "token");
    assert.deepEqual(p.recipes, []);
    assert.deepEqual(p.readTools, []);
    assert.ok(p.live && p.setup?.steps.length);
    assert.equal(directFor({ provider: id, auth_type: "token", oauth: {} })?.id, "live-travel");
    assert.deepEqual(liveTravelAdapter.tools({ provider: id, scope: "" }), []);
  }
});
