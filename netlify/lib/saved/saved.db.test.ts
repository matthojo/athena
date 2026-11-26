// Real path for Saved: the real /api function on Postgres with every migration through 0038.
// A link saved with a capture key gets its readable copy from a local fixture server; an image (multipart and data URL);
// a quote; client_id and same-link repeats; sealing at rest; CORS for the extension; ping; the app's list, search,
// day, reader, edit and delete; and Siri/Share text that is a link, or an image, going to Saved instead of the assistant.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/saved/saved.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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

const fixture = (name: string) => readFileSync(new URL(`../../../lib/fixtures/saved/${name}`, import.meta.url));

test("Saved: capture key, readable copy, images, quotes, CORS, the app's routes and capture → Saved", { skip: !url && "set ATHENA_TEST_DB_URL" }, async (t) => {
  // A local site: the article, its lead image, and a page that redirects to it.
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/science/sleep") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fixture("article.html"));
    if (req.url === "/images/sleep-hero.png") return res.writeHead(200, { "content-type": "image/png" }).end(fixture("sleep-hero.png"));
    if (req.url === "/short") return res.writeHead(302, { location: "/science/sleep" }).end();
    if (req.url === "/watch") return res.writeHead(200, { "content-type": "text/html" }).end(fixture("video.html"));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The page reader's seams: the local server is "public", and is read over http (production always reads https).
  const { pageDeps } = await import("../../../lib/saved-fetch");
  pageDeps.fetch = (input, init) => fetch(input, init);
  pageDeps.assertPublic = async () => undefined;
  pageDeps.upgrade = (u) => u;

  const blobs = new Map<string, Uint8Array>();
  const { useSavedStore } = await import("../../../lib/saved");
  useSavedStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, new Uint8Array(v)), get: async (k: string) => (blobs.has(k) ? blobs.get(k)!.buffer : null), delete: async (k: string) => void blobs.delete(k) }) as never);

  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const { createApiKey } = await import("../../../lib/api-keys");
  await qRaw(`DELETE FROM saved_items`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const capture = (await createApiKey("Extension", "capture")).token;

  const send = async (method: string, path: string, opts: { body?: BodyInit; json?: unknown; token?: string | null; origin?: string; type?: string } = {}) => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? "master-token-for-tests" : opts.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    if (opts.type) headers["Content-Type"] = opts.type;
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body }), {} as never);
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return { status: res.status, body, headers: res.headers };
  };
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  // ---- CORS: preflight and the reply both name the extension's origin ----
  let r = await send("OPTIONS", "/saved", { token: null, origin: EXT });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), EXT);
  assert.match(r.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST/);

  // ---- ping, and keys ----
  r = await send("GET", "/saved/ping", { token: capture, origin: EXT });
  assert.deepEqual(r.body, { ok: true, name: "Athena" });
  assert.equal(r.headers.get("access-control-allow-origin"), EXT);
  assert.equal((await send("GET", "/saved/ping", { token: "athc_wrong" })).status, 401);
  assert.equal((await send("POST", "/saved", { token: null, json: { url: `${site}/x` } })).status, 401);

  // ---- a link, through a redirect, read once: title, site, author, date, text and lead image ----
  const clientId = "7d1f1c1e-4a7b-4a0e-9a59-0d2b0d3c9a11";
  r = await send("POST", "/saved", { token: capture, origin: EXT, json: { url: `${site}/short`, title: "Tab title", note: "for the sleep talk", source: "extension", client_id: clientId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const link = r.body.item;
  assert.equal(r.body.url, `https://athena.test/#/saved/${link.id}`);
  assert.equal(link.kind, "link");
  assert.equal(link.title, "Tab title", "the client's title wins");
  assert.equal(link.site, "The Longform Review");
  assert.equal(link.author, "Dr Hannah Okafor");
  assert.equal(link.published_at, "2026-10-21");
  assert.equal(link.note, "for the sleep talk");
  assert.equal(link.source, "extension");
  assert.equal(link.has_readable, true);
  assert.equal(link.fetch_status, "ok");
  assert.equal(link.image_url, `/api/saved/${link.id}/image`);
  assert.ok(hits.includes("/images/sleep-hero.png"));

  // Same client_id again: the same item, 200, nothing new, and to a capture key only its id. Same link without one,
  // with the app's token: the same item too, the note added.
  r = await send("POST", "/saved", { token: capture, json: { url: `${site}/short`, source: "extension", client_id: clientId } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, link.id);
  assert.equal(r.body.item, undefined, "a capture key gets nothing of what was already saved");
  r = await send("POST", "/saved", { json: { url: `${site}/short#top`, note: "and the offsite", source: "shortcut" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, link.id);
  assert.equal(r.body.item.note, "for the sleep talk\n\nand the offsite");
  // A capture key's repeat of the link: answered with the id alone, and never adds to the item. With a note, it's kept as its own item.
  r = await send("POST", "/saved", { token: capture, json: { url: `${site}/short`, source: "shortcut" } });
  assert.deepEqual([r.status, r.body.id, r.body.item], [200, link.id, undefined]);
  r = await send("POST", "/saved", { token: capture, json: { url: `${site}/short`, note: "from a capture key", source: "shortcut" } });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.id, link.id);
  assert.equal((await send("GET", `/saved/${link.id}`)).body.note, "for the sleep talk\n\nand the offsite", "the first item is as it was");
  await send("DELETE", `/saved/${r.body.id}`);

  // Sealed at rest: the link, its words and the note. Kind and dates readable.
  const [raw] = await qRaw<Record<string, string | null>>(`SELECT url, title, site, author, readable, note, kind, url_bidx FROM saved_items WHERE id = $1`, [link.id]);
  for (const col of ["url", "title", "site", "author", "readable", "note"]) assert.ok(raw[col]?.startsWith("enc:v1:"), `${col} sealed`);
  assert.equal(raw.kind, "link");
  assert.ok(raw.url_bidx && !raw.url_bidx.includes("127.0.0.1"));
  // The image bytes are sealed too: no PNG or WebP header in the store.
  const lg = blobs.get(`${link.id}/lg`)!;
  assert.ok(lg && !Buffer.from(lg).includes(Buffer.from("WEBP")), "image sealed");

  // The reader: the clean text, no nav or footer.
  r = await send("GET", `/saved/${link.id}`);
  assert.match(r.body.readable, /slow-wave sleep/);
  assert.doesNotMatch(r.body.readable, /All rights reserved/);
  r = await send("GET", `/saved/${link.id}/image?size=sm`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");

  // Any client can name itself as the source (migration 0092); a name that isn't short and plain is filed as the app's.
  r = await send("POST", "/saved", { token: capture, json: { text: "Kept from Raycast", source: "raycast" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.source, "raycast");
  r = await send("POST", "/saved", { token: capture, json: { text: "Kept from somewhere odd", source: "Not a name; DROP TABLE" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.source, "app");

  // A video page: a preview, no article text.
  r = await send("POST", "/saved", { token: capture, json: { url: `${site}/watch`, source: "extension" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.fetch_status, "preview");
  assert.equal(r.body.item.has_readable, false);
  assert.equal(r.body.item.title, "Making sourdough at home");

  // A page that won't load is still saved, with what the client knew.
  r = await send("POST", "/saved", { token: capture, json: { url: `${site}/gone`, title: "Gone page", source: "extension" } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.fetch_status, "failed");
  assert.equal(r.body.item.title, "Gone page");

  // ---- an image: multipart, and a data URL; over 10 MB is 413 ----
  const form = new FormData();
  form.set("image", new Blob([fixture("sleep-hero.png")], { type: "image/png" }), "shot.png");
  form.set("source", "share-target");
  form.set("source_url", "https://example.com/gallery");
  form.set("note", "colour idea");
  r = await send("POST", "/saved", { token: capture, body: form });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.item.kind, "image");
  assert.equal(r.body.item.image_w, 64);
  assert.match(r.body.item.image_tone, /^#[0-9a-f]{6}$/);
  assert.equal(r.body.item.source_url, "https://example.com/gallery");
  const dataUrl = `data:image/png;base64,${fixture("sleep-hero.png").toString("base64")}`;
  r = await send("POST", "/saved", { token: capture, json: { image: dataUrl, source: "extension", source_url: `${site}/science/sleep` } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.kind, "image");
  const huge = new FormData();
  huge.set("image", new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" }), "big.png");
  r = await send("POST", "/saved", { token: capture, body: huge });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /over 10 MB/);
  r = await send("POST", "/saved", { token: capture, json: { image: "data:text/html;base64,PGh0bWw+", source: "extension" } });
  assert.equal(r.status, 400, "not an image");

  // ---- a quote with its source; a snippet; a note; too long ----
  r = await send("POST", "/saved", { token: capture, json: { selection: "Sleep is not the absence of work; it is when a good share of the work gets done.", url: `${site}/science/sleep`, title: "Why sleep is when you learn", source: "extension" } });
  assert.equal(r.status, 201);
  const quote = r.body.item;
  assert.equal(quote.kind, "quote");
  assert.equal(quote.source_url, `${site}/science/sleep`);
  const [rq] = await qRaw<{ quote: string }>(`SELECT quote FROM saved_items WHERE id = $1`, [quote.id]);
  assert.ok(rq.quote.startsWith("enc:v1:"), "quote sealed");
  r = await send("POST", "/saved", { token: capture, json: { text: "SELECT id, title FROM notes WHERE archived_at IS NULL;\nORDER BY updated_at DESC;", source: "app" } });
  assert.equal(r.body.item.kind, "snippet");
  r = await send("POST", "/saved", { token: capture, json: { text: "x".repeat(20_001), source: "app" } });
  assert.equal(r.status, 413);
  r = await send("POST", "/saved", { token: capture, json: { source: "app" } });
  assert.equal(r.status, 400);

  // ---- the capture key can't read anything back ----
  assert.equal((await send("GET", "/saved", { token: capture })).status, 401);
  assert.equal((await send("GET", `/saved/${link.id}`, { token: capture })).status, 401);
  assert.equal((await send("GET", `/saved/${link.id}/image`, { token: capture })).status, 401);
  assert.equal((await send("DELETE", `/saved/${link.id}`, { token: capture })).status, 401);

  // ---- the app: list, filter, search, the day ----
  r = await send("GET", "/saved");
  assert.equal(r.body.counts.all, 9);
  assert.equal(r.body.counts.image, 2);
  assert.equal(r.body.items[0].kind, "snippet", "newest first");
  r = await send("GET", "/saved?kind=quote");
  assert.deepEqual(r.body.items.map((i: any) => i.id), [quote.id]);
  r = await send("GET", `/saved?q=${encodeURIComponent("hippocampus")}`);
  assert.equal(r.body.items[0].id, link.id, "found by its readable text");
  assert.match(r.body.items[0].match, /hippocampus/);
  r = await send("GET", `/saved?q=${encodeURIComponent("offsite")}`);
  assert.equal(r.body.items[0].id, link.id, "found by its note");
  r = await send("GET", `/saved?day=${link.saved_on}`);
  assert.equal(r.body.items.length, 9);

  // Edit, archive, bring back, delete (its image goes too).
  r = await send("PATCH", `/saved/${link.id}`, { json: { title: "Sleep and learning", tags: ["#sleep", "talk"] } });
  assert.equal(r.body.title, "Sleep and learning");
  assert.deepEqual(r.body.tags, ["sleep", "talk"]);
  r = await send("PATCH", `/saved/${link.id}`, { json: { archived: true } });
  assert.equal(r.body.archived, true);
  assert.equal((await send("GET", "/saved")).body.counts.all, 8);
  await send("PATCH", `/saved/${link.id}`, { json: { archived: false } });
  r = await send("POST", `/saved/${link.id}/refetch`);
  assert.equal(r.body.fetch_status, "ok");
  assert.equal(r.body.title, "Sleep and learning", "a refetch keeps the owner's title");
  r = await send("DELETE", `/saved/${link.id}`);
  assert.equal(r.body.deleted, true);
  assert.equal(blobs.has(`${link.id}/lg`), false);
  assert.equal((await send("GET", `/saved/${link.id}`)).status, 404);

  // ---- Siri/Share: a link goes to Saved, not the assistant; so does an image ----
  r = await send("POST", "/assistant/capture", { token: capture, type: "text/plain", body: `Why sleep is when you learn ${site}/science/sleep` });
  assert.equal(r.status, 200);
  assert.equal(r.body, "Saved “Why sleep is when you learn”.");
  const [{ n, source }] = await qRaw<{ n: number; source: string }>(`SELECT count(*)::int AS n, max(source) AS source FROM saved_items WHERE kind = 'link' AND fetch_status = 'ok'`);
  assert.equal(n, 1);
  assert.equal(source, "shortcut");
  r = await send("POST", "/assistant/capture?format=json", { token: capture, json: { text: `${site}/science/sleep` } });
  assert.match(r.body.reply, /was already in Saved/);
  const shot = new FormData();
  shot.set("image", new Blob([fixture("sleep-hero.png")], { type: "image/png" }), "IMG_0001.png");
  r = await send("POST", "/assistant/capture", { token: capture, body: shot });
  assert.equal(r.body, "Saved the image.");
  const [{ images }] = await qRaw<{ images: number }>(`SELECT count(*)::int AS images FROM saved_items WHERE kind = 'image' AND source = 'shortcut'`);
  assert.equal(images, 1);

  // ---- a repeat client_id with a note, title or tags updates the item (the note replaces) ----
  // The link was saved before: a capture key's save of it with a note is its own item, which the client_id then names.
  const later = "0b9b7c1e-2f3a-4c5d-8e9f-a1b2c3d4e5f6";
  r = await send("POST", "/saved", { token: capture, origin: EXT, json: { url: `${site}/watch`, source: "extension", client_id: later, note: "first" } });
  assert.equal(r.status, 201);
  const toolbar = r.body.item;
  r = await send("POST", "/saved", { token: capture, origin: EXT, json: { url: `${site}/watch`, source: "extension", client_id: later, note: "watch with Sam", tags: ["baking"] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, toolbar.id);
  let kept = (await send("GET", `/saved/${toolbar.id}`)).body;
  assert.equal(kept.note, "watch with Sam", "the note replaces");
  assert.deepEqual(kept.tags, ["baking"]);
  r = await send("POST", "/saved", { token: capture, json: { client_id: later, title: "Sourdough, slowly", source: "extension" } });
  kept = (await send("GET", `/saved/${toolbar.id}`)).body;
  assert.equal(kept.title, "Sourdough, slowly");
  assert.equal(kept.note, "watch with Sam", "leaving the note out keeps it");

  // ---- an image by address: fetched through the guarded fetch; one that can't be fetched is kept as a link ----
  r = await send("POST", "/saved", { token: capture, json: { image: `${site}/images/sleep-hero.png`, source_url: `${site}/science/sleep`, source: "extension" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.item.kind, "image");
  assert.equal(r.body.item.image_w, 64);
  assert.equal(r.body.item.source_url, `${site}/science/sleep`);
  const byForm = new FormData();
  byForm.set("image", `${site}/missing.png`);
  byForm.set("source", "extension");
  r = await send("POST", "/saved", { token: capture, body: byForm });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.kind, "link", "an image that won't load is kept as a link");
  assert.equal(r.body.item.url, `${site}/missing.png`);

  // ---- HEIC is refused with how to fix it ----
  const heic = new Uint8Array(64);
  heic.set(Buffer.from("\u0000\u0000\u0000\u0018ftypheic", "latin1"));
  const hf = new FormData();
  hf.set("image", new Blob([heic], { type: "image/heic" }), "IMG_1.HEIC");
  r = await send("POST", "/saved", { token: capture, body: hf });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Convert it to JPEG/);

  // ---- 60 saves a minute per key, then 429; another key is unaffected ----
  const { takeSaveSlot } = await import("../../../lib/saved");
  await qRaw(`DELETE FROM saved_rate`);
  const burst = (await createApiKey("Burst", "capture")).token;
  const reqFor = (tok: string) => new Request("https://athena.test/api/saved", { headers: { Authorization: `Bearer ${tok}` } });
  for (let i = 0; i < 59; i++) assert.equal(await takeSaveSlot(reqFor(burst)), true);
  r = await send("POST", "/saved", { token: burst, json: { text: "the sixtieth", source: "app" } });
  assert.equal(r.status, 201);
  r = await send("POST", "/saved", { token: burst, json: { text: "one too many", source: "app" } });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Try again shortly/);
  assert.equal((await send("POST", "/saved", { token: capture, json: { text: "still fine", source: "app" } })).status, 201);
  const [{ raw: bucketRow }] = await qRaw<{ raw: string }>(`SELECT string_agg(bucket, ',') AS raw FROM saved_rate`);
  assert.ok(!bucketRow.includes(burst), "tokens are never stored");

  await qRaw(`DELETE FROM saved_items`);
  await qRaw(`DELETE FROM saved_rate`);
});
