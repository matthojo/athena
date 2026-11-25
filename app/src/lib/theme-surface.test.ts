/**
 * The theme surface (ARCHITECTURE.md, "Appearance and the theme surface"):
 * the public --theme-* tokens a theme sets, and the system tokens that
 * derive from them. Shape and type follow a few multipliers, so these check
 * that fonts and on-scale spacing in the stylesheets are tokens too (font
 * sizes and radii already are: type-scale.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const TOKENS = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8");

export const THEME_TOKENS = {
  colour: ["page", "surface", "sunken", "border", "text", "text-muted", "accent", "on-accent", "focus"],
  shape: ["radius", "density"],
  type: ["font-ui", "font-display", "font-mono", "text-scale"],
};

const block = (selector: string) => {
  const at = TOKENS.indexOf(`${selector} {`);
  return TOKENS.slice(at, TOKENS.indexOf("\n}", at));
};
const LIGHT = block(":root");
const DARK = block(':root:where([data-scheme="dark"])');

test("the public set is small, and defined where it should be", () => {
  const all = [...THEME_TOKENS.colour, ...THEME_TOKENS.shape, ...THEME_TOKENS.type];
  assert.ok(all.length >= 12 && all.length <= 20);
  const defined = [...new Set([...TOKENS.matchAll(/(--theme-[\w-]+):/g)].map((m) => m[1]))];
  assert.deepEqual(defined.sort(), all.map((t) => `--theme-${t}`).sort(), "every --theme-* token is listed here, and the other way round");
  for (const t of all) assert.match(LIGHT, new RegExp(`--theme-${t}:`), `${t} has a default`);
  // Focus follows the accent in both schemes, so only the colours that change are restated for dark.
  for (const t of THEME_TOKENS.colour.filter((c) => c !== "focus")) assert.match(DARK, new RegExp(`--theme-${t}:`), `${t} has a dark value`);
});

test("the system tokens derive from the public ones", () => {
  const derives: Record<string, string> = {
    canvas: "page", surface: "surface", sunken: "sunken", line: "border", ink: "text", "ink-2": "text-muted",
    accent: "accent", "on-accent": "on-accent", focus: "focus",
  };
  for (const [token, from] of Object.entries(derives)) {
    assert.match(TOKENS, new RegExp(`\\n  --${token}: var\\(--theme-${from}\\);`), `--${token}`);
    assert.doesNotMatch(DARK, new RegExp(`\\n  --${token}:`), `--${token} isn't restated for dark`);
  }
  // Fonts and text size: Athena's default, then a theme's, then a person's own choice on top.
  for (const f of ["ui", "display", "mono"]) assert.match(TOKENS, new RegExp(`\\n  --font-${f}: var\\(--user-font-${f}, var\\(--theme-font-${f}\\)\\);`), `--font-${f}`);
  for (const m of TOKENS.matchAll(/\n {2}--text-[\w-]+: ([^;]+);/g)) assert.match(m[1], /^calc\([\d.]+rem \* var\(--user-text-scale, var\(--theme-text-scale\)\)\)$/);
  assert.doesNotMatch(TOKENS, /--user-[\w-]+:/, "a person's overrides are unset until they choose one");
  for (const m of TOKENS.matchAll(/\n {2}--space-[\w-]+: ([^;]+);/g)) assert.match(m[1], /^calc\([\d.]+px \* var\(--theme-density\)\)$/);
  for (const m of TOKENS.matchAll(/\n {2}--radius-([\w-]+): ([^;]+);/g)) {
    if (m[1] === "pill") continue;
    assert.match(m[2], /^calc\([\d.]+px \* var\(--theme-radius\)\)$/);
  }
});

test("the Athena wordmark keeps its own face: not themed, not overridden", () => {
  const value = /\n {2}--font-wordmark: ([^;]+);/.exec(TOKENS)?.[1] ?? "";
  assert.match(value, /^"Funnel Display"/);
  assert.doesNotMatch(value, /var\(/, "written out, not taken from --theme-* or --user-*");
  const css = readFileSync(new URL("../styles/components.css", import.meta.url), "utf8");
  assert.match(css, /\n\.brand-name \{\n {2}font-family: var\(--font-wordmark\);/);
});

function sheets(): [string, string][] {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  return walk(SRC)
    .filter((f) => f.endsWith(".css") && !f.endsWith("tokens.css"))
    .map((f) => [relative(SRC, f), readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))]);
}

const lineOf = (css: string, at: number) => css.slice(0, at).split("\n").length;

test("every font family is a token", () => {
  const raw: string[] = [];
  for (const [file, css] of sheets()) {
    for (const m of css.matchAll(/(?<![\w-])font-family\s*:\s*([^;{}]+)/g)) {
      if (!/^(var\(--font-[\w-]+\)|inherit)$/.test(m[1].trim())) raw.push(`${file}:${lineOf(css, m.index!)}: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(raw, []);
});

const SCALE = new Set(["2", "4", "8", "12", "16", "24", "32", "48", "64"]);

test("spacing on the 4pt scale is written as a --space-* token, so density reaches it", () => {
  const raw: string[] = [];
  for (const [file, css] of sheets()) {
    for (const m of css.matchAll(/(?<![\w-])(?:padding|margin|gap|row-gap|column-gap|scroll-padding|scroll-margin)(?:-[a-z-]+)?\s*:\s*([^;{}]+)/g)) {
      // Only whole values at the top level: a length inside calc() or another function is part of a sum.
      let top = m[1];
      for (let before = ""; before !== top; ) {
        before = top;
        top = top.replace(/[\w-]*\([^()]*\)/g, " ");
      }
      for (const n of top.matchAll(/(?<![\w.-])(\d+)px\b/g)) if (SCALE.has(n[1])) raw.push(`${file}:${lineOf(css, m.index!)}: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(raw, []);
});
