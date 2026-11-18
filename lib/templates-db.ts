/**
 * The owner's note templates (migration 0047, lib/templates.ts for the
 * rules). The six starters live in code; editing one saves a row carrying
 * its key, which then stands in for it. "Save as template" on a note makes
 * a row of its own. Names and bodies are sealed (SECURITY.md §11), so SQL
 * never compares them: names are matched here.
 *
 * Nothing is deleted: a template is archived, and archiving an edited
 * starter brings the original back.
 */
import { AthenaInputError, q, sealer } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { STARTERS, TEMPLATE_LIMITS, parseTemplate, templateNeeds, type FieldContext } from "./templates";

export interface NoteTemplate {
  /** A row's uuid, or "starter:<key>" for a starter nobody has edited. */
  id: string;
  /** The starter it is (edited or not); null for the owner's own. */
  starter: string | null;
  name: string;
  /** One line for the picker. */
  blurb: string;
  body: string;
  /** Field names, as written. */
  fields: string[];
  /** What has to be picked first: a meeting, a person, a trip, a project, a week. */
  needs: FieldContext[];
  edited: boolean;
  updated_at: string | null;
}

interface Row {
  id: string;
  starter: string | null;
  name: string;
  body: string;
  updated_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shape(t: { id: string; starter: string | null; name: string; body: string; edited: boolean; updated_at: string | null }): NoteTemplate {
  const starter = STARTERS.find((s) => s.key === t.starter);
  const fields = parseTemplate(t.body).map((f) => f.name);
  return {
    ...t,
    blurb: starter?.blurb ?? (fields.length ? `Fills ${fields.slice(0, 3).join(", ")}${fields.length > 3 ? "…" : ""}` : "Your own"),
    fields,
    needs: templateNeeds(t.body),
  };
}

/** Starters first (edited or not), in their order, then the owner's own, newest first. */
export async function listTemplates(): Promise<NoteTemplate[]> {
  const rows = await q<Row>(`SELECT id, starter, name, body, updated_at FROM note_templates WHERE archived_at IS NULL ORDER BY updated_at DESC`);
  const starters = STARTERS.map((s) => {
    const edited = rows.find((r) => r.starter === s.key);
    return shape(edited ? { ...edited, edited: true } : { id: `starter:${s.key}`, starter: s.key, name: s.name, body: s.body, edited: false, updated_at: null });
  });
  const own = rows.filter((r) => !r.starter || !STARTERS.some((s) => s.key === r.starter)).map((r) => shape({ ...r, starter: null, edited: true }));
  return [...starters, ...own];
}

/** By id ("starter:meeting" or a uuid), or by name ("meeting notes", "1:1"). */
export async function findTemplate(ref: string): Promise<NoteTemplate | null> {
  const all = await listTemplates();
  const key = ref.trim().toLowerCase();
  return (
    all.find((t) => t.id === ref) ??
    all.find((t) => t.starter && `starter:${t.starter}` === ref) ??
    all.find((t) => t.name.toLowerCase() === key) ??
    all.find((t) => t.starter === key) ??
    all.find((t) => t.name.toLowerCase().includes(key) || (key.length > 2 && key.includes(t.name.toLowerCase()))) ??
    null
  );
}

function clean(input: { name?: string; body?: string }): { name: string; body: string } {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  const body = (input.body ?? "").replace(/\r\n?/g, "\n");
  if (!name) throw new AthenaInputError("Give the template a name");
  if (name.length > TEMPLATE_LIMITS.name) throw new AthenaInputError(`Keep the name under ${TEMPLATE_LIMITS.name} characters`);
  if (body.length > TEMPLATE_LIMITS.body) throw new AthenaInputError("That template is too long");
  if (isEncryptedPlaceholder(name) || isEncryptedPlaceholder(body)) throw new AthenaInputError("That can't be read right now, so it can't be saved as a template");
  return { name, body };
}

/** A new template of the owner's own (from scratch, or "Save as template" on a note). */
export async function createTemplate(input: { name?: string; body?: string }): Promise<NoteTemplate> {
  const t = clean(input);
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM note_templates WHERE archived_at IS NULL`);
  if (n >= TEMPLATE_LIMITS.count) throw new AthenaInputError(`You can keep up to ${TEMPLATE_LIMITS.count} templates`);
  const s = await sealer();
  const [row] = await q<Row>(`INSERT INTO note_templates (name, body) VALUES ($1, $2) RETURNING id, starter, name, body, updated_at`, [s.text(t.name), s.text(t.body)]);
  return shape({ ...row, edited: true });
}

/** Change a template. Editing a starter the first time saves it as the owner's version of that starter. */
export async function updateTemplate(id: string, input: { name?: string; body?: string }): Promise<NoteTemplate> {
  const s = await sealer();
  const starterKey = id.startsWith("starter:") ? id.slice(8) : null;
  if (starterKey) {
    const starter = STARTERS.find((x) => x.key === starterKey);
    if (!starter) throw new AthenaInputError("No such template");
    // Already edited once: change that row, keeping whatever isn't being changed.
    const [existing] = await q<{ id: string }>(`SELECT id FROM note_templates WHERE starter = $1 AND archived_at IS NULL`, [starterKey]);
    if (existing) return updateTemplate(existing.id, input);
    const t = clean({ name: input.name ?? starter.name, body: input.body ?? starter.body });
    const [row] = await q<Row>(`INSERT INTO note_templates (starter, name, body) VALUES ($1, $2, $3) RETURNING id, starter, name, body, updated_at`, [starterKey, s.text(t.name), s.text(t.body)]);
    return shape({ ...row, edited: true });
  }
  if (!UUID_RE.test(id)) throw new AthenaInputError("No such template");
  const [current] = await q<Row>(`SELECT id, starter, name, body, updated_at FROM note_templates WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!current) throw new AthenaInputError("No such template");
  const t = clean({ name: input.name ?? current.name, body: input.body ?? current.body });
  const [row] = await q<Row>(`UPDATE note_templates SET name = $2, body = $3, updated_at = now() WHERE id = $1 RETURNING id, starter, name, body, updated_at`, [id, s.text(t.name), s.text(t.body)]);
  return shape({ ...row, edited: true });
}

/** Archive one of the owner's templates, or put a starter back as it was. Undo: restoreTemplate. */
export async function archiveTemplate(id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AthenaInputError("A starter can't be removed, only put back as it was");
  await q(`UPDATE note_templates SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL`, [id]);
}

export async function restoreTemplate(id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AthenaInputError("No such template");
  // An edited starter comes back only if it hasn't been edited again meanwhile.
  await q(
    `UPDATE note_templates t SET archived_at = NULL, updated_at = now() WHERE t.id = $1
       AND NOT (t.starter IS NOT NULL AND EXISTS (SELECT 1 FROM note_templates o WHERE o.starter = t.starter AND o.archived_at IS NULL))`,
    [id],
  );
}
