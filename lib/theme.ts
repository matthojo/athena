/**
 * Themes: the data, and the reader every theme goes through (docs:
 * architecture/theming).
 *
 * A theme is a small, versioned piece of JSON, the same shape whether it is
 * built in, made in Settings → Appearance, or shared through Community as a
 * theme.json (lib/theme-share.ts). It has the header every shared file
 * carries (lib/share-kinds.ts):
 *
 *   {
 *     "format": 1,                               the file format, as the other kinds have it
 *     "name": "Clay",
 *     "summary": "Warm paper and terracotta",    (optional)
 *     "version": "1.0",                          (optional: its author's own, free text)
 *     "author": "a-github-username",             (optional)
 *     "based_on": "https://github.com/…",        (optional)
 *     "colours": {
 *       "light": { "page": "#f6f0e8", "accent": "#b4532a", ... },
 *       "dark":  { ... }                         (either, or both)
 *     },
 *     "shape": { "radius": 1.1, "density": 1 },
 *     "text": { "scale": 1 },
 *     "chart": { "light": [five colours], "dark": [five colours] }   (optional)
 *   }
 *
 * The first spelling, from before themes could be shared, is read too:
 * "format": "athena-theme" with "version": 1 as the format's number and a
 * free-text author. themeJson() writes the shape above.
 *
 * What a theme can set is the public colours (the --theme-* colours in
 * tokens.css), the corner radius, the density and the text scale, and
 * optionally five data colours for charts. Where it leaves a scheme or a
 * colour out, Athena's own default fills in. It never names a typeface and
 * can't load anything.
 *
 * Every theme is untrusted, the owner's own included, because the same reader
 * reads shared ones. readTheme() keeps only known keys, accepts colours
 * only in a small safe syntax (hex, rgb(), hsl() and oklch() with plain
 * numbers: no url(), no var(), nothing that loads or refers to anything) and
 * writes each back out as oklch(), clamps the numbers,
 * and drops the rest. Nothing a theme holds reaches the page except through
 * that canonical form.
 */

/** The file format a theme is written in: a whole number, as every shared file's `format` is. */
export const THEME_FORMAT = 1;
/** The first spelling of the format, read but never written: "format": "athena-theme", "version": 1. */
export const LEGACY_FORMAT = "athena-theme";
const LEGACY_VERSION = 1;

/** The public colours, by their key in a theme and the token each sets. */
export const COLOUR_KEYS = ["page", "surface", "sunken", "border", "text", "textMuted", "accent", "onAccent", "focus"] as const;
export type ColourKey = (typeof COLOUR_KEYS)[number];
export const COLOUR_TOKEN: Record<ColourKey, string> = {
  page: "--theme-page",
  surface: "--theme-surface",
  sunken: "--theme-sunken",
  border: "--theme-border",
  text: "--theme-text",
  textMuted: "--theme-text-muted",
  accent: "--theme-accent",
  onAccent: "--theme-on-accent",
  focus: "--theme-focus",
};

export type Scheme = "light" | "dark";
export const SCHEMES: Scheme[] = ["light", "dark"];
export type SchemeColours = Partial<Record<ColourKey, string>>;

/** How many data colours a chart palette holds: one for each of Athena's chart series (--chart-1 to --chart-5). */
export const CHART_SERIES = 5;

export interface Theme {
  format: typeof THEME_FORMAT;
  name: string;
  author?: string;
  summary?: string;
  colours: Partial<Record<Scheme, SchemeColours>>;
  shape: { radius: number; density: number };
  text: { scale: number };
  chart?: Partial<Record<Scheme, string[]>>;
}

/** The ranges a theme's numbers are clamped to. 1 is Athena's own in each. */
export const LIMITS = {
  radius: { min: 0, max: 2 },
  density: { min: 0.8, max: 1.25 },
  scale: { min: 0.9, max: 1.25 },
} as const;

export const NAME_MAX = 40;
export const AUTHOR_MAX = 60;
export const SUMMARY_MAX = 140;
/** A theme as text is a few hundred bytes; anything much bigger isn't one. */
export const THEME_MAX_BYTES = 16_000;
/** Two data colours closer than this in OKLab can't be told apart as series. */
export const CHART_MIN_DISTANCE = 0.07;

// ---------- Colours ----------

/** A parsed colour: sRGB channels 0–255, or oklch. */
export type Colour = { space: "srgb"; r: number; g: number; b: number } | { space: "oklch"; l: number; c: number; h: number };

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const COLOUR_MAX = 64;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** The numbers inside fn( ... ), separated by spaces or commas, each with an optional unit from `units`. Null if anything else is there. */
function args(body: string, units: string): { n: number; unit: string }[] | null {
  const parts = body.trim().split(/\s*,\s*|\s+/);
  const out: { n: number; unit: string }[] = [];
  const one = new RegExp(`^(${NUMBER})(${units})?$`, "i");
  for (const p of parts) {
    const m = one.exec(p);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    out.push({ n, unit: (m[2] ?? "").toLowerCase() });
  }
  return out;
}

/**
 * A colour in the safe syntax, or null. Hex (#rgb or #rrggbb), rgb(), hsl()
 * or oklch(), opaque, with plain numbers only. Anything else (a named colour,
 * a transparent one, var(), url(), calc(), color-mix(), an escape, a comment)
 * is not a colour here.
 */
export function parseColour(raw: unknown): Colour | null {
  if (typeof raw !== "string" || raw.length > COLOUR_MAX) return null;
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return { space: "srgb", r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
  }
  const fn = /^(rgb|hsl|oklch)\(([^()]*)\)$/.exec(s);
  if (!fn) return null;
  if (fn[1] === "rgb") {
    const a = args(fn[2], "%");
    if (!a || a.length !== 3) return null;
    const pct = a[0].unit === "%";
    if (a.some((x) => (x.unit === "%") !== pct)) return null;
    const [r, g, b] = a.map((x) => clamp(Math.round(pct ? (x.n / 100) * 255 : x.n), 0, 255));
    return { space: "srgb", r, g, b };
  }
  if (fn[1] === "hsl") {
    const a = args(fn[2], "deg|%");
    if (!a || a.length !== 3 || a[0].unit === "%" || a[1].unit !== "%" || a[2].unit !== "%") return null;
    const [r, g, b] = hslToRgb(a[0].n, clamp(a[1].n, 0, 100) / 100, clamp(a[2].n, 0, 100) / 100);
    return { space: "srgb", r, g, b };
  }
  const a = args(fn[2], "deg|%");
  if (!a || a.length !== 3 || a[1].unit === "deg" || a[2].unit === "%" || a[0].unit === "deg") return null;
  const l = a[0].unit === "%" ? a[0].n / 100 : a[0].n;
  const c = a[1].unit === "%" ? (a[1].n / 100) * 0.4 : a[1].n;
  return { space: "oklch", l: clamp(l, 0, 1), c: clamp(c, 0, 0.4), h: ((a[2].n % 360) + 360) % 360 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 30;
  const k = (n: number) => (n + hh) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => clamp(Math.round(v * 255), 0, 255)) as [number, number, number];
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** A colour written out: #rrggbb for sRGB, oklch(L C H) with five decimals at most (three for the hue). */
export function formatColour(c: Colour): string {
  if (c.space === "srgb") return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `oklch(${round(c.l, 5)} ${round(c.c, 5)} ${round(c.h, 3)})`;
}

/**
 * A colour in the safe syntax, in Athena's canonical form, always oklch(L C H);
 * null if it isn't one. Never hex: the app mixes colours with transparent in
 * oklch (color-mix(in oklch, var(--canvas) 92%, transparent)), and Chrome
 * gives an sRGB colour mixed that way no hue, which it draws as red.
 */
export const canonicalColour = (raw: unknown): string | null => {
  const c = parseColour(raw);
  if (!c) return null;
  if (c.space === "oklch") return formatColour(c);
  // Five decimals is enough for every hex colour to come back exactly; a grey has no hue.
  const o = toOklch(c);
  const grey = o.c < 0.000005;
  return formatColour({ space: "oklch", l: o.l, c: grey ? 0 : o.c, h: grey ? 0 : o.h });
};

// OKLab (Björn Ottosson's matrices, public domain).
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export type Lab = [number, number, number];

export function toOklab(c: Colour): Lab {
  if (c.space === "oklch") {
    const h = (c.h * Math.PI) / 180;
    return [c.l, c.c * Math.cos(h), c.c * Math.sin(h)];
  }
  const [R, G, B] = [c.r, c.g, c.b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function toOklch(c: Colour): { l: number; c: number; h: number } {
  if (c.space === "oklch") return { l: c.l, c: c.c, h: c.h };
  const [L, a, b] = toOklab(c);
  return { l: L, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** The nearest sRGB colour, as #rrggbb (for theme-color, and colour pickers). Out-of-gamut colours are clipped. */
export function toHex(c: Colour): string {
  if (c.space === "srgb") return formatColour(c);
  const [L, a, b] = toOklab(c);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const [r, g, bl] = rgb.map((v) => clamp(Math.round(fromLinear(clamp(v, 0, 1)) * 255), 0, 255));
  return formatColour({ space: "srgb", r, g, b: bl });
}

/** How far apart two colours are, in OKLab. */
export function distance(x: Colour, y: Colour): number {
  const [a, b] = [toOklab(x), toOklab(y)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The pairs of data colours too close to tell apart as series (indexes into the list), or none. */
export function closePairs(colours: string[]): [number, number][] {
  const parsed = colours.map(parseColour);
  const out: [number, number][] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const [a, b] = [parsed[i], parsed[j]];
      if (!a || !b || distance(a, b) < CHART_MIN_DISTANCE) out.push([i, j]);
    }
  }
  return out;
}

// ---------- The reader ----------

/** Something the reader left out of a theme, and why: for the person reading or writing one. */
export interface ThemeProblem {
  path: string;
  why: "unknown" | "not-a-colour" | "not-a-number" | "clamped" | "too-long" | "chart-size" | "chart-close" | "not-text" | "not-a-handle";
}

export interface ReadResult {
  theme: Theme | null;
  /** Why there's no theme at all, when there isn't. */
  error?: "not-json" | "too-big" | "not-a-theme" | "newer-version" | "no-name";
  problems: ThemeProblem[];
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A line of plain text: control and invisible formatting characters out, spaces collapsed, cut to `max`. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? [...s].slice(0, max).join("").trim() : null;
}

function readNumber(raw: unknown, path: string, lim: { min: number; max: number }, problems: ThemeProblem[]): number {
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    problems.push({ path, why: "not-a-number" });
    return 1;
  }
  const n = round(clamp(raw, lim.min, lim.max), 3);
  if (n !== raw) problems.push({ path, why: "clamped" });
  return n;
}

/**
 * Read a theme: from JSON text or a parsed value. Returns the theme with only
 * what Athena understands in it, written out Athena's way, and a list of what
 * was left out. A theme with no name, or from a newer version of Athena, or
 * that isn't a theme at all, comes back as null.
 */
export function readTheme(input: unknown): ReadResult {
  const problems: ThemeProblem[] = [];
  let raw = input;
  if (typeof input === "string") {
    if (input.length > THEME_MAX_BYTES) return { theme: null, error: "too-big", problems };
    try {
      raw = JSON.parse(input);
    } catch {
      return { theme: null, error: "not-json", problems };
    }
  }
  if (!isObject(raw)) return { theme: null, error: "not-a-theme", problems };
  const legacy = raw.format === LEGACY_FORMAT;
  if (legacy) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return { theme: null, error: "not-a-theme", problems };
    if (raw.version > LEGACY_VERSION) return { theme: null, error: "newer-version", problems };
  } else {
    if (typeof raw.format !== "number" || !Number.isInteger(raw.format) || raw.format < 1) return { theme: null, error: "not-a-theme", problems };
    if (raw.format > THEME_FORMAT) return { theme: null, error: "newer-version", problems };
    // A shared file's `format` is a number for every kind, so a theme has to have something a theme has.
    if (!["colours", "shape", "text", "chart"].some((k) => own(raw, k))) return { theme: null, error: "not-a-theme", problems };
  }

  // The header fields (version, based_on) are read by lib/share-kinds.ts readHeader, not kept here; they aren't unknown.
  const known = legacy ? ["format", "version", "name", "author", "summary", "colours", "shape", "text", "chart"] : ["format", "name", "summary", "version", "author", "based_on", "colours", "shape", "text", "chart"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) problems.push({ path: k, why: "unknown" });

  const name = cleanText(raw.name, NAME_MAX);
  if (!name) return { theme: null, error: "no-name", problems };
  if (typeof raw.name === "string" && [...raw.name.trim()].length > NAME_MAX) problems.push({ path: "name", why: "too-long" });

  const theme: Theme = { format: THEME_FORMAT, name, colours: {}, shape: { radius: 1, density: 1 }, text: { scale: 1 } };
  for (const [key, max] of [["author", AUTHOR_MAX], ["summary", SUMMARY_MAX]] as const) {
    if (raw[key] === undefined) continue;
    const t = cleanText(raw[key], max);
    if (t) theme[key] = t;
    else problems.push({ path: key, why: "not-text" });
  }

  if (raw.colours !== undefined) {
    if (!isObject(raw.colours)) problems.push({ path: "colours", why: "unknown" });
    else {
      for (const k of Object.keys(raw.colours)) if (!SCHEMES.includes(k as Scheme)) problems.push({ path: `colours.${k}`, why: "unknown" });
      for (const scheme of SCHEMES) {
        if (!own(raw.colours, scheme)) continue;
        const given = raw.colours[scheme];
        if (!isObject(given)) {
          problems.push({ path: `colours.${scheme}`, why: "unknown" });
          continue;
        }
        const set: SchemeColours = {};
        for (const k of Object.keys(given)) {
          if (!(COLOUR_KEYS as readonly string[]).includes(k)) {
            problems.push({ path: `colours.${scheme}.${k}`, why: "unknown" });
            continue;
          }
          const c = canonicalColour(given[k]);
          if (c) set[k as ColourKey] = c;
          else problems.push({ path: `colours.${scheme}.${k}`, why: "not-a-colour" });
        }
        if (Object.keys(set).length) theme.colours[scheme] = set;
      }
    }
  }

  const shape = isObject(raw.shape) ? raw.shape : {};
  if (raw.shape !== undefined && !isObject(raw.shape)) problems.push({ path: "shape", why: "unknown" });
  for (const k of Object.keys(shape)) if (k !== "radius" && k !== "density") problems.push({ path: `shape.${k}`, why: "unknown" });
  theme.shape.radius = readNumber(shape.radius, "shape.radius", LIMITS.radius, problems);
  theme.shape.density = readNumber(shape.density, "shape.density", LIMITS.density, problems);

  const text = isObject(raw.text) ? raw.text : {};
  if (raw.text !== undefined && !isObject(raw.text)) problems.push({ path: "text", why: "unknown" });
  for (const k of Object.keys(text)) if (k !== "scale") problems.push({ path: `text.${k}`, why: "unknown" });
  theme.text.scale = readNumber(text.scale, "text.scale", LIMITS.scale, problems);

  if (raw.chart !== undefined) {
    if (!isObject(raw.chart)) problems.push({ path: "chart", why: "unknown" });
    else {
      for (const k of Object.keys(raw.chart)) if (!SCHEMES.includes(k as Scheme)) problems.push({ path: `chart.${k}`, why: "unknown" });
      const chart: Partial<Record<Scheme, string[]>> = {};
      for (const scheme of SCHEMES) {
        if (!own(raw.chart, scheme)) continue;
        const list = raw.chart[scheme];
        if (!Array.isArray(list) || list.length !== CHART_SERIES) {
          problems.push({ path: `chart.${scheme}`, why: "chart-size" });
          continue;
        }
        const colours = list.map(canonicalColour);
        const bad = colours.findIndex((c) => c === null);
        if (bad >= 0) {
          problems.push({ path: `chart.${scheme}.${bad}`, why: "not-a-colour" });
          continue;
        }
        // The one check on a palette: every series can be told from every other.
        if (closePairs(colours as string[]).length) {
          problems.push({ path: `chart.${scheme}`, why: "chart-close" });
          continue;
        }
        chart[scheme] = colours as string[];
      }
      if (Object.keys(chart).length) theme.chart = chart;
    }
  }

  return { theme, problems };
}

/** The header a shared theme.json carries beside the theme (lib/share-kinds.ts ShareHeader). */
export interface ThemeHeader {
  version?: string;
  author?: string;
  based_on?: string;
}

/**
 * A theme as the JSON Athena writes, and shares as theme.json: its keys in a fixed order, nothing else. With a
 * header, its author is the header's (a GitHub username) and the theme's own free-text author is left out.
 */
export function themeJson(theme: Theme, header?: ThemeHeader): string {
  const out: Record<string, unknown> = { format: THEME_FORMAT, name: theme.name };
  if (theme.summary) out.summary = theme.summary;
  if (header) {
    if (header.version) out.version = header.version;
    if (header.author) out.author = header.author;
    if (header.based_on) out.based_on = header.based_on;
  } else if (theme.author) out.author = theme.author;
  const colours: Record<string, SchemeColours> = {};
  for (const s of SCHEMES) {
    const set = theme.colours[s];
    if (set && Object.keys(set).length) colours[s] = Object.fromEntries(COLOUR_KEYS.filter((k) => set[k]).map((k) => [k, set[k]]));
  }
  out.colours = colours;
  out.shape = { radius: theme.shape.radius, density: theme.shape.density };
  out.text = { scale: theme.text.scale };
  if (theme.chart && (theme.chart.light || theme.chart.dark)) out.chart = Object.fromEntries(SCHEMES.filter((s) => theme.chart?.[s]).map((s) => [s, theme.chart![s]]));
  return JSON.stringify(out, null, 2);
}

// ---------- The person's own themes, and which one is chosen ----------

/**
 * Where a theme the person added came from (lib/theme-share.ts). Missing on a theme they made. Plain: a public
 * catalogue id, a hash, an author's username and version, nothing they wrote.
 */
export interface ThemeOrigin {
  /** The Community listing it came from; null for a file or a link. */
  catalogue_id: string | null;
  /** SHA-256 of the listing's files as added. Null once it stops following the listing (an Update went beside it). */
  hash: string | null;
  /** Its author's version, as the file or listing said. */
  version: string | null;
  /** Its author's GitHub username, if they gave one. */
  author: string | null;
  /** The person has changed it since adding it: an Update then goes beside it, never over it. */
  changed: boolean;
}

/** One of the person's own themes, as stored: an id of Athena's own, the theme, and where it came from if they added it. */
export interface OwnTheme {
  id: string;
  theme: Theme;
  origin?: ThemeOrigin;
}

const ORIGIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORIGIN_HASH = /^sha256-[0-9a-f]{64}$/;
const ORIGIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/;
const ORIGIN_AUTHOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** An origin as stored, checked field by field; anything that doesn't fit is left out. Null when there's none. */
export function readOrigin(raw: unknown): ThemeOrigin | null {
  if (!isObject(raw)) return null;
  const pick = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  return {
    catalogue_id: pick(raw.catalogue_id, ORIGIN_ID),
    hash: pick(raw.hash, ORIGIN_HASH),
    version: pick(raw.version, ORIGIN_VERSION),
    author: pick(raw.author, ORIGIN_AUTHOR),
    changed: raw.changed === true,
  };
}

/** Which theme is in use: Athena's own, a built-in one, or one of the person's. */
export type ThemeChoice = "athena" | `builtin:${string}` | `own:${string}`;

export const OWN_THEMES_MAX = 40;
const ID = /^[a-z0-9]{6,32}$/;
const BUILTIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

export const isThemeChoice = (v: unknown): v is ThemeChoice =>
  v === "athena" || (typeof v === "string" && ((v.startsWith("builtin:") && BUILTIN_ID.test(v.slice(8))) || (v.startsWith("own:") && ID.test(v.slice(4)))));

/** What's stored as the choice, checked; anything else is Athena's own. */
export const readThemeChoice = (v: unknown): ThemeChoice => (isThemeChoice(v) ? v : "athena");

/** The person's own themes as stored, each read like any other theme; anything unreadable is left out. */
export function readOwnThemes(raw: unknown): OwnTheme[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OwnTheme[] = [];
  for (const item of raw.slice(0, OWN_THEMES_MAX)) {
    if (!isObject(item) || typeof item.id !== "string" || !ID.test(item.id) || seen.has(item.id)) continue;
    const { theme } = readTheme(item.theme);
    if (!theme) continue;
    seen.add(item.id);
    const origin = readOrigin(item.origin);
    out.push(origin ? { id: item.id, theme, origin } : { id: item.id, theme });
  }
  return out;
}

/** A new id for one of the person's own themes. */
export function newThemeId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}
