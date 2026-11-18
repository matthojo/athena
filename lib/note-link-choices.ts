/**
 * The owner's Card and Mention choices for web links in a note Athena wrote
 * (security review M6; owner's answer 10 Nov 2026: "remember my choice").
 *
 * In such a note a web link is plain and never previewed
 * (app/src/editor/link-view.ts). When the owner switches one to a Card, a
 * Mention or an Embed in the editor, the app records { url, mode } here and
 * the link keeps its preview the next time the note opens.
 *
 * Why a model can't forge one: the choice is not in the note. It is a row in
 * `note_link_choices` (migration 0059), written only by
 * PUT /api/notes/:id/link-choices. No assistant tool, collection tool or MCP
 * tool writes that table, and nothing in a note's title, body, tags or a
 * link's title is ever read as a choice. The payload is sealed, like a note.
 */
import { AthenaInputError, getNote, q } from "./db";
import { openText, sealText } from "./data-box";
import { cleanLinkChoice, withLinkChoice, type ChoiceMode, type LinkChoice } from "./links";

function read(payload: string | undefined): LinkChoice[] {
  if (!payload) return [];
  try {
    const list: unknown = JSON.parse(openText(payload));
    return Array.isArray(list) ? list.map(cleanLinkChoice).filter((c): c is LinkChoice => !!c) : [];
  } catch {
    // Unreadable (a key this deploy doesn't hold): no choices, so every link stays plain.
    return [];
  }
}

export async function getLinkChoices(noteId: string): Promise<LinkChoice[]> {
  const [row] = await q<{ payload: string }>(`SELECT payload FROM note_link_choices WHERE note_id = $1`, [noteId]);
  return read(row?.payload);
}

/** Set (or, with mode null, forget) the owner's choice for one address in one note. */
export async function setLinkChoice(noteId: string, raw: unknown): Promise<LinkChoice[]> {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const forget = o.mode === null || o.mode === "link";
  const choice = cleanLinkChoice(forget ? { url: o.url, mode: "card" } : raw);
  if (!choice) throw new AthenaInputError("A link choice needs an http(s) url and a mode: card, mention or embed");
  if (!(await getNote(noteId, { includeArchived: true }))) throw new AthenaInputError("That note isn't there any more", 404);
  const next = withLinkChoice(await getLinkChoices(noteId), choice.url, forget ? null : (choice.mode as ChoiceMode));
  await q(
    `INSERT INTO note_link_choices (note_id, payload) VALUES ($1, $2)
     ON CONFLICT (note_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [noteId, sealText(JSON.stringify(next))],
  );
  return next;
}
