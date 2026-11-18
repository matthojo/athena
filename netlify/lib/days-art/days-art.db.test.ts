// Real path for artwork and day maps: the real /api function, Postgres with every migration (0033 included) and a
// local Netlify Blobs server. Only the outside world is stubbed: the tile provider, TMDB and the image hosts.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days-art/days-art.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the art tables and the maps-art setting first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtHint, ArtRef } from "../../../lib/art";

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
const VISITS = [
  { start: "2026-11-03T08:00:00Z", end: "2026-11-03T08:40:00Z", lat: 51.55681, lng: -0.15172, name: "Home", place: "11111111-1111-4111-8111-111111111111" },
  { start: "2026-11-03T12:30:00Z", end: "2026-11-03T13:30:00Z", lat: 51.51241, lng: -0.12583, name: "Dishoom", venue: "Dishoom Covent Garden" },
  { start: "2026-11-03T15:00:00Z", end: "2026-11-03T16:30:00Z", lat: 51.5637, lng: -0.1657, name: "Hampstead Heath" },
  { start: "2026-11-03T19:00:00Z", end: "2026-11-03T23:59:00Z", lat: 51.55682, lng: -0.15171, name: "Home" },
];

test("Days art: day maps (no key, a refused key, a working key, cached, sealed) and artwork (allowlist, size cap, dedupe, cache headers)", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const sharp = (await import("sharp")).default;
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { sealText } = await import("../../../lib/data-box");
  const A = await import("../../../lib/art");
  const M = await import("../../../lib/static-map");

  // A local Blobs server, as Netlify runs it.
  const dir = mkdtempSync(join(tmpdir(), "athena-blobs-"));
  const server = new BlobsServer({ directory: dir, token: "blobs-token" });
  const { port } = await server.start();
  const store = (name: string) => getStore({ name, siteID: "athena-test", token: "blobs-token", edgeURL: `http://localhost:${port}` });
  A.useArtStore(() => store("athena-art"));
  M.useMapStore(() => store("athena-maps"));

  for (const t of ["art_sources", "art"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key = 'maps-art'`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND day = $1::date`, [DAY]);

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {}) => {
    const token = opts.token === undefined ? "master-token-for-tests" : opts.token;
    return api(
      new Request(`https://athena.test/api${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      {} as never,
    );
  };

  // ----- The tile provider, stubbed: answers 403 to a bad key, a plain tile otherwise. -----
  const tileUrls: URL[] = [];
  const tile = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#e8eaee" } }).png().toBuffer();
  M.mapDeps.assertPublic = async () => undefined;
  M.mapDeps.fetch = async (input) => {
    const u = new URL(String(input));
    tileUrls.push(u);
    if (u.searchParams.get("key") === "bad-key") return new Response("Invalid key", { status: 403 });
    return new Response(new Uint8Array(tile), { headers: { "content-type": "image/png" } });
  };

  try {
    // No sign-in, no map.
    assert.equal((await call("GET", `/days/${DAY}/map`, { token: null })).status, 401);
    assert.equal((await call("GET", "/art/AAAAAAAAAAAAAAAAAAAAAA", { token: null })).status, 401);

    // ----- No key: an honest state, nothing fetched. -----
    let res = await call("GET", `/days/${DAY}/map?theme=light`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { state: "no_key" });
    assert.equal(tileUrls.length, 0);
    let status = await (await call("GET", "/maps-art")).json();
    assert.equal(status.tiles, null);
    assert.equal(status.art_count, 0);

    // ----- A key the provider turns down is never kept. -----
    res = await call("POST", "/maps-art/tiles", { body: { provider: "maptiler", key: "bad-key" } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /didn't accept that key/);
    assert.equal((await (await call("GET", "/maps-art")).json()).tiles, null);

    // ----- A working key: kept sealed, a sample in both themes, never sent back. -----
    tileUrls.length = 0;
    res = await call("POST", "/maps-art/tiles", { body: { provider: "maptiler", key: " good-key-123 " } });
    assert.equal(res.status, 200);
    const added = await res.json();
    assert.equal(added.tiles.provider, "maptiler");
    assert.equal(added.tiles.status, "working");
    assert.match(added.preview.light, /^data:image\/webp;base64,/);
    assert.match(added.preview.dark, /^data:image\/webp;base64,/);
    assert.ok(tileUrls.every((u) => u.searchParams.get("key") === "good-key-123"), "the key is trimmed");
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'maps-art'`);
    assert.ok(!JSON.stringify(row.value).includes("good-key-123"), "sealed at rest");
    status = await (await call("GET", "/maps-art")).json();
    assert.ok(!JSON.stringify(status).includes("good-key"), "never sent back");
    res = await call("GET", "/maps-art/preview/dark");
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format, "webp");

    // ----- A day without places: nothing to draw. -----
    res = await call("GET", `/days/${DAY}/map`);
    assert.deepEqual(await res.json(), { state: "no_places" });

    // The day's places, sealed as lib/places-visits.ts keeps them.
    await qRaw(
      `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source) VALUES ('location', $1, $2, $3::timestamptz, $4::date, 'day')`,
      [`Places · ${DAY} · Merged`, sealText(JSON.stringify({ visits: VISITS, line: "Home, lunch at Dishoom, then Hampstead Heath", weather: null, places: {} })), `${DAY}T12:00:00Z`, DAY],
    );

    // ----- The map: drawn once, from tile numbers only. -----
    tileUrls.length = 0;
    res = await call("GET", `/days/${DAY}/map?theme=light`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
    assert.equal(res.headers.get("x-map-stops"), "3", "home twice is one marker");
    assert.equal(decodeURIComponent(res.headers.get("x-map-attribution")!), "© MapTiler © OpenStreetMap contributors");
    const etag = res.headers.get("etag")!;
    assert.match(etag, /^"[A-Za-z0-9_-]{22}"$/);
    const first = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(first).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 640]);
    assert.ok(tileUrls.length > 0);
    for (const u of tileUrls) {
      assert.match(u.toString(), /^https:\/\/api\.maptiler\.com\/maps\/dataviz\/256\/\d+\/\d+\/\d+@2x\.png\?key=good-key-123$/);
      const text = decodeURIComponent(u.toString()).toLowerCase();
      for (const v of VISITS) {
        assert.ok(!text.includes(v.name.toLowerCase()) && !text.includes(String(v.lat)) && !text.includes(String(v.lng)), "no names or coordinates");
      }
      assert.ok(!text.includes("1111"), "no ids");
    }

    // Again: from the cache, no tiles. With its ETag: 304.
    tileUrls.length = 0;
    res = await call("GET", `/days/${DAY}/map?theme=light`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(first));
    assert.equal(tileUrls.length, 0);
    res = await call("GET", `/days/${DAY}/map?theme=light`, { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 304);

    // Dark is its own map, from the dark style. The tall one too.
    res = await call("GET", `/days/${DAY}/map?theme=dark&size=tall`);
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get("etag"), etag);
    assert.ok(tileUrls.length > 0 && tileUrls.every((u) => u.pathname.startsWith("/maps/dataviz-dark/")));
    assert.deepEqual([(await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width], [840]);

    // What's kept in Blobs is sealed.
    const maps = await store("athena-maps").list();
    assert.ok(maps.blobs.length >= 4);
    for (const b of maps.blobs) {
      const raw = new Uint8Array((await store("athena-maps").get(b.key, { type: "arrayBuffer" }))!);
      assert.equal(Buffer.from(raw.subarray(0, 4)).toString("ascii"), "ATHF", `${b.key} is sealed`);
    }

    // A place changes: a new map (a new ETag), drawn again.
    await qRaw(`UPDATE sensitive_blobs SET ciphertext = $1 WHERE domain = 'location' AND source = 'day' AND day = $2::date`, [sealText(JSON.stringify({ visits: VISITS.slice(0, 2), line: null, weather: null, places: {} })), DAY]);
    tileUrls.length = 0;
    res = await call("GET", `/days/${DAY}/map?theme=light`);
    assert.notEqual(res.headers.get("etag"), etag);
    assert.ok(tileUrls.length > 0);

    // ----- Artwork -----
    const poster = await sharp({ create: { width: 1000, height: 1500, channels: 3, background: "#203a8f" } }).jpeg().toBuffer();
    const big = Buffer.alloc(A.MAX_SOURCE_BYTES + 10);
    big.set([0xff, 0xd8, 0xff]);
    const imageCalls: string[] = [];
    A.artDeps.assertPublic = async () => undefined;
    A.artDeps.fetch = async (input, init) => {
      const u = String(input);
      imageCalls.push(u);
      if (u.startsWith("https://api.themoviedb.org/3/search/movie")) {
        const auth = new URL(u).searchParams.get("api_key");
        if (auth !== "tmdb-good") return new Response("{}", { status: 401 });
        return Response.json({ results: [{ poster_path: "/paddington.jpg" }] });
      }
      if (u === "https://a.ltrbxd.com/poster-a.jpg" || u === "https://image.tmdb.org/t/p/w780/paddington.jpg") return new Response(new Uint8Array(poster));
      if (u === "https://i.scdn.co/image/same-bytes") return new Response(new Uint8Array(poster));
      if (u === "https://i.scdn.co/image/huge") return new Response(new Uint8Array(big));
      void init;
      return new Response("missing", { status: 404 });
    };
    const entries: Array<{ entry: { id: string; title: string; art?: ArtRef }; hints: ArtHint[] }> = [
      { entry: { id: "e1", title: "Past Lives" }, hints: [{ url: "https://a.ltrbxd.com/poster-a.jpg" }] },
      { entry: { id: "e2", title: "Past Lives again" }, hints: [{ url: "https://a.ltrbxd.com/poster-a.jpg" }] },
      { entry: { id: "e3", title: "The same bytes elsewhere" }, hints: [{ url: "https://i.scdn.co/image/same-bytes" }] },
      { entry: { id: "e4", title: "Not on the list" }, hints: [{ url: "https://evil.example/poster.jpg" }] },
      { entry: { id: "e5", title: "Too big" }, hints: [{ url: "https://i.scdn.co/image/huge" }] },
      { entry: { id: "e6", title: "Paddington 2" }, hints: [{ film: { title: "Paddington 2", year: 2017 } }] },
    ];
    let out = await A.attachArt(entries, { budgetMs: 10_000 });
    const art = out[0].art!;
    assert.ok(art && A.isArtId(art.id));
    assert.deepEqual([art.w, art.h], [533, 800]);
    assert.match(art.tone!, /^#[0-9a-f]{6}$/);
    assert.deepEqual(out[1].art, art, "the same address: the same art");
    assert.equal(out[2].art?.id, art.id, "the same bytes from another address: stored once");
    assert.equal(out[3].art, undefined, "not on the allowlist");
    assert.equal(out[4].art, undefined, "over the size cap");
    assert.equal(out[5].art, undefined, "no TMDB key: a title isn't looked up");
    assert.equal(imageCalls.filter((u) => u === "https://a.ltrbxd.com/poster-a.jpg").length, 1, "fetched once for two entries");
    assert.ok(!imageCalls.some((u) => u.includes("evil.example")), "never requested");
    assert.ok(!imageCalls.some((u) => u.includes("themoviedb")), "TMDB not asked without a key");
    assert.equal(Number((await qRaw<{ n: string }>(`SELECT count(*) AS n FROM art`))[0].n), 1);
    const sources = await qRaw<{ source_hash: string; art_id: string | null }>(`SELECT source_hash, art_id FROM art_sources`);
    assert.equal(sources.filter((s) => s.art_id === art.id).length, 2);
    assert.equal(sources.filter((s) => s.art_id === null).length, 2, "misses are remembered");
    assert.ok(sources.every((s) => !s.source_hash.includes("ltrbxd") && !s.source_hash.includes("http")), "sources are blind indexes");

    // A second pass: all from the database, nothing fetched.
    imageCalls.length = 0;
    out = await A.attachArt(entries, { budgetMs: 10_000 });
    assert.equal(out[0].art?.id, art.id);
    assert.equal(imageCalls.length, 0);

    // Kept sealed, in two sizes.
    for (const size of ["sm", "lg"]) {
      const raw = new Uint8Array((await store("athena-art").get(`${art.id}/${size}`, { type: "arrayBuffer" }))!);
      assert.equal(Buffer.from(raw.subarray(0, 4)).toString("ascii"), "ATHF");
    }

    // Served behind the token, cached for a year.
    res = await call("GET", `/art/${art.id}?size=sm`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const sm = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([sm.width, sm.height], [160, 240]);
    res = await call("GET", `/art/${art.id}?size=sm`, { headers: { "If-None-Match": res.headers.get("etag")! } });
    assert.equal(res.status, 304);
    assert.equal((await call("GET", "/art/not-an-id")).status, 404);
    assert.equal((await call("GET", "/art/BBBBBBBBBBBBBBBBBBBBBB")).status, 404);

    // ----- TMDB: a refused key isn't kept; a good one finds the poster for a title. -----
    res = await call("POST", "/maps-art/tmdb", { body: { key: "tmdb-bad" } });
    assert.equal(res.status, 400);
    res = await call("POST", "/maps-art/tmdb", { body: { key: "tmdb-good" } });
    assert.equal(res.status, 200);
    assert.match((await res.json()).preview.poster, /^data:image\/webp;base64,/);
    // The miss before the key was a skip, not a remembered miss: asked now.
    out = await A.attachArt([entries[5]], { budgetMs: 10_000 });
    assert.equal(out[0].art?.id, art.id, "the same poster bytes again: still one image");
    assert.equal((await (await call("GET", "/maps-art")).json()).art_count, 1);

    // ----- Removing the map key: back to the honest state. -----
    res = await call("DELETE", "/maps-art/tiles");
    assert.equal((await res.json()).tiles, null);
    assert.deepEqual(await (await call("GET", `/days/${DAY}/map`)).json(), { state: "no_key" });
    assert.equal((await call("GET", "/maps-art/preview/light")).status, 404);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    await qRaw(`DELETE FROM sensitive_blobs WHERE domain = 'location' AND day = $1::date`, [DAY]);
  }
});

test("The backfill on the collect tick: Days entries without art get it, a few at a time; posts never do", { skip: !url && "set ATHENA_TEST_DB_URL" }, async (t) => {
  const { qRaw } = await import("../../../lib/db");
  const [has] = await qRaw<{ t: string | null }>(`SELECT to_regclass('day_entries')::text AS t`);
  if (!has?.t) return t.skip("no day_entries table (claude/days-data's migration 0032 isn't applied here)");
  const sharp = (await import("sharp")).default;
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const A = await import("../../../lib/art");
  const { backfillDayArt } = await import("../../../lib/day-art-backfill");
  const dir = mkdtempSync(join(tmpdir(), "athena-blobs-"));
  const server = new BlobsServer({ directory: dir, token: "blobs-token" });
  const { port } = await server.start();
  A.useArtStore(() => getStore({ name: "athena-art", siteID: "athena-test", token: "blobs-token", edgeURL: `http://localhost:${port}` }));
  try {
    for (const tb of ["art_sources", "art", "day_entries"]) await qRaw(`DELETE FROM ${tb}`);
    const add = (kind: string, source: string, title: string, url: string | null, date: string, position: number) =>
      qRaw(`INSERT INTO day_entries (date, kind, source, external_id, ext_key, title, url, position) VALUES ($1::date, $2, $3, $4, $4, $5, $6, $7) RETURNING id`, [date, kind, source, `${source}-${title}`, title, url, position]);
    await add("played", "steam", "Hades", "https://store.steampowered.com/app/1145360/", "2026-11-06", 0);
    await add("listened", "spotify", "Red", "https://open.spotify.com/album/1EoDsNmgTLtmwe1BDAVxV5", "2026-11-05", 0);
    await add("posted", "bluesky", "A post", null, "2026-11-06", 1);
    await add("workout", "strava", "Run", null, "2026-11-06", 2);

    const header = await sharp({ create: { width: 460, height: 215, channels: 3, background: "#5a3a2a" } }).jpeg().toBuffer();
    const album = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#7a3040" } }).jpeg().toBuffer();
    const calls: string[] = [];
    A.artDeps.assertPublic = async () => undefined;
    A.artDeps.fetch = async (input) => {
      const u = String(input);
      calls.push(u);
      if (u.startsWith("https://shared.akamai.steamstatic.com/")) return new Response(new Uint8Array(header));
      if (u.startsWith("https://open.spotify.com/oembed")) return Response.json({ thumbnail_url: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02" });
      if (u.startsWith("https://image-cdn-ak.spotifycdn.com/")) return new Response(new Uint8Array(album));
      return new Response("no", { status: 404 });
    };

    const r = await backfillDayArt({ budgetMs: 10_000 });
    assert.deepEqual(r, { looked: 2, eligible: 2, found: 2 }, "only kinds that can have art are listed (lib/days.ts): workouts and posts are never looked at");
    const rows = await qRaw<{ title: string; art: { id: string; w: number; h: number; tone?: string } | null }>(`SELECT title, art FROM day_entries ORDER BY title`);
    const by = Object.fromEntries(rows.map((x) => [x.title, x.art]));
    assert.deepEqual([by["Hades"]?.w, by["Hades"]?.h], [460, 215]);
    assert.deepEqual([by["Red"]?.w, by["Red"]?.h], [300, 300]);
    assert.match(by["Red"]!.tone!, /^#[0-9a-f]{6}$/);
    assert.equal(by["A post"], null);
    assert.equal(by["Run"], null);
    assert.ok(!calls.some((c) => c.includes("bluesky")), "nothing asked for the post");

    // The next tick: nothing that can have art is left, and nothing is fetched.
    calls.length = 0;
    assert.deepEqual(await backfillDayArt({ budgetMs: 10_000 }), { looked: 0, eligible: 0, found: 0 });
    assert.equal(calls.length, 0);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    await qRaw(`DELETE FROM day_entries`);
  }
});
