/**
 * One type scale and one set of radii (docs/notes/night-e1.md). Every font
 * size and border radius in the stylesheets comes from tokens.css, like the
 * durations and easings in finish-motion.test.ts. Allowed as they are: 0,
 * 50% (a circle), 999px (a pill, better written --radius-pill), inherit, and
 * sizes relative to the text around them (em, %). A fluid size is fine when
 * it starts and ends on the scale: clamp(var(--text-…), …, var(--text-…)).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const styles = new URL("../styles/", import.meta.url);
const tokens = readFileSync(new URL("tokens.css", styles), "utf8");

/** Every stylesheet but tokens.css, comments blanked so line numbers hold. */
function sheets(): [string, string][] {
  return readdirSync(styles)
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map((f) => [f, readFileSync(new URL(f, styles), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))]);
}

/** `prop: value` pairs on each line whose property matches. */
function declarations(css: string, prop: RegExp): { line: number; value: string }[] {
  const out: { line: number; value: string }[] = [];
  css.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/(?<![\w-])([a-z-]+)\s*:\s*([^;{}]+)/g)) if (prop.test(m[1])) out.push({ line: i + 1, value: m[2].trim() });
  });
  return out;
}

const FLUID = /clamp\(\s*var\(--text-[\w-]+\)\s*,[^,]+,\s*var\(--text-[\w-]+\)\s*\)/g;
const LENGTH = /(?<![\w.-])\d*\.?\d+(px|rem)\b/;

export function rawFontSize(value: string): boolean {
  return LENGTH.test(value.replace(FLUID, "").replace(/var\([^)]*\)/g, ""));
}

export function rawRadius(value: string): boolean {
  const rest = value
    .replace(/var\([^)]*\)/g, "")
    .replace(/(?<![\w.-])999px\b/g, "")
    .replace(/(?<![\w.-])50%/g, "")
    .replace(/(?<![\w.-])0(px|rem|%)?(?![\w.%])/g, "");
  return /(?<![\w.-])\d*\.?\d+(px|rem|em|%)/.test(rest);
}

test("the checks catch what they should and pass what they should", () => {
  assert.ok(rawFontSize("11px"));
  assert.ok(rawFontSize("1.0625rem"));
  assert.ok(rawFontSize("var(--weight-medium) 10px / 1 var(--font-ui)"));
  assert.ok(rawFontSize("clamp(1.75rem, 1.3rem + 2vw, 2.375rem)"));
  assert.ok(!rawFontSize("var(--text-meta)"));
  assert.ok(!rawFontSize("var(--weight-semibold) var(--text-title) / 1.1 var(--font-display)"));
  assert.ok(!rawFontSize("clamp(var(--text-heading), 1.2rem + 3vw, var(--text-hero))"));
  assert.ok(!rawFontSize("0.9em"));
  assert.ok(!rawFontSize("inherit"));
  assert.ok(rawRadius("6px"));
  assert.ok(rawRadius("var(--radius-xs) 3px"));
  assert.ok(rawRadius("0.5rem"));
  assert.ok(!rawRadius("0"));
  assert.ok(!rawRadius("50%"));
  assert.ok(!rawRadius("999px"));
  assert.ok(!rawRadius("inherit"));
  assert.ok(!rawRadius("0 var(--radius-2xs) var(--radius-2xs) 0"));
});

test("every font size in the stylesheets is a --text-* token", () => {
  const raw: string[] = [];
  for (const [file, css] of sheets()) {
    for (const d of declarations(css, /^font(-size)?$/)) if (rawFontSize(d.value)) raw.push(`${file}:${d.line}: ${d.value}`);
  }
  assert.deepEqual(raw, []);
});

test("every border radius in the stylesheets is a --radius-* token", () => {
  const raw: string[] = [];
  for (const [file, css] of sheets()) {
    for (const d of declarations(css, /^border(-[a-z]+)*-radius$/)) if (rawRadius(d.value)) raw.push(`${file}:${d.line}: ${d.value}`);
  }
  assert.deepEqual(raw, []);
});

test("nothing smaller than --text-meta but the one micro step, and that one is 11px", () => {
  const sizes = [...tokens.matchAll(/--text-([\w-]+):\s*calc\(([\d.]+)rem \* var\(--user-text-scale, var\(--theme-text-scale\)\)\)/g)].map(([, name, rem]) => [name, Number(rem) * 16] as const);
  const small = sizes.filter(([, px]) => px < 12);
  assert.deepEqual(small, [["micro", 11]]);
});

test("the page frame's two widths are tokens", () => {
  assert.match(tokens, /--page-narrow:\s*760px;/);
  assert.match(tokens, /--page-wide:\s*1120px;/);
});
