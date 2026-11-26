/**
 * Every shade in tokens.css is worked out from the public --theme-* colours
 * (docs: architecture/theming), so a theme that sets
 * only those recolours the whole app. This works tokens.css out the way a
 * browser would (var() and color-mix() in oklab), sets each public colour to
 * something new, in light and in dark, and checks what moves: every colour
 * token but the few in FIXED has to follow at least one public colour, and
 * each family has to follow its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Colour tokens that stay as they are under any theme, and why. */
export const FIXED: Record<string, string[]> = {
  "Drawn over photos, video, maps and cover art, whose colours no theme sets: white type and dark scrims keep them readable.": [
    "--pic-zoom-bg", "--pic-zoom-ink", "--viewer-bg", "--viewer-ink", "--viewer-backdrop-bg", "--btn-soft-bg", "--viewer-pdf-bg",
    "--viewer-card-bg", "--photo-viewer-bg", "--photo-viewer-ink", "--icon-btn-bg", "--cal-cell-ink", "--cal-cell-after-bg",
    "--mood-glyph-on", "--mood-glyph-off", "--cal-cell-ink-2", "--cal-cell-after-bg-2", "--cal-num-on", "--cal-num-off",
    "--rl-embed-stage-bg", "--rl-embed-scrim-bg", "--rl-play-bg", "--rl-play-ink", "--rl-play-hover-bg", "--rl-play-focus-visible-ring",
    "--rl-play-ghost-bg", "--rl-play-bg-2", "--rl-embed-scrim-bg-2", "--rl-embed-note-ink", "--rl-embed-audio-bg-1", "--rl-embed-audio-bg-2",
    "--rl-embed-audio-bg-3", "--rl-embed-audio-ink", "--rl-card-site-ink", "--rl-play-bg-3", "--rl-play-ink-2", "--rl-embed-note-inline-ink",
    "--rl-player-bg-1", "--rl-player-bg-2", "--rl-player-ink", "--rl-player-note-ink", "--rl-player-track-bg", "--rl-player-fill-bg",
    "--watch-card-len-bg", "--watch-card-len-ink", "--rl-date-m-ink", "--rl-menu-thumb-date-ink", "--daymap-full-bg",
  ],
  "Other companies' colours.": ["--logo-granola-bg", "--logo-elevenlabs-bg", "--logo-elevenlabs-ink", "--hsrc-apple-ink", "--hsrc-apple-bg", "--logo-bg", "--rl-mark-default"],
  "Print: a note printed on paper, the same whatever the screen shows.": [
    "--print-page-bg", "--print-body-bg", "--print-note-canvas", "--print-note-surface", "--print-note-sunken", "--print-note-line",
    "--print-note-line-strong", "--print-note-ink", "--print-note-ink-2", "--print-note-ink-3", "--print-note-accent", "--print-note-accent-ink",
  ],
  "The avatar kit's line work, part of the drawing.": ["--kit-tile-line", "--kit-wr-swatch-shadow"],
  "White type and marks on a saturated fill (a status colour, a person's colour, a logo tile).": [
    "--btn-danger-ink", "--cm-item-focus-ink", "--cm-item-focus-ink-2", "--rl-fav-ink", "--rl-switch-hint-ink", "--team-report-badge-ink",
    "--team-entry-count-ink", "--wr-person-avatar-bg", "--wr-person-avatar-ink", "--wr-tick-box-ink", "--wr-strip-day-ink", "--wr-open-mark-ink",
    "--file-summary-mark-bg",
  ],
};

/** Families that must follow a public colour: [public colour, tokens]. */
const FOLLOWS: [string, string[]][] = [
  ["surface", ["--sunken-strong", "--ink-3", "--on-ink", "--mint-wash", "--warn-wash", "--todo-bad-wash", "--graph-bg", "--cm-surface"]],
  ["border", ["--sunken-strong", "--line-strong", "--chart-axis", "--chart-grid", "--flow-wire", "--rl-sk"]],
  ["text", ["--ink-3", "--good", "--warn", "--bad", "--chart-1", "--chart-5", "--stage-deep", "--scale-1", "--ctx-blue", "--graph-person", "--graph-detail", "--wr-mood-3", "--cm-hair", "--cm-wash", "--cm-press", "--rl-hair"]],
  ["page", ["--on-ink", "--aurora-b", "--today-day-a", "--scale-3"]],
  ["accent", ["--accent-wash", "--accent-ink", "--aurora-a", "--orb-hi", "--orb-mid", "--orb-low", "--talk-orb-speaking-mid", "--graph-ring", "--wm-ring"]],
];

type Lab = [number, number, number, number];

function blocks(): { light: Map<string, string>; dark: Map<string, string> } {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const m of CSS.matchAll(/(:root(?::where\(\[data-scheme="dark"\]\))?)\s*\{([^}]*)\}/g)) {
    const into = m[1].includes("dark") ? dark : light;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into.set(d[1], d[2].trim());
  }
  return { light, dark };
}

const BLOCKS = blocks();

/** The tokens in force for a scheme, with overrides on top (what a theme sets on the root). */
function tokens(scheme: "light" | "dark", set: Record<string, string> = {}): Map<string, string> {
  const all = new Map(BLOCKS.light);
  if (scheme === "dark") for (const [k, v] of BLOCKS.dark) all.set(k, v);
  for (const [k, v] of Object.entries(set)) all.set(k, v);
  return all;
}

function resolve(value: string, all: Map<string, string>, depth = 0): string {
  if (depth > 20) throw new Error(`var() loop in ${value}`);
  return value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback?: string) => {
    const v = all.get(name) ?? fallback;
    if (v === undefined) throw new Error(`${name} is not defined`);
    return resolve(v, all, depth + 1);
  });
}

// sRGB and oklch to OKLab (Björn Ottosson's matrices, public domain).
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function rgbToLab(r: number, g: number, b: number, alpha = 1): Lab {
  const [R, G, B] = [r, g, b].map((c) => lin(c / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, alpha];
}

/** The text inside the parentheses that open at `open`, and where they close. */
function group(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error(`unclosed ( in ${src}`);
}

function split(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "(") depth++;
    else if (args[i] === ")") depth--;
    else if (args[i] === "," && depth === 0) {
      out.push(args.slice(from, i).trim());
      from = i + 1;
    }
  }
  return [...out, args.slice(from).trim()];
}

const num = (s: string) => (s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));

/** One colour expression to OKLab and alpha. */
export function colour(expr: string): Lab {
  const e = expr.trim();
  if (e === "transparent") return [0, 0, 0, 0];
  if (e === "white") return rgbToLab(255, 255, 255);
  if (e === "black") return rgbToLab(0, 0, 0);
  const hex = /^#([0-9a-f]{3,8})$/i.exec(e)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return rgbToLab(r, g, b, full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1);
  }
  const fn = /^(oklch|color-mix)\(/.exec(e)?.[1];
  if (fn === "oklch") {
    const [body] = group(e, e.indexOf("("));
    const [lch, a] = body.split("/");
    const [L, C, H] = lch.trim().split(/\s+/).map(num);
    const h = (H * Math.PI) / 180;
    return [L, C * Math.cos(h), C * Math.sin(h), a === undefined ? 1 : num(a.trim())];
  }
  if (fn === "color-mix") {
    const [body] = group(e, e.indexOf("("));
    const [space, x, y] = split(body);
    assert.equal(space, "in oklab", `mix in oklab: ${e}`);
    const part = (s: string): [Lab, number | null] => {
      const m = /^(.*?)\s+([\d.]+%)$/.exec(s);
      return m ? [colour(m[1]), num(m[2])] : [colour(s), null];
    };
    const [A, pa] = part(x);
    const [B, pb] = part(y);
    const p = pa ?? (pb === null ? 0.5 : 1 - pb);
    const alpha = A[3] * p + B[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const f = (i: number) => (A[i] * A[3] * p + B[i] * B[3] * (1 - p)) / alpha;
    return [f(0), f(1), f(2), alpha];
  }
  throw new Error(`not a colour: ${e}`);
}

/** A token's value with every colour in it worked out: what a browser would paint. */
function painted(value: string): string | null {
  let out = "";
  let found = false;
  for (let i = 0; i < value.length; ) {
    const m = /^(?:color-mix\(|oklch\(|#[0-9a-f]{3,8}\b|(?:white|black|transparent)\b)/i.exec(value.slice(i));
    if (m && !/[\w-]/.test(value[i - 1] ?? "")) {
      const end = m[0].endsWith("(") ? group(value, i + m[0].length - 1)[1] + 1 : i + m[0].length;
      out += `[${colour(value.slice(i, end)).map((n) => n.toFixed(4)).join(" ")}]`;
      found = true;
      i = end;
    } else out += value[i++];
  }
  return found ? out : null;
}

function paint(scheme: "light" | "dark", set: Record<string, string> = {}): Map<string, string> {
  const all = tokens(scheme, set);
  const out = new Map<string, string>();
  for (const [name, value] of all) {
    if (name.startsWith("--theme-")) continue;
    const p = painted(resolve(value, all));
    if (p) out.set(name, p);
  }
  return out;
}

/** A new value for each public colour, well away from Athena's own. */
const NEW: Record<string, string> = {
  page: "oklch(0.9 0.03 80)",
  surface: "oklch(0.97 0.02 80)",
  sunken: "oklch(0.92 0.03 80)",
  border: "oklch(0.8 0.04 80)",
  text: "oklch(0.3 0.05 40)",
  "text-muted": "oklch(0.45 0.05 40)",
  accent: "oklch(0.6 0.15 150)",
  "on-accent": "oklch(0.2 0.05 150)",
  focus: "oklch(0.6 0.2 30)",
};

test("the evaluator works colours out like a browser", () => {
  const close = (a: Lab, b: Lab) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  assert.ok(close(colour("#ffffff"), [1, 0, 0, 1]));
  assert.ok(close(colour("oklch(0.5 0 0 / 0.2)"), [0.5, 0, 0, 0.2]));
  assert.ok(close(colour("color-mix(in oklab, oklch(0.2 0 0) 25%, oklch(0.6 0 0))"), [0.5, 0, 0, 1]));
  assert.ok(close(colour("color-mix(in oklab, oklch(0.2 0 0) 30%, transparent)"), [0.2, 0, 0, 0.3]), "mixing with transparent keeps the colour, at an alpha");
  assert.equal(resolve("var(--a)", new Map([["--a", "var(--b, red)"]])), "red");
});

for (const scheme of ["light", "dark"] as const) {
  test(`every shade follows the public colours (${scheme})`, () => {
    const base = paint(scheme);
    const moved = new Map<string, Set<string>>();
    for (const c of Object.keys(NEW)) {
      const next = paint(scheme, { [`--theme-${c}`]: NEW[c] });
      for (const [name, v] of base) if (next.get(name) !== v) (moved.get(name) ?? moved.set(name, new Set()).get(name)!).add(c);
    }
    const fixed = new Set(Object.values(FIXED).flat());
    // Only black shadows, white highlights and transparency in a token: they darken or lighten whatever is under them.
    const lightAndShadow = (name: string) =>
      [...base.get(name)!.matchAll(/\[([^\]]+)\]/g)].every((m) => {
        const [L, a, b, alpha] = m[1].split(" ").map(Number);
        return alpha === 0 || ((L < 0.001 || L > 0.999) && Math.abs(a) < 0.001 && Math.abs(b) < 0.001);
      });
    const orphans = [...base.keys()].filter((n) => !moved.has(n) && !fixed.has(n) && !lightAndShadow(n));
    assert.deepEqual(orphans, [], "these keep a hand-picked colour: derive them from the --theme-* colours, or say in FIXED why not");
    const stale = [...fixed].filter((n) => moved.has(n));
    assert.deepEqual(stale, [], "these follow the theme now: take them out of FIXED");
    for (const [from, names] of FOLLOWS) {
      const missing = names.filter((n) => !moved.get(n)?.has(from));
      assert.deepEqual(missing, [], `these should follow --theme-${from}`);
    }
  });
}

test("status colours stay apart and readable under a theme", () => {
  // Under the made-up theme above, every status colour is still its own hue, and the three are as far apart as ever but for the lean toward the text.
  for (const scheme of ["light", "dark"] as const) {
    const set = Object.fromEntries(Object.entries(NEW).map(([k, v]) => [`--theme-${k}`, v]));
    const all = tokens(scheme, set);
    const lab = (n: string) => colour(resolve(all.get(n)!, all));
    const [good, warn, bad] = ["--good", "--warn", "--bad"].map(lab);
    const dist = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const [a, b] of [[good, warn], [warn, bad], [good, bad]]) assert.ok(dist(a, b) > 0.08, `${scheme}: status colours too close`);
    const hue = (c: Lab) => ((Math.atan2(c[2], c[1]) * 180) / Math.PI + 360) % 360;
    assert.ok(hue(good) > 120 && hue(good) < 180, `${scheme}: good is green (${hue(good)})`);
    assert.ok(hue(bad) < 45 || hue(bad) > 345, `${scheme}: bad is red (${hue(bad)})`);
    assert.ok(hue(warn) > 45 && hue(warn) < 100, `${scheme}: warn is amber (${hue(warn)})`);
  }
});
