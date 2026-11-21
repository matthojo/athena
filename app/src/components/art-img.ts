/**
 * Artwork on a day entry or in Watch & read: a poster, cover, album or game
 * header that Athena keeps (lib/art.ts). For the design session to drop in
 * anywhere an entry has `art`.
 *
 *   artImg(entry.art-img, { alt: "Past Lives", size: "sm", fallback: "film" })
 *
 * - The box has the image's shape from the start (w/h), filled with its
 *   dominant tone, so nothing jumps when it loads.
 * - Loads when it nears the screen (300 px ahead), through the token, and
 *   fades in. Reduced motion: no fade.
 * - Kept in Cache Storage, so it opens offline and is fetched once per
 *   device. The server's copy is cached for a year too (ids never change).
 * - No art, or it won't load: a quiet tile with the kind's icon, same shape.
 *   With `cover` it's a made cover instead: a fill picked from the title, the
 *   kind's icon, and the title in --ink or --on-ink, whichever reads on that
 *   fill (lib/cover-ink.ts). The title goes when the cover is under 64 px
 *   across (a container query), since the real one is beside it.
 *   In sample mode nothing is fetched.
 */
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { isSampleMode } from "../db/api";
import { fetchArtBlob } from "../db/art-api";
import { inkFor, madeFill } from "../lib/cover-ink";
import "../styles/days-art.css";

export interface ArtLike {
  id: string;
  w: number;
  h: number;
  tone?: string;
}

export interface ArtImgOptions {
  /** What it's art for: the title, e.g. "Past Lives". */
  alt: string;
  /** sm: up to 240 px on the long edge (lists); lg: up to 800 px (a hero). Default sm. */
  size?: "sm" | "lg";
  /** The icon shown when there's no art. Default film. */
  fallback?: IconName;
  /** The shape without art (width / height). Default 2 / 3, a poster. */
  ratio?: number;
  /** Extra class on the box. */
  class?: string;
  /** Load straight away (the first screenful). */
  eager?: boolean;
  /** Without art, draw a cover with this title (and maker) instead of the plain icon tile. */
  cover?: { title: string; by?: string };
}

const CACHE = "athena-art-v1";
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();
const keyFor = (id: string, size: string) => `/art-cache/${id}/${size}`;

/** An object URL for kept art: from this device, or fetched once. Null when it can't be had now. */
export function artUrl(id: string, size: "sm" | "lg"): Promise<string | null> {
  const key = keyFor(id, size);
  const ready = urls.get(key);
  if (ready) return Promise.resolve(ready);
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      let blob: Blob | null = null;
      try {
        const hit = await (await caches.open(CACHE)).match(key);
        blob = hit ? await hit.blob() : null;
      } catch {
        blob = null;
      }
      if (!blob && !isSampleMode() && navigator.onLine) {
        try {
          blob = await fetchArtBlob(id, size);
          try {
            await (await caches.open(CACHE)).put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/webp" } }));
          } catch {
            // not kept here (a private window): fine
          }
        } catch {
          blob = null;
        }
      }
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      return url;
    })().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Keep a picture as an item's art on this device, both sizes: sample mode's covers come only from here. */
export async function keepArt(id: string, blob: Blob): Promise<void> {
  for (const size of ["sm", "lg"] as const) {
    const key = keyFor(id, size);
    urls.set(key, URL.createObjectURL(blob));
    try {
      await (await caches.open(CACHE)).put(key, new Response(blob, { headers: { "Content-Type": blob.type || "image/webp" } }));
    } catch {
      // not kept past this visit (a private window): fine
    }
  }
}

// One observer for every image on the page.
const waiting = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;
function whenNear(el: Element, run: () => void): void {
  if (typeof IntersectionObserver === "undefined") return run();
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer!.unobserve(e.target);
        waiting.get(e.target)?.();
        waiting.delete(e.target);
      }
    },
    { rootMargin: "300px 0px" }
  );
  waiting.set(el, run);
  observer.observe(el);
}

/** A hex colour (what lib/art.ts stores) or an oklch() one (lib/day-types.ts allows any CSS colour). Nothing else reaches a style. */
const TONE = /^(#[0-9a-f]{6}|oklch\([0-9.%\s/]+\))$/i;

/** The art box. Always returns an element of the right shape, art or not. */
export function artImg(art: ArtLike | null | undefined, opts: ArtImgOptions): HTMLElement {
  const size = opts.size ?? "sm";
  const ratio = art && art.w > 0 && art.h > 0 ? art.w / art.h : opts.ratio ?? 2 / 3;
  const box = h("span", { class: `art-img${opts.class ? ` ${opts.class}` : ""}`, "data-size": size });
  box.style.setProperty("--art-ratio", String(ratio));
  if (art?.tone && TONE.test(art.tone)) box.style.setProperty("--art-tone", art.tone);

  const none = () => {
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", opts.alt);
    const icon = h("span", { class: "art-img__icon", "aria-hidden": "true" }, icons[opts.fallback ?? "film"]());
    const title = opts.cover?.title.trim();
    if (!title) {
      box.classList.add("art-img--none");
      box.replaceChildren(icon);
      return;
    }
    const fill = madeFill(title);
    box.classList.add("art-img--made", `art-img--ink-${inkFor(fill).tone}`);
    box.style.setProperty("--art-fill", fill);
    const by = opts.cover?.by?.trim();
    box.replaceChildren(icon, h("span", { class: "art-img__words", "aria-hidden": "true" }, h("span", { class: "art-img__title" }, title), by ? h("span", { class: "art-img__by" }, by) : null));
  };
  if (!art?.id) {
    none();
    return box;
  }

  const img = h("img", { class: "art-img__img", alt: opts.alt, decoding: "async", draggable: "false" }) as HTMLImageElement;
  box.append(img);
  box.classList.add("art-img--loading");
  const load = async () => {
    const url = await artUrl(art.id, size);
    if (!url) {
      box.classList.remove("art-img--loading");
      none();
      return;
    }
    img.addEventListener(
      "load",
      () => {
        box.classList.remove("art-img--loading");
        box.classList.add("art-img--in");
      },
      { once: true }
    );
    img.addEventListener("error", () => none(), { once: true });
    img.src = url;
  };
  if (opts.eager) void load();
  else whenNear(box, () => void load());
  return box;
}
