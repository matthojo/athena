// Live: real artwork from the real internet, through the real /api, Postgres and a local Blobs server. Nothing
// stubbed: Open Library (a cover by ISBN and one by title) and Steam (a header by app id), with the real DNS check.
// Run: ATHENA_LIVE=1 ATHENA_TEST_DB_URL=postgres://… NODE_USE_ENV_PROXY=1 npx tsx --test netlify/lib/days-art/days-art.live.test.ts
// Skipped without both. ATHENA_ART_OUT=<dir> also writes each stored image there, to look at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DayEntryLike } from "../../../lib/art";

const url = process.env.ATHENA_TEST_DB_URL;
const live = process.env.ATHENA_LIVE === "1";
if (url && live) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("Live art: Open Library and Steam covers onto day entries and Watch & read, served by /api/art", { skip: !(url && live) && "set ATHENA_LIVE=1 and ATHENA_TEST_DB_URL", timeout: 90_000 }, async () => {
  const sharp = (await import("sharp")).default;
  const { BlobsServer } = await import("@netlify/blobs/server");
  const { getStore } = await import("@netlify/blobs");
  const api = (await import("../../functions/api")).default;
  const { qRaw } = await import("../../../lib/db");
  const A = await import("../../../lib/art");

  const dir = mkdtempSync(join(tmpdir(), "athena-blobs-"));
  const server = new BlobsServer({ directory: dir, token: "blobs-token" });
  const { port } = await server.start();
  A.useArtStore(() => getStore({ name: "athena-art", siteID: "athena-test", token: "blobs-token", edgeURL: `http://localhost:${port}` }));
  for (const t of ["art_sources", "art", "reading_items"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM settings WHERE key = 'maps-art'`);

  // Record what goes out, but let it through.
  const hosts = new Set<string>();
  const realFetch = A.artDeps.fetch;
  A.artDeps.fetch = (input, init) => {
    hosts.add(new URL(String(input)).host);
    return realFetch(input, init);
  };
  const call = async (method: string, path: string, body?: unknown) =>
    api(new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer master-token-for-tests" }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);

  try {
    // ----- A day's entries -----
    const entries: DayEntryLike[] = [
      { id: "d1", kind: "read", source: "goodreads", title: "The Wager", subtitle: "David Grann" },
      { id: "d2", kind: "played", source: "steam", title: "Hades", url: "https://store.steampowered.com/app/1145360/" },
      { id: "d3", kind: "watched", source: "letterboxd", title: "Past Lives" }, // no TMDB key: none
      { id: "d4", kind: "posted", source: "bluesky", title: "A post" }, // never
    ];
    const out = await A.attachDayArt(entries, { d1: { isbn: "9780385534260" } }, { budgetMs: 30_000 });
    const [book, game] = [out[0].art, out[1].art];
    assert.ok(book && A.isArtId(book.id), "The Wager's cover");
    assert.ok(game && A.isArtId(game.id), "Hades' header");
    assert.ok(book.h > book.w, `a cover is portrait (${book.w}×${book.h})`);
    assert.ok(game.w > game.h, `a header is landscape (${game.w}×${game.h})`);
    assert.equal(out[2].art, undefined);
    assert.equal(out[3].art, undefined);
    assert.ok([...hosts].every((h) => /(^|\.)(openlibrary\.org|archive\.org|steamstatic\.com)$/.test(h)), `only allowed hosts: ${[...hosts].join(", ")}`);

    // Served behind the token, as WebP, cached for a year.
    for (const [name, art] of [["wager", book], ["hades", game]] as const) {
      for (const size of ["sm", "lg"] as const) {
        const res = await call("GET", `/art/${art.id}?size=${size}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
        const bytes = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(bytes).metadata();
        assert.equal(meta.format, "webp");
        assert.ok(Math.max(meta.width!, meta.height!) <= A.ART_SIZES[size]);
        if (process.env.ATHENA_ART_OUT) writeFileSync(join(process.env.ATHENA_ART_OUT, `live-${name}-${size}.webp`), bytes);
      }
    }

    // ----- Watch & read: the same book by title (Open Library search), the same game; the cover is stored once. -----
    hosts.clear();
    await call("POST", "/reading", { title: "The Wager", author: "David Grann", kind: "book", status: "reading" });
    await call("POST", "/reading", { title: "Hades", kind: "game", url: "https://store.steampowered.com/app/1145360/", status: "done" });
    await call("POST", "/reading", { title: "A long read", kind: "article", url: "https://example.com/a", status: "queued" });
    // Each list request spends at most 1.5 s on new art; a slow cover (archive.org can take seconds) finishes
    // after the reply and is there next time. Ask again a few times, as the app does on later visits.
    let byTitle: Record<string, { title: string; art?: { id: string } }> = {};
    for (let i = 0; i < 8; i++) {
      const res = await call("GET", "/reading");
      assert.equal(res.status, 200);
      const items = (await res.json()).items as Array<{ title: string; art?: { id: string } }>;
      byTitle = Object.fromEntries(items.map((x) => [x.title, x]));
      if (byTitle["The Wager"].art && byTitle["Hades"].art) break;
      await new Promise((r) => setTimeout(r, 2_500));
    }
    assert.equal(byTitle["Hades"].art?.id, game.id, "the game header from the day is reused, not fetched again");
    assert.ok(byTitle["The Wager"].art?.id, "the book found by title");
    assert.equal(byTitle["A long read"].art, undefined, "articles have no art");
    assert.ok(!hosts.has("shared.akamai.steamstatic.com"), "Steam not asked twice");
    if (process.env.ATHENA_ART_OUT) writeFileSync(join(process.env.ATHENA_ART_OUT, "live-art.json"), JSON.stringify({ book, game, wagerByTitle: byTitle["The Wager"].art }, null, 1));
  } finally {
    A.artDeps.fetch = realFetch;
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    await qRaw(`DELETE FROM reading_items`);
  }
});
