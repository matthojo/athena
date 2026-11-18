// Link previews (rich links): the normalised address, favicons, shapes, freshness, and reading recorded pages.
// No network and no database: the page and image fetches are replaced with recorded fixtures.
// Run: npx tsx --test lib/link-previews.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { faviconHref, isFresh, normalisePreviewUrl, previewDeps, readPreview, shapeOf } from "./link-previews";
import { PageFetchError } from "./saved-fetch";

const fixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");

test("the address a preview is kept under", () => {
  assert.equal(normalisePreviewUrl("http://Example.COM/Path/?utm_source=x&b=2#section"), "https://example.com/Path/?b=2");
  assert.equal(normalisePreviewUrl("https://example.com/a/"), "https://example.com/a");
  assert.equal(normalisePreviewUrl("https://example.com/"), "https://example.com");
  assert.equal(normalisePreviewUrl("https://youtu.be/dQw4w9WgXcQ?si=abc"), "https://youtu.be/dQw4w9WgXcQ", "tracking dropped, case kept");
  assert.equal(normalisePreviewUrl("www.example.com/x"), "https://www.example.com/x");
  assert.equal(normalisePreviewUrl("https://example.com:443/x"), "https://example.com/x");
  for (const bad of ["javascript:alert(1)", "ftp://example.com", "https://localhost/x", "not a url", "", null, 42, "https://user:pw@example.com"]) {
    assert.equal(normalisePreviewUrl(bad), null, String(bad));
  }
});

test("favicons: apple-touch-icon first, then the largest PNG; never SVG, ICO or data", () => {
  const html = fixture("link-previews/walk.html");
  assert.equal(faviconHref(html, "https://weekender.example/walks/canal"), "https://weekender.example/icons/touch.png");
  assert.equal(faviconHref('<link rel="icon" type="image/png" sizes="16x16" href="/a.png"><link rel="shortcut icon" sizes="96x96" href="/b.png">', "https://s.example/"), "https://s.example/b.png");
  assert.equal(faviconHref('<link rel="icon" href="/favicon.ico"><link rel="icon" href="/i.svg"><link rel="icon" href="data:image/png;base64,AAAA">', "https://s.example/"), null);
  assert.equal(faviconHref('<link rel="icon" href="javascript:alert(1)">', "https://s.example/"), null);
  assert.equal(faviconHref("<p>no head</p>", "https://s.example/"), null);
});

test("shapes and freshness", () => {
  assert.equal(shapeOf(1200, 630), "wide");
  assert.equal(shapeOf(800, 800), "square");
  assert.equal(shapeOf(600, 900), "tall");
  assert.equal(shapeOf(null, 10), null);
  const now = Date.parse("2026-11-08T12:00:00Z");
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
  assert.equal(isFresh({ status: "ok", fetched_at: days(29), checked_at: days(29) }, now), true);
  assert.equal(isFresh({ status: "ok", fetched_at: days(31), checked_at: days(31) }, now), false, "a month on, read again");
  assert.equal(isFresh({ status: "ok", fetched_at: days(31), checked_at: new Date(now - 10 * 60_000).toISOString() }, now), true, "a refresh just failed: keep the old one for now");
  assert.equal(isFresh({ status: "failed", fetched_at: null, checked_at: new Date(now - 30 * 60_000).toISOString() }, now), true, "a failure is kept briefly");
  assert.equal(isFresh({ status: "failed", fetched_at: null, checked_at: new Date(now - 61 * 60_000).toISOString() }, now), false, "then tried again");
});

test("reading a recorded article: title, summary, site, author, picture and favicon, only through the page reader's seams", async (t) => {
  const wide = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#3a6ea5" } }).png().toBuffer();
  const icon = await sharp({ create: { width: 180, height: 180, channels: 4, background: "#d0342c" } }).png().toBuffer();
  const asked: string[] = [];
  const saved = { ...previewDeps };
  t.after(() => Object.assign(previewDeps, saved));
  previewDeps.fetchHtml = async (u) => {
    asked.push(u);
    return { html: fixture("link-previews/walk.html"), url: "https://weekender.example/walks/canal" };
  };
  previewDeps.fetchImage = async (u, max) => {
    asked.push(`${u} ${max ?? "default"}`);
    if (u.endsWith("/images/canal-wide.png")) return wide;
    if (u.endsWith("/icons/touch.png")) return icon;
    throw new PageFetchError("http");
  };
  const read = await readPreview("https://weekender.example/walks/canal");
  assert.equal(read.status, "ok");
  assert.equal(read.title, "A slow walk along Regent's Canal");
  assert.match(read.summary ?? "", /^From Little Venice to Limehouse/);
  assert.equal(read.site_name, "The Weekender");
  assert.equal(read.author, "Mara Ellis");
  assert.equal(read.kind, "article");
  assert.deepEqual([read.image?.w, read.image?.h], [1200, 675], "the picture is cut down to 1200px");
  assert.match(read.image!.tone, /^#[0-9a-f]{6}$/);
  assert.equal(read.image!.bytes.subarray(8, 12).toString("ascii"), "WEBP");
  assert.deepEqual([read.favicon?.w, read.favicon?.h], [64, 64]);
  assert.deepEqual(asked, [
    "https://weekender.example/walks/canal",
    "https://weekender.example/images/canal-wide.png default",
    `https://weekender.example/icons/touch.png ${512 * 1024}`,
  ]);
});

test("a shop's page is a product with its price; a page that won't load is failed, with what its address says", async (t) => {
  const saved = { ...previewDeps };
  t.after(() => Object.assign(previewDeps, saved));
  previewDeps.fetchHtml = async () => ({ html: fixture("saved/kinds/shop-product.html"), url: "https://shop.example/p/linen-shirt" });
  previewDeps.fetchImage = async () => {
    throw new PageFetchError("not_image");
  };
  const product = await readPreview("https://shop.example/p/linen-shirt");
  assert.equal(product.status, "ok");
  assert.equal(product.kind, "product");
  assert.ok(product.facts?.price, "a price");
  assert.equal(product.image, null, "a picture that isn't one is left out, not an error");

  previewDeps.fetchHtml = async () => {
    throw new PageFetchError("internal");
  };
  const failed = await readPreview("https://www.imdb.com/title/tt0903747/");
  assert.equal(failed.status, "failed");
  assert.equal(failed.title, null);
  assert.equal(failed.kind, "film", "IMDb's address says it's a title");
  assert.deepEqual(failed.facts, { imdb: "tt0903747" });
  assert.equal(failed.image, null);
});

test("Notion: its fetch answer as a preview, JSON or Markdown-like; its hosts", async () => {
  const { isNotionUrl, notionPreview } = await import("./link-preview-sources");
  assert.ok(isNotionUrl(new URL("https://www.notion.so/team/Trip-plan-0123abcd")));
  assert.ok(isNotionUrl(new URL("https://acme.notion.site/Handbook-0123")));
  assert.ok(!isNotionUrl(new URL("https://notion.so.evil.example/x")));
  assert.ok(!isNotionUrl(new URL("https://notionsite.example/x")));
  const json = JSON.stringify({ metadata: { type: "page" }, title: "Lisbon trip plan", url: "https://www.notion.so/x", text: "<page url=\"x\">\n# Lisbon trip plan\n\n**Flights** booked for 12 May. [Hotel](https://h.example) near Alfama.\n- Pack the adapter\n</page>" });
  assert.deepEqual(notionPreview(json), { title: "Lisbon trip plan", summary: "Flights booked for 12 May. Hotel near Alfama. Pack the adapter", site_name: "Notion", author: null });
  assert.deepEqual(notionPreview("# Reading list\n\nBooks for the winter."), { title: "Reading list", summary: "Books for the winter.", site_name: "Notion", author: null });
  const long = notionPreview('<page title="Q3 goals">' + "x ".repeat(400) + "</page>")!.summary!;
  assert.ok(long.length <= 300 && long.endsWith("…"), "the summary is cut to 300 characters with an ellipsis");
  assert.equal(notionPreview("no title here"), null);
  assert.equal(notionPreview(JSON.stringify({ error: "not found" })), null);
});

test("a connected account's preview comes first; without one (or when it fails) the page is read as usual", async (t) => {
  const { registerPreviewSource } = await import("./link-previews");
  const saved = { ...previewDeps };
  t.after(() => Object.assign(previewDeps, saved));
  const pages: string[] = [];
  previewDeps.fetchHtml = async (u) => {
    pages.push(u);
    return { html: "<title>Sign in to Notion</title>", url: u };
  };
  previewDeps.fetchImage = async () => {
    throw new PageFetchError("not_image");
  };
  let mode: "page" | "none" | "throw" = "page";
  registerPreviewSource({
    id: "test-notion",
    matches: (u) => u.hostname === "www.notion.so",
    read: async () => {
      if (mode === "throw") throw new Error("signed out");
      return mode === "page" ? { title: "Lisbon trip plan", summary: "Flights booked.", site_name: "Notion", author: null } : null;
    },
  });
  let read = await readPreview("https://www.notion.so/Trip-0123");
  assert.deepEqual([read.status, read.title, read.summary, read.site_name], ["ok", "Lisbon trip plan", "Flights booked.", "Notion"]);
  assert.deepEqual(pages, [], "the page itself isn't fetched");
  mode = "none";
  read = await readPreview("https://www.notion.so/Trip-0123");
  assert.equal(read.title, "Sign in to Notion");
  mode = "throw";
  read = await readPreview("https://www.notion.so/Trip-0123");
  assert.equal(read.title, "Sign in to Notion");
  read = await readPreview("https://docs.example/Trip");
  assert.equal(read.title, "Sign in to Notion", "other sites never ask the source");
  assert.equal(pages.length, 3);
  registerPreviewSource({ id: "test-notion", matches: () => false, read: async () => null });
});

test("the monthly sweep deletes only previews not used for 90 days", async () => {
  const { sweepCutoff, PREVIEW_UNUSED_DAYS, PREVIEW_FRESH_DAYS, isFresh } = await import("./link-previews");
  const now = Date.parse("2026-11-08T04:00:00Z");
  const day = 86_400_000;
  const cutoff = sweepCutoff(now).getTime();
  assert.equal(PREVIEW_UNUSED_DAYS, 90);
  assert.equal(now - cutoff, (90 + 30) * day, "checked_at older than 120 days");
  // A preview in use: every request after 30 days reads the page again and moves checked_at,
  // so a preview last used 89 days ago was checked at most 119 days ago, inside the cutoff.
  const lastUse = now - 89 * day;
  const readOn = lastUse - (PREVIEW_FRESH_DAYS - 1) * day - 1;
  assert.ok(isFresh({ status: "ok", fetched_at: new Date(readOn), checked_at: new Date(readOn) }, lastUse), "still fresh at its last use, so not read again");
  assert.ok(readOn >= cutoff, "kept: used 89 days ago");
  assert.ok(now - 121 * day < cutoff, "one checked 121 days ago goes");
});

test("the app and the server key a preview by the same address", async () => {
  const { normalisePreviewUrl } = await import("./link-previews");
  const shared = await import("./link-preview-url");
  for (const raw of ["http://Example.com/Walk/?utm_source=x#top", "https://youtu.be/dQw4w9WgXcQ?si=abc", "www.example.com", "notaurl"]) {
    assert.equal(normalisePreviewUrl(raw), shared.normalisePreviewUrl(raw), raw);
  }
  assert.equal(shared.previewKeyText("https://example.com/walk"), "link-preview\u0000https://example.com/walk");
});
