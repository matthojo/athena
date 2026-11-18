/**
 * To-do contexts on the server: the owner's list (Settings → To do), the
 * corrections Athena remembers, and `autoContext`, which every path where
 * Athena files a to-do itself goes through (lib/memory.ts upsertCommitment
 * calls it on create). The rules are in lib/todo-context.ts.
 *
 * Names are readable labels (SECURITY.md §11 "What stays readable"), so
 * uniqueness is a database index. Removing a context archives it; to-dos
 * read an archived context as blank (lib/memory.ts COMMITMENT_SELECT), and
 * restoring it brings them back.
 */

import { AthenaInputError, q, tx } from "./db";
import {
  CONTEXT_COLOURS,
  CONTEXT_ICONS,
  CONTEXT_KINDS,
  CONTEXT_LIMITS,
  chooseContext,
  cleanContextName,
  contextByName,
  hintKey,
  type ContextChoice,
  type ContextKind,
  type ContextSignals,
  type TodoContext,
} from "./todo-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT = `SELECT id, kind, key, name, icon, colour, position, archived_at, created_at, updated_at FROM todo_contexts`;

export async function listContexts(opts: { includeArchived?: boolean } = {}): Promise<TodoContext[]> {
  return q<TodoContext>(`${SELECT} WHERE ($1::boolean OR archived_at IS NULL) ORDER BY kind, position, created_at`, [opts.includeArchived ?? false]);
}

export interface ContextInput {
  kind?: ContextKind;
  name?: string;
  icon?: string;
  colour?: string;
  archived?: boolean;
}

function checkLook(input: ContextInput) {
  if (input.icon !== undefined && !(CONTEXT_ICONS as readonly string[]).includes(input.icon)) throw new AthenaInputError("Pick one of the icons shown");
  if (input.colour !== undefined && !(CONTEXT_COLOURS as readonly string[]).includes(input.colour)) throw new AthenaInputError("Pick one of the colours shown");
}

function nameOrThrow(raw: unknown): string {
  const r = cleanContextName(raw);
  if ("error" in r) throw new AthenaInputError(r.error);
  return r.name;
}

const kindWord = (k: ContextKind) => (k === "area" ? "an area" : "a where/how");

async function clashCheck(run: <T>(text: string, params?: unknown[]) => Promise<T[]>, kind: ContextKind, name: string, exceptId?: string) {
  const [clash] = await run<{ name: string }>(
    `SELECT name FROM todo_contexts WHERE kind = $1 AND lower(name) = lower($2) AND archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [kind, name, exceptId ?? null],
  );
  if (clash) throw new AthenaInputError(`You already have ${kindWord(kind)} called “${clash.name}”.`);
}

export async function createContext(input: ContextInput): Promise<TodoContext> {
  if (!input.kind || !CONTEXT_KINDS.includes(input.kind)) throw new AthenaInputError("kind: area or where");
  const kind = input.kind;
  const name = nameOrThrow(input.name);
  checkLook(input);
  return tx(async (run) => {
    await run(`SELECT pg_advisory_xact_lock(hashtext('athena:todo_contexts'))`);
    await clashCheck(run, kind, name);
    const [{ n }] = await run<{ n: number }>(`SELECT count(*)::int AS n FROM todo_contexts WHERE kind = $1 AND archived_at IS NULL`, [kind]);
    if (n >= CONTEXT_LIMITS.perKind) throw new AthenaInputError(`That's ${CONTEXT_LIMITS.perKind} already. Remove one first.`);
    const [row] = await run<TodoContext>(
      `INSERT INTO todo_contexts (kind, name, icon, colour, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position) + 1, 0) FROM todo_contexts WHERE kind = $1 AND archived_at IS NULL))
       RETURNING id, kind, key, name, icon, colour, position, archived_at, created_at, updated_at`,
      [kind, name, input.icon ?? "tag", input.colour ?? "grey"],
    );
    return row;
  });
}

/** Rename, change the look, remove (archived: true) or bring back (archived: false). */
export async function updateContext(id: string, input: ContextInput): Promise<TodoContext> {
  if (!UUID.test(id)) throw new AthenaInputError("Not found", 404);
  checkLook(input);
  const name = input.name === undefined ? undefined : nameOrThrow(input.name);
  return tx(async (run) => {
    await run(`SELECT pg_advisory_xact_lock(hashtext('athena:todo_contexts'))`);
    const [cur] = await run<TodoContext>(`${SELECT} WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur) throw new AthenaInputError("Not found", 404);
    const restoring = input.archived === false && cur.archived_at;
    if (name !== undefined || restoring) await clashCheck(run, cur.kind, name ?? cur.name, id);
    const [row] = await run<TodoContext>(
      `UPDATE todo_contexts SET
         name = COALESCE($2, name),
         icon = COALESCE($3, icon),
         colour = COALESCE($4, colour),
         archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END,
         updated_at = now()
       WHERE id = $1
       RETURNING id, kind, key, name, icon, colour, position, archived_at, created_at, updated_at`,
      [id, name ?? null, input.icon ?? null, input.colour ?? null, input.archived ?? null],
    );
    return row;
  });
}

/** Put one kind's live contexts in this order. */
export async function reorderContexts(kind: ContextKind, ids: string[]): Promise<TodoContext[]> {
  if (!CONTEXT_KINDS.includes(kind)) throw new AthenaInputError("kind: area or where");
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !UUID.test(x))) throw new AthenaInputError("ids: a list of context ids");
  await tx(async (run) => {
    const live = await run<{ id: string }>(`SELECT id FROM todo_contexts WHERE kind = $1 AND archived_at IS NULL`, [kind]);
    const known = new Set(live.map((r) => r.id));
    if (ids.length !== known.size || ids.some((x) => !known.has(x))) throw new AthenaInputError("Send every live context of that kind, once each");
    await run(`UPDATE todo_contexts t SET position = o.i - 1, updated_at = now() FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, i) WHERE t.id = o.id`, [ids]);
  });
  return listContexts();
}

/** How many open to-dos each live context is on (Settings shows it; the remove confirm names it). */
export async function contextCounts(): Promise<Record<string, number>> {
  const rows = await q<{ id: string; n: number }>(
    `SELECT x.id, count(*)::int AS n FROM commitments c
       CROSS JOIN LATERAL (VALUES (c.area_id), (c.where_id)) AS x(id)
     WHERE x.id IS NOT NULL AND c.archived_at IS NULL AND c.status = 'open' AND c.kind <> 'decision'
     GROUP BY x.id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.n]));
}

/** Throws unless each id is a live context of its kind. Null and undefined pass. */
export async function checkContextIds(ids: { area_id?: string | null; where_id?: string | null }): Promise<void> {
  const wanted = (["area", "where"] as const).flatMap((k) => {
    const id = k === "area" ? ids.area_id : ids.where_id;
    return id ? [{ k, id }] : [];
  });
  if (!wanted.length) return;
  for (const w of wanted) if (!UUID.test(w.id)) throw new AthenaInputError(`Invalid '${w.k}_id'`);
  const rows = await q<{ id: string; kind: ContextKind }>(`SELECT id, kind FROM todo_contexts WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`, [wanted.map((w) => w.id)]);
  for (const w of wanted) {
    if (!rows.some((r) => r.id === w.id && r.kind === w.k)) throw new AthenaInputError(w.k === "area" ? "That area isn't one of yours" : "That where/how isn't one of yours");
  }
}

// ---------- corrections ----------

/** Remember the owner's choice for the sender or source this to-do came from. Owner-made to-dos are skipped. */
export async function rememberCorrection(t: { source: string | null; person_id: string | null; area_id: string | null; where_id: string | null }): Promise<void> {
  const key = hintKey(t);
  if (!key) return;
  await q(
    `INSERT INTO todo_context_hints (key, area_id, where_id) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET area_id = EXCLUDED.area_id, where_id = EXCLUDED.where_id, updated_at = now()`,
    [key.slice(0, 207), t.area_id, t.where_id],
  );
}

async function hintFor(t: { source?: string | null; person_id?: string | null }): Promise<{ area_id: string | null; where_id: string | null } | null> {
  const key = hintKey(t);
  if (!key) return null;
  const [row] = await q<{ area_id: string | null; where_id: string | null }>(`SELECT area_id, where_id FROM todo_context_hints WHERE key = $1`, [key]);
  return row ?? null;
}

// ---------- Athena filing a to-do ----------

export interface AutoContextInput {
  title: string;
  notes?: string | null;
  source?: string | null;
  person_id?: string | null;
  /** The collection's label, when the writer knows it. */
  label?: string | null;
  /** Names the owner said (Ask: "add buy milk to errands"): used as given when they name a live context. */
  given?: { area?: string | null; where?: string | null } | null;
  /** The model's guess, as names; used only when `sure`. */
  suggestion?: { area?: string | null; where?: string | null; sure?: boolean } | null;
}

/**
 * The context for a to-do Athena files itself. Each side is the owner's
 * stated name, else the rules (lib/todo-context.ts chooseContext). Never
 * throws for an unknown name: it just stays blank.
 */
export async function autoContext(input: AutoContextInput): Promise<ContextChoice> {
  const [contexts, hint] = await Promise.all([listContexts(), hintFor(input)]);
  const signals: ContextSignals = { title: input.title, notes: input.notes, source: input.source, label: input.label, suggestion: input.suggestion, hint };
  const chosen = chooseContext(signals, contexts);
  const givenArea = contextByName(input.given?.area, contexts, "area");
  const givenWhere = contextByName(input.given?.where, contexts, "where");
  return {
    area_id: givenArea?.id ?? chosen.area_id,
    where_id: givenWhere?.id ?? chosen.where_id,
    why: { ...chosen.why, ...(givenArea ? { area: "asked" as const } : {}), ...(givenWhere ? { where: "asked" as const } : {}) },
  };
}
