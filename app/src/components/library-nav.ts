/**
 * The Library's shape at runtime: lib/library-layout.ts holds the groups
 * (Notes and collections, People and places, Home and money, Health and
 * habits, the owner's own kinds, More); this adds the owner's kinds as of
 * now. The Library index (views/library.ts), the desktop sidebar and ⌘K all
 * read libraryGroups(), so they never disagree.
 *
 * Inside a section on a phone, librarySegments() is the way back and across:
 * a "Library" link, then the sections of the same group as a segmented
 * control (People · Places · Organisations …). On desktop the sidebar does
 * that job and this is hidden. Days and To do have their own tabs in the
 * dock, so they get nothing here.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import type { ViewId } from "./nav";
import { isKindView, kindView, type KindView } from "../lib/routes";
import { kindsSnapshot, onKindsChange } from "../db/custom-kinds";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { segmentItems, withKinds, type LibraryGroup, type LibraryItem } from "../lib/library-layout";

export type { LibraryGroup, LibraryItem };

export type LibrarySection = "notes" | "saved" | "recipes" | "days" | "loops" | "person" | "place" | "organisation" | "event" | "trips" | "purchases" | "money" | "house" | "health" | "habits" | "admin" | "reading" | "music" | "work" | "goals" | "graph" | "community" | KindView;

/** The section ids views pass in, as the views they are. */
const SECTION_VIEW: Record<Exclude<LibrarySection, KindView>, ViewId> = {
  notes: "notes",
  saved: "saved",
  recipes: "recipes",
  days: "days",
  loops: "loops",
  person: "people",
  place: "places",
  organisation: "organisations",
  event: "events",
  trips: "trips",
  purchases: "purchases",
  health: "health",
  habits: "habits",
  money: "money",
  house: "house",
  admin: "admin",
  reading: "reading",
  music: "music",
  work: "work",
  goals: "goals",
  graph: "graph",
  community: "community",
};

const kindIcon = (icon: string): IconName => (icon in icons ? (icon as IconName) : "folder");

/** The Library's groups, with the owner's own kinds as of now. */
export function libraryGroups(): LibraryGroup[] {
  return withKinds(
    KIND_WORD.yours,
    kindsSnapshot().map((k) => ({ view: kindView(k.id), label: k.name, icon: kindIcon(k.icon) }))
  );
}

/** Views that live in the Library: the dock's Library tab is lit on these. */
export function isLibraryView(view: ViewId): boolean {
  return view === "library" || isKindView(view) || libraryGroups().some((g) => g.items.some((i) => i.view === view));
}

const viewOf = (section: LibrarySection): ViewId => (isKindView(section) ? section : SECTION_VIEW[section]);

export function librarySegments(active: LibrarySection, go: (view: ViewId) => void): HTMLElement {
  const view = viewOf(active);
  const wrap = h("nav", { class: "lib-nav", "aria-label": "Library" });
  if (view === "days" || view === "loops") {
    wrap.hidden = true;
    return wrap;
  }
  // With sections to switch between, the way back is a round button at the start of their row, so the
  // header spends one line, not two; on its own (Graph, a lone kind of your own) it keeps its word.
  const back = h("button", { class: "lib-nav__back", type: "button", "aria-label": "Library" }, icons.back(), h("span", { class: "lib-nav__word" }, "Library"));
  back.addEventListener("click", () => go("library"));
  const seg = h("div", { class: "segmented" });
  const paint = () => {
    const items = segmentItems(libraryGroups(), view);
    seg.hidden = items.length < 2;
    wrap.classList.toggle("lib-nav--row", !seg.hidden);
    seg.replaceChildren(
      ...items.map((s) => {
        const b = h("button", { class: "segmented__item", type: "button", "aria-current": s.view === view ? "page" : undefined }, s.label);
        b.addEventListener("click", () => s.view !== view && go(s.view));
        return b;
      })
    );
  };
  paint();
  wrap.append(back, seg);
  // The row fades at whichever edge has more beyond it, so it reads as scrollable.
  const edges = () => {
    seg.classList.toggle("is-more-right", seg.scrollLeft + seg.clientWidth < seg.scrollWidth - 2);
    seg.classList.toggle("is-more-left", seg.scrollLeft > 2);
  };
  seg.addEventListener("scroll", edges, { passive: true });
  // A kind made, renamed or archived elsewhere shows up here too, while this control is on screen.
  const unsub = onKindsChange((kindId) => {
    if (!wrap.isConnected && wrap.dataset.mounted) return unsub();
    if (kindId === null) paint();
  });
  // Keep the current section in view (centred where it can be) without moving the page.
  requestAnimationFrame(() => {
    wrap.dataset.mounted = "1";
    const current = seg.querySelector<HTMLElement>('[aria-current="page"]');
    if (current && seg.scrollWidth > seg.clientWidth) seg.scrollLeft = current.offsetLeft - (seg.clientWidth - current.offsetWidth) / 2;
    edges();
  });
  return wrap;
}
