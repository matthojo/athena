/**
 * Where nudges Athena starts are kept (migration 0051): the `nudges` rows
 * (payload sealed under the data key), the `nudge_mutes` "Fewer like this"
 * rows, and the switches in the `settings` row `proactive`.
 */
import { AthenaInputError, q, qRaw } from "../db";
import { sealText } from "../data-box";
import { DEFAULT_PROACTIVE, PROACTIVE_KEY, mergeProactive, readProactive, type ProactivePrefs } from "./gate";
import { RULE_IDS, type Nudge, type RuleId } from "./types";

/** "Fewer like this" lasts a month; the rule's switch in Settings stays as it was. */
export const MUTE_DAYS = 30;

export interface StoredNudge extends Nudge {
  id: string;
  created_at: string;
  pushed_at: string | null;
  opened_at: string | null;
  dismissed_at: string | null;
  applied: number[];
}

interface Row {
  id: string;
  rule: RuleId;
  key: string;
  payload: string;
  created_at: string;
  expires_at: string;
  pushed_at: string | null;
  opened_at: string | null;
  dismissed_at: string | null;
  applied: number[];
}

const COLUMNS = `id, rule, key, payload, created_at, expires_at, pushed_at, opened_at, dismissed_at, applied`;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function present(r: Row): StoredNudge | null {
  let p: Omit<Nudge, "rule" | "key" | "expires_at">;
  try {
    p = JSON.parse(r.payload);
  } catch {
    return null; // sealed under a key this deploy doesn't have
  }
  return {
    id: r.id,
    rule: r.rule,
    key: r.key,
    title: p.title,
    body: p.body,
    why: p.why ?? [],
    context: p.context ?? "",
    prompt: p.prompt ?? "",
    about: p.about ?? [],
    actions: p.actions ?? [],
    ...(p.thread_id ? { thread_id: p.thread_id } : {}),
    ...(p.url ? { url: p.url } : {}),
    // A Team run's card: who it's from, for its avatar (docs/team.md, Nudges).
    ...(p.assistant ? { assistant: p.assistant } : {}),
    expires_at: iso(r.expires_at)!,
    created_at: iso(r.created_at)!,
    pushed_at: iso(r.pushed_at),
    opened_at: iso(r.opened_at),
    dismissed_at: iso(r.dismissed_at),
    applied: Array.isArray(r.applied) ? r.applied : [],
  };
}

// ---------- switches ----------

export async function loadProactivePrefs(): Promise<ProactivePrefs> {
  try {
    const [row] = await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [PROACTIVE_KEY]);
    return readProactive(row?.value);
  } catch {
    return readProactive(null);
  }
}

export async function saveProactivePrefs(patch: unknown): Promise<ProactivePrefs> {
  let next: ProactivePrefs;
  try {
    next = mergeProactive(await loadProactivePrefs(), patch);
  } catch (error) {
    throw new AthenaInputError((error as Error).message);
  }
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PROACTIVE_KEY, JSON.stringify(next)],
  );
  return next;
}

export { DEFAULT_PROACTIVE };

// ---------- mutes ----------

export async function loadMutes(): Promise<Map<RuleId, string>> {
  const rows = await qRaw<{ rule: RuleId; muted_until: string }>(`SELECT rule, muted_until FROM nudge_mutes WHERE muted_until > now()`);
  return new Map(rows.map((r) => [r.rule, iso(r.muted_until)!]));
}

export const isRule = (v: unknown): v is RuleId => typeof v === "string" && (RULE_IDS as readonly string[]).includes(v);

/** "Fewer like this": the rule says nothing for MUTE_DAYS. */
export async function muteRule(rule: unknown, now = new Date()): Promise<{ rule: RuleId; muted_until: string }> {
  if (!isRule(rule)) throw new AthenaInputError(`rule: one of ${RULE_IDS.join(", ")}`);
  const until = new Date(now.getTime() + MUTE_DAYS * 86_400_000).toISOString();
  await qRaw(`INSERT INTO nudge_mutes (rule, muted_until) VALUES ($1, $2) ON CONFLICT (rule) DO UPDATE SET muted_until = EXCLUDED.muted_until, created_at = now()`, [rule, until]);
  return { rule, muted_until: until };
}

export async function unmuteRule(rule: unknown): Promise<void> {
  if (!isRule(rule)) throw new AthenaInputError(`rule: one of ${RULE_IDS.join(", ")}`);
  await qRaw(`DELETE FROM nudge_mutes WHERE rule = $1`, [rule]);
}

// ---------- nudges ----------

/** Keys among these that were nudged before. */
export async function seenKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await qRaw<{ key: string }>(`SELECT key FROM nudges WHERE key = ANY($1::text[])`, [keys]);
  return new Set(rows.map((r) => r.key));
}

export async function madeOn(day: string): Promise<number> {
  const [row] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM nudges WHERE local_day = $1::date`, [day]);
  return row?.n ?? 0;
}

/** What the owner closed: a dismissed awaiting-reply nudge closes its thread. */
export async function closedKeys(): Promise<Set<string>> {
  const rows = await qRaw<{ key: string }>(`SELECT key FROM nudges WHERE dismissed_at IS NOT NULL AND rule = 'awaiting_reply' AND created_at > now() - interval '60 days'`);
  return new Set(rows.map((r) => `thread:${r.key.split(":")[1]}`));
}

/** Keep a nudge; null when its key was taken already (another run got there first). */
export async function recordNudge(n: Nudge, day: string, now = new Date()): Promise<StoredNudge | null> {
  const { rule, key, expires_at, ...rest } = n;
  const [row] = await q<Row>(
    `INSERT INTO nudges (rule, key, payload, local_day, expires_at, created_at) VALUES ($1, $2, $3, $4::date, $5, $6)
     ON CONFLICT (key) DO NOTHING RETURNING ${COLUMNS}`,
    [rule, key, sealText(JSON.stringify(rest)), day, expires_at, now.toISOString()],
  );
  return row ? present(row) : null;
}

/** Close the live nudges whose key starts with this (a car's MOT renewed, a vehicle taken off: lib/car-sync.ts). */
export async function closeNudgesLike(prefix: string, now = new Date()): Promise<void> {
  const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
  await qRaw(`UPDATE nudges SET dismissed_at = $2 WHERE dismissed_at IS NULL AND key LIKE $1`, [like, now.toISOString()]);
}

export async function markPushed(id: string): Promise<void> {
  await qRaw(`UPDATE nudges SET pushed_at = now() WHERE id = $1::uuid`, [id]);
}

/** Cards for Home: not dismissed, not expired, from the last two days. */
export async function listLiveNudges(now = new Date()): Promise<StoredNudge[]> {
  const rows = await q<Row>(
    `SELECT ${COLUMNS} FROM nudges WHERE dismissed_at IS NULL AND expires_at > $1 AND created_at > $1::timestamptz - interval '2 days' ORDER BY created_at DESC LIMIT 12`,
    [now.toISOString()],
  );
  return rows.map(present).filter((n): n is StoredNudge => !!n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One nudge, for a push opening Ask. Marks it opened. */
export async function openNudge(id: string): Promise<StoredNudge | null> {
  if (!UUID.test(id)) return null;
  const [row] = await q<Row>(`UPDATE nudges SET opened_at = COALESCE(opened_at, now()) WHERE id = $1::uuid RETURNING ${COLUMNS}`, [id]);
  return row ? present(row) : null;
}

/** One nudge, as stored, without marking it opened. */
export async function nudgeById(id: string): Promise<StoredNudge | null> {
  if (!UUID.test(id)) return null;
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM nudges WHERE id = $1::uuid`, [id]);
  return row ? present(row) : null;
}

export async function dismissNudge(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await qRaw<{ id: string }>(`UPDATE nudges SET dismissed_at = COALESCE(dismissed_at, now()) WHERE id = $1::uuid RETURNING id`, [id]);
  return rows.length > 0;
}

/** Note that action `index` was applied (or put back, `on` false). */
export async function markApplied(id: string, index: unknown, on = true): Promise<number[]> {
  if (!UUID.test(id)) throw new AthenaInputError("No such nudge");
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 20) throw new AthenaInputError("index: which action, from 0");
  const [row] = await qRaw<{ applied: number[] }>(
    on
      ? `UPDATE nudges SET applied = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(applied || to_jsonb($2::int)) x) WHERE id = $1::uuid RETURNING applied`
      : `UPDATE nudges SET applied = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(applied) x WHERE x <> to_jsonb($2::int)), '[]'::jsonb) WHERE id = $1::uuid RETURNING applied`,
    [id, index],
  );
  if (!row) throw new AthenaInputError("No such nudge");
  return row.applied;
}

/** Today's day plan, if one was made: the morning briefing carries it (lib/proactive/briefing.ts). */
export async function dayPlanFor(day: string): Promise<StoredNudge | null> {
  const [row] = await q<Row>(`SELECT ${COLUMNS} FROM nudges WHERE rule = 'day_plan' AND local_day = $1::date AND dismissed_at IS NULL LIMIT 1`, [day]);
  return row ? present(row) : null;
}
