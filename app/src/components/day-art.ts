/**
 * Artwork for Days: posters, covers, album art, game art and photos. Each
 * tile keeps its own shape (2:3, 1:1, 16:9…) and shows its tone until the
 * image arrives, so a strip never flashes grey. Images load when they come
 * near the screen and fade in (no fade with reduced motion). A cover inside
 * a link lifts a little on hover and settles on press (days-art.css); the
 * sample covers' titles follow lib/cover-ink.ts.
 */

import { h } from "../lib/dom";
import { artUrl, photoUrl, type DayArt as Art, type DayPhoto } from "../db/days-app";
import "../styles/days-art.css";

let observer: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function watch(el: HTMLElement, load: () => void) {
  if (typeof IntersectionObserver === "undefined") return load();
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer!.unobserve(e.target);
        pending.get(e.target)?.();
        pending.delete(e.target);
      }
    },
    { rootMargin: "400px 200px" }
  );
  pending.set(el, load);
  observer.observe(el);
}

export interface ArtTileOptions {
  /** The tile's height in px; its width follows the art's shape. Omit to fill the width instead. */
  height?: number;
  /** Words for a screen reader; empty when the title is said next to it. */
  alt?: string;
  className?: string;
  /** Fallback shape when there's no art at all ("w/h"). */
  shape?: [number, number];
  /** A letter or two to show when there's no art. */
  initials?: string;
  /** One of the owner's photos rather than artwork; "full" loads the whole file. */
  photo?: "thumb" | "full";
  /** The large size (800px) for heroes and wide tiles. */
  large?: boolean;
  /** Force this shape (w, h), cropping the art to fill it. */
  frame?: [number, number];
}

/** A day photo as a tile's art: its shape, or 4:3 when unknown. */
export const photoArt = (p: DayPhoto): Art => ({ id: p.id, w: p.w || 4, h: p.h || 3 });

export function artTile(art: Art | undefined, opts: ArtTileOptions = {}): HTMLElement {
  const [w, hh] = opts.frame ?? (art ? [art.w, art.h] : (opts.shape ?? [1, 1]));
  const tile = h("span", { class: `art${opts.className ? ` ${opts.className}` : ""}${art ? "" : " art--none"}` });
  tile.style.aspectRatio = `${w} / ${hh}`;
  if (opts.height) {
    tile.style.height = `${opts.height}px`;
    tile.style.width = `${Math.round((opts.height * w) / hh)}px`;
  }
  if (art?.tone) tile.style.setProperty("--tone", art.tone);
  if (!art) {
    if (opts.initials) tile.append(h("span", { class: "art__initials", "aria-hidden": "true" }, opts.initials));
    if (opts.alt) tile.setAttribute("aria-label", opts.alt);
    return tile;
  }
  const img = h("img", { class: "art__img", alt: opts.alt ?? "", decoding: "async", draggable: "false" }) as HTMLImageElement;
  tile.append(img);
  watch(tile, () => {
    void (opts.photo ? photoUrl(art.id, opts.photo === "thumb") : artUrl(art.id, opts.large ? "lg" : "sm")).then((url) => {
      if (!url) return tile.classList.add("art--missing");
      img.addEventListener("load", () => tile.classList.add("is-loaded"), { once: true });
      img.src = url;
    });
  });
  return tile;
}

export const initialsOf = (title: string) =>
  title
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

/** A row of artwork at one height, each at its own width, up to `max`; the rest as "+3". */
export function artStrip(items: { art?: Art; title: string; photo?: boolean }[], opts: { height: number; max: number }): HTMLElement | null {
  const withArt = items.filter((i) => i.art);
  if (!withArt.length) return null;
  const shown = withArt.slice(0, opts.max);
  const strip = h("span", { class: "art-strip", "aria-hidden": "true" }, ...shown.map((i) => artTile(i.art, { height: opts.height, frame: [3, 4], photo: i.photo ? "thumb" : undefined })));
  strip.style.height = `${opts.height}px`;
  if (withArt.length > shown.length) strip.append(h("span", { class: "art-strip__more", style: `height:${opts.height}px` }, `+${withArt.length - shown.length}`));
  return strip;
}
