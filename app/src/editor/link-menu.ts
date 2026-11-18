/**
 * The editor's @ menu, redrawn from the approved prototype: one list of
 * things in Athena (people, places, events, to-dos, Watch & read, Saved,
 * notes…) with their pictures or kind icons, and "Paste a link" at the foot.
 * Typing after the @ filters it (the editor's suggestion plugin asks
 * db/mentions.ts); Up and Down move, Enter or Tab picks, Esc closes.
 *
 * "Paste a link" swaps the list for an address field. The /card and /embed
 * commands open the menu straight onto that field.
 *
 * Our own DOM, built with h(); nothing is set as HTML.
 */

import { h } from "../lib/dom";
import type { IconName } from "../components/icons";
import { icon } from "./link-render";
import { pastedUrl } from "./link-model";

export interface AtRow {
  title: string;
  /** "Person · Sister". */
  sub: string;
  icon: IconName;
  /** The kind, for the icon's colour (rl-k--person…). */
  kind: string;
  thumb?: Promise<string | null> | null;
  /** A "New person “…”" row. */
  create?: boolean;
}

export interface AtMenu {
  el: HTMLElement;
  set(rows: AtRow[], query: string): void;
  move(by: number): void;
  /** Enter or Tab on the active row. */
  pick(): void;
  /** Open on the address field (Paste a link, /card, /embed). */
  startPaste(heading?: string): void;
  place(caret: DOMRect): void;
  readonly pasting: boolean;
  remove(): void;
}

let menus = 0;

function highlight(text: string, q: string): (Node | string)[] {
  if (!q) return [text];
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [text];
  return [text.slice(0, i), h("mark", {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

export function atMenu(opts: {
  onPick: (index: number) => void;
  /** A typed or pasted address; the menu closes when this returns true. */
  onPaste: (url: string) => boolean | void;
  /** Esc in the address field when it was opened straight onto it. */
  onCancel: () => void;
  emptyText: string;
}): AtMenu {
  const id = `rl-at-${++menus}`;
  let rows: AtRow[] = [];
  let query = "";
  let index = 0;
  let pasting = false;
  let pasteOnly = false;
  let items: HTMLElement[] = [];

  const list = h("div", { class: "rl-menu__list", role: "listbox", id: `${id}-list`, "aria-label": "Link to" });
  const pasteField = h("input", { class: "rl-menu__url", type: "url", inputmode: "url", placeholder: "https://", "aria-label": "Paste a link", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const pasteErr = h("span", { class: "rl-menu__err", role: "status" });
  const pasteHead = h("span", {}, "Paste a link");
  const pastePane = h(
    "div",
    { class: "rl-menu__paste", hidden: true },
    h("span", { class: "rl-menu__pastehead" }, icon("link"), pasteHead),
    pasteField,
    pasteErr,
    h("span", { class: "rl-kbd-hint" }, "Enter to add · Esc to go back")
  );
  const el = h("div", { class: "rl-menu rl-menu--floating", id }, list, pastePane);
  el.addEventListener("pointerdown", (e) => {
    if (e.target !== pasteField) e.preventDefault();
  });

  function draw() {
    const q = query.trim();
    items = rows.map((r, i) => {
      const tile = h("span", { class: `rl-menu__thumb rl-menu__thumb--icon rl-k--${r.kind}` }, icon(r.icon));
      void r.thumb?.then((src) => {
        if (!src || !tile.isConnected) return;
        tile.className = "rl-menu__thumb";
        tile.replaceChildren(h("img", { src, alt: "", decoding: "async" }));
      });
      return h(
        "div",
        { class: `rl-menu__item${r.create ? " rl-menu__item--create" : ""}`, role: "option", id: `${id}-${i}`, "aria-selected": "false" },
        tile,
        h("span", { class: "rl-menu__text" }, h("span", { class: "rl-menu__title" }, ...highlight(r.title, q)), h("span", { class: "rl-menu__sub" }, h("span", {}, r.sub)))
      );
    });
    const paste = h(
      "div",
      { class: "rl-menu__item rl-menu__item--paste", role: "option", id: `${id}-paste`, "aria-selected": "false" },
      h("span", { class: "rl-menu__thumb rl-menu__thumb--icon rl-k--web" }, icon("link")),
      h("span", { class: "rl-menu__text" }, h("span", { class: "rl-menu__title" }, "Paste a link"), h("span", { class: "rl-menu__sub" }, "Any page, video, song, map or design"))
    );
    items.push(paste);
    items.forEach((it, i) => {
      it.addEventListener("click", () => {
        index = i;
        api.pick();
      });
      it.addEventListener("pointermove", () => {
        if (index === i) return;
        index = i;
        mark();
      });
    });
    const empty = rows.length ? null : h("div", { class: "rl-menu__empty" }, q ? `Nothing in Athena called “${q}”` : opts.emptyText);
    list.replaceChildren(...(empty ? [empty] : []), ...items);
    index = Math.min(index, items.length - 1);
    mark();
  }

  function mark() {
    items.forEach((it, i) => it.setAttribute("aria-selected", String(i === index)));
    const cur = items[index];
    cur?.scrollIntoView({ block: "nearest" });
    el.dataset.active = cur?.id ?? "";
  }

  function endPaste() {
    pasting = false;
    pastePane.hidden = true;
    list.hidden = false;
  }

  function submit(raw: string) {
    const url = pastedUrl(raw);
    if (!url) {
      pasteErr.textContent = "That doesn't look like a web address";
      return;
    }
    pasteErr.textContent = "";
    opts.onPaste(url);
  }

  pasteField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit(pasteField.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (pasteOnly) opts.onCancel();
      else endPaste();
    }
  });
  pasteField.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    pasteField.value = text.trim();
    submit(text);
  });

  const api: AtMenu = {
    el,
    get pasting() {
      return pasting;
    },
    set(next, q) {
      rows = next;
      query = q;
      if (!pasting) draw();
    },
    move(by) {
      if (!items.length) return;
      index = (index + by + items.length) % items.length;
      mark();
    },
    pick() {
      if (index >= rows.length) return api.startPaste();
      opts.onPick(index);
    },
    startPaste(heading) {
      pasting = true;
      pasteOnly = !!heading;
      pasteHead.textContent = heading ?? "Paste a link";
      list.hidden = true;
      pastePane.hidden = false;
      pasteErr.textContent = "";
      pasteField.value = "";
      requestAnimationFrame(() => pasteField.focus());
    },
    place(caret) {
      const vw = document.documentElement.clientWidth;
      const phone = vw < 640;
      el.classList.toggle("rl-menu--sheet", phone);
      if (phone) {
        el.style.left = "12px";
        el.style.right = "12px";
      } else {
        const w = el.offsetWidth || 340;
        el.style.left = `${Math.round(Math.max(12, Math.min(caret.left - 12, vw - w - 12)))}px`;
        el.style.right = "";
      }
      const hgt = el.offsetHeight || 320;
      const below = caret.bottom + 8;
      el.style.top = below + hgt < window.innerHeight - 8 ? `${Math.round(below)}px` : `${Math.round(Math.max(8, caret.top - hgt - 8))}px`;
    },
    remove() {
      el.remove();
    },
  };
  draw();
  return api;
}
