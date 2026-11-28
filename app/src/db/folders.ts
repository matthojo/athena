/**
 * Folders for notes on the device (lib/note-folders.ts on the server; the
 * rules, shared, in lib/note-folder-rules.ts). The Notes list, a note's
 * folder chip and Move to read them synchronously (foldersSnapshot):
 * primeFolders() fills it from this device's copy at start-up, and every
 * load keeps it current.
 *
 * Making, renaming, moving and deleting a folder need a connection. Moving
 * a note into one doesn't: that's a change to the note, queued like any
 * other (db/sync.ts). Counts come from the notes on this device, so they're
 * right offline too. Sample mode keeps its folders, and changes to them, here.
 */

import { ApiError, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { notesSnapshot, refreshNotes } from "./data";
import { pullNotes, updateNoteLocal } from "./sync";
import {
  cleanFolderName,
  descendants,
  folderPath,
  moveFolderProblem,
  nameTaken,
  newFolderProblem,
  parentOnDelete,
  type NoteFolder,
} from "../../../lib/note-folder-rules";
import { SAMPLE_FOLDERS } from "./sample-data";

export type { NoteFolder };

/** A folder change that couldn't be made: the words say why. */
export class FolderError extends Error {}

const subs = new Set<() => void>();
export function onFoldersChange(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

let snapshot: NoteFolder[] = [];

function set(all: NoteFolder[]) {
  if (JSON.stringify(all) === JSON.stringify(snapshot)) return;
  snapshot = all;
  subs.forEach((fn) => fn());
}

export const foldersSnapshot = (): NoteFolder[] => snapshot;
export const folderById = (id: string | null | undefined): NoteFolder | null => (id ? (snapshot.find((f) => f.id === id) ?? null) : null);
/** "Work › Clients", or "" for no folder. */
export const pathOf = (id: string | null | undefined): string => folderPath(snapshot, id);

/** Live notes in a folder and every folder inside it, from the notes on this device. */
export function notesIn(id: string): number {
  const ids = new Set([id, ...descendants(snapshot, id).map((f) => f.id)]);
  return notesSnapshot().notes.filter((n) => n.folder_id && ids.has(n.folder_id)).length;
}

// ---------- sample mode ----------

const SAMPLE_KEY = "athena.sample.folders";

function readSample(): NoteFolder[] {
  try {
    const raw = localStorage.getItem(SAMPLE_KEY);
    if (raw) return JSON.parse(raw) as NoteFolder[];
  } catch {
    // fall through to the sample set
  }
  return SAMPLE_FOLDERS;
}

function writeSample(all: NoteFolder[]) {
  try {
    localStorage.setItem(SAMPLE_KEY, JSON.stringify(all));
  } catch {
    // private mode: the change lasts until reload
  }
  set(all);
}

// ---------- load ----------

export async function primeFolders(): Promise<void> {
  try {
    if (isSampleMode()) set(readSample());
    else {
      const raw = await getMeta("noteFolders");
      if (raw) set(JSON.parse(raw) as NoteFolder[]);
    }
  } catch {
    // nothing kept yet
  }
  void loadFolders();
}

export async function loadFolders(): Promise<NoteFolder[]> {
  if (isSampleMode()) {
    set(readSample());
    return snapshot;
  }
  try {
    const r = await request<{ folders: NoteFolder[] }>("/folders");
    set(r.folders);
    void setMeta("noteFolders", JSON.stringify(r.folders));
  } catch {
    // offline: this device's copy stands
  }
  return snapshot;
}

// ---------- changes ----------

const now = () => new Date().toISOString();

function nameOrThrow(raw: string): string {
  const r = cleanFolderName(raw);
  if ("error" in r) throw new FolderError(r.error);
  return r.name;
}

/** What the server said, or that there's no connection. */
async function online<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.onLine) throw new FolderError("Folders need a connection to change. Moving notes into them doesn't.");
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status && error.status < 500) throw new FolderError(error.message);
    if (error instanceof ApiError && !error.status) throw new FolderError("Folders need a connection to change. Moving notes into them doesn't.");
    throw new FolderError("Couldn't change the folder. Try again.");
  }
}

export async function createFolder(rawName: string, parent: string | null): Promise<NoteFolder> {
  const name = nameOrThrow(rawName);
  const problem = newFolderProblem(snapshot, parent);
  if (problem) throw new FolderError(problem);
  const taken = nameTaken(snapshot, name, parent);
  if (taken) throw new FolderError(`There's already a folder called “${taken.name}” there`);
  if (isSampleMode()) {
    const f: NoteFolder = { id: crypto.randomUUID(), name, parent_id: parent, created_at: now(), updated_at: now() };
    writeSample([...snapshot, f]);
    return f;
  }
  const f = await online(() => request<NoteFolder>("/folders", { method: "POST", body: JSON.stringify({ name, parent_id: parent }) }));
  set([...snapshot, f]);
  void loadFolders();
  return f;
}

export async function renameFolder(id: string, rawName: string): Promise<NoteFolder> {
  const cur = folderById(id);
  if (!cur) throw new FolderError("That folder isn't there any more");
  const name = nameOrThrow(rawName);
  const taken = nameTaken(snapshot, name, cur.parent_id, id);
  if (taken) throw new FolderError(`There's already a folder called “${taken.name}” there`);
  return change(id, { name });
}

export async function moveFolder(id: string, parent: string | null): Promise<NoteFolder> {
  const cur = folderById(id);
  if (!cur) throw new FolderError("That folder isn't there any more");
  const problem = moveFolderProblem(snapshot, id, parent);
  if (problem) throw new FolderError(problem);
  const taken = nameTaken(snapshot, cur.name, parent, id);
  if (taken) throw new FolderError(`There's already a folder called “${taken.name}” there`);
  return change(id, { parent_id: parent });
}

async function change(id: string, patch: { name?: string; parent_id?: string | null }): Promise<NoteFolder> {
  if (isSampleMode()) {
    const next = snapshot.map((f) => (f.id === id ? { ...f, ...patch, updated_at: now() } : f));
    writeSample(next);
    return next.find((f) => f.id === id)!;
  }
  const f = await online(() => request<NoteFolder>(`/folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }));
  set(snapshot.map((x) => (x.id === id ? f : x)));
  return f;
}

/** Delete a folder: its notes and folders move to its parent (or out of any folder). Resolves to where they went. */
export async function deleteFolder(id: string): Promise<string | null> {
  const to = parentOnDelete(snapshot, id);
  if (isSampleMode()) {
    for (const n of notesSnapshot().notes.filter((x) => x.folder_id === id)) await updateNoteLocal(n.id, { folder_id: to }, n);
    writeSample(snapshot.filter((f) => f.id !== id).map((f) => (f.parent_id === id ? { ...f, parent_id: to } : f)));
    return to;
  }
  await online(() => request(`/folders/${encodeURIComponent(id)}`, { method: "DELETE" }));
  set(snapshot.filter((f) => f.id !== id).map((f) => (f.parent_id === id ? { ...f, parent_id: to } : f)));
  void loadFolders();
  // The server moved the notes: bring them here.
  void pullNotes()
    .then(() => refreshNotes())
    .catch(() => undefined);
  return to;
}

/** Put notes in a folder (null: out of any). Works offline: each is a change to the note, queued. */
export async function fileNotes(noteIds: string[], folder: string | null): Promise<void> {
  const all = notesSnapshot().notes;
  for (const id of noteIds) {
    const n = all.find((x) => x.id === id);
    await updateNoteLocal(id, { folder_id: folder }, n);
  }
}
