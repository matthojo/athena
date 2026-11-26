/**
 * A theme, worked out into what goes on the page (docs: architecture/theming).
 *
 * compileTheme() turns a theme that has been through the reader
 * (lib/theme.ts readTheme) into a Paint: custom properties grouped by the
 * one place each may go. paintCss() writes a Paint out as a stylesheet for
 * <style id="athena-theme">, and the first-paint script (appearance-boot.ts)
 * writes the same stylesheet from the copy this device keeps, before any of
 * Athena's own stylesheets load, so a theme never flashes Athena's defaults.
 *
 * The theme's rules beat tokens.css by specificity, not by order:
 * `html:root[data-scheme="light"]` outranks tokens.css's `:root` and
 * `:root:where([data-scheme="dark"])`, wherever the two sit in the document.
 * A scheme's colours are scoped to that scheme, so a theme that gives only
 * light colours leaves dark to Athena. Nothing is written to the root's
 * inline style, which the app rewrites (the keyboard's --kb).
 *
 * The page glow: under Athena's own accent the aurora keeps its blue and mint
 * exactly (tokens.css). Under any other accent both hazes are tinted from it
 * (glow() below).
 */

import { COLOUR_KEYS, COLOUR_TOKEN, SCHEMES, canonicalColour, parseColour, toHex, toOklch, readTheme, type Scheme, type Theme } from "../../../lib/theme";
import athena from "../themes/athena.json";

/** Athena's own theme: the defaults in tokens.css, as theme data (theme-paint.test.ts checks the two agree). */
export const ATHENA: Theme = readTheme(athena).theme!;

/** Where a group of properties goes. The first-paint script maps the same names to the same selectors, so stored data never names a selector. */
export const BLOCKS = {
  root: "html:root",
  light: 'html:root[data-scheme="light"]',
  dark: 'html:root[data-scheme="dark"]',
} as const;
export type Block = keyof typeof BLOCKS;

export const PAINT_VERSION = 1;

/** A theme, ready for the page: properties per block, and the page colour for theme-color in each scheme. */
export interface Paint {
  v: typeof PAINT_VERSION;
  blocks: Partial<Record<Block, Record<string, string>>>;
  meta: Partial<Record<Scheme, string>>;
}

/** The only property names a paint may set. */
export const PROPERTY = /^--(?:(?:theme|chart|aurora)-[a-z0-9-]+|accent-tint)$/;
/** The only functions a value may use: none of them loads or reaches anything. */
const FUNCTIONS = ["oklch", "color-mix", "var"];
const VALUE_CHARS = /^[a-z0-9#.%(), /-]+$/i;

/** Whether a value is safe to write into the theme's stylesheet. The first-paint script applies the same test. */
export function safeValue(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 400 || !VALUE_CHARS.test(v)) return false;
  for (const m of v.matchAll(/([a-z-]*)\(/gi)) if (!FUNCTIONS.includes(m[1].toLowerCase())) return false;
  for (const m of v.matchAll(/var\(([^()]*)\)/gi)) if (!PROPERTY.test(m[1].trim())) return false;
  return true;
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);
const hue = (h: number) => fmt(((h % 360) + 360) % 360);

/**
 * The accent's family under an accent that isn't Athena's own, for one
 * scheme. tokens.css mixes 15% of a fixed pigment (the orb's cyan, the first
 * haze's blue) into some of the accent's shades, through
 * var(--accent-tint, 15%); here that goes to 0%, so those shades are the
 * accent alone (a fixed cyan in a terracotta accent goes grey). The second
 * haze, Athena's mint, becomes a soft wash of the accent's own hue at the
 * lightness the mint has, with Athena's own recipe.
 */
export function glow(accent: string, scheme: Scheme): Record<string, string> {
  const { c, h } = toOklch(parseColour(accent)!);
  const chroma = fmt(Math.min(scheme === "light" ? 0.12 : 0.11, c * 0.7));
  const pigment = `oklch(${scheme === "light" ? "0.89" : "0.52"} ${chroma} ${hue(h)})`;
  const alpha = scheme === "light" ? 55 : 16;
  return {
    "--accent-tint": "0%",
    "--aurora-b": `color-mix(in oklab, color-mix(in oklab, ${pigment} 80%, var(--theme-page)) ${alpha}%, transparent)`,
  };
}

/** A theme worked out for the page. Null, or Athena's own, is an empty paint: tokens.css as it is. */
export function compileTheme(theme: Theme | null): Paint {
  const paint: Paint = { v: PAINT_VERSION, blocks: {}, meta: {} };
  if (!theme) return paint;
  const put = (block: Block, name: string, value: string) => ((paint.blocks[block] ??= {})[name] = value);

  if (theme.shape.radius !== 1) put("root", "--theme-radius", fmt(theme.shape.radius));
  if (theme.shape.density !== 1) put("root", "--theme-density", fmt(theme.shape.density));
  if (theme.text.scale !== 1) put("root", "--theme-text-scale", fmt(theme.text.scale));

  for (const scheme of SCHEMES) {
    const set = theme.colours[scheme] ?? {};
    for (const key of COLOUR_KEYS) {
      const c = canonicalColour(set[key]);
      if (c) put(scheme, COLOUR_TOKEN[key], c);
    }
    if (set.page) paint.meta[scheme] = toHex(parseColour(set.page)!);
    const accent = canonicalColour(set.accent);
    if (accent && accent !== ATHENA.colours[scheme]?.accent) Object.assign((paint.blocks[scheme] ??= {}), glow(accent, scheme));
    theme.chart?.[scheme]?.forEach((c, i) => {
      const v = canonicalColour(c);
      if (v) put(scheme, `--chart-${i + 1}`, v);
    });
  }
  // Belt and braces: whatever made it this far is checked again on its way out.
  for (const props of Object.values(paint.blocks)) for (const [k, v] of Object.entries(props!)) if (!PROPERTY.test(k) || !safeValue(v)) delete props![k];
  return paint;
}

/** A paint as the theme's stylesheet. The first-paint script writes the same text. */
export function paintCss(paint: Paint | null): string {
  if (!paint) return "";
  let css = "";
  for (const block of Object.keys(BLOCKS) as Block[]) {
    const props = paint.blocks[block];
    if (!props) continue;
    let body = "";
    for (const name of Object.keys(props)) if (PROPERTY.test(name) && safeValue(props[name])) body += `${name}:${props[name]};`;
    if (body) css += `${BLOCKS[block]}{${body}}`;
  }
  return css;
}

// ---------- A person's own font and text size ----------

/** A person's own font and size, for this device. They sit above any theme (--user-*). */
export interface Personal {
  /** "@system" for the device's interface font, a family name on the device, or unset for Athena's own. */
  font?: string;
  /** A multiplier on every text size. */
  size?: number;
}

export const SYSTEM_FONT = "@system";
export const SIZE_LIMITS = { min: 0.875, max: 1.5, step: 0.0625 };
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** A family name Athena will write into a stylesheet: no quotes, backslashes, braces, semicolons, angle brackets or control characters. */
export const FONT_NAME = /^[^"'\\;{}<>\u0000-\u001f\u007f]{1,64}$/;

/** What's stored, checked. */
export function readPersonal(raw: unknown): Personal {
  const out: Personal = {};
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (r.font === SYSTEM_FONT || (typeof r.font === "string" && FONT_NAME.test(r.font) && r.font.trim() === r.font)) out.font = r.font as string;
  if (typeof r.size === "number" && Number.isFinite(r.size)) {
    const s = Math.min(SIZE_LIMITS.max, Math.max(SIZE_LIMITS.min, r.size));
    if (s !== 1) out.size = Math.round(s * 10000) / 10000;
  }
  return out;
}

/** The person's own layer as a stylesheet. The first-paint script writes the same text. */
export function personalCss(p: Personal): string {
  let body = "";
  const font = p.font === SYSTEM_FONT ? SYSTEM_STACK : p.font && FONT_NAME.test(p.font) ? `"${p.font}", ${SYSTEM_STACK}` : null;
  if (font) body += `--user-font-ui:${font};--user-font-display:${font};`;
  if (p.size && p.size !== 1) body += `--user-text-scale:${fmt(p.size)};`;
  return body ? `html:root{${body}}` : "";
}
