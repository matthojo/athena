// Security review, session 6: each finding's measured hostile input, with a time or memory bound.
// M18 metadata scans, M20 image decode, M21 nested pages, M5 push endpoints, M4 the login limit's config.
// No network and no database. Run: npx tsx --test lib/hostile-content.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeflate, crc32 } from "node:zlib";
import sharp from "sharp";
import { decodeImage, MAX_DECODE_PIXELS, prepareArt } from "./art";
import { faviconHref, previewDeps, readPreview } from "./link-previews";
import { extractPage, MAX_PAGE_DEPTH, MAX_READABLE_ELEMS, pageShape, tooDeep } from "./saved-extract";
import { detectFromHtml, jsonLdNodes, metaContent, META_SCAN_CHARS } from "./saved-kinds";
import { pushCredential, pushEndpoint } from "./push";

/** Run it and say how long it took. */
function timed<T>(run: () => T): { ms: number; out: T } {
  const t = performance.now();
  const out = run();
  return { ms: performance.now() - t, out };
}
const MB3 = 3 * 1024 * 1024;
const fill = (unit: string, chars = MB3) => unit.repeat(Math.ceil(chars / unit.length));

// ---------- M18: metadata from fetched HTML ----------

test("M18: 3 MB of unclosed <script, <meta and <link tags is read in well under a second", () => {
  // Before: 200 KB of "<script " took 2.1 s and "<meta " 2.8 s per name, growing with the square of the size.
  for (const unit of ["<script ", "<meta ", "<link ", '<script type="application/ld+json">/* ', "<script type=application/ld+json ", '<meta property="og:title" ']) {
    const html = fill(unit);
    const { ms } = timed(() => {
      jsonLdNodes(html);
      metaContent(html, "og:type", "og:title", "books:author", "book:author", "books:isbn", "product:price:amount", "og:site_name");
      detectFromHtml(html, "https://hostile.example/page");
      faviconHref(html, "https://hostile.example/page");
    });
    assert.ok(ms < 500, `${JSON.stringify(unit)} took ${Math.round(ms)} ms`);
  }
  // The same tags closed only at the very end: still one pass.
  for (const unit of ["<script ", "<meta ", "<link "]) {
    const html = `${fill(unit)}>`;
    const { ms } = timed(() => [jsonLdNodes(html), metaContent(html, "og:type", "og:title"), faviconHref(html, "https://hostile.example/")]);
    assert.ok(ms < 500, `${JSON.stringify(unit)} closed at the end took ${Math.round(ms)} ms`);
  }
});

test("M18: metadata still reads as before, and only from the first 300,000 characters", () => {
  const page = `<html><head>
    <META Property="og:type" content="book">
    <meta content='Lapvona &amp; more' property="og:title">
    <meta name="empty" content=""><meta name="fallback" content="second">
    <meta property="twice" data-content="no" content="yes">
    <metadata property="og:type" content="wrong"></metadata>
    <script>var s = "<script type=application/ld+json>";</script>
    <script type="application/ld+json">/* <![CDATA[ */ {"@graph":[{"@type":"Book","name":"Lapvona"}]} /* ]]> */</script>
    <script type='application/ld+json'>not json</script>
    <SCRIPT TYPE="application/ld+json"><!--{"@type":"Person","name":"Ottessa"}--></SCRIPT>
  </head></html>`;
  assert.equal(metaContent(page, "og:type"), "book");
  assert.equal(metaContent(page, "og:title"), "Lapvona & more");
  assert.equal(metaContent(page, "empty", "fallback"), "second", "an empty first match falls through to the next name");
  assert.equal(metaContent(page, "twice"), "yes");
  assert.equal(metaContent(page, "missing"), undefined);
  assert.deepEqual(
    jsonLdNodes(page).map((n) => n["@type"] ?? "graph"),
    ["graph", "Book", "Person"],
  );
  const late = `${" ".repeat(META_SCAN_CHARS)}<meta property="og:type" content="book"><script type="application/ld+json">{"@type":"Book"}</script>`;
  assert.equal(metaContent(late, "og:type"), undefined);
  assert.deepEqual(jsonLdNodes(late), []);
});

// ---------- M21: nested pages ----------

test("M21: a page of unclosed <div> is refused from its text, never parsed", async () => {
  // Before: 20,000 nested <div> (100 KB) ran for 32 s and threw RangeError; 80,000 did not finish.
  for (const n of [20_000, 80_000, 750_000]) {
    const html = fill("<div>", n * 5);
    const { ms, out } = timed(() => [tooDeep(html), extractPage(html, "https://hostile.example/")] as const);
    assert.ok(ms < 500, `${n} nested took ${Math.round(ms)} ms`);
    assert.equal(out[0], true);
    assert.deepEqual(out[1], { title: null, site_name: null, author: null, published_at: null, excerpt: null, image: null, text: null, words: 0 });
  }
  // Mixed tags, attributes and comments in the way don't hide it.
  assert.equal(tooDeep(fill('<section class="a"><!-- <div> --><b><span data-x=">">', 200_000)), true);

  // The preview route gets "failed", not an exception.
  const realFetch = previewDeps.fetchHtml;
  previewDeps.fetchHtml = async (url) => ({ html: fill("<div>", 100_000), url });
  try {
    const { ms, out } = await (async () => {
      const t = performance.now();
      const out = await readPreview("https://hostile.example/deep");
      return { ms: performance.now() - t, out };
    })();
    assert.equal(out.status, "failed");
    assert.ok(ms < 500, `readPreview took ${Math.round(ms)} ms`);
    // Anything else the page read throws is "failed" too.
    previewDeps.fetchHtml = async () => ({ html: null as unknown as string, url: "https://hostile.example/" });
    assert.equal((await readPreview("https://hostile.example/broken")).status, "failed");
  } finally {
    previewDeps.fetchHtml = realFetch;
  }
});

test("M21: ordinary pages aren't mistaken for deep ones", () => {
  // Tags HTML closes by itself are siblings, as in linkedom's parser.
  for (const unit of ["<p>text", "<li>item", "<tr><td>cell<td>cell", "<dt>a<dd>b", "<option>x", "<br>", '<img src="a.png">', "<div>x</div>", "<p>a <b>b</b></p>"]) {
    const shape = pageShape(`<html><body><table><ul>${unit.repeat(2_000)}</ul></table></body></html>`);
    assert.ok(shape.depth <= 8, `${unit}: depth ${shape.depth}`);
  }
  assert.equal(pageShape("<div>".repeat(MAX_PAGE_DEPTH - 1)).depth, MAX_PAGE_DEPTH - 1);
  assert.equal(tooDeep("<div>".repeat(MAX_PAGE_DEPTH)), false);
  assert.equal(tooDeep("<div>".repeat(MAX_PAGE_DEPTH + 1)), true);
  // Script and style text isn't markup.
  assert.equal(pageShape(`<html><body><script>${'document.write("<div>");'.repeat(5_000)}</script><p>x</p></body></html>`).depth, 3);
  assert.deepEqual(pageShape('<html><head><title>T</title></head><body><p>one</p><p>two <a href="/">x</a></p></body></html>'), { depth: 4, elements: 7 });
});

test("M21: a flat page over 20,000 elements keeps its preview and skips Readability", () => {
  // Before: 3 MB of repeated links ran Readability for 17 s and 1.3 GB.
  const words = "A sentence of ordinary words that would count as article text. ".repeat(4);
  const html = `<html><head><title>Long list</title><meta property="og:description" content="Summary"></head><body><article>${`<p>${words}</p>`.repeat(200)}${'<a href="/x">x</a>'.repeat(MAX_READABLE_ELEMS)}</article></body></html>`;
  const { ms, out } = timed(() => extractPage(html, "https://hostile.example/list"));
  assert.equal(out.title, "Long list");
  assert.equal(out.excerpt, "Summary");
  assert.equal(out.text, null);
  assert.ok(ms < 2_000, `took ${Math.round(ms)} ms`);
  // The same article under the limit is still read.
  const small = extractPage(`<html><head><title>Long list</title></head><body><article>${`<p>${words}</p>`.repeat(200)}</article></body></html>`, "https://ok.example/a");
  assert.ok((small.text ?? "").length > 1_000);
});

// ---------- M20: image decode ----------

/** A valid interlaced 16-bit RGB PNG of zeros, built without ever holding its pixels (7700×7700 is 461 KB on the wire, 356 MB decoded). */
async function zeroPng(width: number, height: number): Promise<Buffer> {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([16, 2, 0, 0, 1], 8); // 16-bit, RGB, Adam7 interlaced
  // Adam7: each pass's rows are a filter byte and 6 bytes a pixel; every byte is zero.
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let raw = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const cols = Math.ceil((width - x0) / dx);
    const rows = Math.ceil((height - y0) / dy);
    if (cols > 0 && rows > 0) raw += rows * (1 + cols * 6);
  }
  const deflate = createDeflate({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (b: Buffer) => parts.push(b));
  const done = new Promise<void>((resolve, reject) => deflate.on("end", resolve).on("error", reject));
  const zeros = Buffer.alloc(1 << 20);
  for (let left = raw; left > 0; left -= zeros.length) {
    if (!deflate.write(left >= zeros.length ? zeros : zeros.subarray(0, left))) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await done;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat(parts)), chunk("IEND", Buffer.alloc(0))]);
}

/** The most memory this process has held so far, in MB (a decode's memory is freed before it can be read any other way). */
const peakMb = () => process.resourceUsage().maxRSS / 1024;

test("M20: the 461 KB PNG that took 1.1 GB is refused from its header", async () => {
  sharp.cache(false);
  const bomb = await zeroPng(7700, 7700);
  assert.ok(bomb.byteLength < 600_000, `the file is small (${bomb.byteLength} bytes)`);
  assert.equal((await sharp(bomb).metadata()).width, 7700, "and a real PNG");
  const before = peakMb();
  const t = performance.now();
  await assert.rejects(decodeImage(bomb, 1600));
  await assert.rejects(prepareArt(bomb));
  // A link preview with it as the page's picture: the card comes back without one.
  const realHtml = previewDeps.fetchHtml;
  const realImage = previewDeps.fetchImage;
  previewDeps.fetchHtml = async (url) => ({ html: '<html><head><title>Pic</title><meta property="og:image" content="https://hostile.example/bomb.png"></head><body></body></html>', url });
  previewDeps.fetchImage = async () => bomb;
  try {
    const read = await readPreview("https://hostile.example/pic");
    assert.equal(read.status, "ok");
    assert.equal(read.title, "Pic");
    assert.equal(read.image, null);
  } finally {
    previewDeps.fetchHtml = realHtml;
    previewDeps.fetchImage = realImage;
  }
  const ms = performance.now() - t;
  const grew = peakMb() - before;
  assert.ok(ms < 1_000, `took ${Math.round(ms)} ms`);
  assert.ok(grew < 100, `peak memory grew ${Math.round(grew)} MB`);
});

test("M20: the largest image still accepted is decoded once, not three times", async () => {
  sharp.cache(false);
  const side = Math.floor(Math.sqrt(MAX_DECODE_PIXELS)); // 5000×5000, 16-bit interlaced: 150 MB a decode
  const big = await zeroPng(side, side);
  const before = peakMb();
  const art = await prepareArt(big);
  const grew = peakMb() - before;
  assert.deepEqual([art.w, art.h, art.tone], [800, 800, "#000000"]);
  console.log(`  (decode of ${side}×${side}: peak memory grew ${Math.round(grew)} MB)`);
  assert.ok(grew < 300, `peak memory grew ${Math.round(grew)} MB`);
  // One pixel over the limit is refused.
  await assert.rejects(decodeImage(await zeroPng(side + 1, side), 1600));
});

test("M20: decodeImage turns, shrinks and never enlarges; sizes come from the one decode", async () => {
  // A 300×200 JPEG whose EXIF says "rotate 90°": the decoded picture is 200×300.
  const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 40, b: 40 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const d = await decodeImage(jpeg, 150);
  assert.deepEqual([d.w, d.h], [100, 150]);
  const small = await d.from().resize({ width: 50, height: 50, fit: "inside" }).webp().toBuffer({ resolveWithObject: true });
  assert.deepEqual([small.info.width, small.info.height, small.info.format], [33, 50, "webp"]);
  const same = await decodeImage(jpeg, 1600);
  assert.deepEqual([same.w, same.h], [200, 300]);
  // Greyscale with alpha, and a palette GIF, come out as colour pixels.
  const grey = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 0.5 } } }).greyscale().png().toBuffer();
  assert.deepEqual([(await decodeImage(grey, 100)).w, (await decodeImage(grey, 100)).h], [20, 10]);
  const gif = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 0, g: 0, b: 255 } } }).gif().toBuffer();
  const mean = await (await decodeImage(gif, 100)).from().removeAlpha().resize(1, 1, { fit: "fill" }).raw().toBuffer();
  assert.ok(mean[2] > 200 && mean[0] < 50, "blue stays blue");
  await assert.rejects(decodeImage(Buffer.from("not an image"), 100));
});

test("M20: a 50 megapixel JPEG (a full-size phone photo) is kept, cheaply; over 60 is refused", async () => {
  sharp.cache(false);
  // 8160×6120: decoded at a reduced size, so it never holds the full picture.
  const photo = await sharp({ create: { width: 8160, height: 6120, channels: 3, background: { r: 136, g: 68, b: 34 } } }).jpeg().toBuffer();
  const before = peakMb();
  const t = performance.now();
  const d = await decodeImage(photo, 1600);
  const art = await prepareArt(photo);
  const ms = performance.now() - t;
  const grew = peakMb() - before;
  assert.deepEqual([d.w, d.h, art.w, art.h], [1600, 1200, 800, 600]);
  assert.ok(ms < 2_000, `took ${Math.round(ms)} ms`);
  assert.ok(grew < 150, `peak memory grew ${Math.round(grew)} MB`);
  // Past 60 megapixels a JPEG is refused from its header too.
  const huge = await sharp({ create: { width: 8000, height: 7600, channels: 3, background: "#000" }, limitInputPixels: false }).jpeg().toBuffer();
  const t2 = performance.now();
  await assert.rejects(decodeImage(huge, 1600));
  assert.ok(performance.now() - t2 < 500);
  // The higher limit is for JPEG bytes only: the same size as a PNG stays refused (the bomb above is 59 megapixels).
  await assert.rejects(decodeImage(await zeroPng(6000, 5000), 1600));
});

// ---------- M5: push endpoints ----------

test("M5: a subscription endpoint must be on a known push service", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc:DEF_123",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QOb2",
    "https://api.sandbox.push.apple.com/3/device/x",
    "https://wns2-db5p.notify.windows.com/w/?token=AwYAAAC",
    "https://FCM.googleapis.com:443/fcm/send/abc",
  ]) {
    assert.equal(pushEndpoint(ok), ok, ok);
  }
  for (const bad of [
    "https://attacker.example/collect",
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://user@web.push.apple.com/x",
    "https://fcm.googleapis.com.attacker.example/fcm/send/abc",
    "https://attacker.example/fcm.googleapis.com",
    "https://attacker.example/?x=.push.apple.com",
    "https://push.apple.com.attacker.example/x",
    "https://evilpush.apple.com/x",
    "https://notify.windows.com.attacker.example/x",
    "https://fcm.googleapis.com./fcm/send/abc",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "https://[::1]/x",
    "wss://web.push.apple.com/x",
    `https://web.push.apple.com/${"x".repeat(2_100)}`,
    "not a url",
    "",
    null,
    42,
    { href: "https://web.push.apple.com/x" },
  ]) {
    assert.equal(pushEndpoint(bad), null, String(bad));
  }
});

test("M5: a subscription's credential is the master token by a fingerprint of it, or an API key by its id, never a token", () => {
  const was = process.env.MCP_BEARER_TOKEN;
  try {
    process.env.MCP_BEARER_TOKEN = "master-token-one";
    const a = pushCredential({ id: "master" });
    assert.match(a ?? "", /^[0-9a-f]{32}$/);
    assert.equal(pushCredential({ id: "master" }), a);
    assert.ok(!a!.includes("master-token-one"));
    process.env.MCP_BEARER_TOKEN = "master-token-two";
    assert.notEqual(pushCredential({ id: "master" }), a, "a new master token drops its subscriptions");
    const key = pushCredential({ id: "key:5a3e0000-0000-4000-8000-000000000001" });
    assert.match(key ?? "", /^[0-9a-f]{32}$/);
    assert.notEqual(key, pushCredential({ id: "key:5a3e0000-0000-4000-8000-000000000002" }));
    assert.equal(pushCredential({ id: "something else" }), null);
    delete process.env.MCP_BEARER_TOKEN;
    assert.equal(pushCredential({ id: "master" }), null);
  } finally {
    if (was === undefined) delete process.env.MCP_BEARER_TOKEN;
    else process.env.MCP_BEARER_TOKEN = was;
  }
});

// ---------- M4: the login limit ----------

test("M4: the login form has a platform rate limit, as a plain object Netlify can read", async () => {
  const { config } = await import("../netlify/edge-functions/login-limit");
  assert.deepEqual(config, { path: "/login", method: "POST", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } });
  assert.ok(config.rateLimit.windowSize <= 180, "Netlify's maximum window");
});
