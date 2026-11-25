// Saved: URL detection, choosing the kind, extraction on fixture pages, the guarded page fetch and its size caps,
// and the capture → Saved decision. No database.
// Run: npx tsx --test lib/saved.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureIsLink, cleanSource, cleanTags, cleanUrl, leadingUrl, looksLikeCode, MAX_PAGE_BYTES, MAX_SAVED_TEXT, planSave, readingTime, SAVED_SOURCES, savedUrlKey, SaveTooBig, siteOf } from "./saved-rules";
import { extractPage } from "./saved-extract";
import { fetchPageHtml, fetchPageImage, pageDeps, PageFetchError } from "./saved-fetch";
import { dataUrlBytes } from "../netlify/lib/saved/routes";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/saved/${name}`, import.meta.url));

test("URLs: cleaned, http(s) only, no credentials, www. gets https", () => {
  assert.equal(cleanUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(cleanUrl("  https://example.com/a).  "), "https://example.com/a");
  assert.equal(cleanUrl("www.bbc.co.uk/news"), "https://www.bbc.co.uk/news");
  assert.equal(cleanUrl("https://example.com/p#:~:text=sleep"), "https://example.com/p");
  assert.equal(cleanUrl("javascript:alert(1)"), null);
  assert.equal(cleanUrl("ftp://example.com/x"), null);
  assert.equal(cleanUrl("https://user:pw@example.com/"), null);
  assert.equal(cleanUrl("https://localhost/"), null);
  assert.equal(cleanUrl("not a url"), null);
});

test("leading URL: the link alone, link then note, Safari's 'Title URL', but not a link mid-sentence", () => {
  assert.deepEqual(leadingUrl("https://a.com/x"), { url: "https://a.com/x", rest: "" });
  assert.deepEqual(leadingUrl("https://a.com/x read this later"), { url: "https://a.com/x", rest: "read this later" });
  assert.deepEqual(leadingUrl("Why sleep matters https://a.com/x"), { url: "https://a.com/x", rest: "Why sleep matters" });
  assert.deepEqual(leadingUrl("Why sleep matters\nhttps://a.com/x"), { url: "https://a.com/x", rest: "Why sleep matters" });
  assert.equal(leadingUrl("remind me to call Sam about https://a.com/x tomorrow"), null);
  assert.equal(leadingUrl("buy milk"), null);
  assert.equal(captureIsLink("https://a.com"), true);
  assert.equal(captureIsLink("Add a to-do: buy milk"), false);
});

test("kind: image, then selection (quote), then link, then code (snippet), then note", () => {
  assert.equal(planSave({ url: "https://a.com", hasImage: true })?.kind, "image");
  assert.equal(planSave({ url: "https://a.com", hasImage: true })?.source_url, "https://a.com/");
  const q = planSave({ url: "https://a.com/p", selection: "Sleep is when the work gets done." })!;
  assert.equal(q.kind, "quote");
  assert.equal(q.quote, "Sleep is when the work gets done.");
  assert.equal(q.source_url, "https://a.com/p");
  assert.equal(planSave({ text: "https://a.com/p" })?.kind, "link");
  const t = planSave({ text: "A good read https://a.com/p" })!;
  assert.equal(t.kind, "link");
  assert.equal(t.title, "A good read");
  const n = planSave({ text: "https://a.com/p for the offsite" })!;
  assert.equal(n.note, "for the offsite");
  assert.equal(planSave({ text: "const x = await fetch(url);\nconsole.log(x);" })?.kind, "snippet");
  assert.equal(planSave({ text: "git rebase -i HEAD~3" })?.kind, "snippet");
  assert.equal(planSave({ text: "“The best time to plant a tree was twenty years ago.”" })?.kind, "quote");
  assert.equal(planSave({ text: "Ideas for Sam's birthday: a pottery class" })?.kind, "note");
  assert.equal(planSave({}), null);
  assert.equal(planSave({ text: "   " }), null);
});

test("caps: text over 20,000 characters is refused, titles cut, tags tidied", () => {
  assert.throws(() => planSave({ text: "x".repeat(MAX_SAVED_TEXT + 1) }), SaveTooBig);
  assert.throws(() => planSave({ selection: "x".repeat(MAX_SAVED_TEXT + 1) }), SaveTooBig);
  assert.equal(planSave({ url: "https://a.com", title: "t".repeat(500) })?.title?.length, 300);
  assert.deepEqual(cleanTags(["#sleep", "Sleep", " health ", "", 4]), ["sleep", "health"]);
  assert.deepEqual(cleanTags("a, b,a"), ["a", "b"]);
});

test("small helpers: site, reading time, code, data URLs, link identity", () => {
  assert.equal(siteOf("https://www.nytimes.com/2026/x"), "nytimes.com");
  assert.equal(siteOf("https://m.youtube.com/watch"), "youtube.com");
  assert.equal(readingTime(100), null);
  assert.equal(readingTime(1400), "7 min read");
  assert.equal(looksLikeCode("Meet Sam at 3"), false);
  assert.deepEqual([...(dataUrlBytes("data:image/png;base64,iVBORw0K") ?? [])].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(dataUrlBytes("https://a.com/x.png"), null);
  assert.equal(savedUrlKey("https://A.com/x/#top"), savedUrlKey("https://a.com/x"));
});

test("extraction: an article gives its title, author, date, lead image and clean text, without nav or footer", () => {
  const x = extractPage(fixture("article.html").toString("utf8"), "https://longform.example/science/sleep");
  assert.equal(x.title, "Why sleep is when you learn");
  assert.equal(x.site_name, "The Longform Review");
  assert.equal(x.author, "Dr Hannah Okafor");
  assert.equal(x.published_at, "2026-10-21");
  assert.equal(x.image, "https://longform.example/images/sleep-hero.png");
  assert.match(x.excerpt ?? "", /hours we cut/);
  assert.ok(x.text, "has text");
  assert.match(x.text!, /slow-wave sleep/);
  assert.match(x.text!, /## What to try this week/);
  assert.match(x.text!, /• Same wake time, seven days\.\n• No caffeine/);
  assert.doesNotMatch(x.text!, /Most read|All rights reserved|Subscribe|tracker/);
  assert.ok(x.words > 200);
  assert.doesNotMatch(x.text!, /^By Dr/);
});

test("extraction: a video page keeps its preview and has no article text", () => {
  const x = extractPage(fixture("video.html").toString("utf8"), "https://www.youtube.com/watch?v=abc123");
  assert.equal(x.title, "Making sourdough at home");
  assert.equal(x.text, null);
  assert.equal(x.author, "Bake With Jo");
  assert.equal(x.image, "https://i.ytimg.com/vi/abc123/maxresdefault.jpg");
  assert.equal(x.excerpt, "A slow, calm walk through a weekend loaf.");
});

// ---------- the guarded fetch ----------

function stubNetwork(t: { after: (fn: () => void) => void }, pages: Record<string, () => Response>) {
  const saved = { ...pageDeps };
  const asked: string[] = [];
  pageDeps.assertPublic = async (u: URL) => {
    if (u.hostname.endsWith(".internal-test")) throw new Error("internal");
  };
  pageDeps.fetch = async (input: string | URL) => {
    const u = String(input);
    asked.push(u);
    const page = pages[u];
    return page ? page() : new Response("nope", { status: 404 });
  };
  t.after(() => Object.assign(pageDeps, saved));
  return asked;
}

test("fetch: http is read over https, redirects re-checked, charset decoded", async (t) => {
  const asked = stubNetwork(t, {
    "https://news.example/a": () => new Response(null, { status: 301, headers: { location: "http://news.example/b" } }),
    "https://news.example/b": () => new Response(fixture("latin1.html"), { headers: { "content-type": "text/html; charset=iso-8859-1" } }),
  });
  const page = await fetchPageHtml("http://news.example/a");
  assert.deepEqual(asked, ["https://news.example/a", "https://news.example/b"]);
  assert.equal(page.url, "https://news.example/b");
  assert.match(page.html, /Café notes/);
});

test("fetch: an internal address is refused, even after a redirect", async (t) => {
  stubNetwork(t, { "https://ok.example/": () => new Response(null, { status: 302, headers: { location: "https://db.internal-test/" } }) });
  await assert.rejects(fetchPageHtml("https://db.internal-test/"), (e: PageFetchError) => e.reason === "internal");
  await assert.rejects(fetchPageHtml("https://ok.example/"), (e: PageFetchError) => e.reason === "internal");
});

test("fetch: size caps on declared and streamed bodies; not HTML; not an image", async (t) => {
  const big = "x".repeat(MAX_PAGE_BYTES + 10);
  stubNetwork(t, {
    "https://a.example/declared": () => new Response("small", { headers: { "content-type": "text/html", "content-length": String(MAX_PAGE_BYTES + 1) } }),
    "https://a.example/streamed": () => new Response(big, { headers: { "content-type": "text/html" } }),
    "https://a.example/pdf": () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }),
    "https://a.example/img": () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } }),
    "https://a.example/ok.png": () => new Response(fixture("sleep-hero.png"), { headers: { "content-type": "image/png" } }),
  });
  await assert.rejects(fetchPageHtml("https://a.example/declared"), (e: PageFetchError) => e.reason === "too_big");
  await assert.rejects(fetchPageHtml("https://a.example/streamed"), (e: PageFetchError) => e.reason === "too_big");
  await assert.rejects(fetchPageHtml("https://a.example/pdf"), (e: PageFetchError) => e.reason === "not_html");
  await assert.rejects(fetchPageImage("https://a.example/img"), (e: PageFetchError) => e.reason === "not_image");
  assert.equal((await fetchPageImage("https://a.example/ok.png"))[0], 0x89);
});

test("fetch: one deadline for the whole read", async (t) => {
  stubNetwork(t, {});
  const before = pageDeps.timeoutMs;
  pageDeps.timeoutMs = 50;
  pageDeps.fetch = (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  t.after(() => (pageDeps.timeoutMs = before));
  await assert.rejects(fetchPageHtml("https://slow.example/"), (e: PageFetchError) => e.reason === "timeout");
});

test("a save's source: any short plain name a client gives, else the app's", () => {
  for (const name of [...SAVED_SOURCES, "raycast", "my-script-2"]) assert.equal(cleanSource(name), name);
  assert.equal(cleanSource(" Raycast "), "raycast");
  for (const bad of [undefined, null, 7, "", "2fast", "-dash", "two words", "under_score", "a".repeat(41), "x'; DROP TABLE saved_items; --", "näme"]) {
    assert.equal(cleanSource(bad), "app", String(bad));
  }
  // The column's CHECK (migration 0092) is the same rule, so what the code lets through, the database takes.
  const sql = readFileSync(new URL("../netlify/database/migrations/0092_saved-source-open/migration.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("CHECK (source ~ '^[a-z][a-z0-9-]{0,39}$')"));
});
