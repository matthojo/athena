/**
 * The mode switcher: a small floating Mention · Link · Card · Embed bar that
 * appears over a link when it's clicked or just pasted. Tab and the arrow keys
 * move along it (wrapping round), Enter or Space picks, Esc closes and puts
 * focus back on the link. Only one is ever open.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { MODE_ICON, MODE_LABEL, switcherChoices, type LinkMode, type LinkTarget } from "./link-model";
import { spring } from "./link-motion";

export interface Switcher {
  el: HTMLElement;
  /** Point it at the element now standing for the link (after a mode change). */
  retarget(anchor: HTMLElement, mode: LinkMode): void;
  close(opts?: { restoreFocus?: boolean }): void;
}

let open: Switcher | null = null;

export const closeSwitcher = (restoreFocus = false) => open?.close({ restoreFocus });
export const switcherOpen = () => open;

export interface SwitcherOptions {
  focus?: boolean;
  reason?: "paste" | "menu";
  /** For "Pasted a YouTube link". */
  provider?: string | null;
  /** Called once when it closes. */
  onClose?: () => void;
}

export function openSwitcher(anchor: HTMLElement, link: LinkTarget, title: string, mode: LinkMode, onPick: (m: LinkMode) => void, opts: SwitcherOptions = {}): Switcher {
  open?.close();
  let target = anchor;
  let current = mode;

  const thumb = h("span", { class: "rl-switch__thumb", "aria-hidden": "true" });
  const buttons = switcherChoices(link).map(({ mode: m, enabled: ok, reason }) => {
    const b = h(
      "button",
      {
        type: "button",
        class: "rl-switch__opt",
        "data-mode": m,
        "aria-pressed": String(m === current),
        "aria-disabled": ok ? undefined : "true",
        title: ok ? undefined : reason,
        tabindex: "-1",
      },
      icons[MODE_ICON[m]](),
      h("span", {}, MODE_LABEL[m])
    );
    // Keep the editor's focus and selection while the pointer is down.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!ok || m === current) return;
      onPick(m);
    });
    return b;
  });

  const hint = opts.reason === "paste" ? h("span", { class: "rl-switch__hint" }, opts.provider ? `Pasted ${/^[AEIOU]/.test(opts.provider) ? "an" : "a"} ${opts.provider} link` : "Pasted a link") : null;
  const el = h("div", { class: "rl-switch", role: "toolbar", "aria-label": `Show “${title}” as`, "aria-orientation": "horizontal" }, hint, h("div", { class: "rl-switch__track" }, thumb, ...buttons));
  const s = spring();
  el.style.setProperty("--rl-spring", s.easing);
  el.style.setProperty("--rl-spring-dur", `${s.duration}ms`);

  const enabled = () => buttons.filter((b) => b.getAttribute("aria-disabled") !== "true");
  const active = () => buttons.find((b) => b.dataset.mode === current)!;

  function placeThumb(animate: boolean) {
    const b = active();
    if (!animate) thumb.style.transition = "none";
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
    if (!animate) {
      void thumb.offsetWidth;
      thumb.style.transition = "";
    }
  }

  function place() {
    if (!target.isConnected) return;
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 10;
    // Over a pill or a short line: centred on it. Over a card: its top-left, like a toolbar.
    const block = r.height > 60;
    let left = block ? r.left : r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.top - hgt - gap;
    let below = false;
    if (top < 8) {
      top = block ? Math.max(8, r.top + gap) : r.bottom + gap;
      below = !block;
    }
    top = Math.min(top, vh - hgt - 8);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.side = below ? "below" : "above";
  }

  function keydown(e: KeyboardEvent) {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Tab" || e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const back = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey);
      const next = list[(Math.max(i, 0) + (back ? list.length - 1 : 1)) % list.length];
      next.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? list[0] : list[list.length - 1]).focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      api.close({ restoreFocus: true });
    } else if (e.key === "Enter" || e.key === " ") {
      // Enter or Space picks the focused option (buttons do this, but keep it inside the bar).
      e.stopPropagation();
    }
  }

  function outside(e: PointerEvent) {
    const t = e.target as Node;
    if (el.contains(t) || target.contains(t)) return;
    api.close();
  }

  const reflow = () => place();
  el.addEventListener("keydown", keydown);
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("scroll", reflow, true);
  window.addEventListener("resize", reflow);

  const api: Switcher = {
    el,
    retarget(next, mode) {
      target = next;
      target.classList.add("is-selected");
      current = mode;
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.mode === current));
      placeThumb(true);
      requestAnimationFrame(place);
      // Keep following the link while it settles into its new shape.
      const until = performance.now() + 700;
      const follow = () => {
        if (open !== api) return;
        place();
        if (performance.now() < until) requestAnimationFrame(follow);
      };
      requestAnimationFrame(follow);
    },
    close({ restoreFocus = false } = {}) {
      if (open !== api) return;
      open = null;
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", reflow, true);
      window.removeEventListener("resize", reflow);
      target.classList.remove("is-selected");
      // A link drawn again while this was open (its title arrived) carried the ring over.
      for (const n of document.querySelectorAll(".rl-node.is-selected")) if (!n.closest(".ProseMirror-selectednode")) n.classList.remove("is-selected");
      el.classList.add("is-leaving");
      const done = () => el.remove();
      el.addEventListener("animationend", done, { once: true });
      setTimeout(done, 260);
      if (restoreFocus && target.isConnected) target.focus({ preventScroll: true });
      opts.onClose?.();
    },
  };

  (anchor.closest("dialog[open]") ?? document.body).append(el);
  open = api;
  target.classList.add("is-selected");
  place();
  placeThumb(false);
  if (opts.focus !== false) active().focus({ preventScroll: true });
  return api;
}
