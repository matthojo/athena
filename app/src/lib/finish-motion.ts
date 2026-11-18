/**
 * The motion for finishing something: ticking a to-do, answering a card in
 * the Review inbox, ticking a habit, choosing a mood. Everything reads its
 * timing from the motion tokens in styles/tokens.css, so the app keeps one
 * rhythm, and everything respects prefers-reduced-motion (the CSS parts via
 * the global rule in base.css, the scripted parts here).
 *
 *  - collapse / expand: an element folds its height away (or opens back
 *    out), so whatever is below slides up or down rather than jumping.
 *  - lift: a card rises a little and fades as it leaves.
 *  - flip: a repaint where everything that stays put animates from where it
 *    was, and anything new opens out.
 *  - settle: a small scale from 0.96 to 1, for a tap that sets something.
 *
 * Nothing here runs on import.
 */

import { prefersReducedMotion } from "./motion";

/** The token values, for when styles aren't there to read (tests, a detached document). */
export const MOTION_FALLBACK = {
  "--dur-fast": 200,
  "--dur-base": 320,
  "--dur-hold": 600,
} as const;

export type DurationToken = keyof typeof MOTION_FALLBACK;

/** "320ms" → 320, "0.8s" → 800. Anything else gives the fallback. */
export function parseDuration(value: string | null | undefined, fallback: number): number {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/i.exec(value ?? "");
  if (!m) return fallback;
  const n = Number(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A duration token in ms, read from the page's styles. */
export function dur(name: DurationToken): number {
  if (typeof document === "undefined") return MOTION_FALLBACK[name];
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(name), MOTION_FALLBACK[name]);
}

const EASE_FALLBACK = {
  "--ease-out": "cubic-bezier(0.25, 1, 0.5, 1)",
  "--ease-out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
  "--ease-in": "cubic-bezier(0.7, 0, 0.84, 0)",
} as const;

/** An easing token, read from the page's styles. */
export function ease(name: keyof typeof EASE_FALLBACK): string {
  if (typeof document === "undefined") return EASE_FALLBACK[name];
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || EASE_FALLBACK[name];
}

/**
 * When each part of finishing a to-do starts, in ms from the tap. The check
 * lands (--dur-fast), the row rests ticked (--dur-hold), then folds away
 * (--dur-base); an emptied group's heading follows halfway through the fold.
 * Reduced motion: nothing waits.
 */
export function finishPlan(opts: { fast: number; hold: number; base: number; lastInGroup: boolean; reduced: boolean }) {
  if (opts.reduced) return { collapseAt: 0, groupAt: null as number | null, doneAt: 0 };
  const collapseAt = Math.max(opts.fast, opts.hold);
  const groupAt = opts.lastInGroup ? collapseAt + Math.round(opts.base / 2) : null;
  const doneAt = groupAt === null ? collapseAt + opts.base : groupAt + opts.base;
  return { collapseAt, groupAt, doneAt };
}

/**
 * What a repaint did to a keyed list: how far each element that stayed moved
 * (old top minus new top, so it can be drawn back where it was), and which
 * keys are new. Moves under half a pixel don't count.
 */
export function flipDeltas(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): { moved: Map<string, number>; entered: string[] } {
  const moved = new Map<string, number>();
  const entered: string[] = [];
  for (const [key, top] of after) {
    const was = before.get(key);
    if (was === undefined) entered.push(key);
    else if (Math.abs(was - top) >= 0.5) moved.set(key, was - top);
  }
  return { moved, entered };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export { wait as motionWait };

function done(a: Animation): Promise<void> {
  return a.finished.then(
    () => undefined,
    () => undefined
  );
}

/**
 * An element's look when folded away: no height, padding or opacity. In a
 * flex or grid parent with a gap, a negative margin takes up the gap as well,
 * so the gap doesn't vanish in one frame when the element is finally removed.
 */
function foldedStyle(el: HTMLElement): Record<string, string> {
  const folded: Record<string, string> = { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", opacity: "0" };
  const parent = el.parentElement;
  if (!parent) return folded;
  const pcs = getComputedStyle(parent);
  const stacked = pcs.display.includes("grid") || (pcs.display.includes("flex") && pcs.flexDirection.startsWith("column"));
  const gap = stacked ? parseFloat(pcs.rowGap) || 0 : 0;
  if (gap) {
    if (el.previousElementSibling) folded.marginTop = `${-gap}px`;
    else if (el.nextElementSibling) folded.marginBottom = `${-gap}px`;
  }
  return folded;
}

function openStyle(el: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(el);
  return {
    height: `${el.getBoundingClientRect().height}px`,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    opacity: cs.opacity,
  };
}

/**
 * Fold an element's height away (with its padding and margins) and fade it.
 * It stays folded, at zero height, until something removes or expands it.
 */
export async function collapse(el: HTMLElement, opts: { duration?: number; easing?: string } = {}): Promise<void> {
  const from = openStyle(el);
  const to = foldedStyle(el);
  el.dataset.folded = "";
  el.style.overflow = "hidden";
  if (!prefersReducedMotion() && el.isConnected) {
    const a = el.animate([from, to], { duration: opts.duration ?? dur("--dur-base"), easing: opts.easing ?? ease("--ease-out") });
    await done(a);
  }
  Object.assign(el.style, to);
}

/** The reverse of collapse: open an element out from nothing to its own height. */
export async function expand(el: HTMLElement, opts: { duration?: number; easing?: string } = {}): Promise<void> {
  // Back to its natural size, measured, then drawn from zero.
  for (const p of ["height", "paddingTop", "paddingBottom", "marginTop", "marginBottom", "opacity"] as const) el.style[p] = "";
  delete el.dataset.folded;
  if (prefersReducedMotion() || !el.isConnected) {
    el.style.overflow = "";
    return;
  }
  const to = openStyle(el);
  const from = foldedStyle(el);
  el.style.overflow = "hidden";
  el.classList.add("is-unfolding");
  await done(el.animate([from, to], { duration: opts.duration ?? dur("--dur-base"), easing: opts.easing ?? ease("--ease-out") }));
  el.classList.remove("is-unfolding");
  el.style.overflow = "";
}

/** Restart the shared settle (styles/components.css, .is-landing) on an element. */
export function settle(el: Element | null | undefined): void {
  if (!el) return;
  el.classList.remove("is-landing");
  // Read layout so the class coming back starts the animation again.
  void (el as HTMLElement).offsetWidth;
  el.classList.add("is-landing");
  const end = (e: Event) => {
    if (e.target !== el) return;
    el.classList.remove("is-landing");
    el.removeEventListener("animationend", end);
  };
  el.addEventListener("animationend", end);
}

/** Tops of every [data-flip] element under root, by key. */
function measure(root: HTMLElement): Map<string, number> {
  const tops = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    if (el.dataset.folded === undefined) tops.set(el.dataset.flip!, el.getBoundingClientRect().top);
  });
  return tops;
}

/**
 * Repaint a list so nothing jumps. Elements keyed with data-flip that stay
 * slide from where they were; new ones (when `enter` is set) open out, and
 * a new element inside another new one rides along with its parent.
 */
export function flip(root: HTMLElement, mutate: () => void, opts: { enter?: boolean } = {}): void {
  if (prefersReducedMotion()) {
    mutate();
    return;
  }
  const before = measure(root);
  mutate();
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => els.set(el.dataset.flip!, el));
  // New elements are measured at zero height, so the slide of what's below
  // them and their opening out don't add up to twice the distance.
  const entering = opts.enter ? [...els].filter(([k]) => !before.has(k)).map(([, el]) => el) : [];
  const outer = entering.filter((el) => !entering.some((other) => other !== el && other.contains(el)));
  for (const el of outer) {
    el.dataset.folded = "";
    Object.assign(el.style, foldedStyle(el), { overflow: "hidden" });
  }
  const after = measure(root);
  for (const el of entering) el.classList.add("is-unfolding");
  const { moved } = flipDeltas(before, after);
  const duration = dur("--dur-base");
  const easing = ease("--ease-out");
  for (const [key, dy] of moved) {
    const el = els.get(key);
    if (!el) continue;
    // A child rides on its keyed parent's slide; it only adds its own difference.
    const parent = el.parentElement?.closest<HTMLElement>("[data-flip]");
    const rel = dy - (parent && root.contains(parent) ? moved.get(parent.dataset.flip!) ?? 0 : 0);
    if (Math.abs(rel) < 0.5) continue;
    el.animate([{ transform: `translateY(${rel}px)` }, { transform: "none" }], { duration, easing });
  }
  for (const el of outer) void expand(el);
  for (const el of entering) if (!outer.includes(el)) el.classList.remove("is-unfolding");
}

type Listens = { addEventListener(type: string, fn: (e: Event) => void): void; removeEventListener(type: string, fn: (e: Event) => void): void };

/**
 * Saves still waiting on their motion (a ticked to-do resting or folding).
 * If the page is hidden or closed first (a phone backgrounding the app
 * freezes timers), every waiting save runs at once and the rest of the
 * motion is skipped. The listeners are only attached while something is
 * waiting, and come off again once nothing is.
 */
export function pendingFinishes(win: Listens, doc: Listens & { visibilityState: string }) {
  const waiting = new Set<() => void>();
  const onHidden = () => {
    if (doc.visibilityState === "hidden") flushAll();
  };
  const attach = () => {
    doc.addEventListener("visibilitychange", onHidden);
    win.addEventListener("pagehide", flushAll);
  };
  const detach = () => {
    doc.removeEventListener("visibilitychange", onHidden);
    win.removeEventListener("pagehide", flushAll);
  };
  function remove(fn: () => void) {
    if (waiting.delete(fn) && !waiting.size) detach();
  }
  function flushAll() {
    const all = [...waiting];
    waiting.clear();
    detach();
    for (const fn of all) fn();
  }
  return {
    /** Wait to save; returns a function that drops it (cancelled, or saved by the motion). */
    add(fn: () => void): () => void {
      if (!waiting.size) attach();
      waiting.add(fn);
      return () => remove(fn);
    },
    flushAll,
    get size() {
      return waiting.size;
    },
  };
}

let shared: ReturnType<typeof pendingFinishes> | null = null;
/** The page's one registry, made on first use (never on import). */
export function finishQueue(): ReturnType<typeof pendingFinishes> {
  return (shared ??= pendingFinishes(window, document));
}
