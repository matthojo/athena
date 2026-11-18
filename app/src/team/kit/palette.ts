/**
 * Palette keys for AvatarSpec.fur / accent / outfitColor. The keys are stored
 * on saved characters and must never change; only the values do.
 *
 * Restraint pass (16 Nov): every coat, cheek and outfit sits in Athena's own
 * colour world. Neutrals are tinted toward cobalt (hue 264), coats are soft
 * and low in chroma, and cobalt (and, a little, mint) are the only strong
 * colours. Light values are the designed default; dark mode draws each fill
 * through `darkFill` (compressed toward the middle, a touch less chroma) so a
 * white cat never glares off a near-black page. See avatar.css.
 */

/** The one outline: the app's ink, a step lighter. Never darkened or lightened by theme. */
export const INK = "#22262e";

export interface FurTone {
  /** Main coat. */
  fill: string;
  /** Muzzle, inner ear, fox mask. */
  light: string;
  /** Bear inner ear, nose, details. */
  shade: string;
  label: string;
}

export const FUR: Record<string, FurTone> = {
  charcoal: { fill: "#5f636c", light: "#858991", shade: "#3f424a", label: "Charcoal" },
  cocoa: { fill: "#a58471", light: "#d5c0ae", shade: "#684b3e", label: "Cocoa" },
  honey: { fill: "#d3b185", light: "#ecdcc1", shade: "#8d6949", label: "Honey" },
  ginger: { fill: "#ce8864", light: "#f7f3ec", shade: "#8c523b", label: "Ginger" },
  snow: { fill: "#f3f5f9", light: "#fdfdff", shade: "#d1d4db", label: "Snow" },
  cream: { fill: "#ebe0cd", light: "#f9f5ec", shade: "#b4a18b", label: "Cream" },
  mint: { fill: "#82d0b7", light: "#c4ecde", shade: "#499780", label: "Mint" },
  lilac: { fill: "#b8acdc", light: "#e0daf3", shade: "#7f6faa", label: "Lilac" },
  sky: { fill: "#9dc7e4", light: "#d3e8f7", shade: "#5685ad", label: "Sky" },
  blush: { fill: "#eac7cb", light: "#f9e8ea", shade: "#b9858c", label: "Blush" },
  slate: { fill: "#9ea5b3", light: "#cdd1d9", shade: "#666f7f", label: "Slate" },
  butter: { fill: "#ecdaa2", light: "#f7f0d6", shade: "#b79b5f", label: "Butter" },
};

export interface AccentTone {
  /** Inner ears, spots, small noses. */
  fill: string;
  /** Blush cheeks (drawn at partial opacity, full when happy). */
  cheek: string;
  label: string;
}

export const ACCENT: Record<string, AccentTone> = {
  rose: { fill: "#d38e9d", cheek: "#e3a4ac", label: "Rose" },
  pink: { fill: "#dda1b2", cheek: "#e6abb8", label: "Pink" },
  peach: { fill: "#e0b398", cheek: "#e4b0a0", label: "Peach" },
  coral: { fill: "#d88a77", cheek: "#e1998c", label: "Coral" },
  butter: { fill: "#e8cf8c", cheek: "#e3b09f", label: "Butter" },
  lilac: { fill: "#9e9ed8", cheek: "#d3accf", label: "Lilac" },
  mint: { fill: "#73cbb0", cheek: "#e4adb4", label: "Mint" },
  sky: { fill: "#77a0dc", cheek: "#e4adb4", label: "Sky" },
};

export interface OutfitTone {
  fill: string;
  label: string;
}

export const OUTFIT: Record<string, OutfitTone> = {
  cobalt: { fill: "#3e6bd1", label: "Cobalt" },
  periwinkle: { fill: "#818dcf", label: "Periwinkle" },
  teal: { fill: "#6c9fa5", label: "Teal" },
  leaf: { fill: "#77a680", label: "Leaf" },
  mustard: { fill: "#d6ad68", label: "Mustard" },
  orange: { fill: "#dda87d", label: "Orange" },
  tomato: { fill: "#ca755a", label: "Tomato" },
  berry: { fill: "#b16175", label: "Berry" },
  pink: { fill: "#e5bac3", label: "Pink" },
  plum: { fill: "#826c9b", label: "Plum" },
  oat: { fill: "#e0d6c6", label: "Oat" },
};

/** Outfit colours that sit well against each coat (no muddy same-hue pairs). */
export const OUTFITS_FOR_FUR: Record<string, string[]> = {
  charcoal: ["cobalt", "tomato", "mustard", "pink", "leaf", "teal", "orange"],
  cocoa: ["teal", "cobalt", "mustard", "leaf", "periwinkle", "berry"],
  honey: ["cobalt", "teal", "berry", "plum", "leaf"],
  ginger: ["cobalt", "teal", "oat", "plum", "periwinkle"],
  snow: ["cobalt", "periwinkle", "tomato", "berry", "leaf", "mustard", "pink"],
  cream: ["cobalt", "teal", "berry", "plum", "leaf", "tomato"],
  mint: ["periwinkle", "plum", "berry", "mustard", "tomato"],
  lilac: ["mustard", "leaf", "teal", "tomato", "berry"],
  sky: ["mustard", "tomato", "berry", "oat", "plum"],
  blush: ["periwinkle", "teal", "cobalt", "leaf", "plum"],
  slate: ["mustard", "tomato", "pink", "orange", "oat"],
  butter: ["periwinkle", "cobalt", "plum", "berry", "teal"],
};

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;

/** Resolve a palette key; a raw hex is accepted, anything else falls back. */
export function furTone(key: string): FurTone {
  if (FUR[key]) return FUR[key];
  if (HEX.test(key)) return { fill: key, light: key, shade: INK, label: key };
  return FUR.cocoa;
}

export function accentTone(key: string): AccentTone {
  if (ACCENT[key]) return ACCENT[key];
  if (HEX.test(key)) return { fill: key, cheek: key, label: key };
  return ACCENT.rose;
}

export function outfitTone(key: string): OutfitTone {
  if (OUTFIT[key]) return OUTFIT[key];
  if (HEX.test(key)) return { fill: key, label: key };
  return OUTFIT.cobalt;
}

/**
 * A soft disc colour for the character's backdrop (Team cards). Mixes the
 * coat's shade toward the surface, so pale coats (snow, cream) still get a
 * visible tint and every disc sits at about the same quiet depth.
 */
export function avatarTint(fur: string): string {
  const t = furTone(fur);
  return `color-mix(in oklch, ${t.shade === INK ? t.fill : t.shade} 20%, var(--surface, #fcfdfe))`;
}

// ---------- Dark mode ----------

type Lab = [l: number, a: number, b: number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklab(hex: string): Lab {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (d) => d + d) : hex;
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, "0")).join("");
}

/** Where dark mode pulls every fill's lightness toward, and how far. */
const DARK_MID = 0.72;
const DARK_PULL = 0.3;
const DARK_CHROMA = 0.9;
const darkCache = new Map<string, string>();

/**
 * The dark-mode value of any fill: lightness pulled 30% toward the middle (a
 * white coat becomes a soft pale grey, charcoal lifts off the page) and a
 * little less chroma. The ink outline is left alone. Not a palette key.
 */
export function darkFill(hex: string): string {
  if (!HEX.test(hex)) return hex;
  const key = hex.toLowerCase();
  if (key === INK) return INK;
  let out = darkCache.get(key);
  if (!out) {
    const [L, A, B] = hexToOklab(key);
    out = oklabToHex([L + (DARK_MID - L) * DARK_PULL, A * DARK_CHROMA, B * DARK_CHROMA]);
    darkCache.set(key, out);
  }
  return out;
}
