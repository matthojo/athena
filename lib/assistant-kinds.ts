/**
 * Ask's assistant and the owner's own kinds of record: "make a Wines type
 * with grape, region and rating", "add Château Musar, a Lebanese red, 4
 * stars", "move the fig to the kitchen", "duplicate Wines", "rename Wines to
 * Red wines and give it the wine icon". Kept beside lib/assistant.ts, which
 * lists these tools with its own, runs them through runKindTool() and undoes
 * their changes through applyKindUndo(). Archiving a kind or a record is
 * archive_or_restore's (lib/assistant-records.ts); a kind's fields are
 * changed with lib/assistant-fields.ts's tools.
 *
 * Every property is required, so "" and [] stand for "not given", and each
 * call is checked against `inputs` before it runs. Every change comes back as a
 * receipt with Open and Undo. Undo archives what was made, puts a record's
 * title, body and values back, puts a kind's names and icon back, or
 * restores what was archived. Nothing is deleted: archiving is as far as Ask
 * goes, and only when asked.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import type { Change } from "./assistant";
import { archiveEntity, unarchiveEntity, AthenaInputError } from "./db";
import { setValue } from "./custom-fields";
import {
  createCustomRecord,
  createKind,
  duplicateKind,
  getCustomRecord,
  getKind,
  listKinds,
  recordDetail,
  requireKind,
  searchCustomRecords,
  updateCustomRecord,
  updateKind,
  type ValueChange,
} from "./custom-kinds";
import { listFields } from "./custom-fields";
import { FIELD_TYPES, KIND_ICONS, formatValue } from "./custom-field-rules";
import { joinList } from "./answer-text";
import { KIND_WORD } from "./custom-kind-words";

const UUID = z.string().uuid();
const VALUE = z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(60)).max(30), z.null()]);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every object closed, every property listed as required. Not strict (see lib/assistant-records.ts): `inputs` below checks each call. */
const object = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const W = KIND_WORD;

export const KIND_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_kinds",
    description:
      `The owner's own ${W.many}: kinds of record they keep themselves, like Wines, Plants or Board games. Each has a name, ` +
      `an id (its kind for list_fields, add_field and set_field is custom:<id>), its fields and how many records it has.`,
    input_schema: object({}),
  },
  {
    name: "make_kind",
    description:
      `Make a new ${W.one} (a kind of record the owner keeps, with its own fields), when the owner asks for one: ` +
      `"track my wines", "make a Wines ${W.one} with grape, region and rating", "start keeping my board games". ` +
      `Not for a shopping list, packing list, to-do list or checklist: those are checklist notes (add_to_list) or to-dos. ` +
      `Not for books, films or shows: those go on watch & read. Give it its fields in one go. ` +
      `If one with that name already exists, you get it back (an archived one is restored, records and all).`,
    input_schema: object({
      name: { type: "string", description: "Plural, as the owner will see it: “Wines”, “Plants”, “Board games”." },
      one: { type: "string", description: "One of them, lower case: “wine”, “plant”, “board game”. \"\" to work it out from the name." },
      icon: { type: "string", enum: [...KIND_ICONS], description: "The closest icon; folder when nothing fits." },
      fields: {
        type: "array",
        description: "Its fields, in the order to show them. Rating for stars; number with a unit (£, cm) for prices and sizes; choice for one of a fixed list; choices for tags.",
        items: object({
          label: { type: "string", description: "Short, sentence case: “Grape”, “Region”, “Rating”." },
          type: { type: "string", enum: [...FIELD_TYPES] },
          options: { type: "array", items: { type: "string" }, description: "choice and choices: the starting list. [] otherwise." },
          unit: { type: "string", description: "number only, e.g. £, cm, kg. \"\" otherwise." },
        }),
      },
    }),
  },
  {
    name: "find_records",
    description:
      `Find records in the owner's ${W.many} by words in their name, notes or text and choice fields ("Lebanese", "Musar"). ` +
      `Returns ids, which ${W.one} each is in, its field values and its notes. Give kind (a ${W.one}'s name) to look in just one, "" for all; query "" lists them.`,
    input_schema: object({ query: { type: "string" }, kind: { type: "string" } }),
  },
  {
    name: "save_record",
    description:
      `Add a record to one of the owner's ${W.many} ("add Château Musar to my wines, red, 4 stars"), or change one (give record_id from find_records). ` +
      `values sets fields by their name (list_kinds says which exist; add one first with add_field if it's missing, asking unless they named it). ` +
      `A value: text, a number, true/false, a list for choices, or null to clear it. ` +
      `body is the record's notes, Markdown; it replaces what's there, so keep what should stay. Link people as [@Name](athena://person/<id>).`,
    input_schema: object({
      kind: { type: "string", description: `The ${W.one}'s name or id. Needed for a new record; "" when changing one.` },
      record_id: { type: "string", description: "\"\" for a new record." },
      title: { type: "string", description: "Its name: “Château Musar 2017”. \"\" to leave it." },
      body: { type: "string", description: "Notes about it, Markdown. \"\" to leave them." },
      values: {
        type: "array",
        items: object({
          field: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }, { type: "null" }] },
        }),
      },
    }),
  },
  {
    name: "duplicate_kind",
    description: `Copy one of the owner's ${W.many} with all its fields and none of its records, as “<Name> copy”, when they ask. They can rename it.`,
    input_schema: object({ kind: { type: "string", description: `The ${W.one}'s name or id.` } }),
  },
  {
    name: "update_kind",
    description:
      `Rename one of the owner's ${W.many}, change what one of it is called, or change its icon, when they ask. "" leaves each as it is. ` +
      `Its fields are changed with change_field (kind custom:<id>); archiving it is archive_or_restore.`,
    input_schema: object({
      kind: { type: "string", description: `The ${W.one}'s name or id.` },
      name: { type: "string", description: 'Its new name, plural, as the owner will see it: “Red wines”. "" to leave it.' },
      one: { type: "string", description: 'One of them, lower case: “red wine”. "" to leave it (a new name brings its own when the old one was worked out from the old name).' },
      icon: { type: "string", enum: ["", ...KIND_ICONS], description: "\"\" to leave it." },
    }),
  },
];

/**
 * Archiving a kind or a record is archive_or_restore's now (lib/assistant-records.ts),
 * which archives anything. This one is no longer offered to the model; runKindTool
 * still takes it, for callers from before.
 */
const ARCHIVE_KIND_OR_RECORD = "archive_kind_or_record";

export const KIND_TOOL_NAMES: ReadonlySet<string> = new Set([...KIND_TOOLS.map((t) => t.name), ARCHIVE_KIND_OR_RECORD]);

/** The system prompt's lines about the owner's own kinds (lib/assistant.ts puts them in "How to work"). */
export const KIND_GUIDANCE = `- The owner's own ${W.many} are kinds of record they keep themselves, like Wines, Plants or Board games, each with its own fields (list_kinds). "Track my wines", "make a Wines ${W.one} with grape, region and rating" or "keep a list of the board games I own" means make_kind with sensible fields, in one go. Adding to one ("add Château Musar, a Lebanese red, 4 stars"): list_kinds, then save_record with the values by field name. Changing one: find_records, then save_record with its record_id.
- A shopping list, packing list, gift list, to-do list or checklist is never a ${W.one}: it's a checklist note (add_to_list) or to-dos (add_todo). Books, films and shows go on watch & read. Make a ${W.one} only when the owner asks for one, or wants to keep things of one kind with details on each.
- When the owner mentions a ${W.one} that doesn't exist ("add this to my cheeses"), ask_owner whether to make it, naming its fields, unless they asked for it.
- A ${W.one}'s fields work like any record's: list_fields, add_field, set_field and change_field with kind custom:<id> from list_kinds. Renaming a ${W.one} or changing its icon is update_kind; archiving or restoring one (or a record in one) is archive_or_restore with kind type (or record).`;

const inputs = {
  list_kinds: z.object({}).passthrough(),
  make_kind: z.object({
    name: z.string().min(1).max(80),
    one: z.string().max(80).default(""),
    icon: z.string().max(40).default(""),
    fields: z
      .array(z.object({ label: z.string().min(1).max(60), type: z.enum(FIELD_TYPES), options: z.array(z.string().max(60)).max(60).default([]), unit: z.string().max(12).default("") }))
      .max(30)
      .default([]),
  }),
  find_records: z.object({ query: z.string().max(200).default(""), kind: z.string().max(100).default("") }),
  save_record: z.object({
    kind: z.string().max(100).default(""),
    record_id: z.union([UUID, z.literal("")]).default(""),
    title: z.string().max(300).default(""),
    body: z.string().max(20_000).default(""),
    values: z.array(z.object({ field: z.string().min(1).max(80), value: VALUE })).max(40).default([]),
  }),
  duplicate_kind: z.object({ kind: z.string().min(1).max(100) }),
  update_kind: z.object({
    kind: z.string().min(1).max(100),
    name: z.string().max(80).default(""),
    one: z.string().max(80).default(""),
    icon: z.union([z.enum(KIND_ICONS), z.literal("")]).default(""),
  }),
  archive_kind_or_record: z.object({ what: z.enum(["kind", "record"]), id: UUID, archive: z.boolean() }),
};

/** "Grape: Syrah · Rating: 4 stars", the first few values a change set. */
function valuesLine(changes: ValueChange[], max = 2): string {
  return changes
    .filter((c) => c.value !== null)
    .slice(0, max)
    .map((c) => `${c.field.label}: ${formatValue(c.field, c.value!)}`)
    .join(" · ");
}

/** Run one of KIND_TOOLS for lib/assistant.ts's session; `record` files a change and returns the tool result. */
export async function runKindTool(name: string, raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  switch (name) {
    case "list_kinds": {
      const kinds = await listKinds();
      if (!kinds.length) return `The owner has no ${W.many} yet.`;
      const out = await Promise.all(
        kinds.map(async (k) => ({
          id: k.id,
          kind: k.kind,
          name: k.name,
          one: k.one,
          records: k.record_count,
          fields: (await listFields({ kind: k.kind })).map((f) => ({
            name: f.label,
            type: f.type,
            ...(f.options.length ? { options: f.options } : {}),
            ...(f.unit ? { unit: f.unit } : {}),
          })),
        })),
      );
      return JSON.stringify(out);
    }
    case "make_kind": {
      const input = inputs.make_kind.parse(raw);
      const { kind, outcome, fields } = await createKind(
        {
          name: input.name,
          one: input.one || undefined,
          icon: input.icon || undefined,
          fields: input.fields.map((f) => ({ label: f.label, type: f.type, options: f.options, unit: f.unit })),
        },
        { reuse: true },
      );
      const fieldNames = fields.map((f) => f.label);
      if (outcome === "exists") {
        return JSON.stringify({ done: `There's already a “${kind.name}” ${W.one}.`, id: kind.id, kind: kind.kind, fields: fieldNames });
      }
      return record({
        kind: "kind",
        id: kind.id,
        icon: kind.icon,
        action: outcome === "created" ? "created" : "updated",
        title: kind.name,
        detail:
          outcome === "created"
            ? `${capitalise(W.new)}${fieldNames.length ? ` · ${joinList(fieldNames.length > 3 ? [...fieldNames.slice(0, 2), `${fieldNames.length - 2} more`] : fieldNames)}` : ""}`
            : `${capitalise(W.one)} restored, with its records`,
        open: { kind: "kind", id: kind.id },
        undo: { op: "archive", kind: "kind", id: kind.id },
      });
    }
    case "find_records": {
      const { query, kind } = inputs.find_records.parse(raw);
      const matches = await searchCustomRecords(query, { kind: kind || undefined, limit: 12 });
      if (!matches.length) return query ? `Nothing in the owner's ${W.many} matches ${JSON.stringify(query)}.` : `There's nothing in ${kind || `the owner's ${W.many}`} yet.`;
      // The top few in full, so a change can keep what's there.
      const out: Array<Record<string, unknown>> = [];
      for (const [i, m] of matches.entries()) {
        if (i >= 5) {
          out.push({ id: m.id, title: m.title, in: m.kind, snippet: m.snippet });
          continue;
        }
        const detail = await recordDetail(m.id);
        out.push({
          id: m.id,
          title: m.title,
          in: m.kind,
          values: Object.fromEntries((detail?.fields ?? []).map((f) => [f.name, f.text])),
          body: (detail?.body ?? "").slice(0, 1500),
        });
      }
      return JSON.stringify(out);
    }
    case "save_record": {
      const input = inputs.save_record.parse(raw);
      const values = input.values.map((v) => ({ field: v.field, value: v.value }));
      if (!input.record_id) {
        if (!input.kind) throw new Error(`Say which ${W.one} it goes in (list_kinds).`);
        if (!input.title.trim()) throw new Error("A new record needs a title.");
        const { record: rec, kind, changes } = await createCustomRecord({ kind: input.kind, title: input.title, body: input.body || undefined, values });
        const line = valuesLine(changes);
        return record({
          kind: "record",
          id: rec.id,
          icon: kind.icon,
          action: "created",
          title: rec.title,
          detail: `${capitalise(kind.one)} · added to ${kind.name}${line ? ` · ${line}` : ""}`,
          open: { kind: "record", id: rec.id },
          undo: { op: "archive", kind: "record", id: rec.id },
        });
      }
      const { record: rec, kind, changes, before } = await updateCustomRecord(input.record_id, {
        title: input.title.trim() ? input.title : undefined,
        body: input.body ? input.body : undefined,
        values,
      });
      const what: string[] = [];
      if (rec.title !== before.title) what.push("renamed");
      if (rec.body !== before.body) what.push("notes updated");
      const line = valuesLine(changes, 3);
      return record({
        kind: "record",
        id: rec.id,
        icon: kind.icon,
        action: "updated",
        title: rec.title,
        detail: [capitalise(kind.one), line || capitalise(what.join(", ") || "Updated")].join(" · "),
        open: { kind: "record", id: rec.id },
        undo: {
          op: "restore_record",
          id: rec.id,
          title: before.title,
          body: before.body,
          values: changes.map((c) => ({ field_id: c.field.id, value: c.previous })),
        },
      });
    }
    case "duplicate_kind": {
      const { kind: ref } = inputs.duplicate_kind.parse(raw);
      const source = await requireKind(ref);
      const { kind, fields } = await duplicateKind(source.id);
      return record({
        kind: "kind",
        id: kind.id,
        icon: kind.icon,
        action: "created",
        title: kind.name,
        detail: `Copy of ${source.name} · ${fields.length} ${fields.length === 1 ? "field" : "fields"}, no records`,
        open: { kind: "kind", id: kind.id },
        undo: { op: "archive", kind: "kind", id: kind.id },
      });
    }
    case "update_kind": {
      const input = inputs.update_kind.parse(raw);
      const before = await requireKind(input.kind);
      const kind = await updateKind(before.id, { name: input.name.trim() || undefined, one: input.one.trim() || undefined, icon: input.icon || undefined });
      const parts: string[] = [];
      if (kind.name !== before.name) parts.push(`Renamed from ${before.name}`);
      if (kind.one !== before.one) parts.push(`One is called “${kind.one}”`);
      if (kind.icon !== before.icon) parts.push("New icon");
      if (!parts.length) return JSON.stringify({ done: `No change: the “${kind.name}” ${W.one} already has that`, id: kind.id });
      return record({
        kind: "kind",
        id: kind.id,
        icon: kind.icon,
        action: "updated",
        title: kind.name,
        detail: `${capitalise(W.one)} · ${parts.join(" · ")}`,
        open: { kind: "kind", id: kind.id },
        undo: { op: "restore_kind", id: kind.id, name: before.name, one: before.one, icon: before.icon as (typeof KIND_ICONS)[number] },
      });
    }
    case "archive_kind_or_record": {
      const { what, id, archive } = inputs.archive_kind_or_record.parse(raw);
      if (what === "kind") {
        const kind = await getKind(id, { includeArchived: true });
        if (!kind) throw new Error(`No ${W.one} with that id. Use list_kinds.`);
        const ok = archive ? await archiveEntity("kind", id) : await unarchiveEntity("kind", id);
        if (!ok) throw new Error(`No ${W.one} with that id.`);
        return record({
          kind: "kind",
          id,
          icon: kind.icon,
          action: "updated",
          title: kind.name,
          detail: archive ? `${capitalise(W.one)} archived, with its ${kind.record_count} ${kind.record_count === 1 ? "record" : "records"}` : `${capitalise(W.one)} restored`,
          open: archive ? null : { kind: "kind", id },
          undo: { op: archive ? "unarchive" : "archive", kind: "kind", id },
        });
      }
      const rec = await getCustomRecord(id, { includeArchived: true });
      if (!rec) throw new Error("No record with that id. Use find_records.");
      const kind = await getKind(rec.kind_id, { includeArchived: true });
      const ok = archive ? await archiveEntity("record", id) : await unarchiveEntity("record", id);
      if (!ok) throw new Error("No record with that id.");
      return record({
        kind: "record",
        id,
        icon: kind?.icon,
        action: "updated",
        title: rec.title,
        detail: `${capitalise(kind?.one ?? "record")} · ${archive ? "archived" : "restored"}`,
        open: archive ? null : { kind: "record", id },
        undo: { op: archive ? "unarchive" : "archive", kind: "record", id },
      });
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- undo ----------

const KIND_UNDO = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("restore_record"),
    id: UUID,
    title: z.string().max(1000),
    body: z.string().max(200_000),
    values: z.array(z.object({ field_id: UUID, value: VALUE })).max(40),
  }),
  z.object({ op: z.literal("unarchive"), kind: z.enum(["kind", "record"]), id: UUID }),
  z.object({ op: z.literal("restore_kind"), id: UUID, name: z.string().min(1).max(200), one: z.string().min(1).max(200), icon: z.enum(KIND_ICONS) }),
]);

export type KindUndo = z.infer<typeof KIND_UNDO>;

const KIND_UNDO_OPS = new Set(["restore_record", "unarchive", "restore_kind"]);

export function isKindUndo(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && KIND_UNDO_OPS.has(String((raw as { op?: unknown }).op));
}

/** Put a record or a kind's names back as they were, or restore what was archived. (Archiving what was made is lib/assistant.ts's "archive".) */
export async function applyKindUndo(raw: unknown): Promise<void> {
  const undo = KIND_UNDO.parse(raw);
  if (undo.op === "unarchive") {
    if (!(await unarchiveEntity(undo.kind, undo.id))) throw new AthenaInputError("That isn't there any more", 404);
    return;
  }
  if (undo.op === "restore_kind") {
    await updateKind(undo.id, { name: undo.name, one: undo.one, icon: undo.icon });
    return;
  }
  await updateCustomRecord(undo.id, { title: undo.title, body: undo.body });
  for (const v of undo.values) await setValue({ field_id: v.field_id, entity_id: undo.id, value: v.value }, { restore: true });
}
