/**
 * Peek cards: a look at what a Mention or a Link points to without leaving
 * the note. On a desk they open after a short
 * hover, 380ms, then 80ms while moving between links, or after a 700ms pause
 * on a link reached with the keyboard. On a phone a long press opens the
 * context menu instead, with this same card as its preview (link-context.ts).
 * Peeks close when the pointer leaves, on Esc, on a tap elsewhere, or when
 * the page scrolls.
 */

import { h } from "../lib/dom";
import { shortDate } from "../lib/format";
import { PROVIDER_NAMES } from "../../../lib/embeds";
import { favicon, icon, KIND_ICON, kindLabel, liveDetail, type Thing } from "./link-render";

export const PEEK_FIRST_MS = 380;
export const PEEK_NEXT_MS = 80;
const PEEK_FOCUS_MS = 700;

const fine = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const pic = (src: string, cls: string) => h("img", { class: cls, src, alt: "", decoding: "async", draggable: "false", referrerpolicy: "no-referrer" });
const meta = (name: Parameters<typeof icon>[0], text: string) => h("span", { class: "rl-meta" }, icon(name), h("span", {}, text));

/** What a peek shows: the thing's picture, name and its live details. */
export function peekContent(t: Thing): HTMLElement {
  const kids: (Node | null)[] = [];
  const live = t.live;
  if (t.kind === "web") {
    if (t.image) kids.push(h("span", { class: `rl-peek__media rl-peek__media--${t.imageShape === "square" ? "square" : "wide"}` }, pic(t.image, "rl-media__img")));
    kids.push(
      h(
        "span",
        { class: "rl-peek__body" },
        h("span", { class: "rl-card__site" }, favicon(t), h("span", {}, t.embed ? PROVIDER_NAMES[t.embed.provider] : t.site)),
        h("span", { class: "rl-peek__title" }, t.title),
        t.summary ? h("span", { class: "rl-card__summary" }, t.summary) : null,
        t.url ? h("span", { class: "rl-peek__url" }, t.url.replace(/^https?:\/\//, "")) : null
      )
    );
  } else {
    const head = h(
      "span",
      { class: "rl-peek__head" },
      t.kind === "person" && t.image
        ? h("span", { class: "rl-face rl-face--lg" }, pic(t.image, "rl-face__img"))
        : t.image
          ? h("span", { class: `rl-peek__thumb rl-peek__thumb--${t.imageShape ?? "square"}` }, pic(t.image, "rl-media__img"))
          : h("span", { class: `rl-tile rl-tile--lg rl-k--${t.kind}` }, icon(KIND_ICON[t.kind])),
      h("span", { class: "rl-peek__names" }, h("span", { class: "rl-peek__title" }, t.title), h("span", { class: "rl-card__kind" }, t.site === kindLabel(t.kind) ? kindLabel(t.kind) : `${kindLabel(t.kind)} · ${t.site}`))
    );
    kids.push(head);
    const rows: (Node | null)[] = [];
    if (live?.kind === "person") {
      if (live.lastCatchUp) rows.push(meta("chat", `Last catch-up: ${shortDate(live.lastCatchUp)}`));
      if (live.birthday) rows.push(meta("gift", `Birthday ${shortDate(live.birthday)}`));
    }
    if (live?.kind === "place") {
      if (live.area) rows.push(meta("pin", live.area));
      if (live.lastVisit) rows.push(meta("clock", `Last there ${shortDate(live.lastVisit)}`));
    }
    if (live?.kind === "event") {
      rows.push(meta("calendar", liveDetail(live)));
      if (live.where) rows.push(meta("pin", live.where));
    }
    if (live?.kind === "todo") rows.push(meta("clock", liveDetail(live)));
    if (live?.kind === "watch") rows.push(meta("tv", live.type), meta("bookmark", live.progressText ? `${live.status} · ${live.progressText}` : live.status));
    if (live?.kind === "saved" && liveDetail(live)) rows.push(meta("tag", liveDetail(live)));
    if (live?.kind === "note") rows.push(h("span", { class: "rl-note-lines" }, ...live.lines.slice(0, 2).map((l) => h("span", {}, l))));
    if (rows.length) kids.push(h("span", { class: "rl-peek__rows" }, ...rows));
  }
  kids.push(h("span", { class: "rl-peek__foot" }, h("span", { class: "rl-kbd-hint" }, t.kind === "web" ? "Opens in a new tab" : "Opens in Athena"), h("span", { class: "rl-peek__open" }, "Open", icon(t.kind === "web" ? "external" : "arrowRight"))));
  return h("div", { class: `rl-peek__card rl-peek--${t.kind}`, style: t.tint ? `--tint:${t.tint}` : undefined }, ...kids);
}

let current: { el: HTMLElement; anchor: HTMLElement } | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export function hidePeek(): void {
  clearTimeout(hideTimer);
  if (!current) return;
  const { el, anchor } = current;
  current = null;
  anchor.removeAttribute("aria-describedby");
  el.classList.add("is-leaving");
  setTimeout(() => el.remove(), 180);
}

export const peekShowing = () => current?.anchor ?? null;

function showPeek(anchor: HTMLElement, t: Thing, how: "hover" | "focus", onOpen?: () => void) {
  if (current?.anchor === anchor) return;
  hidePeek();
  const card = peekContent(t);
  const el = h("div", { class: `rl-peek rl-peek--${how}`, id: "rl-peek", role: "tooltip" }, card);
  el.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  el.addEventListener("pointerleave", () => scheduleHide());
  if (onOpen) {
    const open = card.querySelector<HTMLElement>(".rl-peek__open");
    open?.addEventListener("click", () => {
      hidePeek();
      onOpen();
    });
    open?.style.setProperty("cursor", "pointer");
  }
  (anchor.closest("dialog[open]") ?? document.body).append(el);
  current = { el, anchor };
  anchor.setAttribute("aria-describedby", "rl-peek");
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12));
  let top = r.bottom + 8;
  let side = "below";
  if (top + hgt > window.innerHeight - 12 && r.top - hgt - 8 > 12) {
    top = r.top - hgt - 8;
    side = "above";
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.dataset.side = side;
  el.style.setProperty("--origin-x", `${Math.round(r.left + r.width / 2 - left)}px`);
}

function scheduleHide(wait = 140) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePeek, wait);
}

/** A Mention or a Link: a drawn node in one of those modes, or a web link's words. */
const PEEKABLE = '.rl-node[data-rl-mode="mention"], .rl-node[data-rl-mode="link"], a.rl-link[href^="http"]';

/**
 * Wire peeks onto every Mention and Link inside `scope`. `find` turns an
 * element back into what it shows (it may wait for the data); `blocked` says
 * when not to peek (the switcher or a context menu is open). Returns a teardown.
 */
export function wirePeeks(scope: HTMLElement, find: (el: HTMLElement) => Promise<Thing | null>, blocked: () => boolean, open?: (el: HTMLElement) => void) {
  let showTimer: ReturnType<typeof setTimeout> | undefined;

  const nodeOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(PEEKABLE) : null);

  const show = (n: HTMLElement, how: "hover" | "focus", still: () => boolean) => {
    void find(n).then((t) => {
      if (t && still() && !blocked()) showPeek(n, t, how, open ? () => open(n) : undefined);
    });
  };

  const over = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || !fine()) return;
    const n = nodeOf(e.target);
    if (!n || blocked() || n.dataset.rlState === "loading") return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    if (current?.anchor === n) return;
    showTimer = setTimeout(() => show(n, "hover", () => n.matches(":hover")), current ? PEEK_NEXT_MS : PEEK_FIRST_MS);
  };
  const out = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const n = nodeOf(e.target);
    if (!n) return;
    clearTimeout(showTimer);
    if (current?.anchor === n) scheduleHide();
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(showTimer);
    hidePeek();
  };
  const focusIn = (e: FocusEvent) => {
    const n = nodeOf(e.target);
    if (!n || !n.matches(":focus-visible") || blocked()) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(n, "focus", () => document.activeElement === n), PEEK_FOCUS_MS);
  };
  const focusOut = (e: FocusEvent) => {
    clearTimeout(showTimer);
    if (current && nodeOf(e.target) === current.anchor && current.el.classList.contains("rl-peek--focus")) hidePeek();
  };
  const elsewhere = (e: PointerEvent) => {
    if (current && !current.el.contains(e.target as Node) && !current.anchor.contains(e.target as Node)) hidePeek();
  };
  const key = (e: KeyboardEvent) => e.key === "Escape" && current && hidePeek();
  const scrolled = () => current && hidePeek();

  scope.addEventListener("pointerover", over);
  scope.addEventListener("pointerout", out);
  scope.addEventListener("pointerdown", down);
  scope.addEventListener("focusin", focusIn);
  scope.addEventListener("focusout", focusOut);
  document.addEventListener("pointerdown", elsewhere, true);
  document.addEventListener("keydown", key);
  window.addEventListener("scroll", scrolled, true);

  return {
    destroy() {
      clearTimeout(showTimer);
      hidePeek();
      scope.removeEventListener("pointerover", over);
      scope.removeEventListener("pointerout", out);
      scope.removeEventListener("pointerdown", down);
      scope.removeEventListener("focusin", focusIn);
      scope.removeEventListener("focusout", focusOut);
      document.removeEventListener("pointerdown", elsewhere, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scrolled, true);
    },
  };
}
