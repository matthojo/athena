/**
 * The hash routes, as pure functions so they can be tested: parseRoute reads
 * a hash (old addresses included, redirected to where they live now) and
 * routeHash writes the canonical one. main.ts renders whatever they say.
 */

import type { RecordKind } from "../types";
import type { ViewId } from "../components/nav";
import { weekStart } from "../components/day-words";
import { localToday } from "./time";

/** One of the owner's own kinds of record: its records, at #/kind/<id>. */
export type KindView = `kind:${string}`;

export const kindView = (id: string): KindView => `kind:${id}`;
export const isKindView = (view: string): view is KindView => view.startsWith("kind:");
export const kindIdOf = (view: KindView): string => view.slice("kind:".length);

export interface Route {
  view: ViewId;
  /** A Library source (#/notes?source=…); in Settings, the account a sign-in came back with. */
  source: string | null;
  /** A note id (#/notes/<id>), a record id (#/people/<id> …) or a Settings section. */
  noteId: string | null;
  /** The folder open in Notes (#/notes?folder=<id>). */
  folder?: string | null;
  /** A tag open in Notes (#/notes?tag=ai%2Fopenai). */
  tag?: string | null;
  /** Notes with no tag (#/notes?untagged=1). */
  untagged?: boolean;
}

export const RECORD_VIEWS: Partial<Record<ViewId, RecordKind>> = {
  people: "person",
  places: "place",
  organisations: "organisation",
  events: "event",
};
export const VIEW_FOR_KIND: Record<RecordKind, ViewId> = { person: "people", place: "places", organisation: "organisations", event: "events" };

/** Views with no id or source in their route: #/<view>. */
export const PLAIN_VIEWS: ViewId[] = ["library", "ask", "archived", "loops", "admin", "reading", "music", "work", "goals", "health", "habits", "money", "house", "review", "settings", "team"];

/** Week in review for the week holding `today`: where #/week (the old weekly review) and "This week" go now. */
export const thisWeekPath = (today = localToday()): string => `week/${weekStart(today)}`;

/** #/checkin/<kind> or #/checkin/<kind>/<date> (the check-in pushes, lib/checkin-types.ts): a check-in to open over the page. */
export function parseCheckin(hash: string): { kind: "morning" | "evening"; date: string | null } | null {
  const [view, kind, date] = hash.replace(/^#\/?/, "").split("?")[0].split("/");
  if (view !== "checkin" || (kind !== "morning" && kind !== "evening")) return null;
  return { kind, date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
}

export function parseRoute(hash: string, today = localToday()): Route {
  const [path, qs] = hash.replace(/^#\/?/, "").split("?");
  const [view, id] = path.split("/");
  const source = new URLSearchParams(qs ?? "").get("source");
  if (view === "notes") {
    const p = new URLSearchParams(qs ?? "");
    const folder = p.get("folder");
    const tag = p.get("tag");
    const scope = folder ? { folder } : tag ? { tag } : p.get("untagged") === "1" ? { untagged: true } : {};
    return { view: "notes", source, noteId: id ? decodeURIComponent(id) : null, ...scope };
  }
  // #/checkin/…: Home underneath, with the check-in open over it (parseCheckin).
  if (view === "checkin") return { view: "home", source: null, noteId: null };
  // #/kind/<kind id>, or #/kind/<kind id>/<record id>: one of the owner's own kinds of record.
  if (view === "kind" && id) {
    const recordId = path.split("/")[2];
    return { view: kindView(decodeURIComponent(id)), source: null, noteId: recordId ? decodeURIComponent(recordId) : null };
  }
  // #/graph, or #/graph/<id> with something selected.
  if (view === "graph") return { view: "graph", source: null, noteId: id ? decodeURIComponent(id) : null };
  // #/days, #/days/<date>, #/days/calendar?m=…, #/days/week/<monday>, #/days/search?q=…: Days keeps its own query.
  if (view === "days") return { view: "days", source: qs || null, noteId: path.split("/").slice(1).join("/") || null };
  // #/week: the old weekly review, retired for Week in review (Home's card, pushes and bookmarks still say it).
  if (view === "week") return { view: "days", source: null, noteId: thisWeekPath(today) };
  // #/day/<date>: older links to a day (Ask, search) open it too.
  if (view === "day" && id) return { view: "days", source: null, noteId: id };
  // #/saved, #/saved/<id>, #/saved/shared (the share target): Saved and one item.
  if (view === "saved") return { view: "saved", source: null, noteId: id ? decodeURIComponent(id) : null };
  // #/recipes, #/recipes/<id>, #/recipes/<id>/cook, #/recipes/plan, #/recipes/list: Recipes keeps its own path.
  if (view === "recipes") return { view: "recipes", source: null, noteId: path.split("/").slice(1).map(decodeURIComponent).join("/") || null };
  // #/health, #/health/wellness: Health's Body and Wellness tabs.
  if (view === "health") return { view: "health", source: null, noteId: id === "wellness" ? "wellness" : null };
  // #/trips/<id>, #/purchases/<id>: a push or Coming up opening one.
  if (view === "trips" || view === "purchases") return { view, source: null, noteId: id ? decodeURIComponent(id) : null };
  // #/settings, or #/settings/<section> (fields, sources, voice, iphone, api-keys; accounts and collections open sources).
  // #/settings/accounts?connected=<id> is where an account sign-in returns to.
  // #/settings/skills/<id> (or …/new): one of Ask's skills, a page of its own.
  if (view === "settings" && id === "skills" && path.split("/")[2]) return { view: "settings", source: null, noteId: `skills/${decodeURIComponent(path.split("/")[2])}` };
  // #/settings/appearance/<id>: Appearance with one of the person's themes open in its editor.
  if (view === "settings" && id === "appearance" && path.split("/")[2]) return { view: "settings", source: null, noteId: `appearance/${decodeURIComponent(path.split("/")[2])}` };
  if (view === "settings") return { view: "settings", source: new URLSearchParams(qs ?? "").get("connected"), noteId: id ? decodeURIComponent(id) : null };
  // Connectors moved into Settings: old links (and sign-ins started before the move) land there.
  if (view === "connectors") {
    const params = new URLSearchParams(qs ?? "");
    return { view: "settings", source: params.get("connected"), noteId: params.get("open") === "elevenlabs" ? "voice" : "accounts" };
  }
  // Reminders moved into Settings, beside Notifications; pushes still link to #/reminders.
  if (view === "reminders") return { view: "settings", source: null, noteId: "reminders" };
  // #/team, #/team/<id>, #/team/new: the Team, one assistant, or setup.
  // #/team/chat, #/team/chat/<post id>, #/team/assignment/<id>: Team chat (at a post) and one assignment keep their path.
  if (view === "team") return { view: "team", source: null, noteId: path.split("/").slice(1).map(decodeURIComponent).join("/") || null };
  // #/flows, #/flows/new, #/flows/<id>, #/flows/runs/<run id>: Flows, a new one, one flow, or one run.
  if (view === "flows") return { view: "flows", source: null, noteId: path.split("/").slice(1).map(decodeURIComponent).join("/") || null };
  // #/community, #/community?kind=flow: the Community catalogue, filtered by kind (app/src/community/page.ts).
  if (view === "community") return { view: "community", source: qs || null, noteId: null };
  // #/add, #/add?catalogue=<id>, #/add?link=<url>: the preview every shared item goes through (app/src/add/). Its query rides in `source`.
  if (view === "add") return { view: "add", source: qs || null, noteId: null };
  // #/ask/nudge/<id>: a nudge's push opening Ask on it (lib/ask-nudge.ts).
  if (view === "ask" && id === "nudge") return { view: "ask", source: null, noteId: path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : null };
  if (PLAIN_VIEWS.includes(view as ViewId)) return { view: view as ViewId, source: null, noteId: null };
  if (RECORD_VIEWS[view as ViewId]) return { view: view as ViewId, source: null, noteId: id ? decodeURIComponent(id) : null };
  return { view: "home", source: null, noteId: null };
}

export function routeHash(r: Route): string {
  if (r.view === "home") return "#/";
  if (isKindView(r.view)) return `#/kind/${encodeURIComponent(kindIdOf(r.view))}${r.noteId ? `/${encodeURIComponent(r.noteId)}` : ""}`;
  if (r.view === "days") return `#/days${r.noteId ? `/${r.noteId}` : ""}${r.source ? `?${r.source}` : ""}`;
  if (r.view === "reminders") return "#/settings/reminders";
  if (r.view === "week") return `#/days/${thisWeekPath()}`;
  if (r.view === "recipes") return `#/recipes${r.noteId ? `/${r.noteId.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  if (r.view === "settings" && r.noteId?.startsWith("skills/")) return `#/settings/skills/${encodeURIComponent(r.noteId.slice("skills/".length))}`;
  if (r.view === "settings" && r.noteId?.startsWith("appearance/")) return `#/settings/appearance/${encodeURIComponent(r.noteId.slice("appearance/".length))}`;
  if (r.view === "settings") return `#/settings${r.noteId ? `/${encodeURIComponent(r.noteId)}` : ""}`;
  if (r.view === "team") return `#/team${r.noteId ? `/${r.noteId.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  if (r.view === "community") return `#/community${r.source ? `?${r.source}` : ""}`;
  if (r.view === "flows") return `#/flows${r.noteId ? `/${r.noteId.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  if (r.view === "add") return `#/add${r.source ? `?${r.source}` : ""}`;
  if (r.view === "health") return `#/health${r.noteId === "wellness" ? "/wellness" : ""}`;
  if (PLAIN_VIEWS.includes(r.view)) return `#/${r.view}`;
  if (RECORD_VIEWS[r.view] || r.view === "graph" || r.view === "saved" || r.view === "trips" || r.view === "purchases") return `#/${r.view}${r.noteId ? `/${encodeURIComponent(r.noteId)}` : ""}`;
  const params = new URLSearchParams();
  if (r.source !== null) params.set("source", r.source);
  if (r.folder) params.set("folder", r.folder);
  else if (r.tag) params.set("tag", r.tag);
  else if (r.untagged) params.set("untagged", "1");
  const qs = params.toString();
  return `#/notes${r.noteId ? `/${encodeURIComponent(r.noteId)}` : ""}${qs ? `?${qs}` : ""}`;
}
