/**
 * The owner's own fields on the device (lib/custom-fields.ts on the server):
 * their definitions, for Settings and every record's Details, and their
 * values. Same degrade chain as db/records.ts: the live API, then what this
 * device cached, and sample mode keeps its own fields and edits here.
 *
 * Writes follow the record they belong to. A note's values save like the
 * rest of the note: on the device first, queued in the outbox (db/sync.ts)
 * and sent when there's a connection. Everything else needs a connection,
 * like the profile's other fields. Changing the fields themselves (Settings)
 * needs a connection too.
 *
 * Values are checked on the device with the same rules the server uses
 * (lib/custom-field-rules.ts), so a typo gets an answer even offline.
 */

import { ApiError, isSampleMode } from "./api";
import * as fapi from "./custom-fields-api";
import { getMeta, setMeta } from "./idb";
import { OfflineError } from "./records";
import { onNoteIdResolved, pendingFieldValues, queueFieldValue, resolveId } from "./sync";
import { sampleFields, sampleValues } from "./sample-fields";
import {
  FieldError,
  cleanLabel,
  cleanOptions,
  cleanUnit,
  convertValue,
  fieldKindInfo,
  hasOptions,
  isFieldType,
  normaliseValue,
  sameLabel,
  searchText,
  typeChangeAllowed,
  typeChangeRefusal,
  type CustomField,
  type FieldKind,
  type FieldValue,
} from "../../../lib/custom-field-rules";
import type { ConnectionState } from "../types";
import type { FieldInput } from "./custom-fields-api";

export type { CustomField, FieldKind, FieldValue };
export type { FieldInput };

/** A record's values, by field id. */
export type ValueMap = Record<string, FieldValue>;
/** A kind's values, by record id. */
type KindValues = Record<string, ValueMap>;

/** Changing the fields themselves needs the server. */
export class FieldsOffline extends Error {
  constructor() {
    super("You're offline. Changing fields needs a connection.");
  }
}

// ---------- change notifications ----------

const subs = new Set<(kind: FieldKind | null) => void>();

/** Fields or values changed (null: anything, or several kinds). */
export function onCustomFieldsChange(fn: (kind: FieldKind | null) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(kind: FieldKind | null) {
  subs.forEach((fn) => fn(kind));
}

/** Something outside this module (Ask's assistant) may have changed fields: everyone reload. */
export const customFieldsChanged = () => emit(null);

// ---------- helpers ----------

const byOrder = (a: CustomField, b: CustomField) => a.position - b.position || a.created_at.localeCompare(b.created_at);

/** A kind's live fields, in the owner's order. */
export function liveFields(fields: CustomField[], kind: FieldKind): CustomField[] {
  return fields.filter((f) => f.kind === kind && !f.archived_at).sort(byOrder);
}

/** The words a record list's search can match in a record's values (text and choices fields). */
export function valuesSearchText(fields: CustomField[], values: ValueMap | undefined): string {
  if (!values) return "";
  return fields
    .map((f) => (values[f.id] === undefined ? "" : searchText(f.type, values[f.id])))
    .filter(Boolean)
    .join(" ");
}

function online<T>(run: () => Promise<T>, offline: () => Error): Promise<T> {
  if (!navigator.onLine) return Promise.reject(offline());
  return run().catch((error) => {
    throw error instanceof ApiError ? error : offline();
  });
}

// ---------- the device cache ----------

let fieldsMemo: CustomField[] | null = null;

async function cachedFields(): Promise<CustomField[]> {
  if (fieldsMemo) return fieldsMemo;
  const raw = await getMeta("customFields");
  fieldsMemo = raw ? (JSON.parse(raw) as CustomField[]) : [];
  return fieldsMemo;
}

async function storeFields(fields: CustomField[]): Promise<void> {
  fieldsMemo = fields;
  await setMeta("customFields", JSON.stringify(fields));
}

async function cacheField(field: CustomField): Promise<void> {
  const all = await cachedFields();
  await storeFields([...all.filter((f) => f.id !== field.id), field]);
}

/** A kind's live fields as the server just listed them (archived ones stay as cached). */
async function cacheKindFields(kind: FieldKind, live: CustomField[]): Promise<void> {
  const all = await cachedFields();
  await storeFields([...all.filter((f) => f.kind !== kind || f.archived_at), ...live]);
}

async function cachedValues(kind: FieldKind): Promise<KindValues> {
  const raw = await getMeta(`customValues:${kind}`);
  return raw ? (JSON.parse(raw) as KindValues) : {};
}

async function storeValues(kind: FieldKind, values: KindValues): Promise<void> {
  await setMeta(`customValues:${kind}`, JSON.stringify(values));
}

async function cacheValue(kind: FieldKind, entityId: string, fieldId: string, value: FieldValue | null): Promise<void> {
  const all = await cachedValues(kind);
  const mine = { ...(all[entityId] ?? {}) };
  if (value === null) delete mine[fieldId];
  else mine[fieldId] = value;
  all[entityId] = mine;
  await storeValues(kind, all);
}

// A new note's values were cached under its temporary id: follow it to the real one.
if (typeof window !== "undefined") {
  onNoteIdResolved((tempId, id) => {
    void cachedValues("note").then(async (all) => {
      if (!all[tempId]) return;
      all[id] = { ...all[tempId], ...(all[id] ?? {}) };
      delete all[tempId];
      await storeValues("note", all);
    });
  });
}

// ---------- sample mode ----------

type SampleOverlay = Record<string, CustomField>;
type SampleValueOverlay = Record<string, Record<string, FieldValue | null>>;

async function sampleAllFields(): Promise<CustomField[]> {
  const overlay = JSON.parse((await getMeta("sampleFields")) ?? "{}") as SampleOverlay;
  const byId = new Map(sampleFields().map((f) => [f.id, f]));
  for (const f of Object.values(overlay)) byId.set(f.id, f);
  const fields = [...byId.values()];
  // How many records have a value: what a type change has to keep.
  for (const f of fields) {
    const values = await sampleKindValues(f.kind);
    f.value_count = Object.values(values).filter((v) => v[f.id] !== undefined).length;
  }
  return fields;
}

async function writeSampleField(field: CustomField): Promise<void> {
  const overlay = JSON.parse((await getMeta("sampleFields")) ?? "{}") as SampleOverlay;
  overlay[field.id] = field;
  await setMeta("sampleFields", JSON.stringify(overlay));
}

async function sampleKindValues(kind: FieldKind): Promise<KindValues> {
  const out: KindValues = {};
  for (const v of sampleValues()) if (v.kind === kind) (out[v.entity_id] ??= {})[v.field_id] = v.value;
  const overlay = JSON.parse((await getMeta("sampleFieldValues")) ?? "{}") as SampleValueOverlay;
  for (const [key, values] of Object.entries(overlay)) {
    const [k, entityId] = key.split("|");
    if (k !== kind) continue;
    const mine = (out[entityId] ??= {});
    for (const [fieldId, value] of Object.entries(values)) {
      if (value === null) delete mine[fieldId];
      else mine[fieldId] = value;
    }
  }
  return out;
}

async function writeSampleValue(kind: FieldKind, entityId: string, fieldId: string, value: FieldValue | null): Promise<void> {
  const overlay = JSON.parse((await getMeta("sampleFieldValues")) ?? "{}") as SampleValueOverlay;
  (overlay[`${kind}|${entityId}`] ??= {})[fieldId] = value;
  await setMeta("sampleFieldValues", JSON.stringify(overlay));
}

/** Sample mode: a kind's copy gets every live field of the original (db/custom-kinds.ts duplicateKind). */
export async function copySampleFields(from: FieldKind, to: FieldKind): Promise<void> {
  const now = new Date().toISOString();
  for (const f of liveFields(await sampleAllFields(), from)) {
    await writeSampleField({ ...f, id: crypto.randomUUID(), kind: to, value_count: 0, created_at: now, updated_at: now });
  }
  emit(to);
}

/** Sample mode: a record's copy gets its values (db/custom-kinds.ts duplicateCustomRecord). */
export async function copySampleValues(kind: FieldKind, fromId: string, toId: string): Promise<void> {
  const values = (await sampleKindValues(kind))[fromId] ?? {};
  for (const [fieldId, value] of Object.entries(values)) await writeSampleValue(kind, toId, fieldId, value);
  emit(kind);
}

// ---------- reads ----------

/** Every field of every kind, archived ones too (Settings and the Archived page). */
export async function loadAllFields(): Promise<{ fields: CustomField[]; state: ConnectionState }> {
  if (isSampleMode()) return { fields: await sampleAllFields(), state: "sample" };
  try {
    const fields = await fapi.fetchFields(true);
    await storeFields(fields);
    return { fields, state: "online" };
  } catch {
    return { fields: await cachedFields(), state: "offline" };
  }
}

/** One record's fields and values, for its Details. */
export async function loadRecordFields(kind: FieldKind, entityId: string): Promise<{ fields: CustomField[]; values: ValueMap; state: ConnectionState }> {
  if (isSampleMode()) {
    return { fields: liveFields(await sampleAllFields(), kind), values: (await sampleKindValues(kind))[entityId] ?? {}, state: "sample" };
  }
  const id = kind === "note" ? resolveId(entityId) : entityId;
  // A note that hasn't reached the server yet has nothing there to read.
  if (!id.startsWith("local-")) {
    try {
      const { fields, values } = await fapi.fetchValues(kind, id);
      await cacheKindFields(kind, fields);
      const mine: ValueMap = {};
      for (const v of values) mine[v.field_id] = v.value;
      // Values still waiting in the outbox are newer than the server's.
      if (kind === "note") for (const [fieldId, value] of await pendingFieldValues(id)) value === null ? delete mine[fieldId] : (mine[fieldId] = value);
      const all = await cachedValues(kind);
      all[id] = mine;
      await storeValues(kind, all);
      return { fields: liveFields(fields, kind), values: mine, state: "online" };
    } catch {
      // fall through to the device
    }
  }
  return { fields: liveFields(await cachedFields(), kind), values: (await cachedValues(kind))[id] ?? {}, state: "offline" };
}

/** A kind's fields and every record's values (a list's search). */
export async function loadKindValues(kind: FieldKind): Promise<{ fields: CustomField[]; values: KindValues }> {
  if (isSampleMode()) return { fields: liveFields(await sampleAllFields(), kind), values: await sampleKindValues(kind) };
  try {
    const { fields, values } = await fapi.fetchValues(kind);
    await cacheKindFields(kind, fields);
    const all: KindValues = {};
    for (const v of values) (all[v.entity_id] ??= {})[v.field_id] = v.value;
    await storeValues(kind, all);
    return { fields: liveFields(fields, kind), values: all };
  } catch {
    return { fields: liveFields(await cachedFields(), kind), values: await cachedValues(kind) };
  }
}

// ---------- values ----------

/**
 * Set (or with an empty value, clear) one field on one record. Checked here
 * first, so a value that doesn't fit is explained straight away (FieldError).
 * Returns the field as it now is (a new choice joins its options) and the
 * value as saved.
 */
export async function setFieldValue(field: CustomField, entityId: string, raw: unknown): Promise<{ field: CustomField; value: FieldValue | null }> {
  const { value, newOptions } = normaliseValue(field, raw);
  const next = newOptions.length ? { ...field, options: [...field.options, ...newOptions], updated_at: new Date().toISOString() } : field;
  const kind = field.kind;

  if (isSampleMode()) {
    await writeSampleValue(kind, entityId, field.id, value);
    if (next !== field) await writeSampleField(next);
    emit(kind);
    return { field: next, value };
  }

  if (kind === "note") {
    // Saved on the device at once and sent with the note's other edits.
    const id = resolveId(entityId);
    await cacheValue(kind, id, field.id, value);
    if (next !== field) await cacheField(next);
    await queueFieldValue(id, field.id, value);
    emit(kind);
    return { field: next, value };
  }

  const saved = await online(() => fapi.putValue({ field_id: field.id, entity_id: entityId, entity_kind: kind, value }), () => new OfflineError());
  await cacheValue(kind, entityId, field.id, saved.value?.value ?? null);
  await cacheField(saved.field);
  emit(kind);
  return { field: saved.field, value: saved.value?.value ?? null };
}

// ---------- fields ----------

function checkName(fields: CustomField[], kind: FieldKind, label: string, selfId?: string): void {
  const clash = fields.find((f) => f.kind === kind && f.id !== selfId && sameLabel(f.label, label));
  if (!clash) return;
  const many = fieldKindInfo(kind).many;
  throw new FieldError(
    clash.archived_at ? `There's an archived “${clash.label}” field for ${many}. Restore it from Archived, or pick another name.` : `There's already a “${clash.label}” field for ${many}.`,
  );
}

/** Add a field (no id) or change one: its name, type, options or unit. */
export async function saveField(input: FieldInput, id?: string): Promise<CustomField> {
  const all = isSampleMode() ? await sampleAllFields() : await cachedFields();
  const current = id ? all.find((f) => f.id === id) : undefined;
  const kind = current?.kind ?? input.kind;
  if (!kind) throw new FieldError("Pick what the field is for");
  const label = input.label !== undefined ? cleanLabel(input.label) : current?.label;
  if (!label) throw new FieldError("Give the field a name");
  if (input.label !== undefined) checkName(all, kind, label, id);
  const type = input.type ?? current?.type;
  if (!type || !isFieldType(type)) throw new FieldError("Pick what it holds");
  if (current && type !== current.type && !typeChangeAllowed(current.type, type, current.value_count > 0)) throw new FieldError(typeChangeRefusal(current.label, type));
  const options = hasOptions(type) ? (input.options !== undefined ? cleanOptions(input.options) : (current?.options ?? [])) : [];
  const unit = type === "number" ? (input.unit !== undefined ? cleanUnit(input.unit) : (current?.unit ?? "")) : "";

  if (isSampleMode()) {
    const now = new Date().toISOString();
    const field: CustomField = current
      ? { ...current, label, type, options, unit, updated_at: now }
      : {
          id: crypto.randomUUID(),
          kind,
          label,
          type,
          options,
          unit,
          position: Math.max(-1, ...all.filter((f) => f.kind === kind && !f.archived_at).map((f) => f.position)) + 1,
          value_count: 0,
          archived_at: null,
          created_at: now,
          updated_at: now,
        };
    if (current && (type !== current.type || input.renames?.length)) {
      // Carry values across a type change or an option's new name, as the server does.
      const renames = new Map((input.renames ?? []).map((r) => [r.from.toLowerCase(), r.to]));
      const rename = (s: string) => renames.get(s.toLowerCase()) ?? s;
      for (const [entityId, values] of Object.entries(await sampleKindValues(kind))) {
        if (values[field.id] === undefined) continue;
        let v = convertValue(current.type, type, values[field.id]);
        if (renames.size) v = Array.isArray(v) ? [...new Set(v.map(rename))] : typeof v === "string" ? rename(v) : v;
        await writeSampleValue(kind, entityId, field.id, v);
      }
    }
    await writeSampleField(field);
    emit(kind);
    return field;
  }

  const saved = await online(
    () => (id ? fapi.updateField(id, { ...input, label, options: hasOptions(type) ? options : undefined, unit: type === "number" ? unit : undefined }) : fapi.createField({ kind, label, type, options, unit })),
    () => new FieldsOffline(),
  );
  await cacheField(saved);
  emit(kind);
  return saved;
}

/** Archive a field (its values are kept) or restore it. */
export async function setFieldArchived(field: CustomField, archived: boolean): Promise<CustomField> {
  if (isSampleMode()) {
    const all = await sampleAllFields();
    if (!archived) checkName(all, field.kind, field.label, field.id);
    const position = archived ? field.position : Math.max(-1, ...all.filter((f) => f.kind === field.kind && !f.archived_at).map((f) => f.position)) + 1;
    const next = { ...field, archived_at: archived ? new Date().toISOString() : null, position, updated_at: new Date().toISOString() };
    await writeSampleField(next);
    emit(field.kind);
    return next;
  }
  const saved = await online(() => fapi.archiveField(field.id, archived), () => new FieldsOffline());
  await cacheField(saved);
  emit(field.kind);
  return saved;
}

/** Put a kind's fields in this order. */
export async function reorderFields(kind: FieldKind, ids: string[]): Promise<CustomField[]> {
  if (isSampleMode()) {
    const all = await sampleAllFields();
    const out: CustomField[] = [];
    for (const [i, id] of ids.entries()) {
      const f = all.find((x) => x.id === id);
      if (!f) continue;
      const next = { ...f, position: i };
      await writeSampleField(next);
      out.push(next);
    }
    emit(kind);
    return out;
  }
  const fields = await online(() => fapi.reorderFields(kind, ids), () => new FieldsOffline());
  await cacheKindFields(kind, fields);
  emit(kind);
  return fields;
}
