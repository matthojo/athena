/**
 * The working dot's colour: each assistant's own, read from its character's
 * palette by key (team/kit/palette.ts), and checked for contrast against the
 * value each key has now, so it stays readable whatever the palette holds.
 *
 *   dotColour(spec)      { light, dark, from }  the colour for each theme
 *   paintWho(el, spec)   sets --who-light / --who-dark and .has-who on el;
 *                        the .team-dot and ring inside take it
 *                        (styles/team-pulse.css)
 *
 * A breathing dot coloured from the character's primary colour, everywhere
 * it belongs to one assistant.
 */
import { INK, accentTone, furTone, outfitTone } from "./kit/palette";

const full = (hex: string) => (hex.length === 4 ? hex.replace(/[0-9a-f]/gi, "$&$&") : hex);

/** WCAG relative luminance of a #rgb or #rrggbb. */
function luminance(hex: string): number {
  const h = full(hex);
  const lin = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** `a` moved `t` of the way to `b`, in sRGB: "#rrggbb". */
function mix(a: string, b: string, t: number): string {
  const [x, y] = [full(a), full(b)];
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(x.slice(i, i + 2), 16) * (1 - t) + parseInt(y.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * What a working dot sits on, per theme (tokens.css --surface, --canvas and
 * --sunken, as sRGB): it must clear DOT_CONTRAST on every one of them.
 */
export const DOT_GROUNDS = {
  light: ["#fcfdfe", "#f4f6f8", "#eef0f4"],
  dark: ["#14171d", "#0c0e13", "#1d2026"],
} as const;

/** WCAG 1.4.11's 3:1 for a mark you need to see. */
export const DOT_CONTRAST = 3;

export interface DotColour {
  light: string;
  dark: string;
  /** Where each came from, for the tests and the contact sheet: "fur", "fur shade", "fur shade, deepened", "outfit", "accent", "outfit, deepened"… */
  from: { light: string; dark: string };
}

/** How far a coat may be deepened toward ink (lifted toward white on dark) and still be its coat. */
const COAT_STEPS = 2;

/**
 * A character's own colour for its working dot, in each theme, the first
 * that reads on every ground: its coat; its coat's shade; that shade a
 * little deeper; its outfit; its accent; and, when none of those reads,
 * whichever reads first deepened a step at a time. So a pale coat (cream)
 * takes its outfit in light, a dark one (charcoal) its outfit in dark, and
 * a near-white one (snow) its outfit in both: a white dot would say
 * "working" but not who.
 */
export function dotColour(spec: { fur: string; outfitColor: string; accent: string }): DotColour {
  const fur = furTone(spec.fur);
  const white = luminance(fur.fill) > 0.75;
  const coat: Array<[string, string]> = white ? [] : [["fur", fur.fill], ["fur shade", fur.shade]];
  const rest: Array<[string, string]> = [
    ["outfit", outfitTone(spec.outfitColor).fill],
    ["accent", accentTone(spec.accent).fill],
  ];
  const pick = (grounds: readonly string[], toward: string): [string, string] => {
    const reads = (c: string) => Math.min(...grounds.map((g) => contrast(c, g))) >= DOT_CONTRAST;
    const deeper = ([from, c]: [string, string], step: number): [string, string] => [`${from}, deepened`, mix(c, toward, step / 10)];
    const found = coat.find(([, c]) => reads(c));
    if (found) return found;
    for (let step = 1; step <= COAT_STEPS && coat.length; step++) {
      const d = deeper(coat[1], step);
      if (reads(d[1])) return d;
    }
    const other = rest.find(([, c]) => reads(c));
    if (other) return other;
    // Nothing reads as it is: deepen them all a step at a time; the first to read wins, in the same order.
    const all = [...coat, ...rest];
    for (let step = 1; step < 10; step++) {
      const d = all.map((t) => deeper(t, step)).find(([, c]) => reads(c));
      if (d) return d;
    }
    return all[0];
  };
  const [lf, light] = pick(DOT_GROUNDS.light, INK);
  const [df, dark] = pick(DOT_GROUNDS.dark, "#ffffff");
  return { light, dark, from: { light: lf, dark: df } };
}

/**
 * Give an element its assistant's colour: the working dot and the ring round
 * a working face inside it (styles/team-pulse.css `.team-dot`, `--who`) take
 * it, in light and dark. Without one they stay the accent.
 */
export function paintWho(el: HTMLElement, spec: { fur: string; outfitColor: string; accent: string } | null | undefined): HTMLElement {
  if (!spec) {
    el.classList.remove("has-who");
    return el;
  }
  const c = dotColour(spec);
  el.style.setProperty("--who-light", c.light);
  el.style.setProperty("--who-dark", c.dark);
  el.classList.add("has-who");
  return el;
}
