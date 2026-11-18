/**
 * How the owner's own fields look across the app: an icon per type and per
 * kind of record, and the one line that describes a field in Settings.
 */

import type { IconName } from "../components/icons";
import { FIELD_TYPE_INFO, customKindId, isCustomKind, type CustomField, type FieldKind, type FieldType } from "../../../lib/custom-field-rules";
import { kindById } from "../db/custom-kinds";
import { kindIcon } from "./entity-icon";

export const FIELD_TYPE_ICON: Record<FieldType, IconName> = {
  text: "text",
  long_text: "paragraph",
  number: "hash",
  rating: "star",
  boolean: "toggle",
  date: "calendar",
  link: "link",
  choice: "radio",
  choices: "tag",
};

/** Kinds without an icon of their own fall back to the fields icon; the owner's own kinds show theirs. */
const KIND_ICON: Partial<Record<FieldKind, IconName>> = {
  person: "person",
  place: "pin",
  organisation: "building",
  event: "calendar",
  note: "note",
  reading: "bookmark",
  goal: "target",
  asset: "shield",
  project: "project",
};

export const fieldKindIcon = (kind: FieldKind): IconName => (isCustomKind(kind) ? kindIcon(kindById(customKindId(kind))) : (KIND_ICON[kind] ?? "sliders"));

const KIND_KEY = "athena.fieldsKind";

/** Which kind's fields Settings shows (Settings remembers it; Ask's receipts set it before opening Settings). */
export function rememberFieldsKind(kind: string): void {
  try {
    sessionStorage.setItem(KIND_KEY, kind);
  } catch {
    // private mode: Settings opens on People
  }
}

export function lastFieldsKind(): string | null {
  try {
    return sessionStorage.getItem(KIND_KEY);
  } catch {
    return null;
  }
}

/** "Number · UK", "Choices · Climbing, Jazz and 2 more", "Rating". */
export function fieldSummary(field: CustomField): string {
  const type = FIELD_TYPE_INFO[field.type].label;
  // A field named for its type ("Rating") says what the type is instead of repeating it.
  if (field.label.toLowerCase() === type.toLowerCase() && !field.unit && !field.options.length) return FIELD_TYPE_INFO[field.type].hint;
  if (field.type === "number" && field.unit) return `${type} · ${field.unit}`;
  if (field.type === "choice" || field.type === "choices") {
    if (!field.options.length) return `${type} · no options yet`;
    const shown = field.options.length > 3 ? 2 : 3;
    const more = field.options.length - shown;
    return `${type} · ${field.options.slice(0, shown).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  }
  return type;
}
