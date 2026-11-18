/**
 * The Library's groups as plain data, so the index, the desktop sidebar, ⌘K
 * and the phone's segmented control all read one list (and tests can too).
 *
 * Small groups on purpose: a phone shows a group's sections as one segmented
 * row, which stays readable up to about five. Four built-in groups, then the
 * owner's own kinds, then More:
 *  - Notes and collections: what you write or keep (notes, saved things, what
 *    you watch and read, what you play, recipes).
 *  - People and places: who and where, and the plans that join them (events,
 *    trips).
 *  - Home and money: the house (energy, bills), what you pay for, what's
 *    being delivered, what renews.
 *  - Health, habits and work: your body, your routines, what you're working
 *    towards, and what you shipped.
 */

import type { ViewId } from "../components/nav";
import type { IconName } from "../components/icons";

export type LibraryGroupId = "notes" | "people" | "home" | "you" | "kinds" | "more";

export interface LibraryItem {
  view: ViewId;
  label: string;
  icon: IconName;
}

export interface LibraryGroup {
  id: LibraryGroupId;
  label: string;
  items: LibraryItem[];
}

/** Every built-in group; "kinds" is filled with the owner's own kinds at runtime. */
export const LIBRARY_LAYOUT: readonly LibraryGroup[] = [
  {
    id: "notes",
    label: "Notes and collections",
    items: [
      { view: "notes", label: "Notes", icon: "notes" },
      { view: "saved", label: "Saved", icon: "bookmark" },
      { view: "reading", label: "Watch & read", icon: "film" },
      { view: "music", label: "Music", icon: "music" },
      { view: "recipes", label: "Recipes", icon: "pot" },
    ],
  },
  {
    id: "people",
    label: "People and places",
    items: [
      { view: "people", label: "People", icon: "person" },
      { view: "places", label: "Places", icon: "pin" },
      { view: "organisations", label: "Organisations", icon: "building" },
      { view: "events", label: "Events", icon: "calendar" },
      { view: "trips", label: "Trips", icon: "suitcase" },
    ],
  },
  {
    id: "home",
    label: "Home and money",
    items: [
      { view: "house", label: "House", icon: "home" },
      { view: "money", label: "Money", icon: "wallet" },
      { view: "purchases", label: "Purchases", icon: "parcel" },
      { view: "admin", label: "Life admin", icon: "shield" },
    ],
  },
  {
    id: "you",
    label: "Health, habits and work",
    items: [
      { view: "health", label: "Health", icon: "heart" },
      { view: "habits", label: "Habits", icon: "flame" },
      { view: "goals", label: "Goals", icon: "target" },
      { view: "work", label: "Work", icon: "work" },
    ],
  },
  { id: "kinds", label: "", items: [] },
  {
    id: "more",
    label: "More",
    items: [
      { view: "graph", label: "Graph", icon: "graph" },
      { view: "archived", label: "Archived", icon: "archive" },
      { view: "settings", label: "Settings", icon: "sliders" },
    ],
  },
];

/** The layout with the owner's own kinds put in their group. */
export function withKinds(kindsLabel: string, kinds: LibraryItem[]): LibraryGroup[] {
  return LIBRARY_LAYOUT.map((g) => (g.id === "kinds" ? { ...g, label: kindsLabel, items: kinds } : { ...g, items: [...g.items] }));
}

/** The group a view belongs to, if any. */
export function groupOf(groups: readonly LibraryGroup[], view: ViewId): LibraryGroup | undefined {
  return groups.find((g) => g.items.some((i) => i.view === view));
}

/**
 * What a phone's segmented control shows inside a section: the other
 * sections of its group. More (Graph, Archived, Settings) isn't a set you
 * move across, and a group of one has nothing to switch to.
 */
export function segmentItems(groups: readonly LibraryGroup[], view: ViewId): LibraryItem[] {
  const g = groupOf(groups, view);
  if (!g || g.id === "more" || g.items.length < 2) return [];
  return g.items;
}
