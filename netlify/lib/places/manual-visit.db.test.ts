// A place visit added by hand, through the real /api function and Postgres with every migration: for someone with no Swarm
// and no Timeline file. A saved Place (its address on the map) and a typed address (named by the map), each on the day, on
// the Place's visits and gone again when removed. Nominatim and Open-Meteo answer from here.
// Other tests share this database: this one uses its own day and Places, and leaves everything else alone.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/places/manual-visit.db.test.ts
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

const DAY = "2025-03-14";

test("Places by hand: a visit to a saved Place or a typed address, on the day and the Place, and removed again", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const P = await import("../../../lib/places-visits");

  // This test's own day and Places, from any earlier run.
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND day = $1::date`, [DAY]);
  await qRaw(`DELETE FROM places WHERE name IN ('Manual Test Café', 'Corner Bakery Test', 'No Address Test')`);
  const { blindIndex } = await import("../../../lib/data-box");
  const keys = ["1 Manual Test Lane, Testtown", "4 Bakery Test Row, Testquay", "Nowhere At All"].map((a) => blindIndex("other", `addr:${P.addressKey(a)}`));
  await qRaw(`DELETE FROM location_cache WHERE key = ANY($1::text[])`, [keys]);

  P.lookupDeps.gapMs = 5;
  const seen = { search: [] as URL[], reverse: [] as URL[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.host === "nominatim.openstreetmap.org" && u.pathname === "/search") {
      seen.search.push(u);
      const q = u.searchParams.get("q") ?? "";
      if (/Manual Test Lane/.test(q)) return reply([{ lat: "50.10101", lon: "-4.20202" }]);
      if (/Bakery Test Row/.test(q)) return reply([{ lat: "50.30303", lon: "-4.40404" }]);
      return reply([]);
    }
    if (u.host === "nominatim.openstreetmap.org") {
      seen.reverse.push(u);
      if (Math.abs(Number(u.searchParams.get("lat")) - 50.30303) < 0.001) return reply({ category: "shop", type: "bakery", name: "Corner Bakery Test", address: { road: "Bakery Test Row", town: "Testquay" } });
      return reply({ error: "Unable to geocode" });
    }
    if (u.host.endsWith("open-meteo.com")) {
      const d = u.searchParams.get("start_date")!;
      return reply({ daily: { time: [d], temperature_2m_max: [11.2], weather_code: [3], precipitation_sum: [0] } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const dayPlaces = async () => ((await call("GET", `/days/${DAY}`)).json.places as Array<{ id?: string; name: string; minutes?: number }>) ?? [];

  try {
    // Full access only.
    assert.equal((await call("GET", "/places/visits/manual", undefined, "")).status, 401);
    assert.equal((await call("POST", "/places/visits/manual", { date: DAY, time: "12:00", minutes: 30, address: "1 Manual Test Lane" }, "")).status, 401);

    const made = await call("POST", "/places", { name: "Manual Test Café", address: "1 Manual Test Lane, Testtown" });
    assert.ok(made.status === 200 || made.status === 201, made.text);
    const cafe = made.json as { id: string };
    const bare = (await call("POST", "/places", { name: "No Address Test" })).json as { id: string };

    // ---- a saved Place: its address looked up once, the visit on the day and the Place ----
    let r = await call("POST", "/places/visits/manual", { date: DAY, time: "12:40", minutes: 75, place_id: cafe.id });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.visit.name, "Manual Test Café");
    assert.equal(r.json.visit.minutes, 75);
    assert.equal(r.json.visit.date, DAY);
    assert.equal(seen.search.length, 1);
    assert.equal("lat" in r.json.visit, false, "no coordinates go back");
    const first = r.json.visit.id as string;
    let stops = await dayPlaces();
    assert.deepEqual(stops.find((s) => s.id === cafe.id), { id: cafe.id, name: "Manual Test Café", minutes: 75 });
    r = await call("GET", `/places/${cafe.id}/visits`);
    assert.equal(r.json.visits.count, 1);
    assert.equal(r.json.visits.last, DAY);
    // A second visit to it the same day: no second lookup (the Place has its spot now), two visits on the Place.
    r = await call("POST", "/places/visits/manual", { date: DAY, time: "18:00", minutes: 30, place_id: cafe.id });
    assert.equal(r.status, 201, r.text);
    const again = r.json.visit.id as string;
    assert.equal(seen.search.length, 1);
    assert.equal((await call("GET", `/places/${cafe.id}/visits`)).json.visits.count, 2);

    // ---- a typed address with no name: the map names it, and it becomes a Place with that address ----
    r = await call("POST", "/places/visits/manual", { date: DAY, time: "15:10", minutes: 20, address: "4 Bakery Test Row, Testquay" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.visit.name, "Corner Bakery Test", "named by the map");
    assert.equal(r.json.visit.address, "4 Bakery Test Row, Testquay");
    const typed = r.json.visit.id as string;
    stops = await dayPlaces();
    const bakery = stops.find((s) => s.name === "Corner Bakery Test");
    assert.ok(bakery?.id, JSON.stringify(stops));
    assert.equal((await call("GET", `/places/${bakery!.id}`)).json.address, "4 Bakery Test Row, Testquay");
    assert.match((await call("GET", `/days/${DAY}`)).json.places_line, /Manual Test Café.*Corner Bakery Test/);

    // ---- refused ----
    assert.equal((await call("POST", "/places/visits/manual", { date: DAY, time: "12:00", minutes: 30, address: "Nowhere At All" })).status, 400);
    const noAddress = await call("POST", "/places/visits/manual", { date: DAY, time: "12:00", minutes: 30, place_id: bare.id });
    assert.equal(noAddress.status, 400);
    assert.match(noAddress.json.error, /has no address yet/);
    assert.equal((await call("POST", "/places/visits/manual", { date: "2999-01-01", time: "12:00", minutes: 30, place_id: cafe.id })).status, 400);
    assert.equal((await call("POST", "/places/visits/manual", { date: DAY, time: "12:00", minutes: 30, place_id: cafe.id, address: "x y z w" })).status, 400);
    assert.equal((await call("POST", "/places/visits/manual", { date: DAY, time: "12:00", minutes: 30, place_id: "00000000-0000-4000-8000-000000000000" })).status, 404);

    // ---- listed, newest first, and sealed at rest ----
    r = await call("GET", `/places/visits/manual?date=${DAY}`);
    assert.deepEqual(r.json.visits.map((v: { id: string }) => v.id), [again, typed, first]);
    const [row] = await qRaw<{ label: string; ciphertext: string }>(`SELECT label, ciphertext FROM sensitive_blobs WHERE domain = 'location' AND source = 'manual' AND day = $1::date`, [DAY]);
    assert.equal(row.label, `Places · ${DAY} · Added by hand`);
    assert.match(row.ciphertext, /^enc:v1:/);
    assert.doesNotMatch(row.ciphertext, /Bakery|Manual Test/);

    // ---- removed: the day is rebuilt ----
    assert.equal((await call("DELETE", `/places/visits/manual?date=${DAY}&id=${first}`)).status, 200);
    assert.equal((await call("DELETE", `/places/visits/manual?date=${DAY}&id=${first}`)).status, 404);
    assert.equal((await call("GET", `/places/${cafe.id}/visits`)).json.visits.count, 1);
    assert.equal((await call("DELETE", `/places/visits/manual?date=${DAY}&id=${again}`)).status, 200);
    assert.equal((await call("GET", `/places/${cafe.id}/visits`)).json.visits, null, "no visits left on the Place");
    assert.equal((await dayPlaces()).length, 1);
    assert.equal((await call("DELETE", `/places/visits/manual?date=${DAY}&id=${typed}`)).status, 200);
    assert.deepEqual(await dayPlaces(), []);
    const left = await qRaw(`SELECT source FROM sensitive_blobs WHERE domain = 'location' AND day = $1::date`, [DAY]);
    assert.deepEqual(left, [], "nothing left for the day: it's no longer a day of places");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const MERGE_DAY = "2025-03-15";
const MERGE_DAY_CHECKIN = "2025-03-16";

test("Places by hand: a visit that overlaps a Timeline visit or a check-in there is that stop, and taking it out leaves the other", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const P = await import("../../../lib/places-visits");

  // This test's own days and Places, from any earlier run.
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND day = ANY($1::date[])`, [[MERGE_DAY, MERGE_DAY_CHECKIN]]);
  await qRaw(`DELETE FROM places WHERE name IN ('Merge Test Deli', 'Merge Test Timeline Spot', 'Merge Test Bar')`);
  const { blindIndex } = await import("../../../lib/data-box");
  await qRaw(`DELETE FROM location_cache WHERE key = $1`, [blindIndex("other", `addr:${P.addressKey("7 Merge Test Lane, Testmouth")}`)]);

  P.lookupDeps.gapMs = 5;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.host === "nominatim.openstreetmap.org" && u.pathname === "/search") return reply(/Merge Test Lane/.test(u.searchParams.get("q") ?? "") ? [{ lat: "50.50505", lon: "-4.60606" }] : []);
    if (u.host === "nominatim.openstreetmap.org") return reply({ error: "Unable to geocode" });
    if (u.host.endsWith("open-meteo.com")) {
      const d = u.searchParams.get("start_date")!;
      return reply({ daily: { time: [d], temperature_2m_max: [9.5], weather_code: [61], precipitation_sum: [2] } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const dayPlaces = async (day: string) => ((await call("GET", `/days/${day}`)).json.places as Array<{ id?: string; name: string; minutes?: number }>) ?? [];
  const count = async (id: string) => ((await call("GET", `/places/${id}/visits`)).json.visits?.count as number | undefined) ?? 0;
  const placeNamed = async (name: string) => (await qRaw<{ id: string }>(`SELECT id FROM places WHERE name = $1`, [name]))[0]?.id;

  try {
    const deli = (await call("POST", "/places", { name: "Merge Test Deli", address: "7 Merge Test Lane, Testmouth" })).json as { id: string };

    // ---- added by hand first, then the Timeline file: one stop, the Place counts one visit ----
    let r = await call("POST", "/places/visits/manual", { date: MERGE_DAY, time: "12:15", minutes: 60, place_id: deli.id });
    assert.equal(r.status, 201, r.text);
    const byHand = r.json.visit.id as string;
    assert.equal(await count(deli.id), 1);
    // 200 m off (the Timeline's own spot) and 12:00 to 13:30: the same stop.
    r = await call("POST", "/places/timeline", { days: [{ date: MERGE_DAY, visits: [{ start: `${MERGE_DAY}T12:00:00Z`, end: `${MERGE_DAY}T13:30:00Z`, lat: 50.50685, lng: -4.60606, name: "Merge Test Timeline Spot" }] }] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await dayPlaces(MERGE_DAY), [{ id: deli.id, name: "Merge Test Deli", minutes: 90 }], "one stop, the Timeline's times, the Place it was added to");
    assert.equal(await count(deli.id), 1, "counted once");
    assert.equal(await placeNamed("Merge Test Timeline Spot"), undefined, "no second Place for the same stop");
    r = await call("GET", `/places/visits/manual?date=${MERGE_DAY}`);
    assert.deepEqual(r.json.visits.map((v: { id: string; name: string; place_id?: string }) => [v.id, v.name, v.place_id]), [[byHand, "Merge Test Deli", deli.id]]);

    // ---- taken out: the Timeline visit stays, named the Timeline's way ----
    assert.equal((await call("DELETE", `/places/visits/manual?date=${MERGE_DAY}&id=${byHand}`)).status, 200);
    const stops = await dayPlaces(MERGE_DAY);
    assert.deepEqual(stops.map((s) => [s.name, s.minutes]), [["Merge Test Timeline Spot", 90]]);
    assert.equal(await count(deli.id), 0);

    // ---- a Swarm check-in first, then added by hand: one stop, and the visit by hand says how long ----
    await P.saveCheckins(new Map([[MERGE_DAY_CHECKIN, [{ id: "merge-test-checkin", at: `${MERGE_DAY_CHECKIN}T19:05:00Z`, lat: 50.50505, lng: -4.60306, venue: "Merge Test Bar", venue_id: "fsq-merge-test" }]]]), "replace");
    assert.deepEqual((await dayPlaces(MERGE_DAY_CHECKIN)).map((s) => s.name), ["Merge Test Bar"]);
    r = await call("POST", "/places/visits/manual", { date: MERGE_DAY_CHECKIN, time: "19:00", minutes: 120, place_id: deli.id });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(await dayPlaces(MERGE_DAY_CHECKIN), [{ id: deli.id, name: "Merge Test Deli", minutes: 120 }]);
    assert.equal(await count(deli.id), 1);
    assert.equal(await count((await placeNamed("Merge Test Bar"))!), 0, "the venue's Place doesn't count it as well");
    assert.equal((await call("DELETE", `/places/visits/manual?date=${MERGE_DAY_CHECKIN}&id=${r.json.visit.id}`)).status, 200);
    assert.deepEqual((await dayPlaces(MERGE_DAY_CHECKIN)).map((s) => s.name), ["Merge Test Bar"], "the check-in stays");
  } finally {
    globalThis.fetch = realFetch;
    await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND day = ANY($1::date[])`, [[MERGE_DAY, MERGE_DAY_CHECKIN]]);
  }
});
