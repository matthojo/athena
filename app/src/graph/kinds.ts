/**
 * What each kind of thing on the graph is called, looks like and opens to.
 * Pages (notes, people, places, organisations, events and the owner's own
 * records, one colour for every kind of those) are solid dots in their own colour; the layer-2 details that hang off them (catch-ups,
 * to-dos, facts, watch & read) are small rings in one quiet colour, so the five
 * kinds you navigate by stay the loud ones. Colours are design tokens in
 * styles/graph.css (--graph-<kind>), light and dark.
 */

import type { IconName } from "../components/icons";
import { CHANNEL_META, COMMITMENT_META, readingMeta } from "../lib/memory-meta";
import { shortDate } from "../lib/format";
import { kindById } from "../db/custom-kinds";
import { entityIcon } from "../lib/entity-icon";
import type { CommitmentKind, EntityKind, GraphKind, GraphNode, InteractionChannel } from "../types";

export const PAGE_KINDS = ["person", "note", "place", "organisation", "event", "record", "saved"] as const satisfies readonly GraphKind[];
export const DETAIL_KINDS = ["interaction", "commitment", "fact", "reading"] as const satisfies readonly GraphKind[];
export const ALL_KINDS: GraphKind[] = [...PAGE_KINDS, ...DETAIL_KINDS];

export const isDetail = (kind: GraphKind): boolean => (DETAIL_KINDS as readonly GraphKind[]).includes(kind);

export const KIND_INFO: Record<GraphKind, { one: string; many: string; icon: IconName }> = {
  person: { one: "Person", many: "People", icon: "person" },
  note: { one: "Note", many: "Notes", icon: "note" },
  place: { one: "Place", many: "Places", icon: "pin" },
  organisation: { one: "Organisation", many: "Orgs", icon: "building" },
  event: { one: "Event", many: "Events", icon: "calendar" },
  // Each of the owner's own kinds is named for itself (filterLabel, describe): these are the fallbacks.
  record: { one: "Record", many: "Records", icon: "folder" },
  saved: { one: "Saved", many: "Saved", icon: "bookmark" },
  interaction: { one: "Catch-up", many: "Catch-ups", icon: "chat" },
  commitment: { one: "To-do", many: "To-dos", icon: "check" },
  fact: { one: "Fact", many: "Facts", icon: "sparkle" },
  reading: { one: "Watch & read", many: "Watch & read", icon: "tv" },
};

/** The CSS custom property holding a kind's colour (details share one). */
export const colorVar = (kind: GraphKind): string => (isDetail(kind) ? "--graph-detail" : `--graph-${kind}`);

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a filter chip stands for: a kind, or, for the owner's own records, one
 * of their kinds ("record:<kind id>"), so Wines and Plants filter apart.
 */
export const filterKey = (n: Pick<GraphNode, "kind" | "kind_id">): string => (n.kind === "record" ? `record:${n.kind_id ?? ""}` : n.kind);

/** A filter chip's name: "People", or a kind of the owner's own ("Wines"). `one` is its name for one, from a node. */
export function filterLabel(key: string, one = ""): string {
  if (!key.startsWith("record:")) return KIND_INFO[key as GraphKind]?.many ?? key;
  return kindById(key.slice("record:".length))?.name ?? (one ? `${capitalise(one)}s` : KIND_INFO.record.many);
}

/** The icon a node shows in lists and the card: a record shows its kind's. */
export const nodeIcon = (n: GraphNode) =>
  n.kind === "record" ? entityIcon("record", n.kind_id) : n.kind === "reading" && n.sub === "book" ? "book" : KIND_INFO[n.kind].icon;

/** "Wine" for a record, "Person" for a person. */
export const kindOne = (n: GraphNode) => (n.kind === "record" ? capitalise(n.sub || KIND_INFO.record.one) : KIND_INFO[n.kind].one);

/** The short label drawn beside a dot and shown in search: a catch-up is "Call, 3 Nov" rather than its summary. */
export function labelFor(n: GraphNode): string {
  if (n.kind === "interaction") {
    const channel = CHANNEL_META[n.sub as InteractionChannel]?.label ?? "Catch-up";
    return n.at ? `${channel}, ${shortDate(n.at)}` : channel;
  }
  return n.title.trim() || "Untitled";
}

/** The full title, for the card and the list. */
export const titleFor = (n: GraphNode): string => n.title.trim() || (n.kind === "interaction" ? labelFor(n) : "Untitled");

/** "Person · Mentee", "Catch-up · Call, 3 Nov", "To-do · Done". */
export function describe(n: GraphNode): string {
  const kind = KIND_INFO[n.kind].one;
  switch (n.kind) {
    case "note":
      return n.sub === "note" || !n.sub ? kind : `${kind} · ${capitalise(n.sub)}`;
    case "interaction":
      return `${kind} · ${labelFor(n)}`;
    case "commitment":
      return n.sub === "done" ? "To-do · Done" : COMMITMENT_META[n.sub as CommitmentKind]?.label ?? kind;
    case "fact":
      return "Something to remember";
    case "event":
      return n.sub ? `${kind} · ${capitalise(n.sub)}` : kind;
    case "reading":
      return n.sub ? `${kind} · ${readingMeta(n.sub).label}` : kind;
    case "record":
      return kindOne(n);
    case "saved":
      return n.sub ? `${kind} · ${capitalise(n.sub)}` : kind;
    default:
      return n.sub ? `${kind} · ${n.sub}` : kind;
  }
}

/** Dot radius in world units: hubs grow with the square root of their links. */
export function radiusFor(n: GraphNode): number {
  if (isDetail(n.kind)) return 3.2 + Math.min(1.8, Math.sqrt(n.degree) * 0.5);
  const base = n.kind === "person" ? 6.5 : n.kind === "note" ? 4.6 : 5.6;
  return Math.min(base + Math.sqrt(n.degree) * 2.3, 24);
}

/** The kinds with their own page, which the app's open handlers take. */
export const isPage = (kind: GraphKind): kind is Exclude<EntityKind, "project"> | "saved" => !isDetail(kind);
