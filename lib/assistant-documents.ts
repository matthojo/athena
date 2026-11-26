/**
 * Ask's assistant and documents: "start meeting notes for my 2pm with
 * Priya", "trip plan for Lisbon", "send that to Google Docs". Kept beside
 * lib/assistant.ts, which lists these with its own tools, runs them through
 * runDocumentTool() and undoes them through applyDocumentUndo().
 *
 * fill_template fills from Athena's own records (lib/template-fill.ts), not
 * from the model: Claude picks the template and what it's about, and gets
 * back only which fields were filled and which were left blank, never the
 * text. So it can't invent a value, and nothing it read is repeated to it.
 *
 * make_document makes a note into a Markdown or Word file on that note
 * (lib/document-make-db.ts). Undo deletes the file.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import type { Change } from "./assistant";
import { WAITING, type ConfirmCard } from "./assistant-confirm";
import { AthenaInputError, createNote, getNote } from "./db";
import { findTemplate, listTemplates } from "./templates-db";
import { fieldInfo } from "./templates";
import { fillFromAthena } from "./template-fill";
import { DOCUMENT_FORMATS } from "./assignment-types";
import { deleteDocument, makeNoteDocument, stageMaking } from "./document-make-db";
import { documentAccounts, listExports, PROVIDER_NAME, undoExport, type DocumentProvider } from "./documents";

const UUID = z.string().uuid();

export const DOCUMENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "fill_template",
    description:
      "Start a new note from one of the owner's templates, filled from Athena's records: Meeting notes, 1:1, Trip plan, Weekly review, Letter, Project brief, or one of their own. " +
      "For “start meeting notes for my 2pm with Priya”: find the event with find_items (kind event) and pass event_id; its people come with it. For a 1:1 or a letter, pass person_ids (find_people). For a trip plan, trip_id (find_items kind trip). For a project brief, project_id. A weekly review needs nothing. " +
      "Athena fills each field from the record it names and leaves the rest blank for the owner; you never write the content. The result lists which fields were filled and which were left blank.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        template: { type: "string", description: "The template's name (“Meeting notes”, “1:1”, “Trip plan”…) or id." },
        event_id: { type: "string", description: "The meeting, from find_items." },
        person_ids: { type: "array", items: { type: "string" }, description: "People it's with, from find_people." },
        trip_id: { type: "string" },
        project_id: { type: "string" },
        week_of: { type: "string", description: "A day in the week to review, YYYY-MM-DD. Leave out for this week." },
      },
      required: ["template"],
    },
  },
  {
    name: "send_note",
    description:
      "Offer to send one of the owner's notes to Google Docs (a new doc in their Athena folder) or Notion (a new page under the page they chose), only when they ask. The app asks them to confirm, and sends it only when they tap Send. " +
      "Sending a note that was sent before updates that doc or page instead of making another. After calling it, say in one short sentence that it's ready to confirm; never say it's sent.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        note_id: { type: "string", description: "From find_notes, or a note you just made." },
        to: { type: "string", enum: ["google-docs", "notion"] },
      },
      required: ["note_id", "to"],
    },
  },
  {
    name: "make_document",
    description:
      "Make one of the owner's notes into a file they can download: Markdown (md, the note as written) or Word (docx). The file is kept on the note, under its Files. " +
      "For a PDF, tell them to open the note's menu and choose Print or save as PDF; you can't make one. Never use this to send a note anywhere: that's send_note.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        note_id: { type: "string", description: "From find_notes, or a note you just made." },
        format: { type: "string", enum: [...DOCUMENT_FORMATS] },
      },
      required: ["note_id", "format"],
    },
  },
];

export const DOCUMENT_TOOL_NAMES = new Set(DOCUMENT_TOOLS.map((t) => t.name));

export const DOCUMENT_GUIDANCE = `- Templates: for “start meeting notes for…”, “prep my 1:1 with…”, “a trip plan for Lisbon”, “weekly review”, find what it's about first, then fill_template. Reply with what it filled and what it left for them, as the result says. Never add content of your own to the note afterwards.
- Sending: send_note only when the owner asks to send, share or export a note to Google Docs or Notion. The owner confirms in the app; never say it's sent before they do. If the result says to add an account first, tell them that.
- Files: make_document when the owner asks for a note as a Word document, a Markdown file, a download or "a document". Say it's on the note, ready to download. They can also do this themselves from the note's menu.`;

const inputs = {
  fill_template: z.object({
    template: z.string().min(1).max(120),
    event_id: UUID.optional(),
    person_ids: z.array(UUID).max(10).optional(),
    trip_id: UUID.optional(),
    project_id: UUID.optional(),
    week_of: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  send_note: z.object({ note_id: UUID, to: z.enum(["google-docs", "notion"]) }),
  make_document: z.object({ note_id: UUID, format: z.enum(DOCUMENT_FORMATS) }),
};

const FORMAT_NAME = { md: "Markdown file", docx: "Word document" } as const;
const sizeWords = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export async function runDocumentTool(name: string, raw: unknown, ctx: { record: (change: Omit<Change, "label">) => string; confirm: (card: ConfirmCard) => void }): Promise<string> {
  if (name === "fill_template") {
    const input = inputs.fill_template.parse(raw);
    const template = await findTemplate(input.template);
    if (!template) {
      const names = (await listTemplates()).map((t) => t.name).join(", ");
      throw new AthenaInputError(`No template called “${input.template}”. The owner has: ${names}.`);
    }
    const filled = await fillFromAthena(template, input);
    const note = await createNote({ title: filled.title, body: filled.body, type: "note", source: "assistant", tags: [] });
    const left = filled.blanks.length ? ` · ${filled.blanks.length} left for you` : "";
    const receipt = ctx.record({
      kind: "note",
      id: note.id,
      action: "created",
      title: note.title || template.name,
      detail: `${template.name} · ${plural(filled.filled.length, "part")} filled${left}`,
      open: { kind: "note", id: note.id },
      undo: { op: "archive", kind: "note", id: note.id },
    });
    // Names only: the model says what was filled and what's left, never the content.
    if (template.shared) {
      // Someone else's template (lib/template-share.ts): its heading and its own field names are their words, so the
      // model gets only Athena's: the fields Athena knows, by their own names, and a count of the rest.
      const known = (names: string[]) => names.flatMap((n) => (fieldInfo(n) ? [fieldInfo(n)!.key] : []));
      const blanks = known(filled.blanks);
      const detail = `${plural(filled.filled.length, "part")} filled${left}`;
      return JSON.stringify({ ...JSON.parse(receipt), done: `Made a note from a template someone shared: ${detail}`, title: "A note from a template someone shared", detail, filled: known(filled.filled.map((f) => f.name)), left_blank: blanks, other_blanks: filled.blanks.length - blanks.length });
    }
    return JSON.stringify({ ...JSON.parse(receipt), filled: filled.filled.map((f) => f.name), left_blank: filled.blanks });
  }
  if (name === "send_note") {
    // Prepared for the owner to confirm: nothing is made in Google Docs or Notion here.
    const input = inputs.send_note.parse(raw);
    const note = await getNote(input.note_id);
    if (!note) throw new AthenaInputError("That note isn't there any more");
    const to = input.to as DocumentProvider;
    if (!(await documentAccounts()).some((a) => a.provider === to)) throw new AthenaInputError(`Add a ${PROVIDER_NAME[to]} account first, under Sources`);
    const updates = (await listExports(note.id)).some((e) => e.provider === to);
    ctx.confirm({ kind: "send_note", note_id: note.id, title: note.title || "Untitled note", to, updates });
    return JSON.stringify({ shown: WAITING });
  }
  if (name === "make_document") {
    const input = inputs.make_document.parse(raw);
    const { document, made, title } = await makeNoteDocument(input.note_id, input.format, { stageId: await stageMaking(input.note_id).catch(() => null) });
    // The note hasn't changed since this file was made from it: nothing new to keep, or to undo.
    if (!made) return JSON.stringify({ done: `No change: ${document.name} is already on that note`, id: document.file_id, document: { file_id: document.file_id, name: document.name, format: document.format } });
    const receipt = ctx.record({
      kind: "document",
      id: document.file_id,
      action: "created",
      title: document.name,
      detail: `${FORMAT_NAME[document.format]} · ${sizeWords(document.size)} · from ${title}`,
      open: { kind: "note", id: document.note_id },
      undo: { op: "delete_document", note_id: document.note_id, id: document.file_id },
    });
    return JSON.stringify({ ...JSON.parse(receipt), document: { file_id: document.file_id, name: document.name, format: document.format } });
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---------- undo ----------

const DOCUMENT_UNDO = z.discriminatedUnion("op", [z.object({ op: z.literal("undo_export"), id: UUID }), z.object({ op: z.literal("delete_document"), note_id: UUID, id: UUID })]);
export type DocumentUndo = z.infer<typeof DOCUMENT_UNDO>;

export function isDocumentUndo(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && ["undo_export", "delete_document"].includes((raw as { op?: unknown }).op as string);
}

/** Trash the Google Doc, or move the Notion page Athena made under "Removed by Athena". A file made from a note is deleted. */
export async function applyDocumentUndo(raw: unknown): Promise<void> {
  const undo = DOCUMENT_UNDO.parse(raw);
  if (undo.op === "delete_document") return void (await deleteDocument(undo.note_id, undo.id));
  await undoExport(undo.id);
}
