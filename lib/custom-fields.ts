/**
 * Custom fields on the server: defining, renaming, reordering and archiving
 * the owner's own fields, and reading and setting their values. The rules
 * (kinds, types, what a value may be, safe type changes) are in
 * lib/custom-field-rules.ts, shared with the PWA.
 *
 * Same rules as lib/db.ts: the SQL lives here (and there), archived fields are
 * hidden except where asked for, and nothing is deleted. An archived field
 * keeps its values and gets them back when it's restored. Values go only
 * when their record is permanently deleted (deleteEntityForever in lib/db.ts).
 *
 * Encrypted at rest (SECURITY.md §11): labels, units, options and values are
 * sealed on the way in and come back opened from q() and tx(). SQL never
 * compares, sorts or searches them: names are matched and values searched
 * here in TypeScript.
 *
 * Kinds are the built-in ones (people, places, …) and the owner's own
 * ('custom:<kind id>', lib/custom-kinds.ts), whose records all live in one
 * table, custom_records: every query on a custom kind's records keeps to that
 * kind (kind_id) and to kinds that aren't archived. An archived kind's fields
 * are hidden with it, values kept.
 */
import { AthenaInputError, q, sealer, tx } from "./db";
import { KIND_WORD } from "./custom-kind-words";
import { PlaceholderWrite } from "./data-box";
import { isEncryptedPlaceholder } from "./encrypted";
import {
  fieldKindInfo,
  FIELD_KIND_LIST,
  FIELD_TYPES,
  FieldError,
  cleanLabel,
  cleanOptions,
  cleanUnit,
  convertValue,
  customKindId,
  customKindKey,
  isBuiltinKind,
  isCustomKind,
  registerCustomKinds,
  hasOptions,
  isFieldKind,
  isFieldType,
  isValueOfType,
  normaliseValue,
  sameLabel,
  searchText,
  typeChangeAllowed,
  typeChangeRefusal,
  type CustomField,
  type CustomFieldKind,
  type CustomValue,
  type FieldKind,
  type FieldKindInfo,
  type FieldType,
  type FieldValue,
  type Normalised,
} from "./custom-field-rules";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

/** Every column, plus how many records have a value. */
const FIELD_COLUMNS = `f.id, f.kind, f.label, f.type, f.options, f.unit, f.position, f.archived_at, f.created_at, f.updated_at,
  (SELECT count(*)::int FROM custom_values v WHERE v.field_id = f.id) AS value_count`;

interface FieldRow extends Omit<CustomField, "options" | "value_count"> {
  options: unknown;
  value_count: number | string | null;
}

/** Sealed JSON comes back from q() as its JSON text; plain JSON as itself. */
function readJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toField(row: FieldRow): CustomField {
  const options = readJson(row.options);
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    type: row.type,
    options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [],
    unit: row.unit ?? "",
    position: row.position,
    value_count: Number(row.value_count ?? 0),
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A stored value, or undefined when it can't be read here (a placeholder) or isn't the field's type. */
function readValue(type: FieldType, raw: string): FieldValue | undefined {
  if (isEncryptedPlaceholder(raw)) return undefined;
  const value = readJson(raw);
  return isValueOfType(type, value) ? value : undefined;
}

/** Rule errors are the owner's words: answer them as a 400. */
function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FieldError) throw new AthenaInputError(error.message);
    throw error;
  }
}

interface KindRow {
  id: string;
  name: string;
  one: string;
  archived_at: string | null;
}

/**
 * One of the owner's own kinds, archived or not; null when there's no such
 * kind. Teaches fieldKindInfo() its names. Inside a transaction, pass its run.
 */
async function customKindRow(kind: CustomFieldKind, run: Run = q): Promise<KindRow | null> {
  const [row] = await run<KindRow>(`SELECT id, name, one, archived_at FROM custom_kinds WHERE id = $1`, [customKindId(kind)]);
  if (row && !isEncryptedPlaceholder(row.name) && !isEncryptedPlaceholder(row.one)) registerCustomKinds([row]);
  return row ?? null;
}

/** What a kind is called. The owner's own kinds are read fresh, so a rename shows straight away. */
export async function kindInfo(kind: FieldKind, run: Run = q): Promise<FieldKindInfo> {
  if (isCustomKind(kind)) await customKindRow(kind, run);
  return fieldKindInfo(kind);
}

/** A kind that exists: built in, or one of the owner's own that isn't archived (or is, with `archived`). */
export async function knownKind(raw: unknown, opts: { archived?: boolean } = {}): Promise<FieldKind> {
  if (isBuiltinKind(raw)) return raw;
  if (isCustomKind(raw)) {
    const row = await customKindRow(raw);
    if (!row) throw new AthenaInputError(`That ${KIND_WORD.one} doesn't exist`, 404);
    if (row.archived_at && !opts.archived) throw new AthenaInputError(`“${row.name}” is archived. Restore it from Archived first.`);
    return customKindKey(row.id);
  }
  throw new AthenaInputError(`Unknown kind '${String(raw)}': use one of ${FIELD_KIND_LIST.join(", ")}, or custom:<id> for one of the owner's ${KIND_WORD.many}`);
}

/** A custom kind's record, live (its kind too) unless `any`. */
const CUSTOM_RECORD = (any: boolean) => `SELECT r.id, r.title, r.updated_at FROM custom_records r JOIN custom_kinds k ON k.id = r.kind_id
   WHERE r.kind_id = $1${any ? "" : " AND r.archived_at IS NULL AND k.archived_at IS NULL"}`;

function idOf(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) throw new AthenaInputError(`Invalid ${what} id`);
  return raw;
}

/** One writer per kind at a time while names are checked: labels are sealed, so SQL can't hold them unique. */
async function lockKind(run: Run, kind: string): Promise<void> {
  await run(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`athena:custom_fields:${kind}`]);
}

const NEXT_POSITION = `(SELECT COALESCE(max(position) + 1, 0) FROM custom_fields WHERE kind = $2 AND archived_at IS NULL)`;

// ---------- fields ----------

/**
 * Fields in the owner's order, grouped by kind. Archived ones only when asked
 * (Settings' Archived list). Without a kind, an archived custom kind's fields
 * are left out: they're hidden with it.
 */
export async function listFields(opts: { kind?: FieldKind; includeArchived?: boolean } = {}): Promise<CustomField[]> {
  const rows = await q<FieldRow>(
    `SELECT ${FIELD_COLUMNS} FROM custom_fields f
     WHERE ($1::text IS NULL OR f.kind = $1) AND ($2::boolean OR f.archived_at IS NULL)
       AND ($1::text IS NOT NULL OR f.kind NOT LIKE 'custom:%'
            OR EXISTS (SELECT 1 FROM custom_kinds k WHERE k.archived_at IS NULL AND f.kind = 'custom:' || k.id::text))
     ORDER BY f.kind, f.position, f.created_at`,
    [opts.kind ?? null, opts.includeArchived ?? false],
  );
  return rows.map(toField);
}

export async function getField(id: string, opts: { includeArchived?: boolean } = {}): Promise<CustomField | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<FieldRow>(`SELECT ${FIELD_COLUMNS} FROM custom_fields f WHERE f.id = $1 AND ($2::boolean OR f.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  return row ? toField(row) : null;
}

/** A live field of a kind by its id or its name (any case; "interest" finds "Interests"). */
export async function findField(kind: FieldKind, labelOrId: string): Promise<CustomField | null> {
  const fields = await listFields({ kind });
  return fields.find((f) => f.id === labelOrId) ?? fields.find((f) => sameLabel(f.label, labelOrId)) ?? null;
}

export interface DefineInput {
  kind: unknown;
  label: unknown;
  type: unknown;
  options?: unknown;
  unit?: unknown;
}

export type DefineOutcome = "created" | "restored" | "exists";

/**
 * Add a field to a kind, at the end of its order. A name already in use for
 * that kind is refused, unless `reuse` (Ask's assistant): then the live field
 * comes back as it is, or an archived one is restored, values and all.
 */
export async function defineField(input: DefineInput, opts: { reuse?: boolean } = {}): Promise<{ field: CustomField; outcome: DefineOutcome }> {
  const kind = await knownKind(input.kind);
  if (!isFieldType(input.type)) throw new AthenaInputError(`Unknown field type '${String(input.type)}': use one of ${FIELD_TYPES.join(", ")}`);
  const type = input.type;
  const label = check(() => cleanLabel(input.label));
  const options = hasOptions(type) ? check(() => cleanOptions(input.options)) : [];
  const unit = type === "number" ? check(() => cleanUnit(input.unit)) : "";
  const many = fieldKindInfo(kind).many;
  const s = await sealer();

  const { id, outcome } = await tx(async (run): Promise<{ id: string; outcome: DefineOutcome }> => {
    await lockKind(run, kind);
    const named = (
      await run<{ id: string; label: string; archived_at: string | null }>(
        `SELECT id, label, archived_at FROM custom_fields WHERE kind = $1 ORDER BY archived_at DESC NULLS FIRST`,
        [kind],
      )
    ).filter((f) => sameLabel(f.label, label));
    const live = named.find((f) => !f.archived_at);
    if (live) {
      if (opts.reuse) return { id: live.id, outcome: "exists" };
      throw new AthenaInputError(`There's already a “${live.label}” field for ${many}.`);
    }
    const archived = named[0];
    if (archived) {
      if (!opts.reuse) throw new AthenaInputError(`There's an archived “${archived.label}” field for ${many}. Restore it from Archived, or pick another name.`);
      await run(`UPDATE custom_fields SET archived_at = NULL, position = ${NEXT_POSITION}, updated_at = now() WHERE id = $1`, [archived.id, kind]);
      return { id: archived.id, outcome: "restored" };
    }
    const [row] = await run<{ id: string }>(
      `INSERT INTO custom_fields (kind, label, type, options, unit, position)
       VALUES ($2, $1, $3, $4::jsonb, $5, ${NEXT_POSITION})
       RETURNING id`,
      [s.text(label), kind, type, s.json(options), s.text(unit)],
    );
    return { id: row.id, outcome: "created" };
  });
  return { field: (await getField(id))!, outcome };
}

export interface FieldPatch {
  label?: unknown;
  type?: unknown;
  /** choice / choices: the whole list, in order. */
  options?: unknown;
  /** Options renamed in this edit: values using `from` change to `to`. */
  renames?: unknown;
  unit?: unknown;
}

function parseRenames(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) return map;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { from, to } = r as { from?: unknown; to?: unknown };
    if (typeof from === "string" && typeof to === "string" && from.trim() && to.trim()) map.set(from.trim().toLowerCase(), to.trim().replace(/\s+/g, " "));
  }
  return map;
}

/**
 * Rename, retype or re-option a field. A type change is only allowed when
 * it's safe (lib/custom-field-rules.ts SAFE_TYPE_CHANGES), and carries every
 * value across; otherwise the owner is told to make a new field. Renaming an
 * option renames it in every value; removing one leaves values as they are.
 */
export async function updateField(id: string, patch: FieldPatch): Promise<CustomField> {
  idOf(id, "field");
  const s = await sealer();
  await tx(async (run) => {
    await run(`SELECT id FROM custom_fields WHERE id = $1 FOR UPDATE`, [id]);
    const [row] = await run<FieldRow>(`SELECT ${FIELD_COLUMNS} FROM custom_fields f WHERE f.id = $1`, [id]);
    if (!row) throw new AthenaInputError("That field doesn't exist", 404);
    const field = toField(row);
    const many = isFieldKind(field.kind) ? (await kindInfo(field.kind, run)).many : field.kind;
    const params: unknown[] = [id];
    const sets: string[] = [];
    const set = (column: string, value: unknown, cast = "") => sets.push(`${column} = $${params.push(value)}${cast}`);

    if (patch.label !== undefined) {
      const label = check(() => cleanLabel(patch.label));
      if (label !== field.label) {
        await lockKind(run, field.kind);
        const others = await run<{ label: string; archived_at: string | null }>(`SELECT label, archived_at FROM custom_fields WHERE kind = $1 AND id <> $2`, [
          field.kind,
          id,
        ]);
        const clash = others.find((o) => sameLabel(o.label, label));
        if (clash) {
          throw new AthenaInputError(
            clash.archived_at ? `There's an archived “${clash.label}” field for ${many}. Pick another name.` : `There's already a “${clash.label}” field for ${many}.`,
          );
        }
        set("label", s.text(label));
      }
    }

    // Values as stored, read once if anything below needs to rewrite them.
    let stored: Array<{ entity_id: string; value: FieldValue }> | null = null;
    const values = async () =>
      (stored ??= (await run<{ entity_id: string; value: string }>(`SELECT entity_id, value FROM custom_values WHERE field_id = $1`, [id])).flatMap((r) => {
        const value = readValue(field.type, r.value);
        return value === undefined ? [] : [{ entity_id: r.entity_id, value }];
      }));
    const changed = new Map<string, FieldValue>();

    let type = field.type;
    if (patch.type !== undefined && patch.type !== field.type) {
      if (!isFieldType(patch.type)) throw new AthenaInputError(`Unknown field type '${String(patch.type)}'`);
      if (!typeChangeAllowed(field.type, patch.type, field.value_count > 0)) throw new AthenaInputError(typeChangeRefusal(field.label, patch.type));
      type = patch.type;
      for (const v of await values()) {
        const next = convertValue(field.type, type, v.value);
        if (JSON.stringify(next) !== JSON.stringify(v.value)) changed.set(v.entity_id, next);
      }
      set("type", type);
    }

    if (!hasOptions(type)) {
      if (field.options.length) set("options", s.json([]), "::jsonb");
    } else if (patch.options !== undefined) {
      const options = check(() => cleanOptions(patch.options));
      const renames = parseRenames(patch.renames);
      if (renames.size) {
        const rename = (item: string) => renames.get(item.toLowerCase()) ?? item;
        for (const v of await values()) {
          const current = changed.get(v.entity_id) ?? convertValue(field.type, type, v.value);
          const next = Array.isArray(current) ? [...new Set(current.map(rename))] : typeof current === "string" ? rename(current) : current;
          if (JSON.stringify(next) !== JSON.stringify(v.value)) changed.set(v.entity_id, next);
        }
      }
      if (JSON.stringify(options) !== JSON.stringify(field.options)) set("options", s.json(options), "::jsonb");
    }

    if (type === "number") {
      if (patch.unit !== undefined) {
        const unit = check(() => cleanUnit(patch.unit));
        if (unit !== field.unit) set("unit", s.text(unit));
      }
    } else if (field.unit) set("unit", "");

    for (const [entityId, value] of changed) {
      await run(`UPDATE custom_values SET value = $3, updated_at = now() WHERE field_id = $1 AND entity_id = $2`, [id, entityId, s.text(JSON.stringify(value))]);
    }
    if (sets.length) await run(`UPDATE custom_fields SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  });
  return (await getField(id, { includeArchived: true }))!;
}

/** A field's values as they're stored, the readable ones (Ask's Undo of a field change puts them back). */
export async function fieldValues(id: string): Promise<Array<{ entity_id: string; value: FieldValue }>> {
  const field = await getField(id, { includeArchived: true });
  if (!field) return [];
  const rows = await q<{ entity_id: string; value: string }>(`SELECT entity_id, value FROM custom_values WHERE field_id = $1`, [id]);
  return rows.flatMap((r) => {
    const value = readValue(field.type, r.value);
    return value === undefined ? [] : [{ entity_id: r.entity_id, value }];
  });
}

/**
 * Put a field back exactly as it was before an edit (Ask's Undo): its name,
 * type, options and unit, and the values the edit rewrote. Unlike
 * updateField any type goes back, since it's what was there; a name another
 * field has taken since is refused.
 */
export async function restoreField(
  id: string,
  before: { label: string; type: string; options: string[]; unit: string },
  values: Array<{ entity_id: string; value: FieldValue }> = [],
): Promise<CustomField> {
  idOf(id, "field");
  if (!isFieldType(before.type)) throw new AthenaInputError(`Unknown field type '${before.type}'`);
  const type = before.type;
  const label = check(() => cleanLabel(before.label));
  const options = hasOptions(type) ? check(() => cleanOptions(before.options)) : [];
  const unit = type === "number" ? check(() => cleanUnit(before.unit)) : "";
  if (values.some((v) => !UUID_RE.test(v.entity_id) || !isValueOfType(type, v.value))) throw new AthenaInputError("Those values don't fit that field");
  const s = await sealer();
  await tx(async (run) => {
    const [f] = await run<{ kind: string }>(`SELECT kind FROM custom_fields WHERE id = $1 FOR UPDATE`, [id]);
    if (!f) throw new AthenaInputError("That field doesn't exist", 404);
    await lockKind(run, f.kind);
    const others = await run<{ label: string; archived_at: string | null }>(`SELECT label, archived_at FROM custom_fields WHERE kind = $1 AND id <> $2`, [f.kind, id]);
    const clash = others.find((o) => sameLabel(o.label, label));
    if (clash) throw new AthenaInputError(`There's ${clash.archived_at ? "an archived" : "already a"} “${clash.label}” field. Rename that one first.`);
    await run(`UPDATE custom_fields SET label = $2, type = $3, options = $4::jsonb, unit = $5, updated_at = now() WHERE id = $1`, [
      id,
      s.text(label),
      type,
      s.json(options),
      s.text(unit),
    ]);
    for (const v of values) {
      await run(`UPDATE custom_values SET value = $3, updated_at = now() WHERE field_id = $1 AND entity_id = $2`, [id, v.entity_id, s.text(JSON.stringify(v.value))]);
    }
  });
  return (await getField(id, { includeArchived: true }))!;
}

/** Put a kind's fields in this order (ids it doesn't list keep their order, after these). */
export async function reorderFields(kindRaw: unknown, ids: unknown): Promise<CustomField[]> {
  const kind = await knownKind(kindRaw);
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new AthenaInputError("Send the field ids in their new order");
  await tx(async (run) => {
    await lockKind(run, kind);
    const live = (await run<{ id: string }>(`SELECT id FROM custom_fields WHERE kind = $1 AND archived_at IS NULL ORDER BY position, created_at`, [kind])).map(
      (r) => r.id,
    );
    const wanted = [...new Set(ids as string[])].filter((id) => live.includes(id));
    const order = [...wanted, ...live.filter((id) => !wanted.includes(id))];
    await run(
      `UPDATE custom_fields AS f SET position = v.ord - 1, updated_at = now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, ord) WHERE f.id = v.id`,
      [order],
    );
  });
  return listFields({ kind });
}

/**
 * Archive a field (it disappears from every record; its values stay) or
 * restore it, at the end of its kind's order, with its values back.
 */
export async function setFieldArchived(id: string, archived: boolean): Promise<CustomField> {
  idOf(id, "field");
  if (archived) {
    await q(`UPDATE custom_fields SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL`, [id]);
  } else {
    await tx(async (run) => {
      const [f] = await run<{ kind: string; label: string; archived_at: string | null }>(`SELECT kind, label, archived_at FROM custom_fields WHERE id = $1 FOR UPDATE`, [id]);
      if (!f?.archived_at) return;
      await lockKind(run, f.kind);
      const live = await run<{ label: string }>(`SELECT label FROM custom_fields WHERE kind = $1 AND archived_at IS NULL AND id <> $2`, [f.kind, id]);
      const clash = live.find((o) => sameLabel(o.label, f.label));
      const many = isFieldKind(f.kind) ? (await kindInfo(f.kind, run)).many : f.kind;
      if (clash) throw new AthenaInputError(`There's already a “${clash.label}” field for ${many}. Rename one of them first.`);
      await run(`UPDATE custom_fields SET archived_at = NULL, position = ${NEXT_POSITION}, updated_at = now() WHERE id = $1`, [id, f.kind]);
    });
  }
  const field = await getField(id, { includeArchived: true });
  if (!field) throw new AthenaInputError("That field doesn't exist", 404);
  return field;
}

// ---------- values ----------

/** Values of a kind's live fields: every record's, or just these records'. */
export async function listValues(kindRaw: unknown, entityIds?: string[]): Promise<CustomValue[]> {
  const kind = await knownKind(kindRaw);
  if (entityIds?.some((id) => !UUID_RE.test(id))) throw new AthenaInputError("Invalid record id");
  const rows = await q<{ field_id: string; entity_id: string; value: string; updated_at: string; type: FieldType }>(
    `SELECT v.field_id, v.entity_id, v.value, v.updated_at, f.type
     FROM custom_values v JOIN custom_fields f ON f.id = v.field_id AND f.archived_at IS NULL
     WHERE v.entity_kind = $1 AND f.kind = $1 AND ($2::uuid[] IS NULL OR v.entity_id = ANY($2::uuid[]))`,
    [kind, entityIds ?? null],
  );
  return rows.flatMap((r) => {
    const value = readValue(r.type, r.value);
    return value === undefined ? [] : [{ field_id: r.field_id, entity_kind: kind, entity_id: r.entity_id, value, updated_at: r.updated_at }];
  });
}

export interface FieldWithValue {
  field: CustomField;
  value: FieldValue;
}

/** Records' filled-in fields, in the owner's order, by record id (MCP's get_* and list_* output). */
export async function valuesByRecord(kind: FieldKind, ids: string[]): Promise<Map<string, FieldWithValue[]>> {
  const out = new Map<string, FieldWithValue[]>();
  const wanted = ids.filter((id) => UUID_RE.test(id));
  if (!wanted.length) return out;
  const [fields, values] = await Promise.all([listFields({ kind }), listValues(kind, wanted)]);
  if (!fields.length) return out;
  const byKey = new Map(values.map((v) => [`${v.entity_id}:${v.field_id}`, v.value]));
  for (const id of wanted) {
    const filled = fields.flatMap((field) => (byKey.has(`${id}:${field.id}`) ? [{ field, value: byKey.get(`${id}:${field.id}`)! }] : []));
    if (filled.length) out.set(id, filled);
  }
  return out;
}

export async function recordValues(kind: FieldKind, id: string): Promise<FieldWithValue[]> {
  return (await valuesByRecord(kind, [id])).get(id) ?? [];
}

/** A live record's display title, or null when it's archived or gone (or, for a custom kind, its kind is). */
export async function recordTitle(kind: FieldKind, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  if (isCustomKind(kind)) {
    const [row] = await q<{ title: string }>(`${CUSTOM_RECORD(false)} AND r.id = $2`, [customKindId(kind), id]);
    return row ? row.title : null;
  }
  const { table, title } = fieldKindInfo(kind);
  const [row] = await q<{ title: string }>(`SELECT ${title} AS title FROM ${table} WHERE id = $1 AND archived_at IS NULL`, [id]);
  return row ? row.title : null;
}

/** Live records of a kind whose name matches (exact, then starts with, then has every word). Names are sealed, so this matches here. */
export async function findRecords(kindRaw: unknown, query: string, limit = 8): Promise<Array<{ id: string; title: string }>> {
  const kind = await knownKind(kindRaw);
  const { table, title } = fieldKindInfo(kind);
  const rows = isCustomKind(kind)
    ? await q<{ id: string; title: string; updated_at: string }>(CUSTOM_RECORD(false), [customKindId(kind)])
    : await q<{ id: string; title: string; updated_at: string }>(`SELECT id, ${title} AS title, updated_at FROM ${table} WHERE archived_at IS NULL`);
  const term = query.trim().toLowerCase();
  const words = term.split(/\s+/).filter(Boolean);
  const tier = (t: string) => (t === term ? 0 : t.startsWith(term) ? 1 : words.every((w) => t.includes(w)) ? 2 : -1);
  return rows
    .filter((r) => !isEncryptedPlaceholder(r.title))
    .map((r) => ({ r, tier: tier((r.title ?? "").toLowerCase()) }))
    .filter((x) => x.tier >= 0)
    .sort((a, b) => a.tier - b.tier || new Date(b.r.updated_at).getTime() - new Date(a.r.updated_at).getTime())
    .slice(0, limit)
    .map(({ r }) => ({ id: r.id, title: r.title || "Untitled" }));
}

export interface SetValueInput {
  field_id: unknown;
  entity_id: unknown;
  /** Optional check: the record's kind must be the field's. */
  entity_kind?: unknown;
  /** null, "" or [] clears it. */
  value: unknown;
}

export interface SetValueResult {
  field: CustomField;
  value: CustomValue | null;
  /** What it was before (null = empty), for undo. */
  previous: FieldValue | null;
}

/** Undo puts back exactly what was there; it may predate an option's rename, so options aren't checked. */
function restoreShape(field: CustomField, raw: unknown): Normalised {
  if (raw === null || raw === undefined) return { value: null, newOptions: [] };
  if (isValueOfType(field.type, raw)) return { value: raw, newOptions: [] };
  return check(() => normaliseValue(field, raw));
}

/**
 * Set or clear one field on one live record. The value is checked and tidied
 * for its type (lib/custom-field-rules.ts normaliseValue); new choices are
 * added to the field's options. `restore` (undo) also writes to archived
 * fields and records, and takes the old value as it was.
 */
export async function setValue(input: SetValueInput, opts: { restore?: boolean } = {}): Promise<SetValueResult> {
  const fieldId = idOf(input.field_id, "field");
  const entityId = idOf(input.entity_id, "record");
  const s = await sealer();
  const previous = await tx(async (run) => {
    await run(`SELECT id FROM custom_fields WHERE id = $1 FOR UPDATE`, [fieldId]);
    const [row] = await run<FieldRow>(`SELECT ${FIELD_COLUMNS} FROM custom_fields f WHERE f.id = $1`, [fieldId]);
    if (!row) throw new AthenaInputError("That field doesn't exist", 404);
    const field = toField(row);
    if (!isFieldKind(field.kind)) throw new AthenaInputError(`Fields for '${field.kind}' can't be filled in here`);
    const info = await kindInfo(field.kind, run);
    if (input.entity_kind !== undefined && input.entity_kind !== field.kind) throw new AthenaInputError(`“${field.label}” is a field for ${info.many}`);
    if (field.archived_at && !opts.restore) throw new AthenaInputError(`“${field.label}” is archived. Restore it from Archived first.`);
    // A custom kind's records share one table: the record must be of this field's kind.
    const [exists] = isCustomKind(field.kind)
      ? await run<{ ok: number }>(`${CUSTOM_RECORD(!!opts.restore)} AND r.id = $2`, [customKindId(field.kind), entityId])
      : await run<{ ok: number }>(`SELECT 1 AS ok FROM ${info.table} WHERE id = $1${opts.restore ? "" : " AND archived_at IS NULL"}`, [entityId]);
    if (!exists) throw new AthenaInputError(`That ${info.one} doesn't exist or is archived`, 404);

    const [old] = await run<{ value: string }>(`SELECT value FROM custom_values WHERE field_id = $1 AND entity_id = $2`, [fieldId, entityId]);
    // Couldn't be decrypted here: overwriting it would lose what might still be recoverable.
    if (old && isEncryptedPlaceholder(old.value)) throw new PlaceholderWrite();
    const before = old ? (readValue(field.type, old.value) ?? null) : null;

    const { value, newOptions } = opts.restore ? restoreShape(field, input.value) : check(() => normaliseValue(field, input.value));
    if (value === null) {
      await run(`DELETE FROM custom_values WHERE field_id = $1 AND entity_id = $2`, [fieldId, entityId]);
    } else {
      await run(
        `INSERT INTO custom_values (field_id, entity_kind, entity_id, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (field_id, entity_id) DO UPDATE SET value = EXCLUDED.value, entity_kind = EXCLUDED.entity_kind, updated_at = now()`,
        [fieldId, field.kind, entityId, s.text(JSON.stringify(value))],
      );
    }
    if (newOptions.length) {
      await run(`UPDATE custom_fields SET options = $2::jsonb, updated_at = now() WHERE id = $1`, [fieldId, s.json([...field.options, ...newOptions])]);
    }
    return before;
  });

  const field = (await getField(fieldId, { includeArchived: true }))!;
  const [row] = await q<{ value: string; updated_at: string }>(`SELECT value, updated_at FROM custom_values WHERE field_id = $1 AND entity_id = $2`, [fieldId, entityId]);
  const value = row ? readValue(field.type, row.value) : undefined;
  return {
    field,
    value: value === undefined ? null : { field_id: fieldId, entity_kind: field.kind, entity_id: entityId, value, updated_at: row.updated_at },
    previous,
  };
}

/**
 * The words in records' text and choices fields, by record id: recall
 * searches them with the record. `custom` adds every custom kind's records.
 */
export async function searchableValues(kinds: FieldKind[], opts: { custom?: boolean } = {}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const rows = await q<{ entity_id: string; value: string; type: FieldType }>(
    `SELECT v.entity_id, v.value, f.type
     FROM custom_values v JOIN custom_fields f ON f.id = v.field_id AND f.archived_at IS NULL
     WHERE (v.entity_kind = ANY($1::text[]) OR ($2::boolean AND v.entity_kind LIKE 'custom:%'))
       AND f.type IN ('text', 'long_text', 'choice', 'choices')`,
    [kinds, opts.custom ?? false],
  );
  for (const r of rows) {
    const value = readValue(r.type, r.value);
    const text = value === undefined ? "" : searchText(r.type, value);
    if (text) map.set(r.entity_id, map.has(r.entity_id) ? `${map.get(r.entity_id)} ${text}` : text);
  }
  return map;
}
