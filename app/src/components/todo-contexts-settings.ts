/**
 * Settings → To do (#/settings/todo): the owner's areas and where/how
 * contexts. Each list in its order, with how many open to-dos each is on;
 * New, Reorder; tap one to rename it or pick its icon and colour. Remove asks
 * first, clears it from every to-do and offers Undo (the server archives it,
 * so Undo puts it back on those to-dos too).
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { contextCount, createContext, liveContexts, loadContexts, onContextsChange, reorderContexts, updateContext, type ContextKind, type TodoContext } from "../db/todo-contexts";
import { CONTEXT_COLOURS, CONTEXT_ICONS } from "../../../lib/todo-context";
import { plural } from "../lib/format";
import type { ConnectionState } from "../types";
import "../styles/todo-contexts.css";

const KIND: Record<ContextKind, { heading: string; one: string; lede: string; placeholder: string; newLabel: string }> = {
  area: { heading: "Areas", one: "area", lede: "Which part of your life a to-do belongs to.", placeholder: "Name, like Side project", newLabel: "New area" },
  where: { heading: "Where or how", one: "where/how", lede: "Where you can do it, or what you need.", placeholder: "Name, like Gym or Car", newLabel: "New where/how" },
};

const COLOUR_NAMES: Record<(typeof CONTEXT_COLOURS)[number], string> = {
  grey: "Grey",
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  orange: "Orange",
  red: "Red",
  pink: "Pink",
  violet: "Violet",
};

const iconOf = (name: string) => (icons[name as IconName] ?? icons.tag)();
const countWords = (n: number) => (n ? `On ${n} open ${plural(n, "to-do", "to-dos")}` : "Not on any open to-dos");

function tile(c: { icon: string; colour: string }): HTMLElement {
  return h("span", { class: "tile tile--sm ctx-tile", "data-colour": c.colour, "aria-hidden": "true" }, iconOf(c.icon));
}

/** Ask, remove, and offer Undo. */
export async function removeContext(c: TodoContext): Promise<boolean> {
  const n = contextCount(c.id);
  const ok = await confirmDialog({
    title: `Remove ${c.name}?`,
    body: n ? `It comes off ${n} open ${plural(n, "to-do", "to-dos")}. The to-dos stay.` : `No open to-dos use it.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return false;
  try {
    await updateContext(c.id, { archived: true });
    showToast(`${c.name} removed`, {
      icon: "trash",
      action: { label: "Undo", run: () => void updateContext(c.id, { archived: false }).catch((e) => showToast(e instanceof Error ? e.message : "Couldn't bring it back", { icon: "close" })) },
    });
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Couldn't remove it", { icon: "wifiOff" });
    return false;
  }
}

/** Make a context of `kind` (null) or change one. */
export function openContextEditor(initial: TodoContext | null, kind: ContextKind): void {
  let rec = initial;
  let iconName: string = initial?.icon ?? "tag";
  let colour: string = initial?.colour ?? "grey";
  const words = KIND[kind];

  const mark = h("span", {});
  const paintMark = () => mark.replaceChildren(tile({ icon: iconName, colour }));
  paintMark();

  let saving: Promise<void> = Promise.resolve();
  function save(patch: { name?: string; icon?: string; colour?: string }, revert?: () => void) {
    if (!rec) return;
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await updateContext(rec.id, patch);
        editor.refresh();
      } catch (error) {
        revert?.();
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "pen", timeoutMs: 5000 });
      }
    });
  }

  // ---------- colour ----------
  const swatches = CONTEXT_COLOURS.map((name) => {
    const b = h("button", { class: "ctx-swatch", type: "button", role: "radio", "data-colour": name, "aria-checked": String(name === colour), "aria-label": COLOUR_NAMES[name], title: COLOUR_NAMES[name] }, h("span", { class: "ctx-dot", "aria-hidden": "true" }));
    b.addEventListener("click", () => {
      if (name === colour) return;
      const before = colour;
      colour = name;
      paintPickers();
      save({ colour: name }, () => {
        colour = before;
        paintPickers();
      });
    });
    return b;
  });
  const colourSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Colour"), h("div", { class: "ctx-swatches", role: "radiogroup", "aria-label": "Colour" }, ...swatches));

  // ---------- icon ----------
  const iconButtons = CONTEXT_ICONS.map((name) => {
    const b = h("button", { class: "kind-icon", type: "button", role: "radio", "aria-checked": String(name === iconName), "aria-label": name, title: name }, iconOf(name));
    b.addEventListener("click", () => {
      if (name === iconName) return;
      const before = iconName;
      iconName = name;
      paintPickers();
      save({ icon: name }, () => {
        iconName = before;
        paintPickers();
      });
    });
    return b;
  });
  const iconSection = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Icon"), h("div", { class: "kind-icons", role: "radiogroup", "aria-label": "Icon" }, ...iconButtons));

  function paintPickers() {
    swatches.forEach((b, i) => b.setAttribute("aria-checked", String(CONTEXT_COLOURS[i] === colour)));
    iconButtons.forEach((b, i) => b.setAttribute("aria-checked", String(CONTEXT_ICONS[i] === iconName)));
    paintMark();
  }

  const editor = openEditorSheet({
    newLabel: words.newLabel,
    isNew: !initial,
    titleValue: initial?.name ?? "",
    placeholder: words.placeholder,
    mark,
    createLabel: "Add",
    sections: [colourSection, iconSection],
    onTitle: (name) => {
      const before = rec?.name ?? "";
      save({ name }, () => (editor.title.value = before));
    },
    create: async () => {
      rec = await createContext({ kind, name: editor.title.value, icon: iconName, colour });
      showToast(`Added ${rec.name}`, { icon: "check" });
      return true;
    },
    status: () => (rec ? countWords(contextCount(rec.id)) : ""),
    more: initial
      ? [
          {
            icon: "trash",
            label: "Remove",
            run: () => {
              if (!rec) return;
              void removeContext(rec).then((gone) => gone && editor.sheet.close());
            },
          },
        ]
      : [],
  });
  editor.sheet.dialog.classList.add("kind-editor");
}

/** The section: both lists. */
export function todoContextsSection(): { el: HTMLElement; destroy: () => void } {
  let state: ConnectionState = "online";
  let loaded = false;
  const reordering: Record<ContextKind, boolean> = { area: false, where: false };
  const lists: Record<ContextKind, HTMLElement> = { area: h("div", { class: "settings__fields" }), where: h("div", { class: "settings__fields" }) };
  const offline = h("p", { class: "settings__note", hidden: true }, icons.wifiOff(), "You're offline. Changing your contexts needs a connection.");

  const block = (kind: ContextKind) =>
    h(
      "div",
      { class: "ctx-settings__block" },
      h("h3", { class: "group__label ctx-settings__label" }, KIND[kind].heading),
      h("p", { class: "ctx-settings__lede" }, KIND[kind].lede),
      lists[kind]
    );

  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-todo" },
    h("h2", { class: "settings__heading", id: "settings-todo" }, icons.loop(), "To do"),
    h("p", { class: "settings__lede" }, "Give to-dos an area and say where you'd do them, then filter To do by either. Athena fills these in for to-dos it adds, when it's clear."),
    block("area"),
    block("where"),
    offline
  );

  async function move(kind: ContextKind, from: number, to: number) {
    const order = liveContexts(kind).map((c) => c.id);
    if (to < 0 || to >= order.length) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    try {
      await reorderContexts(kind, order);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't move it", { icon: "wifiOff" });
    }
  }

  function row(kind: ContextKind, c: TodoContext, i: number, total: number): HTMLElement {
    const body = h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.name), h("span", { class: "row__meta" }, countWords(contextCount(c.id))));
    if (reordering[kind]) {
      const arrow = (dir: "up" | "down") => {
        const target = dir === "up" ? i - 1 : i + 1;
        const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "data-dir": dir, "aria-label": `Move ${c.name} ${dir}`, disabled: target < 0 || target >= total }, dir === "up" ? icons.arrowUp() : icons.arrowDown());
        b.addEventListener("click", () => void move(kind, i, target));
        return b;
      };
      return h("div", { class: "row settings__row", "data-id": c.id }, tile(c), body, h("span", { class: "settings__move" }, arrow("up"), arrow("down")));
    }
    const b = h("button", { class: "row settings__row", type: "button", "data-id": c.id, "aria-label": `${c.name}, ${countWords(contextCount(c.id))}. Edit` }, tile(c), body, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
    b.addEventListener("click", () => openContextEditor(c, kind));
    return b;
  }

  function paintKind(kind: ContextKind) {
    const live = liveContexts(kind);
    const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), KIND[kind].newLabel);
    add.addEventListener("click", () => openContextEditor(null, kind));
    const reorder = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-pressed": String(reordering[kind]) }, reordering[kind] ? "Done" : "Reorder");
    reorder.addEventListener("click", () => {
      reordering[kind] = !reordering[kind];
      paintKind(kind);
    });
    lists[kind].replaceChildren(
      live.length
        ? h("div", { class: `card card--flush list${reordering[kind] ? " is-reordering" : ""}` }, ...live.map((c, i) => row(kind, c, i, live.length)))
        : h("p", { class: "ctx-settings__empty" }, kind === "area" ? "No areas. Add one to sort to-dos by part of life." : "None yet. Add one, like Phone or Errands."),
      h("div", { class: "settings__actions" }, add, live.length > 1 ? reorder : null)
    );
  }

  function paint() {
    if (!loaded) return;
    paintKind("area");
    paintKind("where");
    offline.hidden = state !== "offline";
  }

  void loadContexts().then((r) => {
    state = r.state;
    loaded = true;
    paint();
  });
  const unsub = onContextsChange(() => {
    loaded = true;
    paint();
  });
  return { el, destroy: unsub };
}
