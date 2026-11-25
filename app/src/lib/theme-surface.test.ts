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

/** The app's stylesheets but tokens.css, with comments blanked (line breaks kept) unless `strip` is false. */
function sheets(strip = true): [string, string][] {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  return walk(SRC)
    .filter((f) => f.endsWith(".css") && !f.endsWith("tokens.css"))
    .map((f) => {
      const css = readFileSync(f, "utf8");
      return [relative(SRC, f), strip ? css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")) : css];
    });
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

/**
 * Lengths that stay the same at every density, and why. A declaration that
 * keeps a raw length says which with a comment after it: `inset: -8px; /* fixed: touch *\/`.
 * A hairline (1px or less) needs no comment, and nor does a length inside
 * calc() or another function: there it's a fixed part of a sum (an icon's
 * width, a safe-area inset), and the spacing beside it is a token.
 */
export const FIXED: Record<string, string> = {
  touch: "An invisible hit area around a small control: a touch target keeps its size at any density.",
  icon: "Placed or centred on a fixed-size icon, avatar, dot or mark: icons don't scale with density, so neither does what lines up with them.",
  cell: "Inside a fixed-size cell or control (a calendar day, a switch's track, a file tile).",
  chart: "Chart and timeline geometry, measured against the marks it draws.",
  art: "Decorative art positioned off the page (the aurora).",
  layout: "An offset matching a fixed-height bar it sits under.",
};

/** Spacing and position properties, and custom properties named for spacing (--chip-gutter, --gap). */
const SPACING = /(?<![\w-])((?:padding|margin|scroll-padding|scroll-margin|inset)(?:-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|--(?:[\w-]+-)?(?:gutter|gap|edge|pad|inset))\s*:\s*([^;{}]+)(;?)/g;

/** Raw spacing lengths in a stylesheet: px values over a hairline at the top level of a spacing or position value, without a `fixed:` reason. */
export function rawSpacing(src: string): { line: number; text: string; why?: string }[] {
  // Keep `fixed:` reasons as markers, blank every other comment (line breaks kept).
  const css = src.replace(/\/\*\s*fixed:\s*([\w-]+)\s*\*\//g, (c, why: string) => `@fixed(${why})`.padEnd(c.length)).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const hits: { line: number; text: string; why?: string }[] = [];
  for (const m of css.matchAll(SPACING)) {
    let top = m[2];
    for (let before = ""; before !== top; ) {
      before = top;
      top = top.replace(/[\w-]*\([^()]*\)/g, " ");
    }
    const raw = [...top.matchAll(/(?<![\w.-])-?(\d+(?:\.\d+)?)px\b/g)].filter((n) => Number(n[1]) > 1);
    if (!raw.length) continue;
    const why = /^\s*@fixed\(([\w-]+)\)/.exec(css.slice(m.index! + m[0].length))?.[1];
    hits.push({ line: lineOf(css, m.index!), text: `${m[1]}: ${m[2].trim()}`, why });
  }
  return hits;
}

test("the spacing check catches raw lengths and passes tokens, hairlines and reasons", () => {
  const raw = (s: string) => rawSpacing(s).filter((h) => !h.why).map((h) => h.text);
  assert.deepEqual(raw(".a { padding: 6px 10px; }"), ["padding: 6px 10px"]);
  assert.deepEqual(raw(".a { margin: 0 -8px; gap: 3px; }"), ["margin: 0 -8px", "gap: 3px"]);
  assert.deepEqual(raw(".a { top: 10px; inset-inline: 4px; }"), ["top: 10px", "inset-inline: 4px"]);
  assert.deepEqual(raw(".a { --chip-gutter: 14px; --gap: 6px; --size: 34px; }"), ["--chip-gutter: 14px", "--gap: 6px"]);
  assert.deepEqual(raw(".a { padding: var(--space-xs-sm) calc(3 * var(--space-px)); margin: -1px; gap: 0.5em; }"), []);
  assert.deepEqual(raw(".a { left: calc(var(--space-md) + 34px + var(--space-sm)); padding-bottom: calc(var(--safe-bottom) + 12px); }"), []);
  assert.deepEqual(raw(".a::after { inset: -8px; /* fixed: touch */ }"), []);
  assert.deepEqual(raw(".a { /* padding: 6px */ border-top: 2px solid; }"), []);
  assert.deepEqual(rawSpacing(".a { inset: -8px; /* fixed: touch */ }")[0].why, "touch");
});

test("all spacing follows density: every padding, margin, gap and inset is a --space-* token, or says why not", () => {
  const raw: string[] = [];
  const unknown: string[] = [];
  for (const [file, src] of sheets(false)) {
    for (const h of rawSpacing(src)) {
      if (!h.why) raw.push(`${file}:${h.line}: ${h.text}`);
      else if (!FIXED[h.why]) unknown.push(`${file}:${h.line}: fixed: ${h.why}`);
    }
  }
  assert.deepEqual(raw, [], "write these as --space-* tokens (calc(N * var(--space-px)) between steps), or give a reason from FIXED");
  assert.deepEqual(unknown, [], `a reason is one of: ${Object.keys(FIXED).join(", ")}`);
});

test("inline styles space with tokens too", () => {
  const raw: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const f of walk(SRC).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/style: ["'`]([^"'`]*)["'`]/g)) {
      for (const d of m[1].matchAll(/(?:padding|margin|gap)[\w-]*\s*:\s*([^;]+)/g)) if (/(?<![\w.])\d+px/.test(d[1].replace(/var\([^()]*\)/g, ""))) raw.push(`${relative(SRC, f)}: ${d[0]}`);
    }
  }
  assert.deepEqual(raw, []);
});
