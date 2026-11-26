/**
 * Spring motion for rich links: an easing
 * curve sampled from a damped spring (CSS linear()), and a shared-element
 * morph so a pill can grow into a card and a card can fold back into a pill.
 */

import { prefersReducedMotion } from "../lib/motion";

/** Sample a damped spring into a CSS linear() easing. Stiffness and damping as in most spring APIs (mass 1). */
export function springEasing(stiffness = 260, damping = 24, points = 48): { easing: string; duration: number } {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const at = (t: number) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  };
  // Settle when within 0.1% and staying there.
  let end = 0.1;
  while (end < 3 && Math.abs(1 - at(end)) > 0.001) end += 0.02;
  const stops: string[] = [];
  for (let i = 0; i <= points; i++) stops.push(at((i / points) * end).toFixed(4));
  stops[stops.length - 1] = "1";
  return { easing: `linear(${stops.join(", ")})`, duration: Math.round(end * 1000) };
}

let cached: { easing: string; duration: number } | null = null;

/** The one spring, falling back to ease-out-expo where linear() isn't understood. */
export function spring(): { easing: string; duration: number } {
  if (cached) return cached;
  const s = springEasing();
  const ok = typeof CSS !== "undefined" && CSS.supports("transition-timing-function", s.easing);
  cached = ok ? s : { easing: "cubic-bezier(0.16, 1, 0.3, 1)", duration: 480 };
  return cached;
}

const radius = (el: Element) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;

/**
 * Replace `from` with whatever `swap` draws (the editor redraws the link in
 * its new mode and returns the new element), animating between them: the new
 * element opens out from where the old one was, while a ghost of the old one
 * travels to the new spot and fades. With reduced motion it's a quick fade.
 */
export function morph(from: HTMLElement, swap: () => HTMLElement | null): void {
  if (prefersReducedMotion() || !from.isConnected || typeof from.animate !== "function") {
    const to = swap();
    if (!to || !prefersReducedMotion() || typeof to.animate !== "function") return;
    to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "linear" });
    return;
  }
  const o = from.getBoundingClientRect();
  const ro = radius(from);
  const ghost = from.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.removeAttribute("tabindex");
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.remove("is-selected");
  ghost.classList.add("rl-ghost");
  Object.assign(ghost.style, { position: "fixed", left: `${o.left}px`, top: `${o.top}px`, width: `${o.width}px`, height: `${o.height}px`, margin: "0", zIndex: "350", pointerEvents: "none" });

  const host = from.closest("dialog[open]") ?? document.body;
  const to = swap();
  if (!to || !to.isConnected) return;
  const n = to.getBoundingClientRect();
  const rn = radius(to);
  host.append(ghost);

  const { easing, duration } = spring();
  const grow = n.width * n.height >= o.width * o.height;
  const dx = o.left - n.left;
  const dy = o.top - n.top;

  to.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0px ${Math.max(0, n.width - o.width)}px ${Math.max(0, n.height - o.height)}px 0px round ${ro}px)` },
      { transform: "translate(0, 0)", clipPath: `inset(0px 0px 0px 0px round ${rn}px)` },
    ],
    { duration, easing }
  );
  to.animate([{ opacity: grow ? 0.2 : 0 }, { opacity: 1 }], { duration: grow ? duration * 0.5 : duration * 0.7, easing: "ease-out" });

  const out = ghost.animate(
    [
      { transform: "translate(0, 0)", clipPath: `inset(0px 0px 0px 0px round ${ro}px)`, opacity: 1 },
      { transform: `translate(${-dx}px, ${-dy}px)`, clipPath: `inset(0px ${Math.max(0, o.width - n.width)}px ${Math.max(0, o.height - n.height)}px 0px round ${rn}px)`, opacity: 0 },
    ],
    { duration: grow ? duration * 0.45 : duration * 0.8, easing, fill: "forwards" }
  );
  out.onfinish = () => ghost.remove();
  out.oncancel = () => ghost.remove();
}
