/**
 * A note's earlier versions (migration 0061).
 *
 * "Nothing is deleted" has to cover overwriting too: an MCP client, Ask's
 * assistant, a collection run or a script can replace a note's whole body.
 * updateNote (lib/db.ts) keeps what was there each time a note's title or
 * body changes, whoever changes it, the last NOTE_VERSIONS_KEPT per note.
 * The owner's own typing in the app is grouped: at most one version per 10
 * minutes. Here: listing them, and putting one back.
 *
 * Restoring is an overwrite like any other, so what the note held just
 * before is kept as a version too: a restore can itself be undone.
 * Titles and bodies are sealed like the note's own.
 */
import { AthenaInputError, q, updateNote, type Note } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";

/** How many earlier versions a note keeps (updateNote in lib/db.ts drops the rest; keep the two in step). */
export const NOTE_VERSIONS_KEPT = 20;

export interface NoteVersion {
  id: string;
  note_id: string;
  title: string;
  body: string;
  /** What made the change that replaced this version: 'owner' (the app's editor), 'api', 'mcp', 'restore', …; null when it didn't say. */
  changed_by: string | null;
  /** When it was replaced. */
  created_at: string;
}

/** A note's earlier versions, newest first. */
export async function listNoteVersions(noteId: string): Promise<NoteVersion[]> {
  return q<NoteVersion>(
    `SELECT id, note_id, title, body, changed_by, created_at FROM note_versions
     WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [noteId, NOTE_VERSIONS_KEPT],
  );
}

/** Put an earlier version's title and body back. Null when the note or the version isn't there. */
export async function restoreNoteVersion(noteId: string, versionId: string): Promise<Note | null> {
  const [version] = await q<NoteVersion>(`SELECT id, note_id, title, body, changed_by, created_at FROM note_versions WHERE id = $1 AND note_id = $2`, [versionId, noteId]);
  if (!version) return null;
  if (isEncryptedPlaceholder(version.title) || isEncryptedPlaceholder(version.body)) throw new AthenaInputError("That version can't be read here, so it can't be restored.");
  return updateNote(noteId, { title: version.title, body: version.body }, { by: "restore" });
}
