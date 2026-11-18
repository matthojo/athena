/**
 * Per-species base art (ears, head, face markings) on a 120×120 canvas, plus
 * the anchor points every eye, mouth and accessory hangs from. The head is
 * always centred on x=60; the body starts under the chin.
 */
import type { Species } from "./types";
import type { AccentTone, FurTone } from "./palette";
import { INK, darkFill } from "./palette";

export interface Anchors {
  /** y of the head's top edge on the centre line. */
  top: number;
  /** Half the head's width a little below the top (hat brims). */
  brim: number;
  /** x of the head's left edge at eye height (the right edge mirrors it). */
  faceL: number;
  eyeY: number;
  eyeDx: number;
  cheekY: number;
  cheekDx: number;
  cheekR: number;
  noseY: number;
  mouthY: number;
  /** Where the chin meets the body; neck accessories hang from here. */
  chinY: number;
  /** Bow / flower spot on the head's upper right. */
  side: [number, number];
  /** Eye patch strap end on the upper left of the head outline. */
  strapL: [number, number];
}

export interface SpeciesArt {
  anchors: Anchors;
  /** Drawn behind the head. */
  ears(f: FurTone, a: AccentTone): string;
  /** `simple`: the small head, which leaves fine markings (monster spots) off. */
  head(f: FurTone, a: AccentTone, simple?: boolean): string;
  /** Default nose; empty when the species has none. */
  nose(f: FurTone, a: AccentTone): string;
  /** Drawn over the mouth (whiskers). */
  over?(f: FurTone, a: AccentTone): string;
  label: string;
}

const mirror = (d: string) => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${+(120 - +x).toFixed(2)},${y}`);
const pair = (d: string, attrs: string) => `<path d="${d}" ${attrs}/><path d="${mirror(d)}" ${attrs}/>`;

export const SPECIES: Record<Species, SpeciesArt> = {
  cat: {
    label: "Cat",
    anchors: {
      top: 32, brim: 34, faceL: 22, eyeY: 58, eyeDx: 15, cheekY: 69, cheekDx: 25, cheekR: 7,
      noseY: 65, mouthY: 70, chinY: 88, side: [82, 40], strapL: [30, 42],
    },
    ears: (f, a) =>
      pair("M25,50 L29,16 Q30,12 33.5,14.5 L56,34 Z", `fill="${f.fill}"`) +
      pair("M31,40 L33,23 L46,34 Z", `fill="${a.fill}" stroke="none"`),
    head: (f) => `<path d="M22,62 C22,40 38,32 60,32 C82,32 98,40 98,62 C98,80 82,88 60,88 C38,88 22,80 22,62 Z" fill="${f.fill}"/>`,
    nose: (_f, a) => `<path d="M-3,-1.6 L3,-1.6 L0,1.8 Z" fill="${a.fill}" stroke-linejoin="round"/>`,
    over: () =>
      `<g fill="none" stroke-width="{t}">` +
      pair("M31,68 C22,64 14,64 5,66 M31,72 C22,71 14,73 7,78", "") +
      `</g>`,
  },
  bear: {
    label: "Bear",
    anchors: {
      top: 30, brim: 35, faceL: 24, eyeY: 56, eyeDx: 16, cheekY: 67, cheekDx: 26, cheekR: 7.5,
      noseY: 66, mouthY: 72, chinY: 90, side: [82, 38], strapL: [31, 41],
    },
    ears: (f) =>
      `<circle cx="32" cy="36" r="12" fill="${f.fill}"/><circle cx="88" cy="36" r="12" fill="${f.fill}"/>` +
      `<circle cx="32" cy="36" r="6.5" fill="${f.shade}" stroke="none"/><circle cx="88" cy="36" r="6.5" fill="${f.shade}" stroke="none"/>`,
    head: (f) =>
      `<path d="M24,62 C24,40 40,30 60,30 C80,30 96,40 96,62 C96,80 82,90 60,90 C38,90 24,80 24,62 Z" fill="${f.fill}"/>` +
      `<ellipse cx="60" cy="71" rx="15" ry="11" fill="${f.light}"/>`,
    nose: (f) => `<ellipse cx="0" cy="0" rx="4.6" ry="3.2" fill="${f.shade}"/>`,
  },
  fox: {
    label: "Fox",
    anchors: {
      top: 30, brim: 35, faceL: 22, eyeY: 55, eyeDx: 16, cheekY: 66, cheekDx: 26, cheekR: 7,
      noseY: 68, mouthY: 74, chinY: 89, side: [83, 38], strapL: [29, 41],
    },
    ears: (f) =>
      pair("M26,48 L29,10 Q30,7 33,9.5 L56,32 Z", `fill="${f.fill}"`) +
      pair("M31,38 L32.5,17 L46,31 Z", `fill="${f.light}" stroke="none"`),
    head: (f) =>
      `<path d="M22,60 C22,38 38,30 60,30 C82,30 98,38 98,60 C98,78 84,89 60,89 C36,89 22,78 22,60 Z" fill="${f.fill}"/>` +
      `<path d="M23,60 C32,66 46,62 54,68 L60,72 L66,68 C74,62 88,66 97,60 L108,63 L99,68 L105,72 L94,74 C88,84 76,90 60,90 C44,90 32,84 26,74 L15,72 L21,68 L12,63 Z" fill="${f.light}" stroke-linejoin="round"/>`,
    nose: () => `<path d="M-4.5,-2 L4.5,-2 L0,2.8 Z" fill="${INK}" stroke-linejoin="round"/>`,
  },
  bunny: {
    label: "Bunny",
    anchors: {
      top: 38, brim: 32, faceL: 26, eyeY: 62, eyeDx: 15, cheekY: 73, cheekDx: 24, cheekR: 7,
      noseY: 70, mouthY: 74, chinY: 92, side: [80, 45], strapL: [33, 48],
    },
    ears: (f, a) =>
      pair("M35,46 C30,26 32,4 43,4 C54,4 56,26 52,46 Z", `fill="${f.fill}"`) +
      pair("M39.5,40 C37,26 38,11 43.5,11 C49,11 49.5,26 48,40 Z", `fill="${a.fill}" stroke="none"`),
    head: (f) => `<path d="M26,66 C26,46 40,38 60,38 C80,38 94,46 94,66 C94,84 80,92 60,92 C40,92 26,84 26,66 Z" fill="${f.fill}"/>`,
    nose: (_f, a) => `<ellipse cx="0" cy="0" rx="2.8" ry="2" fill="${a.fill}"/>`,
  },
  monster: {
    label: "Monster",
    anchors: {
      top: 28, brim: 33, faceL: 26, eyeY: 54, eyeDx: 14, cheekY: 66, cheekDx: 23, cheekR: 6.5,
      noseY: 64, mouthY: 70, chinY: 90, side: [81, 36], strapL: [32, 40],
    },
    ears: (f, a) =>
      pair("M50,30 Q46,18 40,12", `class="kit-stalk" fill="none" style="--kstalk:${darkFill(f.shade === INK ? f.fill : f.shade)}"`) +
      `<circle cx="39" cy="11" r="4" fill="${a.fill}"/><circle cx="81" cy="11" r="4" fill="${a.fill}"/>` +
      `<circle cx="27" cy="56" r="8" fill="${a.fill}"/><circle cx="93" cy="56" r="8" fill="${a.fill}"/>`,
    head: (f, a, simple) =>
      `<path d="M26,62 C26,38 40,28 60,28 C80,28 94,38 94,62 C94,82 80,90 60,90 C40,90 26,82 26,62 Z" fill="${f.fill}"/>` +
      (simple ? "" : `<g fill="${a.fill}" stroke="none"><circle cx="44" cy="38" r="4.5"/><circle cx="79" cy="44" r="3.5"/><circle cx="36" cy="74" r="3"/><circle cx="70" cy="34" r="2.2"/></g>`),
    nose: () => "",
  },
};
