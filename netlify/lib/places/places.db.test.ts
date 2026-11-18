// Real path for places: the real /api function (status, the Timeline import, names, a Place's visits), a real Life log run
// (executeRun) that syncs Swarm without Claude, the runner's Life log save (AthenaWriter), and Postgres with every migration (0031 included).
// Outside services are stubbed: Foursquare, Nominatim and Open-Meteo answer from here.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/places/places.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties connectors, collections, Life log notes, places and location rows first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

const DAY = "2026-11-03";
const at = (hhmm: string) => Math.floor(Date.parse(`${DAY}T${hhmm}:00Z`) / 1000);

test("Places: a Timeline import plus Swarm make one sealed day, with a places line and a weather line on the Day", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { AthenaWriter, executeRun } = await import("../connectors/runner");
  const { qRaw, getNote } = await import("../../../lib/db");
  const C = await import("../../../lib/connectors");
  const P = await import("../../../lib/places-visits");
  const { parseTimeline, groupVisitsByDay } = await import("../../../lib/places-timeline");
  const { lifeRetryWaits } = await import("../connectors/lifelog-b-http");

  for (const t of ["collected_items", "collection_runs", "collections", "connectors", "place_geo", "location_cache", "location_todo"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM notes WHERE source LIKE 'life-log%'`);
  for (const t of ["day_entries", "days"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM places`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('location', 'health')`);
  await qRaw(`DELETE FROM settings WHERE key = 'swarm_backfill'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  // ---- the outside world, stubbed ----
  lifeRetryWaits.ms = [1, 1];
  P.lookupDeps.gapMs = 5;
  const seen = { nominatim: [] as URL[], meteo: [] as URL[], swarm: [] as URL[], agent: [] as string[] };
  const SWARM_ITEMS = [
    // During the Timeline's lunch visit: the same visit, named by Swarm.
    { id: "ck-lunch", createdAt: at("13:08"), type: "checkin", venue: { id: "4ac5dishoom", name: "Dishoom", location: { lat: 51.51245, lng: -0.12705, city: "London" }, categories: [{ name: "Indian Restaurant", primary: true }] } },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.host === "api.foursquare.com") {
      seen.swarm.push(u);
      if (u.pathname === "/v2/users/self") return reply({ meta: { code: 200 }, response: { user: { id: "1" } } });
      const after = Number(u.searchParams.get("afterTimestamp") || 0);
      const before = Number(u.searchParams.get("beforeTimestamp") || Infinity);
      return reply({ meta: { code: 200 }, response: { checkins: { items: SWARM_ITEMS.filter((c) => c.createdAt >= after && c.createdAt < before) } } });
    }
    if (u.host === "nominatim.openstreetmap.org") {
      seen.nominatim.push(u);
      seen.agent.push(String(new Headers(init.headers).get("User-Agent")));
      const lat = Number(u.searchParams.get("lat"));
      if (Math.abs(lat - 51.5608) < 0.001) return reply({ category: "leisure", type: "park", name: "Hampstead Heath", address: { city: "London", suburb: "Hampstead" } });
      if (Math.abs(lat - 51.556) < 0.001) return reply({ category: "highway", type: "residential", name: "Example Road", address: { road: "Example Road", suburb: "Kentish Town", city: "London" } });
      if (Math.abs(lat - 51.5136) < 0.001) return reply({ category: "office", type: "company", name: "Some Office", address: { road: "Wardour Street", city: "London", suburb: "Soho" } });
      return reply({ error: "Unable to geocode" });
    }
    if (u.host.endsWith("open-meteo.com")) {
      seen.meteo.push(u);
      const d = u.searchParams.get("start_date")!;
      return reply({ daily: { time: [d], temperature_2m_max: [13.6], weather_code: [63], precipitation_sum: [5.1] } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const routes = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return JSON.parse(await res.text());
  };

  try {
    // ---- status: full access only ----
    assert.equal((await call("GET", "/places/status", undefined, "")).status, 401);
    let r = await call("GET", "/places/status");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.days, 0);
    assert.equal(r.json.tz, "Europe/London");

    // ---- the Timeline import, as the browser sends it ----
    const parsed = parseTimeline(readFileSync(new URL("../../../lib/fixtures/timeline-android.json", import.meta.url), "utf8"));
    const days = groupVisitsByDay(parsed.visits, "Europe/London");
    assert.equal((await call("POST", "/places/timeline", { days: [{ date: DAY, visits: [{ ...days[0].visits[0], address: "1 Example Road" }] }] })).status, 400, "only visit fields");
    r = await call("POST", "/places/timeline", { days });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ days: r.json.days, added: r.json.added, unchanged: r.json.unchanged }, { days: 1, added: 4, unchanged: 0 });
    assert.ok(r.json.waiting >= 1, "lunch and the heath wait for names");
    assert.equal(seen.nominatim.length, 0, "an import never asks the map itself");

    // Sealed at rest: the labels say the day and source, nothing else; the database refuses a readable day.
    const rows = await qRaw<{ source: string; label: string; ciphertext: string }>(`SELECT source, label, ciphertext FROM sensitive_blobs WHERE domain = 'location' ORDER BY source`);
    assert.deepEqual(rows.map((x) => x.source), ["day", "timeline"]);
    for (const x of rows) {
      assert.match(x.ciphertext, /^enc:v1:/);
      assert.match(x.label, /^Places · 2026-11-03 · (Merged|Google Maps Timeline)$/);
      assert.ok(!/51\.5|ChIJ|Dishoom/.test(x.label + x.ciphertext));
    }
    await assert.rejects(qRaw(`INSERT INTO sensitive_blobs (domain, label, ciphertext, day, source) VALUES ('location', 'x', '{"visits":[]}', '2026-11-02', 'timeline')`));
    await assert.rejects(qRaw(`INSERT INTO place_geo (place_id, sealed) SELECT id, '{"lat":51.5}' FROM places LIMIT 1`));
    const geo = await qRaw<{ sealed: string }>(`SELECT sealed FROM place_geo`);
    assert.ok(geo.length >= 2 && geo.every((g) => g.sealed.startsWith("enc:v1:")), "Home and Work, sealed");

    // ---- a Life log reading Swarm: the run syncs it without Claude, then names what's waiting ----
    const swarm = await routes("POST", "/connectors", { provider: "swarm", name: "Swarm", account_label: "personal", client_id: "FSQID", client_secret: "fsq-secret" });
    assert.ok(swarm.id, JSON.stringify(swarm));
    await C.updateConnectorSecrets(swarm.id, (s) => {
      s.tokens = { access_token: "fsq-token", obtained_at: Date.now() };
    });
    const life = await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [swarm.id], schedule: "daily", run_at: "23:30" });
    const collection = (await C.getCollection(life.id))!;
    const run = await C.queueRun(life.id, "manual");
    await executeRun(run.id, new Date());
    const [done] = await qRaw<{ status: string; error: string | null; summary: string | null }>(`SELECT status, error, summary FROM collection_runs WHERE id = $1`, [run.id]);
    assert.equal(done.status, "succeeded", done.error ?? "");
    assert.ok(seen.swarm.every((u) => u.searchParams.get("oauth_token") === "fsq-token"));
    assert.ok(seen.swarm.some((u) => u.pathname === "/v2/users/self/checkins"));
    assert.ok(seen.nominatim.length >= 1, "the run named what was waiting");
    for (const u of seen.nominatim) assert.deepEqual([...u.searchParams.keys()].sort(), ["accept-language", "addressdetails", "format", "lat", "lon", "zoom"]);
    assert.ok(seen.agent.every((a) => a === P.NOMINATIM_AGENT && !/@|jordan/i.test(a)));

    // One Day: lunch is one visit named by Swarm, the heath by the map, the weather for where most of the day was. No note.
    const { getDay } = await import("../../../lib/days");
    const dayOf = async (opts: { places?: boolean } = {}) => (await getDay(DAY, { tz: "Europe/London", ...opts }))!;
    let day = await dayOf();
    const LINES = ["Work, lunch at Dishoom, then Hampstead Heath", "14° and rain in London"];
    assert.deepEqual([day.places_line, day.weather], LINES, JSON.stringify(day));
    assert.ok(day.places.some((p) => p.name === "Dishoom" && p.id));
    assert.ok(!/51\.|-0\.1|ChIJ/.test(JSON.stringify(day)), "no coordinates or ids in the day");
    assert.equal((await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM notes WHERE source LIKE 'life-log%'`))[0].n, 0, "no day note");
    const [merged] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'location' AND source = 'day' AND day = $1`, [DAY]);
    const { openStrict } = await import("../../../lib/data-box");
    const record = JSON.parse(openStrict(merged.ciphertext)) as { visits: Array<{ name?: string; swarm?: boolean; timeline?: boolean }> };
    assert.equal(record.visits.filter((v) => v.name === "Dishoom").length, 1, "the check-in and the Timeline visit are one");
    assert.ok(record.visits.find((v) => v.name === "Dishoom")!.swarm && record.visits.find((v) => v.name === "Dishoom")!.timeline);
    assert.equal(seen.meteo.length, 1, "one weather request for the day");
    assert.equal(seen.meteo[0].searchParams.get("latitude"), "51.56", "where most of the day was: home, rounded");

    // ---- a Life log run writes the day's entries: the places stay where they are ----
    const writer = new AthenaWriter(collection, "00000000-0000-0000-0000-000000000000", { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0 } as never, new Date(), "Europe/London");
    await writer.run("athena_day_entry", { date: DAY, entries: [{ kind: "watched", source: "trakt", external_id: "h-1", title: "Severance", subtitle: "S2E1" }] });
    day = await dayOf();
    assert.deepEqual([day.places_line, day.weather], LINES);
    assert.deepEqual(day.entries.filter((e) => e.source !== "places").map((e) => e.title), ["Severance"]);
    assert.deepEqual(day.entries.filter((e) => e.source === "places").map((e) => e.title), ["Home", "Work", "Dishoom", "Hampstead Heath"], "the stops as entries");

    // ---- the Place page's line ----
    const [dishoom] = await qRaw<{ id: string }>(`SELECT id FROM places WHERE name = 'Dishoom'`);
    const [heath] = await qRaw<{ id: string; address: string }>(`SELECT id, address FROM places WHERE name = 'Hampstead Heath'`);
    assert.ok(dishoom && heath, "named stops became Places");
    r = await call("GET", `/places/${dishoom.id}/visits`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ count: r.json.visits.count, days: r.json.visits.days, last: r.json.visits.last }, { count: 1, days: 1, last: DAY });

    // ---- again, nothing doubles: the same file, the same check-ins ----
    const lookups = seen.nominatim.length;
    r = await call("POST", "/places/timeline", { days });
    assert.deepEqual({ added: r.json.added, unchanged: r.json.unchanged }, { added: 0, unchanged: 1 });
    await executeRun((await C.queueRun(life.id, "manual")).id, new Date());
    r = await call("GET", `/places/${dishoom.id}/visits`);
    assert.equal(r.json.visits.count, 1);
    assert.equal(seen.nominatim.length, lookups, "names come from the cache");
    day = await dayOf();
    assert.deepEqual([day.places_line, day.weather], LINES);
    r = await call("POST", "/places/names");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.waiting, 0);
    r = await call("GET", "/places/status");
    assert.deepEqual({ days: r.json.days, first: r.json.first, waiting: r.json.waiting, swarm: r.json.swarm, life_log: r.json.life_log }, { days: 1, first: DAY, waiting: 0, swarm: true, life_log: "Life log" });

    // ---- Ask doesn't see it unless asked about places ----
    assert.ok(!JSON.stringify(await dayOf({ places: false })).includes("Dishoom"));

    // ---- rotation re-seals ----
    const before = await qRaw<{ n: string }>(`SELECT count(*) AS n FROM sensitive_blobs WHERE domain = 'location'`);
    assert.deepEqual(await P.resealPlaces(), { resealed: 0, failed: 0 }, "nothing under an old key");
    assert.equal((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM sensitive_blobs WHERE domain = 'location'`))[0].n, before[0].n);
  } finally {
    globalThis.fetch = realFetch;
  }
});
