// Real path for rich links, stage 1: the real /api function on Postgres with every migration (0040 included) and a
// local Netlify Blobs server. Pages come from a local server through Saved's guarded page reader (its seams opened
// for 127.0.0.1); tiles from a stubbed provider. Covers link previews (read, kept, sealed, the address not kept,
// pictures and their headers, refresh after 30 days, a failed refresh keeping the last good one, failures kept
// briefly, refresh=1, the rate limit), one-pin maps for a Place and a map link, and content-link sync with modes.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/rich-links/rich-links.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

const fixture = (name: string) => readFileSync(new URL(`../../../lib/fixtures/${name}`, import.meta.url));
const TOKEN = "master-token-for-tests";

test("Rich links: link previews, one-pin maps and content links with modes", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const sharp = (await import("sharp")).default;
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const api = (await import("../../functions/api")).default;
  const { qRaw, syncContentLinks } = await import("../../../lib/db");
  const { sealText, blindIndex } = await import("../../../lib/data-box");
  const blindIndexOf = (norm: string) => blindIndex("other", `addr:${norm}`)!;
  const { formatAthenaLink, formatWebLink } = await import("../../../lib/links");
  const { createApiKey } = await import("../../../lib/api-keys");
  const P = await import("../../../lib/link-previews");
  const M = await import("../../../lib/static-map");
  const { pageDeps } = await import("../../../lib/saved-fetch");

  // ----- A local site: an article, its picture and favicon, a failing page, and a switch to break it. -----
  const wide = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3a6ea5" } }).png().toBuffer();
  const icon = await sharp({ create: { width: 180, height: 180, channels: 4, background: "#d0342c" } }).png().toBuffer();
  const hits: string[] = [];
  let down = false;
  const site = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (down) return res.writeHead(500).end();
    if (req.url?.startsWith("/walks/canal")) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fixture("link-previews/walk.html"));
    if (req.url === "/images/canal-wide.png") return res.writeHead(200, { "content-type": "image/png" }).end(wide);
    if (req.url === "/icons/touch.png") return res.writeHead(200, { "content-type": "image/png" }).end(icon);
    if (req.url?.startsWith("/n/")) return res.writeHead(200, { "content-type": "text/html" }).end(`<title>Page ${req.url}</title>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  pageDeps.fetch = (input, init) => fetch(input, init);
  pageDeps.assertPublic = async () => undefined;
  pageDeps.upgrade = (u) => u;
  // The preview key is the https form of the address; the local server only speaks http, so read it as http.
  P.previewDeps.fetchHtml = async (u) => (await import("../../../lib/saved-fetch")).fetchPageHtml(u.replace(/^https:/, "http:"));
  P.previewDeps.fetchImage = async (u, max) => (await import("../../../lib/saved-fetch")).fetchPageImage(u.replace(/^https:/, "http:"), max);

  // A local Blobs server, as Netlify runs it.
  const dir = mkdtempSync(join(tmpdir(), "athena-blobs-"));
  const blobs = new BlobsServer({ directory: dir, token: "blobs-token" });
  const { port } = await blobs.start();
  const store = (name: string) => getStore({ name, siteID: "athena-test", token: "blobs-token", edgeURL: `http://localhost:${port}` });
  P.usePreviewStore(() => store("athena-link-previews"));
  M.useMapStore(() => store("athena-maps"));

  await qRaw(`DELETE FROM link_previews`);
  await qRaw(`DELETE FROM saved_rate`);
  await qRaw(`DELETE FROM settings WHERE key = 'maps-art'`);

  const call = async (path: string, opts: { token?: string | null; method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    return api(
      new Request(`https://athena.test/api${path}`, {
        method: opts.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      {} as never,
    );
  };
  const preview = async (address: string, extra = "") => {
    const res = await call(`/link-preview?url=${encodeURIComponent(address)}${extra}`);
    return { status: res.status, body: await res.json() };
  };
  const page = (path: string) => `${origin.replace("http:", "https:")}${path}`;

  try {
    // ----- Auth: the app's token or a full key, never a capture key or nothing. -----
    const capture = (await createApiKey("Extension", "capture")).token;
    for (const path of ["/link-preview?url=https%3A%2F%2Fa.example", "/link-map?url=x", "/places/11111111-1111-4111-8111-111111111111/map"]) {
      assert.equal((await call(path, { token: null })).status, 401, path);
      assert.equal((await call(path, { token: capture })).status, 401, `${path} with a capture key`);
    }
    assert.equal((await call("/link-preview?url=https%3A%2F%2Fa.example", { method: "POST" })).status, 405);

    // ----- Not a web address. -----
    let r = await preview("javascript:alert(1)");
    assert.deepEqual([r.status, r.body.error], [400, "That isn't a web address."]);
    assert.equal((await preview("")).status, 400);

    // ----- A page read once, through the guarded reader, and kept. -----
    const walk = page("/walks/canal/?utm_source=newsletter#top");
    r = await preview(walk);
    assert.equal(r.status, 200);
    const p1 = r.body;
    assert.equal(p1.status, "ok");
    assert.equal(p1.url, page("/walks/canal"), "normalised: no tracking, fragment or trailing slash");
    assert.equal(p1.title, "A slow walk along Regent's Canal");
    assert.equal(p1.site_name, "The Weekender");
    assert.equal(p1.author, "Mara Ellis");
    assert.equal(p1.kind, "article");
    assert.match(p1.summary, /^From Little Venice/);
    assert.deepEqual([p1.image_w, p1.image_h, p1.shape], [1200, 675, "wide"]);
    assert.match(p1.image_tone, /^#[0-9a-f]{6}$/);
    assert.match(p1.image_url, new RegExp(`^/api/link-preview/${p1.id}/image\\?v=`));
    assert.match(p1.favicon_url, new RegExp(`^/api/link-preview/${p1.id}/favicon\\?v=`));
    assert.equal(p1.embed, null);
    assert.ok(p1.fetched_at);
    assert.deepEqual(hits, ["/walks/canal", "/images/canal-wide.png", "/icons/touch.png"]);

    // Sealed at rest; the address isn't kept anywhere in the row.
    const [raw] = await qRaw<Record<string, unknown>>(`SELECT * FROM link_previews WHERE id = $1`, [p1.id]);
    for (const col of ["title", "summary", "site_name", "author", "kind"]) assert.match(String(raw[col]), /^enc:v1:/, `${col} sealed`);
    assert.ok(!JSON.stringify(raw).includes("127.0.0.1") && !JSON.stringify(raw).includes("canal"), "no address or words readable");
    assert.equal(raw.status, "ok");

    // The pictures: WebP, with Saved's safe headers; the blobs are sealed.
    for (const which of ["image", "favicon"] as const) {
      const res = await call(p1[`${which}_url`].replace(/^\/api/, ""), { headers: { Origin: "https://athena.test" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/webp");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
      assert.equal(res.headers.get("access-control-allow-origin"), "https://athena.test");
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
      const kept = Buffer.from((await store("athena-link-previews").get(`${p1.id}/${which}`, { type: "arrayBuffer" }))!);
      assert.notEqual(kept.subarray(8, 12).toString("ascii"), "WEBP", `${which} sealed in Blobs`);
    }
    assert.equal((await call(`/link-preview/${p1.id}/poster`)).status, 404);
    assert.equal((await call(`/link-preview/not-an-id/image`)).status, 404);
    assert.equal((await call(`/link-preview/11111111-1111-4111-8111-111111111111/image`)).status, 404);

    // Asked again, in any spelling of the same address: the kept one, nothing fetched.
    hits.length = 0;
    r = await preview(page("/walks/canal#later"));
    assert.equal(r.body.id, p1.id);
    assert.equal(hits.length, 0);

    // A month on, it's read again. If that read fails, the last good preview stays.
    await qRaw(`UPDATE link_previews SET fetched_at = now() - interval '31 days', checked_at = now() - interval '31 days' WHERE id = $1`, [p1.id]);
    down = true;
    r = await preview(walk);
    assert.equal(hits.length, 1, "tried once");
    assert.deepEqual([r.body.status, r.body.title, r.body.id], ["ok", "A slow walk along Regent's Canal", p1.id]);
    hits.length = 0;
    r = await preview(walk);
    assert.equal(hits.length, 0, "the failed try is noted, so it isn't tried again straight away");
    down = false;
    await qRaw(`UPDATE link_previews SET checked_at = now() - interval '2 hours' WHERE id = $1`, [p1.id]);
    r = await preview(walk);
    assert.ok(hits.includes("/walks/canal"), "read again");
    assert.ok(Date.parse(r.body.fetched_at) > Date.now() - 60_000);
    assert.notEqual(r.body.image_url, p1.image_url, "a new picture address after a new read");

    // refresh=1 reads it now, even when fresh.
    hits.length = 0;
    await preview(walk, "&refresh=1");
    assert.ok(hits.includes("/walks/canal"));

    // ----- A page that fails: kept as failed for an hour, then tried again. -----
    hits.length = 0;
    r = await preview(page("/missing"));
    assert.deepEqual([r.status, r.body.status, r.body.title, r.body.image_url, r.body.site_name], [200, "failed", null, null, "127.0.0.1"]);
    await preview(page("/missing"));
    assert.deepEqual(hits, ["/missing"], "a failure is kept briefly");
    await qRaw(`UPDATE link_previews SET checked_at = now() - interval '61 minutes' WHERE id = $1`, [r.body.id]);
    await preview(page("/missing"));
    assert.deepEqual(hits, ["/missing", "/missing"]);

    // ----- An embeddable address carries its player. -----
    P.previewDeps.fetchHtml = async () => ({ html: "<title>Video</title>", url: "https://youtu.be/dQw4w9WgXcQ" });
    r = await preview("https://youtu.be/dQw4w9WgXcQ?si=share");
    assert.equal(r.body.url, "https://youtu.be/dQw4w9WgXcQ");
    assert.equal(r.body.embed.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    P.previewDeps.fetchHtml = async (u) => (await import("../../../lib/saved-fetch")).fetchPageHtml(u.replace(/^https:/, "http:"));

    // ----- The rate limit: reads count, kept previews don't. -----
    const bucket = createHash("sha256").update(`link-preview-rate\u0000${TOKEN}`).digest("hex").slice(0, 32);
    await qRaw(`INSERT INTO saved_rate (bucket, minute, n) VALUES ($1, date_trunc('minute', now()), 30) ON CONFLICT (bucket, minute) DO UPDATE SET n = 30`, [bucket]);
    r = await preview(page("/n/1"));
    assert.deepEqual([r.status, r.body.error], [429, "That's a lot of link previews in one minute. Try again shortly."]);
    assert.equal((await preview(walk)).status, 200, "a kept preview still answers");
    await qRaw(`UPDATE link_previews SET fetched_at = now() - interval '40 days', checked_at = now() - interval '40 days' WHERE id = $1`, [p1.id]);
    r = await preview(walk);
    assert.deepEqual([r.status, r.body.title], [200, "A slow walk along Regent's Canal"], "over the limit, a stale preview beats nothing");
    await qRaw(`DELETE FROM saved_rate WHERE bucket = $1`, [bucket]);
    assert.equal((await preview(page("/n/1"))).body.title, "Page /n/1");

    // ----- Maps: a Place's pin and a map link's pin, drawn from tiles and cached like day maps. -----
    const tile = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#e8eaee" } }).png().toBuffer();
    const tileUrls: URL[] = [];
    M.mapDeps.assertPublic = async () => undefined;
    M.mapDeps.fetch = async (input) => {
      const u = new URL(String(input));
      tileUrls.push(u);
      return new Response(new Uint8Array(tile), { headers: { "content-type": "image/png" } });
    };
    const [place] = await qRaw<{ id: string }>(`INSERT INTO places (name) VALUES ('Dishoom') RETURNING id`);
    const [nowhere] = await qRaw<{ id: string }>(`INSERT INTO places (name) VALUES ('Somewhere') RETURNING id`);
    await qRaw(`INSERT INTO place_geo (place_id, sealed) VALUES ($1, $2)`, [place.id, sealText(JSON.stringify({ lat: 51.51241, lng: -0.12583 }))]);

    let res = await call(`/places/${place.id}/map`);
    assert.equal(res.headers.get("x-map-state"), "no_key");
    assert.deepEqual(await res.json(), { state: "no_key" });
    assert.equal((await call("/maps-art/tiles", { method: "POST", body: { provider: "maptiler", key: "good-key-123" } })).status, 200);
    tileUrls.length = 0;

    res = await call(`/places/${place.id}/map?theme=dark`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/webp");
    assert.equal(res.headers.get("x-map-state"), "ready");
    assert.equal(res.headers.get("x-map-stops"), "1");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const etag = res.headers.get("etag")!;
    const img = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([img.format, img.width, img.height], ["webp", 1200, 640], "the card size, drawn at 2×");
    assert.ok(tileUrls.length > 0);
    for (const u of tileUrls) {
      assert.ok(!/51\.5|0\.125|Dishoom/i.test(u.toString()), "the provider is sent tile numbers, never the spot or the name");
    }
    tileUrls.length = 0;
    res = await call(`/places/${place.id}/map?theme=dark`, { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 304);
    res = await call(`/places/${place.id}/map?theme=dark`);
    assert.equal(res.status, 200);
    assert.equal(tileUrls.length, 0, "the second time comes from the cache");
    assert.equal((await call(`/places/${nowhere.id}/map`)).headers.get("x-map-state"), "no_places");
    assert.equal((await call(`/places/not-a-uuid/map`)).status, 404);

    // The same spot from a Google Maps link is the same still (same pin, same cache).
    res = await call(`/link-map?url=${encodeURIComponent("https://www.google.com/maps/place/Dishoom/@51.5,-0.1,17z/data=!3d51.51241!4d-0.12583")}&theme=dark`);
    assert.equal(res.headers.get("x-map-state"), "ready");
    assert.equal(res.headers.get("etag"), etag);
    assert.equal(tileUrls.length, 0);
    res = await call(`/link-map?url=${encodeURIComponent("https://maps.apple.com/?ll=51.5362,-0.1257&q=Dishoom")}`);
    assert.equal(res.headers.get("x-map-state"), "ready");
    res = await call(`/link-map?url=${encodeURIComponent("https://maps.apple.com/?q=Dishoom")}`);
    assert.deepEqual(await res.json(), { state: "no_places" }, "a search has no spot");
    res = await call(`/link-map?url=${encodeURIComponent("https://example.com/map")}`);
    assert.deepEqual([res.status, (await res.json()).error], [400, "That isn't a Google Maps or Apple Maps link."]);

    // ----- A Place with only a typed address: looked up once (Nominatim, stubbed), cached, then drawn. -----
    const V = await import("../../../lib/places-visits");
    const lookups: URL[] = [];
    V.lookupDeps.gapMs = 0;
    V.lookupDeps.fetch = async (input) => {
      const u = new URL(String(input));
      lookups.push(u);
      const q = u.searchParams.get("q") ?? "";
      return new Response(JSON.stringify(/Nowhere/.test(q) ? [] : [{ lat: "51.5194", lon: "-0.1270" }]), { headers: { "content-type": "application/json" } });
    };
    const { sealer } = await import("../../../lib/db");
    const s = await sealer();
    const [typed] = await qRaw<{ id: string }>(`INSERT INTO places (name, address) VALUES ('The museum', $1) RETURNING id`, [s.text("Great Russell St, London WC1B 3DG")]);
    const [lost] = await qRaw<{ id: string }>(`INSERT INTO places (name, address) VALUES ('Lost', $1) RETURNING id`, [s.text("1 Nowhere Lane, Atlantis")]);
    await qRaw(`DELETE FROM location_cache WHERE key = ANY($1::text[])`, [[V.addressKey("Great Russell St, London WC1B 3DG"), V.addressKey("1 Nowhere Lane, Atlantis")].map((a) => (blindIndexOf(a)))]);
    res = await call(`/places/${typed.id}/map`);
    assert.equal(res.headers.get("x-map-state"), "ready");
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].origin + lookups[0].pathname, V.NOMINATIM_SEARCH_URL);
    assert.equal(lookups[0].searchParams.get("q"), "Great Russell St, London WC1B 3DG", "only the address is sent");
    assert.ok(!lookups[0].toString().includes("museum"), "never the place's name");
    res = await call(`/places/${typed.id}/map?theme=dark`);
    assert.equal(res.headers.get("x-map-state"), "ready");
    assert.equal(lookups.length, 1, "the address is looked up once");
    assert.equal((await qRaw(`SELECT 1 FROM place_geo WHERE place_id = $1`, [typed.id])).length, 0, "visit matching is left alone");
    const cached = await qRaw<{ sealed: string }>(`SELECT sealed FROM location_cache WHERE key = $1`, [blindIndexOf(V.addressKey("Great Russell St, London WC1B 3DG"))]);
    assert.match(cached[0].sealed, /^enc:v1:/, "kept sealed under a blind-index key");
    assert.equal((await call(`/places/${lost.id}/map`)).headers.get("x-map-state"), "no_places");
    assert.equal((await call(`/places/${lost.id}/map`)).headers.get("x-map-state"), "no_places");
    assert.equal(lookups.length, 2, "an address that can't be found isn't asked again");
    await qRaw(`DELETE FROM places WHERE id = ANY($1::uuid[])`, [[typed.id, lost.id]]);

    // ----- A Notion page through the connected Notion account (stubbed): its real title, no page fetch. -----
    const C = await import("./connector-previews");
    const calls: Array<{ name: string; args: unknown }> = [];
    C.connectorPreviewDeps.listConnectors = async () => [{ id: "c1", provider: "notion", status: "connected", allowed_tools: ["notion-fetch"] }] as never;
    C.connectorPreviewDeps.openConnector = async () => ({ close: async () => undefined }) as never;
    C.connectorPreviewDeps.callTool = async (_o, name, args) => {
      calls.push({ name, args });
      return { text: JSON.stringify({ title: "Lisbon trip plan", text: "# Lisbon trip plan\n\nFlights booked for 12 May." }), isError: false };
    };
    hits.length = 0;
    r = await preview("https://www.notion.so/team/Lisbon-0123abcd");
    assert.deepEqual([r.body.status, r.body.title, r.body.summary, r.body.site_name], ["ok", "Lisbon trip plan", "Flights booked for 12 May.", "Notion"]);
    assert.deepEqual(calls, [{ name: "notion-fetch", args: { id: "https://www.notion.so/team/Lisbon-0123abcd" } }]);
    assert.equal(hits.length, 0);
    const [sealedRow] = await qRaw<{ title: string }>(`SELECT title FROM link_previews WHERE id = $1`, [r.body.id]);
    assert.match(sealedRow.title, /^enc:v1:/);
    // No Notion account: read like any page.
    C.connectorPreviewDeps.listConnectors = async () => [];
    P.previewDeps.fetchHtml = async () => ({ html: "<title>Notion – Sign in</title>", url: "https://www.notion.so/login" });
    r = await preview("https://www.notion.so/team/Other-4567");
    assert.equal(r.body.title, "Notion – Sign in");
    P.previewDeps.fetchHtml = async (u) => (await import("../../../lib/saved-fetch")).fetchPageHtml(u.replace(/^https:/, "http:"));

    // ----- Content-link sync: an edge for a link whatever its mode; a web card is not an edge. -----
    const [note] = await qRaw<{ id: string }>(`INSERT INTO notes (title, body) VALUES ('Saturday', '') RETURNING id`);
    const [person] = await qRaw<{ id: string }>(`INSERT INTO people (name) VALUES ('Priya') RETURNING id`);
    const body = [
      formatAthenaLink("person", person.id, "@Priya", "card"),
      formatAthenaLink("place", place.id, "@Dishoom", "link"),
      formatAthenaLink("place", nowhere.id, "@Somewhere", "mention"),
      formatWebLink("https://a.example/walk", "A walk", "embed"),
    ].join("\n\n");
    await syncContentLinks(note.id, body);
    const edges = await qRaw<{ target_type: string; target_id: string }>(`SELECT target_type, target_id FROM edges WHERE source_id = $1 AND origin = 'content' ORDER BY target_type, target_id`, [note.id]);
    assert.deepEqual(
      edges.map((e) => `${e.target_type}:${e.target_id}`).sort(),
      [`person:${person.id}`, `place:${place.id}`, `place:${nowhere.id}`].sort(),
    );
    await syncContentLinks(note.id, formatAthenaLink("person", person.id, "@Priya", "card"));
    assert.equal((await qRaw(`SELECT 1 FROM edges WHERE source_id = $1 AND origin = 'content'`, [note.id])).length, 1, "removed links lose their edges");
    await qRaw(`DELETE FROM edges WHERE source_id = $1`, [note.id]);
    await qRaw(`DELETE FROM notes WHERE id = $1`, [note.id]);
    await qRaw(`DELETE FROM people WHERE id = $1`, [person.id]);
    await qRaw(`DELETE FROM places WHERE id = ANY($1::uuid[])`, [[place.id, nowhere.id]]);
  } finally {
    site.close();
    await blobs.stop();
    rmSync(dir, { recursive: true, force: true });
    await qRaw(`DELETE FROM link_previews`);
    await qRaw(`DELETE FROM settings WHERE key = 'maps-art'`);
  }
});
