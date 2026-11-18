/**
 * The owner's skills (migration 0058, `ask_skills`): SKILL.md text, reference
 * files and where each came from, sealed in `payload` under the data key
 * (SECURITY.md §11). Readable columns are only the on switch, the starter key,
 * the use count and times. Names are unique, checked here (they're sealed).
 *
 * Nothing is saved without the owner: an import is a preview first
 * (lib/skills.ts, lib/skill-fetch.ts), and a draft from a chat
 * (lib/skill-draft.ts) only opens the editor. A new skill starts off unless
 * the owner saves it on.
 *
 * An assistant's own skill (0069, docs/team.md "Skills") has `assistant_id`
 * set: Athena writes it for that Team assistant, its turns always load it,
 * and main Ask never lists or loads it (enabledSkills skips it; it stays off).
 * It doesn't count toward the owner's 50, and it goes with its assistant.
 */
import { AthenaInputError, q, qRaw } from "./db";
import { sealText } from "./data-box";
import { STARTER_SKILLS } from "./skill-starters";
import { checkDoc, checkFiles, parseSkillMd, SKILL_LIMITS, SkillFormatError, type SkillDoc, type SkillFile, type SkillSkipped, type SkillSource, type SkillSourceKind } from "./skills";
import type { TeamSkillMeta } from "./team-skill";

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  extra: string;
  files: SkillFile[];
  skipped: SkillSkipped[];
  source: SkillSource;
  enabled: boolean;
  starter: string | null;
  /** The Team assistant it belongs to (its own skill), or null for the owner's. */
  assistant_id: string | null;
  /** An assistant's skill: what Athena wrote it from. */
  team?: TeamSkillMeta;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  payload: string;
  enabled: boolean;
  starter: string | null;
  assistant_id: string | null;
  uses: number;
  last_used_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface Payload {
  name: string;
  description: string;
  body: string;
  extra: string;
  files: SkillFile[];
  skipped: SkillSkipped[];
  source: SkillSource;
  team?: TeamSkillMeta;
}

const COLUMNS = `id, payload, enabled, starter, assistant_id, uses, last_used_at, created_at, updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
const SOURCE_KINDS: SkillSourceKind[] = ["upload", "link", "written", "chat", "starter", "team"];

/** A row as Athena reads it; null when its text can't be opened (sealed under a key this deploy doesn't have). */
function present(r: Row): Skill | null {
  let p: Payload;
  try {
    p = JSON.parse(r.payload) as Payload;
  } catch {
    return null;
  }
  return {
    id: r.id,
    name: p.name,
    description: p.description,
    body: p.body,
    extra: p.extra ?? "",
    files: p.files ?? [],
    skipped: p.skipped ?? [],
    source: p.source,
    enabled: r.enabled,
    starter: r.starter,
    assistant_id: r.assistant_id ?? null,
    ...(p.team ? { team: p.team } : {}),
    uses: Number(r.uses ?? 0),
    last_used_at: iso(r.last_used_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

/** Add the starters once: one the owner deletes stays deleted. */
async function ensureStarters(): Promise<void> {
  const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'skills.starters'`);
  if (row) return;
  // Claim the setting first, so two lists at once add them once.
  const claimed = await qRaw<{ key: string }>(`INSERT INTO settings (key, value) VALUES ('skills.starters', 'true'::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`);
  if (!claimed.length) return;
  const at = new Date().toISOString();
  for (const s of STARTER_SKILLS) {
    const doc = parseSkillMd(s.text);
    const payload: Payload = { ...doc, files: [], skipped: [], source: { kind: "starter", at } };
    await qRaw(`INSERT INTO ask_skills (payload, enabled, starter) VALUES ($1, false, $2)`, [sealText(JSON.stringify(payload)), s.key]);
  }
}

/** Every skill, most recently used first, then newest. */
export async function listSkills(): Promise<Skill[]> {
  await ensureStarters();
  const rows = await q<Row>(`SELECT ${COLUMNS} FROM ask_skills ORDER BY last_used_at DESC NULLS LAST, created_at DESC`);
  return rows.map(present).filter((s): s is Skill => !!s);
}

/** The switched-on skills, for main Ask: never an assistant's own. No starters are added from here. */
export async function enabledSkills(): Promise<Skill[]> {
  const rows = await q<Row>(`SELECT ${COLUMNS} FROM ask_skills WHERE enabled AND assistant_id IS NULL ORDER BY last_used_at DESC NULLS LAST, created_at DESC`);
  return rows.map(present).filter((s): s is Skill => !!s);
}

export async function getSkill(id: unknown): Promise<Skill | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM ask_skills WHERE id = $1::uuid`, [id]);
  return row ? present(row) : null;
}

export interface SkillInput {
  /** The whole SKILL.md (an import or download); or the three parts below. */
  skill_md?: unknown;
  name?: unknown;
  description?: unknown;
  body?: unknown;
  extra?: unknown;
  files?: unknown;
  skipped?: unknown;
  source?: unknown;
  enabled?: unknown;
}

const str = (v: unknown, max = 50_000) => (typeof v === "string" ? v.slice(0, max) : undefined);

function sourceOf(raw: unknown): SkillSource {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = SOURCE_KINDS.includes(s.kind as SkillSourceKind) && s.kind !== "starter" && s.kind !== "team" ? (s.kind as SkillSourceKind) : "written";
  const url = str(s.url, 2048);
  const file = str(s.file, 200);
  return { kind, ...(url && /^https:\/\//.test(url) ? { url } : {}), ...(file ? { file } : {}), at: new Date().toISOString() };
}

function skippedOf(raw: unknown): SkillSkipped[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 200)
    .map((x) => ({ path: String((x as { path?: unknown })?.path ?? "").slice(0, 300), reason: String((x as { reason?: unknown })?.reason ?? "").slice(0, 80) }))
    .filter((x) => x.path && x.reason);
}

/** The parts to keep, checked: a SKILL.md read whole, or the editor's fields. Throws AthenaInputError. */
function payloadOf(input: SkillInput, was?: Skill): Payload {
  try {
    const md = str(input.skill_md, SKILL_LIMITS.body + 5_000);
    const doc = md
      ? parseSkillMd(md)
      : checkDoc({
          name: str(input.name, 200) ?? was?.name ?? "",
          description: str(input.description, 5_000) ?? was?.description ?? "",
          body: str(input.body, SKILL_LIMITS.body + 1) ?? was?.body ?? "",
          extra: str(input.extra, 5_000) ?? was?.extra ?? "",
        });
    const files = input.files === undefined ? (was?.files ?? []) : checkFiles(input.files);
    return { ...doc, files, skipped: input.skipped === undefined ? (was?.skipped ?? []) : skippedOf(input.skipped), source: was?.source ?? sourceOf(input.source), ...(was?.team ? { team: was.team } : {}) };
  } catch (error) {
    if (error instanceof SkillFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
}

async function nameTaken(name: string, except?: string): Promise<boolean> {
  return (await listSkills()).some((s) => s.name === name && s.id !== except);
}

/** Save a new skill the owner checked. Off unless they say on. */
export async function createSkill(input: SkillInput): Promise<Skill> {
  const p = payloadOf(input);
  const all = await listSkills();
  if (all.filter((s) => !s.assistant_id).length >= SKILL_LIMITS.skills) throw new AthenaInputError(`You have ${SKILL_LIMITS.skills} skills, the most Athena keeps. Delete one first.`);
  if (all.some((s) => s.name === p.name)) throw new AthenaInputError(`There's already a skill called ${p.name}. Pick another name.`);
  const [row] = await q<Row>(`INSERT INTO ask_skills (payload, enabled) VALUES ($1, $2) RETURNING ${COLUMNS}`, [sealText(JSON.stringify(p)), input.enabled === true]);
  return present(row)!;
}

/** Change a skill's text, files or switch. */
export async function updateSkill(id: unknown, input: SkillInput): Promise<Skill> {
  const was = await getSkill(id);
  if (!was) throw new AthenaInputError("That skill isn't there any more", 404);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new AthenaInputError("enabled: true or false");
  const touchesText = ["skill_md", "name", "description", "body", "extra", "files", "skipped"].some((k) => (input as Record<string, unknown>)[k] !== undefined);
  const p = touchesText ? payloadOf(input, was) : null;
  // An assistant's own skill stays off: it's loaded by its assistant, never by main Ask.
  if (was.assistant_id) input = { ...input, enabled: undefined };
  if (p && p.name !== was.name && (await nameTaken(p.name, was.id))) throw new AthenaInputError(`There's already a skill called ${p.name}. Pick another name.`);
  const [row] = await q<Row>(
    `UPDATE ask_skills SET payload = COALESCE($2, payload), enabled = COALESCE($3, enabled), updated_at = now() WHERE id = $1::uuid RETURNING ${COLUMNS}`,
    [was.id, p ? sealText(JSON.stringify(p)) : null, typeof input.enabled === "boolean" ? input.enabled : null],
  );
  return present(row)!;
}

export async function deleteSkill(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  return (await qRaw<{ id: string }>(`DELETE FROM ask_skills WHERE id = $1::uuid RETURNING id`, [id])).length > 0;
}

/** Count one use of each, now. Unknown ids are ignored. */
export async function recordSkillUses(ids: string[], at = new Date()): Promise<void> {
  const clean = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!clean.length) return;
  await qRaw(`UPDATE ask_skills SET uses = uses + 1, last_used_at = $2 WHERE id = ANY($1::uuid[])`, [clean, at.toISOString()]);
}

// ---------- an assistant's own skill (0069) ----------

/** The skill that belongs to this assistant, or null. */
export async function assistantSkill(assistantId: string): Promise<Skill | null> {
  if (!UUID.test(assistantId)) return null;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM ask_skills WHERE assistant_id = $1::uuid`, [assistantId]);
  return row ? present(row) : null;
}

/** A name no other skill has: the one asked for, or it with -2, -3… Pure. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const tail = `-${i}`;
    const n = `${name.slice(0, SKILL_LIMITS.name - tail.length).replace(/-+$/, "")}${tail}`;
    if (!taken.has(n)) return n;
  }
  return `${name.slice(0, 50)}-${Date.now().toString(36)}`;
}

/**
 * Save the skill Athena wrote for an assistant: a new one, or this one's
 * text replaced (its files stay). It's kept off, so main Ask never uses it.
 * The name is made unique among all skills. Throws AthenaInputError.
 */
export async function putAssistantSkill(assistantId: string, doc: SkillDoc, team: TeamSkillMeta): Promise<Skill> {
  if (!UUID.test(assistantId)) throw new AthenaInputError("That assistant isn't there any more", 404);
  let clean: SkillDoc;
  try {
    clean = checkDoc(doc);
  } catch (error) {
    if (error instanceof SkillFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  const was = await assistantSkill(assistantId);
  const taken = new Set((await listSkills()).filter((s) => s.id !== was?.id).map((s) => s.name));
  const name = was && !taken.has(was.name) && clean.name === was.name ? was.name : freeName(clean.name, taken);
  const payload: Payload = { ...clean, name, files: was?.files ?? [], skipped: was?.skipped ?? [], source: was?.source ?? { kind: "team", at: new Date().toISOString() }, team };
  const sealed = sealText(JSON.stringify(payload));
  const [row] = was
    ? await q<Row>(`UPDATE ask_skills SET payload = $2, enabled = false, updated_at = now() WHERE id = $1::uuid RETURNING ${COLUMNS}`, [was.id, sealed])
    : await q<Row>(
        `INSERT INTO ask_skills (payload, enabled, assistant_id)
         SELECT $1, false, $2::uuid WHERE EXISTS (SELECT 1 FROM team_assistants WHERE id = $2::uuid)
         ON CONFLICT (assistant_id) WHERE assistant_id IS NOT NULL DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
         RETURNING ${COLUMNS}`,
        [sealed, assistantId],
      );
  if (!row) throw new AthenaInputError("That assistant isn't there any more", 404);
  return present(row)!;
}

/** Change only what Athena keeps about how a skill was made (the owner kept theirs as it is). */
export async function setAssistantSkillMeta(skill: Skill, team: TeamSkillMeta): Promise<Skill> {
  const payload: Payload = { name: skill.name, description: skill.description, body: skill.body, extra: skill.extra, files: skill.files, skipped: skill.skipped, source: skill.source, team };
  const [row] = await q<Row>(`UPDATE ask_skills SET payload = $2 WHERE id = $1::uuid RETURNING ${COLUMNS}`, [skill.id, sealText(JSON.stringify(payload))]);
  return row ? present(row)! : skill;
}
