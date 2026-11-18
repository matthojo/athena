/**
 * To-do contexts in the UI: the quiet tag on a To do row, the filter
 * buttons above the list (each opens a menu), and the sheet's pickers (a
 * row of chips; tapping the chosen one clears it). Colours are tokens
 * (--ctx-<colour> in tokens.css), stepped for each theme.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { contextById, liveContexts, type ContextKind, type TodoContext } from "../db/todo-contexts";
import type { ContextFilter } from "../../../lib/todo-context";
import "../styles/todo-contexts.css";

const icon = (name: string) => (icons[name as IconName] ?? icons.tag)();

export const KIND_WORDS: Record<ContextKind, { label: string; any: string; none: string }> = {
  area: { label: "Area", any: "Any area", none: "No area" },
  where: { label: "Where", any: "Anywhere", none: "Not set" },
};

/** A context's dot and name, for a row's meta line. */
export function contextTag(c: TodoContext): HTMLElement {
  // An area is a coloured dot; a where/how is its icon, so the two never read alike.
  const mark = c.kind === "area" ? h("span", { class: "ctx-dot", "aria-hidden": "true" }) : icon(c.icon);
  return h("span", { class: "ctx-tag", "data-colour": c.colour, "data-kind": c.kind, title: `${KIND_WORDS[c.kind].label}: ${c.name}` }, mark, c.name);
}

/** The tags for a to-do, area first; nothing for contexts that were removed. */
export function contextTags(t: { area_id?: string | null; where_id?: string | null }): HTMLElement[] {
  return [contextById(t.area_id), contextById(t.where_id)].filter((c): c is TodoContext => !!c).map(contextTag);
}

let menuSeq = 0;

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  icon?: SVGElement | null;
  colour?: string;
}

/** A pill that opens a menu of options; the chosen one is ticked. */
export function menuChip<T extends string>(opts: {
  label: () => string;
  lead: () => SVGElement | HTMLElement | null;
  active: () => boolean;
  options: () => MenuOption<T>[];
  value: () => T;
  onChange: (v: T) => void;
  aria: string;
}): { el: HTMLElement; paint: () => void } {
  const id = `ctx-menu-${++menuSeq}`;
  const btn = h("button", { class: "chip chip--menu", type: "button", popovertarget: id, "aria-haspopup": "menu" }) as HTMLButtonElement;
  const menu = h("div", { class: "menu ctx-menu", id, popover: "auto", role: "menu" }) as HTMLElement & { hidePopover?: () => void };
  function paint() {
    btn.replaceChildren(...[opts.lead(), h("span", { class: "chip__text" }, opts.label()), icons.chevronDown()].filter((x): x is SVGElement | HTMLElement => !!x));
    btn.dataset.active = String(opts.active());
    btn.setAttribute("aria-label", `${opts.aria}: ${opts.label()}`);
  }
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const now = opts.value();
    menu.replaceChildren(
      ...opts.options().map((o) => {
        if (o.value === ("--" as T)) return h("div", { class: "menu__sep" });
        const b = h(
          "button",
          { class: "menu__item", type: "button", role: "menuitemradio", "aria-checked": String(o.value === now) },
          o.colour ? h("span", { class: "ctx-dot", "data-colour": o.colour, "aria-hidden": "true" }) : (o.icon ?? h("span", { class: "ctx-dot ctx-dot--none", "aria-hidden": "true" })),
          h("span", { class: "menu__label" }, o.label),
          o.value === now ? icons.check() : null
        );
        b.addEventListener("click", () => {
          menu.hidePopover?.();
          if (o.value !== now) opts.onChange(o.value);
        });
        return b;
      })
    );
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 320)}px`;
    menu.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 232))}px`;
    menu.style.right = "auto";
  });
  paint();
  return { el: h("span", { class: "ctx-menu-wrap" }, btn, menu), paint };
}

/** A filter on one kind of context, for To do's bar. */
export function contextFilterChip(kind: ContextKind, value: () => ContextFilter, onChange: (v: ContextFilter) => void): { el: HTMLElement; paint: () => void } {
  const w = KIND_WORDS[kind];
  return menuChip<string>({
    aria: kind === "area" ? "Filter by area" : "Filter by where",
    value: () => value() ?? "",
    active: () => !!value(),
    label: () => {
      const v = value();
      if (!v) return w.label;
      if (v === "none") return w.none;
      return contextById(v)?.name ?? w.label;
    },
    lead: () => {
      const c = contextById(value());
      if (!c) return null;
      return c.kind === "area" ? h("span", { class: "ctx-dot", "data-colour": c.colour, "aria-hidden": "true" }) : icon(c.icon);
    },
    options: () => [
      { value: "", label: w.any, icon: icon(kind === "area" ? "target" : "pin") },
      { value: "--", label: "" },
      ...liveContexts(kind).map((c) => (kind === "area" ? { value: c.id, label: c.name, colour: c.colour } : { value: c.id, label: c.name, icon: icon(c.icon) })),
      { value: "--", label: "" },
      { value: "none", label: w.none },
    ],
    onChange: (v) => onChange(v === "" ? null : v),
  });
}

/** The sheet's picker: one chip per context; tap the chosen one again to clear it. */
export function contextPicker(kind: ContextKind, value: string | null, onChange: (id: string | null) => void): { el: HTMLElement; set: (id: string | null) => void } {
  let current = value;
  const row = h("span", { class: "chip-row ctx-picker", role: "radiogroup", "aria-label": KIND_WORDS[kind].label });
  function paint() {
    const live = liveContexts(kind);
    row.replaceChildren(
      ...live.map((c) => {
        const on = c.id === current;
        const b = h("button", { class: "chip chip--sm ctx-chip", type: "button", role: "radio", "aria-checked": String(on), "data-colour": c.colour, title: on ? `${c.name}. Tap again to clear` : c.name }, icon(c.icon), c.name);
        b.addEventListener("click", (e) => {
          e.preventDefault();
          current = on ? null : c.id;
          paint();
          onChange(current);
        });
        return b;
      })
    );
    if (!live.length) row.append(h("span", { class: "ctx-picker__empty" }, "None yet. Add some in Settings → To do."));
  }
  paint();
  return {
    el: row,
    set: (id) => {
      current = id;
      paint();
    },
  };
}
