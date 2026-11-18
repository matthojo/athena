/**
 * Ask's assistant and the owner's own fields: "add a shoe size field to
 * people", "Rowan's shoe size is 6", "rate Dune 5 stars", "Priya is into
 * climbing and jazz", "rename Grape to Grapes", "put Rating first", "archive
 * the Region field". Kept beside lib/assistant.ts, which lists these tools
 * with its own, runs them through runFieldTool() and undoes their changes
 * through applyFieldUndo().
 *
 * Inventing a field is the owner's call: the prompt has the assistant ask
 * first (ask_owner) unless the owner asked for the field by name, and a
 * field is only changed when the owner asks. Every change comes back as a
 * receipt with Open and Undo; undo archives a field it made, puts a value
 * back as it was, puts a field it changed back (name, type, options, unit,
 * order, and any values the change rewrote), or archives or restores it
 * again. Nothing is deleted.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import type { Change } from "./assistant";
import {
  defineField,
  fieldValues,
  findField,
  kindInfo,
  listFields,
  recordTitle,
  recordValues,
  reorderFields,
  restoreField,
  setFieldArchived,
  setValue,
  updateField,
  type FieldPatch,
} from "./custom-fields";
import { FIELD_KIND_LIST, FIELD_TYPE_INFO, FIELD_TYPES, formatValue, isCustomKind, isFieldKind, sameLabel, type BuiltinFieldKind, type FieldKind } from "./custom-field-rules";
import { KIND_WORD } from "./custom-kind-words";

/** A built-in kind, or one of the owner's own as custom:<id> (from list_kinds). */
const KIND = z.string().refine((k): k is FieldKind => isFieldKind(k), `Use one of ${FIELD_KIND_LIST.join(", ")}, or custom:<id> from list_kinds`) as unknown as z.ZodType<FieldKind>;
const KIND_SCHEMA = {
  type: "string",
  description: `One of ${FIELD_KIND_LIST.join(", ")}; or custom:<id> for one of the owner's own ${KIND_WORD.many} (list_kinds gives the id).`,
} as const;
const UUID = z.string().uuid();
/** A value as the model gives it; null clears. */
const VALUE = z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(60)).max(30), z.null()]);
/** The most values a field change's Undo carries back (a retype or a renamed option rewrites them). */
const MAX_UNDO_VALUES = 2000;

/** Where a field change's Open goes: the record (a custom kind's: "record"), or Settings' fields for a kind ("fields", id = the kind). */
export type FieldOpenKind = Exclude<BuiltinFieldKind, "person" | "note"> | "fields" | "record";

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every object closed, every property listed as required. change_field isn't strict (see lib/assistant-records.ts): its input is checked when it runs. */
const object = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

export const FIELD_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_fields",
    description:
      "The owner's own fields for a kind of record (like Shoe size and Interests on people, or Rating on Watch & read): each one's name, type, options and unit, plus any archived ones. Give record_id to also get that record's current values. Check this before adding a field or setting a value.",
    input_schema: {
      type: "object",
      properties: { kind: KIND_SCHEMA, record_id: { type: "string" } },
      required: ["kind"],
    },
  },
  {
    name: "add_field",
    description:
      "Add one of the owner's own fields to every record of a kind. Only when the owner asked for it, or agreed when you asked (ask_owner). " +
      "Types: text, long_text, number (unit optional, e.g. UK or cm), rating (1 to 5 stars; halves allowed), boolean (yes or no), date, link, " +
      "choice (one of options), choices (several, like tags: good for interests; new ones are added as they're used). " +
      "If an archived field has the same name it's restored, values and all. Never for bank, card, password or medical details.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND_SCHEMA,
        label: { type: "string", description: "Short, sentence case: “Shoe size”, “Interests”, “Rating”." },
        type: { type: "string", enum: [...FIELD_TYPES] },
        options: { type: "array", items: { type: "string" }, description: "choice / choices: the starting list." },
        unit: { type: "string", description: "number only, e.g. UK, EU, cm, kg." },
      },
      required: ["kind", "label", "type"],
    },
  },
  {
    name: "set_field",
    description:
      "Set or clear one of the owner's own fields on a record: “Rowan's shoe size is 6”, “rate Dune 5 stars”, “Priya is into climbing and jazz”. " +
      "field is the field's name from list_fields. value: text, a number, true/false, a list for choices, or null to clear it. " +
      "For a choices field, add: true keeps what's there and adds to it. A choice field's value must be one of its options.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND_SCHEMA,
        record_id: { type: "string" },
        field: { type: "string" },
        value: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }, { type: "null" }],
        },
        add: { type: "boolean" },
      },
      required: ["kind", "record_id", "field", "value"],
    },
  },
  {
    name: "change_field",
    description:
      "Change one of the owner's own fields itself, only when they ask: rename it, change its options (renames makes values using an old option follow it), its unit or its type, " +
      "move it in the order, or archive or restore it (its values are kept). Check list_fields first. A type change that would spoil values already there is refused: then suggest a new field. " +
      '"" (or [] or 0) leaves each part as it is.',
    input_schema: object({
      kind: KIND_SCHEMA,
      field: { type: "string", description: "Its name now, from list_fields (an archived one's, to restore it)." },
      label: { type: "string", description: 'Its new name, sentence case. "" to leave it.' },
      type: { type: "string", enum: ["", ...FIELD_TYPES], description: "\"\" to leave it." },
      options: { type: "array", items: { type: "string" }, description: "choice and choices: the whole list as it should be, in order. [] to leave it (or to apply renames alone)." },
      renames: {
        type: "array",
        items: object({ from: { type: "string" }, to: { type: "string" } }),
        description: "Options being renamed, so the values that use them follow. [] for none.",
      },
      unit: { type: "string", description: 'number: a unit like cm or UK. "" to leave it.' },
      position: { type: "integer", description: "Where it goes among the kind's fields: 1 is first. 0 to leave it." },
      archive: { type: "string", enum: ["", "archive", "restore"], description: "Archive it (hidden everywhere, values kept) or restore it, on its own. \"\" otherwise." },
      clear: { type: "array", items: { type: "string", enum: ["unit"] }, description: "[\"unit\"] to drop a number's unit. [] otherwise." },
    }),
  },
];

export const FIELD_TOOL_NAMES: ReadonlySet<string> = new Set(FIELD_TOOLS.map((t) => t.name));

/** The system prompt's lines about fields (lib/assistant.ts puts them in "How to work"). */
export const FIELD_GUIDANCE = `- The owner's own fields: records can have fields the owner defined, like Shoe size or Interests on people and Rating on Watch & read. When they give you a detail like that ("Rowan's shoe size is 6", "rate Dune 5 stars", "Priya is into climbing and jazz"), find the record (find_people, find_notes, find_watch_read or find_items), check list_fields for that kind, then set_field. For a choices field like Interests, use add: true so what's there stays.
- If no field fits: when they asked for a field ("add a shoe size field to people"), add_field and carry on. When you'd be inventing one, ask_owner first and name it, e.g. "Add an ‘Interests’ field to people?" with options "Add the field" and "Cancel" (for a person, also "Just remember it", which uses remember). Once they agree, add_field, then set_field.
- Changing a field itself ("rename Grape to Grapes", "add Rosé to the colour options", "put Rating first", "archive the Region field"): change_field, after list_fields.
- Field types: rating for stars, number with a unit (UK, cm) for sizes, choices for interests and tags, choice for one of a fixed list, boolean for yes or no, date, link, text or long_text. Fields never hold bank, card, password or medical details.`;

const inputs = {
  list_fields: z.object({ kind: KIND, record_id: UUID.optional() }),
  add_field: z.object({
    kind: KIND,
    label: z.string().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    options: z.array(z.string().max(60)).max(60).optional(),
    unit: z.string().max(12).optional(),
  }),
  set_field: z.object({ kind: KIND, record_id: UUID, field: z.string().min(1).max(80), value: VALUE, add: z.boolean().optional() }),
  change_field: z.object({
    kind: KIND,
    field: z.string().min(1).max(80),
    label: z.string().max(60).default(""),
    type: z.enum(["", ...FIELD_TYPES]).default(""),
    options: z.array(z.string().max(60)).max(60).default([]),
    renames: z.array(z.object({ from: z.string().max(60), to: z.string().max(60) })).max(60).default([]),
    unit: z.string().max(12).default(""),
    position: z.number().int().min(0).max(500).default(0),
    archive: z.enum(["", "archive", "restore"]).default(""),
    clear: z.array(z.enum(["unit"])).max(1).default([]),
  }),
};

/** Lists for a receipt: the first few and how many more. */
function shortList(items: string[], max = 4): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", ");
}

/** Run one of FIELD_TOOLS for lib/assistant.ts's session; `record` files a change and returns the tool result. */
export async function runFieldTool(name: string, raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  switch (name) {
    case "list_fields": {
      const { kind, record_id } = inputs.list_fields.parse(raw);
      const all = await listFields({ kind, includeArchived: true });
      const live = all.filter((f) => !f.archived_at);
      const info = await kindInfo(kind);
      const result: Record<string, unknown> = {
        kind: info.many,
        fields: live.map((f) => ({
          name: f.label,
          type: f.type,
          ...(f.options.length ? { options: f.options } : {}),
          ...(f.unit ? { unit: f.unit } : {}),
        })),
        archived_fields: all.filter((f) => f.archived_at).map((f) => f.label),
      };
      if (record_id) {
        const title = await recordTitle(kind, record_id);
        if (title === null) throw new Error(`No ${info.one} with id ${record_id}.`);
        result.record = { title, values: Object.fromEntries((await recordValues(kind, record_id)).map(({ field, value }) => [field.label, value])) };
      }
      return JSON.stringify(result);
    }
    case "add_field": {
      const input = inputs.add_field.parse(raw);
      const info = await kindInfo(input.kind);
      const { field, outcome } = await defineField(input, { reuse: true });
      if (outcome === "exists") {
        return JSON.stringify({ done: `${capitalise(info.many)} already have a “${field.label}” field (${field.type}).`, options: field.options });
      }
      return record({
        kind: "field",
        id: field.id,
        action: outcome === "created" ? "created" : "updated",
        title: field.label,
        detail: outcome === "created" ? `New field for ${info.many} · ${FIELD_TYPE_INFO[field.type].label}` : `Field restored for ${info.many}, with its values`,
        open: { kind: "fields", id: field.kind },
        undo: { op: "archive_field", id: field.id },
      });
    }
    case "set_field": {
      const input = inputs.set_field.parse(raw);
      const info = await kindInfo(input.kind);
      const field = await findField(input.kind, input.field);
      if (!field) {
        const names = (await listFields({ kind: input.kind })).map((f) => f.label);
        throw new Error(
          `${capitalise(info.many)} have no “${input.field}” field${names.length ? ` (they have: ${names.join(", ")})` : ""}. Add it with add_field, asking the owner first unless they asked for it.`,
        );
      }
      const title = await recordTitle(input.kind, input.record_id);
      if (title === null) throw new Error(`No ${info.one} with id ${input.record_id}. Find it first.`);
      let value: unknown = input.value;
      if (input.add && field.type === "choices" && value !== null) {
        const current = (await recordValues(input.kind, input.record_id)).find((v) => v.field.id === field.id)?.value;
        const adding = Array.isArray(value) ? value : String(value).split(",");
        value = [...(Array.isArray(current) ? current : []), ...adding];
      }
      const result = await setValue({ field_id: field.id, entity_id: input.record_id, value });
      const shown = result.value ? formatValue(result.field, result.value.value) : null;
      return record({
        kind: "field",
        // One record can get several fields in a reply; each is its own change.
        id: `${field.id}:${input.record_id}`,
        action: "updated",
        title: title || (input.kind === "note" ? "Untitled note" : "Untitled"),
        detail: shown === null ? `${field.label} cleared` : `${field.label}: ${shown}`,
        open: isCustomKind(input.kind) ? { kind: "record", id: input.record_id } : { kind: input.kind as Exclude<BuiltinFieldKind, "person" | "note">, id: input.record_id },
        undo: { op: "restore_field_value", field_id: field.id, entity_id: input.record_id, value: result.previous },
      });
    }
    case "change_field":
      return changeField(raw, record);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

async function changeField(raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  const input = inputs.change_field.parse(raw);
  const info = await kindInfo(input.kind);
  const all = await listFields({ kind: input.kind, includeArchived: true });
  const live = all.filter((f) => !f.archived_at);
  const archived = all.find((f) => f.archived_at && sameLabel(f.label, input.field));
  const field = live.find((f) => f.id === input.field || sameLabel(f.label, input.field)) ?? (input.archive === "restore" ? archived : undefined);
  if (!field) {
    if (archived) throw new Error(`“${archived.label}” is archived. Restore it first (archive: restore).`);
    throw new Error(`${capitalise(info.many)} have no “${input.field}” field${live.length ? ` (they have: ${live.map((f) => f.label).join(", ")})` : ""}.`);
  }
  // Two receipts for one field in a reply each keep their own Undo.
  const id = `${field.id}:${crypto.randomUUID().slice(0, 8)}`;
  const open = { kind: "fields" as const, id: input.kind };

  const editing = !!(input.label.trim() || input.type || input.options.length || input.renames.length || input.unit.trim() || input.clear.length || input.position);
  if (input.archive) {
    if (editing) throw new Error("Archive or restore a field on its own, then change it.");
    const archive = input.archive === "archive";
    if (!!field.archived_at === archive) return JSON.stringify({ done: `No change: “${field.label}” is already ${archive ? "archived" : "there"}` });
    const f = await setFieldArchived(field.id, archive);
    return record({
      kind: "field",
      id,
      action: "updated",
      title: f.label,
      detail: archive ? `Field for ${info.many} archived, values kept` : `Field restored for ${info.many}, with its values`,
      open,
      undo: { op: "set_field_archived", id: field.id, archived: !archive },
    });
  }
  if (!editing) throw new Error("Say what to change.");

  const patch: FieldPatch = {};
  const parts: string[] = [];
  if (input.label.trim() && input.label.trim() !== field.label) {
    patch.label = input.label;
    parts.push(`Renamed from ${field.label}`);
  }
  if (input.type && input.type !== field.type) {
    patch.type = input.type;
    parts.push(`Now ${FIELD_TYPE_INFO[input.type].label.toLowerCase()}`);
  }
  const renames = input.renames.filter((r) => r.from.trim() && r.to.trim() && r.from.trim() !== r.to.trim());
  if (input.options.length || renames.length) {
    const renamed = (o: string) => renames.find((r) => sameLabel(r.from, o))?.to.trim() ?? o;
    patch.options = input.options.length ? input.options : field.options.map(renamed);
    if (renames.length) {
      patch.renames = renames;
      parts.push(...renames.map((r) => `${r.from.trim()} is now ${r.to.trim()}`));
    }
  }
  if (input.clear.includes("unit")) patch.unit = "";
  else if (input.unit.trim()) patch.unit = input.unit;

  // Undo puts back exactly what was there: the field, the values a retype or a renamed option rewrites, and the order.
  const values = patch.type || patch.renames ? await fieldValues(field.id) : [];
  const order = live.map((f) => f.id);
  const updated = Object.keys(patch).length ? await updateField(field.id, patch) : field;
  if (updated.options.length && JSON.stringify(updated.options) !== JSON.stringify(field.options) && !renames.length) parts.push(`Options: ${shortList(updated.options)}`);
  if (updated.unit !== field.unit) parts.push(updated.unit ? `Unit: ${updated.unit}` : "Unit dropped");
  let moved = false;
  if (input.position > 0 && !field.archived_at) {
    const rest = order.filter((f) => f !== field.id);
    const at = Math.min(input.position - 1, rest.length);
    if (order.indexOf(field.id) !== at) {
      rest.splice(at, 0, field.id);
      await reorderFields(input.kind, rest);
      moved = true;
      parts.push(at === 0 ? "Moved to first" : at === rest.length - 1 ? "Moved to last" : `Moved to number ${at + 1}`);
    }
  }
  if (!parts.length) return JSON.stringify({ done: `No change: “${field.label}” already has that` });
  const undoValues = values.length <= MAX_UNDO_VALUES;
  return record({
    kind: "field",
    id,
    action: "updated",
    title: updated.label,
    detail: `Field for ${info.many} · ${parts.join(" · ")}`,
    open,
    undo: undoValues
      ? { op: "restore_field", id: field.id, label: field.label, type: field.type, options: field.options, unit: field.unit, values, ...(moved ? { order } : {}) }
      : null,
  });
}

// ---------- undo ----------

const FIELD_UNDO = z.discriminatedUnion("op", [
  z.object({ op: z.literal("restore_field_value"), field_id: UUID, entity_id: UUID, value: VALUE }),
  z.object({ op: z.literal("archive_field"), id: UUID }),
  z.object({ op: z.literal("set_field_archived"), id: UUID, archived: z.boolean() }),
  z.object({
    op: z.literal("restore_field"),
    id: UUID,
    label: z.string().min(1).max(200),
    type: z.enum(FIELD_TYPES),
    options: z.array(z.string().max(200)).max(200),
    unit: z.string().max(40),
    values: z.array(z.object({ entity_id: UUID, value: VALUE.refine((v) => v !== null) })).max(MAX_UNDO_VALUES),
    order: z.array(UUID).max(500).optional(),
  }),
]);

export type FieldUndo = z.infer<typeof FIELD_UNDO>;

const FIELD_UNDO_OPS = new Set(["restore_field_value", "archive_field", "set_field_archived", "restore_field"]);

export function isFieldUndo(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && FIELD_UNDO_OPS.has(String((raw as { op?: unknown }).op));
}

/** Archive a field the assistant made, put a value or a field back as it was, or archive or restore a field again. */
export async function applyFieldUndo(raw: unknown): Promise<void> {
  const undo = FIELD_UNDO.parse(raw);
  switch (undo.op) {
    case "archive_field":
      await setFieldArchived(undo.id, true);
      return;
    case "set_field_archived":
      await setFieldArchived(undo.id, undo.archived);
      return;
    case "restore_field_value":
      await setValue({ field_id: undo.field_id, entity_id: undo.entity_id, value: undo.value }, { restore: true });
      return;
    case "restore_field": {
      const field = await restoreField(undo.id, undo, undo.values as Array<{ entity_id: string; value: string | number | boolean | string[] }>);
      if (undo.order && isFieldKind(field.kind)) await reorderFields(field.kind, undo.order);
      return;
    }
  }
}
