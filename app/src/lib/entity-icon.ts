/**
 * The icon for anything a link or a chip can point at. A record in one of the
 * owner's own kinds shows its kind's icon (a wine glass for Wines), from the
 * kinds this device has loaded (db/custom-kinds.ts).
 */

import { icons, type IconName } from "../components/icons";
import { kindById, kindOfRecord } from "../db/custom-kinds";
import type { CustomKind, LinkedKind } from "../types";

const BASE: Record<Exclude<LinkedKind, "record">, IconName> = {
  note: "note",
  person: "person",
  place: "pin",
  organisation: "building",
  event: "calendar",
  project: "project",
  // As their @-mention chips show them (editor/link-render.ts).
  saved: "bookmark",
  commitment: "check",
  reading: "tv",
};

/** A kind's own icon by name, or a folder when it names none this app has. */
export const kindIcon = (kind: Pick<CustomKind, "icon"> | undefined): IconName => (kind && kind.icon in icons ? (kind.icon as IconName) : "folder");

/**
 * `id`: a record's own id, for when only a link to it is at hand (its kind is looked up).
 * `subtitle`: a Watch & read title's kind as the server words it ("Book"): a book shows a book, the rest a TV.
 */
export function entityIcon(kind: LinkedKind, kindId?: string | null, id?: string, subtitle?: string): IconName {
  if (kind === "reading" && subtitle?.toLowerCase() === "book") return "book";
  if (kind !== "record") return BASE[kind];
  const k = kindId ?? (id ? kindOfRecord(id) : undefined);
  return kindIcon(k ? kindById(k) : undefined);
}
