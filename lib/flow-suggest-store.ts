/**
 * What flow suggestions read and keep (lib/flow-suggest.ts).
 *
 * Reads, all bounded by time: collected deliveries, bookings, appointments,
 * deadlines and renewals (team_events, kept 7 days, and purchases for 30),
 * reminders and the owner's own to-dos (8 weeks), What Ask did (30 days) and
 * saved items (60 days). Nothing is written but a dismissal: migration 0082
 * keeps the suggestion's id, which names the kind of habit and, for one built
 * on the owner's words, a short hash of them (never the words).
 *
 * Flows the owner already has come through a port (FlowReader), so this
 * slice doesn't import the engine; netlify/functions/api.ts wires it.
 */
import { q, qRaw } from "./db";
import { presentActivity } from "./ask-activity";
import { filedToOf } from "./saved";
import { FOLLOW_KINDS, REPEAT_DAYS, SAVED_DAYS, type AskChange, type CollectedItem, type OwnerReminder, type OwnerTodo, type SavedFiling, type SuggestSignals } from "./flow-suggest";
import type { ExistingFlow } from "./flow-suggest-check";

/** How suggestions read the owner's flows. The engine implements it once merged. */
export interface FlowReader {
  /** Every flow, on or off: a paused flow still counts as "already a flow". */
  list(): Promise<ExistingFlow[]>;
}

/** Until the engine is wired: no flows. */
export const NO_FLOWS: FlowReader = { list: async () => [] };

const PURCHASE_DAYS = 30;
const EVENT_DAYS = 7;
const ACTIVITY_DAYS = 30;
/** To-dos the owner made: by hand, in the app, through Ask, a Shortcut or the share sheet. A collection's own aren't habits. */
const OWNER_SOURCES = ["manual", "app", "assistant", "ask", "voice", "shortcut", "share-target"];

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const ago = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

/** One item per record, with every time it arrived or moved on. Pure. */
export function mergeCollected(rows: Array<{ id: string; kind: string; title: string; at: string }>): CollectedItem[] {
  const by = new Map<string, CollectedItem>();
  for (const r of rows) {
    const key = `${r.kind}:${r.id}`;
    const had = by.get(key);
    if (had) {
      if (!had.times.includes(r.at)) had.times.push(r.at);
      if (!had.title && r.title) had.title = r.title;
    } else by.set(key, { id: r.id, kind: r.kind, title: r.title, times: [r.at] });
  }
  return [...by.values()];
}

async function readCollected(now: Date): Promise<CollectedItem[]> {
  const kinds = Object.keys(FOLLOW_KINDS);
  const events = await qRaw<{ id: string | number; ref_id: string | null; kind: string; title: string | null; created_at: string | Date }>(
    `SELECT id, ref_id, facets->>'kind' AS kind, facets->>'title' AS title, created_at FROM team_events
      WHERE kind = 'collected' AND created_at >= $1 AND facets->>'kind' = ANY($2::text[])`,
    [ago(now, EVENT_DAYS), kinds],
  );
  // Purchases go back further than team_events: every order Athena saw this month, with when it was seen and when it last moved.
  const purchases = await q<{ id: string; retailer: string; items: string[] | null; created_at: string | Date; status_at: string | Date }>(
    `SELECT id, retailer, items, created_at, status_at FROM purchases WHERE created_at >= $1 OR status_at >= $1`,
    [ago(now, PURCHASE_DAYS)],
  );
  return mergeCollected([
    ...events.map((e) => ({ id: e.ref_id ?? `event:${e.id}`, kind: e.kind, title: e.title ?? "", at: iso(e.created_at)! })),
    ...purchases.flatMap((p) => {
      const title = [p.retailer, ...(p.items ?? [])].filter(Boolean).join(" ");
      return [iso(p.created_at)!, iso(p.status_at)!].map((at) => ({ id: p.id, kind: "delivery", title, at }));
    }),
  ]);
}

async function readReminders(now: Date): Promise<OwnerReminder[]> {
  const rows = await q<{ id: string; text: string; created_at: string | Date; remind_at: string | Date; repeat: string; done_at: string | Date | null }>(
    `SELECT id, text, created_at, remind_at, repeat, done_at FROM reminders
      WHERE created_at >= $1 OR (repeat <> 'none' AND done_at IS NULL)`,
    [ago(now, REPEAT_DAYS)],
  );
  return rows.map((r) => ({ id: r.id, text: r.text ?? "", created_at: iso(r.created_at)!, remind_at: iso(r.remind_at)!, repeat: r.repeat, done: r.done_at != null }));
}

async function readTodos(now: Date): Promise<OwnerTodo[]> {
  const rows = await q<{ id: string; title: string; created_at: string | Date; due_on: string | null }>(
    `SELECT id, title, created_at, to_char(due_on, 'YYYY-MM-DD') AS due_on FROM commitments
      WHERE created_at >= $1 AND kind IN ('todo', 'i_owe') AND status <> 'dropped' AND archived_at IS NULL
        AND (source IS NULL OR source = ANY($2::text[]))`,
    [ago(now, REPEAT_DAYS), OWNER_SOURCES],
  );
  return rows.map((r) => ({ id: r.id, title: r.title ?? "", created_at: iso(r.created_at)!, due_on: r.due_on }));
}

async function readActivity(now: Date): Promise<AskChange[]> {
  const rows = await q<Parameters<typeof presentActivity>[0]>(
    `SELECT id, created_at, source, thread_id, plan_id, routine_id, nudge_id, state, state_at, payload FROM ask_activity
      WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 500`,
    [ago(now, ACTIVITY_DAYS)],
  );
  return rows
    .map((r) => presentActivity(r))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => ({ at: e.at, state: e.state, change: { kind: e.change.kind, action: e.change.action, title: e.change.title ?? "", detail: e.change.detail ?? "" } }));
}

async function readSaved(now: Date): Promise<SavedFiling[]> {
  const rows = await q<{ id: string; thing: string | null; saved_at: string | Date; filed_at: string | Date | null; filed_to: string | null }>(
    `SELECT id, thing, saved_at, filed_at, filed_to FROM saved_items WHERE saved_at >= $1`,
    [ago(now, SAVED_DAYS)],
  );
  return rows.map((r) => ({ id: r.id, thing: r.thing, saved_at: iso(r.saved_at)!, filed_at: iso(r.filed_at), action: filedToOf(r.filed_to)?.action ?? null }));
}

/** Everything the detectors look at. A source that can't be read counts as empty: a suggestion is never worth an error. */
export async function readSignals(now = new Date()): Promise<SuggestSignals> {
  const safe = async <T>(what: string, read: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await read();
    } catch (error) {
      console.error(`Athena flow suggestions: couldn't read ${what}`, (error as Error)?.message?.slice(0, 120));
      return [];
    }
  };
  const [collected, reminders, todos, activity, saved] = await Promise.all([
    safe("collected items", () => readCollected(now)),
    safe("reminders", () => readReminders(now)),
    safe("to-dos", () => readTodos(now)),
    safe("What Ask did", () => readActivity(now)),
    safe("saved items", () => readSaved(now)),
  ]);
  const collectedDays: Record<string, number> = Object.fromEntries(Object.keys(FOLLOW_KINDS).map((k) => [k, k === "delivery" ? PURCHASE_DAYS : EVENT_DAYS]));
  return { collected, collectedDays, reminders, todos, activity, saved };
}

// ---------- dismissals (0082) ----------

export const SUGGESTION_ID = /^[a-z0-9_-]{3,80}$/;

export async function listDismissed(): Promise<Set<string>> {
  const rows = await qRaw<{ id: string }>(`SELECT id FROM flow_suggestion_dismissals`);
  return new Set(rows.map((r) => r.id));
}

/** Keep a dismissal for good. Saying it twice is fine. */
export async function dismissSuggestion(id: string): Promise<void> {
  if (!SUGGESTION_ID.test(id)) throw new Error("Not a suggestion id");
  await qRaw(`INSERT INTO flow_suggestion_dismissals (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [id]);
}
