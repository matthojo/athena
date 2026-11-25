import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { APPEARANCE_KEY, APPEARANCES, applyAppearance, asAppearance, darkSource, refreshSchemeSources, resolveScheme, type Appearance } from "./appearance";
import { BOOT_MARKER, BOOT_SCRIPT } from "./appearance-boot";
import { parseColour, toHex } from "./cover-ink";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const INDEX = read("../../index.html");
const TOKENS = read("../styles/tokens.css");

/** index.html's <head>, as a document. */
const page = () => parseHTML(INDEX.replace(BOOT_MARKER, "")).document;

/** Run the first-paint script against a document, a stored value and the system's scheme. */
function boot(stored: string | null | "throws", systemDark: boolean) {
  const document = page();
  const localStorage = {
    getItem(key: string) {
      if (stored === "throws") throw new Error("SecurityError");
      return key === APPEARANCE_KEY ? stored : null;
    },
  };
  const window = { matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && systemDark }) };
  new Function("document", "window", "localStorage", BOOT_SCRIPT)(document, window, localStorage);
  return document;
}

const themeColours = (doc: Document) => [...doc.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));

test("a choice resolves to a scheme; anything unknown is the system's", () => {
  assert.deepEqual(APPEARANCES, ["system", "light", "dark"]);
  assert.equal(resolveScheme("system", false), "light");
  assert.equal(resolveScheme("system", true), "dark");
  assert.equal(resolveScheme("light", true), "light");
  assert.equal(resolveScheme("dark", false), "dark");
  assert.equal(asAppearance("dark"), "dark");
  assert.equal(asAppearance("light"), "light");
  assert.equal(asAppearance(null), "system");
  assert.equal(asAppearance("sepia"), "system");
});

test("the first-paint script sets the scheme from the stored choice, or the system's", () => {
  const cases: Array<[string | null | "throws", boolean, Appearance, "light" | "dark"]> = [
    [null, false, "system", "light"],
    [null, true, "system", "dark"],
    ["light", true, "light", "light"],
    ["dark", false, "dark", "dark"],
    ["sepia", true, "system", "dark"],
    ["throws", true, "system", "dark"],
    ["throws", false, "system", "light"],
  ];
  for (const [stored, systemDark, appearance, scheme] of cases) {
    const doc = boot(stored, systemDark);
    const why = `stored ${stored}, system ${systemDark ? "dark" : "light"}`;
    assert.equal(doc.documentElement.getAttribute("data-appearance"), appearance, why);
    assert.equal(doc.documentElement.getAttribute("data-scheme"), scheme, why);
    assert.equal(doc.querySelector('meta[name="color-scheme"]')!.getAttribute("content"), scheme, why);
    const colour = scheme === "dark" ? "#0c0e13" : "#f4f6f8";
    assert.deepEqual(themeColours(doc), [colour, colour], why);
  }
});

test("the first-paint script and applyAppearance agree", () => {
  for (const choice of APPEARANCES) {
    for (const systemDark of [false, true]) {
      const booted = boot(choice === "system" ? null : choice, systemDark);
      const applied = page();
      assert.equal(applyAppearance(applied, choice, systemDark), resolveScheme(choice, systemDark));
      for (const attr of ["data-appearance", "data-scheme"]) assert.equal(applied.documentElement.getAttribute(attr), booted.documentElement.getAttribute(attr));
      assert.deepEqual(themeColours(applied), themeColours(booted));
      assert.equal(applied.querySelector('meta[name="color-scheme"]')!.getAttribute("content"), booted.querySelector('meta[name="color-scheme"]')!.getAttribute("content"));
    }
  }
});

test("the script runs before any stylesheet, after the metas it sets", () => {
  const at = INDEX.indexOf(BOOT_MARKER);
  assert.ok(at > 0, "index.html has the marker vite.config.ts replaces");
  assert.ok(at > INDEX.lastIndexOf('name="theme-color"'));
  assert.ok(at > INDEX.indexOf('name="color-scheme"'));
  assert.ok(at < INDEX.indexOf('rel="stylesheet"'));
  assert.ok(at < INDEX.indexOf("<script"));
  assert.match(read("../../vite.config.ts"), /transformIndexHtml: \(html\) => html\.replace\(BOOT_MARKER, `<script>\$\{BOOT_SCRIPT\}<\/script>`\)/);
});

/** --theme-page in a scheme, as the hex a theme-color meta takes. */
function pageHex(scheme: "light" | "dark"): string {
  const block = scheme === "light" ? TOKENS.slice(TOKENS.indexOf(":root {")) : TOKENS.slice(TOKENS.indexOf(':root:where([data-scheme="dark"]) {'));
  const value = /--theme-page:\s*([^;]+);/.exec(block)![1];
  return toHex(parseColour(value)!);
}

test("theme-color and the manifest match the page colour in tokens.css", () => {
  const light = pageHex("light");
  const dark = pageHex("dark");
  for (const meta of page().querySelectorAll('meta[name="theme-color"]')) {
    assert.equal(meta.getAttribute("data-light"), light);
    assert.equal(meta.getAttribute("data-dark"), dark);
  }
  // The manifest can hold one colour; an installed app's splash is light, as before.
  const manifest = JSON.parse(read("../../public/manifest.json")) as { theme_color: string; background_color: string };
  assert.equal(manifest.theme_color, light);
  assert.equal(manifest.background_color, light);
});

test("a picture's dark version is shown while the app is dark, and follows a change", () => {
  const { document } = parseHTML('<html data-scheme="light"><body><picture id="p"></picture></body></html>');
  const g = globalThis as { document?: Document };
  const before = g.document;
  g.document = document;
  try {
    const source = darkSource("data:image/png;base64,AAAA");
    document.getElementById("p")!.append(source);
    assert.equal(source.getAttribute("media"), "not all");
    document.documentElement.setAttribute("data-scheme", "dark");
    refreshSchemeSources(document);
    assert.equal(source.getAttribute("media"), "all");
    document.documentElement.setAttribute("data-scheme", "light");
    refreshSchemeSources(document);
    assert.equal(source.getAttribute("media"), "not all");
  } finally {
    g.document = before;
  }
});

test("one switch: nothing else asks for the system's scheme", () => {
  assert.match(TOKENS, /:root \{\n {2}color-scheme: light;/);
  assert.match(TOKENS, /:root:where\(\[data-scheme="dark"\]\) \{\n {2}color-scheme: dark;/);
  const src = fileURLToPath(new URL("../", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const asking = walk(src)
    .filter((f) => /\.(css|ts)$/.test(f) && !/\.test\.ts$|lib\/appearance(-boot)?\.ts$/.test(f))
    .filter((f) => /prefers-color-scheme/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
  assert.deepEqual(asking, []);
});
