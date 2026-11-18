// The real browser UI: right-click menus and the keyboard shortcut, in headed
// Chromium under Xvfb, clicked with xdotool. Uses the plain Chrome build (no
// test host permission), so reading the selection and the image works only
// through the activeTab grant a real menu click gives.
//   xvfb-run -a -s "-screen 0 1280x900x24" node e2e/native.mjs [--shots]
// Needs Xvfb, xdotool and ImageMagick's `import`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, startMock } from "./mock-server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist", "chrome");
const shotsDir = join(root, "..", "docs", "notes", "shots-extension");
const SHOTS = process.argv.includes("--shots");

if (!process.env.DISPLAY) {
  console.error("Run under xvfb-run (see the comment at the top).");
  process.exit(2);
}

const x = (...args) => execFileSync("xdotool", args.map(String));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMock();
const profile = mkdtempSync(join(tmpdir(), "athena-native-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 900, height: 600 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--window-position=0,0", "--window-size=1000,760"],
});

let failed = false;
const steps = [];
async function step(name, fn) {
  try {
    await fn();
    steps.push(`ok   ${name}`);
  } catch (err) {
    failed = true;
    steps.push(`FAIL ${name}\n     ${String(err?.stack || err).split("\n").slice(0, 3).join("\n     ")}`);
  }
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await sleep(100);
  }
};

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  for (const p of context.pages()) if (p.url().includes(id)) await p.close();
  // Settings straight into storage: a script can't click the browser's
  // permission prompt. Without the grant, saves rely on Athena's CORS.
  await sw.evaluate(([origin, key]) => chrome.storage.local.set({ settings: { origin, key } }), [mock.origin, KEY]);
  const granted = await sw.evaluate((o) => chrome.permissions.contains({ origins: [o + "/*"] }), mock.origin);
  assert.equal(granted, false, "plain build: no host access to the page");

  const page = await context.newPage();
  await page.goto(`${mock.origin}/page`);
  await page.bringToFront();
  const items = () => mock.items;

  // Opens the page's context menu at an element and picks our item, counting
  // up from the bottom: just above Inspect, or above View page source too on
  // the page menu.
  async function menu(selector, shotName, ups = 2) {
    const box = await page.locator(selector).boundingBox();
    x("mousemove", 1250, 880);
    await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + Math.min(10, box.height / 2), { button: "right" });
    await sleep(800);
    if (SHOTS && shotName) execFileSync("import", ["-window", "root", "-crop", "908x731+0+0", join(shotsDir, `${shotName}.png`)]);
    x("key", ...Array(ups).fill("Up"), "Return");
  }

  if (SHOTS) mkdirSync(shotsDir, { recursive: true });

  await step("real menu: Save selection as a quote, exact text", async () => {
    const expected = await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById("quote"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return getSelection().toString();
    });
    const before = items().length;
    await menu("#quote", "menu-native-selection");
    await until(() => items().length === before + 1);
    const item = items().at(-1);
    assert.equal(item.selection, expected, "exact text, read through activeTab");
    assert.deepEqual([item.url, item.title, item.source], [`${mock.origin}/page`, "Notes on slow software", "extension"]);
    await until(() => page.locator("#athena-save-toast").count());
    if (SHOTS) {
      await sleep(500);
      execFileSync("import", ["-window", "root", "-crop", "908x731+0+0", join(shotsDir, "menu-native-result.png")]);
    }
  });

  await step("real menu: Save link", async () => {
    await page.evaluate(() => getSelection().removeAllRanges());
    const before = items().length;
    await menu("#link");
    await until(() => items().length === before + 1);
    assert.deepEqual([items().at(-1).url, items().at(-1).source_url], ["https://example.com/essay", `${mock.origin}/page`]);
  });

  await step("real menu: Save image, with the bytes", async () => {
    const before = items().length;
    await menu("#img");
    await until(() => items().length === before + 1);
    const item = items().at(-1);
    assert.equal(item.url, `${mock.origin}/cat.png`);
    assert.ok(item.multipart && item.image?.type === "image/png", JSON.stringify(item.image));
  });

  await step("real menu: Save page", async () => {
    const before = items().length;
    await menu("h1", null, 3);
    await until(() => items().length === before + 1);
    assert.deepEqual([items().at(-1).kind, items().at(-1).url], ["page", `${mock.origin}/page`]);
  });

  await step("real shortcut: Alt+Shift+S saves the page", async () => {
    const before = items().length;
    await page.mouse.click(600, 500);
    x("key", "alt+shift+s");
    await until(() => items().length === before + 1);
    assert.equal(items().at(-1).url, `${mock.origin}/page`);
  });
} finally {
  await context.close();
  await mock.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(steps.join("\n"));
if (failed) process.exit(1);
