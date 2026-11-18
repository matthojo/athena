/**
 * A note made into a file the owner can download (docs/team.md "Documents
 * for download"): Markdown as written, or Word from that Markdown
 * (lib/document-make.ts). The file is kept like any other (lib/files.ts:
 * sealed bytes in Blobs, its name sealed on the row) and linked to its note,
 * so it shows under the note's Files and goes when the note does.
 *
 * Asking again for a note that hasn't changed gives the file already made,
 * so downloading twice doesn't leave two copies on the note.
 */
import { randomUUID } from "node:crypto";
import { DOCUMENT_FORMATS, DOCX_TYPE, type DocumentFile, type DocumentFormat } from "./assignment-types";
import { AthenaInputError, getNote, qRaw } from "./db";
import { noteDocument, noteMarkdown } from "./document-make";
import { isEncryptedPlaceholder } from "./encrypted";
import { deleteFilesForGood, isUuid, listNoteFiles, saveFile, type FileMeta } from "./files";

const TYPE: Record<DocumentFormat, string> = { md: "text/markdown", docx: DOCX_TYPE };
const FORMAT = new Map<string, DocumentFormat>(DOCUMENT_FORMATS.map((f) => [TYPE[f], f]));

export function isDocumentFormat(raw: unknown): raw is DocumentFormat {
  return DOCUMENT_FORMATS.includes(raw as DocumentFormat);
}

const toDocument = (noteId: string, f: FileMeta): DocumentFile => ({ file_id: f.id, note_id: noteId, format: FORMAT.get(f.type)!, name: f.name, size: f.size, created_at: f.created_at });

/**
 * The files made from a note (`files.made_from_note`, 0076), newest first.
 * A Markdown file the owner attached themselves isn't one.
 */
export async function documentsForNote(noteId: string): Promise<DocumentFile[]> {
  if (!isUuid(noteId)) return [];
  const made = new Set((await qRaw<{ id: string }>(`SELECT id FROM files WHERE made_from_note = $1::uuid`, [noteId])).map((r) => r.id));
  return (await listNoteFiles(noteId))
    .filter((f) => FORMAT.has(f.type) && made.has(f.id))
    .map((f) => toDocument(noteId, f))
    .reverse();
}

/** The stage working on the assignment this note belongs to (or waiting for Go on its plan), for a file an assistant makes. */
export async function stageMaking(noteId: string): Promise<string | null> {
  if (!isUuid(noteId)) return null;
  const [row] = await qRaw<{ id: string }>(
    `SELECT s.id FROM team_stages s JOIN team_assignments a ON a.id = s.assignment_id
      WHERE a.note_id = $1::uuid AND (s.status = 'running' OR (s.status = 'waiting' AND s.waits_for = 'go')) ORDER BY s.position LIMIT 1`,
    [noteId],
  );
  return row?.id ?? null;
}

/** makeDocument, saying whether it made a new file or found the one already made from the note as it is. `stageId`: the assignment stage that made it. */
export async function makeNoteDocument(noteId: string, format: DocumentFormat, opts: { stageId?: string | null } = {}): Promise<{ document: DocumentFile; made: boolean; title: string }> {
  const note = isUuid(noteId) ? await getNote(noteId) : null;
  if (!note) throw new AthenaInputError("Note not found", 404);
  if (isEncryptedPlaceholder(note.title) || isEncryptedPlaceholder(note.body)) throw new AthenaInputError("This copy of Athena can't read that note, so it can't make a file from it.");
  const title = note.title.trim() || "Untitled note";
  if (!noteMarkdown(note)) throw new AthenaInputError("There's nothing in that note yet");
  const { name, bytes } = noteDocument(note, format);
  const same = (await documentsForNote(note.id)).find((d) => d.format === format && d.name === name && Date.parse(d.created_at) >= new Date(note.updated_at).getTime());
  if (same) return { document: same, made: false, title };
  const saved = await saveFile({ id: randomUUID(), name, type: TYPE[format], bytes, link: { note: note.id }, docx: format === "docx" });
  // Marked as made from this note (and by which stage), so it's told from a file the owner attached.
  await qRaw(`UPDATE files SET made_from_note = $2::uuid, stage_id = $3::uuid WHERE id = $1`, [saved.id, note.id, opts.stageId ?? null]);
  return { document: toDocument(note.id, saved), made: true, title };
}

/** Make a note into a Markdown or Word file, kept sealed and linked to the note. */
export async function makeDocument(noteId: string, format: DocumentFormat, stageId?: string | null): Promise<DocumentFile> {
  return (await makeNoteDocument(noteId, format, { stageId })).document;
}

/** Undo for make_document: the file goes, for good. Only a Markdown or Word file that's on that note. */
export async function deleteDocument(noteId: string, fileId: string): Promise<boolean> {
  if (!(await documentsForNote(noteId)).some((d) => d.file_id === fileId)) return false;
  return (await deleteFilesForGood([fileId])).length > 0;
}
