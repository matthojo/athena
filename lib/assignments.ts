/**
 * Assignments: the store (docs/team.md, "Store"; migration 0076; the
 * contract is lib/assignment-types.ts).
 *
 * `team_assignments.payload` seals the title and brief, and
 * `team_stages.words` seals a stage's task, handoff, questions and answers
 * (StageWords), as `team_assistants.payload` does. Status, checkpoints and
 * what a stage waits for are plain, so the reminders job can read them.
 *
 * A guest is a `team_assistants` row with `assignment_id` set, made here
 * from the role library (lib/team-roles.ts) with a character from a fresh
 * seed. It has no triggers, isn't on the Team page (lib/team.ts leaves it
 * out) and goes with its assignment. `keepGuest` clears the column: the same
 * row becomes a standing assistant.
 *
 * Nothing here runs anything: lib/assignment-run.ts moves the work on.
 */
import { AthenaInputError, q, qRaw, tx } from "./db";
import { sealText } from "./data-box";
import type { Assignment, AssignmentStage, AssignmentStatus, Checkpoint, DocumentFile, Lineup, LineupStage, RoleKey, StageStatus, StageWho, StageWords, Suggestions, WaitsFor } from "./assignment-types";
import { ASSIGNMENT_LIMITS as L, ROLE_KEYS } from "./assignment-types";
import { guestAllow, roleFor } from "./team-roles";
import { getAssistant } from "./team";
import { getTeamRun } from "./team-run";
import { avatarFromSeed, nameFromSeed, newSeed, personalityFromSeed } from "./team-seed";
import { MAX_ASSISTANTS, MAX_JOB, type AvatarSpec, type TeamAssistant } from "./team-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
type Run = <T>(text: string, params?: unknown[]) => Promise<T[]>;

/** Keeping a guest when the team already has MAX_ASSISTANTS: the route answers 409 with this line. */
export class TeamFullError extends Error {
  constructor(name: string) {
    super(`Your team is full. Remove an assistant to keep ${name}.`);
    this.name = "TeamFullError";
  }
}

/** What `words` holds beside the contract's StageWords. Never sent to the app. */
export interface StoredWords extends StageWords {
  /** This stage read other people's words (a web page, a collected note), so every later stage is held as it was. */
  held?: boolean;
  /** Its own send-back, asked for while a plan of its waits for Go: done once the plan has had it. */
  back?: { to: number; note: string };
}

/** A stage as the runner works with it. */
export interface StageRec {
  id: string;
  assignment_id: string;
  position: number;
  assistant_id: string;
  checkpoint: Checkpoint;
  status: StageStatus;
  waits_for: WaitsFor | null;
  run_id: string | null;
  note_version: string | null;
  sent_back_from: number | null;
  words: StoredWords;
  started_at: string | null;
  finished_at: string | null;
}

/** An assignment without its stages. */
export type AssignmentHead = Omit<Assignment, "stages" | "documents">;

interface HeadRow {
  id: string;
  payload: string;
  status: AssignmentStatus;
  checkpoint: Checkpoint;
  suggestions: Suggestions;
  sent_back: boolean;
  note_id: string | null;
  thread_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  finished_at: string | Date | null;
}

interface StageRow extends Omit<StageRec, "words" | "started_at" | "finished_at"> {
  words: string;
  started_at: string | Date | null;
  finished_at: string | Date | null;
}

const H_COLUMNS = `id, payload, status, checkpoint, suggestions, sent_back, note_id, thread_id, created_at, updated_at, finished_at`;
const S_COLUMNS = `id, assignment_id, position, assistant_id, checkpoint, status, waits_for, run_id, note_version, sent_back_from, words, started_at, finished_at`;

function readJson<T>(text: string | null): Partial<T> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    // sealed under a key this deploy doesn't have: shown without its words, never run
    return {};
  }
}

const presentHead = (r: HeadRow): AssignmentHead => {
  const w = readJson<{ title: string; brief: string }>(r.payload);
  return {
    id: r.id,
    title: w.title ?? "",
    brief: w.brief ?? "",
    status: r.status,
    checkpoint: r.checkpoint,
    suggestions: r.suggestions,
    sent_back: r.sent_back === true,
    note_id: r.note_id,
    thread_id: r.thread_id,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    finished_at: iso(r.finished_at),
  };
};

/** Words as kept: every part present, whatever was stored. Pure. */
export function cleanWords(w: Partial<StoredWords>): StoredWords {
  return {
    task: typeof w.task === "string" ? w.task : "",
    handoff: w.handoff && typeof w.handoff === "object" ? { did: String(w.handoff.did ?? ""), open: String(w.handoff.open ?? ""), next: String(w.handoff.next ?? "") } : null,
    questions: Array.isArray(w.questions) ? w.questions : [],
    answers: Array.isArray(w.answers) ? w.answers : [],
    ...(typeof w.note === "string" && w.note ? { note: w.note } : {}),
    ...(w.held ? { held: true } : {}),
    ...(w.back && typeof w.back === "object" && Number.isInteger(w.back.to) ? { back: { to: w.back.to, note: String(w.back.note ?? "") } } : {}),
  };
}

const presentStage = (r: StageRow): StageRec => ({ ...r, position: Number(r.position), sent_back_from: r.sent_back_from == null ? null : Number(r.sent_back_from), words: cleanWords(readJson<StoredWords>(r.words)), started_at: iso(r.started_at), finished_at: iso(r.finished_at) });

// ---------- reading ----------

export async function headOf(id: unknown): Promise<AssignmentHead | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<HeadRow>(`SELECT ${H_COLUMNS} FROM team_assignments WHERE id = $1::uuid`, [id]);
  return row ? presentHead(row) : null;
}

/** An assignment's stages, in order. */
export async function loadStages(assignmentId: string): Promise<StageRec[]> {
  if (!UUID.test(assignmentId)) return [];
  return (await q<StageRow>(`SELECT ${S_COLUMNS} FROM team_stages WHERE assignment_id = $1::uuid ORDER BY position`, [assignmentId])).map(presentStage);
}

export async function stageById(id: string): Promise<StageRec | null> {
  if (!UUID.test(id)) return null;
  const [row] = await q<StageRow>(`SELECT ${S_COLUMNS} FROM team_stages WHERE id = $1::uuid`, [id]);
  return row ? presentStage(row) : null;
}

/** The stage a Team run belongs to (team_runs.stage_id), or null for any other run. */
export async function stageOfRun(runId: string): Promise<StageRec | null> {
  if (!UUID.test(runId)) return null;
  const [row] = await q<StageRow>(`SELECT ${S_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ")} FROM team_stages s JOIN team_runs r ON r.stage_id = s.id WHERE r.id = $1::uuid`, [runId]);
  return row ? presentStage(row) : null;
}

interface WhoRow {
  id: string;
  payload: string;
  role: string | null;
  assignment_id: string | null;
}

/** Who each stage is, as lists draw it. */
async function whoFor(ids: string[]): Promise<Map<string, StageWho>> {
  const out = new Map<string, StageWho>();
  if (!ids.length) return out;
  const rows = await q<WhoRow>(`SELECT id, payload, role, assignment_id FROM team_assistants WHERE id = ANY($1::uuid[])`, [ids]);
  for (const r of rows) {
    const w = readJson<{ name: string; job: string; avatar: AvatarSpec }>(r.payload);
    const role = r.role && (ROLE_KEYS as readonly string[]).includes(r.role) ? (r.role as RoleKey) : null;
    out.set(r.id, { id: r.id, name: w.name ?? "", avatar: w.avatar ?? avatarFromSeed(r.id), job: w.job ?? "", role, guest: r.assignment_id != null });
  }
  return out;
}

/** One stage's `who`, for a post or a line of copy. */
export async function whoOf(assistantId: string): Promise<StageWho | null> {
  return (await whoFor([assistantId])).get(assistantId) ?? null;
}

async function present(head: AssignmentHead, documentsFor?: (noteId: string) => Promise<DocumentFile[]>): Promise<Assignment> {
  const recs = await loadStages(head.id);
  const who = await whoFor([...new Set(recs.map((s) => s.assistant_id))]);
  const stages: AssignmentStage[] = [];
  for (const s of recs) {
    const run = s.run_id ? await getTeamRun(s.run_id) : null;
    const { held: _held, back: _back, ...words } = s.words;
    stages.push({
      ...words,
      id: s.id,
      position: s.position,
      who: who.get(s.assistant_id) ?? { id: s.assistant_id, name: "", avatar: avatarFromSeed(s.assistant_id), job: "", role: null, guest: false },
      checkpoint: s.checkpoint,
      status: s.status,
      waits_for: s.waits_for,
      run_id: s.run_id,
      thread_id: run?.thread_id ?? null,
      waiting: run?.waiting ?? 0,
      step: s.status === "running" ? (run?.step ?? null) : null,
      note_version: s.note_version,
      sent_back_from: s.sent_back_from,
      started_at: s.started_at,
      finished_at: s.finished_at,
    });
  }
  const documents = head.note_id && documentsFor ? await documentsFor(head.note_id).catch(() => []) : [];
  return { ...head, stages, documents };
}

export async function getAssignment(id: unknown, documentsFor?: (noteId: string) => Promise<DocumentFile[]>): Promise<Assignment | null> {
  const head = await headOf(id);
  return head ? present(head, documentsFor) : null;
}

/** Every assignment, newest first. */
export async function listAssignments(documentsFor?: (noteId: string) => Promise<DocumentFile[]>, limit = 50): Promise<Assignment[]> {
  const rows = await q<HeadRow>(`SELECT ${H_COLUMNS} FROM team_assignments ORDER BY created_at DESC, id LIMIT $1`, [Math.min(100, Math.max(1, Math.floor(limit) || 50))]);
  const out: Assignment[] = [];
  for (const r of rows) out.push(await present(presentHead(r), documentsFor));
  return out;
}

/** Assignments running or waiting now (ASSIGNMENT_LIMITS.running at most). */
export async function openCount(): Promise<number> {
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_assignments WHERE status IN ('running', 'waiting')`);
  return n;
}

/** Stages that wait for the owner: an answer, an approval, or a Go on a plan. */
export async function waitingCount(): Promise<number> {
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM team_stages s JOIN team_assignments a ON a.id = s.assignment_id WHERE a.status = 'waiting' AND s.status = 'waiting' AND s.waits_for IS NOT NULL`);
  return n;
}

/** Assignments with a stage running or waiting on a plan: what the reminders pass looks over (lib/assignment-run.ts sweepAssignments). */
export async function openAssignmentIds(): Promise<string[]> {
  return (await qRaw<{ id: string }>(`SELECT id FROM team_assignments WHERE status IN ('running', 'waiting') ORDER BY updated_at`)).map((r) => r.id);
}

// ---------- writing ----------

const sealWords = (w: StoredWords) => sealText(JSON.stringify(cleanWords(w)));

/** A guest's row for one stage: a character from the lineup's seed (or a fresh one), the role's job and instructions. */
async function insertGuest(run: Run, assignmentId: string, stage: LineupStage, taken: string[]): Promise<string> {
  const role = roleFor(stage.role);
  const seed = stage.seed || newSeed();
  const name = stage.name?.trim() || nameFromSeed(seed, taken);
  taken.push(name);
  const words = {
    name,
    job: (stage.job?.trim() || role?.job || stage.task).slice(0, MAX_JOB),
    instructions: (stage.role === "custom" ? stage.instructions : role?.instructions)?.trim() ?? "",
    personality: personalityFromSeed(seed),
    avatar: avatarFromSeed(seed),
  };
  const [row] = await run<{ id: string }>(
    `INSERT INTO team_assistants (payload, allow, paused, web, assignment_id, role) VALUES ($1, $2::text[], false, $3, $4::uuid, $5) RETURNING id`,
    [sealText(JSON.stringify(words)), guestAllow(role?.allow ?? []), stage.web ?? role?.web ?? false, assignmentId, stage.role],
  );
  return row.id;
}

async function insertStages(run: Run, assignmentId: string, lineup: Lineup): Promise<void> {
  const taken = (await run<{ payload: string }>(`SELECT payload FROM team_assistants WHERE assignment_id IS NULL`)).map((r) => readJson<{ name: string }>(r.payload).name ?? "").filter(Boolean);
  for (const [i, stage] of lineup.stages.entries()) {
    let assistantId = stage.assistant_id ?? null;
    if (assistantId) {
      const [standing] = await run<{ id: string }>(`SELECT id FROM team_assistants WHERE id = $1::uuid AND assignment_id IS NULL`, [assistantId]);
      if (!standing) throw new AthenaInputError(`Stage ${i + 1}: that assistant isn't on the team any more`, 404);
    } else assistantId = await insertGuest(run, assignmentId, stage, taken);
    await run(`INSERT INTO team_stages (assignment_id, position, assistant_id, checkpoint, words) VALUES ($1::uuid, $2, $3::uuid, $4, $5)`, [
      assignmentId,
      i + 1,
      assistantId,
      stage.checkpoint,
      sealWords({ task: stage.task, handoff: null, questions: [], answers: [] }),
    ]);
  }
}

/**
 * Keep a lineup as a draft: the assignment, its guests and its stages. Nothing runs. With `id`, a draft's lineup
 * is replaced (the owner reordered or swapped before Go): its guests and stages are made again.
 */
export async function saveLineup(lineup: Lineup, opts: { id?: string | null; threadId?: string | null } = {}): Promise<string> {
  if (lineup.stages.length < L.minStages || lineup.stages.length > L.maxStages) throw new AthenaInputError(`A lineup has ${L.minStages} to ${L.maxStages} stages`);
  const payload = sealText(JSON.stringify({ title: lineup.title, brief: lineup.brief }));
  return tx(async (run) => {
    let id = opts.id ?? null;
    if (id) {
      const rows = await run<{ id: string }>(`UPDATE team_assignments SET payload = $2, checkpoint = $3, suggestions = $4, updated_at = now() WHERE id = $1::uuid AND status = 'draft' RETURNING id`, [id, payload, lineup.checkpoint, lineup.suggestions]);
      if (!rows.length) throw new AthenaInputError("That lineup has already started, or isn't there any more", 404);
      await run(`DELETE FROM team_stages WHERE assignment_id = $1::uuid`, [id]);
      await run(`DELETE FROM team_assistants WHERE assignment_id = $1::uuid`, [id]);
    } else {
      const thread = opts.threadId && UUID.test(opts.threadId) ? opts.threadId : null;
      const [row] = await run<{ id: string }>(`INSERT INTO team_assignments (payload, status, checkpoint, suggestions, thread_id) VALUES ($1, 'draft', $2, $3, $4::uuid) RETURNING id`, [payload, lineup.checkpoint, lineup.suggestions, thread]);
      id = row.id;
    }
    await insertStages(run, id, lineup);
    return id;
  });
}

/** Change an assignment's plain columns. `when`: only from one of these statuses; false when it had moved on. */
export async function setHead(
  id: string,
  patch: { status?: AssignmentStatus; checkpoint?: Checkpoint; suggestions?: Suggestions; sent_back?: boolean; note_id?: string | null; finished?: boolean },
  when?: AssignmentStatus[],
): Promise<boolean> {
  const rows = await qRaw<{ id: string }>(
    `UPDATE team_assignments SET status = COALESCE($2, status), checkpoint = COALESCE($3, checkpoint), suggestions = COALESCE($4, suggestions), sent_back = COALESCE($5, sent_back),
            note_id = CASE WHEN $6 THEN $7::uuid ELSE note_id END, finished_at = CASE WHEN $8::boolean IS NULL THEN finished_at WHEN $8 THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1::uuid AND ($9::text[] IS NULL OR status = ANY($9::text[])) RETURNING id`,
    [id, patch.status ?? null, patch.checkpoint ?? null, patch.suggestions ?? null, patch.sent_back ?? null, patch.note_id !== undefined, patch.note_id ?? null, patch.finished ?? null, when ?? null],
  );
  return rows.length > 0;
}

export interface StagePatch {
  status?: StageStatus;
  /** null clears it. */
  waits_for?: WaitsFor | null;
  run_id?: string | null;
  note_version?: string | null;
  sent_back_from?: number | null;
  checkpoint?: Checkpoint;
  words?: StoredWords;
  started?: boolean;
  /** true: now. false: cleared. */
  finished?: boolean;
}

/** Change a stage. `when`: only while it's in this status (and waiting for this); false when it had moved on, so a step is taken once. */
export async function setStage(id: string, patch: StagePatch, when?: { status: StageStatus; waits_for?: WaitsFor | null }): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (sql: string, value?: unknown) => {
    if (value === undefined) sets.push(sql);
    else {
      params.push(value);
      sets.push(sql.replace("?", `$${params.length}`));
    }
  };
  if (patch.status) set(`status = ?`, patch.status);
  if (patch.waits_for !== undefined) patch.waits_for === null ? set(`waits_for = NULL`) : set(`waits_for = ?`, patch.waits_for);
  if (patch.run_id !== undefined) patch.run_id === null ? set(`run_id = NULL`) : set(`run_id = ?::uuid`, patch.run_id);
  if (patch.note_version !== undefined) patch.note_version === null ? set(`note_version = NULL`) : set(`note_version = ?::uuid`, patch.note_version);
  if (patch.sent_back_from !== undefined) patch.sent_back_from === null ? set(`sent_back_from = NULL`) : set(`sent_back_from = ?`, patch.sent_back_from);
  if (patch.checkpoint) set(`checkpoint = ?`, patch.checkpoint);
  if (patch.words) set(`words = ?`, sealWords(patch.words));
  if (patch.started) set(`started_at = now()`);
  if (patch.finished !== undefined) set(patch.finished ? `finished_at = now()` : `finished_at = NULL`);
  if (!sets.length) return true;
  let where = `id = $1::uuid`;
  if (when) {
    params.push(when.status);
    where += ` AND status = $${params.length}`;
    if (when.waits_for !== undefined) {
      if (when.waits_for === null) where += ` AND waits_for IS NULL`;
      else {
        params.push(when.waits_for);
        where += ` AND waits_for = $${params.length}`;
      }
    }
  }
  const rows = await qRaw<{ id: string }>(`UPDATE team_stages SET ${sets.join(", ")} WHERE ${where} RETURNING id`, params);
  return rows.length > 0;
}

/** Remove an assignment: its stages, guests and posts go with it. Its note stays: that's the owner's. */
export async function deleteAssignment(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  // A guest's "From <Name>" cards go from Home with it, as deleteAssistant does for a standing one.
  await qRaw(`UPDATE nudges SET dismissed_at = now() WHERE dismissed_at IS NULL AND rule = 'team' AND key IN (SELECT 'team:' || r.id::text FROM team_runs r JOIN team_assistants a ON a.id = r.assistant_id WHERE a.assignment_id = $1::uuid)`, [id]);
  const rows = await qRaw<{ id: string }>(`DELETE FROM team_assignments WHERE id = $1::uuid RETURNING id`, [id]);
  return rows.length > 0;
}

// ---------- guests ----------

/** Is this assistant a guest, and of which assignment? */
export async function guestOf(assistantId: string): Promise<string | null> {
  if (!UUID.test(assistantId)) return null;
  const [row] = await qRaw<{ assignment_id: string | null }>(`SELECT assignment_id FROM team_assistants WHERE id = $1::uuid`, [assistantId]);
  return row?.assignment_id ?? null;
}

/**
 * "Keep <Name> on the team": the guest's row becomes a standing assistant, so its skill, conversations and runs
 * come with it. It keeps its allowlist and has no triggers. Throws TeamFullError at MAX_ASSISTANTS. Returns the
 * assistant and the assignment it came from; `kept: false` when it was standing already.
 */
export async function keepGuest(assistantId: unknown): Promise<{ assistant: TeamAssistant; assignment_id: string | null; kept: boolean }> {
  const a = await getAssistant(assistantId);
  if (!a) throw new AthenaInputError("That assistant isn't there any more", 404);
  const from = await guestOf(a.id);
  if (!from) return { assistant: a, assignment_id: null, kept: false };
  const kept = await qRaw<{ id: string }>(
    `UPDATE team_assistants SET assignment_id = NULL, updated_at = now()
      WHERE id = $1::uuid AND assignment_id IS NOT NULL AND (SELECT count(*) FROM team_assistants WHERE assignment_id IS NULL) < $2 RETURNING id`,
    [a.id, MAX_ASSISTANTS],
  );
  if (!kept.length) {
    // Kept from another tab in the meantime, or no room.
    if (!(await guestOf(a.id))) return { assistant: a, assignment_id: null, kept: false };
    throw new TeamFullError(a.name);
  }
  return { assistant: a, assignment_id: from, kept: true };
}
