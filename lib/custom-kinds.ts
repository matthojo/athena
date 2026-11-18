/**
 * The owner's own kinds of record ("Wines", "Plants", "Board games") and the
 * records kept of them. The SQL for both lives here, beside
 * lib/custom-fields.ts, whose fields and values they reuse: a kind's fields
 * are custom fields of kind 'custom:<kind id>', and a record's values are
 * custom values with that entity kind. The app, Ask and MCP all go through
 * these functions.
 *
 * Same rules as lib/db.ts. Nothing here deletes: kinds and records are
 * archived (archiveEntity / unarchiveEntity, kinds "kind" and "record"), and
 * permanent deletion is the owner's, from the Archived page
 * (deleteEntityForever). An archived kind hides itself and every record of it
 * from every read; its fields and values are kept and come back with it.
 *
 * Encrypted at rest (SECURITY.md §11): names, singular names, titles and
 * bodies are sealed on the way in and come back opened from q() and tx().
 * SQL never compares, sorts or searches them: names are matched, lists sorted
 * and records searched here in TypeScript.
 */
import { AthenaInputError, byName, q, sealer, syncContentLinks, tx, unarchiveEntity } from "./db";
import { PlaceholderWrite } from "./data-box";
import { isEncryptedPlaceholder } from "./encrypted";
import { findField, listFields, listValues, setValue } from "./custom-fields";
import {
  FieldError,
  KIND_ICONS,
  KIND_LIMITS,
  cleanKindName,
  cleanKindOne,
  cleanLabel,
  cleanOptions,
  cleanRecordTitle,
  cleanUnit,
  copyName,
  customKindId,
  customKindKey,
  formatValue,
  hasOptions,
  isCustomKind,
  isFieldType,
  isKindIcon,
  labelKey,
  normaliseValue,
  registerCustomKinds,
  sameLabel,
  searchText,
  singular,
  type CustomField,
  type CustomFieldKind,
  type FieldType,
  type FieldValue,
} from "./custom-field-rules";
import { KIND_WORD } from "./custom-kind-words";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

export interface CustomKind {
  id: string;
  /** Its fields' kind: 'custom:<id>'. */
  kind: CustomFieldKind;
  /** "Wines", as the Library shows it. */
  name: string;
  /** "wine": one record, mid-sentence ("New wine"). */
  one: string;
  /** One of KIND_ICONS. */
  icon: string;
  position: number;
  /** Live records. */
  record_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomRecord {
  id: string;
  kind_id: string;
  title: string;
  /** Markdown. athena:// links in it are this record's 'content' links. */
  body: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
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

/** One writer at a time while names are checked: they're sealed, so SQL can't hold them unique. */
const lockKinds = (run: Run) => run(`SELECT pg_advisory_xact_lock(hashtext('athena:custom_kinds'))`);

const NEXT_POSITION = `(SELECT COALESCE(max(position) + 1, 0) FROM custom_kinds WHERE archived_at IS NULL)`;

// ---------- kinds ----------

const KIND_COLUMNS = `k.id, k.name, k.one, k.icon, k.position, k.archived_at, k.created_at, k.updated_at,
  (SELECT count(*)::int FROM custom_records r WHERE r.kind_id = k.id AND r.archived_at IS NULL) AS record_count`;

type KindRow = Omit<CustomKind, "kind" | "record_count"> & { record_count: number | string | null };

function toKind(row: KindRow): CustomKind {
  return { ...row, kind: customKindKey(row.id), record_count: Number(row.record_count ?? 0) };
}

const readable = (k: { name: string; one: string }) => !isEncryptedPlaceholder(k.name) && !isEncryptedPlaceholder(k.one);

/** The owner's kinds in their order (archived ones last, when asked for). */
export async function listKinds(opts: { includeArchived?: boolean } = {}): Promise<CustomKind[]> {
  const rows = await q<KindRow>(
    `SELECT ${KIND_COLUMNS} FROM custom_kinds k WHERE ($1::boolean OR k.archived_at IS NULL)
     ORDER BY k.archived_at IS NOT NULL, k.position, k.created_at`,
    [opts.includeArchived ?? false],
  );
  const kinds = rows.map(toKind);
  registerCustomKinds(kinds.filter(readable));
  return kinds;
}

/** By id (or 'custom:<id>'). Archived kinds only when asked. */
export async function getKind(ref: string, opts: { includeArchived?: boolean } = {}): Promise<CustomKind | null> {
  const id = isCustomKind(ref) ? customKindId(ref) : ref;
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<KindRow>(`SELECT ${KIND_COLUMNS} FROM custom_kinds k WHERE k.id = $1 AND ($2::boolean OR k.archived_at IS NULL)`, [
    id,
    opts.includeArchived ?? false,
  ]);
  if (!row) return null;
  const kind = toKind(row);
  if (readable(kind)) registerCustomKinds([kind]);
  return kind;
}

/** A live kind by id, 'custom:<id>' or name: "wines", "Wine" and "WINES" all find Wines. */
export async function findKind(ref: string): Promise<CustomKind | null> {
  const t = ref.trim();
  if (UUID_RE.test(t) || isCustomKind(t)) return getKind(t);
  const key = labelKey(t);
  if (!key) return null;
  return (await listKinds()).find((k) => labelKey(k.name) === key || labelKey(k.one) === key) ?? null;
}

/** findKind, or a 404 in the owner's words. */
export async function requireKind(ref: unknown): Promise<CustomKind> {
  const kind = typeof ref === "string" ? await findKind(ref) : null;
  if (!kind) throw new AthenaInputError(`There's no ${KIND_WORD.one} called “${String(ref ?? "")}”`, 404);
  return kind;
}

/** Does another kind (live or archived) already go by this name or singular? */
function clashOf<T extends { id: string; name: string; one: string }>(rows: T[], name: string, one: string, selfId?: string): T | undefined {
  return rows.find((r) => r.id !== selfId && (sameLabel(r.name, name) || sameLabel(r.one, one) || sameLabel(r.name, one) || sameLabel(r.one, name)));
}

export interface KindFieldInput {
  label: unknown;
  type: unknown;
  options?: unknown;
  unit?: unknown;
}

export interface KindInput {
  name: unknown;
  one?: unknown;
  icon?: unknown;
  /** Fields to start with, in order. */
  fields?: unknown;
}

export type KindOutcome = "created" | "exists" | "restored";

const MAX_START_FIELDS = 30;

function cleanIcon(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return KIND_ICONS[0];
  if (!isKindIcon(raw)) throw new AthenaInputError(`Pick one of the icons: ${KIND_ICONS.join(", ")}`);
  return raw;
}

/** The fields a new kind starts with, checked before anything is saved. */
function startFields(raw: unknown): Array<{ label: string; type: FieldType; options: string[]; unit: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AthenaInputError("Send the fields as a list");
  if (raw.length > MAX_START_FIELDS) throw new AthenaInputError(`Start with up to ${MAX_START_FIELDS} fields; you can add more later`);
  const out: Array<{ label: string; type: FieldType; options: string[]; unit: string }> = [];
  for (const item of raw) {
    const f = (item ?? {}) as KindFieldInput;
    const label = check(() => cleanLabel(f.label));
    if (!isFieldType(f.type)) throw new AthenaInputError(`“${label}” needs a type: one of text, long_text, number, rating, boolean, date, link, choice, choices`);
    if (out.some((o) => sameLabel(o.label, label))) throw new AthenaInputError(`“${label}” is in the list twice`);
    out.push({
      label,
      type: f.type,
      options: hasOptions(f.type) ? check(() => cleanOptions(f.options)) : [],
      unit: f.type === "number" ? check(() => cleanUnit(f.unit)) : "",
    });
  }
  return out;
}

/**
 * Make a kind, with the fields it starts with, at the end of the owner's
 * order. A name already in use (or the same name for one) is refused, unless
 * `reuse` (Ask's assistant): then a live kind comes back as it is, and an
 * archived one is restored with its fields and records.
 */
export async function createKind(input: KindInput, opts: { reuse?: boolean } = {}): Promise<{ kind: CustomKind; outcome: KindOutcome; fields: CustomField[] }> {
  const name = check(() => cleanKindName(input.name));
  const one = check(() => cleanKindOne(input.one, name));
  const icon = cleanIcon(input.icon);
  const fields = startFields(input.fields);
  const s = await sealer();

  const { id, outcome } = await tx(async (run): Promise<{ id: string; outcome: KindOutcome }> => {
    await lockKinds(run);
    const rows = await run<{ id: string; name: string; one: string; archived_at: string | null }>(
      `SELECT id, name, one, archived_at FROM custom_kinds ORDER BY archived_at DESC NULLS FIRST`,
    );
    const live = rows.filter((r) => !r.archived_at);
    const liveClash = clashOf(live, name, one);
    if (liveClash) {
      if (opts.reuse) return { id: liveClash.id, outcome: "exists" };
      throw new AthenaInputError(`There's already a “${liveClash.name}” ${KIND_WORD.one}.`);
    }
    const archived = clashOf(
      rows.filter((r) => r.archived_at),
      name,
      one,
    );
    if (archived) {
      if (opts.reuse) return { id: archived.id, outcome: "restored" };
      throw new AthenaInputError(`There's an archived “${archived.name}” ${KIND_WORD.one}. Restore it from Archived, or pick another name.`);
    }
    if (live.length >= KIND_LIMITS.kinds) throw new AthenaInputError(`You can have up to ${KIND_LIMITS.kinds} ${KIND_WORD.many}. Archive one you don't use first.`);
    const [row] = await run<{ id: string }>(`INSERT INTO custom_kinds (name, one, icon, position) VALUES ($1, $2, $3, ${NEXT_POSITION}) RETURNING id`, [
      s.text(name),
      s.text(one),
      icon,
    ]);
    for (const [i, f] of fields.entries()) {
      await run(`INSERT INTO custom_fields (kind, label, type, options, unit, position) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [
        customKindKey(row.id),
        s.text(f.label),
        f.type,
        s.json(f.options),
        s.text(f.unit),
        i,
      ]);
    }
    return { id: row.id, outcome: "created" };
  });

  if (outcome === "restored") await unarchiveEntity("kind", id);
  const kind = (await getKind(id))!;
  return { kind, outcome, fields: await listFields({ kind: kind.kind }) };
}

export interface KindPatch {
  name?: unknown;
  one?: unknown;
  icon?: unknown;
}

/**
 * Rename a kind, change what one of it is called, or its icon. A new name
 * brings a new singular with it when the old one was worked out from the old
 * name ("Wines" -> "Red wines" makes "red wine") and none was given.
 */
export async function updateKind(ref: string, patch: KindPatch): Promise<CustomKind> {
  const current = await getKind(ref);
  if (!current) throw new AthenaInputError(`That ${KIND_WORD.one} doesn't exist or is archived`, 404);
  if (!readable(current)) throw new PlaceholderWrite();
  const name = patch.name !== undefined ? check(() => cleanKindName(patch.name)) : current.name;
  const derived = current.one === singular(current.name);
  const one =
    patch.one !== undefined && patch.one !== null && patch.one !== ""
      ? check(() => cleanKindOne(patch.one, name))
      : name !== current.name && derived
        ? check(() => cleanKindOne(undefined, name))
        : current.one;
  const icon = patch.icon !== undefined ? cleanIcon(patch.icon) : current.icon;
  if (name === current.name && one === current.one && icon === current.icon) return current;
  const s = await sealer();
  await tx(async (run) => {
    await lockKinds(run);
    const rows = await run<{ id: string; name: string; one: string; archived_at: string | null }>(`SELECT id, name, one, archived_at FROM custom_kinds`);
    const clash = clashOf(rows, name, one, current.id);
    if (clash) {
      throw new AthenaInputError(
        clash.archived_at ? `There's an archived “${clash.name}” ${KIND_WORD.one}. Pick another name.` : `There's already a “${clash.name}” ${KIND_WORD.one}.`,
      );
    }
    await run(`UPDATE custom_kinds SET name = $2, one = $3, icon = $4, updated_at = now() WHERE id = $1`, [current.id, s.text(name), s.text(one), icon]);
  });
  return (await getKind(current.id))!;
}

/** Put the owner's kinds in this order (ids it doesn't list keep their order, after these). */
export async function reorderKinds(ids: unknown): Promise<CustomKind[]> {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new AthenaInputError(`Send the ${KIND_WORD.many}' ids in their new order`);
  await tx(async (run) => {
    await lockKinds(run);
    const live = (await run<{ id: string }>(`SELECT id FROM custom_kinds WHERE archived_at IS NULL ORDER BY position, created_at`)).map((r) => r.id);
    const wanted = [...new Set(ids as string[])].filter((id) => live.includes(id));
    const order = [...wanted, ...live.filter((id) => !wanted.includes(id))];
    await run(
      `UPDATE custom_kinds AS k SET position = v.ord - 1, updated_at = now()
       FROM unnest($1::uuid[]) WITH ORDINALITY AS v(id, ord) WHERE k.id = v.id`,
      [order],
    );
  });
  return listKinds();
}

/**
 * Copy a kind: "Wines copy", with every live field (names, types, options,
 * units and order) and none of its records, placed just after it. The copy's
 * fields are written as the original's are stored, so nothing is decrypted.
 */
export async function duplicateKind(ref: string): Promise<{ kind: CustomKind; fields: CustomField[] }> {
  const source = await getKind(ref);
  if (!source) throw new AthenaInputError(`That ${KIND_WORD.one} doesn't exist or is archived`, 404);
  if (!readable(source)) throw new PlaceholderWrite();
  const s = await sealer();
  const id = await tx(async (run) => {
    await lockKinds(run);
    const rows = await run<{ id: string; name: string; one: string; archived_at: string | null }>(`SELECT id, name, one, archived_at FROM custom_kinds`);
    if (rows.filter((r) => !r.archived_at).length >= KIND_LIMITS.kinds) {
      throw new AthenaInputError(`You can have up to ${KIND_LIMITS.kinds} ${KIND_WORD.many}. Archive one you don't use first.`);
    }
    const name = copyName(source.name, (c) => rows.some((r) => sameLabel(r.name, c) || sameLabel(r.one, c)));
    const one = copyName(source.one, (c) => rows.some((r) => sameLabel(r.one, c) || sameLabel(r.name, c)));
    await run(`UPDATE custom_kinds SET position = position + 1 WHERE archived_at IS NULL AND position > $1`, [source.position]);
    const [row] = await run<{ id: string }>(`INSERT INTO custom_kinds (name, one, icon, position) VALUES ($1, $2, $3, $4) RETURNING id`, [
      s.text(name),
      s.text(one),
      source.icon,
      source.position + 1,
    ]);
    await run(
      `INSERT INTO custom_fields (kind, label, type, options, unit, position)
       SELECT $2, label, type, options, unit, position FROM custom_fields WHERE kind = $1 AND archived_at IS NULL`,
      [source.kind, customKindKey(row.id)],
    );
    return row.id;
  });
  const kind = (await getKind(id))!;
  return { kind, fields: await listFields({ kind: kind.kind }) };
}

// ---------- records ----------

const RECORD_COLUMNS = `r.id, r.kind_id, r.title, r.body, r.archived_at, r.created_at, r.updated_at`;

/** A kind's live records, by title (sorted here: titles are sealed). Nothing while the kind is archived. */
export async function listCustomRecords(kindRef: string, opts: { limit?: number } = {}): Promise<CustomRecord[]> {
  const kind = await getKind(kindRef);
  if (!kind) return [];
  const rows = await q<CustomRecord>(`SELECT ${RECORD_COLUMNS} FROM custom_records r WHERE r.kind_id = $1 AND r.archived_at IS NULL`, [kind.id]);
  return rows.sort(byName((r) => r.title)).slice(0, opts.limit ?? 1000);
}

/** One record, live and of a live kind unless `includeArchived`. */
export async function getCustomRecord(id: string, opts: { includeArchived?: boolean } = {}): Promise<CustomRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await q<CustomRecord>(
    `SELECT ${RECORD_COLUMNS} FROM custom_records r JOIN custom_kinds k ON k.id = r.kind_id
     WHERE r.id = $1 AND ($2::boolean OR (r.archived_at IS NULL AND k.archived_at IS NULL))`,
    [id, opts.includeArchived ?? false],
  );
  return row ?? null;
}

/** Field values to set on a record: { "Grape": "Syrah" }, or [{ field, value }]. */
export type ValuesInput = Record<string, unknown> | Array<{ field: unknown; value: unknown }>;

export interface ValueChange {
  field: CustomField;
  /** What it was (null = empty), for undo. */
  previous: FieldValue | null;
  value: FieldValue | null;
}

function valuePairs(raw: unknown): Array<{ field: string; value: unknown }> {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.map((p) => {
      const pair = (p ?? {}) as { field?: unknown; value?: unknown };
      if (typeof pair.field !== "string" || !pair.field.trim()) throw new AthenaInputError("Each value needs the field's name");
      return { field: pair.field, value: pair.value ?? null };
    });
  }
  if (typeof raw === "object") return Object.entries(raw as Record<string, unknown>).map(([field, value]) => ({ field, value: value ?? null }));
  throw new AthenaInputError("Send values as { field name: value }");
}

/**
 * Work out which field each value is for, and check every value fits, before
 * anything is written: a record isn't half-saved because its third value was
 * wrong. Names match like field names do ("grape" finds Grape).
 */
async function resolveValues(kind: CustomKind, raw: unknown): Promise<Array<{ field: CustomField; value: unknown }>> {
  const pairs = valuePairs(raw);
  const out: Array<{ field: CustomField; value: unknown }> = [];
  for (const { field: name, value } of pairs) {
    const field = await findField(kind.kind, name);
    if (!field) {
      const names = (await listFields({ kind: kind.kind })).map((f) => f.label);
      throw new AthenaInputError(`${kind.name} have no “${name}” field${names.length ? ` (they have: ${names.join(", ")})` : ""}. Add it first.`);
    }
    check(() => normaliseValue(field, value));
    out.push({ field, value });
  }
  return out;
}

async function writeValues(recordId: string, values: Array<{ field: CustomField; value: unknown }>): Promise<ValueChange[]> {
  const changes: ValueChange[] = [];
  for (const { field, value } of values) {
    const result = await setValue({ field_id: field.id, entity_id: recordId, value });
    changes.push({ field: result.field, previous: result.previous, value: result.value?.value ?? null });
  }
  return changes;
}

function cleanBody(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new AthenaInputError("The body should be text (Markdown)");
  if (raw.length > KIND_LIMITS.body) throw new AthenaInputError(`Keep it under ${KIND_LIMITS.body.toLocaleString("en-GB")} characters`);
  return raw;
}

export interface RecordInput {
  /** The kind, by id, 'custom:<id>' or name. Only when creating. */
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  values?: unknown;
}

/** Add a record to a live kind, with its body and field values. Links in the body become its links. */
export async function createCustomRecord(input: RecordInput): Promise<{ record: CustomRecord; kind: CustomKind; changes: ValueChange[] }> {
  const kind = await requireKind(input.kind);
  const title = check(() => cleanRecordTitle(input.title, kind.one));
  const body = cleanBody(input.body) ?? "";
  const values = await resolveValues(kind, input.values);
  const s = await sealer();
  const [row] = await q<{ id: string }>(`INSERT INTO custom_records (kind_id, title, body) VALUES ($1, $2, $3) RETURNING id`, [kind.id, s.text(title), s.text(body)]);
  if (body) await syncContentLinks(row.id, body, "record");
  const changes = await writeValues(row.id, values);
  return { record: (await getCustomRecord(row.id, { includeArchived: true }))!, kind, changes };
}

/** Change a record's title, body and/or values. Omitted ones are left as they are. */
export async function updateCustomRecord(id: string, patch: RecordInput): Promise<{ record: CustomRecord; kind: CustomKind; changes: ValueChange[]; before: CustomRecord }> {
  const before = await getCustomRecord(id);
  if (!before) throw new AthenaInputError("That doesn't exist, or it's archived", 404);
  const kind = (await getKind(before.kind_id))!;
  const title = patch.title !== undefined ? check(() => cleanRecordTitle(patch.title, kind.one)) : undefined;
  const body = cleanBody(patch.body);
  const values = await resolveValues(kind, patch.values);
  if ((title !== undefined && isEncryptedPlaceholder(before.title)) || (body !== undefined && isEncryptedPlaceholder(before.body))) throw new PlaceholderWrite();
  const s = await sealer();
  if (title !== undefined || body !== undefined) {
    await q(`UPDATE custom_records SET title = COALESCE($2, title), body = COALESCE($3, body), updated_at = now() WHERE id = $1`, [
      id,
      s.maybe(title ?? null),
      s.maybe(body ?? null),
    ]);
    if (body !== undefined) await syncContentLinks(id, body, "record");
  }
  const changes = await writeValues(id, values);
  if (changes.length && title === undefined && body === undefined) await q(`UPDATE custom_records SET updated_at = now() WHERE id = $1`, [id]);
  return { record: (await getCustomRecord(id, { includeArchived: true }))!, kind, changes, before };
}

/**
 * Copy a record: "<Title> copy", with its body and every field value. Links in
 * the body come along the same way a saved body's do (syncContentLinks).
 */
export async function duplicateCustomRecord(id: string): Promise<{ record: CustomRecord; kind: CustomKind }> {
  const source = await getCustomRecord(id);
  if (!source) throw new AthenaInputError("That doesn't exist, or it's archived", 404);
  if (isEncryptedPlaceholder(source.title) || isEncryptedPlaceholder(source.body)) throw new PlaceholderWrite();
  const kind = (await getKind(source.kind_id))!;
  const title = copyTitle(source.title);
  const s = await sealer();
  const [row] = await q<{ id: string }>(`INSERT INTO custom_records (kind_id, title, body) VALUES ($1, $2, $3) RETURNING id`, [
    kind.id,
    s.text(title),
    s.text(source.body),
  ]);
  // Values are copied as stored (sealed), only for fields that are live.
  await q(
    `INSERT INTO custom_values (field_id, entity_kind, entity_id, value)
     SELECT v.field_id, v.entity_kind, $2, v.value FROM custom_values v JOIN custom_fields f ON f.id = v.field_id AND f.archived_at IS NULL
     WHERE v.entity_id = $1 AND v.entity_kind = $3`,
    [source.id, row.id, kind.kind],
  );
  if (source.body) await syncContentLinks(row.id, source.body, "record");
  return { record: (await getCustomRecord(row.id))!, kind };
}

/** "Château Musar copy", kept to the title limit. */
function copyTitle(title: string): string {
  return `${title.slice(0, KIND_LIMITS.title - 5).trimEnd()} copy`;
}

// ---------- reading records with their fields ----------

/** One filled-in field, as Ask and MCP read it. */
export interface RecordField {
  field_id: string;
  name: string;
  type: FieldType;
  value: FieldValue;
  /** How it reads: "£18", "4 stars", "Syrah, Grenache". */
  text: string;
}

export interface RecordDetail extends CustomRecord {
  /** Its kind's names. */
  kind: { id: string; name: string; one: string };
  fields: RecordField[];
}

/** Records with their kind's names and filled-in fields, in the owner's field order. */
export async function withRecordFields(kind: CustomKind, records: CustomRecord[]): Promise<RecordDetail[]> {
  if (!records.length) return [];
  const [fields, values] = await Promise.all([listFields({ kind: kind.kind }), listValues(kind.kind, records.map((r) => r.id))]);
  const byKey = new Map(values.map((v) => [`${v.entity_id}:${v.field_id}`, v.value]));
  return records.map((r) => ({
    ...r,
    kind: { id: kind.id, name: kind.name, one: kind.one },
    fields: fields.flatMap((f) => {
      const value = byKey.get(`${r.id}:${f.id}`);
      return value === undefined ? [] : [{ field_id: f.id, name: f.label, type: f.type, value, text: formatValue(f, value) }];
    }),
  }));
}

export async function recordDetail(id: string): Promise<RecordDetail | null> {
  const record = await getCustomRecord(id);
  if (!record) return null;
  const kind = await getKind(record.kind_id);
  if (!kind) return null;
  return (await withRecordFields(kind, [record]))[0];
}

export interface RecordMatch {
  id: string;
  kind_id: string;
  /** "Wines". */
  kind: string;
  /** "wine". */
  one: string;
  title: string;
  /** Where the words were found: a line of the body, or "Region: Bekaa Valley". */
  snippet: string;
  updated_at: string;
}

const plain = (markdown: string) =>
  markdown
    .replace(/\[@?([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Live records whose title, body or text and choice values hold every word
 * of the query (titles first), newest first within each. Optionally one
 * kind's. An empty query lists them. Decrypted and matched here.
 */
export async function searchCustomRecords(query: string, opts: { kind?: string; limit?: number } = {}): Promise<RecordMatch[]> {
  const kinds = opts.kind ? [await requireKind(opts.kind)] : await listKinds();
  if (!kinds.length) return [];
  const byId = new Map(kinds.map((k) => [k.id, k]));
  const [rows, fields] = await Promise.all([
    q<CustomRecord>(`SELECT ${RECORD_COLUMNS} FROM custom_records r WHERE r.archived_at IS NULL AND r.kind_id = ANY($1::uuid[])`, [kinds.map((k) => k.id)]),
    Promise.all(kinds.map((k) => listFields({ kind: k.kind }))).then((all) => all.flat()),
  ]);
  const searchable = fields.filter((f) => ["text", "long_text", "choice", "choices"].includes(f.type));
  const values = rows.length && searchable.length
    ? await q<{ entity_id: string; field_id: string; value: string }>(
        `SELECT entity_id, field_id, value FROM custom_values WHERE field_id = ANY($1::uuid[]) AND entity_id = ANY($2::uuid[])`,
        [searchable.map((f) => f.id), rows.map((r) => r.id)],
      )
    : [];
  const fieldById = new Map(searchable.map((f) => [f.id, f]));
  const valueText = new Map<string, Array<{ label: string; text: string }>>();
  for (const v of values) {
    const f = fieldById.get(v.field_id);
    if (!f || isEncryptedPlaceholder(v.value)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.value);
    } catch {
      continue;
    }
    const text = typeof parsed === "string" || Array.isArray(parsed) ? searchText(f.type, parsed as FieldValue) : "";
    if (text) valueText.set(v.entity_id, [...(valueText.get(v.entity_id) ?? []), { label: f.label, text }]);
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ match: RecordMatch; tier: number; at: number }> = [];
  for (const r of rows) {
    if (isEncryptedPlaceholder(r.title)) continue;
    const kind = byId.get(r.kind_id)!;
    const title = r.title.toLowerCase();
    const body = isEncryptedPlaceholder(r.body) ? "" : plain(r.body);
    const vals = valueText.get(r.id) ?? [];
    const all = `${title} ${body.toLowerCase()} ${vals.map((v) => v.text.toLowerCase()).join(" ")}`;
    if (!words.every((w) => all.includes(w))) continue;
    const tier = !words.length ? 2 : title === query.trim().toLowerCase() ? 0 : words.every((w) => title.includes(w)) ? 1 : 2;
    const hitValue = vals.find((v) => words.some((w) => v.text.toLowerCase().includes(w)));
    const snippet = tier < 2 || !words.length ? (vals.map((v) => `${v.label}: ${v.text}`).join(" · ") || body.slice(0, 160)) : hitValue ? `${hitValue.label}: ${hitValue.text}` : snippetOf(body, words);
    scored.push({
      match: { id: r.id, kind_id: kind.id, kind: kind.name, one: kind.one, title: r.title, snippet: snippet.slice(0, 200), updated_at: r.updated_at },
      tier,
      at: new Date(r.updated_at).getTime(),
    });
  }
  return scored
    .sort((a, b) => a.tier - b.tier || b.at - a.at)
    .slice(0, opts.limit ?? 20)
    .map((s) => s.match);
}

/** The stretch of the body around the first word that matched. */
function snippetOf(body: string, words: string[]): string {
  const lower = body.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return body.slice(0, 160);
  const start = Math.max(0, at - 50);
  return `${start ? "…" : ""}${body.slice(start, start + 160)}`;
}
