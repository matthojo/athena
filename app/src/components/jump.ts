/**
 * ⌘K, "Search or jump to…": one box that searches your notes, asks about
 * what you typed (⌘J opens Ask itself), or takes
 * you to a place (Home, Days, Inbox, a Library section, a Settings page).
 * Typing filters the places. The first row searches notes for what you typed,
 * unless a place's name starts with it ("tr" → Trips): then that place leads.
 * Arrow keys move, Enter goes, Escape closes. A native <dialog>, so focus is
 * trapped and the page behind is inert.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { dayIcons } from "./day-icons";
import { libraryGroups } from "./library-nav";
import type { ViewId } from "./nav";
import { liveContexts } from "../db/todo-contexts";
import { readTodoView, writeTodoView } from "../lib/todo-view";

export interface JumpPlace {
  view: ViewId;
  /** A Settings section, for places inside Settings. */
  noteId?: string;
  label: string;
  /** Where it sits, shown quietly beside the name. */
  where: string;
  icon: () => Element;
  /** Other words people use for it ("review" finds Inbox). */
  also?: string;
  /** To do filtered to one context ("To do: Errands"). */
  context?: { kind: "area" | "where"; id: string };
}

/** Other words for Library sections. */
const ALSO: Partial<Record<ViewId, string>> = { saved: "bookmarks links clippings read later articles quotes" };

/** Everywhere ⌘K can take you, in the order it lists them. */
export function jumpPlaces(): JumpPlace[] {
  const lib: JumpPlace[] = [{ view: "library", label: "Library", where: "", icon: icons.library }];
  for (const g of libraryGroups()) {
    for (const i of g.items) lib.push({ view: i.view, label: i.label, where: g.id === "more" ? "" : "Library", icon: icons[i.icon as IconName], also: ALSO[i.view] });
  }
  return [
    { view: "home", label: "Home", where: "", icon: icons.home, also: "today" },
    { view: "days", label: "Days", where: "", icon: dayIcons.days, also: "today calendar journal mood" },
    { view: "loops", label: "To do", where: "", icon: icons.loop, also: "tasks loops waiting" },
    { view: "ask", label: "Ask", where: "", icon: icons.chat, also: "question chat assistant" },
    { view: "team", label: "Team", where: "", icon: icons.team, also: "assistants helpers agents" },
    { view: "review", label: "Inbox", where: "Check in", icon: icons.inbox, also: "review suggestions" },
    { view: "week", label: "This week", where: "Check in", icon: icons.week, also: "weekly review" },
    ...lib,
    { view: "settings", noteId: "sources", label: "Sources", where: "Settings", icon: icons.plug, also: "connectors accounts connect" },
    { view: "settings", noteId: "fields", label: "Your fields", where: "Settings", icon: icons.sliders },
    { view: "settings", noteId: "voice", label: "Voice", where: "Settings", icon: icons.mic },
    { view: "settings", noteId: "iphone", label: "From your iPhone", where: "Settings", icon: icons.phone, also: "shortcut siri" },
    { view: "settings", noteId: "api-keys", label: "API keys", where: "Settings", icon: icons.key },
    { view: "settings", noteId: "notifications", label: "Notifications", where: "Settings", icon: icons.bell, also: "push alerts quiet" },
    { view: "settings", noteId: "reminders", label: "Reminders", where: "Settings", icon: icons.clock, also: "remind alarm" },
    { view: "settings", noteId: "todo", label: "To-do contexts", where: "Settings", icon: icons.loop, also: "areas where how" },
    // To do, filtered to each context.
    ...(["area", "where"] as const).flatMap((kind) =>
      liveContexts(kind).map((c) => ({ view: "loops" as ViewId, label: `To do: ${c.name}`, where: kind === "area" ? "Area" : "Where", icon: icons[(c.icon in icons ? c.icon : "tag") as IconName], also: "tasks filter", context: { kind, id: c.id } }))
    ),
  ];
}

/** Places whose name (or other words for it) contain every word typed. */
export function matchPlaces(places: JumpPlace[], q: string): JumpPlace[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return places;
  return places.filter((p) => {
    const hay = `${p.label} ${p.where} ${p.also ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function openJump(actions: {
  go: (view: ViewId, opts?: { noteId?: string | null }) => void;
  searchNotes: (q: string) => void;
  /** Ask about what was typed (lib/open-ask.ts). */
  ask?: (q: string) => void;
}): void {
  if (document.querySelector("dialog.jump")) return;
  const places = jumpPlaces();
  const input = h("input", {
    class: "jump__input",
    type: "search",
    placeholder: "Search or jump to…",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Search notes or jump to a place",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "jump-list",
  }) as HTMLInputElement;
  const list = h("div", { class: "jump__list", id: "jump-list", role: "listbox", "aria-label": "Places" });
  const dialog = h(
    "dialog",
    { class: "jump", "aria-label": "Search or jump to" },
    h("div", { class: "jump__field" }, icons.search(), input, h("kbd", {}, "esc")),
    list
  ) as HTMLDialogElement;

  type Choice = { el: HTMLElement; run: () => void };
  let choices: Choice[] = [];
  let at = 0;

  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const choose = (c: Choice | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  const highlight = (i: number) => {
    at = Math.max(0, Math.min(i, choices.length - 1));
    choices.forEach((c, n) => c.el.setAttribute("aria-selected", String(n === at)));
    const el = choices[at]?.el;
    if (el) {
      input.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
    }
  };
  const row = (id: string, icon: Element, label: string, where: string, run: () => void): Choice => {
    const el = h(
      "div",
      { class: "jump__row", role: "option", id, "aria-selected": "false" },
      h("span", { class: "jump__icon" }, icon),
      h("span", { class: "jump__label" }, label),
      where ? h("span", { class: "jump__where" }, where) : null
    );
    const c = { el, run };
    el.addEventListener("click", () => choose(c));
    el.addEventListener("mousemove", () => at !== choices.indexOf(c) && highlight(choices.indexOf(c)));
    return c;
  };

  const paint = () => {
    const q = input.value.trim();
    const found = matchPlaces(places, q);
    const places_ = found.map((p, i) => row(`jump-${i}`, p.icon(), p.label, p.where, () => {
      // "To do: Errands": that one filter, the other cleared.
      if (p.context) writeTodoView({ ...readTodoView(), area: p.context.kind === "area" ? p.context.id : null, where: p.context.kind === "where" ? p.context.id : null });
      actions.go(p.view, { noteId: p.noteId ?? null });
    }));
    const search = q
      ? [
          row("jump-search", icons.notes(), `Search notes for “${q}”`, "", () => actions.searchNotes(q)),
          ...(actions.ask ? [row("jump-ask", icons.chat(), `Ask about “${q}”`, "Ask", () => actions.ask!(q))] : []),
        ]
      : [];
    // A place whose name starts with what was typed ("tr" → Trips) comes first, so Enter goes there.
    const named = !!q && found.some((p) => p.label.toLowerCase().replace(/:/g, "").startsWith(q.toLowerCase().replace(/:/g, "")));
    const head = q && found.length ? [h("p", { class: "jump__head" }, "Go to")] : [];
    choices = named ? [...places_, ...search] : [...search, ...places_];
    list.replaceChildren(...(named ? [...head, ...places_.map((c) => c.el), ...search.map((c) => c.el)] : [...search.map((c) => c.el), ...head, ...places_.map((c) => c.el)]));
    highlight(0);
  };

  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(at - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(choices[at]);
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => e.target === dialog && close());

  paint();
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
