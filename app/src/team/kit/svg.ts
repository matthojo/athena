/**
 * Composes an AvatarSpec into SVG markup. Pure string work, so it runs in
 * tests and on the server; render.ts turns it into a live element.
 */
import type { AccessoryId, AvatarSpec, EyesId, Mood, MouthId, OutfitId, Species } from "./types";
import { ACCENT, FUR, INK, OUTFIT, accentTone, darkFill, furTone, outfitTone } from "./palette";
import { SPECIES } from "./species";
import { EYES, GRIN, MOUTHS, NOSES, OUTFITS, SIMPLE_EYES, SIMPLE_MOUTHS, TORSO, CALM_MOUTHS } from "./parts";
import { ACCESSORIES, fitSlots } from "./accessories";

export const SPECIES_IDS = Object.keys(SPECIES) as Species[];
export const EYES_IDS = Object.keys(EYES) as EyesId[];
export const MOUTH_IDS = Object.keys(MOUTHS) as MouthId[];
export const OUTFIT_IDS = Object.keys(OUTFITS) as OutfitId[];
export const ACCESSORY_IDS = Object.keys(ACCESSORIES) as AccessoryId[];
export const FUR_KEYS = Object.keys(FUR);
export const ACCENT_KEYS = Object.keys(ACCENT);
export const OUTFIT_COLOR_KEYS = Object.keys(OUTFIT);

const pick = <T extends string>(v: unknown, ok: readonly T[], fallback: T): T =>
  ok.includes(v as T) ? (v as T) : fallback;

/** Coerce anything shaped roughly like a spec into a drawable one. */
export function normalizeSpec(s: Partial<AvatarSpec> | null | undefined): AvatarSpec {
  const x = s ?? {};
  return {
    v: 1,
    seed: typeof x.seed === "string" ? x.seed : "",
    species: pick(x.species, SPECIES_IDS, "cat"),
    fur: typeof x.fur === "string" ? x.fur : "cocoa",
    accent: typeof x.accent === "string" ? x.accent : "rose",
    eyes: pick(x.eyes, EYES_IDS, "round"),
    mouth: pick(x.mouth, MOUTH_IDS, "small-smile"),
    outfit: pick(x.outfit, OUTFIT_IDS, "tee"),
    outfitColor: typeof x.outfitColor === "string" ? x.outfitColor : "cobalt",
    accessories: fitSlots(Array.isArray(x.accessories) ? x.accessories : []),
  };
}

/** Stroke width in canvas units so the outline lands near 2px at common sizes. */
export function strokeFor(size: number): number {
  const s = Number.isFinite(size) && size > 0 ? size : 120;
  return +Math.min(3, Math.max(1.5, (2 * 120) / s)).toFixed(2);
}

/**
 * The small head's outline: heavier, so a 20–36px chip reads as a drawn
 * face and not a smudge. Aims for about 1.4px on screen, within bounds that
 * keep the features open.
 */
export function smallStrokeFor(size: number): number {
  const s = Number.isFinite(size) && size > 0 ? size : 36;
  return +Math.min(5, Math.max(3.4, (1.4 * 120) / s)).toFixed(2);
}

/** Below this rendered size (px) a character is drawn as the simplified head. */
export const SMALL_PX = 40;

/** Accessories too fine to read in a chip; the small head leaves them off. */
const SMALL_SKIPS = new Set<AccessoryId>(["bow", "flowers", "scarf", "heart-necklace"]);

export interface InnerOptions {
  /** The simplified head for chips and rows: no whiskers, spots, highlights or fine accessories, a heavier line. */
  simple?: boolean;
}

const at = (x: number, y: number, body: string) => `<g transform="translate(${x} ${y})">${body}</g>`;

/** Inner markup for a 120×120 viewBox. `size` is the on-screen size of the 120-unit canvas. */
export function avatarInner(input: Partial<AvatarSpec>, size = 120, opts: InnerOptions = {}): string {
  const spec = normalizeSpec(input);
  const simple = !!opts.simple;
  const art = SPECIES[spec.species];
  const a = art.anchors;
  const f = furTone(spec.fur);
  const ac = accentTone(spec.accent);
  const o = outfitTone(spec.outfitColor);
  const sw = simple ? smallStrokeFor(size) : strokeFor(size);
  const acc = spec.accessories.filter((id) => !simple || !SMALL_SKIPS.has(id)).map((id) => ({ id, ...ACCESSORIES[id] }));
  const of = (slot: string) => acc.filter((x) => x.slot === slot).map((x) => `<g class="kit-acc kit-acc-${x.id}">${x.draw(a)}</g>`).join("");
  const eye = simple ? SIMPLE_EYES[spec.eyes] : EYES[spec.eyes];
  const eyeClass = eye.blinks ? "kit-eye" : "kit-eye kit-eye-still";
  // Eyes that blink also carry a smiling arc, shown only in the happy mood (hidden without the stylesheet).
  const joy = eye.blinks ? `<path class="kit-joy" d="M-5,2 Q0,-4.5 5,2" fill="none" visibility="hidden"/>` : "";
  const eyeAt = (dx: number) => `<g transform="translate(${60 + dx} ${a.eyeY})"><g class="${eyeClass}">${eye.draw()}${joy}</g></g>`;
  const nose = NOSES[spec.mouth] ?? art.nose(f, ac);
  const mouth = (simple ? SIMPLE_MOUTHS[spec.mouth] : undefined) ?? MOUTHS[spec.mouth].draw();
  // A calm resting mouth gives way to a grin in the happy mood; a saved big laugh or fang grin stays itself.
  const calm = CALM_MOUTHS.has(spec.mouth);
  const mouthG =
    `<g class="kit-mouth${calm ? " kit-mouth-calm" : ""}">${mouth}</g>` +
    (calm ? `<g class="kit-grin" visibility="hidden">${GRIN(simple)}</g>` : "");

  const outfit = simple ? `<path d="${TORSO}" fill="${spec.outfit === "overalls" || spec.outfit === "vest" || spec.outfit === "collar" ? f.fill : o.fill}"/>` : OUTFITS[spec.outfit].draw(o.fill, f.fill);
  const body = `<g class="kit-body" transform="translate(0 ${a.chinY - 91})">${outfit}${of("neck")}</g>`;
  const head =
    `<g class="kit-head">` +
    art.ears(f, ac) +
    art.head(f, ac, simple) +
    `<g class="kit-cheeks" fill="${ac.cheek}" stroke="none">` +
    `<circle class="kit-cheek" cx="${60 - a.cheekDx}" cy="${a.cheekY}" r="${a.cheekR}"/>` +
    `<circle class="kit-cheek" cx="${60 + a.cheekDx}" cy="${a.cheekY}" r="${a.cheekR}"/></g>` +
    `<g class="kit-eyes">${eyeAt(-a.eyeDx)}${eyeAt(a.eyeDx)}</g>` +
    (simple ? `<g stroke-width="${+(sw * 0.72).toFixed(2)}">` : "") +
    (nose ? at(60, a.noseY, nose) : "") +
    at(60, a.mouthY, mouthG) +
    (simple ? `</g>` : "") +
    (simple ? "" : (art.over?.(f, ac) ?? "")) +
    of("face") +
    of("head") +
    `</g>`;
  const thin = +(sw * (simple ? 0.8 : 0.65)).toFixed(2);
  return withDark(
    `<g stroke="${INK}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">` +
    body + (simple ? "" : laptop(f.fill)) + head + `</g>`,
  ).replace(/\{t\}/g, String(thin));
}

const KEEP = new Set([INK, "#fff", "#ffffff"]);

/**
 * Give every coloured fill and stroke its dark-mode value as a custom
 * property (--kd, --ks) beside the light one. avatar.css swaps them in under
 * prefers-color-scheme: dark; without the stylesheet the light colours stand.
 */
export function withDark(markup: string): string {
  return markup.replace(/<([a-z]+)\b([^>]*?)(\/?)>/g, (tag, name: string, attrs: string, close: string) => {
    const vars: string[] = [];
    const fill = /\sfill="(#[0-9a-f]{3,6})"/i.exec(attrs)?.[1];
    const stroke = /\sstroke="(#[0-9a-f]{3,6})"/i.exec(attrs)?.[1];
    if (fill && !KEEP.has(fill.toLowerCase())) vars.push(`--kd:${darkFill(fill)}`);
    if (stroke && !KEEP.has(stroke.toLowerCase())) vars.push(`--ks:${darkFill(stroke)}`);
    return vars.length ? `<${name}${attrs} style="${vars.join(";")}"${close}>` : tag;
  });
}

/**
 * The working mood's prop: the back of a laptop held at the chest, with two
 * paws on its top edge. Hidden by a presentation attribute, so markup used
 * without the stylesheet (the server, an email) never shows it; avatar.css
 * shows it for [data-mood="working"].
 */
function laptop(fur: string): string {
  return (
    `<g class="kit-prop kit-laptop" visibility="hidden">` +
    `<path d="M38,122 L39.6,98.5 Q40,95.5 43,95.5 L77,95.5 Q80,95.5 80.4,98.5 L82,122 Z" fill="#5c6372"/>` +
    `<path d="M60,104.6 l2.6,4.4 l-2.6,4.4 l-2.6,-4.4 Z" fill="#dbdee5" stroke="none"/>` +
    `<ellipse class="kit-paw kit-paw-l" cx="45" cy="96.5" rx="5.2" ry="4" fill="${fur}"/>` +
    `<ellipse class="kit-paw kit-paw-r" cx="75" cy="96.5" rx="5.2" ry="4" fill="${fur}"/>` +
    `</g>`
  );
}

/** A whole standalone <svg> string (mini previews, screenshots, server use). */
export function avatarMarkup(input: Partial<AvatarSpec>, opts: { size?: number; mood?: Mood; viewBox?: string; simple?: boolean } = {}): string {
  const size = opts.size !== undefined && Number.isFinite(opts.size) && opts.size > 0 ? +opts.size.toFixed(2) : 120;
  const mood = opts.mood ?? "idle";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${opts.viewBox ?? "0 0 120 120"}" width="${size}" height="${size}" class="kit-avatar" data-mood="${mood}" aria-hidden="true" focusable="false">` +
    avatarInner(input, size, { simple: opts.simple }) +
    `</svg>`
  );
}
