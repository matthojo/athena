/**
 * Eyes, mouths/noses and outfits. Eyes and mouths are authored around a local
 * origin and translated onto the species anchors; outfits are drawn on the
 * shared body (shoulders from y≈92 down past the canvas edge).
 */
import type { EyesId, MouthId, OutfitId } from "./types";
import { INK } from "./palette";

// Muted with the palette (16 Nov): warm, never candy.
const MOUTH_RED = "#c25e53";
const TONGUE = "#e59ea3";
const WHITE = "#fdfcf9";
const NOSE_PEACH = "#deaa93";

/** One eye at the origin. The pupil group lifts when thinking; .kit-eye squashes to blink. */
export const EYES: Record<EyesId, { label: string; draw: () => string; blinks: boolean }> = {
  round: {
    label: "Round",
    blinks: true,
    draw: () => `<g class="kit-pupil"><circle r="3.8" fill="${INK}" stroke="none"/><circle cx="1.2" cy="-1.3" r="1.2" fill="#fff" stroke="none"/></g>`,
  },
  sparkle: {
    label: "Sparkle",
    blinks: true,
    draw: () =>
      `<ellipse rx="5.4" ry="6" fill="${INK}" stroke="none"/>` +
      `<g class="kit-pupil"><circle cx="-1.6" cy="-2" r="2.1" fill="#fff" stroke="none"/><circle cx="2" cy="2" r="0.9" fill="#fff" stroke="none"/></g>`,
  },
  sleepy: {
    label: "Sleepy",
    blinks: false,
    draw: () => `<path d="M-5.5,-1 Q0,4.5 5.5,-1" fill="none"/><path d="M-5.5,-1 L-7.5,-2.4 M-4.4,1.2 L-6.4,2.2" fill="none" stroke-width="{t}"/>`,
  },
  happy: {
    label: "Happy",
    blinks: false,
    draw: () => `<path d="M-5,2 Q0,-4.5 5,2" fill="none"/>`,
  },
};

/**
 * The small head's eyes: one solid shape each, no highlights, so they stay
 * eyes at 20px. Sleepy and happy keep their arcs (the heavier line carries them).
 */
export const SIMPLE_EYES: Record<EyesId, { draw: () => string; blinks: boolean }> = {
  round: { blinks: true, draw: () => `<g class="kit-pupil"><circle r="4.6" fill="${INK}" stroke="none"/></g>` },
  sparkle: { blinks: true, draw: () => `<g class="kit-pupil"><ellipse rx="4.8" ry="5.4" fill="${INK}" stroke="none"/></g>` },
  sleepy: { blinks: false, draw: () => `<path d="M-5.5,-0.5 Q0,4.5 5.5,-0.5" fill="none"/>` },
  happy: { blinks: false, draw: () => `<path d="M-5.5,2 Q0,-4.5 5.5,2" fill="none"/>` },
};

/** Draws the nose for the three nose ids; mouths keep the species' own nose. */
export const NOSES: Partial<Record<MouthId, string>> = {
  "button-nose": `<circle r="3.8" fill="${NOSE_PEACH}"/>`,
  "triangle-nose": `<path d="M0,-3.6 L4.4,2.8 L-4.4,2.8 Z" fill="${NOSE_PEACH}" stroke-linejoin="round"/>`,
  "heart-nose": `<path d="M0,3.6 C-1.6,2.4 -4.6,0.4 -4.6,-1.4 C-4.6,-3.4 -2.2,-4 0,-1.8 C2.2,-4 4.6,-3.4 4.6,-1.4 C4.6,0.4 1.6,2.4 0,3.6 Z" fill="#dc8a90"/>`,
};

const smile = `<path d="M-5,-1 Q0,4 5,-1" fill="none"/>`;

export const MOUTHS: Record<MouthId, { label: string; draw: () => string }> = {
  "small-smile": { label: "Small smile", draw: () => smile },
  "big-laugh": {
    label: "Big laugh",
    draw: () =>
      `<path d="M-8,-3 Q0,-4.2 8,-3 Q7,8 0,8 Q-7,8 -8,-3 Z" fill="${MOUTH_RED}" stroke="none"/>` +
      `<path d="M-7.6,-2.6 Q0,-3.6 7.6,-2.6 L7.2,-0.6 Q0,0.4 -7.2,-0.6 Z" fill="${WHITE}" stroke="none"/>` +
      `<path d="M-4.6,5.6 Q0,2.4 4.6,5.6 Q0,8.4 -4.6,5.6 Z" fill="${TONGUE}" stroke="none"/>` +
      `<path d="M-8,-3 Q0,-4.2 8,-3 Q7,8 0,8 Q-7,8 -8,-3 Z" fill="none"/>`,
  },
  "wavy-frown": {
    label: "Wavy frown",
    draw: () => `<path d="M-7,1.5 Q-5.2,-1.6 -3.5,0.8 Q-1.8,3.2 0,0.8 Q1.8,-1.6 3.5,0.8 Q5.2,3.2 7,1" fill="none"/>`,
  },
  "cat-w": { label: "Cat mouth", draw: () => `<path d="M-5,-1 Q-2.5,3.2 0,-0.4 Q2.5,3.2 5,-1" fill="none"/>` },
  "buck-teeth": {
    label: "Buck teeth",
    draw: () =>
      `<path d="M-3,0.4 L-3,4 Q-3,5 -2,5 L2,5 Q3,5 3,4 L3,0.4 Z" fill="${WHITE}"/><path d="M0,1 L0,5" fill="none" stroke-width="{t}"/>` +
      `<path d="M-6,-1.2 Q0,2.6 6,-1.2" fill="none"/>`,
  },
  "fang-grin": {
    label: "Fang grin",
    draw: () =>
      `<path d="M-4.6,0.1 L-3.6,3.6 L-2.4,0.8 Z M4.6,0.1 L3.6,3.6 L2.4,0.8 Z" fill="${WHITE}" stroke-width="{t}" stroke-linejoin="round"/>` +
      `<path d="M-7,-2 Q0,4.2 7,-2" fill="none"/>`,
  },
  "surprised-o": {
    label: "Surprised",
    draw: () =>
      `<ellipse rx="3.6" ry="4.4" fill="#62322f"/>` +
      `<ellipse cy="2.2" rx="2" ry="1.3" fill="${MOUTH_RED}" stroke="none"/>` +
      `<ellipse rx="3.6" ry="4.4" fill="none"/>`,
  },
  smirk: { label: "Smirk", draw: () => `<path d="M-6,0 Q0,2.6 6,-2.6 M5.6,-3.6 Q6.6,-2.8 7.6,-1.6" fill="none"/>` },
  "tongue-out": {
    label: "Tongue out",
    draw: () =>
      `<path d="M-2.8,0.8 L-2.8,4 Q-2.8,6.8 0,6.8 Q2.8,6.8 2.8,4 L2.8,0.8 Z" fill="#db8a94"/>` +
      `<path d="M0,1.8 L0,4.4" fill="none" stroke-width="{t}"/>` +
      `<path d="M-6,-1.2 Q0,3 6,-1.2" fill="none"/>`,
  },
  "button-nose": { label: "Button nose", draw: () => smile },
  "triangle-nose": { label: "Triangle nose", draw: () => smile },
  "heart-nose": { label: "Heart nose", draw: () => smile },
};

/** Resting mouths that are calm enough to give way to the grin when happy. */
export const CALM_MOUTHS: ReadonlySet<MouthId> = new Set<MouthId>(["small-smile", "cat-w", "smirk", "wavy-frown", "button-nose", "triangle-nose", "heart-nose"]);

/** The happy mood's grin: an open smile, warm but smaller than the big laugh. */
export const GRIN = (simple = false) =>
  simple
    ? `<path d="M-6,-2 Q0,-2.8 6,-2 Q5,5.4 0,5.4 Q-5,5.4 -6,-2 Z" fill="${MOUTH_RED}"/>`
    : `<path d="M-6.4,-2.4 Q0,-3.4 6.4,-2.4 Q5.6,6 0,6 Q-5.6,6 -6.4,-2.4 Z" fill="${MOUTH_RED}" stroke="none"/>` +
      `<path d="M-3.6,4.2 Q0,1.8 3.6,4.2 Q0,6.4 -3.6,4.2 Z" fill="${TONGUE}" stroke="none"/>` +
      `<path d="M-6.4,-2.4 Q0,-3.4 6.4,-2.4 Q5.6,6 0,6 Q-5.6,6 -6.4,-2.4 Z" fill="none"/>`;

/**
 * The small head's mouths, where the full one has detail a chip can't hold.
 * Anything not listed draws as usual.
 */
export const SIMPLE_MOUTHS: Partial<Record<MouthId, string>> = {
  "big-laugh": `<path d="M-7,-2.6 Q0,-3.6 7,-2.6 Q6,6.6 0,6.6 Q-6,6.6 -7,-2.6 Z" fill="${MOUTH_RED}"/>`,
  "buck-teeth": `<path d="M-5.5,-1 Q0,4 5.5,-1" fill="none"/>`,
  "fang-grin": `<path d="M-6,-1.6 Q0,4.4 6,-1.6" fill="none"/>`,
  "tongue-out": `<path d="M-5.5,-1 Q0,4 5.5,-1" fill="none"/>`,
  smirk: `<path d="M-5.5,0.4 Q0,2.8 5.5,-2.4" fill="none"/>`,
  "surprised-o": `<ellipse rx="3.4" ry="4" fill="#62322f"/>`,
};

/** The body under every outfit. */
export const TORSO = "M24,124 C24,103 38,93 60,93 C82,93 96,103 96,124 Z";

const SHIRT = "#f7f5f1";

export const OUTFITS: Record<OutfitId, { label: string; draw: (fill: string, fur: string) => string }> = {
  tee: {
    label: "Tee",
    draw: (c) =>
      `<path d="${TORSO}" fill="${c}"/>` +
      `<path d="M49,93.6 Q60,103 71,93.6" fill="none"/>` +
      `<path d="M35,107 L37,124 M85,107 L83,124" fill="none" stroke-width="{t}"/>`,
  },
  hoodie: {
    label: "Hoodie",
    draw: (c) =>
      `<path d="${TORSO}" fill="${c}"/>` +
      `<path d="M36,96 C36,86 48,84 60,84 C72,84 84,86 84,96 C78,102 70,104 60,104 C50,104 42,102 36,96 Z" fill="${c}"/>` +
      `<path d="M54,103 L53,113 M66,103 L67,113" fill="none" stroke-width="{t}"/>` +
      `<circle cx="53" cy="114" r="1.4" fill="${SHIRT}" stroke-width="{t}"/><circle cx="67" cy="114" r="1.4" fill="${SHIRT}" stroke-width="{t}"/>` +
      `<path d="M42,118 L78,118" fill="none" stroke-width="{t}"/>`,
  },
  polo: {
    label: "Polo",
    draw: (c) =>
      `<path d="${TORSO}" fill="${c}"/>` +
      `<path d="M60,100 L60,113" fill="none" stroke-width="{t}"/>` +
      `<circle cx="60" cy="105" r="1.1" fill="${INK}" stroke="none"/><circle cx="60" cy="110" r="1.1" fill="${INK}" stroke="none"/>` +
      `<path d="M46,93 L60,100 L52,106 Z M74,93 L60,100 L68,106 Z" fill="${c}" stroke-linejoin="round"/>`,
  },
  overalls: {
    label: "Overalls",
    draw: (c, fur) =>
      `<path d="${TORSO}" fill="${fur}"/>` +
      `<path d="M41,94 L48,94 L48,108 L41,108 Z M72,94 L79,94 L79,108 L72,108 Z" fill="${c}"/>` +
      `<path d="M40,106 L80,106 L80,124 L40,124 Z" fill="${c}" stroke-linejoin="round"/>` +
      `<circle cx="44.5" cy="109.5" r="1.3" fill="${SHIRT}" stroke-width="{t}"/><circle cx="75.5" cy="109.5" r="1.3" fill="${SHIRT}" stroke-width="{t}"/>` +
      `<path d="M52,114 L68,114 L68,120 L52,120 Z" fill="none" stroke-width="{t}"/>`,
  },
  blazer: {
    label: "Blazer",
    draw: (c) =>
      `<path d="${TORSO}" fill="${c}"/>` +
      `<path d="M49,93 L60,116 L71,93 Z" fill="${SHIRT}" stroke-linejoin="round"/>` +
      `<path d="M49,93 L44,100 L51,104 L47,107 L60,116 Z M71,93 L76,100 L69,104 L73,107 L60,116 Z" fill="${c}" stroke-linejoin="round"/>` +
      `<circle cx="60" cy="120" r="1.3" fill="${INK}" stroke="none"/>`,
  },
  vest: {
    label: "Vest",
    draw: (c, fur) =>
      `<path d="${TORSO}" fill="${fur}"/>` +
      `<path d="M37,124 L37,106 C37,100 40,96 43,95 L46,95 C47,103 53,109 60,109 C67,109 73,103 74,95 L77,95 C80,96 83,100 83,106 L83,124 Z" fill="${c}" stroke-linejoin="round"/>`,
  },
  collar: {
    label: "Collar",
    draw: (c, fur) =>
      `<path d="${TORSO}" fill="${fur}"/>` +
      `<path d="M41,92 C48,99 72,99 79,92 L81,97 C73,106 47,106 39,97 Z" fill="${c}" stroke-linejoin="round"/>` +
      `<circle cx="60" cy="106" r="3" fill="#f0d17d"/>`,
  },
};
