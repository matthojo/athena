/**
 * Saved actions, the pure half (shared with the app, which uses it in sample
 * mode): what each built-in action is called, when it fits and what it
 * needs, how an item reads on a list or as a to-do, and how the list of
 * actions for an item is ordered. lib/saved-actions.ts adds run().
 */
import { detectFromUrl, priceText, thingDetail, type SavedThing } from "./saved-kinds";
import type { SavedItem } from "./saved-rules";

/** Something an action needs from the owner. The app draws a picker for each kind. */
export interface ActionParam {
  name: string;
  /** person: a person picker. list: a checklist note (pick one, or type a new list's name). target: a person, note or project. text: free text. */
  kind: "person" | "list" | "target" | "text";
  label: string;
  required: boolean;
  /** For text: what's there if the owner changes nothing. */
  suggested?: string;
}

/** What an action is, without how it runs. */
export interface ActionSpec {
  /** Stable id: what the API, MCP and Ask call it by ("gift_idea"). */
  id: string;
  /** The button: "Move to Watch & read", "Gift idea for…". */
  label: string | ((item: SavedItem) => string);
  /** One of the app's icon names (app/src/components/icons.ts). */
  icon: string;
  /** Does it make sense for this item? */
  appliesTo(item: SavedItem): boolean;
  /** How good a fit, higher first; the best is the item's suggested action. Default 1. */
  fit?(item: SavedItem): number;
  params?: ActionParam[] | ((item: SavedItem) => ActionParam[]);
}

/** An action as the API lists it. */
export interface ActionInfo {
  id: string;
  label: string;
  icon: string;
  params: ActionParam[];
  /** The best fit for this item: the app shows it as the main button. */
  suggested: boolean;
}

/** What it is: the stored reading, or what its address says (items saved before 0039). */
export function thingOf(item: SavedItem): SavedThing | null {
  if (item.thing) return item.thing;
  if (item.kind === "image") return "image";
  return item.kind === "link" ? (detectFromUrl(item.url)?.type ?? null) : null;
}

/** The actions that fit, best first (ties keep the order they were added). Nothing for an archived item; nothing suggested for a filed one. */
export function describeActions(specs: Iterable<ActionSpec>, item: SavedItem): ActionInfo[] {
  if (item.archived) return [];
  const fits = [...specs]
    .filter((a) => a.appliesTo(item))
    .map((a, i) => ({ a, fit: a.fit?.(item) ?? 1, i }))
    .sort((x, y) => y.fit - x.fit || x.i - y.i);
  return fits.map(({ a }, i) => ({
    id: a.id,
    label: typeof a.label === "function" ? a.label(item) : a.label,
    icon: a.icon,
    params: typeof a.params === "function" ? a.params(item) : (a.params ?? []),
    suggested: i === 0 && !item.filed,
  }));
}

/** The item's own name: the thing's name, the page's title, or the start of a note. */
export function itemName(item: SavedItem): string {
  const raw = item.facts?.name ?? item.title ?? item.quote ?? item.note ?? item.site ?? "Saved item";
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > 90 ? `${one.slice(0, 89).trimEnd()}…` : one;
}

export const linkOf = (item: SavedItem) => item.url ?? item.source_url;

/** How it reads on a list: "[Green wrap dress](https://…) · £45 · COS". Markdown, like Ask's add_to_list. */
export function listLine(item: SavedItem): string {
  const name = itemName(item).replace(/[[\]]/g, "");
  const url = linkOf(item);
  const thing = thingOf(item);
  const detail = thing ? thingDetail(thing, item.facts ?? {}) : undefined;
  const extra = detail ?? (thing === "product" ? priceText(item.facts ?? {}) : undefined) ?? (url ? item.site : undefined);
  return [url && /^https?:\/\//.test(url) ? `[${name}](${url})` : name, extra].filter(Boolean).join(" · ");
}

const VERB: Partial<Record<SavedThing, string>> = { book: "Read", article: "Read", film: "Watch", show: "Watch", video: "Watch", product: "Buy", recipe: "Cook", place: "Visit", event: "Go to" };

/** "Read: Lapvona", "Buy: Green wrap dress"; a note or quote as it is. */
export function todoTitle(item: SavedItem): string {
  const thing = thingOf(item);
  const verb = thing ? VERB[thing] : item.kind === "link" ? "Read" : undefined;
  return (verb ? `${verb}: ${itemName(item)}` : itemName(item)).slice(0, 200);
}

const isThing = (...types: SavedThing[]) => (item: SavedItem) => types.includes(thingOf(item) as SavedThing);

/** The built-ins, in the order they're listed when they fit equally well. */
export const BUILTIN: Record<"watch_read" | "gift_idea" | "add_to_list" | "save_place" | "make_todo" | "link", ActionSpec> = {
  watch_read: { id: "watch_read", label: "Move to Watch & read", icon: "book", appliesTo: isThing("book", "film", "show", "video"), fit: () => 10 },
  gift_idea: {
    id: "gift_idea",
    label: "Gift idea for…",
    icon: "gift",
    appliesTo: (item) => isThing("product", "book", "film", "show", "event", "image", "recipe")(item) || (item.kind === "link" && !thingOf(item)),
    fit: (item) => (thingOf(item) === "product" ? 9 : 3),
    params: [{ name: "person_id", kind: "person", label: "Who it's for", required: true }],
  },
  add_to_list: {
    id: "add_to_list",
    label: "Add to a list or note",
    icon: "checklist",
    appliesTo: () => true,
    fit: (item) => (thingOf(item) === "product" ? 5 : thingOf(item) === "recipe" ? 6 : 2),
    params: [
      { name: "note_id", kind: "list", label: "Which list", required: false },
      { name: "list_title", kind: "text", label: "Or a new list's name", required: false },
    ],
  },
  save_place: { id: "save_place", label: "Save to Places", icon: "pin", appliesTo: isThing("place"), fit: () => 10 },
  make_todo: {
    id: "make_todo",
    label: "Make a to-do",
    icon: "check",
    appliesTo: () => true,
    fit: (item) => (["event", "recipe"].includes(thingOf(item) ?? "") ? 4 : 1),
    params: (item) => [{ name: "title", kind: "text", label: "To-do", required: false, suggested: todoTitle(item) }],
  },
  link: {
    id: "link",
    label: "Link to a person, note or project",
    icon: "link",
    appliesTo: () => true,
    fit: () => 0,
    params: [{ name: "target", kind: "target", label: "Link to", required: true }],
  },
};
