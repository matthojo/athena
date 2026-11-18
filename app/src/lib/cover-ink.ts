/**
 * Titles on covers Athena draws itself: the sample posters and albums
 * (db/sample-days.ts) and the cover an item gets when it has no art
 * (components/art-img.ts). Real art already has its own title, so none of
 * this touches it.
 *
 * - The title's colour is --ink or --on-ink, whichever reads better on the
 *   cover's fill, and it has to clear 3:1 in light and in dark (the two
 *   tokens swap between themes, so both pairs are checked).
 * - Below about 64 px wide a cover shows no title: the real one is beside it.
 *
 * Pure: no DOM, so it runs in tests and in the sample generator alike.
 */

// ---------- Colour ----------

/** Linear-light sRGB, 0–1 each. */
type Rgb = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** oklch(L C h) to linear sRGB (Björn Ottosson's matrices). */
function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const hr = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** A hex (#rgb or #rrggbb) or oklch() colour as linear sRGB; null for anything else. */
export function parseColour(raw: string): Rgb | null {
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const v = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => toLinear(parseInt(v.slice(i, i + 2), 16) / 255)) as Rgb;
  }
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/.exec(s);
  if (ok) {
    const L = ok[1].endsWith("%") ? parseFloat(ok[1]) / 100 : parseFloat(ok[1]);
    const C = ok[2].endsWith("%") ? (parseFloat(ok[2]) / 100) * 0.4 : parseFloat(ok[2]);
    return oklchToRgb(L, C, parseFloat(ok[3]));
  }
  return null;
}

/** As #rrggbb, for SVG text. */
export function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(clamp01(fromLinear(c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** WCAG contrast ratio, 1–21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The two text tokens, as tokens.css has them in light and in dark. */
export const INK = {
  light: { ink: "oklch(0.21 0.012 264)", onInk: "oklch(0.985 0.003 264)" },
  dark: { ink: "oklch(0.95 0.006 264)", onInk: "oklch(0.18 0.012 264)" },
} as const;

/** The least a cover's title may have against its fill. */
export const MIN_TITLE_CONTRAST = 3;

/**
 * "dark" or "light" text for a fill. "dark" is --ink in light and --on-ink in
 * dark (they swap), so the pick holds in both themes. Picks the side with the
 * better worst case; a fill it can't read is treated as mid grey.
 */
export function inkFor(fill: string): { tone: "dark" | "light"; ratio: number } {
  const bg = parseColour(fill) ?? parseColour("#777777")!;
  const worst = (a: string, b: string) => Math.min(contrast(bg, parseColour(a)!), contrast(bg, parseColour(b)!));
  const dark = worst(INK.light.ink, INK.dark.onInk);
  const light = worst(INK.light.onInk, INK.dark.ink);
  return dark >= light ? { tone: "dark", ratio: dark } : { tone: "light", ratio: light };
}

// ---------- A cover for something with no art ----------

/** Muted, warm-leaning fills: a shelf of them should look like a shelf, not a rainbow. */
const MADE_FILLS = [
  "oklch(0.42 0.07 250)",
  "oklch(0.74 0.09 75)",
  "oklch(0.45 0.08 20)",
  "oklch(0.62 0.07 160)",
  "oklch(0.36 0.05 300)",
  "oklch(0.82 0.05 95)",
  "oklch(0.52 0.09 45)",
  "oklch(0.40 0.05 200)",
];

/** A fill for an item with no art, the same every time for the same title. */
export function madeFill(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return MADE_FILLS[(h >>> 0) % MADE_FILLS.length];
}

// ---------- A title drawn into a generated SVG cover ----------

/** Below this many CSS pixels across, a cover shows no title. */
export const TITLE_MIN_PX = 64;

/** Rough glyph width in ems for a serif title; on the wide side so a guess never runs off the edge. */
const EM = 0.56;

/** Words into at most `max` lines of about `perLine` characters each. Null when one word alone is too long. */
export function wrapTitle(title: string, perLine: number, max: number): string[] | null {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    if (w.length > perLine) return null;
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= perLine) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines.length <= max ? lines : null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The title (and a small line under it) for a generated cover W × H, as SVG
 * to append after the artwork: a band of the fill at the foot so the text
 * always sits on a known colour, the text centred inside what's left when the
 * cover is cropped to 3:4 (the app's tiles do that), and a style that hides
 * all of it when the cover is drawn under TITLE_MIN_PX across.
 */
export function coverTitleSvg(opts: { W: number; H: number; title: string; by?: string; fill: string }): string {
  const { W, H, fill } = opts;
  const title = opts.title.trim();
  if (!title) return "";
  // What survives a crop to 3:4, and how wide the whole image is when that part is TITLE_MIN_PX across.
  const safe = Math.min(W, (H * 3) / 4);
  const hideBelow = Math.ceil((TITLE_MIN_PX * W) / safe);
  const room = safe * 0.84;
  // Start big (about 9 px at the smallest size a title shows) and shrink until it fits in three lines.
  let size = safe * 0.13;
  let lines: string[] | null = null;
  for (; size >= safe * 0.06; size *= 0.92) {
    lines = wrapTitle(title, Math.floor(room / (size * EM)), 3);
    if (lines) break;
  }
  if (!lines) {
    size = safe * 0.06;
    lines = [title.slice(0, Math.max(1, Math.floor(room / (size * EM)) - 1)) + "…"];
  }
  const by = opts.by?.trim() ?? "";
  const bySize = size * 0.6;
  const lead = size * 1.15;
  const bottom = H * 0.9;
  const lastBase = bottom - (by ? bySize * 1.5 : 0);
  const firstBase = lastBase - lead * (lines.length - 1);
  const top = firstBase - size * 1.1;
  const ink = toHex(parseColour(INK.light[inkFor(fill).tone === "dark" ? "ink" : "onInk"])!);
  const solid = Math.max(0, top - H * 0.03);
  const fade = Math.max(0, solid - H * 0.16);
  const x = W / 2;
  const text = lines.map((l, i) => `<tspan x="${x.toFixed(1)}" y="${(firstBase + i * lead).toFixed(1)}">${esc(l)}</tspan>`).join("");
  return (
    `<style>@media (max-width:${hideBelow}px){.cv{display:none}}</style>` +
    `<g class="cv"><defs><linearGradient id="cv-band" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop offset="${(fade / H).toFixed(3)}" stop-color="${esc(fill)}" stop-opacity="0"/><stop offset="${(solid / H).toFixed(3)}" stop-color="${esc(fill)}"/></linearGradient></defs>` +
    `<rect y="${fade.toFixed(1)}" width="${W}" height="${(H - fade).toFixed(1)}" fill="url(#cv-band)"/>` +
    `<text text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${size.toFixed(1)}" font-weight="600" fill="${ink}">${text}</text>` +
    (by ? `<text x="${x.toFixed(1)}" y="${bottom.toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${bySize.toFixed(1)}" letter-spacing="${(bySize * 0.06).toFixed(2)}" fill="${ink}">${esc(by)}</text>` : "") +
    `</g>`
  );
}
