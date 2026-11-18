// End-to-end against a real Athena: the unpacked extension (dist/chrome-e2e)
// saves to the Saved API, and the items are read back through the app's own
// list route. The test page comes from the mock server; Athena is real.
//   ATHENA_ORIGIN=http://127.0.0.1:PORT ATHENA_KEY=athc_… ATHENA_MASTER=<app token> node e2e/real.mjs
// ATHENA_ORIGIN must be on 127.0.0.1 (the e2e build's only host permission).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { ATHENA_ORIGIN: athena, ATHENA_KEY: key, ATHENA_MASTER: master } = process.env;
if (!athena || !key || !master) {
  console.error("Set ATHENA_ORIGIN, ATHENA_KEY and ATHENA_MASTER (see the top of this file).");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist", "chrome-e2e");
const site = await startMock(); // only its test page and image
const profile = mkdtempSync(join(tmpdir(), "athena-real-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const items = async () => {
  const res = await fetch(`${athena}/api/saved?limit=50`, { headers: { Authorization: `Bearer ${master}` } });
  const body = await res.json();
  return body.items ?? body;
};
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
};

let failed = false;
const steps = [];
async function step(name, fn) {
  try {
    await fn();
    steps.push(`ok   ${name}`);
  } catch (err) {
    failed = true;
    steps.push(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 4).join("\n     ")}`);
  }
}

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  for (const p of context.pages()) if (p.url().startsWith(base)) await p.close();
  const capture = (menuId, info, tabId) =>
    sw.evaluate(async ([m, i, t]) => globalThis.athena.capture(m, i, await chrome.tabs.get(t)), [menuId, info, tabId]);

  const options = await context.newPage();
  await step("options: Save and Test against the real ping", async () => {
    await options.goto(`${base}/options.html`);
    await options.fill("#address", athena);
    await options.fill("#key", key);
    await options.click("#save");
    await options.waitForSelector("#status.good", { timeout: 15000 });
  });

  const page = await context.newPage();
  await page.goto(`${site.origin}/page`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${site.origin}/page`);

  await step("popup: page saved as a link with its readable copy, then a note added", async () => {
    const popup = await context.newPage();
    await popup.goto(`${base}/popup.html?tab=${tabId}`);
    await popup.waitForSelector("#status.good", { timeout: 20000 });
    const href = await popup.getAttribute("#status a", "href");
    const item = (await items()).find((i) => i.url === `${site.origin}/page`);
    assert.ok(item, "the page is in Saved");
    assert.equal(item.kind, "link");
    assert.equal(item.source, "extension");
    assert.equal(href, `${athena}/#/saved/${item.id}`);
    await popup.fill("#note", "Worth rereading before the tools review.");
    await popup.click("#note-save");
    await popup.waitForSelector("#status.good >> text=with your note");
    await until(async () => (await items()).find((i) => i.id === item.id)?.note === "Worth rereading before the tools review.");
    assert.equal((await items()).filter((i) => i.url === `${site.origin}/page`).length, 1, "no duplicate");
    await popup.close();
  });

  await step("menu: quote keeps the selection exactly", async () => {
    const expected = await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById("quote"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return getSelection().toString();
    });
    const result = await capture("save-selection", { frameId: 0, selectionText: "collapsed" }, tabId);
    assert.equal(result.status, "saved", JSON.stringify(result));
    // The list leaves quote text out; the item's own route has it.
    const { id } = (await items()).find((i) => i.kind === "quote");
    const res = await fetch(`${athena}/api/saved/${id}`, { headers: { Authorization: `Bearer ${master}` } });
    const body = await res.json();
    const item = body.item ?? body;
    assert.equal(item.quote, expected);
    assert.equal(item.source_url ?? item.url, `${site.origin}/page`);
  });

  await step("menu: image from a private address goes as bytes and is an image", async () => {
    const result = await capture("save-image", { frameId: 0, srcUrl: `${site.origin}/cat.png` }, tabId);
    assert.equal(result.status, "saved", JSON.stringify(result));
    const item = (await items()).find((i) => i.kind === "image");
    assert.ok(item, "an image item");
    const img = await fetch(`${athena}${item.image_url}`, { headers: { Authorization: `Bearer ${master}` } });
    assert.equal(img.status, 200);
    assert.ok((await img.arrayBuffer()).byteLength > 100);
  });

  await step("menu: link", async () => {
    const result = await capture("save-link", { frameId: 0, linkUrl: `${site.origin}/cat.png?as=link`, linkText: "a link" }, tabId);
    assert.equal(result.status, "saved", JSON.stringify(result));
    assert.ok((await items()).some((i) => i.url?.includes("as=link")));
  });

  await step("bad key: Athena's 401 holds the save, a good key sends it", async () => {
    await sw.evaluate(([o]) => chrome.storage.local.set({ settings: { origin: o, key: "athc_wrongwrongwrongwrong" } }), [athena]);
    const result = await capture("save-link", { frameId: 0, linkUrl: "https://example.com/held", linkText: "Held" }, tabId);
    assert.deepEqual([result.status, result.reason], ["held", "auth"]);
    await sw.evaluate(([o, k]) => chrome.storage.local.set({ settings: { origin: o, key: k } }), [athena, key]);
    await until(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "");
  });
} finally {
  await context.close();
  await site.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(steps.join("\n"));
if (failed) process.exit(1);
