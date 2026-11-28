/**
 * Sync engine: queues note writes locally and replays them, then pulls fresh
 * notes. No Background Sync API (iOS Safari does not reliably support it per
 * the project brief) — instead this runs explicitly on app load, on the
 * browser's `online` event, and right after each local write.
 *
 * Every note write is optimistic: IndexedDB changes first (so the UI updates
 * and survives a reload offline), then an outbox entry is queued and replayed
 * in order. Ops: create | update | delete | archive | unarchive, and field (a
 * value in one of the owner's own fields, db/custom-fields.ts). Updates to
 * one note coalesce (last write wins per field) so typing doesn't queue a
 * request per keystroke; an update to a note whose create hasn't synced yet
 * folds into that create.
 *
 * Sample mode never touches the network: writes land in IndexedDB only, and
 * data.ts overlays them on the bundled sample notes.
 */

import { getAll, put, putAll, del, get, getMeta, setMeta } from "./idb";
import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import { putValue } from "./custom-fields-api";
import type { FieldValue } from "../../../lib/custom-field-rules";
import type { Note, NotePatch, OutboxEntry } from "../types";

type Listener = () => void;
const listeners = new Set<Listener>();

export function onSyncChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

// ---------- temp id -> server id ----------

/** Creates that synced while an editor still held the temp id. */
const idMap = new Map<string, string>();

/** The server id for a `local-…` temp id once its create has synced (else the id itself). */
export function resolveId(id: string): string {
  return idMap.get(id) ?? id;
}

const ID_EVENT = "athena:note-id";

/** Listen for a temp id becoming a real one (open editors re-key themselves). */
export function onNoteIdResolved(fn: (tempId: string, id: string) => void): () => void {
  const handler = (e: Event) => {
    const { tempId, id } = (e as CustomEvent<{ tempId: string; id: string }>).detail;
    fn(tempId, id);
  };
  window.addEventListener(ID_EVENT, handler);
  return () => window.removeEventListener(ID_EVENT, handler);
}

// ---------- sample-mode bookkeeping ----------

/** Sample notes the user archived or deleted in sample mode (hidden from the overlay). */
export async function sampleHidden(): Promise<Set<string>> {
  const raw = await getMeta("sampleHidden");
  return new Set(raw ? (JSON.parse(raw) as string[]) : []);
}

async function setSampleHidden(id: string, hidden: boolean): Promise<void> {
  const set = await sampleHidden();
  if (hidden) set.add(id);
  else set.delete(id);
  await setMeta("sampleHidden", JSON.stringify([...set]));
}

// ---------- queueing ----------

const entryNoteId = (e: OutboxEntry) => e.noteId ?? e.tempId ?? "";
const entryOp = (e: OutboxEntry) => e.op ?? "create";

async function outbox(): Promise<OutboxEntry[]> {
  const entries = await getAll<OutboxEntry>("outbox");
  return entries.sort((a, b) => (a.key ?? 0) - (b.key ?? 0));
}

/** Pending ops by note id — data.ts uses this to keep optimistic state on screen. */
export async function pendingOps(): Promise<Map<string, OutboxEntry["op"][]>> {
  const map = new Map<string, OutboxEntry["op"][]>();
  for (const e of await outbox()) {
    const id = resolveId(entryNoteId(e));
    map.set(id, [...(map.get(id) ?? []), entryOp(e)]);
  }
  return map;
}

/** Create a note locally and queue it. Returns the optimistic note (temp id). */
export async function createNoteLocal(payload: NotePatch & { body: string }): Promise<Note> {
  // Sample mode never syncs, so its notes get a final id straight away (no
  // "Waiting to sync" badge, and athena:// links to them parse).
  const tempId = isSampleMode() ? crypto.randomUUID() : `local-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const note: Note = {
    id: tempId,
    title: payload.title ?? "",
    body: payload.body,
    type: payload.type ?? "capture",
    source: payload.source ?? "manual",
    tags: payload.tags ?? [],
    folder_id: payload.folder_id ?? null,
    archived_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  await put<Note>("notes", note);
  if (!isSampleMode()) {
    await put<OutboxEntry>("outbox", { op: "create", noteId: tempId, payload, queued_at: nowIso, attempts: 0 });
  }
  notify();
  void flushOutbox();
  return note;
}

/** Back-compat name used by the quick-capture path. */
export const queueCapture = createNoteLocal;

/** Apply a patch locally and queue it (coalescing with anything already pending). */
export async function updateNoteLocal(id: string, patch: NotePatch, base?: Note): Promise<Note | null> {
  id = resolveId(id);
  const current = (await get<Note>("notes", id)) ?? base;
  if (!current) return null;
  const updated: Note = { ...current, ...patch, updated_at: new Date().toISOString() };
  await put<Note>("notes", updated);

  if (!isSampleMode()) {
    const entries = await outbox();
    // Fold into a pending create, or into the latest pending update that
    // isn't followed by an archive/delete (order must be preserved).
    const last = [...entries].reverse().find((e) => resolveId(entryNoteId(e)) === id);
    if (last && (entryOp(last) === "create" || entryOp(last) === "update")) {
      await put<OutboxEntry>("outbox", { ...last, payload: { ...last.payload, ...patch } });
    } else {
      await put<OutboxEntry>("outbox", { op: "update", noteId: id, payload: patch, queued_at: updated.updated_at, attempts: 0 });
    }
  }
  notify();
  scheduleFlush();
  return updated;
}

/** Archive (or unarchive) a note: hidden locally at once, synced in order. */
export async function setNoteArchivedLocal(note: Note, archived: boolean): Promise<void> {
  const id = resolveId(note.id);
  const nowIso = new Date().toISOString();
  if (isSampleMode()) {
    // Kept on the device with archived_at set, so the Archived page can list it.
    await put<Note>("notes", { ...note, id, archived_at: archived ? nowIso : null });
  } else {
    if (archived) await del("notes", id);
    else await put<Note>("notes", { ...note, id, archived_at: null });
    const entries = await outbox();
    const last = [...entries].reverse().find((e) => resolveId(entryNoteId(e)) === id);
    // Undo straight after archive: just drop the archive that hasn't gone yet.
    if (!archived && last && entryOp(last) === "archive" && last.key !== undefined) {
      await del("outbox", last.key);
    } else {
      await put<OutboxEntry>("outbox", {
        op: archived ? "archive" : "unarchive",
        noteId: id,
        payload: {},
        queued_at: nowIso,
        attempts: 0,
      });
    }
  }
  notify();
  void flushOutbox();
}

/**
 * Queue a value for one of the owner's own fields on a note, so it saves
 * offline like the note's other edits (and waits for a new note's create).
 * Setting the same field again before it syncs replaces the queued value.
 */
export async function queueFieldValue(noteId: string, fieldId: string, value: FieldValue | null): Promise<void> {
  if (isSampleMode()) return;
  const id = resolveId(noteId);
  const entries = await outbox();
  const last = [...entries].reverse().find((e) => resolveId(entryNoteId(e)) === id);
  if (last && entryOp(last) === "field" && last.field?.id === fieldId) {
    await put<OutboxEntry>("outbox", { ...last, field: { id: fieldId, value } });
  } else {
    await put<OutboxEntry>("outbox", { op: "field", noteId: id, payload: {}, field: { id: fieldId, value }, queued_at: new Date().toISOString(), attempts: 0 });
  }
  notify();
  scheduleFlush();
}

/** Field values still waiting to sync for a note, newest last (they win over what the server says). */
export async function pendingFieldValues(noteId: string): Promise<Map<string, FieldValue | null>> {
  const id = resolveId(noteId);
  const out = new Map<string, FieldValue | null>();
  for (const e of await outbox()) if (entryOp(e) === "field" && e.field && resolveId(entryNoteId(e)) === id) out.set(e.field.id, e.field.value);
  return out;
}

/** Permanently delete a note. A never-synced note just disappears. */
export async function deleteNoteLocal(note: Note, opts: { files?: boolean } = {}): Promise<void> {
  const id = resolveId(note.id);
  await del("notes", id);
  if (isSampleMode()) {
    await setSampleHidden(id, true);
  } else {
    const entries = await outbox();
    let createdLocally = false;
    for (const e of entries) {
      if (resolveId(entryNoteId(e)) !== id || e.key === undefined) continue;
      if (entryOp(e) === "create") createdLocally = true;
      await del("outbox", e.key);
    }
    if (!createdLocally) {
      await put<OutboxEntry>("outbox", { op: "delete", noteId: id, payload: {}, ...(opts.files ? { deleteFiles: true } : {}), queued_at: new Date().toISOString(), attempts: 0 });
    }
  }
  notify();
  void flushOutbox();
}

// ---------- replay ----------

let flushing = false;
let again = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced flush for the typing path. */
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushOutbox(), 600);
}

/** 4xx (other than auth/rate limits) won't succeed on retry; drop rather than block the queue. */
function isPermanent(error: unknown): boolean {
  return error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status);
}

/** Replay queued writes against the real API, in order. Safe to call repeatedly/concurrently. */
export async function flushOutbox(): Promise<void> {
  if (isSampleMode()) return;
  if (flushing) {
    again = true;
    return;
  }
  flushing = true;
  try {
    do {
      again = false;
      for (const entry of await outbox()) {
        const op = entryOp(entry);
        const rawId = entryNoteId(entry);
        const id = resolveId(rawId);
        try {
          if (op === "create") {
            const created = await api.createNote({ ...entry.payload, body: entry.payload.body ?? "" });
            idMap.set(rawId, created.id);
            const local = await get<Note>("notes", rawId);
            await del("notes", rawId);
            // Keep any local edits made while the create was in flight (they're
            // re-sent as an update just below).
            await put<Note>(
              "notes",
              local
                ? { ...created, title: local.title, body: local.body, type: local.type, tags: local.tags, source: local.source }
                : created
            );
            window.dispatchEvent(new CustomEvent(ID_EVENT, { detail: { tempId: rawId, id: created.id } }));
          } else if (id.startsWith("local-")) {
            // Its create hasn't synced (and must be earlier in the queue); stop and retry in order.
            break;
          } else if (op === "update") {
            // The local copy already holds what was sent (and anything typed
            // since), so the response isn't written back over it.
            // Queued by updateNoteLocal, i.e. typed in the note editor: say so, for the server's note versions.
            await api.updateNote(id, entry.payload, { editor: true });
          } else if (op === "field") {
            if (entry.field) await putValue({ field_id: entry.field.id, entity_id: id, entity_kind: "note", value: entry.field.value });
          } else if (op === "delete") {
            await api.deleteEntity("note", id, { files: entry.deleteFiles }).catch((e) => {
              if (!(e instanceof ApiError && e.status === 404)) throw e;
            });
          } else {
            await api.setArchived("note", id, op === "archive");
          }
          if (entry.key !== undefined) {
            // A coalesced update may have grown while this request was in flight.
            const latest = await get<OutboxEntry>("outbox", entry.key);
            if (latest && JSON.stringify(latest.payload) !== JSON.stringify(entry.payload) && op === "update") {
              again = true;
            } else if (latest && op === "field" && JSON.stringify(latest.field) !== JSON.stringify(entry.field)) {
              // The value changed again while this one was in flight: send the newer one.
              again = true;
            } else if (latest && op === "create" && JSON.stringify(latest.payload) !== JSON.stringify(entry.payload)) {
              // Edits folded into the create after it was sent: replay them as an update.
              await del("outbox", entry.key);
              await put<OutboxEntry>("outbox", { op: "update", noteId: idMap.get(rawId)!, payload: latest.payload, queued_at: new Date().toISOString(), attempts: 0 });
              again = true;
            } else {
              await del("outbox", entry.key);
            }
          }
          notify();
        } catch (error) {
          if (isPermanent(error)) {
            console.warn(`Athena: dropping queued ${op} for ${id}:`, error);
            if (entry.key !== undefined) await del("outbox", entry.key);
            notify();
            continue;
          }
          // Network/API still unavailable — leave queued, stop here so we
          // retry in order next time rather than hammering every entry.
          return;
        }
      }
    } while (again);
  } finally {
    flushing = false;
  }
}

/** Pull notes created/updated/archived since the last successful sync. */
export async function pullNotes(): Promise<void> {
  if (isSampleMode()) return;
  const since = await getMeta("lastSyncAt");
  const startedAt = new Date().toISOString();
  try {
    const notes = await api.fetchNotes({ since: since ?? undefined, limit: 200, includeArchived: true });
    const pending = await pendingOps();
    const live = notes.filter((n) => !n.archived_at && !pending.has(n.id));
    await putAll("notes", live);
    for (const n of notes) if (n.archived_at && !pending.has(n.id)) await del("notes", n.id);
    await setMeta("lastSyncAt", startedAt);
    notify();
  } catch {
    // Offline or backend not up yet — cache stands as-is.
  }
}

/** Full sync pass: flush pending writes, then pull. Call on boot + `online`. */
export async function runSync(): Promise<void> {
  await flushOutbox();
  await pullNotes();
  // Ask's chats sync on the same beat (their own module, loaded on demand).
  void import("./ask-threads").then((m) => m.syncAskThreads()).catch(() => undefined);
}

export async function pendingOutboxCount(): Promise<number> {
  const pending = await getAll<OutboxEntry>("outbox");
  return pending.length;
}

export async function cachedNotes(): Promise<Note[]> {
  const notes = await getAll<Note>("notes");
  return notes.filter((n) => !n.archived_at).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
