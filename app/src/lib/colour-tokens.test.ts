/**
 * Every colour in the app comes from a token in styles/tokens.css, so a theme
 * can change them by changing tokens (ARCHITECTURE.md, "Appearance and the
 * theme surface"). This fails on a raw colour anywhere else in the app's CSS
 * or TypeScript: a hex value, rgb()/hsl()/oklch() and friends with a number
 * in them, or a named colour. A colour function built only from tokens
 * (oklch(var(--tint-l) var(--tint-c) var(--h))) is fine, as are transparent
 * and currentColor. The few files that truly need raw values are in ALLOWED,
 * each with its reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Raw colours that have to stay, and why. `match` narrows an entry to the lines it covers. */
export const ALLOWED: { path: string; ext?: string; match?: RegExp; why: string }[] = [
  { path: "app/src/styles/tokens.css", why: "Where colours are defined." },
  { path: "app/src/components/brand-marks/", why: "Other companies' logos, drawn in their own colours." },
  { path: "app/src/components/brand-logo.ts", why: "Other companies' logos, drawn in their own colours." },
  { path: "app/src/components/backfill-marks.ts", why: "The logos of apps you can import from, in their own colours." },
  { path: "app/src/editor/link-render.ts", match: /^\s*"?[\w-]+"?: \{ action: "[^"]+", mark: "#/, why: "Each service's own brand colour, for the letter mark on a link to it." },
  { path: "app/src/db/sample-", why: "Sample mode's made-up content, standing in for pictures and colours the server would send." },
  { path: "app/src/editor/link-data.ts", why: "Sample mode's made-up link previews, standing in for what the server would send." },
  { path: "app/src/team/kit/", ext: ".ts", why: "The avatar kit's palette: the coats, outfits and features a person picks for an assistant, each with its own dark value. Content, like a photo." },
  { path: "app/src/team/dot-colour.ts", why: "Contrast maths: a character's dot is checked against copies of the surfaces it sits on." },
  { path: "app/src/lib/cover-ink.ts", why: "Contrast maths on cover art, and the fills of covers drawn for things with no art: content, the same in every appearance." },
  { path: "app/src/components/ask-picture.ts", why: "A drawn picture (a sky, a sea, a lighthouse) with its own palette, the same in every appearance." },
  { path: "app/src/components/attachments.ts", match: /fillStyle = "#fff"/, why: "Image processing: a JPEG can't be transparent, so a picture is flattened onto white." },
  { path: "app/src/graph/renderer.ts", match: /^\s*"--graph-[\w-]+": "/, why: "sRGB copies of the graph tokens, for a canvas that can't read the token's oklch()." },
];

const NAMED =
  "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen";

const HEX = /(?<![\w&#$/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FN = /(?<![\w.$-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;
/** A named colour as a whole word in a CSS value (not a custom property name, a function or a class). */
const NAMED_CSS = new RegExp(`(?<![\\w.#$@-])(?:${NAMED})(?![\\w(-])`, "gi");
/** A named colour where TypeScript hands a colour over: an SVG attribute, a canvas style, a style property. */
const NAMED_TS = new RegExp(`(?:\\b(?:fill|stroke|stop-color|flood-color|lighting-color)=["'\\\\]*|(?:fillStyle|strokeStyle|shadowColor)\\s*=\\s*["'\`]|\\b(?:color|background(?:-color)?|fill|stroke)\\s*:\\s*["'\`]?)(?:${NAMED})\\b`, "gi");

/** The source with comments blanked, line breaks kept so line numbers hold. */
export function stripComments(src: string, ts: boolean): string {
  const blank = (c: string) => c.replace(/[^\n]/g, " ");
  if (!ts) return src.replace(/\/\*[\s\S]*?\*\//g, blank);
  // Block comments, and line comments not inside a string or a URL.
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

/** The text inside the parentheses that open at `open`. */
function inside(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** A colour function with a number of its own: oklch(0.5 0.1 264), not oklch(var(--l) var(--c) var(--h)) or oklch(${l} …). */
export function rawFunction(args: string): boolean {
  let rest = args;
  // Innermost var() and ${} first, until none are left (they nest).
  for (let before = ""; before !== rest; ) {
    before = rest;
    rest = rest.replace(/var\([^()]*\)/g, " ").replace(/\$\{[^{}]*\}/g, " ");
  }
  return /(?<![\w-])[\d.]*\d/.test(rest.replace(/\bfrom\b|\bin\b/g, ""));
}

/** Hex values and colour functions with numbers of their own, in `text`, at offsets from `base`. */
function hexAndFunctions(text: string, base: number): { at: number; text: string }[] {
  const hits: { at: number; text: string }[] = [];
  for (const m of text.matchAll(HEX)) hits.push({ at: base + m.index!, text: m[0] });
  for (const m of text.matchAll(FN)) {
    const args = inside(text, m.index! + m[0].length - 1);
    if (rawFunction(args)) hits.push({ at: base + m.index!, text: `${m[0]}${args})` });
  }
  return hits;
}

/** Raw colours in one file's source, with their lines. */
export function rawColours(src: string, kind: "css" | "ts"): { line: number; text: string }[] {
  const code = stripComments(src, kind === "ts");
  const hits: { at: number; text: string }[] = [];
  if (kind === "css") {
    // Only in declaration values, never in selectors or property names. A mask's
    // colours only say how opaque it is (#000 is "show"), so masks are left alone.
    for (const d of code.matchAll(/(?<=[{;\s])(--[\w-]+|[a-z-]+)\s*:([^;{}]*)/g)) {
      if (/^(-webkit-)?mask(-image)?$/.test(d[1])) continue;
      const valueAt = d.index! + d[0].length - d[2].length;
      hits.push(...hexAndFunctions(d[2], valueAt));
      for (const n of d[2].matchAll(NAMED_CSS)) hits.push({ at: valueAt + n.index!, text: n[0] });
    }
  } else {
    hits.push(...hexAndFunctions(code, 0));
    for (const m of code.matchAll(NAMED_TS)) hits.push({ at: m.index!, text: m[0] });
  }
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  return hits.sort((a, b) => a.at - b.at).map((h) => ({ line: lineOf(h.at), text: h.text }));
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const allowed = (path: string, lineText: string) => ALLOWED.some((a) => path.startsWith(a.path) && (!a.ext || path.endsWith(a.ext)) && (!a.match || a.match.test(lineText)));

test("the check catches raw colours and passes tokens", () => {
  const css = (s: string) => rawColours(s, "css").map((h) => h.text);
  const ts = (s: string) => rawColours(s, "ts").map((h) => h.text);
  assert.deepEqual(css(".a { color: #fff; }"), ["#fff"]);
  assert.deepEqual(css(".a { box-shadow: 0 1px 0 oklch(1 0 0 / 0.05) inset; }"), ["oklch(1 0 0 / 0.05)"]);
  assert.deepEqual(css(".a { background: rgba(0, 0, 0, 0.4); }"), ["rgba(0, 0, 0, 0.4)"]);
  assert.deepEqual(css(".a { border-color: white; }"), ["white"]);
  assert.deepEqual(css(".a { background: linear-gradient(red, transparent); }"), ["red"]);
  assert.deepEqual(css(".a { background: oklch(var(--tint-l) var(--tint-c) var(--h)); }"), []);
  assert.deepEqual(css(".a { background: color-mix(in oklch, var(--accent) 9%, var(--sunken)); }"), []);
  assert.deepEqual(css(".a { color: currentColor; background: transparent; }"), []);
  assert.deepEqual(css(".a { --ctx-red: var(--x); color: var(--ctx-red); }"), []);
  assert.deepEqual(css("#fed .b { color: var(--ink); }"), []);
  assert.deepEqual(css("/* #fff and white */ .a { color: var(--ink); }"), []);
  assert.deepEqual(css(".a { grid-area: tan; }"), ["tan"]);
  assert.deepEqual(css(".a { mask-image: linear-gradient(to right, transparent, #000 40px); }"), []);
  assert.deepEqual(ts('const a = "#3266e4";'), ["#3266e4"]);
  assert.deepEqual(ts("ctx.fillStyle = `rgba(255,255,240,${a})`;"), ["rgba(255,255,240,${a})"]);
  assert.deepEqual(ts("const t = `oklch(${l} ${c} ${hue})`;"), []);
  assert.deepEqual(ts('h("rect", { fill: "white" })'), ['fill: "white']);
  assert.deepEqual(ts('const svg = `<rect fill="black"/>`;'), ['fill="black']);
  assert.deepEqual(ts('location.hash = "#/add"; const colour = "red";'), []);
  assert.deepEqual(ts('const x = "https://example.com/#abc"; // #fff'), []);
});

test("no raw colour outside tokens.css, but for the allowed few", () => {
  const raw: string[] = [];
  for (const path of files(SRC)) {
    const kind = path.endsWith(".css") ? "css" : path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts") ? "ts" : null;
    if (!kind) continue;
    const rel = relative(REPO, path);
    const src = readFileSync(path, "utf8");
    const lines = src.split("\n");
    for (const hit of rawColours(src, kind)) if (!allowed(rel, lines[hit.line - 1])) raw.push(`${rel}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(raw, []);
});

test("every allowance still covers something", () => {
  for (const a of ALLOWED) {
    const hit = files(SRC).some((p) => relative(REPO, p).startsWith(a.path));
    assert.ok(hit, `${a.path} is allowed but no longer exists`);
  }
});
