/**
 * Folders for notes on the server (0097; the rules are lib/note-folder-rules.ts).
 *
 * A folder's name is sealed under the data key, like a note's tags, so the
 * checks that compare names (two folders in the same place can't share one)
 * read every folder and decide here. There are a few hundred at most.
 *
 * Changes take one advisory lock, so two at once can't both pass a check the
 * other breaks (two "Recipes", or a folder moved inside its own child).
 */

import { AthenaInputError, q, sealer, tx, type Note } from "./db";
import {
  cleanFolderName,
  descendants,
  findFolder,
  folderPath,
  moveFolderProblem,
  nameTaken,
  newFolderProblem,
  parentOnDelete,
  type NoteFolder,
} from "./note-folder-rules";

export type { NoteFolder };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = "id, name, parent_id, created_at, updated_at";
const LOCK = `SELECT pg_advisory_xact_lock(hashtext('athena:note_folders'))`;

type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

export async function listFolders(): Promise<NoteFolder[]> {
  return q<NoteFolder>(`SELECT ${COLS} FROM note_folders ORDER BY created_at`);
}

/** Live notes in each folder (not counting the folders inside it). */
export async function folderCounts(): Promise<Record<string, number>> {
  const rows = await q<{ folder_id: string; n: number }>(`SELECT folder_id, count(*)::int AS n FROM notes WHERE folder_id IS NOT NULL AND archived_at IS NULL GROUP BY folder_id`);
  return Object.fromEntries(rows.map((r) => [r.folder_id, r.n]));
}

function nameOrThrow(raw: unknown): string {
  const r = cleanFolderName(raw);
  if ("error" in r) throw new AthenaInputError(r.error);
  return r.name;
}

/** A parent from a request: an id, or null for the top. */
function parentOf(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !UUID.test(raw)) throw new AthenaInputError("parent_id: a folder's id, or null");
  return raw.toLowerCase();
}

async function all(run: Run): Promise<NoteFolder[]> {
  return run<NoteFolder>(`SELECT ${COLS} FROM note_folders`);
}

export async function createFolder(input: { name?: unknown; parent_id?: unknown }): Promise<NoteFolder> {
  const name = nameOrThrow(input.name);
  const parent = parentOf(input.parent_id);
  const s = await sealer();
  return tx(async (run) => {
    await run(LOCK);
    const folders = await all(run);
    const problem = newFolderProblem(folders, parent);
    if (problem) throw new AthenaInputError(problem);
    const taken = nameTaken(folders, name, parent);
    if (taken) throw new AthenaInputError(`There's already a folder called “${taken.name}” there`);
    const [row] = await run<NoteFolder>(`INSERT INTO note_folders (name, parent_id) VALUES ($1, $2) RETURNING ${COLS}`, [s.text(name), parent]);
    return { ...row, name };
  });
}

/** Rename a folder, or move it (parent_id: another folder, or null for the top). */
export async function updateFolder(id: string, input: { name?: unknown; parent_id?: unknown }): Promise<NoteFolder> {
  if (!UUID.test(id)) throw new AthenaInputError("Folder not found", 404);
  const name = input.name === undefined ? undefined : nameOrThrow(input.name);
  const moving = input.parent_id !== undefined;
  const parentGiven = moving ? parentOf(input.parent_id) : undefined;
  const s = await sealer();
  return tx(async (run) => {
    await run(LOCK);
    const folders = await all(run);
    const cur = folders.find((f) => f.id === id);
    if (!cur) throw new AthenaInputError("Folder not found", 404);
    const parent = moving ? parentGiven! : cur.parent_id;
    if (moving && parent !== cur.parent_id) {
      const problem = moveFolderProblem(folders, id, parent);
      if (problem) throw new AthenaInputError(problem);
    }
    const finalName = name ?? cur.name;
    const taken = nameTaken(folders, finalName, parent, id);
    if (taken) throw new AthenaInputError(`There's already a folder called “${taken.name}” there`);
    const [row] = await run<NoteFolder>(
      `UPDATE note_folders SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
      [id, s.text(finalName), parent],
    );
    return { ...row, name: finalName };
  });
}

/**
 * Delete a folder. Its notes and folders move to its parent (or out of any
 * folder, at the top); none is deleted. A folder moving up keeps its name
 * even when the parent already has one called the same: the owner can rename
 * it. Returns where they went.
 */
export async function deleteFolder(id: string): Promise<{ moved_to: string | null; notes: number; folders: number }> {
  if (!UUID.test(id)) throw new AthenaInputError("Folder not found", 404);
  return tx(async (run) => {
    await run(LOCK);
    const folders = await all(run);
    if (!folders.some((f) => f.id === id)) throw new AthenaInputError("Folder not found", 404);
    const to = parentOnDelete(folders, id);
    // Each moved note counts as changed, so every device's next sync moves it too.
    const notes = await run<{ id: string }>(`UPDATE notes SET folder_id = $2, updated_at = now() WHERE folder_id = $1 RETURNING id`, [id, to]);
    const kids = await run<{ id: string }>(`UPDATE note_folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1 RETURNING id`, [id, to]);
    await run(`DELETE FROM note_folders WHERE id = $1`, [id]);
    return { moved_to: to, notes: notes.length, folders: kids.length };
  });
}

/** Live notes in a folder and the folders inside it, newest first (Ask's find_notes, MCP's list_notes). */
export async function notesInFolder(id: string, limit = 100): Promise<Note[]> {
  const ids = [id, ...descendants(await listFolders(), id).map((f) => f.id)];
  return q<Note>(`SELECT * FROM notes WHERE folder_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT $2`, [ids, limit]);
}

/** "Work › Clients" for a folder's id, or "" when there's no such folder. */
export async function folderPathOf(id: string | null | undefined): Promise<string> {
  return id ? folderPath(await listFolders(), id) : "";
}

/** Throws unless `id` is a folder (null and undefined pass: no folder, or leave it). */
export async function checkFolderId(id: string | null | undefined): Promise<void> {
  if (id === null || id === undefined) return;
  if (!UUID.test(id)) throw new AthenaInputError("folder_id: a folder's id, or null");
  const [row] = await q<{ id: string }>(`SELECT id FROM note_folders WHERE id = $1`, [id]);
  if (!row) throw new AthenaInputError("That folder isn't there any more");
}

/**
 * A folder by what an agent or Ask called it: an id, a name ("Recipes") or a
 * path ("Work/Clients"). Throws, naming the folders there are, when nothing
 * or more than one fits.
 */
export async function folderFromWords(said: string): Promise<NoteFolder> {
  const folders = await listFolders();
  if (UUID.test(said)) {
    const hit = folders.find((f) => f.id === said.toLowerCase());
    if (hit) return hit;
  }
  const hit = findFolder(folders, said);
  if (hit) return hit;
  const names = folders.length ? `The owner's folders: ${folders.map((f) => f.name).slice(0, 40).join(", ")}.` : "The owner has no folders yet.";
  throw new AthenaInputError(`No single folder is called “${said}”. Give its path, like Work/Clients. ${names}`);
}
