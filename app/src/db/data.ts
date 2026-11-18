/**
 * Every view's data comes through here, always on the same degrade chain:
 * live API -> IndexedDB cache, each result tagged with the ConnectionState it
 * came from so the UI can say so honestly. Bundled sample data is only ever
 * shown in sample mode: an owner with a token whose server can't be reached
 * gets this device's copy, or nothing, marked offline (never someone else's
 * briefing on their first morning).
 *
 * The notes list is shared state (Home, Notes, and the desktop sidebar all
 * read it), so it lives in one tiny store instead of being fetched three
 * times per navigation. Sync status is a second store beside it.
 */

import * as api from "./api";
import { cachedNotes, pendingOps, pendingOutboxCount, sampleHidden } from "./sync";
import { del, get, getAll, getMeta, put, putAll } from "./idb";
import { sampleMetricPoints, sampleNotes, samplePeople } from "./sample-data";
import { isSampleMode } from "./api";
import { edgeKindOf, parseAthenaLinks } from "../../../lib/links";

/** Link kinds that aren't graph entities (Saved, to-dos, Watch & read): they open, but aren't connections. */
import { markdownToText } from "../lib/markdown-text";
import type { Connection, Connections, ConnectionState, EntityKind, EntityRef, LinkedKind, MetricPoint, Note, Person } from "../types";

// ---------- Loaders ----------

/** Sample notes with this device's sample-mode edits laid over them. */
async function sampleWithEdits(): Promise<Note[]> {
  const [edited, hidden] = await Promise.all([getAll<Note>("notes"), sampleHidden()]);
  const byId = new Map(sampleNotes().map((n) => [n.id, n]));
  for (const n of edited) byId.set(n.id, n);
  return [...byId.values()].filter((n) => !hidden.has(n.id) && !n.archived_at);
}

async function loadNotes(limit = 300): Promise<{ notes: Note[]; state: ConnectionState }> {
  if (isSampleMode()) return { notes: await sampleWithEdits(), state: "sample" };
  try {
    const notes = await api.fetchNotes({ limit });
    const pending = await pendingOps();
    // Writes still in the outbox win over the server's copy: a note with a
    // pending archive/delete stays hidden, one with pending edits shows the
    // local version, and never-synced creates stay visible.
    const hidden = new Set([...pending].filter(([, ops]) => ops.some((o) => o === "archive" || o === "delete")).map(([id]) => id));
    const cached = await cachedNotes();
    const local = new Map(cached.map((n) => [n.id, n]));
    const merged = notes
      .filter((n) => !hidden.has(n.id))
      .map((n) => (pending.has(n.id) && local.has(n.id) ? local.get(n.id)! : n));
    const serverIds = new Set(notes.map((n) => n.id));
    const extras = cached.filter((n) => !serverIds.has(n.id) && (n.id.startsWith("local-") || pending.has(n.id)) && !hidden.has(n.id));
    await putAll("notes", merged);
    // A complete list lets the cache forget notes deleted/archived elsewhere.
    if (notes.length < limit) {
      for (const n of cached) if (!serverIds.has(n.id) && !n.id.startsWith("local-") && !pending.has(n.id)) await del("notes", n.id);
    }
    return { notes: [...extras, ...merged], state: "online" };
  } catch {
    return { notes: await cachedNotes().catch(() => []), state: "offline" };
  }
}

function localMatch(notes: Note[], q: string): Note[] {
  const needle = q.trim().toLowerCase();
  return notes
    .filter((n) => n.title.toLowerCase().includes(needle) || markdownToText(n.body).toLowerCase().includes(needle))
    .slice(0, 30);
}

export async function searchNotes(q: string): Promise<{ notes: Note[]; state: ConnectionState }> {
  if (!q.trim()) return { notes: [], state: "online" };
  if (isSampleMode()) return { notes: localMatch(await sampleWithEdits(), q), state: "sample" };
  try {
    return { notes: await api.search(q, 30), state: "online" };
  } catch {
    return { notes: localMatch(await cachedNotes().catch(() => []), q), state: "offline" };
  }
}

export async function loadMetric(key: string): Promise<{ points: MetricPoint[]; state: ConnectionState }> {
  if (isSampleMode()) return { points: sampleMetricPoints(key), state: "sample" };
  try {
    const points = await api.fetchMetricPoints(key, { limit: 10 });
    await put("metrics", { metric: key, points });
    return { points, state: "online" };
  } catch {
    const cached = await get<{ metric: string; points: MetricPoint[] }>("metrics", key).catch(() => undefined);
    return { points: cached?.points ?? [], state: "offline" };
  }
}

export async function loadPeople(): Promise<{ people: Person[]; state: ConnectionState }> {
  if (isSampleMode()) return { people: samplePeople(), state: "sample" };
  try {
    const people = await api.fetchStalePeople(60);
    await putAll("people", people);
    return { people, state: "online" };
  } catch {
    return { people: await getAll<Person>("people").catch(() => []), state: "offline" };
  }
}

// ---------- Notes store ----------

export interface NotesSnapshot {
  notes: Note[];
  state: ConnectionState;
  loaded: boolean;
}

/** One note from the shared store (falls back to the device cache). */
/**
 * A note by id: this device's copy, else the server's. Collections write
 * notes on the server while the app sits in the background, and links to
 * them (a person's timeline, a backlink) arrive before the next sync does.
 */
export async function findNote(id: string): Promise<Note | null> {
  const here = notesSnap.notes.find((n) => n.id === id) ?? (await get<Note>("notes", id).catch(() => undefined)) ?? (isSampleMode() ? sampleNotes().find((n) => n.id === id) : undefined);
  if (here) return here;
  if (isSampleMode() || id.startsWith("local-")) return null;
  try {
    const note = await api.fetchNote(id);
    await put("notes", note);
    void refreshNotes();
    return note;
  } catch {
    return null;
  }
}

let notesSnap: NotesSnapshot = { notes: [], state: "online", loaded: false };
const notesSubs = new Set<(s: NotesSnapshot) => void>();
let inflight: Promise<void> | null = null;

export function notesSnapshot(): NotesSnapshot {
  return notesSnap;
}

export function onNotes(fn: (s: NotesSnapshot) => void): () => void {
  notesSubs.add(fn);
  if (notesSnap.loaded) fn(notesSnap);
  return () => notesSubs.delete(fn);
}

export function refreshNotes(): Promise<void> {
  inflight ??= loadNotes()
    .then(({ notes, state }) => {
      const sorted = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      notesSnap = { notes: sorted, state, loaded: true };
      notesSubs.forEach((fn) => fn(notesSnap));
      void refreshStatus();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------- Sync status store ----------

export type EncryptionInfo = Awaited<ReturnType<typeof api.fetchEncryption>>;

export interface SyncStatus {
  state: ConnectionState;
  pending: number;
  lastSyncAt: string | null;
  /** Encryption at rest, as the server last reported it (null in sample mode or before it answers). */
  encryption: EncryptionInfo | null;
}

let status: SyncStatus = { state: "online", pending: 0, lastSyncAt: null, encryption: null };
let encryptionCheckedAt = 0;

/** Ask the server how encryption stands, at most every five minutes; the status line updates when it answers. */
function checkEncryption(): void {
  if (isSampleMode() || !navigator.onLine || Date.now() - encryptionCheckedAt < 5 * 60_000) return;
  encryptionCheckedAt = Date.now();
  api
    .fetchEncryption()
    .then((encryption) => {
      status = { ...status, encryption };
      statusSubs.forEach((fn) => fn(status));
    })
    .catch(() => {
      encryptionCheckedAt = 0; // offline or an older server: try again next time
    });
}
const statusSubs = new Set<(s: SyncStatus) => void>();

export function onStatus(fn: (s: SyncStatus) => void): () => void {
  statusSubs.add(fn);
  fn(status);
  return () => statusSubs.delete(fn);
}

export function setSyncing(): void {
  status = { ...status, state: "syncing" };
  statusSubs.forEach((fn) => fn(status));
}

export async function refreshStatus(): Promise<void> {
  const [pending, lastSyncAt] = await Promise.all([pendingOutboxCount(), getMeta("lastSyncAt")]);
  const state: ConnectionState = isSampleMode() ? "sample" : !navigator.onLine ? "offline" : notesSnap.state;
  status = { state, pending, lastSyncAt: lastSyncAt ?? null, encryption: isSampleMode() ? null : status.encryption };
  statusSubs.forEach((fn) => fn(status));
  checkEncryption();
}

// ---------- Entities (mentions, links, backlinks) ----------

/** Offline/sample fallback for @ and [[ suggestions: notes from the store, plus cached entities. */
async function localEntities(): Promise<EntityRef[]> {
  const notes: EntityRef[] = notesSnap.notes.map((n) => ({
    kind: "note",
    id: n.id,
    title: n.title || markdownToText(n.body).split("\n")[0].slice(0, 80) || "Untitled",
    subtitle: n.type,
    updated_at: n.updated_at,
  }));
  // People, places, organisations and events from the Library (device cache
  // or sample data), plus anything seen in earlier online searches.
  const { loadRecords } = await import("./records");
  const kinds = ["person", "place", "organisation", "event"] as const;
  const lists = await Promise.all(kinds.map((k) => loadRecords(k).catch(() => ({ items: [] }))));
  const records: EntityRef[] = lists.flatMap(({ items }, i) =>
    items.map((r) => ({
      kind: kinds[i],
      id: r.id,
      title: "name" in r ? r.name : r.title,
      subtitle: "",
      updated_at: r.updated_at,
    }))
  );
  // The owner's own records ("Château Musar 2017 · Wine").
  const { localRecordRefs } = await import("./custom-kinds");
  records.push(...(await localRecordRefs().catch(() => [])));
  const cached = (await getMeta("entityCache").catch(() => undefined)) ?? "[]";
  const seen = new Set(records.map((r) => `${r.kind}:${r.id}`));
  const extra = (JSON.parse(cached) as EntityRef[]).filter((r) => !seen.has(`${r.kind}:${r.id}`));
  return [...records, ...extra, ...notes];
}

/** Remember entities we've seen so @-mentions still suggest them offline. */
async function rememberEntities(refs: EntityRef[]): Promise<void> {
  const fresh = refs.filter((r) => r.kind !== "note");
  if (!fresh.length) return;
  const existing = JSON.parse((await getMeta("entityCache")) ?? "[]") as EntityRef[];
  const byKey = new Map(existing.map((r) => [`${r.kind}:${r.id}`, r]));
  for (const r of fresh) byKey.set(`${r.kind}:${r.id}`, r);
  await put("meta", { key: "entityCache", value: JSON.stringify([...byKey.values()].slice(-500)) });
}

export async function searchEntities(q: string, kinds: EntityKind[]): Promise<{ results: EntityRef[]; state: ConnectionState }> {
  const local = async (state: ConnectionState) => {
    const needle = q.trim().toLowerCase();
    const results = (await localEntities())
      .filter((e) => kinds.includes(e.kind) && (!needle || e.title.toLowerCase().includes(needle)))
      .sort((a, b) => Number(!a.title.toLowerCase().startsWith(needle)) - Number(!b.title.toLowerCase().startsWith(needle)))
      .slice(0, 8);
    return { results, state };
  };
  if (isSampleMode()) return local("sample");
  try {
    const results = await api.searchEntities(q, kinds, 8);
    void rememberEntities(results);
    void import("./custom-kinds").then((m) => m.learnRecordKinds(results));
    return { results, state: "online" };
  } catch {
    return local("offline");
  }
}

/**
 * A note's links: outgoing straight from its body (always current, even
 * offline), backlinks from the server, else by scanning cached notes.
 */
export async function loadConnections(kind: EntityKind, id: string, body?: string): Promise<Connections> {
  const fromBody: Connection[] = body
    ? dedupe(parseAthenaLinks(body).map((l) => ({ ...l, kind: edgeKindOf(l.kind) as LinkedKind }))).map((l) => ({
        kind: l.kind,
        id: l.id,
        title: l.label.replace(/^@/, ""),
        subtitle: "",
        updated_at: "",
        edge_id: `${l.kind}:${l.id}`,
        relation: "mentions",
        origin: "content",
      }))
    : [];
  const scan = (): Connection[] =>
    notesSnap.notes
      .filter((n) => n.id !== id && parseAthenaLinks(n.body).some((l) => edgeKindOf(l.kind) === kind && l.id === id))
      .map((n) => ({ kind: "note", id: n.id, title: n.title || "Untitled", subtitle: n.type, updated_at: n.updated_at, edge_id: n.id, relation: "mentions", origin: "content" }));

  if (isSampleMode() || id.startsWith("local-")) {
    // Records whose notes link here, too (sample mode keeps them on the device).
    const { recordBacklinks } = await import("./custom-kinds");
    return { outgoing: fromBody, backlinks: [...scan(), ...(await recordBacklinks(kind, id).catch(() => []))] };
  }
  try {
    const remote = await api.fetchConnections(kind, id);
    void import("./custom-kinds").then((m) => m.learnRecordKinds([...remote.outgoing, ...remote.backlinks]));
    // Body links reflect unsaved typing; manual links only come from the server.
    // A body link keeps its typed label; the server's subtitle ("Book") comes along for its icon.
    const sub = new Map(remote.outgoing.map((c) => [`${c.kind}:${c.id}`, c.subtitle]));
    const typed = fromBody.map((c) => ({ ...c, subtitle: sub.get(`${c.kind}:${c.id}`) ?? c.subtitle }));
    const outgoing = body ? [...typed, ...remote.outgoing.filter((c) => c.origin === "manual")] : remote.outgoing;
    return { outgoing, backlinks: remote.backlinks, through_notes: remote.through_notes ?? [] };
  } catch {
    return { outgoing: fromBody, backlinks: scan() };
  }
}

function dedupe<T extends { kind: string; id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.kind}:${i.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
