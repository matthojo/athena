// End-to-end: loads the unpacked extension (dist/chrome-e2e) in Chromium and
// saves against the mock /api/saved. With --shots, also writes screenshots to
// shots/extension/ at the repository root (git-ignored).
//   npm run test:e2e        npm run shots

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, startMock } from "./mock-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist", "chrome-e2e");
const shotsDir = join(root, "..", "shots", "extension");
const SHOTS = process.argv.includes("--shots");

const mock = await startMock();
const profile = mkdtempSync(join(tmpdir(), "athena-ext-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  deviceScaleFactor: SHOTS ? 2 : 1,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

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

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function shot(page, name, target) {
  if (!SHOTS) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.waitForTimeout(400); // fonts and the toast's entrance
  await (target || page).screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  const base = `chrome-extension://${id}`;
  const items = () => mock.items;
  const capture = (menuId, info, tabId) =>
    sw.evaluate(
      async ([menuId, info, tabId]) => globalThis.athena.capture(menuId, info, await chrome.tabs.get(tabId)),
      [menuId, info, tabId],
    );

  // The install opens the options page; use our own.
  for (const p of context.pages()) if (p.url().startsWith(base)) await p.close();

  const options = await context.newPage();
  await step("options: refuses a full-access key and a bad address", async () => {
    await options.goto(`${base}/options.html`);
    await options.fill("#address", "not an address");
    await options.fill("#key", "athk_" + "x".repeat(40));
    await options.click("#save");
    assert.match(await options.textContent("#address-error"), /web address/);
    assert.match(await options.textContent("#key-error"), /full-access/);
  });

  await step("options: Save stores the address and Test connects", async () => {
    await options.fill("#address", mock.origin + "/settings");
    await options.fill("#key", KEY);
    await options.click("#save");
    await options.waitForSelector("#status.good");
    assert.match(await options.textContent("#status"), /Connected/);
    const stored = await sw.evaluate(() => chrome.storage.local.get("settings"));
    assert.deepEqual(stored.settings, { origin: mock.origin, key: KEY });
    await options.click("#test");
    await options.waitForSelector("#status.good");
  });

  for (const scheme of ["light", "dark"]) {
    await options.emulateMedia({ colorScheme: scheme });
    await options.setViewportSize({ width: 900, height: 980 });
    await shot(options, `options-${scheme}`);
  }

  const page = await context.newPage();
  await page.goto(`${mock.origin}/page`);
  const tabId = await sw.evaluate(
    async (url) => (await chrome.tabs.query({ url: url + "/page" }))[0].id,
    mock.origin,
  );

  await step("popup: saves the page, shows the link, adds a note", async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 300 });
    await popup.goto(`${base}/popup.html?tab=${tabId}`);
    await popup.waitForSelector("#status.good");
    const link = await popup.getAttribute("#status a", "href");
    const item = items().at(-1);
    assert.equal(item.url, `${mock.origin}/page`);
    assert.equal(item.title, "Notes on slow software");
    assert.equal(item.source, "extension");
    assert.equal(item.kind, "page");
    assert.equal(link, `${mock.origin}/#/saved/${item.id}`);
    for (const scheme of ["light", "dark"]) {
      await popup.emulateMedia({ colorScheme: scheme });
      await shot(popup, `popup-saved-${scheme}`, popup.locator("main"));
    }
    await popup.fill("#note", "Worth rereading before the tools review.");
    await popup.keyboard.press("Control+Enter");
    await popup.waitForSelector("#status.good >> text=with your note");
    assert.equal(item.note, "Worth rereading before the tools review.");
    assert.equal(items().filter((i) => i.client_id === item.client_id).length, 1);
    await popup.close();
  });

  await step("menu: Save selection as a quote keeps the text exactly", async () => {
    const expected = await page.evaluate(() => {
      const el = document.getElementById("quote");
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return getSelection().toString();
    });
    assert.match(expected, /\n\t/, "the test text has a line break and a tab");
    const result = await capture("save-selection", { frameId: 0, selectionText: "collapsed by the browser" }, tabId);
    assert.equal(result.status, "saved");
    const item = items().at(-1);
    assert.equal(item.selection, expected);
    assert.equal(item.url, `${mock.origin}/page`);
    assert.equal(item.title, "Notes on slow software");
    await page.waitForSelector("#athena-save-toast");
    await page.evaluate(() => getSelection().removeAllRanges());
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 900, height: 520 });
      await shot(page, `menu-quote-saved-${scheme}`);
    }
  });

  await step("menu: Save image sends bytes for a private address", async () => {
    const result = await capture("save-image", { frameId: 0, srcUrl: `${mock.origin}/cat.png`, mediaType: "image" }, tabId);
    assert.equal(result.status, "saved");
    const item = items().at(-1);
    assert.equal(item.kind, "image");
    assert.equal(item.url, `${mock.origin}/cat.png`);
    assert.equal(item.source_url, `${mock.origin}/page`);
    assert.ok(item.multipart && item.image.size > 100 && item.image.type === "image/png", JSON.stringify(item.image));
  });

  await step("menu: Save link and Save page", async () => {
    await capture("save-link", { frameId: 0, linkUrl: "https://example.com/essay", linkText: "the full essay" }, tabId);
    let item = items().at(-1);
    assert.deepEqual([item.kind, item.url, item.title, item.source_url], ["link", "https://example.com/essay", "the full essay", `${mock.origin}/page`]);
    await capture("save-page", { frameId: 0 }, tabId);
    item = items().at(-1);
    assert.deepEqual([item.kind, item.url], ["page", `${mock.origin}/page`]);
  });

  await step("offline: queued with a badge, then sent once, with no duplicate", async () => {
    const before = items().length;
    mock.state.down = true;
    let popup;
    try {
    const result = await capture("save-link", { frameId: 0, linkUrl: "https://example.com/later", linkText: "Later" }, tabId);
    assert.equal(result.status, "queued");
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), "1");
    await page.waitForSelector('#athena-save-toast[data-title="Saved for later"]');
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(page, `menu-offline-queued-${scheme}`);
    }
    popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 300 });
    await popup.goto(`${base}/popup.html?tab=${tabId}`);
    await popup.waitForSelector("#status.warn");
    await popup.waitForSelector("#outbox li");
    for (const scheme of ["light", "dark"]) {
      await popup.emulateMedia({ colorScheme: scheme });
      await shot(popup, `popup-offline-${scheme}`, popup.locator("main"));
    }
    } finally {
      mock.state.down = false;
    }
    await popup.click("#retry-all");
    await until(() => items().length === before + 2);
    await until(async () => (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "");
    await sw.evaluate(() => globalThis.athena.queue.flush({ force: true }));
    assert.equal(items().length, before + 2, "nothing sent twice");
    await popup.close();
  });

  await step("bad key: held with a clear message, sent after the key is fixed", async () => {
    await sw.evaluate((origin) => chrome.storage.local.set({ settings: { origin, key: "athc_wrongwrongwrongwrong" } }), mock.origin);
    const before = items().length;
    const result = await capture("save-page", { frameId: 0 }, tabId);
    assert.deepEqual([result.status, result.reason], ["held", "auth"]);
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), "!");
    await page.waitForSelector('#athena-save-toast[data-title="Not sent yet"]');
    await options.reload();
    await options.waitForSelector("#outbox li");
    assert.match(await options.textContent("#outbox"), /didn't accept the key/);
    await options.fill("#key", KEY);
    await options.click("#save");
    await options.waitForSelector("#status.good");
    await until(() => items().length === before + 1);
  });

  await step("unreachable Athena: Test says so", async () => {
    await options.fill("#address", "http://127.0.0.1:9");
    await options.click("#test");
    await options.waitForSelector("#status.bad");
    assert.match(await options.textContent("#status"), /Couldn't reach/);
  });
} finally {
  await context.close();
  await mock.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(steps.join("\n"));
if (failed) process.exit(1);
