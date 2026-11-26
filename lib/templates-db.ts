/**
 * The owner's note templates (migration 0047, lib/templates.ts for the
 * rules). The six starters live in code; editing one saves a row carrying
 * its key, which then stands in for it. "Save as template" on a note makes
 * a row of its own. Names and bodies are sealed (docs: security/encryption), so SQL
 * never compares them: names are matched here.
 *
 * Nothing is deleted: a template is archived, and archiving an edited
 * starter brings the original back.
 *
 * Shared templates (migration 0091, lib/template-share.ts):
 *  - `addSharedTemplate`: what the `#/add` screen's Add does for a template.
 *    The file is read again, never trusted, and becomes a new row marked as
 *    someone else's (origin 'shared', its author, version and summary). It
 *    never replaces or renames one of the owner's: a name already in use gets
 *    a number on the end.
 *  - `replaceSharedTemplate`: Update, from a newer Community listing. Only an
 *    added template the owner hasn't changed is replaced; once they've
 *    changed it (changed_at), the new version is added beside it and theirs
 *    stays as they left it.
 *  - `exportTemplateFor`: POST /api/templates/:id/share. A template the owner
 *    wrote, as a file: links into their Athena taken out and the
 *    personal-data check run, as for the other kinds. Nothing is kept.
 */
import { AthenaInputError, q, qRaw, sealer } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { STARTERS, TEMPLATE_LIMITS, parseTemplate, templateNeeds, type FieldContext } from "./templates";
import { exportTemplate, freeTemplateName, readSharedTemplate, serialiseSharedTemplate, TEMPLATE_FILE, type SharedTemplate, type TemplateExport } from "./template-share";
import { ShareFormatError, type KnownTerm } from "./team-share";
import type { Reach } from "./reach";

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
  /**
   * Added from someone else's file or a Community listing: who made it, their summary, and the listing. Null for
   * Athena's starters and the owner's own. `changed`: the owner has changed it since adding it.
   */
  shared: SharedInfo | null;
}

export interface SharedInfo {
  author: string | null;
  version: string | null;
  summary: string;
  catalogue_id: string | null;
  changed: boolean;
}

interface Row {
  id: string;
  starter: string | null;
  name: string;
  body: string;
  updated_at: string;
  origin: string | null;
  summary: string;
  author: string | null;
  version: string | null;
  catalogue_id: string | null;
  changed_at: string | null;
}

const COLUMNS = "id, starter, name, body, updated_at, origin, summary, author, version, catalogue_id, changed_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sharedOf(r: Partial<Row>): SharedInfo | null {
  if (r.origin !== "shared") return null;
  return { author: r.author ?? null, version: r.version ?? null, summary: r.summary ?? "", catalogue_id: r.catalogue_id ?? null, changed: !!r.changed_at };
}

function shape(t: { id: string; starter: string | null; name: string; body: string; edited: boolean; updated_at: string | null; shared?: SharedInfo | null }): NoteTemplate {
  const starter = STARTERS.find((s) => s.key === t.starter);
  const fields = parseTemplate(t.body).map((f) => f.name);
  const shared = t.shared ?? null;
  return {
    id: t.id,
    starter: t.starter,
    name: t.name,
    body: t.body,
    edited: t.edited,
    updated_at: t.updated_at,
    blurb: starter?.blurb ?? (shared?.summary || (fields.length ? `Fills ${fields.slice(0, 3).join(", ")}${fields.length > 3 ? "…" : ""}` : "Your own")),
    fields,
    needs: templateNeeds(t.body),
    shared,
  };
}

const fromRow = (r: Row): NoteTemplate => shape({ ...r, starter: r.origin === "shared" ? null : r.starter, edited: true, shared: sharedOf(r) });

/** Starters first (edited or not), in their order, then the owner's own, newest first. */
export async function listTemplates(): Promise<NoteTemplate[]> {
  const rows = await q<Row>(`SELECT ${COLUMNS} FROM note_templates WHERE archived_at IS NULL ORDER BY updated_at DESC`);
  const starters = STARTERS.map((s) => {
    const edited = rows.find((r) => r.starter === s.key && r.origin !== "shared");
    return shape(edited ? { ...edited, edited: true } : { id: `starter:${s.key}`, starter: s.key, name: s.name, body: s.body, edited: false, updated_at: null });
  });
  const own = rows.filter((r) => r.origin === "shared" || !r.starter || !STARTERS.some((s) => s.key === r.starter)).map(fromRow);
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
  const [row] = await q<Row>(`INSERT INTO note_templates (name, body) VALUES ($1, $2) RETURNING ${COLUMNS}`, [s.text(t.name), s.text(t.body)]);
  return fromRow(row);
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
    const [row] = await q<Row>(`INSERT INTO note_templates (starter, name, body) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`, [starterKey, s.text(t.name), s.text(t.body)]);
    return fromRow(row);
  }
  if (!UUID_RE.test(id)) throw new AthenaInputError("No such template");
  const [current] = await q<Row>(`SELECT ${COLUMNS} FROM note_templates WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!current) throw new AthenaInputError("No such template");
  const t = clean({ name: input.name ?? current.name, body: input.body ?? current.body });
  // An added template the owner changes is theirs from then on: an Update goes beside it, never over it.
  const changed = current.origin === "shared" && (t.name !== current.name || t.body !== current.body);
  const [row] = await q<Row>(`UPDATE note_templates SET name = $2, body = $3, updated_at = now()${changed ? ", changed_at = now()" : ""} WHERE id = $1 RETURNING ${COLUMNS}`, [id, s.text(t.name), s.text(t.body)]);
  return fromRow(row);
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

// ---------- shared templates ----------

const CATALOGUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

type Listing = { id: string; hash: string; version?: string };

function readListing(catalogue?: Listing) {
  if (!catalogue) return null;
  if (!CATALOGUE_ID.test(catalogue.id) || !HASH.test(catalogue.hash)) throw new AthenaInputError("That catalogue listing isn't one Athena can read.");
  const version = typeof catalogue.version === "string" ? catalogue.version.trim().slice(0, 20) : "";
  return { id: catalogue.id, hash: catalogue.hash, version: version || null };
}

function readShared(raw: SharedTemplate): SharedTemplate {
  try {
    return readSharedTemplate(raw);
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/** What adding (or updating) a shared template did. */
export interface AddedTemplate {
  id: string;
  /** The name it's under: its own, or with a number on the end when one of the owner's has that name. */
  name: string;
  renamed: boolean;
  /** An Update went beside the owner's changed copy rather than over it. */
  beside: boolean;
}

async function insertShared(shared: SharedTemplate, listing: ReturnType<typeof readListing>): Promise<AddedTemplate> {
  const all = await listTemplates();
  if (all.filter((t) => !(t.starter && !t.edited)).length >= TEMPLATE_LIMITS.count) throw new AthenaInputError(`You can keep up to ${TEMPLATE_LIMITS.count} templates. Remove one first.`);
  const name = freeTemplateName(shared.name, all.map((t) => t.name));
  const s = await sealer();
  const [row] = await q<{ id: string }>(
    `INSERT INTO note_templates (name, body, origin, summary, author, version, catalogue_id, catalogue_hash, catalogue_version) VALUES ($1, $2, 'shared', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [s.text(name), s.text(shared.body), s.text(shared.summary), shared.author ?? null, shared.version ?? null, listing?.id ?? null, listing?.hash ?? null, listing?.version ?? null],
  );
  return { id: row.id, name, renamed: name !== shared.name, beside: false };
}

/**
 * Add a shared template: read again, and kept as a new template marked as someone else's. Nothing of the owner's is
 * replaced or renamed; a name already in use gets a number on the end. Throws AthenaInputError with words.
 */
export async function addSharedTemplate(raw: SharedTemplate, catalogue?: Listing): Promise<AddedTemplate> {
  return insertShared(readShared(raw), readListing(catalogue));
}

/**
 * Update a template added from Community to a newer version. While the owner hasn't changed it, its name stays and
 * its body and summary become the new version's. Once they have, theirs is left exactly as it is (and no longer
 * follows the listing), and the new version is added beside it. Throws AthenaInputError with words.
 */
export async function replaceSharedTemplate(id: string, raw: SharedTemplate, catalogue: Listing): Promise<AddedTemplate> {
  if (!UUID_RE.test(id)) throw new AthenaInputError("That template isn't there any more", 404);
  const shared = readShared(raw);
  const listing = readListing(catalogue)!;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM note_templates WHERE id = $1 AND archived_at IS NULL AND origin = 'shared'`, [id]);
  if (!row) throw new AthenaInputError("That template isn't there any more", 404);
  if (row.changed_at) {
    // Theirs stays as they left it, and stops following the listing (no hash, so no update checks), still saying it
    // came from Community; the new version goes beside it, and is the one found for that listing from now on.
    await qRaw(`UPDATE note_templates SET catalogue_hash = NULL, updated_at = now() WHERE id = $1`, [id]);
    return { ...(await insertShared(shared, listing)), beside: true };
  }
  const s = await sealer();
  await qRaw(
    `UPDATE note_templates SET body = $2, summary = $3, author = $4, version = $5, catalogue_id = $6, catalogue_hash = $7, catalogue_version = $8, updated_at = now() WHERE id = $1`,
    [id, s.text(shared.body), s.text(shared.summary), shared.author ?? null, shared.version ?? null, listing.id, listing.hash, listing.version],
  );
  return { id, name: row.name, renamed: false, beside: false };
}

/** An added template's tier as it is here now, for Community's Update banner: always 1 (lib/reach.ts reachOfTemplate). */
export async function templateTier(id: string): Promise<Reach["tier"] | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await qRaw<{ id: string }>(`SELECT id FROM note_templates WHERE id = $1 AND archived_at IS NULL`, [id]);
  return row ? 1 : null;
}

/**
 * One of the owner's own templates as a file to share. `raw` is the request: `{ edits?, fine? }`. Athena's starters
 * (edited or not) and templates added from someone else can't go. Throws AthenaInputError with words.
 */
export async function exportTemplateFor(id: string, raw: Record<string, unknown>, opts: { hosts: string[]; known?: KnownTerm[] }): Promise<TemplateExport> {
  if (id.startsWith("starter:")) throw new AthenaInputError("That's one of Athena's own templates, and every Athena has it already. Share one you wrote.");
  if (!UUID_RE.test(id)) throw new AthenaInputError("No such template", 404);
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM note_templates WHERE id = $1 AND archived_at IS NULL`, [id]);
  if (!row) throw new AthenaInputError("No such template", 404);
  if (row.origin === "shared") throw new AthenaInputError("Someone else shared that template with you. Share only templates you wrote.");
  if (row.starter) throw new AthenaInputError("That's your version of one of Athena's own templates. Share one you wrote.");
  if (isEncryptedPlaceholder(row.name) || isEncryptedPlaceholder(row.body)) throw new AthenaInputError("That template can't be read right now, so it can't be shared");
  const e = (raw.edits && typeof raw.edits === "object" ? raw.edits : {}) as Record<string, unknown>;
  const fine = Array.isArray(raw.fine) ? raw.fine.filter((f): f is string => typeof f === "string").slice(0, 200) : [];
  const known = opts.known ?? (await (await import("./team-share-store")).knownTerms());
  try {
    return exportTemplate({ name: row.name, body: row.body }, {
      ownHosts: opts.hosts,
      known,
      edits: { name: str(e.name, 200), summary: str(e.summary, 800), version: str(e.version, 20), author: str(e.author, 40) },
      fine,
    });
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

/** The download: <slug>/template.json in a zip. */
export async function templateZip(x: TemplateExport): Promise<Uint8Array> {
  const { writeSkillZip } = await import("./skill-zip");
  return writeSkillZip([{ path: `${x.slug}/${TEMPLATE_FILE}`, text: serialiseSharedTemplate(x.shared) }]);
}
