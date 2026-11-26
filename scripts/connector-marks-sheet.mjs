/**
 * Contact sheet of every connector mark at tile size, in light and dark,
 * each beside its preset's name, for checking marks against the services'
 * brand pages.
 *
 *   npm run dev:app          # in another terminal
 *   node scripts/connector-marks-sheet.mjs [http://localhost:5173]
 *
 * Renders the app's own brandLogo() with the app's own CSS through the Vite
 * dev server, so the sheet shows exactly what Settings shows. Writes
 * shots/connectors/marks-{light,dark}.png at 2x (git-ignored).
 */

import { createRequire } from "node:module";
// Playwright is installed globally (not a dependency), which ESM imports cannot see.
const { chromium } = createRequire(import.meta.url)("playwright");
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://localhost:5173";
const out = resolve("shots/connectors");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1200, height: 800 } });
  // No server behind the dev app: answer every API call empty so nothing waits.
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, body: "{}", contentType: "application/json" }));
  await page.goto(base, { waitUntil: "load" });
  await page.evaluate(async (root) => {
    const { brandLogo } = await import("/src/components/brand-logo.ts");
    // Vite serves files outside app/ under /@fs/ (lib/ is the repo's shared code).
    const { CONNECTOR_PRESETS } = await import(`/@fs${root}/lib/connector-presets.ts`);
    document.body.replaceChildren();
    document.body.style.cssText = "margin:0;padding:24px;background:var(--canvas, var(--bg))";
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(5, 1fr);gap:10px 18px;width:1150px;font:13px/1.3 Geist, system-ui, sans-serif;color:var(--ink)";
    for (const p of CONNECTOR_PRESETS) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:10px";
      const name = document.createElement("span");
      name.innerHTML = `${p.label}<br><span style="color:var(--ink-3, var(--muted));font-size:11px">${p.id}</span>`;
      row.append(brandLogo(p.id, "md"), brandLogo(p.id, "sm"), name);
      grid.append(row);
    }
    document.body.append(grid);
  }, resolve("."));
  await page.waitForTimeout(300);
  const grid = page.locator("body > div");
  await grid.screenshot({ path: `${out}/marks-${scheme}.png` });
  await page.close();
}
await browser.close();
console.log(`wrote ${out}/marks-{light,dark}.png`);
