/**
 * The owner's own kinds of record over MCP (lib/custom-kinds.ts): agents can
 * list and read kinds, make one with its fields, rename one or change its
 * icon, and add, change, read and list its records. Archiving and restoring
 * go through the generic archive / unarchive tools (kinds "kind" and
 * "record"). Nothing here deletes, and archived kinds and records are never
 * listed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers } from "./results";
import { listFields } from "../../../lib/custom-fields";
import {
  createCustomRecord,
  createKind,
  listCustomRecords,
  listKinds,
  recordDetail,
  requireKind,
  searchCustomRecords,
  updateCustomRecord,
  updateKind,
  withRecordFields,
  type CustomKind,
} from "../../../lib/custom-kinds";
import { FIELD_TYPES, KIND_ICONS } from "../../../lib/custom-field-rules";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { NOTE_STYLE_SHORT } from "../../../lib/writing-style";

const W = KIND_WORD;

/** What agents are told a kind is, wherever one comes up. */
const ABOUT =
  `The owner's own ${W.many} are kinds of record they keep themselves (Wines, Plants, Board games), each with its own fields. ` +
  `A ${W.one}'s fields are custom fields of kind custom:<id> (list_custom_fields, set_custom_value). ` +
  `A shopping list, packing list or checklist is a note, and a to-do is a commitment: neither is a ${W.one}.`;

const kindRef = z.string().min(1).describe(`The ${W.one}'s id, custom:<id>, or its name ("Wines")`);

const valuesSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
  .describe(
    "Field values by field name: { \"Grape\": \"Syrah\", \"Rating\": 4, \"Price\": 18 }. A rating is 1 to 5; a choice must be one of its options; null clears. " +
      "Never bank, card, password or medical details.",
  );

/** A kind as agents read it: names, fields, how many records. */
async function describeKind(k: CustomKind) {
  const fields = await listFields({ kind: k.kind });
  return {
    id: k.id,
    kind: k.kind,
    name: k.name,
    one: k.one,
    icon: k.icon,
    records: k.record_count,
    fields: fields.map((f) => ({ id: f.id, name: f.label, type: f.type, ...(f.options.length ? { options: f.options } : {}), ...(f.unit ? { unit: f.unit } : {}) })),
  };
}

export function registerCustomKindTools(server: McpServer, { ok, stored, fail, safe }: Helpers): void {
  server.tool(
    "list_kinds",
    `The owner's own ${W.many}, in their order, with each one's fields and how many records it has. ${ABOUT}`,
    {},
    safe(async () => ok(await Promise.all((await listKinds()).map(describeKind)))),
  );

  server.tool(
    "get_kind",
    `One of the owner's own ${W.many}, by id or name, with its fields.`,
    { kind: kindRef },
    safe(async ({ kind }) => ok(await describeKind(await requireKind(kind)))),
  );

  server.tool(
    "create_kind",
    `Make a new ${W.one} with the fields it starts with, when the owner wants to keep a kind of thing with details on each ("track my wines: grape, region, rating"). ` +
      `${ABOUT} A name already in use is refused.`,
    {
      name: z.string().min(1).describe("Plural, as shown: 'Wines', 'Plants', 'Board games'"),
      one: z.string().optional().describe("One of them, for sentences: 'wine'. Worked out from the name when omitted"),
      icon: z.enum(KIND_ICONS).optional().describe("Defaults to folder"),
      fields: z
        .array(
          z.object({
            name: z.string().min(1).describe("Sentence case: 'Grape', 'Rating'"),
            type: z.enum(FIELD_TYPES).describe("rating = 1–5 stars; number takes a unit; choice = one of options; choices = several, like tags"),
            options: z.array(z.string()).optional(),
            unit: z.string().optional().describe("number only: '£', 'cm'"),
          }),
        )
        .optional(),
    },
    safe(async ({ name, one, icon, fields }) => {
      const { kind } = await createKind({ name, one, icon, fields: (fields ?? []).map((f) => ({ label: f.name, type: f.type, options: f.options, unit: f.unit })) });
      return ok(await describeKind(kind));
    }),
  );

  server.tool(
    "update_kind",
    `Rename one of the owner's ${W.many}, change what one of it is called, or its icon. Omitted ones are left as they are.`,
    {
      kind: kindRef,
      name: z.string().min(1).optional(),
      one: z.string().min(1).optional(),
      icon: z.enum(KIND_ICONS).optional(),
    },
    safe(async ({ kind, name, one, icon }) => ok(await describeKind(await updateKind((await requireKind(kind)).id, { name, one, icon })))),
  );

  server.tool(
    "upsert_record",
    `Add a record to one of the owner's ${W.many} (omit id; give kind and title), or change one (give id; omitted parts are left as they are). ` +
      `body is Markdown notes and replaces what's there; link to things with athena:// links, e.g. [@Priya Shah](athena://person/<uuid>), and a record is ` +
      `linked as [@Château Musar](athena://record/<uuid>). ${NOTE_STYLE_SHORT}`,
    {
      id: z.string().uuid().optional().describe("The record to change; omit to add one"),
      kind: kindRef.optional().describe(`Required when adding: the ${W.one}'s id or name`),
      title: z.string().optional().describe("Required when adding"),
      body: z.string().optional(),
      values: valuesSchema.optional(),
    },
    safe(async ({ id, kind, title, body, values }) => {
      if (id) return stored("records", await recordDetail((await updateCustomRecord(id, { title, body, values })).record.id));
      if (!kind) return fail(`Give the ${W.one} (kind) to add it to`);
      const { record } = await createCustomRecord({ kind, title, body, values });
      return stored("records", await recordDetail(record.id));
    }),
  );

  server.tool(
    "get_record",
    `One record from the owner's ${W.many}, with its ${W.one}, fields and notes (archived ones are not returned). Its links: get_connections with kind 'record'.`,
    { id: z.string().uuid() },
    safe(async ({ id }) => {
      const detail = await recordDetail(id);
      return detail ? stored("records", detail) : fail(`Record ${id} not found`);
    }),
  );

  server.tool(
    "list_records",
    `Records in one of the owner's ${W.many}, by name, with their fields. With query, only those whose name, notes or text and choice fields hold every word (any ${W.one} when kind is omitted).`,
    {
      kind: kindRef.optional(),
      query: z.string().optional(),
      limit: z.number().int().positive().max(500).optional().describe("Defaults to 100"),
    },
    safe(async ({ kind, query, limit }) => {
      if (query?.trim() || !kind) {
        const matches = await searchCustomRecords(query ?? "", { kind, limit: limit ?? 100 });
        return stored("records", matches);
      }
      const k = await requireKind(kind);
      return stored("records", await withRecordFields(k, await listCustomRecords(k.id, { limit: limit ?? 100 })));
    }),
  );
}

