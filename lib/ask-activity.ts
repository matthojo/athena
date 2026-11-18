/**
 * What Ask did (migration 0055, `ask_activity`): one row per change Ask
 * made, newest first, under Settings → Ask. Ask's replies, a plan's Go, a
 * routine's plan (Go'd by the owner) and a nudge card's parts all write here,
 * so the log is one store and nothing scans conversations to build it.
 *
 * Each row keeps the receipt as the reply showed it (what it is, what
 * happened, where Open goes, the Undo op) sealed in `payload`, plus its
 * state: done, undone, or undo_failed when Undo was refused because what it
 * changed has moved on. Undo here is the same applyUndo as a reply's Undo
 * (lib/assistant.ts); a reply's Undo sends the row's id along, so the log
 * and the conversation agree.
 */
import { AthenaInputError, q, qRaw } from "./db";
import { sealText } from "./data-box";
import type { Change } from "./assistant";
import type { NudgeAction } from "./proactive/types";

export const ACTIVITY_SOURCES = ["ask", "plan", "routine", "nudge", "team"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];
export type ActivityState = "done" | "undone" | "undo_failed";

/** Where a change came from: which conversation, plan, routine or nudge. */
export interface ActivityContext {
  source: ActivitySource;
  thread_id?: string | null;
  plan_id?: string | null;
  routine_id?: string | null;
  nudge_id?: string | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  source: ActivitySource;
  thread_id: string | null;
  plan_id: string | null;
  routine_id: string | null;
  nudge_id: string | null;
  state: ActivityState;
  state_at: string | null;
  change: Change;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOrNull = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);

/** The receipt as it's kept: the change without its own activity id. Pure. */
export function activityPayload(change: Change): string {
  const { activity_id: _id, ...kept } = change;
  return JSON.stringify(kept);
}

/** The row's columns for one change. Pure, so a test can check every source's rows without a database. */
export function activityRow(change: Change, ctx: ActivityContext): { source: ActivitySource; thread_id: string | null; plan_id: string | null; routine_id: string | null; nudge_id: string | null; payload: string } {
  if (!(ACTIVITY_SOURCES as readonly string[]).includes(ctx.source)) throw new Error(`source: one of ${ACTIVITY_SOURCES.join(", ")}`);
  return {
    source: ctx.source,
    thread_id: idOrNull(ctx.thread_id),
    plan_id: idOrNull(ctx.plan_id),
    routine_id: idOrNull(ctx.routine_id),
    nudge_id: idOrNull(ctx.nudge_id),
    payload: activityPayload(change),
  };
}

/**
 * Keep these changes in the log, in order, and hand them back each with its
 * row's id (`activity_id`), which a reply's Undo sends back. A change already
 * logged keeps its id and isn't written twice. If the log can't be written the
 * changes still come back (without ids): the change itself has happened.
 */
export async function logChanges(changes: Change[], ctx: ActivityContext): Promise<Change[]> {
  const out: Change[] = [];
  for (const c of changes) {
    if (c.activity_id) {
      out.push(c);
      continue;
    }
    try {
      const r = activityRow(c, ctx);
      const [row] = await qRaw<{ id: string }>(
        `INSERT INTO ask_activity (source, thread_id, plan_id, routine_id, nudge_id, payload) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [r.source, r.thread_id, r.plan_id, r.routine_id, r.nudge_id, sealText(r.payload)],
      );
      out.push({ ...c, activity_id: row.id });
    } catch (error) {
      console.error("Athena activity: couldn't keep a change in the log", (error as Error).message?.slice(0, 160));
      out.push(c);
    }
  }
  return out;
}

interface Row {
  id: string;
  created_at: string | Date;
  source: ActivitySource;
  thread_id: string | null;
  plan_id: string | null;
  routine_id: string | null;
  nudge_id: string | null;
  state: ActivityState;
  state_at: string | Date | null;
  payload: string;
}

const COLUMNS = `id, created_at, source, thread_id, plan_id, routine_id, nudge_id, state, state_at, payload`;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

/** A row as the app reads it; null when its receipt can't be opened (sealed under a key this deploy doesn't have). */
export function presentActivity(r: Row): ActivityEntry | null {
  let change: Change;
  try {
    change = JSON.parse(r.payload) as Change;
  } catch {
    return null;
  }
  return {
    id: r.id,
    at: iso(r.created_at)!,
    source: r.source,
    thread_id: r.thread_id,
    plan_id: r.plan_id,
    routine_id: r.routine_id,
    nudge_id: r.nudge_id,
    state: r.state,
    state_at: iso(r.state_at),
    change: { ...change, activity_id: r.id },
  };
}

/** Newest first; `before` (an ISO time) pages back. */
export async function listActivity(opts: { limit?: number; before?: string | null } = {}): Promise<ActivityEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? new Date(opts.before).toISOString() : null;
  const rows = await q<Row>(
    `SELECT ${COLUMNS} FROM ask_activity ${before ? "WHERE created_at < $2::timestamptz" : ""} ORDER BY created_at DESC, id DESC LIMIT $1`,
    before ? [limit, before] : [limit],
  );
  return rows.map(presentActivity).filter((e): e is ActivityEntry => !!e);
}

export async function getActivity(id: unknown): Promise<ActivityEntry | null> {
  const key = idOrNull(id);
  if (!key) return null;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM ask_activity WHERE id = $1::uuid`, [key]);
  return row ? presentActivity(row) : null;
}

/** Record how an Undo went. Unknown ids are ignored: an older reply's change was never logged. */
export async function markActivity(id: unknown, state: ActivityState): Promise<void> {
  const key = idOrNull(id);
  if (!key) return;
  await qRaw(`UPDATE ask_activity SET state = $2, state_at = now() WHERE id = $1::uuid`, [key, state]);
}

/** A refusal (what it changed has moved on, or the op is one Athena can't take back) rather than a fault worth retrying. */
export const isRefusal = (error: unknown): boolean => error instanceof AthenaInputError || (error instanceof Error && error.name === "ZodError");

/**
 * Undo one logged change with the same undo a reply uses, and record how it
 * went. A refusal is kept as undo_failed (couldn't undo) and thrown on; any
 * other error leaves the row as it was, so the owner can try again.
 */
export async function undoActivity(id: unknown, undo: (op: unknown) => Promise<void>): Promise<ActivityEntry> {
  const entry = await getActivity(id);
  if (!entry) throw new AthenaInputError("Athena has no record of that change", 404);
  if (entry.state === "undone") return entry;
  if (!entry.change.undo) throw new AthenaInputError("That one can't be undone from here");
  try {
    await undo(entry.change.undo);
  } catch (error) {
    if (isRefusal(error)) await markActivity(entry.id, "undo_failed");
    throw error;
  }
  await markActivity(entry.id, "undone");
  return { ...entry, state: "undone", state_at: new Date().toISOString() };
}

/**
 * A nudge card's part, applied from Home (a move, a to-do given a day), as a
 * change for the log. Its words come from the nudge Athena made, not the app;
 * only the Undo op is the app's, the same one it would send to undo it.
 */
export function nudgeActionChange(action: NudgeAction, undo: unknown): Change {
  const title = action.title;
  const detail = action.label;
  // A move's Undo is the move's own (it knows where the event was); a to-do's puts its old day back.
  const move = undo && typeof undo === "object" && (undo as { op?: unknown }).op === "move_event" ? (undo as Change["undo"]) : null;
  return action.kind === "move"
    ? { kind: "event", id: action.event_id, action: "updated", title, detail, label: `${title}: ${detail}`, open: null, undo: move }
    : { kind: "commitment", id: action.commitment_id, action: "updated", title, detail, label: `${title}: ${detail}`, open: { kind: "commitment", id: action.commitment_id }, undo: { op: "set_due", id: action.commitment_id, due_on: action.was } };
}

/** A nudge's part put back from its card: its log row is undone too. */
export async function markNudgePartUndone(nudgeId: string, entityId: string): Promise<void> {
  const rows = await q<Row>(`SELECT ${COLUMNS} FROM ask_activity WHERE nudge_id = $1::uuid AND state = 'done' ORDER BY created_at DESC`, [nudgeId]);
  const hit = rows.map(presentActivity).find((e) => e?.change.id === entityId);
  if (hit) await markActivity(hit.id, "undone");
}
