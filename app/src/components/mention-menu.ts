/**
 * The @ suggestion list: one component for the note editor's popover
 * (editor/editor.ts) and Ask's composer (components/mention-input.ts).
 * It draws rows and keeps the active one; whoever owns it decides when it
 * opens, what's in it and what picking does. Our own DOM, built with h(),
 * nothing set as HTML.
 *
 * On a phone, Ask docks it as a sheet just above the composer (and so above
 * the keyboard); elsewhere it floats under (or over) the caret.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { entityIcon } from "../lib/entity-icon";

/** A mention's icon: Saved, to-dos and Watch & read have their own; the rest as everywhere else. */
export function mentionIcon(kind: string, kindId?: string | null): IconName {
  if (kind === "saved") return "bookmark";
  if (kind === "todo") return "check";
  if (kind === "watch") return "book";
  return entityIcon(kind as Parameters<typeof entityIcon>[0], kindId ?? null);
}

export interface MenuRow {
  title: string;
  sub: string;
  icon: IconName;
  /** A picture instead of the icon (a saved image or link): an object URL, when it arrives. */
  thumb?: Promise<string | null> | null;
  /** Its own tint: the editor's "create" rows. */
  create?: boolean;
}

export interface MentionMenu {
  el: HTMLElement;
  /** Show these rows (or the empty line). `query` is what the empty line quotes. */
  set(rows: MenuRow[], query: string): void;
  /** Arrow keys: true when there was a row to move to. */
  move(delta: number): boolean;
  readonly active: number;
  readonly size: number;
  /** Float by a caret rectangle, or dock above an element as a sheet. */
  place(at: { caret: DOMRect } | { above: DOMRect; sheet: boolean }): void;
  remove(): void;
}

let menus = 0;

export function mentionMenu(opts: { emptyText: string; onPick: (index: number) => void; label?: string }): MentionMenu {
  const uid = `mention-${++menus}`;
  const el = h("div", { class: "mention-menu", role: "listbox", id: uid, "aria-label": opts.label ?? "Suggestions" });
  let rows: MenuRow[] = [];
  let active = 0;
  let query = "";

  const mark = () => {
    el.querySelectorAll<HTMLElement>(".mention-menu__item").forEach((b, i) => b.setAttribute("aria-selected", String(i === active)));
    if (rows.length) el.setAttribute("aria-activedescendant", `${uid}-${active}`);
    else el.removeAttribute("aria-activedescendant");
    el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const paint = () => {
    if (!rows.length) {
      el.replaceChildren(h("div", { class: "mention-menu__empty" }, query ? `No match for “${query}”` : opts.emptyText));
      mark();
      return;
    }
    el.replaceChildren(
      ...rows.map((row, i) => {
        const tile = h("span", { class: "tile tile--sm" }, icons[row.icon]());
        void row.thumb?.then((src) => {
          if (!src || !tile.isConnected) return;
          tile.classList.add("tile--thumb");
          tile.replaceChildren(h("img", { src, alt: "", loading: "lazy", decoding: "async" }));
        });
        const b = h(
          "button",
          {
            class: `mention-menu__item${row.create ? " mention-menu__item--create" : ""}`,
            type: "button",
            role: "option",
            id: `${uid}-${i}`,
            tabindex: "-1",
            "aria-selected": String(i === active),
          },
          tile,
          h("span", { class: "mention-menu__text" }, h("span", { class: "mention-menu__title" }, row.title), h("span", { class: "mention-menu__sub" }, row.sub))
        );
        // mousedown, not click: focus (and the caret) stay where they were.
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          opts.onPick(i);
        });
        b.addEventListener("mousemove", () => {
          if (active === i) return;
          active = i;
          mark();
        });
        return b;
      })
    );
    mark();
  };

  return {
    el,
    get active() {
      return active;
    },
    get size() {
      return rows.length;
    },
    set(next, q) {
      rows = next;
      query = q;
      active = Math.min(active, Math.max(0, rows.length - 1));
      paint();
    },
    move(delta) {
      if (!rows.length) return false;
      active = (active + delta + rows.length) % rows.length;
      mark();
      return true;
    },
    place(at) {
      if ("caret" in at) {
        const rect = at.caret;
        const width = Math.min(320, window.innerWidth - 24);
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        const below = rect.bottom + 6;
        const fitsBelow = below + 280 < window.innerHeight;
        el.classList.remove("mention-menu--sheet");
        el.style.translate = "";
        el.style.left = `${left}px`;
        el.style.width = `${width}px`;
        el.style.top = fitsBelow ? `${below}px` : "auto";
        el.style.bottom = fitsBelow ? "auto" : `${window.innerHeight - rect.top + 6}px`;
        return;
      }
      // Docked just above what it sits on: a full-width sheet on a phone, a 440px list on a desk.
      const r = at.above;
      el.classList.toggle("mention-menu--sheet", at.sheet);
      const left = at.sheet ? 8 : r.left;
      el.style.left = `${left}px`;
      el.style.width = `${at.sheet ? window.innerWidth - 16 : Math.min(r.width, 440)}px`;
      // Its top edge, lifted by its own height: the same coordinates as the rectangle, keyboard or not.
      el.style.bottom = "auto";
      el.style.top = `${r.top - 8}px`;
      el.style.translate = "0 -100%";
    },
    remove() {
      el.remove();
    },
  };
}
