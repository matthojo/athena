/**
 * Display names and icons for layer 2 — commitment kinds, interaction
 * channels, life-admin kinds, watch & read kinds — so every surface (Home, Tasks,
 * the person profile, the weekly review, Archived) says the same thing.
 */

import { KIND_WORD } from "../../../lib/custom-kind-words";
import type { IconName } from "../components/icons";
import { KIND_WORDS, READING_KINDS, type KindWords } from "../../../lib/watch-read";
import type { ArchivableKind, AssetKind, CommitmentKind, InteractionChannel, LogisticsKind, MemoryKind, ReadingKind, SuggestionOp } from "../types";

/**
 * In the app a to-do with a person attached is just "To do · For Priya";
 * the separate i_owe kind (something promised to someone) stays underneath
 * for agents and the API.
 */
export const COMMITMENT_META: Record<CommitmentKind, { label: string; short: string; icon: IconName }> = {
  todo: { label: "To do", short: "To do", icon: "circle" },
  i_owe: { label: "To do", short: "For", icon: "send" },
  waiting_on: { label: "Waiting on", short: "Waiting on", icon: "hourglass" },
  decision: { label: "Decision", short: "Decided", icon: "flag" },
};

export const CHANNEL_META: Record<InteractionChannel, { label: string; verb: string; icon: IconName }> = {
  meeting: { label: "Meeting", verb: "Met", icon: "people" },
  call: { label: "Call", verb: "Called", icon: "phone" },
  message: { label: "Message", verb: "Messaged", icon: "chat" },
  email: { label: "Email", verb: "Emailed", icon: "mail" },
  in_person: { label: "In person", verb: "Saw", icon: "person" },
  other: { label: "Other", verb: "Caught up", icon: "check" },
};

export const ASSET_META: Record<AssetKind, { label: string; icon: IconName; verb: "renews" | "expires" | "due" }> = {
  passport: { label: "Passport", icon: "idCard", verb: "expires" },
  licence: { label: "Licence", icon: "idCard", verb: "expires" },
  insurance: { label: "Insurance", icon: "shield", verb: "renews" },
  vehicle: { label: "Vehicle", icon: "car", verb: "due" },
  warranty: { label: "Warranty", icon: "shield", verb: "expires" },
  subscription: { label: "Subscription", icon: "refresh", verb: "renews" },
  home: { label: "Home", icon: "home", verb: "due" },
  pet: { label: "Pet", icon: "paw", verb: "due" },
  health: { label: "Health", icon: "heart", verb: "due" },
  other: { label: "Other", icon: "folder", verb: "due" },
};

const READING_ICON: Record<ReadingKind, IconName> = {
  book: "book",
  film: "film",
  tv: "tv",
  article: "note",
  video: "play",
  podcast: "mic",
  music: "music",
  game: "game",
  paper: "notes",
  other: "link",
};

/**
 * Watch & read kinds, in the order the sheet offers them: the label, icon,
 * status words ("To watch · Watching · Watched") and what the author field is
 * called ("Director"; null hides it). The words are lib/watch-read.ts's.
 */
export const READING_META = Object.fromEntries(READING_KINDS.map((k) => [k, { ...KIND_WORDS[k], icon: READING_ICON[k] }])) as Record<
  ReadingKind,
  KindWords & { icon: IconName }
>;

/** A Watch & read item's kind, read safely: one this build doesn't know shows as Other. */
export const readingMeta = (kind: string): KindWords & { icon: IconName } => READING_META[kind as ReadingKind] ?? READING_META.other;

export const SUGGESTION_META: Record<SuggestionOp, { label: string; icon: IconName }> = {
  commitment: { label: "To do", icon: "loop" },
  fact: { label: "Something to remember", icon: "sparkle" },
  interaction: { label: "Catch-up", icon: "chat" },
  event: { label: "Date", icon: "calendar" },
  person: { label: "Person", icon: "person" },
  link: { label: "Connection", icon: "link" },
  booking: { label: "Booking", icon: "suitcase" },
  purchase: { label: "Order", icon: "parcel" },
};

/**
 * Every archivable kind: icon + singular label (the Archived page, menus,
 * toasts). `noun` is what a sentence calls one when the label isn't a noun
 * ("This item and its links…"); otherwise the label is used in lower case.
 */
export const KIND_META: Record<ArchivableKind, { icon: IconName; label: string; noun?: string }> = {
  note: { icon: "note", label: "Note" },
  person: { icon: "person", label: "Person" },
  place: { icon: "pin", label: "Place" },
  organisation: { icon: "building", label: "Organisation" },
  event: { icon: "calendar", label: "Event" },
  project: { icon: "project", label: "Project" },
  commitment: { icon: "loop", label: "To-do" },
  interaction: { icon: "chat", label: "Catch-up" },
  fact: { icon: "sparkle", label: "Fact" },
  asset: { icon: "shield", label: "Life admin" },
  reading: { icon: "bookmark", label: "Watch & read", noun: "item" },
  goal: { icon: "target", label: "Goal" },
  trip: { icon: "suitcase", label: "Trip" },
  booking: { icon: "ticket", label: "Booking" },
  purchase: { icon: "parcel", label: "Purchase" },
  // The owner's own records and kinds: an item's own icon and kind name win where it has them (views/archived.ts).
  record: { icon: "folder", label: "Record" },
  kind: { icon: "folder", label: KIND_WORD.One },
};

export const isLogisticsKind = (kind: ArchivableKind): kind is LogisticsKind => ["trip", "booking", "purchase"].includes(kind);

/** "Renews in 9 days" / "Expired 3 days ago" / "Due today" for a life-admin item. */
export function renewalLabel(kind: AssetKind, daysUntil: number): string {
  const verb = ASSET_META[kind].verb;
  if (daysUntil === 0) return verb === "due" ? "Due today" : `${verb === "renews" ? "Renews" : "Expires"} today`;
  if (daysUntil === 1) return verb === "due" ? "Due tomorrow" : `${verb === "renews" ? "Renews" : "Expires"} tomorrow`;
  if (daysUntil > 0) {
    const span = daysUntil < 60 ? `${daysUntil} days` : daysUntil < 730 ? `${Math.round(daysUntil / 30)} months` : `${Math.round(daysUntil / 365)} years`;
    return verb === "due" ? `Due in ${span}` : `${verb === "renews" ? "Renews" : "Expires"} in ${span}`;
  }
  const ago = -daysUntil;
  const span = `${ago} ${ago === 1 ? "day" : "days"} ago`;
  return verb === "renews" ? `Lapsed ${span}` : verb === "expires" ? `Expired ${span}` : `Overdue by ${ago} ${ago === 1 ? "day" : "days"}`;
}

export const isMemoryKind = (kind: ArchivableKind): kind is MemoryKind =>
  ["commitment", "interaction", "fact", "asset", "reading", "goal"].includes(kind);
