/**
 * A day's map: where you went, as one image Athena draws and keeps
 * (lib/static-map.ts). For the design session to place on a day.
 *
 *   const map = dayMap({ date: "2026-11-07", places: ["Home", "Dishoom", "Hampstead Heath"] });
 *   parent.append(map.el);   // map.destroy() when the view goes
 *
 * States, each designed to sit in a day without shouting:
 *  - loading: the map's shape, quietly shimmering (still, with reduced motion).
 *  - ready: the image, with alt text naming the stops in order. Tap (or
 *    Enter) opens it full screen, larger and sharper, with pinch to zoom;
 *    swipe down, Escape or Close to go back.
 *  - no_key: a faint sketch of a map and "Add a map key in Settings".
 *  - key_rejected: the same, saying the key stopped working.
 *  - no_places: nothing at all (el is hidden), so the day doesn't show an
 *    empty frame. onState says so, if the layout cares.
 *  - unavailable / offline: the last copy on this device if there is one;
 *    otherwise a line saying so and, online, Try again.
 *
 * Follows the system's light or dark setting and redraws when it changes.
 * The image is the server's: the browser never contacts a map provider.
 */
import { h, svg } from "../lib/dom";
import { calendarDate } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { icons } from "./icons";
import { isSampleMode } from "../db/api";
import { decodeHeader, fetchDayMap, PROVIDER_INFO, type DayMapResult, type DayMapState, type TileProvider } from "../db/art-api";
import "../styles/attachments.css";
import "../styles/days-art.css";

export interface DayMapOptions {
  /** The day, "YYYY-MM-DD". */
  date: string;
  /** The day's places in order (Day.places names), for the alt text. Optional. */
  places?: string[];
  /** Where "Add a map key" goes. Default #/settings/maps. */
  settingsHref?: string;
  /** Told each time the state settles. */
  onState?: (state: DayMapState) => void;
}

export interface DayMapHandle {
  el: HTMLElement;
  /** Ask again (after adding a key, say). */
  reload: () => void;
  destroy: () => void;
}

const CACHE = "athena-maps-v1";
const keyFor = (date: string, theme: string, size: string) => `/map-cache/${date}/${theme}/${size}`;
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const theme = () => (dark.matches ? "dark" : "light");

/** "Home, Dishoom, then Hampstead Heath": the stops in order, repeats after the first left out (except going home). */
export function stopsInWords(places: string[]): string {
  const seen: string[] = [];
  for (const p of places.map((x) => x.trim()).filter(Boolean)) if (seen[seen.length - 1] !== p) seen.push(p);
  if (!seen.length) return "";
  if (seen.length === 1) return seen[0];
  return `${seen.slice(0, -1).join(", ")}, then ${seen[seen.length - 1]}`;
}

/** The alt text: what the picture shows, in words a screen reader can say. */
export function mapAlt(date: string, places: string[] | undefined, stops: number | undefined): string {
  const words = stopsInWords(places ?? []);
  if (words) return `Map of ${calendarDate(date)}: ${words}.`;
  if (stops) return `Map of ${calendarDate(date)}: ${stops} ${stops === 1 ? "place" : "places"}.`;
  return `Map of ${calendarDate(date)}.`;
}

async function cached(key: string): Promise<Blob | null> {
  try {
    const hit = await (await caches.open(CACHE)).match(key);
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

async function keep(key: string, blob: Blob, meta: { stops?: number; attribution?: string }): Promise<void> {
  try {
    await (await caches.open(CACHE)).put(
      key,
      new Response(blob, { headers: { "Content-Type": blob.type || "image/webp", "X-Map-Stops": String(meta.stops ?? ""), "X-Map-Attribution": encodeURIComponent(meta.attribution ?? "") } })
    );
  } catch {
    // not kept here: fine
  }
}

async function cachedMeta(key: string): Promise<{ blob: Blob; stops?: number; attribution?: string } | null> {
  try {
    const hit = await (await caches.open(CACHE)).match(key);
    if (!hit) return null;
    return { blob: await hit.blob(), stops: Number(hit.headers.get("X-Map-Stops")) || undefined, attribution: decodeHeader(hit.headers.get("X-Map-Attribution")) };
  } catch {
    return null;
  }
}

/** The map's own icon: two corners pulling outwards. */
const expandIcon = () =>
  svg(
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-6.5 6.5"/><path d="M10 20H4v-6"/><path d="M4 20l6.5-6.5"/></svg>`
  );

/** A faint sketch of a map: a few streets, a dotted route, three stops. Shown where a real map will go. */
export function mapSketch(): SVGSVGElement {
  return svg(
    `<svg class="daymap__sketch" viewBox="0 0 600 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g class="daymap__sketch-streets" fill="none" stroke-linecap="round">
        <path d="M-20 92 C 120 70, 220 120, 360 96 S 560 60, 640 84" stroke-width="10"/>
        <path d="M-20 236 C 140 250, 260 206, 420 226 S 560 260, 640 238" stroke-width="7"/>
        <path d="M168 -20 C 150 90, 196 190, 172 340" stroke-width="7"/>
        <path d="M430 -20 C 446 80, 404 200, 438 340" stroke-width="10"/>
        <path d="M-20 160 L 640 170" stroke-width="4"/>
        <path d="M300 -20 L 286 340" stroke-width="4"/>
        <path d="M60 -20 L 104 340" stroke-width="3"/>
        <path d="M540 -20 L 522 340" stroke-width="3"/>
      </g>
      <path class="daymap__sketch-water" d="M470 260 C 520 236, 600 250, 640 230 L 640 340 L 440 340 Z"/>
      <polyline class="daymap__sketch-route" points="196,118 300,168 404,214" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="0 14"/>
      <g class="daymap__sketch-stops">
        <circle cx="196" cy="118" r="13"/><circle cx="300" cy="168" r="13"/><circle cx="404" cy="214" r="13"/>
      </g>
    </svg>`
  );
}

export function dayMap(opts: DayMapOptions): DayMapHandle {
  const el = h("figure", { class: "daymap", "aria-busy": "true" });
  let destroyed = false;
  let seq = 0;
  let current: { url: string; result: DayMapResult } | null = null;

  const settle = (state: DayMapState) => {
    el.removeAttribute("aria-busy");
    el.dataset.state = state;
    el.hidden = state === "no_places";
    opts.onState?.(state);
  };

  function skeleton() {
    el.dataset.state = "loading";
    el.setAttribute("aria-busy", "true");
    el.replaceChildren(h("div", { class: "daymap__frame daymap__frame--loading" }, mapSketch(), h("span", { class: "visually-hidden" }, "Loading the map")));
  }

  function showReady(blob: Blob, result: DayMapResult) {
    if (current) URL.revokeObjectURL(current.url);
    const url = URL.createObjectURL(blob);
    current = { url, result };
    const alt = mapAlt(opts.date, opts.places, result.stops);
    const img = h("img", { class: "daymap__img", src: url, alt, decoding: "async", draggable: "false" }) as HTMLImageElement;
    const open = h(
      "button",
      { class: "daymap__frame daymap__open", type: "button", "aria-label": `${alt} Open it larger.` },
      img,
      h("span", { class: "daymap__expand", "aria-hidden": "true" }, expandIcon())
    );
    open.addEventListener("click", () => openFullMap(opts, img, result));
    const credit = result.attribution ? h("figcaption", { class: "daymap__credit" }, result.attribution) : null;
    img.addEventListener("load", () => el.classList.add("daymap--in"), { once: true });
    el.replaceChildren(open, ...(credit ? [credit] : []));
    settle("ready");
  }

  function showInvite(state: "no_key" | "key_rejected", provider?: TileProvider) {
    const label = provider ? PROVIDER_INFO[provider].label : "Your map service";
    const title = state === "no_key" ? "See your day on a map" : "Your map key stopped working";
    const sub = state === "no_key" ? "Add a free map key in Settings. It takes about a minute." : `${label} stopped accepting the key. Add a new one to bring your maps back.`;
    const go = h("a", { class: "btn btn--soft btn--sm daymap__cta", href: opts.settingsHref ?? "#/settings/maps" }, state === "no_key" ? "Add a map key" : "Fix it in Settings");
    el.replaceChildren(
      h(
        "div",
        { class: `daymap__frame daymap__frame--invite${state === "key_rejected" ? " daymap__frame--warn" : ""}` },
        mapSketch(),
        h("div", { class: "daymap__invite" }, h("p", { class: "daymap__title" }, title), h("p", { class: "daymap__sub" }, sub), go)
      )
    );
    settle(state);
  }

  function showProblem(state: "unavailable" | "offline") {
    const retry = h("button", { class: "btn btn--soft btn--sm daymap__cta", type: "button" }, "Try again");
    retry.addEventListener("click", () => void load(true));
    el.replaceChildren(
      h(
        "div",
        { class: "daymap__frame daymap__frame--invite daymap__frame--quiet" },
        mapSketch(),
        h(
          "div",
          { class: "daymap__invite" },
          h("p", { class: "daymap__title" }, state === "offline" ? "The map needs a connection" : "The map didn't load"),
          h("p", { class: "daymap__sub" }, state === "offline" ? "It shows up once you're back online." : "Your places are safe. Try again in a minute."),
          state === "offline" ? null : retry
        )
      )
    );
    settle(state);
  }

  async function load(fresh = false) {
    const mine = ++seq;
    const t = theme();
    const key = keyFor(opts.date, t, "card");
    if (fresh || !current) skeleton();
    if (isSampleMode()) {
      showInvite("no_key");
      return;
    }
    // This device's copy first, so a day you've seen opens at once (and offline).
    const kept = !fresh ? await cachedMeta(key) : null;
    if (mine !== seq || destroyed) return;
    if (kept) showReady(kept.blob, { state: "ready", stops: kept.stops, attribution: kept.attribution });
    if (!navigator.onLine) {
      if (!kept) showProblem("offline");
      return;
    }
    let result: DayMapResult;
    try {
      result = await fetchDayMap(opts.date, t, "card");
    } catch {
      if (mine !== seq || destroyed) return;
      if (!kept) showProblem(navigator.onLine ? "unavailable" : "offline");
      return;
    }
    if (mine !== seq || destroyed) return;
    if (result.state === "ready" && result.blob) {
      // Only swap when it changed (a new place on today's map), so nothing flickers.
      if (!kept || kept.blob.size !== result.blob.size) showReady(result.blob, result);
      void keep(key, result.blob, result);
      return;
    }
    if (result.state === "no_key" || result.state === "key_rejected") showInvite(result.state, result.provider);
    else if (result.state === "no_places") {
      el.replaceChildren();
      settle("no_places");
    } else if (!kept) showProblem("unavailable");
  }

  const onTheme = () => void load(true);
  dark.addEventListener("change", onTheme);
  void load();
  return {
    el,
    reload: () => void load(true),
    destroy: () => {
      destroyed = true;
      dark.removeEventListener("change", onTheme);
      if (current) URL.revokeObjectURL(current.url);
    },
  };
}

// ---------- Full screen ----------

/** The map, large: the card's image straight away (no blank wait), then the sharper full-size one. */
function openFullMap(opts: DayMapOptions, from: HTMLImageElement, result: DayMapResult): void {
  const close = h("button", { class: "icon-btn icon-btn--sm viewer__close", type: "button", "aria-label": "Close" }, icons.close());
  const img = h("img", { class: "viewer__img daymap__full", src: from.src, alt: from.alt, draggable: "false" }) as HTMLImageElement;
  const stage = h("div", { class: "viewer__stage daymap__stage" }, img);
  const words = stopsInWords(opts.places ?? []);
  const dialog = h(
    "dialog",
    { class: "viewer daymap__viewer", "aria-label": `Map of ${calendarDate(opts.date)}` },
    h(
      "header",
      { class: "viewer__head" },
      h("div", { class: "viewer__title" }, h("p", { class: "viewer__name" }, calendarDate(opts.date)), h("p", { class: "viewer__meta" }, words || (result.stops ? `${result.stops} ${result.stops === 1 ? "place" : "places"}` : "Where you went"))),
      h("div", { class: "viewer__actions" }, close)
    ),
    stage,
    result.attribution ? h("p", { class: "daymap__viewer-credit" }, result.attribution) : null
  ) as HTMLDialogElement;
  if (!prefersReducedMotion()) dialog.classList.add("daymap__viewer--animate");

  let fullUrl: string | null = null;
  // A phone gets a tall map about its own width; a wide screen a large landscape one.
  const big = window.innerWidth < 720 ? "tall" : "full";
  const key = keyFor(opts.date, theme(), big);
  void (async () => {
    let blob = await cached(key);
    if (!blob && navigator.onLine && !isSampleMode()) {
      try {
        const r = await fetchDayMap(opts.date, theme(), big);
        if (r.state === "ready" && r.blob) {
          blob = r.blob;
          void keep(key, r.blob, r);
        }
      } catch {
        blob = null;
      }
    }
    if (!blob || !dialog.isConnected) return;
    fullUrl = URL.createObjectURL(blob);
    const sharp = new Image();
    sharp.onload = () => {
      if (!dialog.isConnected) return;
      img.style.aspectRatio = `${sharp.naturalWidth} / ${sharp.naturalHeight}`;
      img.src = fullUrl!;
      img.classList.add("daymap__full--sharp");
    };
    sharp.src = fullUrl;
  })();

  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target === stage) dialog.close();
  });
  let start: { x: number; y: number } | null = null;
  stage.addEventListener("pointerdown", (e) => (start = { x: e.clientX, y: e.clientY }));
  stage.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    const dx = e.clientX - start.x;
    start = null;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx) && (window.visualViewport?.scale ?? 1) <= 1.01) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (fullUrl) URL.revokeObjectURL(fullUrl);
    from.closest<HTMLElement>(".daymap__open")?.focus({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}
