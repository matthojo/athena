/**
 * Tracking's store (migration 0073, `trackers` and `tracker_points`; the rules are lib/trackers.ts, the contract
 * lib/tracker-types.ts). One row per tracker and one per check, kept forever, unchanged values too.
 *
 * Sealed (SECURITY.md §11, ENCRYPTED in lib/encryption.ts): a tracker's name, link, label, prefix, suffix, states
 * and target value; a check's value, where it was read and its page's link. Readable: kinds, directions, presets,
 * the currency code, times, and who set or checked.
 *
 *  - createTracker / updateTracker / removeTracker (Undo: restoreTracker). Several per thing, within
 *    TRACKER_LIMITS; the same preset or label twice on one thing is the one already there.
 *  - recordPoint: one check, exactly as read, with its page's link, and what was new about it (TrackerNews).
 *  - setTarget / clearTarget / restoreTarget: "tell me when".
 *  - keepSavePoint: a saved product's price when it was saved, as its price tracker's first check (lib/saved.ts
 *    calls it after a save). backfillSavePoints does it for items saved before 0073; reading a tracker runs it.
 *  - pricesNow: the best price now for a page of Saved's list.
 *
 * Who checked comes from the turn, never from the model: a Team assistant's turn runs inside `asTrackerChecker`
 * (netlify/lib/team-deps.ts and the chat route), so record_value knows which assistant it is.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { q, qRaw, sealer } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { underOwnersGo } from "./run-links";
import type { SavedItem } from "./saved-rules";
import {
  byTime,
  cleanCurrency,
  cleanNumber,
  cleanSource,
  cleanTarget,
  cleanUrl,
  cleanValue,
  MAX_POINTS_SHOWN,
  newsFor,
  planTracker,
  runUrlOf,
  plainLine,
  priceNowOf,
  TRACKER_LIMITS,
  TrackerInputError,
  trackerView,
  cleanAffix,
  cleanLabel,
  cleanStates,
  MAX_NAME_CHARS,
  type PriceNow,
  type Tracker,
  type TrackerChecker,
  type TrackerInput,
  type TrackerNews,
  type TrackerPoint,
  type TrackerSummaryFull,
  type TrackerTarget,
  type TrackerView,
} from "./trackers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export type FullView = TrackerView & { summary: TrackerSummaryFull | null };

// ---------- who is checking ----------

const checker = new AsyncLocalStorage<{ assistantId: string }>();

/** Run a Team assistant's turn so a check it keeps, or a tracker it starts, is its own (runAssistantTurn's callers). */
export function asTrackerChecker<T>(assistantId: string, fn: () => T): T {
  return isId(assistantId) ? checker.run({ assistantId }, fn) : fn();
}

/** Who a check kept now is from: the assistant whose turn this is, else main Ask. */
export function currentChecker(): { by: "ask" } | { by: "assistant"; assistantId: string } {
  const c = checker.getStore();
  return c ? { by: "assistant", assistantId: c.assistantId } : { by: "ask" };
}

export interface Who {
  by: TrackerChecker;
  assistantId?: string | null;
}

const assistantOf = (who: Who) => (who.by === "assistant" && isId(who.assistantId) ? who.assistantId : null);

// ---------- rows ----------

const TCOLS = `id, saved_id, name, url, label, kind, prefix, suffix, currency, states, direction, preset, target_op, target_value, target_set_by, target_assistant_id, target_set_at, assistant_id, assistant_set_by, url_set_by, created_at`;
const PCOLS = `id, tracker_id, value, source, url, checked_at, checked_by, assistant_id`;

interface TrackerRow {
  id: string;
  saved_id: string | null;
  name: string;
  url: string | null;
  label: string;
  kind: Tracker["kind"];
  prefix: string;
  suffix: string;
  currency: string | null;
  states: string[] | null;
  direction: Tracker["direction"];
  preset: Tracker["preset"];
  target_op: TrackerTarget["op"] | null;
  target_value: string | null;
  target_set_by: TrackerTarget["set_by"] | null;
  target_assistant_id: string | null;
  target_set_at: Date | string | null;
  assistant_id: string | null;
  assistant_set_by: Tracker["assistant_set_by"] | null;
  url_set_by: Tracker["url_set_by"] | null;
  created_at: Date | string;
}

interface PointRow {
  id: string;
  tracker_id: string;
  value: string;
  source: string | null;
  url: string | null;
  checked_at: Date | string;
  checked_by: TrackerChecker;
  assistant_id: string | null;
}

const sealed = (v: string | null | undefined) => typeof v === "string" && isEncryptedPlaceholder(v);

/** A row as the API gives it, the item's name filled in; null when a sealed value can't be opened here. */
function toTracker(r: TrackerRow, items: Map<string, { name: string; url: string | null }>): Tracker | null {
  if (sealed(r.label) || sealed(r.name) || sealed(r.prefix) || sealed(r.suffix) || (r.states ?? []).some(sealed)) return null;
  const url = r.url && !sealed(r.url) ? r.url : null;
  const target: TrackerTarget | null =
    r.target_op && r.target_value !== null && !sealed(r.target_value)
      ? { op: r.target_op, value: r.target_value ?? "", set_by: r.target_set_by ?? "owner", assistant_id: r.target_assistant_id, set_at: iso(r.target_set_at ?? r.created_at) }
      : null;
  return {
    id: r.id,
    saved_id: r.saved_id,
    name: r.saved_id ? (items.get(r.saved_id)?.name ?? "Saved item") : r.name,
    url,
    label: r.label,
    kind: r.kind,
    prefix: r.prefix,
    suffix: r.suffix,
    currency: r.currency,
    states: r.states ?? [],
    direction: r.direction,
    preset: r.preset,
    target,
    assistant_id: r.assistant_id,
    assistant_set_by: r.assistant_set_by ?? null,
    url_set_by: r.url_set_by ?? null,
    // The link a run may open (lib/run-links.ts): the owner's or the item's own, never one a model chose alone.
    run_url: runUrlOf({ url, url_set_by: r.url_set_by ?? null, saved_id: r.saved_id }, r.saved_id ? (items.get(r.saved_id)?.url ?? null) : null),
    created_at: iso(r.created_at),
  };
}

function toPoint(r: PointRow, names: Map<string, string>): TrackerPoint | null {
  if (sealed(r.value)) return null;
  return {
    id: r.id,
    tracker_id: r.tracker_id,
    value: r.value,
    source: r.source && !sealed(r.source) ? r.source : null,
    url: r.url && !sealed(r.url) ? r.url : null,
    checked_at: iso(r.checked_at),
    checked_by: r.checked_by,
    assistant_id: r.assistant_id,
    ...(r.assistant_id && names.has(r.assistant_id) ? { who: names.get(r.assistant_id) } : {}),
  };
}

async function assistantNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const clean = [...new Set(ids.filter(isId))];
  if (!clean.length) return new Map();
  try {
    const { getAssistant } = await import("./team");
    const found = await Promise.all(clean.map((id) => getAssistant(id).catch(() => null)));
    return new Map(found.filter((a): a is NonNullable<typeof a> => !!a).map((a) => [a.id, a.name]));
  } catch {
    return new Map();
  }
}

/** Each saved item's name, and its own link (https only), for its trackers. */
async function itemsFor(rows: Array<{ saved_id: string | null }>): Promise<Map<string, { name: string; url: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.saved_id).filter(isId))];
  if (!ids.length) return new Map();
  const [{ getSaved }, { itemName }] = await Promise.all([import("./saved"), import("./saved-action-rules")]);
  const items = await Promise.all(ids.map((id) => getSaved(id).catch(() => null)));
  const own = (i: SavedItem) => [i.url, i.source_url].find((u): u is string => typeof u === "string" && /^https:\/\//.test(u)) ?? null;
  return new Map(items.filter((i): i is SavedItem => !!i).map((i) => [i.id, { name: itemName(i), url: own(i) }]));
}

/** Points for these trackers, the newest MAX_POINTS_SHOWN of each and its save point, oldest first. */
async function pointsFor(ids: string[]): Promise<Map<string, TrackerPoint[]>> {
  const out = new Map<string, TrackerPoint[]>();
  if (!ids.length) return out;
  const rows = await q<PointRow>(
    `SELECT ${PCOLS} FROM (
       SELECT ${PCOLS}, row_number() OVER (PARTITION BY tracker_id ORDER BY checked_at DESC, created_at DESC) AS n
       FROM tracker_points WHERE tracker_id = ANY($1::uuid[]) AND removed_at IS NULL
     ) p WHERE n <= $2 OR checked_by = 'save'`,
    [ids, MAX_POINTS_SHOWN],
  );
  const names = await assistantNames(rows.map((r) => r.assistant_id));
  for (const r of rows) {
    const p = toPoint(r, names);
    if (p) out.set(p.tracker_id, [...(out.get(p.tracker_id) ?? []), p]);
  }
  for (const list of out.values()) list.sort(byTime);
  return out;
}

async function views(rows: TrackerRow[], opts: { now?: Date } = {}): Promise<FullView[]> {
  const [items, points] = await Promise.all([itemsFor(rows), pointsFor(rows.map((r) => r.id))]);
  return rows
    .map((r) => toTracker(r, items))
    .filter((t): t is Tracker => !!t)
    .map((t) => trackerView(t, points.get(t.id) ?? [], opts));
}

// ---------- reading ----------

/** One tracker with its points and summary, or null. Back-fills a saved item's save point first. */
export async function getTracker(id: string, opts: { now?: Date; removed?: boolean } = {}): Promise<FullView | null> {
  if (!isId(id)) return null;
  const [row] = await q<TrackerRow & { removed_at: Date | null }>(`SELECT ${TCOLS}, removed_at FROM trackers WHERE id = $1::uuid`, [id]);
  if (!row || (row.removed_at && !opts.removed)) return null;
  if (row.saved_id && row.preset === "price") await backfillSavePoints({ ids: [row.saved_id] });
  return (await views([row], opts))[0] ?? null;
}

export interface TrackerQuery {
  saved_id?: string;
  standalone?: boolean;
  /** The trackers this assistant checks. */
  assistant_id?: string;
  now?: Date;
  /** Back-fill a saved item's save point first (the default). Off inside the back-fill itself. */
  backfill?: boolean;
}

/** Trackers, newest first: one item's, those on their own, one assistant's, or all. */
export async function listTrackers(query: TrackerQuery = {}): Promise<FullView[]> {
  if (query.saved_id !== undefined && !isId(query.saved_id)) return [];
  if (query.assistant_id !== undefined && !isId(query.assistant_id)) return [];
  if (query.saved_id && query.backfill !== false) await backfillSavePoints({ ids: [query.saved_id] });
  const where = ["removed_at IS NULL"];
  const params: unknown[] = [];
  if (query.saved_id) where.push(`saved_id = $${params.push(query.saved_id)}::uuid`);
  if (query.standalone) where.push(`saved_id IS NULL`);
  if (query.assistant_id) where.push(`assistant_id = $${params.push(query.assistant_id)}::uuid`);
  const rows = await q<TrackerRow>(`SELECT ${TCOLS} FROM trackers WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT 200`, params);
  return views(rows, { now: query.now });
}

/** A saved item's tracker by preset or label ("price", "followers"), or null. */
export async function trackerOn(savedId: string, which: { preset?: Tracker["preset"]; label?: string }, opts: { backfill?: boolean } = {}): Promise<FullView | null> {
  const list = await listTrackers({ saved_id: savedId, backfill: opts.backfill });
  const label = which.label?.trim().toLowerCase();
  return list.find((t) => (which.preset && t.preset === which.preset) || (label && t.label === label)) ?? null;
}

// ---------- trackers ----------

/** Does the saved item exist? Its name, link and currency, for planTracker. */
async function trackedItem(savedId: string | null | undefined) {
  if (!savedId) return null;
  if (!isId(savedId)) throw new TrackerInputError("saved_id: a saved item's id, from find_saved or an @ mention");
  const [{ getSaved }, { itemName, linkOf }] = await Promise.all([import("./saved"), import("./saved-action-rules")]);
  const item = await getSaved(savedId);
  if (!item) return null;
  const link = linkOf(item);
  return { id: item.id, name: itemName(item), url: link && /^https?:\/\//.test(link) ? link : null, currency: item.facts?.currency ?? null };
}

/**
 * Start tracking. With `preset` the rest is filled in; otherwise label and kind (and a direction for a number).
 * On a saved item, or on its own with a name. The same preset, or the same label, on the same thing answers the one
 * already there (`existed`). Throws TrackerInputError for what's missing, over the limits, or an item that isn't there.
 */
export async function createTracker(input: TrackerInput, who: Who): Promise<{ tracker: FullView; existed: boolean }> {
  const item = await trackedItem(input.saved_id);
  const shape = planTracker(input, item);
  // Same thing, same preset or label: that one. Same item and price, so the save point goes on it.
  const same = (await listTrackers(shape.saved_id ? { saved_id: shape.saved_id, backfill: false } : { standalone: true })).find(
    (t) => (shape.preset && t.preset === shape.preset) || (t.label === shape.label && (shape.saved_id ? true : t.name.toLowerCase() === shape.name.toLowerCase())),
  );
  if (same) return { tracker: same, existed: true };
  const [{ n }] = await qRaw<{ n: number }>(
    shape.saved_id ? `SELECT count(*)::int AS n FROM trackers WHERE saved_id = $1::uuid AND removed_at IS NULL` : `SELECT count(*)::int AS n FROM trackers WHERE saved_id IS NULL AND removed_at IS NULL`,
    shape.saved_id ? [shape.saved_id] : [],
  );
  const cap = shape.saved_id ? TRACKER_LIMITS.perItem : TRACKER_LIMITS.standalone;
  if (n >= cap) throw new TrackerInputError(shape.saved_id ? `A saved item can have ${cap} trackers. Remove one first.` : `You can track ${cap} things on their own. Remove one first.`);
  // An assistant that starts tracking something checks it, unless it was given to another. Who chose is kept, so the
  // owner's "Just me" (assistant_id null, sent) is never taken on by an assistant's first check.
  const assistantId = shape.assistant_id ?? assistantOf(who);
  const assistantSetBy = input.assistant_id !== undefined || assistantId ? setterOf(who) : null;
  const target = input.target ? cleanTarget(shape, input.target) : null;
  const s = await sealer();
  const [row] = await q<TrackerRow>(
    `INSERT INTO trackers (saved_id, name, url, label, kind, prefix, suffix, currency, states, direction, preset, assistant_id, target_op, target_value, target_set_by, target_assistant_id, target_set_at, assistant_set_by, url_set_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12::uuid, $13, $14, $15, $16::uuid, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END, $17, $18)
     ON CONFLICT (saved_id, preset) WHERE saved_id IS NOT NULL AND preset IS NOT NULL AND removed_at IS NULL DO NOTHING
     RETURNING ${TCOLS}`,
    [
      shape.saved_id,
      s.text(shape.name),
      s.maybe(shape.url),
      s.text(shape.label),
      shape.kind,
      s.text(shape.prefix),
      s.text(shape.suffix),
      shape.currency,
      s.list(shape.states),
      shape.direction,
      shape.preset,
      assistantId,
      target?.op ?? null,
      target ? s.text(target.value) : null,
      target ? targetSetter(who) : null,
      target ? assistantOf(who) : null,
      assistantSetBy,
      !shape.url ? null : input.url === undefined && shape.saved_id ? "item" : linkSetter(who),
    ],
  );
  if (!row) {
    // Another request made the same preset just now: that one.
    const there = await trackerOn(shape.saved_id!, { preset: shape.preset }, { backfill: false });
    if (there) return { tracker: there, existed: true };
    throw new TrackerInputError("That tracker couldn't be kept. Try again.");
  }
  return { tracker: (await views([row]))[0], existed: false };
}

const targetSetter = (who: Who): TrackerTarget["set_by"] => (who.by === "save" ? "owner" : who.by);
/**
 * Who set a tracker's link (0085): the owner when they typed it, or when it's set under their Go on a plan
 * (lib/run-links.ts asOwnersGo); otherwise the model that chose it, and no run opens it (runUrlOf).
 */
const linkSetter = (who: Who): NonNullable<Tracker["url_set_by"]> => (underOwnersGo() || who.by === "owner" || who.by === "save" ? "owner" : who.by);
/** Who chose a checker: the owner, Ask or an assistant (the save is the owner's). */
const setterOf = (who: Who): NonNullable<Tracker["assistant_set_by"]> => targetSetter(who);

export interface TrackerPatch {
  name?: unknown;
  url?: unknown;
  label?: unknown;
  prefix?: unknown;
  suffix?: unknown;
  states?: unknown;
  direction?: unknown;
  assistant_id?: unknown;
  /** null clears it. */
  target?: { op?: unknown; value?: unknown } | null;
}

/**
 * Change a tracker: its name (on its own), link, label, prefix, suffix, states (every kept check must still be one
 * of them), direction (a number), the assistant that checks it, and its target. Its kind, preset and currency stay:
 * its checks were kept by them. Returns the tracker after, and before (for Undo). Null when it isn't there.
 */
export async function updateTracker(id: string, patch: TrackerPatch, who: Who): Promise<{ tracker: FullView; was: FullView } | null> {
  const was = await getTracker(id);
  if (!was) return null;
  const sets: string[] = [];
  const params: unknown[] = [id];
  const s = await sealer();
  const set = (col: string, v: unknown, cast = "") => sets.push(`${col} = $${params.push(v)}${cast}`);
  if (patch.name !== undefined) {
    if (was.saved_id) throw new TrackerInputError("name: a saved item's tracker takes the item's name");
    const name = plainLine(patch.name, MAX_NAME_CHARS);
    if (!name) throw new TrackerInputError("name: what is being followed");
    set("name", s.text(name));
  }
  if (patch.url !== undefined) {
    const url = cleanUrl(patch.url, "url: the link of the page to check");
    set("url", s.maybe(url));
    set("url_set_by", url ? linkSetter(who) : null);
  }
  if (patch.label !== undefined && !was.preset) set("label", s.text(cleanLabel(patch.label)));
  if (was.kind === "number" && !was.currency) {
    if (patch.prefix !== undefined) set("prefix", s.text(cleanAffix(patch.prefix, "prefix")));
    if (patch.suffix !== undefined) set("suffix", s.text(cleanAffix(patch.suffix, "suffix")));
  }
  if (patch.states !== undefined && was.kind === "state" && !was.preset) {
    const states = cleanStates(patch.states);
    const lost = was.points.find((p) => !states.includes(p.value));
    if (lost) throw new TrackerInputError(`states: "${lost.value}" is in its checks, so it stays`);
    set("states", s.list(states), "::text[]");
  }
  if (patch.direction !== undefined && was.kind === "number" && !was.preset) {
    if (patch.direction !== "lower" && patch.direction !== "higher" && patch.direction !== "change") throw new TrackerInputError('direction: "lower", "higher" or "change"');
    set("direction", patch.direction);
  }
  if (patch.assistant_id !== undefined) {
    set("assistant_id", isId(patch.assistant_id) ? patch.assistant_id : null, "::uuid");
    set("assistant_set_by", setterOf(who));
  }
  if (sets.length) await qRaw(`UPDATE trackers SET ${sets.join(", ")} WHERE id = $1::uuid`, params);
  if (patch.target !== undefined) {
    const after = (await getTracker(id))!;
    if (patch.target === null) await clearTarget(id);
    else await setTarget(id, patch.target, who, after);
  }
  return { tracker: (await getTracker(id))!, was };
}

/** Has the owner stopped this preset on the item? Then nothing starts it again (keepSavePoint, record_value). */
export async function stoppedOn(savedId: string, preset: NonNullable<Tracker["preset"]>): Promise<boolean> {
  if (!isId(savedId)) return false;
  return (await qRaw(`SELECT 1 FROM trackers WHERE saved_id = $1::uuid AND preset = $2 AND removed_at IS NOT NULL LIMIT 1`, [savedId, preset])).length > 0;
}

/** Stop tracking: hidden with its checks, never deleted (Undo: restoreTracker). True when it was there. */
export async function removeTracker(id: string): Promise<boolean> {
  if (!isId(id)) return false;
  return (await qRaw<{ id: string }>(`UPDATE trackers SET removed_at = now() WHERE id = $1::uuid AND removed_at IS NULL RETURNING id`, [id])).length > 0;
}

/** Throw away a tracker just started for a check that wasn't kept: deleted, not stopped, so it can be started again. */
export async function discardTracker(id: string): Promise<void> {
  if (isId(id)) await qRaw(`DELETE FROM trackers WHERE id = $1::uuid`, [id]);
}

/** Bring a stopped tracker back, unless the same preset has been started on the item since. */
export async function restoreTracker(id: string): Promise<boolean> {
  if (!isId(id)) return false;
  try {
    return (await qRaw<{ id: string }>(`UPDATE trackers SET removed_at = NULL WHERE id = $1::uuid AND removed_at IS NOT NULL RETURNING id`, [id])).length > 0;
  } catch {
    return false;
  }
}

// ---------- the target ----------

/** Set (or replace) "tell me when". Returns it, and the one before for Undo. Throws TrackerInputError. */
export async function setTarget(id: string, raw: { op?: unknown; value?: unknown }, who: Who, known?: FullView): Promise<{ target: TrackerTarget; was: TrackerTarget | null; tracker: FullView }> {
  const t = known ?? (await getTracker(id));
  if (!t) throw new TrackerInputError("That tracker isn't there. Use tracker_history for its id.");
  const target = cleanTarget(t, raw);
  const s = await sealer();
  await qRaw(`UPDATE trackers SET target_op = $2, target_value = $3, target_set_by = $4, target_assistant_id = $5::uuid, target_set_at = now() WHERE id = $1::uuid`, [
    id,
    target.op,
    s.text(target.value),
    targetSetter(who),
    assistantOf(who),
  ]);
  const after = (await getTracker(id))!;
  return { target: after.target!, was: t.target, tracker: after };
}

/** Clear it. Returns the one cleared (for Undo), or null when there was none. */
export async function clearTarget(id: string): Promise<TrackerTarget | null> {
  const t = await getTracker(id);
  if (!t?.target) return null;
  await qRaw(`UPDATE trackers SET target_op = NULL, target_value = NULL, target_set_by = NULL, target_assistant_id = NULL, target_set_at = NULL WHERE id = $1::uuid`, [id]);
  return t.target;
}

/** Undo's side: put a target back exactly as it was, or clear it when there was none. */
export async function restoreTarget(id: string, was: Pick<TrackerTarget, "op" | "value" | "set_by" | "assistant_id"> | null): Promise<void> {
  if (!was) {
    await clearTarget(id);
    return;
  }
  await setTarget(id, was, { by: was.set_by, assistantId: was.assistant_id }).catch(() => undefined);
}

// ---------- checks ----------

export interface PointInput {
  value: unknown;
  url?: unknown;
  source?: unknown;
  /** A price's currency as the page gave it: refused when it isn't the tracker's. */
  currency?: unknown;
  /** When it was read; now by default. Never in the future. */
  checked_at?: Date | string;
}

export interface Recorded {
  point: TrackerPoint;
  news: TrackerNews;
  /** The value of the check before this one, or null for the first. */
  previous: string | null;
  tracker: FullView;
  /** The assistant keeping it took the tracker on: nobody checked it and nobody had chosen (0074). */
  took_on: boolean;
}

/**
 * Keep one check. The value as the page wrote it (a number) or one of the states; a page's link, required for Ask and
 * an assistant; for a price, a currency that is the tracker's own, never converted. Returns what was new about it.
 * An assistant keeping a check on a tracker nobody checks, and nobody chose a checker for, takes it on in the same
 * statement (`took_on`): its page lists it and its scheduled runs check it again. The owner's choice, "Just me" or
 * another assistant, is never overwritten. Throws TrackerInputError, and keeps nothing.
 */
export async function recordPoint(trackerId: string, input: PointInput, who: Who): Promise<Recorded> {
  const t = await getTracker(trackerId);
  if (!t) throw new TrackerInputError("That tracker isn't there. Use tracker_history for its id, or track to start one.");
  if (t.currency && input.currency !== undefined && input.currency !== null && input.currency !== "") {
    const c = cleanCurrency(input.currency);
    if (c !== t.currency) throw new TrackerInputError(`currency: this tracks the price in ${t.currency}; a price in ${c} isn't kept here and is never converted`);
  }
  const value = cleanValue(t, input.value);
  const url = cleanUrl(input.url);
  if (!url && who.by !== "owner") throw new TrackerInputError("url: the link of the page the value was read on");
  const source = cleanSource(input.source);
  const now = Date.now();
  const asked = input.checked_at ? new Date(input.checked_at) : null;
  const at = asked && !Number.isNaN(asked.getTime()) && asked.getTime() <= now ? asked : new Date(now);
  const before = t.points.filter((p) => Date.parse(p.checked_at) <= at.getTime());
  const s = await sealer();
  const [row] = await q<PointRow & { took_on: boolean }>(
    `WITH took AS (
       UPDATE trackers SET assistant_id = $7::uuid, assistant_set_by = 'assistant'
       WHERE id = $1::uuid AND $7::uuid IS NOT NULL AND assistant_id IS NULL AND assistant_set_by IS NULL AND removed_at IS NULL
       RETURNING id
     )
     INSERT INTO tracker_points (tracker_id, value, source, url, checked_at, checked_by, assistant_id) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
     RETURNING ${PCOLS}, EXISTS (SELECT 1 FROM took) AS took_on`,
    [t.id, s.text(value), s.maybe(source), s.maybe(url), at.toISOString(), who.by === "save" ? "owner" : who.by, assistantOf(who)],
  );
  const point = toPoint(row, await assistantNames([row.assistant_id]))!;
  const sorted = [...before].sort(byTime);
  return { point, news: newsFor(t, sorted, point), previous: sorted.length ? sorted[sorted.length - 1].value : null, tracker: (await getTracker(t.id))!, took_on: row.took_on === true };
}

/** Undo: hide one check. Never the save point: it's what "since you saved it" is measured from. True when hidden. */
export async function removePoint(id: string): Promise<boolean> {
  if (!isId(id)) return false;
  return (await qRaw<{ id: string }>(`UPDATE tracker_points SET removed_at = now() WHERE id = $1::uuid AND removed_at IS NULL AND checked_by <> 'save' RETURNING id`, [id])).length > 0;
}

/** Bring a hidden check back. */
export async function restorePoint(id: string): Promise<boolean> {
  if (!isId(id)) return false;
  return (await qRaw<{ id: string }>(`UPDATE tracker_points SET removed_at = NULL WHERE id = $1::uuid AND removed_at IS NOT NULL RETURNING id`, [id])).length > 0;
}

/** Which tracker a check is on, live or hidden (the routes check a point belongs to the tracker named). */
export async function pointTracker(id: string): Promise<{ tracker_id: string; checked_by: TrackerChecker } | null> {
  if (!isId(id)) return null;
  const [row] = await qRaw<{ tracker_id: string; checked_by: TrackerChecker }>(`SELECT tracker_id, checked_by FROM tracker_points WHERE id = $1::uuid`, [id]);
  return row ?? null;
}

// ---------- the price when it was saved ----------

/**
 * A saved product's price when it was saved: its price tracker (made now when it has none) and the save point,
 * from the item's own facts and link. Once per item; nothing without a price, a currency and a link. Never throws.
 */
export async function keepSavePoint(item: Pick<SavedItem, "id" | "url" | "saved_at" | "facts">): Promise<boolean> {
  const f = item.facts;
  if (!f?.price || !f.currency || !item.url) return false;
  try {
    const value = cleanNumber(f.price, { money: true });
    const currency = cleanCurrency(f.currency);
    const url = cleanUrl(item.url);
    let tracker = await trackerOn(item.id, { preset: "price" }, { backfill: false }).catch(() => null);
    // The owner stopped tracking its price: it stays stopped.
    if (!tracker && (await stoppedOn(item.id, "price"))) return false;
    if (!tracker) tracker = (await createTracker({ saved_id: item.id, preset: "price", currency }, { by: "owner" })).tracker;
    if (tracker.currency !== currency) return false;
    const s = await sealer();
    const rows = await qRaw<{ id: string }>(
      `INSERT INTO tracker_points (tracker_id, value, source, url, checked_at, checked_by)
       VALUES ($1::uuid, $2, $3, $4, $5, 'save') ON CONFLICT (tracker_id) WHERE checked_by = 'save' DO NOTHING RETURNING id`,
      [tracker.id, s.text(value), s.maybe(cleanSource(f.shop)), s.maybe(url), item.saved_at],
    );
    return rows.length > 0;
  } catch (error) {
    if (!(error instanceof TrackerInputError)) console.error("Athena: keeping the saved price failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The save-time price for items saved before 0073 (or whose save didn't keep one): every saved item with a price in
 * its facts and a link, and no save point on a price tracker yet. Safe to run any number of times. `ids` narrows it.
 * Returns how many it kept.
 */
export async function backfillSavePoints(opts: { ids?: string[]; limit?: number } = {}): Promise<number> {
  const ids = opts.ids?.filter(isId);
  if (ids && !ids.length) return 0;
  const rows = await qRaw<{ id: string }>(
    `SELECT i.id FROM saved_items i
     WHERE i.facts IS NOT NULL AND i.url IS NOT NULL ${ids ? "AND i.id = ANY($2::uuid[])" : ""}
       AND NOT EXISTS (SELECT 1 FROM trackers t JOIN tracker_points p ON p.tracker_id = t.id AND p.checked_by = 'save' WHERE t.saved_id = i.id AND t.preset = 'price')
       AND NOT EXISTS (SELECT 1 FROM trackers t WHERE t.saved_id = i.id AND t.preset = 'price' AND t.removed_at IS NOT NULL)
     ORDER BY i.saved_at LIMIT $1`,
    ids ? [opts.limit ?? 500, ids] : [opts.limit ?? 500],
  );
  if (!rows.length) return 0;
  const { getSaved } = await import("./saved");
  let kept = 0;
  for (const r of rows) {
    const item = await getSaved(r.id);
    if (item && (await keepSavePoint(item))) kept++;
  }
  return kept;
}

/** "Read again" found a price on the item's own page: the owner's own check on its price tracker, the save point first. */
export async function recordOwnerRead(item: Pick<SavedItem, "id" | "url" | "saved_at" | "facts">, facts: { price?: string; currency?: string; shop?: string }): Promise<Recorded | null> {
  if (!item.url || !facts.price || !facts.currency) return null;
  await keepSavePoint(item);
  const tracker = await trackerOn(item.id, { preset: "price" });
  if (!tracker) return null;
  return recordPoint(tracker.id, { value: facts.price, currency: facts.currency, url: item.url, source: facts.shop }, { by: "owner" });
}

// ---------- lists ----------

/**
 * The best price now for a page of saved items, in one query: each price tracker's save point and its checks within
 * 14 days of its newest (the tracker's "now" rule). Only items with a check since they were saved get one.
 */
export async function pricesNow(ids: string[]): Promise<Map<string, PriceNow>> {
  const clean = ids.filter(isId);
  if (!clean.length) return new Map();
  const rows = await q<PointRow & { saved_id: string; currency: string; direction: Tracker["direction"] }>(
    `SELECT p.id, p.tracker_id, p.value, p.source, p.url, p.checked_at, p.checked_by, p.assistant_id, p.saved_id, p.currency, p.direction FROM (
       SELECT pt.*, t.saved_id, t.currency, t.direction, max(pt.checked_at) OVER (PARTITION BY pt.tracker_id) AS newest
       FROM tracker_points pt JOIN trackers t ON t.id = pt.tracker_id
       WHERE t.saved_id = ANY($1::uuid[]) AND t.preset = 'price' AND t.removed_at IS NULL AND pt.removed_at IS NULL
     ) p WHERE p.checked_by = 'save' OR p.checked_at >= p.newest - make_interval(days => $2)`,
    [clean, TRACKER_LIMITS.freshDays],
  );
  const by = new Map<string, { currency: string; direction: Tracker["direction"]; points: TrackerPoint[] }>();
  for (const r of rows) {
    const p = toPoint(r, new Map());
    if (!p) continue;
    const e = by.get(r.saved_id) ?? { currency: r.currency, direction: r.direction, points: [] };
    e.points.push(p);
    by.set(r.saved_id, e);
  }
  const out = new Map<string, PriceNow>();
  for (const [id, e] of by) {
    const now = priceNowOf({ kind: "number", direction: e.direction, currency: e.currency, preset: "price" }, e.points);
    if (now) out.set(id, now);
  }
  return out;
}

export { TrackerInputError };
