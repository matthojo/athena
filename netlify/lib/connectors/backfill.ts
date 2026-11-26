/**
 * History on connect: when the owner connects an account that has history
 * (Trakt, YouTube, Letterboxd…), Athena reads all of it straight from the
 * service's API, page by page, and writes it as Day entries and Watch &
 * read items. No model is involved, so it uses no credits.
 *
 * A direct adapter offers this with `backfill` (direct.ts): a list of
 * streams (history, ratings, watchlist…), each read one page at a time with
 * a cursor. This file runs them:
 *
 *  - Progress is kept per account in settings (`history_load.<id>`): the stream,
 *    its cursor, how many items so far, the oldest day. It's saved after
 *    every page, so a run that times out carries on from that page.
 *  - A day a collection run already wrote for that source is left to it.
 *  - Every write is safe to repeat: Day entries are keyed by the source's
 *    own id (lib/days.ts), Watch & read by its keys and title
 *    (lib/watch-read-sync.ts). Loading history again changes nothing that's
 *    there already.
 *  - Rows it makes are marked `backfilled` (0054) and dated when they
 *    happened, so they show in history and the taste profile, never as new.
 *  - A service saying "slow down" (429) or "busy" (5xx) pauses the account
 *    until later; the scheduled tick (backfill-history.ts) picks it back up.
 *    At most HISTORY_CAP items per account.
 *
 * The background function (backfill-run.ts) does the work; the API only
 * starts it. Nothing here sends a notification. Titles and ids are never
 * logged.
 */
import { getConnectorWithSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { getOwnerTimeZone, q } from "../../../lib/db";
import { zonedToday } from "../../../lib/dates";
import { fillEntryHours, MAX_ENTRIES_PER_WRITE, writeEntries, type EntryInput } from "../../../lib/days";
import { syncWatchRead, type WatchReadInput } from "../../../lib/watch-read-sync";
import { directFor } from "./direct";
import { HAND_OFF_MS, handedOff } from "./trigger";
import { ServiceError } from "./feeds-shared";
import { historyTarget } from "./youtube-history";

/** Items read per stream, at most, unless the stream sets its own (Last.fm scrobbles: 100,000). Enough for years of daily watching. */
export const HISTORY_CAP = 20_000;
/** What the account page says when nothing a load needs is allowed. */
export const BLOCKED = "Choose what Athena can read to load your history";
/** Paused after a 429 for this long (YouTube's daily allowance resets at midnight Pacific; the tick checks again hourly). */
export const WAIT_AFTER_LIMIT_MS = 60 * 60_000;
/** Paused after a 5xx or a dropped connection. */
export const WAIT_AFTER_TROUBLE_MS = 15 * 60_000;
/** A run that stops this many times in a row without getting anywhere gives up. */
export const MAX_ATTEMPTS = 6;

/** One page of a stream: what to write, how many source items it read, and where the next page starts. */
export interface BackfillPage {
  entries: Array<{ date: string; entry: EntryInput }>;
  watchRead?: WatchReadInput[];
  /** Items the service gave on this page (what "1,240 items so far" counts). */
  read: number;
  /** The next page's cursor; none when the stream has nothing older. */
  next?: string;
  /** A stream that saves its own rows (Octopus's sealed home days): the oldest day, and how many it added or changed. */
  oldest?: string;
  added?: number;
}

export interface BackfillStream {
  /** "history", "ratings": for the notes and tests, never shown. */
  id: string;
  /** The account's read tools this stream stands for: it loads only when the owner allows all of them. */
  tools: string[];
  /** Items to read from this stream at most (default HISTORY_CAP). */
  cap?: number;
  page(cursor: string | undefined): Promise<BackfillPage>;
}

/** What a direct adapter implements to load an account's history. */
export interface HistoryBackfill {
  /** The streams in the order they're read: what was watched first, then ratings and lists. */
  open(connector: Connector, secrets: ConnectorSecrets, ctx: { tz: string }): Promise<BackfillStream[]>;
  /** Every tool any stream needs, known without opening the account: with none of them allowed, nothing loads. */
  tools: string[];
  /** What an item is, for the account page ("120 days so far"); items otherwise. */
  unit?: "day";
}

/** blocked: the owner allows none of the reads a load needs ("What Athena can read"). */
export type BackfillState = "running" | "waiting" | "done" | "failed" | "blocked";

/** Stored as settings `history_load.<connector id>`. Counts, days and cursors only: nothing from the history itself. */
export interface BackfillProgress {
  state: BackfillState;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  /** Which stream, and the cursor of the next page to read in it. */
  stream: number;
  cursor?: string;
  /** Items read from the current stream, for its cap. */
  stream_items?: number;
  /** Items read so far. */
  items: number;
  /** Day entries and Watch & read items this load added (not ones already there). */
  added: number;
  /** The oldest day seen (YYYY-MM-DD). */
  oldest?: string;
  /** Stopped at the cap with more still there. */
  capped?: boolean;
  /** "day" when an item is a day of readings (Octopus). */
  unit?: "day";
  /** For the owner: why it stopped or is waiting. */
  error?: string;
  /** Waiting until then. */
  resume_at?: string;
  /** Another run has it until then. */
  lease_until?: string;
  attempts?: number;
}

const KEY = (connectorId: string) => `history_load.${connectorId}`;

export async function getBackfill(connectorId: string): Promise<BackfillProgress | null> {
  const [row] = await q<{ value: BackfillProgress }>(`SELECT value FROM settings WHERE key = $1`, [KEY(connectorId)]);
  return row?.value?.state ? row.value : null;
}

async function saveBackfill(connectorId: string, p: BackfillProgress): Promise<void> {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY(connectorId), JSON.stringify(p)]);
}

/** Forget an account's load (its meters changed under Edit): the next check or "Load history again" starts from the newest page. */
export async function forgetHistory(connectorId: string): Promise<void> {
  await q(`DELETE FROM settings WHERE key = $1`, [KEY(connectorId)]);
}

/** Does the owner allow any read this account's load needs? */
export function allowsAny(connector: Pick<Connector, "provider" | "auth_type" | "oauth" | "allowed_tools">): boolean {
  const allowed = new Set(connector.allowed_tools ?? []);
  return (directFor(connector)?.backfill?.tools ?? []).some((t) => allowed.has(t));
}

/** Does this account have history Athena can load? */
export function canBackfill(connector: Pick<Connector, "provider" | "auth_type" | "oauth">): boolean {
  return !!directFor(connector)?.backfill;
}

/** Hand accounts to the background function. Tests replace `send`. */
export const backfillTrigger = {
  async send(origin: string, connectorIds: string[]): Promise<void> {
    if (!connectorIds.length) return;
    const g = globalThis as { Netlify?: { env: { get(k: string): string | undefined } } };
    const token = g.Netlify?.env.get("MCP_BEARER_TOKEN") ?? process.env.MCP_BEARER_TOKEN;
    if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
    const res = await fetch(new URL(BACKFILL_PATH, origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connector_ids: connectorIds }),
      signal: AbortSignal.timeout(HAND_OFF_MS),
      // Followed, a redirect to the login page would answer 200 and read as handed off.
      redirect: "manual",
    });
    if (!handedOff(res.status)) throw new Error(`background function answered ${res.status}`);
  },
};

export const BACKFILL_PATH = "/api/backfill-run";

/**
 * Start loading an account's history (on connect, or "Load history again").
 * `again` starts from the newest page; otherwise an account already loading
 * or loaded is left as it is. Returns the progress, or null when the account
 * has no history to load.
 */
export async function startBackfill(connectorId: string, origin: string, opts: { again?: boolean; now?: Date } = {}): Promise<BackfillProgress | null> {
  const found = await getConnectorWithSecrets(connectorId);
  if (!found || !canBackfill(found.connector)) return null;
  const now = (opts.now ?? new Date()).toISOString();
  const had = await getBackfill(connectorId);
  if (had && !opts.again) return had;
  if (had?.state === "running" && had.lease_until && had.lease_until > now) return had;
  const unit = directFor(found.connector)?.backfill?.unit;
  const base = { started_at: now, updated_at: now, stream: 0, items: 0, added: 0, ...(had?.oldest ? { oldest: had.oldest } : {}), ...(unit ? { unit } : {}) };
  // Nothing it needs is allowed: say so, and start nothing. Allowing a read starts it (routes.ts).
  if (!allowsAny(found.connector)) {
    const p: BackfillProgress = { ...base, state: "blocked", error: BLOCKED };
    await saveBackfill(connectorId, p);
    return p;
  }
  const p: BackfillProgress = { ...base, state: "running" };
  await saveBackfill(connectorId, p);
  try {
    await backfillTrigger.send(origin, [connectorId]);
  } catch (error) {
    // The scheduled tick picks it up within the quarter hour.
    console.error("Athena backfill: couldn't start the background function:", error instanceof Error ? error.message : "unknown error");
  }
  return p;
}

/** Take the account for this run, unless another run holds it. */
async function claim(connectorId: string, until: string, nowIso: string): Promise<BackfillProgress | null> {
  const [row] = await q<{ value: BackfillProgress }>(
    `UPDATE settings SET value = jsonb_set(value, '{lease_until}', to_jsonb($2::text)), updated_at = now()
     WHERE key = $1 AND value->>'state' IN ('running', 'waiting') AND COALESCE(value->>'lease_until', '') < $3
     RETURNING value`,
    [KEY(connectorId), until, nowIso],
  );
  return row?.value ?? null;
}

export interface RunOptions {
  /** Stop starting new pages after this long; the next run carries on. */
  budgetMs: number;
  /** For tests. */
  clock?: () => number;
  cap?: number;
}

const minDay = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : a < b ? a : b);

/**
 * Read pages until the history runs out, the cap, or the budget. Safe to
 * call while nothing is due (returns what's stored), and from two places at
 * once (one takes the account, the other returns).
 */
export async function runBackfill(connectorId: string, opts: RunOptions): Promise<BackfillProgress | null> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const found = await getConnectorWithSecrets(connectorId);
  const adapter = found && directFor(found.connector);
  if (!found || !adapter?.backfill) {
    console.log(`Athena backfill: skipped, ${!found ? "account not found" : `${found.connector.provider} has no history load`}`);
    return null;
  }
  const stored = await getBackfill(connectorId);
  if (!stored || stored.state === "done" || stored.state === "failed" || stored.state === "blocked") return stored;
  if (stored.state === "waiting" && stored.resume_at && stored.resume_at > iso()) return stored;
  const claimed = await claim(connectorId, iso(started + opts.budgetMs + 120_000), iso());
  if (!claimed) return stored;
  const p: BackfillProgress = claimed;

  const save = async (patch: Partial<BackfillProgress>) => {
    Object.assign(p, patch, { updated_at: iso() });
    await saveBackfill(connectorId, p);
  };
  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(clock()), tz);
  const target = await historyTarget(found.connector);

  if (!allowsAny(found.connector)) {
    await save({ state: "blocked", error: BLOCKED, lease_until: undefined });
    return p;
  }
  let streams: BackfillStream[];
  try {
    streams = await adapter.backfill.open(found.connector, found.secrets, { tz });
  } catch (error) {
    await stopped(error);
    return p;
  }
  // Only what the owner allows under "What Athena can read": a stream needs every tool it stands for.
  const allowed = new Set(found.connector.allowed_tools ?? []);
  const may = (s: BackfillStream) => s.tools.every((t) => allowed.has(t));

  async function stopped(error: unknown) {
    const attempts = (p.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : "Something went wrong";
    const status = error instanceof ServiceError ? error.status : 0;
    const owner = error instanceof ServiceError && error.needsOwner;
    if (!owner && attempts < MAX_ATTEMPTS && (status === 429 || status >= 500 || status === 0)) {
      const wait = status === 429 ? WAIT_AFTER_LIMIT_MS : WAIT_AFTER_TROUBLE_MS;
      await save({ state: "waiting", resume_at: iso(clock() + wait), attempts, error: message, lease_until: undefined });
    } else {
      await save({ state: "failed", finished_at: iso(), attempts, error: message, lease_until: undefined });
    }
    console.error(`Athena backfill (${adapter!.id}): ${owner ? "needs the owner" : "stopped"}${status ? ` (${status})` : ""}`);
  }

  try {
    while (p.stream < streams.length) {
      if (clock() - started > opts.budgetMs) {
        await save({ state: "running", lease_until: undefined });
        return p;
      }
      const stream = streams[p.stream];
      const cap = opts.cap ?? stream.cap ?? HISTORY_CAP;
      if (!may(stream) || (p.stream_items ?? 0) >= cap) {
        console.log(`Athena backfill (${adapter.id}): ${stream.id} ${!may(stream) ? "not allowed under What Athena can read" : "at its cap"}, moving on`);
        await save({ stream: p.stream + 1, cursor: undefined, stream_items: 0, ...(may(stream) ? { capped: true } : {}) });
        continue;
      }
      const page = await stream.page(p.cursor);
      if (!p.cursor || !page.read) console.log(`Athena backfill (${adapter.id}): ${stream.id} page ${p.cursor ?? "1"} gave ${page.read} item(s)${page.next ? ", more to come" : ", the last page"}`);
      const added = await writePage(page, { source: target.source, today });
      const oldest = page.entries.reduce<string | undefined>((o, e) => minDay(o, e.date), page.oldest);
      const next = page.next && page.read > 0 ? page.next : undefined;
      await save({
        items: p.items + page.read,
        added: p.added + added + (page.added ?? 0),
        oldest: minDay(p.oldest, oldest),
        ...(next ? { cursor: next, stream_items: (p.stream_items ?? 0) + page.read } : { stream: p.stream + 1, cursor: undefined, stream_items: 0 }),
        attempts: 0,
        error: undefined,
        resume_at: undefined,
        state: "running",
      });
    }
    await save({ state: "done", finished_at: iso(), lease_until: undefined });
  } catch (error) {
    await stopped(error);
  }
  return p;
}

/** Write one page. Returns how many rows it added. */
async function writePage(page: BackfillPage, opts: { source: string; today: string }): Promise<number> {
  let added = 0;
  // A day a Life log run already wrote for this source is its: the run chose its own ids, so writing ours too would show things twice.
  const sources = [...new Set(page.entries.map((e) => e.entry.source))];
  const dates = [...new Set(page.entries.map((e) => e.date))];
  const covered = new Set(
    (dates.length
      ? await q<{ k: string }>(
          `SELECT DISTINCT source || ' ' || to_char(date, 'YYYY-MM-DD') AS k FROM day_entries WHERE source = ANY($1::text[]) AND date = ANY($2::date[]) AND NOT backfilled`,
          [sources, dates],
        )
      : []
    ).map((r) => r.k),
  );
  const due = page.entries.filter((e) => e.date <= opts.today && !covered.has(`${e.entry.source} ${e.date}`));
  // On those days the run's own entries keep everything but gain when they were played (Music's heatmap): matched by album and artist, never a new row.
  await fillEntryHours(page.entries.filter((e) => e.date <= opts.today && covered.has(`${e.entry.source} ${e.date}`)));
  for (let i = 0; i < due.length; i += MAX_ENTRIES_PER_WRITE) {
    const w = await writeEntries(due.slice(i, i + MAX_ENTRIES_PER_WRITE), { collection: opts.source, backfilled: true });
    added += w.created;
  }
  if (page.watchRead?.length) {
    const out = await syncWatchRead(page.watchRead, { collection: opts.source, backfilled: true });
    added += out.filter((o) => o.action === "created").length;
  }
  return added;
}

/** Accounts the scheduled tick should hand on: still running with nobody on it, or done waiting. */
export async function dueBackfills(now = new Date()): Promise<string[]> {
  const iso = now.toISOString();
  const rows = await q<{ key: string }>(
    `SELECT key FROM settings WHERE key LIKE 'history\\_load.%'
       AND ((value->>'state' = 'running' AND COALESCE(value->>'lease_until', '') < $1)
         OR (value->>'state' = 'waiting' AND COALESCE(value->>'resume_at', '') <= $1))
     ORDER BY updated_at LIMIT 10`,
    [iso],
  );
  return rows.map((r) => r.key.slice("history_load.".length));
}

/** What the account page says: the progress, and (YouTube) a Takeout import that covers what the API can't. */
export interface BackfillStatus {
  supported: boolean;
  progress: BackfillProgress | null;
}

export async function backfillStatus(connector: Connector): Promise<BackfillStatus> {
  if (!canBackfill(connector)) return { supported: false, progress: null };
  const p = await getBackfill(connector.id);
  if (!p) return { supported: true, progress: null };
  // Cursors and leases stay on the server.
  const { cursor: _c, lease_until: _l, attempts: _a, stream_items: _s, ...shown } = p;
  return { supported: true, progress: shown as BackfillProgress };
}
