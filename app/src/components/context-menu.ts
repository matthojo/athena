/**
 * Context menu: one menu for the whole app, opened on whatever was pressed.
 *
 *   right-click            a menu at the pointer (desk)
 *   press and hold 450ms   the preview lifts over a blurred, dimmed page with
 *                          the actions below it (phone), with a light haptic
 *   Shift+F10 / menu key   the same menu under the focused thing (keyboard)
 *
 * A menu is a preview element plus groups of entries. An entry is an action
 * (label, icon, shortcut hint, destructive, disabled with a reason, or a
 * submenu) or an inline segmented choice. Keys: arrows move, Enter or Space
 * picks, Esc goes back or closes, typing jumps to a label, Tab stays inside.
 * Focus goes back to the pressed thing on close.
 *
 * `attachContextMenu(scope, …)` wires the gestures onto everything in a scope
 * that `target()` accepts; `openContextMenu()` opens one directly; and
 * `staticContextMenu()` draws one, inert, for galleries and docs.
 */

import { h } from "../lib/dom";
import { prefersReducedMotion } from "../lib/motion";
import { icons, type IconName } from "./icons";
import "../styles/context-menu.css";

export interface MenuAction {
  kind?: "action";
  id: string;
  label: string;
  icon?: IconName;
  /** Shown on the right on a desk, e.g. "⌘C". A hint only: the menu doesn't listen for it. */
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** A second line under the label, e.g. why it's disabled. */
  hint?: string;
  run?: () => void;
  submenu?: MenuGroup[];
}

export interface MenuChoiceOption<V extends string = string> {
  value: V;
  label: string;
  icon?: IconName;
  disabled?: boolean;
}

/** A row of options, one picked, like "Show as: Mention · Link · Card". */
export interface MenuChoice<V extends string = string> {
  kind: "choice";
  id: string;
  label: string;
  value: V;
  options: MenuChoiceOption<V>[];
  choose: (value: V) => void;
}

export type MenuEntry = MenuAction | MenuChoice;
export type MenuGroup = MenuEntry[];

export interface ContextMenuSpec {
  /** Accessible name of the menu, e.g. "Priya Shah". */
  label: string;
  groups: MenuGroup[];
  /** What the menu is about. Lifts over the page on a phone; sits beside the menu on a desk. */
  preview?: HTMLElement | null;
}

export type OpenedBy = "mouse" | "touch" | "keyboard";
export type MenuLayout = "popover" | "lift";

export interface OpenOptions {
  /** The pressed thing. Focus goes back to it, and the lift starts from it. */
  anchor: HTMLElement;
  by: OpenedBy;
  /** The pointer, for a right-click. Without it the menu sits under the anchor. */
  at?: { x: number; y: number };
  layout?: MenuLayout;
  onClose?: () => void;
}

export interface ContextMenuHandle {
  el: HTMLElement;
  layout: MenuLayout;
  close(opts?: { restoreFocus?: boolean }): void;
}

// ---------- Building the panel ----------

type Info = { action?: MenuAction; choice?: MenuChoice; value?: string; back?: boolean };
const infoOf = new WeakMap<HTMLElement, Info>();

interface Panel {
  el: HTMLElement;
  /** Focus stops, top to bottom. A choice is one row with several stops. */
  rows: HTMLElement[][];
  parentItem?: HTMLElement;
}

let uid = 0;

const ico = (name: IconName, cls = "cm-ico") => {
  const s = icons[name]();
  s.classList.add(...cls.split(" "));
  s.setAttribute("aria-hidden", "true");
  return s;
};

function buildPanel(groups: MenuGroup[], label: string, back?: string): Panel {
  const el = h("div", { class: "cm-menu", role: "menu", "aria-label": label, tabindex: "-1", id: `cm-${++uid}` });
  const rows: HTMLElement[][] = [];
  if (back) {
    const b = h("div", { class: "cm-item cm-item--back", role: "menuitem", tabindex: "-1" }, ico("back"), h("span", { class: "cm-item__text" }, h("span", { class: "cm-item__label" }, back)));
    infoOf.set(b, { back: true });
    rows.push([b]);
    el.append(b, h("div", { class: "cm-sep", role: "separator" }));
  }
  groups
    .filter((g) => g.length)
    .forEach((g, gi) => {
      if (gi) el.append(h("div", { class: "cm-sep", role: "separator" }));
      const group = h("div", { class: "cm-group", role: "group" });
      for (const entry of g) {
        if (entry.kind === "choice") {
          const opts = entry.options.map((o) => {
            const on = o.value === entry.value;
            const opt = h(
              "div",
              {
                class: "cm-seg__opt",
                role: "menuitemradio",
                tabindex: "-1",
                "aria-checked": String(on),
                "aria-disabled": o.disabled ? "true" : undefined,
                "data-cm-value": o.value,
              },
              o.icon ? ico(o.icon) : null,
              h("span", { class: "cm-seg__label" }, o.label)
            );
            infoOf.set(opt, { choice: entry, value: o.value });
            return opt;
          });
          group.append(h("div", { class: "cm-choice", role: "group", "aria-label": entry.label, "data-cm-id": entry.id }, h("div", { class: "cm-choice__label", "aria-hidden": "true" }, entry.label), h("div", { class: "cm-seg" }, ...opts)));
          rows.push(opts);
        } else {
          const a = entry;
          const item = h(
            "div",
            {
              class: `cm-item${a.destructive ? " cm-item--danger" : ""}`,
              role: "menuitem",
              tabindex: "-1",
              "data-cm-id": a.id,
              "aria-disabled": a.disabled ? "true" : undefined,
              "aria-haspopup": a.submenu ? "menu" : undefined,
              "aria-expanded": a.submenu ? "false" : undefined,
            },
            a.icon ? ico(a.icon) : h("span", { class: "cm-ico cm-ico--blank" }),
            h("span", { class: "cm-item__text" }, h("span", { class: "cm-item__label" }, a.label), a.hint ? h("span", { class: "cm-item__hint" }, a.hint) : null),
            a.shortcut && !a.submenu ? h("kbd", { class: "cm-item__kbd", "aria-hidden": "true" }, a.shortcut) : null,
            a.submenu ? ico("chevronRight", "cm-ico cm-item__chev") : null
          );
          infoOf.set(item, { action: a });
          group.append(item);
          rows.push([item]);
        }
      }
      el.append(group);
    });
  return { el, rows };
}

const labelOf = (el: HTMLElement) => (el.querySelector(".cm-item__label, .cm-seg__label")?.textContent ?? "").toLowerCase();
const isOff = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

// ---------- Opening ----------

let current: (ContextMenuHandle & { anchor: HTMLElement }) | null = null;

export const contextMenuOpen = () => !!current;
export const closeContextMenu = (restoreFocus = false) => current?.close({ restoreFocus });

const coarse = () => window.matchMedia("(pointer: coarse)").matches;

function springVars(): { easing: string; duration: number } {
  const cs = getComputedStyle(document.documentElement);
  const easing = cs.getPropertyValue("--cm-spring").trim() || "cubic-bezier(0.16, 1, 0.3, 1)";
  const duration = parseFloat(cs.getPropertyValue("--cm-spring-dur")) || 480;
  return { easing, duration };
}

export function openContextMenu(spec: ContextMenuSpec, opts: OpenOptions): ContextMenuHandle {
  current?.close();
  const { anchor, by } = opts;
  const layout: MenuLayout = opts.layout ?? (by === "touch" || (by === "keyboard" && (coarse() || window.innerWidth < 640)) ? "lift" : "popover");
  const reduce = prefersReducedMotion();

  const backdrop = h("div", { class: "cm-backdrop", "aria-hidden": "true" });
  const layer = h("div", { class: `cm-layer cm-layer--${layout}`, "data-by": by });
  const root = buildPanel(spec.groups, spec.label);
  const panels: Panel[] = [root];
  const top = () => panels[panels.length - 1];

  let preview: HTMLElement | null = null;
  if (spec.preview) {
    preview = h("div", { class: "cm-preview", "aria-hidden": "true" }, spec.preview);
  }

  let stack: HTMLElement | null = null;
  if (layout === "lift") {
    stack = h("div", { class: "cm-stack" }, preview, root.el);
    layer.append(backdrop, stack);
  } else {
    layer.append(backdrop, ...(preview ? [preview] : []), root.el);
  }
  // Inside an open <dialog> (a note in a sheet), so it stays above its top layer.
  (opts.anchor.closest("dialog[open]") ?? document.body).append(layer);
  anchor.classList.add("cm-anchor");

  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const pad = layout === "lift" ? 16 : 8;
  const ar = anchor.getBoundingClientRect();

  // ---------- Place ----------
  if (layout === "popover") {
    const m = root.el;
    const w = m.offsetWidth;
    const hgt = m.offsetHeight;
    let left: number;
    let topY: number;
    let ox = "left";
    let oy = "top";
    if (opts.at) {
      left = opts.at.x + 2;
      topY = opts.at.y + 2;
      if (left + w > vw - pad) {
        left = opts.at.x - w - 2;
        ox = "right";
      }
      if (topY + hgt > vh - pad) {
        topY = opts.at.y - hgt - 2;
        oy = "bottom";
      }
    } else {
      left = ar.left;
      topY = Math.min(ar.bottom, vh - pad) + 6;
      if (topY + hgt > vh - pad) {
        topY = Math.max(ar.top, pad) - hgt - 6;
        oy = "bottom";
      }
    }
    left = Math.max(pad, Math.min(left, vw - w - pad));
    topY = Math.max(pad, Math.min(topY, vh - hgt - pad));
    Object.assign(m.style, { left: `${Math.round(left)}px`, top: `${Math.round(topY)}px`, transformOrigin: `${ox} ${oy}` });

    // The preview goes beside the menu where there's room, and is left out where there isn't.
    if (preview) {
      const pw = preview.offsetWidth;
      const ph = preview.offsetHeight;
      const gap = 12;
      let px: number | null = null;
      if (ox === "left" && left + w + gap + pw <= vw - pad) px = left + w + gap;
      else if (left - gap - pw >= pad) px = left - gap - pw;
      else if (left + w + gap + pw <= vw - pad) px = left + w + gap;
      if (px === null || ph > vh - 2 * pad) preview.remove();
      else {
        const py = Math.max(pad, Math.min(topY, vh - ph - pad));
        Object.assign(preview.style, { left: `${Math.round(px)}px`, top: `${Math.round(py)}px`, transformOrigin: px > left ? "left top" : "right top" });
      }
    }
  } else if (stack) {
    // Preview where the pressed thing was (as near as fits), actions below it.
    const sw = Math.min(360, vw - 2 * pad);
    stack.style.width = `${sw}px`;
    const side = ar.left + ar.width / 2 > vw / 2 ? "end" : "start";
    stack.dataset.align = side;
    let sh = stack.offsetHeight;
    if (preview && sh > vh - 2 * pad) {
      const room = vh - 2 * pad - root.el.offsetHeight - 12;
      if (room < 96) preview.remove();
      else preview.style.maxHeight = `${Math.floor(room)}px`;
      sh = stack.offsetHeight;
    }
    const sx = Math.max(pad, Math.min(ar.left + ar.width / 2 - sw / 2, vw - sw - pad));
    const sy = Math.max(pad, Math.min(ar.top - 6, vh - sh - pad));
    Object.assign(stack.style, { left: `${Math.round(sx)}px`, top: `${Math.round(sy)}px` });
    root.el.style.transformOrigin = `${side === "end" ? "right" : "left"} top`;
  }

  // ---------- Motion in ----------
  if (!reduce && typeof layer.animate === "function") {
    const s = springVars();
    if (layout === "lift" && preview?.isConnected) {
      const pr = preview.getBoundingClientRect();
      const dx = ar.left + ar.width / 2 - (pr.left + pr.width / 2);
      const dy = ar.top + ar.height / 2 - (pr.top + pr.height / 2);
      const sc = Math.max(0.35, Math.min(1, ar.width / pr.width));
      preview.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sc})`, opacity: 0.3 }, { transform: "none", opacity: 1 }], { duration: s.duration, easing: s.easing });
    }
    root.el.animate(
      [
        { transform: layout === "lift" ? "translateY(-10px) scale(0.82)" : "scale(0.94)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: s.duration, easing: s.easing, delay: layout === "lift" ? 50 : 0, fill: "backwards" }
    );
    root.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear", delay: layout === "lift" ? 50 : 0, fill: "backwards" });
  }

  // ---------- Focus and keys ----------
  const posOf = (el: Element | null) => {
    const p = top();
    for (let r = 0; r < p.rows.length; r++) {
      const c = p.rows[r].indexOf(el as HTMLElement);
      if (c >= 0) return { r, c };
    }
    return { r: -1, c: -1 };
  };

  const focusRow = (r: number) => {
    const p = top();
    const n = p.rows.length;
    if (!n) return;
    const row = p.rows[((r % n) + n) % n];
    const pick = row.length > 1 ? (row.find((o) => o.getAttribute("aria-checked") === "true" && !isOff(o)) ?? row.find((o) => !isOff(o)) ?? row[0]) : row[0];
    pick.focus({ preventScroll: false });
  };

  let typed = "";
  let typedAt = 0;
  const typeahead = (ch: string) => {
    const now = performance.now();
    typed = now - typedAt > 600 ? ch : typed + ch;
    typedAt = now;
    const p = top();
    const flat = p.rows.flat();
    const from = flat.indexOf(document.activeElement as HTMLElement);
    // A new letter looks past the current item; more letters keep refining from it.
    const startAt = typed.length > 1 ? Math.max(from, 0) : from + 1;
    for (let i = 0; i < flat.length; i++) {
      const el = flat[(startAt + i) % flat.length];
      if (labelOf(el).startsWith(typed)) {
        el.focus();
        return;
      }
    }
  };

  let subTimer: ReturnType<typeof setTimeout> | undefined;

  function openSub(item: HTMLElement, focusFirst: boolean) {
    const a = infoOf.get(item)?.action;
    if (!a?.submenu || isOff(item)) return;
    if (top().parentItem === item) {
      if (focusFirst) focusRow(0);
      return;
    }
    if (panels.length > 1) closeSub(false);
    const sub = buildPanel(a.submenu, a.label, layout === "lift" ? a.label : undefined);
    sub.parentItem = item;
    sub.el.classList.add("cm-menu--sub");
    item.setAttribute("aria-expanded", "true");
    item.setAttribute("aria-controls", sub.el.id);
    panels.push(sub);
    layer.classList.add("has-sub");
    if (layout === "lift" && stack) {
      root.el.hidden = true;
      stack.append(sub.el);
      sub.el.style.transformOrigin = root.el.style.transformOrigin;
    } else {
      layer.append(sub.el);
      const r = item.getBoundingClientRect();
      const pr = root.el.getBoundingClientRect();
      const w = sub.el.offsetWidth;
      const hgt = sub.el.offsetHeight;
      let left = pr.right - 4;
      let origin = "left";
      if (left + w > vw - pad) {
        left = pr.left - w + 4;
        origin = "right";
      }
      const topY = Math.max(pad, Math.min(r.top - 5, vh - hgt - pad));
      Object.assign(sub.el.style, { left: `${Math.round(left)}px`, top: `${Math.round(topY)}px`, transformOrigin: `${origin} top` });
    }
    if (!reduce && typeof sub.el.animate === "function") {
      const s = springVars();
      sub.el.animate([{ transform: layout === "lift" ? "translateX(12px)" : "scale(0.96)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: s.duration * 0.8, easing: s.easing });
    }
    if (focusFirst) focusRow(0);
  }

  function closeSub(refocus = true) {
    if (panels.length < 2) return;
    const sub = panels.pop()!;
    sub.el.remove();
    sub.parentItem?.setAttribute("aria-expanded", "false");
    sub.parentItem?.removeAttribute("aria-controls");
    root.el.hidden = false;
    layer.classList.remove("has-sub");
    if (refocus) sub.parentItem?.focus();
  }

  function activate(el: HTMLElement) {
    const info = infoOf.get(el);
    if (!info) return;
    if (info.back) return closeSub();
    if (isOff(el)) return;
    if (info.choice) {
      const { choice, value } = info;
      api.close({ restoreFocus: true });
      if (value !== choice.value) choice.choose(value!);
      return;
    }
    const a = info.action!;
    if (a.submenu) return openSub(el, true);
    api.close({ restoreFocus: true });
    a.run?.();
  }

  layer.addEventListener("keydown", (e) => {
    const active = document.activeElement as HTMLElement | null;
    const { r, c } = posOf(active);
    const row = r >= 0 ? top().rows[r] : null;
    const last = top().rows.length - 1;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        focusRow(r < 0 ? 0 : r + 1);
        break;
      case "ArrowUp":
        focusRow(r < 0 ? last : r - 1);
        break;
      case "Tab":
        focusRow(r < 0 ? (e.shiftKey ? last : 0) : r + (e.shiftKey ? -1 : 1));
        break;
      case "Home":
      case "PageUp":
        focusRow(0);
        break;
      case "End":
      case "PageDown":
        focusRow(last);
        break;
      case "ArrowRight":
        if (row && row.length > 1) {
          const opts = row.filter((o) => !isOff(o) || o === active);
          const i = opts.indexOf(active!);
          opts[Math.min(i + 1, opts.length - 1)]?.focus();
        } else if (active && infoOf.get(active)?.action?.submenu) openSub(active, true);
        break;
      case "ArrowLeft":
        if (row && row.length > 1) {
          const opts = row.filter((o) => !isOff(o) || o === active);
          const i = opts.indexOf(active!);
          opts[Math.max(i - 1, 0)]?.focus();
        } else if (panels.length > 1) closeSub();
        break;
      case "Enter":
      case " ":
        if (active && r >= 0) activate(active);
        else if (e.key === "Enter") focusRow(0);
        break;
      case "Escape":
        if (panels.length > 1) closeSub();
        else api.close({ restoreFocus: true });
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /\S/.test(e.key)) typeahead(e.key.toLowerCase());
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ---------- Pointer ----------
  const stopOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".cm-item, .cm-seg__opt") : null);

  layer.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const stop = stopOf(e.target);
    if (!stop || document.activeElement === stop) return;
    const inRoot = root.el.contains(stop);
    if (panels.length > 1 && inRoot && stop !== top().parentItem) {
      clearTimeout(subTimer);
      subTimer = setTimeout(() => closeSub(false), 180);
    }
    if (panels.length > 1 && !inRoot) clearTimeout(subTimer);
    stop.focus({ preventScroll: true });
    if (infoOf.get(stop)?.action?.submenu && layout === "popover" && top().parentItem !== stop) {
      clearTimeout(subTimer);
      subTimer = setTimeout(() => openSub(stop, false), 140);
    }
  });

  layer.addEventListener("click", (e) => {
    const stop = stopOf(e.target);
    if (stop) {
      e.preventDefault();
      activate(stop);
    }
  });

  backdrop.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    api.close({ restoreFocus: by === "keyboard" });
  });
  layer.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!stopOf(e.target) && !(e.target as Element).closest(".cm-menu")) api.close();
  });
  layer.addEventListener("wheel", (e) => !(e.target as Element).closest(".cm-menu") && e.preventDefault(), { passive: false });

  const onScroll = (e: Event) => {
    if (layout === "popover" && !(e.target instanceof Node && layer.contains(e.target))) api.close();
  };
  const onResize = () => api.close();
  const onBlur = () => layout === "popover" && api.close();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onBlur);

  const api: ContextMenuHandle & { anchor: HTMLElement } = {
    el: layer,
    layout,
    anchor,
    close({ restoreFocus = false } = {}) {
      if (current !== api) return;
      current = null;
      clearTimeout(subTimer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      anchor.classList.remove("cm-anchor");
      layer.classList.add("is-leaving");
      layer.style.pointerEvents = "none";
      const done = () => layer.remove();
      layer.addEventListener("animationend", (e) => e.target === layer && done());
      setTimeout(done, 220);
      if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
      opts.onClose?.();
    },
  };
  current = api;

  // Keyboard: first action. Pointer: the menu itself, so nothing looks picked yet.
  if (by === "keyboard") focusRow(0);
  else root.el.focus({ preventScroll: true });
  return api;
}

// ---------- Gestures ----------

export interface AttachOptions {
  /** The thing a menu is for, from an event target inside the scope (or null for none). */
  target: (el: Element) => HTMLElement | null;
  /** The menu for that thing, or null to let the browser have it. */
  build: (target: HTMLElement, by: OpenedBy) => ContextMenuSpec | null;
  /** Called just before a menu opens, e.g. to close a peek. */
  onOpen?: (target: HTMLElement) => void;
  /** Long-press delay on touch. */
  holdMs?: number;
}

/**
 * Right-click, long-press and Shift+F10 / the menu key on anything in `scope`
 * that `target()` accepts. The click that ends a long press is swallowed so
 * the thing doesn't also get tapped.
 */
export function attachContextMenu(scope: HTMLElement, o: AttachOptions): { destroy: () => void } {
  const holdMs = o.holdMs ?? 450;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number; t: HTMLElement } | null = null;
  let lastTouch = -Infinity;
  let pressed = false;
  let keyOpenAt = -Infinity;

  const open = (t: HTMLElement, by: OpenedBy, at?: { x: number; y: number }) => {
    const spec = o.build(t, by);
    if (!spec) return false;
    o.onOpen?.(t);
    openContextMenu(spec, { anchor: t, by, at });
    return true;
  };

  const cancel = () => {
    clearTimeout(timer);
    start?.t.classList.remove("cm-hold");
    start = null;
  };

  const down = (e: PointerEvent) => {
    pressed = false;
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    lastTouch = performance.now();
    const t = o.target(e.target as Element);
    if (!t) return;
    cancel();
    start = { x: e.clientX, y: e.clientY, t };
    t.classList.add("cm-hold");
    timer = setTimeout(() => {
      if (!start) return;
      const target = start.t;
      cancel();
      if (open(target, "touch")) {
        pressed = true;
        navigator.vibrate?.(10);
        getSelection()?.removeAllRanges();
      }
    }, holdMs);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  const menu = (e: MouseEvent) => {
    const t = o.target(e.target as Element);
    if (!t) return;
    e.preventDefault();
    if (current?.anchor === t) return;
    if (performance.now() - keyOpenAt < 400) return;
    // Android fires contextmenu on a long press: open now as a touch menu.
    if (performance.now() - lastTouch < 1500) {
      if (start) {
        cancel();
        if (open(t, "touch")) {
          pressed = true;
          navigator.vibrate?.(10);
        }
      }
      return;
    }
    open(t, "mouse", { x: e.clientX, y: e.clientY });
  };
  const key = (e: KeyboardEvent) => {
    if (!((e.shiftKey && e.key === "F10") || e.key === "ContextMenu")) return;
    const t = o.target(e.target as Element);
    if (!t) return;
    e.preventDefault();
    keyOpenAt = performance.now();
    open(t, "keyboard");
  };
  const swallow = (e: MouseEvent) => {
    if (!pressed) return;
    pressed = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  scope.addEventListener("pointerdown", down);
  scope.addEventListener("pointermove", move);
  scope.addEventListener("pointerup", cancel);
  scope.addEventListener("pointercancel", cancel);
  scope.addEventListener("contextmenu", menu);
  scope.addEventListener("keydown", key);
  scope.addEventListener("click", swallow, true);
  return {
    destroy() {
      cancel();
      scope.removeEventListener("pointerdown", down);
      scope.removeEventListener("pointermove", move);
      scope.removeEventListener("pointerup", cancel);
      scope.removeEventListener("pointercancel", cancel);
      scope.removeEventListener("contextmenu", menu);
      scope.removeEventListener("keydown", key);
      scope.removeEventListener("click", swallow, true);
      if (current && scope.contains(current.anchor)) current.close();
    },
  };
}

// ---------- Drawn, not live (galleries, docs) ----------

/**
 * The menu drawn in place and inert: `focus` marks an entry as focused (an
 * action id, or "choice-id:value"), `submenu` shows that action's submenu
 * open. For the lift layout, `behind` is what shows blurred under it.
 */
export function staticContextMenu(spec: ContextMenuSpec, o: { layout: MenuLayout; focus?: string; submenu?: string; behind?: Node }): HTMLElement {
  const root = buildPanel(spec.groups, spec.label);
  const mark = (panel: Panel, id?: string) => {
    if (!id) return;
    const [eid, val] = id.split(":");
    const el = val ? panel.el.querySelector<HTMLElement>(`[data-cm-id="${eid}"] [data-cm-value="${val}"]`) : panel.el.querySelector<HTMLElement>(`[data-cm-id="${eid}"]`);
    el?.classList.add("is-focus");
  };
  let sub: Panel | null = null;
  if (o.submenu) {
    const a = spec.groups.flat().find((e): e is MenuAction => e.kind !== "choice" && e.id === o.submenu);
    if (a?.submenu) {
      sub = buildPanel(a.submenu, a.label, o.layout === "lift" ? a.label : undefined);
      sub.el.classList.add("cm-menu--sub");
      const parent = root.el.querySelector<HTMLElement>(`[data-cm-id="${a.id}"]`);
      parent?.classList.add("is-focus");
      parent?.setAttribute("aria-expanded", "true");
      mark(sub, a.submenu.flat().find((e) => e.kind === "choice" || !e.disabled)?.id);
    }
  }
  if (!sub) mark(root, o.focus);
  const preview = spec.preview ? h("div", { class: "cm-preview", "aria-hidden": "true" }, spec.preview) : null;

  let el: HTMLElement;
  if (o.layout === "lift") {
    if (sub) root.el.hidden = true;
    el = h("div", { class: "cm-static cm-static--lift" }, o.behind ? h("div", { class: "cm-static__behind" }, o.behind) : null, h("div", { class: "cm-backdrop" }), h("div", { class: "cm-stack" }, preview, root.el, sub?.el ?? null));
  } else {
    el = h("div", { class: "cm-static cm-static--popover" }, h("div", { class: "cm-static__menus" }, root.el, sub?.el ?? null), preview);
    if (sub) {
      // Line the submenu up with the item it came from, once laid out.
      const s = sub;
      requestAnimationFrame(() => {
        const item = root.el.querySelector<HTMLElement>('[aria-expanded="true"]');
        if (item) s.el.style.marginTop = `${item.offsetTop - 5}px`;
      });
    }
  }
  el.setAttribute("aria-hidden", "true");
  el.inert = true;
  for (const n of el.querySelectorAll("[tabindex]")) n.removeAttribute("tabindex");
  for (const n of el.querySelectorAll("[id]")) n.removeAttribute("id");
  return el;
}
