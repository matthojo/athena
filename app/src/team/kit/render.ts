/**
 * Live avatar elements: renderAvatar builds the SVG, and while idle and
 * animated it blinks every 4–7 seconds at random. Timers stop on their own
 * once the element leaves the document.
 */
import "./avatar.css";
import type { AvatarSpec, Mood, RenderOptions } from "./types";
import { SMALL_PX, avatarInner } from "./svg";
import { avatarTint } from "./palette";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The face crop: ears and hats may clip at the edges, the face never does. */
export const HEAD_BOX = "14 16 92 92";
/** The small head's crop: a touch higher, so cat, fox and bear ears stay whole in a round chip. */
export const SMALL_BOX = "13 9 94 94";

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const blinkers = new WeakSet<SVGSVGElement>();

function scheduleBlink(svg: SVGSVGElement, misses = 0): void {
  const wait = 4000 + Math.random() * 3000;
  window.setTimeout(() => {
    if (!svg.isConnected) {
      // Not attached yet (or gone for good): give a fresh element ~30s to land.
      if (svg.dataset.kitSeen || misses >= 5) return void blinkers.delete(svg);
      return scheduleBlink(svg, misses + 1);
    }
    svg.dataset.kitSeen = "1";
    if (svg.dataset.mood === "idle" && svg.classList.contains("kit-animate") && !reducedMotion()) {
      svg.classList.remove("kit-blinking");
      void svg.getBoundingClientRect();
      svg.classList.add("kit-blinking");
    }
    scheduleBlink(svg, 0);
  }, wait);
}

function ensureBlink(svg: SVGSVGElement): void {
  if (blinkers.has(svg) || !svg.classList.contains("kit-animate")) return;
  blinkers.add(svg);
  svg.addEventListener("animationend", (e) => {
    if ((e as AnimationEvent).animationName === "kit-blink") svg.classList.remove("kit-blinking");
  });
  scheduleBlink(svg);
}

/**
 * Draw a character. `animate` defaults to on for sizes of 64px and up (heroes,
 * the setup reveal) and off for chips and bubbles, so lists stay still.
 * Under 40px it draws the small head: framed to the face, a heavier line, and
 * none of the fine detail (whiskers, spots, highlights, bows, necklaces).
 */
export function renderAvatar(spec: AvatarSpec, opts: RenderOptions = { size: 48 }): SVGSVGElement {
  const size = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 48;
  const animate = opts.animate ?? size >= 64;
  const svg = document.createElementNS(SVG_NS, "svg");
  const simple = size < SMALL_PX;
  const head = (opts.frame ?? (simple ? "head" : "full")) === "head";
  const box = head ? (simple ? SMALL_BOX : HEAD_BOX) : "0 0 120 120";
  svg.setAttribute("viewBox", box);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `kit-avatar${animate ? " kit-animate" : ""}${simple ? " kit-small" : ""}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.mood = opts.mood ?? "idle";
  svg.innerHTML = avatarInner(spec, head ? (size * 120) / (simple ? 94 : 92) : size, { simple });
  ensureBlink(svg);
  return svg;
}

/** At this size and up a tile lets ears, antennae and hats rise past its top edge. */
export const RISE_PX = 72;
/** The tile's crop at RISE_PX and up: the head sits at the top edge, and what's above it draws outside. */
export const TILE_BOX = "13 22 94 94";
/** The tile's crop below RISE_PX: the whole character inside, ears, antennae and hats included. */
export const FIT_BOX = "13 4 94 94";

/**
 * The frame every Team surface draws an assistant in: a rounded-square tile
 * tinted from the coat. At RISE_PX and up the character fills the tile and
 * its ears, antennae or hat rise past the top edge; the tile then carries a
 * top margin of that height (`--kit-rise`), so the layout leaves room.
 * Radius and rise follow the size in avatar.css: a screen can resize a tile
 * at a breakpoint by setting `--kit-size` on it (staying on the same side of
 * RISE_PX).
 * Below that it is the plain tile with the character fully inside. People
 * stay circles: the tile is what says "assistant".
 *
 * Returns a <span class="kit-tile"> holding the <svg>; setAvatarMood and
 * updateAvatar take either. `--kit-r` on the tile is its corner radius, for
 * a ring or a dot that follows its shape.
 */
export function renderAvatarTile(spec: AvatarSpec, opts: RenderOptions = { size: 48 }): HTMLSpanElement {
  const size = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 48;
  const rise = size >= RISE_PX;
  const svg = renderAvatar(spec, { ...opts, size, frame: "full" });
  const box = rise ? TILE_BOX : FIT_BOX;
  svg.setAttribute("viewBox", box);
  svg.innerHTML = avatarInner(spec, (size * 120) / boxWidth(box), { simple: size < SMALL_PX });
  const tile = document.createElement("span");
  tile.className = `kit-tile${rise ? " kit-tile-rise" : ""}`;
  tile.setAttribute("aria-hidden", "true");
  tile.style.cssText = `--kit-px:${size}px;--kit-tint:${avatarTint(spec.fur)}`;
  tile.append(svg);
  return tile;
}

const boxWidth = (box: string | null) => Number(box?.split(/\s+/)[2]) || 120;
const svgOf = (el: SVGSVGElement | HTMLElement): SVGSVGElement | null =>
  el instanceof SVGSVGElement ? el : el.querySelector<SVGSVGElement>("svg.kit-avatar");

/** Change mood in place (thinking while a draft loads, happy on the reveal) without redrawing. */
export function setAvatarMood(el: SVGSVGElement | HTMLElement, mood: Mood): void {
  const svg = svgOf(el);
  if (!svg) return;
  svg.dataset.mood = mood;
  ensureBlink(svg);
}

/** Swap a rendered avatar's art (or a tile's, tint included) for a new spec, keeping the element, its mood and its blink timer. */
export function updateAvatar(el: SVGSVGElement | HTMLElement, spec: AvatarSpec): void {
  const svg = svgOf(el);
  if (!svg) return;
  const size = Number(svg.getAttribute("width")) || 48;
  svg.innerHTML = avatarInner(spec, (size * 120) / boxWidth(svg.getAttribute("viewBox")), { simple: size < SMALL_PX });
  const tile = svg.parentElement;
  if (tile?.classList.contains("kit-tile")) tile.style.setProperty("--kit-tint", avatarTint(spec.fur));
}
