/**
 * The owner's own kinds of record on the device (lib/custom-kinds.ts on the
 * server): the kinds themselves, for the Library, the sidebar, Settings and
 * the Graph's filters, and each kind's records. Same degrade chain as
 * db/records.ts: the live API, then what this device cached, and sample mode
 * keeps its own Wines and its edits here.
 *
 * Like people and places, changes need a connection (the server checks names
 * and fields, and a duplicate copies its fields there); offline, the Library
 * reads what was cached. A record's field values go through
 * db/custom-fields.ts with the kind's own field kind, 'custom:<id>'.
 *
 * The chrome reads the kinds synchronously (kindsSnapshot): primeKinds() fills
 * it from the device at start-up, and every load keeps it current. The names
 * are also taught to fieldKindInfo() (lib/custom-field-rules.ts), so Settings
 * and the Archived page can word a custom kind like a built-in one.
 */

import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import * as kapi from "./custom-kinds-api";
import { getMeta, setMeta } from "./idb";
import { OfflineError } from "./records";
import { copySampleFields, copySampleValues, customFieldsChanged } from "./custom-fields";
import { sampleKindRecords, sampleKinds } from "./sample-kinds";
import {
  FieldError,
  KIND_ICONS,
  KIND_LIMITS,
  cleanKindName,
  cleanKindOne,
  cleanRecordTitle,
  copyName,
  customKindKey,
  labelKey,
  registerCustomKinds,
  sameLabel,
  singular,
} from "../../../lib/custom-field-rules";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { parseAthenaLinks } from "../../../lib/links";
import type { ArchivedItem, Connection, ConnectionState, CustomKind, CustomRecord, EntityRef } from "../types";
import type { KindInput, RecordInput } from "./custom-kinds-api";

export type { KindInput, RecordInput };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- change notifications ----------

/** null: the kinds themselves changed (added, renamed, reordered, archived); an id: that kind's records did. */
const subs = new Set<(kindId: string | null) => void>();

export function onKindsChange(fn: (kindId: string | null) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(kindId: string | null) {
  subs.forEach((fn) => fn(kindId));
}

/** Something outside this module (Ask's assistant) may have changed kinds or records: everyone reload. */
export function customKindsChanged(): void {
  void loadKinds().then(() => emit(null));
}

// ---------- the snapshot the chrome reads ----------

let snapshot: CustomKind[] = [];

const byOrder = (a: CustomKind, b: CustomKind) => a.position - b.position || a.created_at.localeCompare(b.created_at);

/** The live kinds, in the owner's order, as last loaded. */
export function kindsSnapshot(): CustomKind[] {
  return snapshot;
}

export function kindById(id: string): CustomKind | undefined {
  return snapshot.find((k) => k.id === id);
}

/** Which kind each record seen on this device is of: a link in a note body names the record, not its kind. */
const recordKinds = new Map<string, string>();

export const kindOfRecord = (id: string): string | undefined => recordKinds.get(id);

/** Remember records' kinds from anything that carries them (lists, search results, connections). */
export function learnRecordKinds(items: Array<{ id: string; kind_id?: string | null; kind?: string }>): void {
  for (const r of items) if (r.kind_id && (r.kind === undefined || r.kind === "record")) recordKinds.set(r.id, r.kind_id);
}

function setSnapshot(all: CustomKind[]) {
  registerCustomKinds(all);
  const live = all.filter((k) => !k.archived_at).sort(byOrder);
  const changed = JSON.stringify(live.map((k) => [k.id, k.name, k.one, k.icon, k.position])) !== JSON.stringify(snapshot.map((k) => [k.id, k.name, k.one, k.icon, k.position]));
  snapshot = live;
  if (changed) emit(null);
}

/** At start-up: the kinds this device knows, before anything is fetched. */
export async function primeKinds(): Promise<void> {
  try {
    if (isSampleMode()) setSnapshot(await sampleAllKinds());
    else {
      const raw = await getMeta("customKinds");
      if (raw) setSnapshot(JSON.parse(raw) as CustomKind[]);
    }
  } catch {
    // nothing cached yet
  }
  void loadKinds();
}

// ---------- sample mode ----------

type KindOverlay = Record<string, CustomKind>;
type RecordOverlay = Record<string, CustomRecord>;

async function readOverlay<T>(key: string): Promise<Record<string, T>> {
  return JSON.parse((await getMeta(key)) ?? "{}") as Record<string, T>;
}

async function sampleDeleted(): Promise<Set<string>> {
  return new Set(JSON.parse((await getMeta("sampleKindsDeleted")) ?? "[]") as string[]);
}

async function markSampleDeleted(ids: string[]): Promise<void> {
  const gone = await sampleDeleted();
  for (const id of ids) gone.add(id);
  await setMeta("sampleKindsDeleted", JSON.stringify([...gone]));
}

async function sampleAllRecords(): Promise<CustomRecord[]> {
  const [overlay, gone] = await Promise.all([readOverlay<CustomRecord>("sampleKindRecords"), sampleDeleted()]);
  const byId = new Map(sampleKindRecords().map((r) => [r.id, r]));
  for (const r of Object.values(overlay)) byId.set(r.id, r);
  return [...byId.values()].filter((r) => !gone.has(r.id));
}

async function sampleAllKinds(): Promise<CustomKind[]> {
  const [overlay, gone, records] = await Promise.all([readOverlay<CustomKind>("sampleKinds"), sampleDeleted(), sampleAllRecords()]);
  const byId = new Map(sampleKinds().map((k) => [k.id, k]));
  for (const k of Object.values(overlay)) byId.set(k.id, k);
  return [...byId.values()]
    .filter((k) => !gone.has(k.id))
    .map((k) => ({ ...k, record_count: records.filter((r) => r.kind_id === k.id && !r.archived_at).length }));
}

async function writeSampleKind(kind: CustomKind): Promise<void> {
  const overlay = await readOverlay<CustomKind>("sampleKinds");
  overlay[kind.id] = kind;
  await setMeta("sampleKinds", JSON.stringify(overlay as KindOverlay));
}

async function writeSampleRecord(record: CustomRecord): Promise<void> {
  const overlay = await readOverlay<CustomRecord>("sampleKindRecords");
  overlay[record.id] = record;
  await setMeta("sampleKindRecords", JSON.stringify(overlay as RecordOverlay));
}

/** Sample mode's archived kinds and records, for the Archived page (the server lists them otherwise). */
export async function sampleArchivedKinds(): Promise<ArchivedItem[]> {
  const kinds = await sampleAllKinds();
  const records = await sampleAllRecords();
  const out: ArchivedItem[] = [];
  for (const k of kinds) {
    if (k.archived_at) out.push({ kind: "kind", id: k.id, title: k.name, archived_at: k.archived_at, icon: k.icon, count: records.filter((r) => r.kind_id === k.id).length, detail: k.one });
  }
  for (const r of records) {
    const k = kinds.find((x) => x.id === r.kind_id);
    if (r.archived_at && k && !k.archived_at) out.push({ kind: "record", id: r.id, title: r.title, archived_at: r.archived_at, kind_id: k.id, icon: k.icon, detail: capitalise(k.one) });
  }
  return out;
}

// ---------- reads ----------

/** Every kind, archived ones too (the snapshot keeps the live ones). */
export async function loadKinds(): Promise<{ kinds: CustomKind[]; state: ConnectionState }> {
  if (isSampleMode()) {
    const kinds = await sampleAllKinds();
    setSnapshot(kinds);
    return { kinds, state: "sample" };
  }
  try {
    const kinds = await kapi.fetchKinds(true);
    await setMeta("customKinds", JSON.stringify(kinds));
    setSnapshot(kinds);
    return { kinds, state: "online" };
  } catch {
    const raw = await getMeta("customKinds").catch(() => undefined);
    const kinds = raw ? (JSON.parse(raw) as CustomKind[]) : [];
    setSnapshot(kinds);
    return { kinds, state: "offline" };
  }
}

const byTitle = (a: CustomRecord, b: CustomRecord) => a.title.localeCompare(b.title, "en-GB", { sensitivity: "base" });

/** A kind's live records, by title. */
export async function loadKindRecords(kindId: string): Promise<{ items: CustomRecord[]; state: ConnectionState }> {
  const out = await (async (): Promise<{ items: CustomRecord[]; state: ConnectionState }> => {
    if (isSampleMode()) return { items: (await sampleAllRecords()).filter((r) => r.kind_id === kindId && !r.archived_at).sort(byTitle), state: "sample" };
    try {
      const items = await kapi.fetchRecords(kindId);
      await setMeta(`customRecords:${kindId}`, JSON.stringify(items));
      return { items, state: "online" };
    } catch {
      const raw = await getMeta(`customRecords:${kindId}`).catch(() => undefined);
      return { items: raw ? (JSON.parse(raw) as CustomRecord[]) : [], state: "offline" };
    }
  })();
  learnRecordKinds(out.items);
  return out;
}

/** One live record (its kind live too), from the server or this device; null when it isn't there. */
export async function findCustomRecord(id: string): Promise<CustomRecord | null> {
  if (isSampleMode()) {
    const r = (await sampleAllRecords()).find((x) => x.id === id);
    const k = r ? (await sampleAllKinds()).find((x) => x.id === r.kind_id) : undefined;
    return r && k && !r.archived_at && !k.archived_at ? r : null;
  }
  try {
    return await kapi.fetchRecord(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    for (const k of snapshot) {
      const raw = await getMeta(`customRecords:${k.id}`).catch(() => undefined);
      const found = raw ? (JSON.parse(raw) as CustomRecord[]).find((r) => r.id === id) : undefined;
      if (found) return found;
    }
    return null;
  }
}

/** Every live record this device can see, as @-mention suggestions ("Château Musar 2017 · Wine"). */
export async function localRecordRefs(): Promise<EntityRef[]> {
  const lists = await Promise.all(snapshot.map((k) => loadKindRecords(k.id).catch(() => ({ items: [] as CustomRecord[] }))));
  return lists.flatMap(({ items }, i) =>
    items.map((r) => ({ kind: "record" as const, id: r.id, title: r.title, subtitle: capitalise(snapshot[i].one), updated_at: r.updated_at, kind_id: snapshot[i].id })),
  );
}

/** Sample mode and offline: records whose notes link to this (their bodies are on the device). */
export async function recordBacklinks(kind: string, id: string): Promise<Connection[]> {
  if (!isSampleMode()) return [];
  const records = (await sampleAllRecords()).filter((r) => !r.archived_at && r.id !== id);
  return records
    .filter((r) => parseAthenaLinks(r.body).some((l) => l.kind === kind && l.id === id))
    .map((r) => {
      const k = kindById(r.kind_id);
      return { kind: "record", id: r.id, title: r.title, subtitle: k ? capitalise(k.one) : "", updated_at: r.updated_at, edge_id: r.id, relation: "mentions", origin: "content", kind_id: r.kind_id };
    });
}

// ---------- writes: kinds ----------

/** Names are checked here too, so a clash is explained straight away (the server checks again). */
function checkKindName(all: CustomKind[], name: string, one: string, selfId?: string): void {
  const clash = all.find((k) => k.id !== selfId && (sameLabel(k.name, name) || sameLabel(k.one, one) || sameLabel(k.name, one) || sameLabel(k.one, name)));
  if (!clash) return;
  throw new FieldError(
    clash.archived_at
      ? `There's an archived “${clash.name}” ${KIND_WORD.one}. Restore it from Archived, or pick another name.`
      : `There's already a “${clash.name}” ${KIND_WORD.one}.`,
  );
}

function online<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.onLine) return Promise.reject(new KindsOffline());
  return run().catch((error) => {
    throw error instanceof ApiError ? error : new KindsOffline();
  });
}

export class KindsOffline extends Error {
  constructor() {
    super(`You're offline. Changing your ${KIND_WORD.many} needs a connection.`);
  }
}

/** Make a kind (no id) or change its name, singular or icon. */
export async function saveKind(input: KindInput, id?: string): Promise<CustomKind> {
  const all = isSampleMode() ? await sampleAllKinds() : (await loadKinds()).kinds;
  const current = id ? all.find((k) => k.id === id) : undefined;
  const name = input.name !== undefined ? cleanKindName(input.name) : current?.name;
  if (!name) throw new FieldError(`Give the ${KIND_WORD.one} a name, like Wines or Plants`);
  const derived = current ? current.one === singular(current.name) : true;
  const one = input.one?.trim() ? cleanKindOne(input.one, name) : current && !(name !== current.name && derived) ? current.one : cleanKindOne(undefined, name);
  const icon = input.icon ?? current?.icon ?? KIND_ICONS[0];
  checkKindName(all, name, one, id);
  if (!current && all.filter((k) => !k.archived_at).length >= KIND_LIMITS.kinds) {
    throw new FieldError(`You can have up to ${KIND_LIMITS.kinds} ${KIND_WORD.many}. Archive one you don't use first.`);
  }

  if (isSampleMode()) {
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const kind: CustomKind = current
      ? { ...current, name, one, icon, updated_at: now }
      : {
          id: newId,
          kind: customKindKey(newId),
          name,
          one,
          icon,
          position: Math.max(-1, ...all.filter((k) => !k.archived_at).map((k) => k.position)) + 1,
          record_count: 0,
          archived_at: null,
          created_at: now,
          updated_at: now,
        };
    await writeSampleKind(kind);
    await loadKinds();
    return kind;
  }
  const saved = await online(() => (id ? kapi.updateKind(id, { name, one, icon }) : kapi.createKind({ name, one, icon }).then((r) => r.kind)));
  await loadKinds();
  return saved;
}

/** Put the kinds in this order. */
export async function reorderKinds(ids: string[]): Promise<void> {
  if (isSampleMode()) {
    for (const [i, id] of ids.entries()) {
      const k = (await sampleAllKinds()).find((x) => x.id === id);
      if (k) await writeSampleKind({ ...k, position: i });
    }
    await loadKinds();
    return;
  }
  await online(() => kapi.reorderKinds(ids));
  await loadKinds();
}

/** "Wines copy": every field, none of the records. */
export async function duplicateKind(id: string): Promise<CustomKind> {
  if (isSampleMode()) {
    const all = await sampleAllKinds();
    const source = all.find((k) => k.id === id);
    if (!source) throw new FieldError(`That ${KIND_WORD.one} isn't there any more`);
    if (all.filter((k) => !k.archived_at).length >= KIND_LIMITS.kinds) throw new FieldError(`You can have up to ${KIND_LIMITS.kinds} ${KIND_WORD.many}.`);
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const taken = (c: string) => all.some((k) => sameLabel(k.name, c) || sameLabel(k.one, c));
    for (const k of all) if (!k.archived_at && k.position > source.position) await writeSampleKind({ ...k, position: k.position + 1 });
    const kind: CustomKind = {
      ...source,
      id: newId,
      kind: customKindKey(newId),
      name: copyName(source.name, taken),
      one: copyName(source.one, taken),
      position: source.position + 1,
      record_count: 0,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    await writeSampleKind(kind);
    await copySampleFields(source.kind, kind.kind);
    await loadKinds();
    return kind;
  }
  const { kind } = await online(() => kapi.duplicateKind(id));
  await loadKinds();
  customFieldsChanged();
  return kind;
}

/** Archive a kind (it hides with everything in it) or restore it. */
export async function setKindArchived(id: string, archived: boolean): Promise<void> {
  if (isSampleMode()) {
    const all = await sampleAllKinds();
    const k = all.find((x) => x.id === id);
    if (!k) return;
    if (!archived) checkKindName(all, k.name, k.one, k.id);
    await writeSampleKind({ ...k, archived_at: archived ? new Date().toISOString() : null, position: archived ? k.position : Math.max(-1, ...all.filter((x) => !x.archived_at).map((x) => x.position)) + 1 });
    await loadKinds();
    customFieldsChanged();
    return;
  }
  await online(() => api.setArchived("kind", id, archived));
  await loadKinds();
  customFieldsChanged();
}

/** Permanent delete: the kind, its records (their links and values) and its fields. The owner's, from Archived, confirmed. */
export async function deleteKindForever(id: string): Promise<void> {
  if (isSampleMode()) {
    const records = (await sampleAllRecords()).filter((r) => r.kind_id === id).map((r) => r.id);
    await markSampleDeleted([id, ...records]);
    await loadKinds();
    return;
  }
  await online(() => api.deleteEntity("kind", id));
  await loadKinds();
  customFieldsChanged();
}

// ---------- writes: records ----------

/** Add a record to a kind (no id) or change its title or notes. Returns it as saved. */
export async function saveCustomRecord(kindId: string, input: RecordInput, id?: string): Promise<CustomRecord> {
  const kind = kindById(kindId);
  if (input.title !== undefined) cleanRecordTitle(input.title, kind?.one);
  if (isSampleMode()) {
    const now = new Date().toISOString();
    const current = id ? (await sampleAllRecords()).find((r) => r.id === id) : undefined;
    const record: CustomRecord = current
      ? { ...current, ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.body !== undefined ? { body: input.body } : {}), updated_at: now }
      : { id: crypto.randomUUID(), kind_id: kindId, title: (input.title ?? "").trim(), body: input.body ?? "", archived_at: null, created_at: now, updated_at: now };
    await writeSampleRecord(record);
    emit(kindId);
    return record;
  }
  if (!navigator.onLine) throw new OfflineError();
  try {
    const saved = id ? await kapi.updateRecord(id, input) : await kapi.createRecord(kindId, input);
    emit(kindId);
    if (!id) void loadKinds();
    return saved;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

/** "<Title> copy", with its notes and every value. */
export async function duplicateCustomRecord(record: CustomRecord): Promise<CustomRecord> {
  if (isSampleMode()) {
    const now = new Date().toISOString();
    const copy: CustomRecord = { ...record, id: crypto.randomUUID(), title: `${record.title.slice(0, KIND_LIMITS.title - 5).trimEnd()} copy`, archived_at: null, created_at: now, updated_at: now };
    await writeSampleRecord(copy);
    await copySampleValues(customKindKey(record.kind_id), record.id, copy.id);
    emit(record.kind_id);
    return copy;
  }
  if (!navigator.onLine) throw new OfflineError();
  const copy = await kapi.duplicateRecord(record.id).catch((error) => {
    throw error instanceof ApiError ? error : new OfflineError();
  });
  emit(record.kind_id);
  void loadKinds();
  return copy;
}

export async function setRecordArchived(record: Pick<CustomRecord, "id" | "kind_id">, archived: boolean): Promise<void> {
  if (isSampleMode()) {
    const r = (await sampleAllRecords()).find((x) => x.id === record.id);
    if (r) await writeSampleRecord({ ...r, archived_at: archived ? new Date().toISOString() : null });
    emit(record.kind_id);
    void loadKinds();
    return;
  }
  if (!navigator.onLine) throw new OfflineError();
  await api.setArchived("record", record.id, archived);
  emit(record.kind_id);
  void loadKinds();
}

/** Permanent delete, with its links and values. The owner's, confirmed. */
export async function deleteRecordForever(record: Pick<CustomRecord, "id" | "kind_id">): Promise<void> {
  if (isSampleMode()) {
    await markSampleDeleted([record.id]);
    emit(record.kind_id);
    return;
  }
  if (!navigator.onLine) throw new OfflineError();
  await api.deleteEntity("record", record.id);
  emit(record.kind_id);
}

/** A kind found by name the way the server finds one ("wine" finds Wines). */
export function findKindByName(name: string): CustomKind | undefined {
  const key = labelKey(name);
  return snapshot.find((k) => labelKey(k.name) === key || labelKey(k.one) === key);
}
