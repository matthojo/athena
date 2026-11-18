/**
 * The owner's own fields over MCP (lib/custom-fields.ts): agents can list a
 * kind's fields, read a record's values and set or clear a value. Defining,
 * renaming and archiving fields is the owner's, in the app (or through Ask),
 * so there's no tool for it, and nothing here deletes.
 *
 * Records' values also ride along on the existing reads: get_person,
 * get_note, list_reading and the rest carry `custom_fields` when any are
 * filled in (withCustomFields below).
 *
 * The owner's own kinds of record (netlify/lib/mcp/custom-kinds.ts) are kinds
 * here too: 'custom:<kind id>', from list_kinds.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers } from "./results";
import { findField, kindInfo, knownKind, listFields, recordTitle, recordValues, setValue, valuesByRecord } from "../../../lib/custom-fields";
import { FIELD_KIND_LIST, formatValue, isFieldKind, type FieldKind, type FieldValue } from "../../../lib/custom-field-rules";
import { KIND_WORD } from "../../../lib/custom-kind-words";

/** One filled-in field, as agents read it. */
interface FieldOut {
  field_id: string;
  name: string;
  type: string;
  value: FieldValue;
  /** How it reads: "6 UK", "4 stars", "Climbing, Jazz". */
  text: string;
}

const out = (rows: Awaited<ReturnType<typeof recordValues>>): FieldOut[] =>
  rows.map(({ field, value }) => ({ field_id: field.id, name: field.label, type: field.type, value, text: formatValue(field, value) }));

/** A record with its filled-in custom fields, when it has any. */
export async function withCustomFields<T extends { id: string }>(kind: FieldKind, record: T): Promise<T & { custom_fields?: FieldOut[] }> {
  const filled = await recordValues(kind, record.id);
  return filled.length ? { ...record, custom_fields: out(filled) } : record;
}

/** The same for a list, in one query. */
export async function withCustomFieldsList<T extends { id: string }>(kind: FieldKind, records: T[]): Promise<Array<T & { custom_fields?: FieldOut[] }>> {
  const byId = await valuesByRecord(
    kind,
    records.map((r) => r.id),
  );
  return records.map((r) => (byId.has(r.id) ? { ...r, custom_fields: out(byId.get(r.id)!) } : r));
}

const kindSchema = z
  .string()
  .refine((k): k is FieldKind => isFieldKind(k), `Use one of ${FIELD_KIND_LIST.join(", ")}, or custom:<id> from list_kinds`)
  .describe(`One of ${FIELD_KIND_LIST.join(", ")}; or custom:<id> for one of the owner's own ${KIND_WORD.many} (list_kinds)`) as unknown as z.ZodType<FieldKind>;

export function registerCustomFieldTools(server: McpServer, { ok, stored, fail, safe }: Helpers): void {
  server.tool(
    "list_custom_fields",
    "The owner's own fields: details they added to a kind of record themselves, like Shoe size and Interests on people or Rating on Watch & read. " +
      "Each has a name, a type (text, long_text, number with an optional unit, rating 1–5, boolean, date, link, choice, choices) and, for choice and choices, options. " +
      "The owner defines them in the app; records' values show up as custom_fields on get_* and list_reading / list_goals / list_assets.",
    { kind: kindSchema.optional().describe("Just this kind's fields; omit for every kind") },
    safe(async ({ kind }) =>
      ok(
        (await listFields({ kind: kind ? await knownKind(kind) : undefined })).map((f) => ({
          id: f.id,
          kind: f.kind,
          name: f.label,
          type: f.type,
          ...(f.options.length ? { options: f.options } : {}),
          ...(f.unit ? { unit: f.unit } : {}),
        })),
      ),
    ),
  );

  server.tool(
    "get_custom_values",
    "One record's filled-in custom fields (see list_custom_fields), by kind and id.",
    { kind: kindSchema, id: z.string().uuid() },
    safe(async ({ kind, id }) => {
      const title = await recordTitle(await knownKind(kind), id);
      if (title === null) return fail(`${(await kindInfo(kind)).one} ${id} not found`);
      return stored("custom fields", { kind, id, title, custom_fields: out(await recordValues(kind, id)) });
    }),
  );

  server.tool(
    "set_custom_value",
    "Set or clear one of the owner's own fields on a record (list_custom_fields says which exist; this can't add a field). " +
      "value: text, a number, true/false, or a list of strings for a choices field; null clears it. A rating is 1 to 5; a choice must be one of " +
      "its options; new choices are added to a choices field's options. Never put bank, card, password or medical details in a field.",
    {
      kind: kindSchema,
      id: z.string().uuid().describe("The record's id"),
      field: z.string().min(1).describe("The field's name (any case) or id"),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
    },
    safe(async ({ kind, id, field: name, value }) => {
      const field = await findField(await knownKind(kind), name);
      if (!field) return fail(`There's no “${name}” field for ${(await kindInfo(kind)).many}. The owner defines fields in the app.`);
      const result = await setValue({ field_id: field.id, entity_id: id, value });
      return ok({
        kind,
        id,
        field_id: field.id,
        name: field.label,
        value: result.value?.value ?? null,
        text: result.value ? formatValue(result.field, result.value.value) : null,
      });
    }),
  );
}
