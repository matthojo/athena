/**
 * Team chat's store (docs/team.md "Team chat"; `team_posts`, migration 0076).
 *
 * One channel for the whole team. A post is for the owner: assistants never
 * read it. Its words are sealed in `body`. It points at its run, stage or
 * assignment and never copies them: a `plan` post carries its run's
 * conversation (`thread_id`), where the plan card lives, a `reply` that
 * holds a plan carries its own, and a `question` or `handoff` post reads
 * its stage's words when it's listed.
 *
 *   postToTeam(input)        one post, as the channel draws it
 *   postRun(run, outcome)    a standing assistant's run: a plan, an update or a failure. Never throws
 *   settlePosts(keys)        a Go, an answer or an approval landed: what waited on it is settled
 *   settlePlanPosts(planId)  Go on a run's or a reply's plan (POST /api/assistant/plan)
 *   dismissPost(id)          the owner dismissed a run that didn't finish
 *   listChat({ before, limit })  a page of posts, and everything that still waits, oldest first
 *   countWaiting()           the one count: one per post that waits, the rows in `listChat().waiting`
 *   sweepPosts(now)          posts outside an assignment older than ASSIGNMENT_LIMITS.postDays
 *
 * What waits is one record everywhere. A plan's post waits exactly while
 * its conversation holds a plan that hasn't run (`ask_plans.ran_at`), the
 * same record TeamRun.waiting counts, so a Go anywhere settles it here. A
 * run that didn't finish waits (`dismiss`) until the owner dismisses it.
 */
import { AthenaInputError, q, qRaw } from "./db";
import { sealText } from "./data-box";
import { getAssistant } from "./team";
import { ASSIGNMENT_LIMITS, DOCX_TYPE, ROLE_KEYS, type DocumentFile, type PostInput, type PostKind, type RoleKey, type StageWho, type StageWords, type TeamChat, type PostWaits, type TeamPost } from "./assignment-types";

export const POST_KINDS: readonly PostKind[] = ["lineup", "update", "handoff", "question", "plan", "approval", "done", "failed", "said", "reply"];
const WAITS: readonly PostWaits[] = ["go", "answer", "approval", "dismiss"];
/** The longest post: an assignment's brief. */
export const MAX_POST = ASSIGNMENT_LIMITS.brief;
export const CHAT_PAGE = 50;
export const CHAT_PAGE_MAX = 100;
/** The waiting strip holds this many at most. */
const WAITING_MAX = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
const uuid = (v: unknown, field: string): string | null => {
  if (v == null) return null;
  if (typeof v !== "string" || !UUID.test(v)) throw new AthenaInputError(`${field}: not an id`);
  return v;
};

interface PostRow {
  id: string | number;
  assistant_id: string | null;
  assignment_id: string | null;
  stage_id: string | null;
  run_id: string | null;
  kind: PostKind;
  body: string;
  waits_for: PostWaits | null;
  settled_at: string | Date | null;
  created_at: string | Date;
  /** The post's own conversation (a reply's plan), or its run's: the post's own run, or its stage's. */
  thread_id: string | null;
  assignment: string | null;
  note_id: string | null;
  words: string | null;
}

// The run is the post's own, or its stage's: a stage's plan lives in its run's conversation.
const SELECT = `SELECT p.id, p.assistant_id, p.assignment_id, p.stage_id, p.run_id, p.kind, p.body, p.waits_for, p.settled_at, p.created_at,
       COALESCE(p.thread_id, r.thread_id) AS thread_id, a.payload AS assignment, a.note_id, s.words
  FROM team_posts p
  LEFT JOIN team_stages s ON s.id = p.stage_id
  LEFT JOIN team_runs r ON r.id = COALESCE(p.run_id, s.run_id)
  LEFT JOIN team_assignments a ON a.id = p.assignment_id`;

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // sealed under a key this deploy doesn't have
  }
};

/** Who each post is from, as lists draw them. An assistant that's gone took its posts with it (cascade). */
async function whoFor(ids: string[]): Promise<Map<string, StageWho>> {
  const out = new Map<string, StageWho>();
  if (!ids.length) return out;
  const [rows, team] = await Promise.all([
    qRaw<{ id: string; role: string | null; assignment_id: string | null }>(`SELECT id, role, assignment_id FROM team_assistants WHERE id = ANY($1::uuid[])`, [ids]),
    Promise.all(ids.map((id) => getAssistant(id).catch(() => null))),
  ]);
  for (const a of team) {
    if (!a) continue;
    const row = rows.find((r) => r.id === a.id);
    const role = row?.role && (ROLE_KEYS as readonly string[]).includes(row.role) ? (row.role as RoleKey) : null;
    out.set(a.id, { id: a.id, name: a.name, avatar: a.avatar, job: a.job, role, guest: !!row?.assignment_id });
  }
  return out;
}

/** The files made from each finished assignment's note, oldest first. */
async function documentsFor(noteIds: string[]): Promise<Map<string, DocumentFile[]>> {
  const out = new Map<string, DocumentFile[]>();
  if (!noteIds.length) return out;
  const rows = await q<{ file_id: string; note_id: string; type: string; name: string; size: number; created_at: string | Date }>(
    `SELECT f.id AS file_id, nf.note_id, f.type, f.name, f.size, f.created_at FROM note_files nf JOIN files f ON f.id = nf.file_id
      WHERE nf.note_id = ANY($1::uuid[]) AND f.made_from_note = nf.note_id AND f.type IN ('text/markdown', $2) ORDER BY f.created_at, f.id`,
    [noteIds, DOCX_TYPE],
  );
  for (const f of rows) {
    const doc: DocumentFile = { file_id: f.file_id, note_id: f.note_id, format: f.type === DOCX_TYPE ? "docx" : "md", name: f.name, size: f.size, created_at: iso(f.created_at)! };
    out.set(f.note_id, [...(out.get(f.note_id) ?? []), doc]);
  }
  return out;
}

async function present(rows: PostRow[]): Promise<TeamPost[]> {
  const done = [...new Set(rows.filter((r) => r.kind === "done" && r.note_id).map((r) => r.note_id!))];
  const [who, documents] = await Promise.all([whoFor([...new Set(rows.map((r) => r.assistant_id).filter((id): id is string => !!id))]), documentsFor(done).catch(() => new Map<string, DocumentFile[]>())]);
  return rows.map((r) => {
    const words = r.kind === "question" || r.kind === "handoff" ? parse<StageWords>(r.words) : null;
    return {
      id: Number(r.id),
      kind: r.kind,
      who: r.assistant_id ? (who.get(r.assistant_id) ?? null) : null,
      from: r.assistant_id ? "assistant" : r.kind === "said" ? "owner" : "ask",
      text: r.body,
      assignment_id: r.assignment_id,
      assignment_title: parse<{ title?: string }>(r.assignment)?.title ?? null,
      stage_id: r.stage_id,
      run_id: r.run_id,
      thread_id: r.thread_id,
      waits_for: r.waits_for,
      settled_at: iso(r.settled_at),
      ...(r.kind === "question" && words ? { questions: words.questions ?? [], answers: words.answers ?? [] } : {}),
      ...(r.kind === "handoff" && words?.handoff ? { handoff: words.handoff } : {}),
      ...(r.kind === "done" ? { documents: r.note_id ? (documents.get(r.note_id) ?? []) : [], note_id: r.note_id } : {}),
      created_at: iso(r.created_at)!,
    } satisfies TeamPost;
  });
}

// ---------- posting ----------

/**
 * One post. The owner's own (`said`) has no assistant; neither has Ask's. A
 * post that waits on the same run or stage as one already waiting isn't made
 * twice: the first one comes back.
 */
export async function postToTeam(input: PostInput): Promise<TeamPost> {
  if (!POST_KINDS.includes(input.kind)) throw new AthenaInputError("kind: not a kind of post");
  const text = typeof input.text === "string" ? input.text.trim().slice(0, MAX_POST) : "";
  if (!text) throw new AthenaInputError("text: say something");
  const waits = input.waits_for ?? null;
  if (waits !== null && !WAITS.includes(waits)) throw new AthenaInputError("waits_for: go, answer, approval or dismiss");
  const assistant = input.kind === "said" ? null : uuid(input.assistant_id, "assistant_id");
  const assignment = uuid(input.assignment_id, "assignment_id");
  const stage = uuid(input.stage_id, "stage_id");
  const run = uuid(input.run_id, "run_id");
  const thread = uuid(input.thread_id, "thread_id");
  if (waits && (run || stage)) {
    const [same] = await qRaw<{ id: string }>(
      `SELECT id FROM team_posts WHERE kind = $1 AND waits_for = $2 AND settled_at IS NULL AND run_id IS NOT DISTINCT FROM $3::uuid AND stage_id IS NOT DISTINCT FROM $4::uuid ORDER BY id LIMIT 1`,
      [input.kind, waits, run, stage],
    );
    if (same) return (await getPost(Number(same.id)))!;
  }
  const [row] = await qRaw<{ id: string }>(
    `INSERT INTO team_posts (assistant_id, assignment_id, stage_id, run_id, kind, body, waits_for, thread_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid) RETURNING id`,
    [assistant, assignment, stage, run, input.kind, sealText(text), waits, thread],
  );
  return (await getPost(Number(row.id)))!;
}

export async function getPost(id: number): Promise<TeamPost | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [post] = await present(await q<PostRow>(`${SELECT} WHERE p.id = $1::bigint`, [id]));
  return post ?? null;
}

/**
 * A standing assistant's run, said in the channel: its plan (waits for Go),
 * what it did, or that it didn't finish (waits to be dismissed). A quiet run isn't passed here. A
 * stage's run is the runner's to post, so it's left alone. Never throws: a
 * run isn't failed by its post.
 */
export async function postRun(run: { id: string; assistant_id: string }, outcome: { kind: "plan" | "update" | "failed"; text: string }): Promise<TeamPost | null> {
  try {
    const [row] = await qRaw<{ stage_id: string | null }>(`SELECT stage_id FROM team_runs WHERE id = $1::uuid`, [run.id]);
    if (!row || row.stage_id) return null;
    return await postToTeam({ kind: outcome.kind, text: outcome.text, assistant_id: run.assistant_id, run_id: run.id, waits_for: outcome.kind === "plan" ? "go" : outcome.kind === "failed" ? "dismiss" : null });
  } catch (error) {
    console.warn("Athena team chat: couldn't post a run", error instanceof Error ? error.message.slice(0, 160) : error);
    return null;
  }
}

/** The post a run made, newest first: where its card and push open. Null when it made none. */
export async function postIdForRun(runId: string): Promise<number | null> {
  if (!UUID.test(runId)) return null;
  const [row] = await qRaw<{ id: string }>(`SELECT id FROM team_posts WHERE run_id = $1::uuid ORDER BY id DESC LIMIT 1`, [runId]);
  return row ? Number(row.id) : null;
}

// ---------- settling ----------

/**
 * A Go, an answer or an approval landed: the posts that waited on it are
 * settled, everywhere at once. Each key given narrows it (a stage of an
 * assignment); one is needed. A run that didn't finish stays until it's
 * dismissed (dismissPost); `failed` settles a stage's failed post instead
 * (Go tried the stage again). Answers how many it settled.
 */
export async function settlePosts(keys: { run_id?: string | null; stage_id?: string | null; assignment_id?: string | null; failed?: boolean }, now = new Date()): Promise<number> {
  const run = uuid(keys.run_id, "run_id");
  const stage = uuid(keys.stage_id, "stage_id");
  const assignment = uuid(keys.assignment_id, "assignment_id");
  if (!run && !stage && !assignment) throw new AthenaInputError("Say which run, stage or assignment");
  if (keys.failed && !stage) throw new AthenaInputError("Say which stage");
  const rows = await qRaw<{ id: string }>(
    `UPDATE team_posts SET settled_at = $4 WHERE waits_for = ANY($5::text[]) AND settled_at IS NULL
        AND ($1::uuid IS NULL OR run_id = $1::uuid) AND ($2::uuid IS NULL OR stage_id = $2::uuid) AND ($3::uuid IS NULL OR assignment_id = $3::uuid) RETURNING id`,
    [run, stage, assignment, now.toISOString(), keys.failed ? ["dismiss"] : ["go", "answer", "approval"]],
  );
  return rows.length;
}

// The conversation a post's plan lives in: its own (an "@Name" reply), or its run's.
const POST_THREAD = `COALESCE(p.thread_id, (SELECT r.thread_id FROM team_runs r WHERE r.id = p.run_id))`;
// A post that waits for Go, whose conversation has a plan that ran and none left to run.
const PLAN_RAN = `p.waits_for = 'go' AND p.settled_at IS NULL
   AND EXISTS (SELECT 1 FROM ask_plans d WHERE d.thread_id = ${POST_THREAD} AND d.ran_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM ask_plans o WHERE o.thread_id = ${POST_THREAD} AND o.ran_at IS NULL)`;

/** Go ran a plan (lib/ask-plans.ts goPlan): its run's or its reply's post is settled. A plan with no post settles nothing. */
export async function settlePlanPosts(planId: unknown, now = new Date()): Promise<number> {
  if (typeof planId !== "string" || !UUID.test(planId)) return 0;
  const rows = await qRaw<{ id: string }>(
    `UPDATE team_posts p SET settled_at = $2 FROM ask_plans g WHERE g.id = $1::uuid AND g.ran_at IS NOT NULL AND ${POST_THREAD} = g.thread_id AND ${PLAN_RAN} RETURNING p.id`,
    [planId, now.toISOString()],
  );
  return rows.length;
}

/** The same for every plan's post, before the channel is read: a Go that didn't come through settlePlanPosts still counts. */
async function settleRanPlans(now: Date): Promise<void> {
  await qRaw(`UPDATE team_posts p SET settled_at = $1 WHERE ${PLAN_RAN}`, [now.toISOString()]);
}

/**
 * The owner dismissed a run that didn't finish: its post is settled and
 * leaves the strip. Only a post that waits to be dismissed: any other comes
 * back untouched (the route answers 409), and one already dismissed comes
 * back as it is. Null: no such post.
 */
export async function dismissPost(id: number, now = new Date()): Promise<TeamPost | null> {
  const post = await getPost(id);
  if (!post) return null;
  if (post.waits_for !== "dismiss" || post.settled_at) return post;
  await qRaw(`UPDATE team_posts SET settled_at = $2 WHERE id = $1::bigint AND waits_for = 'dismiss' AND settled_at IS NULL`, [id, now.toISOString()]);
  return getPost(id);
}

// ---------- reading ----------

const WAITING = `p.waits_for IS NOT NULL AND p.settled_at IS NULL`;

/** What waits for you: one per post that waits (a plan, a question, an approval, a run that didn't finish). Always the length of `listChat().waiting`. */
export async function countWaiting(now = new Date()): Promise<number> {
  await settleRanPlans(now);
  const [row] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM team_posts p WHERE ${WAITING} LIMIT $1) w`, [WAITING_MAX]);
  return row?.n ?? 0;
}

/**
 * The channel: a page of posts, oldest first, ending just before `before`
 * (the newest page without it), and everything that waits, oldest first.
 * `before` in the answer is the id to ask with for the page above, or null
 * at the start of the channel.
 */
export async function listChat(opts: { before?: number | null; limit?: number | null } = {}, now = new Date()): Promise<TeamChat> {
  const limit = Math.min(CHAT_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? CHAT_PAGE) || CHAT_PAGE));
  const before = opts.before != null && Number.isSafeInteger(opts.before) && opts.before > 0 ? opts.before : null;
  await settleRanPlans(now);
  const [page, waiting] = await Promise.all([
    q<PostRow>(`${SELECT} WHERE ($1::bigint IS NULL OR p.id < $1::bigint) ORDER BY p.id DESC LIMIT $2`, [before, limit + 1]),
    q<PostRow>(`${SELECT} WHERE ${WAITING} ORDER BY p.id LIMIT $1`, [WAITING_MAX]),
  ]);
  const more = page.length > limit;
  const rows = page.slice(0, limit).reverse();
  const posts = await present([...rows, ...waiting]);
  return { posts: posts.slice(0, rows.length), waiting: posts.slice(rows.length), before: more && rows.length ? Number(rows[0].id) : null };
}

// ---------- the sweep ----------

/**
 * Posts outside an assignment are kept ASSIGNMENT_LIMITS.postDays days; an
 * assignment's go with it (cascade). One that still waits is kept until it's
 * settled. Answers how many went.
 */
export async function sweepPosts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ASSIGNMENT_LIMITS.postDays * 86_400_000).toISOString();
  const rows = await qRaw<{ id: string }>(`DELETE FROM team_posts p WHERE p.assignment_id IS NULL AND p.created_at < $1 AND NOT (${WAITING}) RETURNING p.id`, [cutoff]);
  return rows.length;
}
