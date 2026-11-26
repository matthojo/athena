/**
 * Your activity (recipe `plays-watches`): a collection with no model. Its
 * runs read new plays, watches and likes, and every other Life log source
 * with a direct adapter (books, highlights, games, chess, posts, saves,
 * events, habits and health days: activity-recent.ts), straight into Days,
 * every hour by default, so a service that keeps only a short history
 * (Spotify's last 50 plays) loses nothing on a busy day, and plain data
 * never goes through Claude. runner.ts runs it (runPlaysWatches) on the
 * same schedule, run history and "what a run saved" as any collection. The
 * Life log's daily counts for what it reads are worked out from Days
 * (activity-metrics.ts).
 *
 * A direct adapter offers it with `recent` (direct.ts): streams like the
 * history load's (backfill.ts), read newest first from the account's
 * last-seen point, and mapped by the same code, so the Day entries and Watch
 * & read items have the history load's ids. Writing again changes nothing
 * (lib/days.ts dedupes by source and id, lib/watch-read-sync.ts by keys and
 * title).
 *
 *  - Music is folded as the Life log folds it: one listened entry per album
 *    (or artist) a day, with count and hours, under albumDayId. Each play's
 *    time is kept in the account's state (as numbers, under a hash of the
 *    entry's id), so the count is every play seen that day, however many
 *    reads saw them.
 *  - State per account in settings (`media_sync.<id>`): each stream's
 *    last-seen time, a lease and a wait. Times and hashes only.
 *  - Only the reads the owner allows under "What Athena can read".
 *  - A 429 waits an hour, a 5xx 15 minutes; the next run picks it up.
 *  - The evening Life log run doesn't read these accounts again: it checks
 *    them one last time and is told what's in Days (runner.ts). For a
 *    source read whole (`whole`), it writes only the day's line.
 *
 * Nothing here sends a notification. Titles and ids are never logged.
 */
import { createHash } from "node:crypto";
import { WORDS, statKey, type Word } from "../../../lib/activity-words";
import { getConnector, getConnectorWithSecrets, listCollections, listConnectors, type Collection, type Connector, type ConnectorSecrets, type RunStatsJson } from "../../../lib/connectors";
import { getOwnerTimeZone, q } from "../../../lib/db";
import { addDays, zonedToInstant, zonedToday } from "../../../lib/dates";
import type { HealthDay } from "../../../lib/health";
import { entriesInRange, matchKey, MAX_ENTRIES_PER_WRITE, readRating, sameThing, touchDays, writeEntries, type DayEntry, type EntryInput } from "../../../lib/days";
import { syncWatchRead, type WatchReadInput } from "../../../lib/watch-read-sync";
import { WAIT_AFTER_LIMIT_MS, WAIT_AFTER_TROUBLE_MS } from "./backfill";
import { emptyHours, foldHours } from "../../../lib/day-hours";
import { directFor } from "./direct";
import { playSlot } from "./media-recent";

export { MAX_PAGES, playSlot } from "./media-recent";

export const RECIPE = "plays-watches";
/** How far before the last-seen point a read starts: a play the service saved late, or a clock a little out. */
export const OVERLAP_MS = 2 * 60 * 60_000;
/** Each account's share of a run. */
export const PER_ACCOUNT_MS = 2 * 60_000;
/**
 * Day entries a model run wrote: a run of any recipe but this one. Plays and
 * watches runs link their entries too (for "what a run saved"), but chose the
 * ids the loads use.
 */
export const BY_MODEL_RUN = `run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM collection_runs rr JOIN collections cc ON cc.id = rr.collection_id WHERE rr.id = day_entries.run_id AND cc.recipe = '${RECIPE}')`;

/** One play of music, for the day's fold. */
export interface Play {
  /** Epoch ms. */
  at: number;
  /** The day's listened entry it counts towards (count is set from every play seen). */
  date: string;
  entry: EntryInput;
}

export { WORDS, statKey, type Word };

/** One thing a check counts once, however many checks see it: a hash of `key` is kept with its count. */
export interface Tally {
  key: string;
  word: Word;
  n: number;
  date: string;
}

/** What one check of a stream found. */
export interface RecentRead {
  entries: Array<{ date: string; entry: EntryInput }>;
  watchRead?: WatchReadInput[];
  plays?: Play[];
  /** Health accounts: sealed health days (lib/health.ts), never entries. */
  health?: HealthDay[];
  /** What to count in the run's line, when it isn't one per entry (busy days, health). */
  tally?: Tally[];
  /** This check's own entries of that source and kind on that day that aren't in `keep` go: a busy day's count entry stands for them. */
  drop?: Array<{ date: string; source: string; kind: EntryInput["kind"]; keep: string[] }>;
  /** Steam's profile is private: no metric, and the run says why. */
  private?: boolean;
  note?: string;
  /** Items the service gave. */
  read: number;
  /** The newest item's time (epoch ms). */
  newest?: number;
}

/** What a stream gets besides the start: the owner's zone, the check's clock, the stream's own kept state (numbers and hashes only) and what the owner allows. */
export interface StreamContext {
  tz: string;
  now: number;
  state: Record<string, unknown>;
  allowed: ReadonlySet<string>;
}

export interface RecentStream {
  /** "plays", "history": state key, never shown. */
  id: string;
  /** The read tools it stands for: it reads only when the owner allows all of them. */
  tools: string[];
  /** Music: a Last.fm or ListenBrainz account in the same Life log is read instead (they usually get the same plays). */
  music?: "lastfm" | "listenbrainz" | "spotify";
  /** Everything since `since` (epoch ms), newest first. */
  read(since: number, ctx?: StreamContext): Promise<RecentRead>;
}

/** What a direct adapter implements to be checked hourly. */
export interface RecentSync {
  /** The Day entries' source ("spotify"). */
  source: string;
  /** Every tool any stream needs: the evening run leaves these to the hourly check. */
  tools: string[];
  /** The account's other listings, also kept from the evening run (it writes nothing for the source). */
  withhold?: string[];
  /** The check writes everything the Life log would for this source: the evening run writes no entries or metrics for it, only the day's line. */
  whole?: boolean;
  /** A health account: its days are sealed health days, and the evening run gets no athena_health_day for it. */
  health?: boolean;
  open(connector: Connector, secrets: ConnectorSecrets, ctx: { tz: string }): Promise<RecentStream[]>;
}

interface StreamState {
  /** Newest item seen (epoch ms). */
  last?: number;
  /** Music: each day's plays, by a hash of the entry's id, as epoch seconds. */
  plays?: Record<string, Record<string, number[]>>;
  /** What's been counted, by a hash of its key: [count, day]. */
  counted?: Record<string, [number, string]>;
  /** The stream's own (StreamContext.state): Steam's totals, Reddit's seen saves. */
  extra?: Record<string, unknown>;
}

/** Stored as settings `media_sync.<connector id>`. */
export interface MediaSyncState {
  /** The first day it checked: a day before it that a Life log run already wrote is left to that run. */
  since_day?: string;
  last_at?: string;
  streams?: Record<string, StreamState>;
  resume_at?: string;
  lease_until?: string;
  /** For the owner: why it's waiting. */
  error?: string;
}

const KEY = (id: string) => `media_sync.${id}`;

export async function getMediaSync(connectorId: string): Promise<MediaSyncState | null> {
  const [row] = await q<{ value: MediaSyncState }>(`SELECT value FROM settings WHERE key = $1`, [KEY(connectorId)]);
  return row?.value ?? null;
}

/** Merge into the stored state. */
async function patchState(connectorId: string, patch: Partial<MediaSyncState>): Promise<void> {
  // JSON drops undefined; a field cleared is written as null and removed.
  const clear = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = (settings.value || EXCLUDED.value) - $3::text[], updated_at = now()`,
    [KEY(connectorId), JSON.stringify(patch), clear],
  );
}

/** Does this account have plays and watches to check? */
export function checksHourly(connector: Pick<Connector, "provider" | "auth_type" | "oauth">): boolean {
  return !!directFor(connector)?.recent;
}

const allowedSet = (c: Pick<Connector, "allowed_tools">) => new Set(c.allowed_tools ?? []);

/** Does the owner allow any read the check needs? */
export function allowsRecent(connector: Pick<Connector, "provider" | "auth_type" | "oauth" | "allowed_tools">): boolean {
  const allowed = allowedSet(connector);
  return (directFor(connector)?.recent?.tools ?? []).some((t) => allowed.has(t));
}

const checkedBy = (all: Collection[], id: string) => all.filter((c) => c.recipe === RECIPE && c.enabled && c.connector_ids.includes(id));

/** Is it checked: connected, in an enabled Plays and watches collection, and something allowed. */
export function hourlyOn(connector: Connector, collections: Collection[]): boolean {
  return checksHourly(connector) && connector.status === "connected" && checkedBy(collections, connector.id).length > 0 && allowsRecent(connector);
}

/** Music read from somewhere better in the same collection: Last.fm over ListenBrainz over Spotify (recipes.ts). */
function musicElsewhere(own: RecentStream["music"], connector: Connector, accounts: Connector[], mates: ReadonlySet<string>): boolean {
  if (!own) return false;
  const order = ["lastfm", "listenbrainz", "spotify"];
  return accounts.some((a) => a.id !== connector.id && mates.has(a.id) && a.status === "connected" && order.indexOf(a.provider) >= 0 && order.indexOf(a.provider) < order.indexOf(own));
}

/** Take the account for this check, unless another holds it or it's waiting. */
async function claim(connectorId: string, until: string, nowIso: string): Promise<boolean> {
  await q(`INSERT INTO settings (key, value) VALUES ($1, '{}'::jsonb) ON CONFLICT (key) DO NOTHING`, [KEY(connectorId)]);
  const rows = await q<{ key: string }>(
    `UPDATE settings SET value = jsonb_set(value, '{lease_until}', to_jsonb($2::text)), updated_at = now()
     WHERE key = $1 AND COALESCE(value->>'lease_until', '') < $3 AND COALESCE(value->>'resume_at', '') <= $3
     RETURNING key`,
    [KEY(connectorId), until, nowIso],
  );
  return rows.length > 0;
}

export interface SyncOptions {
  budgetMs: number;
  /** The Plays and watches collection's source, and the run it's part of (none for the evening run's last check). */
  source: string;
  runId?: string;
  /** Accounts read alongside it: music is taken from the best of them. */
  mates?: string[];
  /** The Life log a health day's line is refreshed in (lib/health.ts). */
  lifeLogSource?: string;
  /** Last.fm and ListenBrainz: read at least this far back (default: from the start of yesterday). The evening run's last check asks for 7 days. */
  lookbackMs?: number;
  clock?: () => number;
}

export interface SyncResult {
  /** blocked: the owner has a step to take (sign in again, a key). */
  state: "checked" | "waiting" | "off" | "busy" | "blocked";
  /** New plays (music), watches (films and episodes) and likes (saved). */
  plays: number;
  watches: number;
  likes: number;
  /** Everything else new, by what the line calls it (books, workouts…). */
  counts?: Partial<Record<Word, number>>;
  /** Days with entries this check wrote or read again, for the metrics (activity-metrics.ts). */
  days?: string[];
  /** Steam's profile was private: no game minutes, and the run says so. */
  note?: string;
  read: number;
  /** Why it's waiting or blocked, for the run summary. */
  message?: string;
  /** Waiting until then. */
  resume_at?: string;
}

/** A hash of a day entry's id, for a play's place in the stored state: no titles kept there. */
export const playKey = (entry: EntryInput) => createHash("sha256").update(`${entry.source}\u0000${entry.external_id}`).digest("base64url").slice(0, 16);

/** Plays an hour, 24 of them, in the owner's time zone: a listened entry's `hours` (lib/day-hours.ts). */
export function playsPerHour(times: number[], tz: string): number[] {
  return foldHours(times.map((s) => s * 1000), tz) ?? emptyHours();
}

/**
 * The day's listened entries from the plays seen before and these: each
 * entry's count is every play seen that day. Returns the entries to write,
 * the state to keep and how many plays are new.
 */
export function foldPlays(plays: Play[], held: Record<string, Record<string, number[]>>, tz: string): { entries: Array<{ date: string; entry: EntryInput }>; held: Record<string, Record<string, number[]>>; fresh: number } {
  const next: Record<string, Record<string, number[]>> = structuredClone(held);
  const touched = new Map<string, { date: string; entry: EntryInput; k: string }>();
  let fresh = 0;
  for (const p of plays) {
    const k = playKey(p.entry);
    const day = (next[p.date] ??= {});
    const times = (day[k] ??= []);
    const s = Math.floor(p.at / 1000);
    if (!times.includes(s)) {
      times.push(s);
      fresh++;
    }
    touched.set(`${p.date}\u0000${k}`, { date: p.date, entry: p.entry, k });
  }
  const entries = [...touched.values()].map(({ date, entry, k }) => {
    const times = next[date][k].sort((a, b) => a - b);
    const { count: _c, ...rest } = entry;
    return { date, entry: { ...rest, ...(times.length > 1 ? { count: times.length } : {}), at: new Date(times[0] * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), hours: playsPerHour(times, tz) } };
  });
  return { entries, held: next, fresh };
}

/**
 * Check one account: every stream the owner allows, from its last-seen
 * point. Safe to call while another check holds it (returns "busy").
 */
export async function syncRecent(connectorId: string, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const none = (state: SyncResult["state"], extra: Partial<SyncResult> = {}): SyncResult => ({ state, plays: 0, watches: 0, likes: 0, read: 0, ...extra });
  const found = await getConnectorWithSecrets(connectorId);
  const sync = found && directFor(found.connector)?.recent;
  if (!found || !sync || !allowsRecent(found.connector)) return none("off");
  const stored = await getMediaSync(connectorId);
  if (stored?.resume_at && stored.resume_at > iso()) return none("waiting", { message: stored.error, resume_at: stored.resume_at });
  if (!(await claim(connectorId, iso(started + opts.budgetMs + 120_000), iso()))) return none("busy");
  const accounts = opts.mates?.length ? await listConnectors() : [];
  const mates = new Set(opts.mates ?? []);

  const tz = await getOwnerTimeZone();
  const today = zonedToday(new Date(clock()), tz);
  const allowed = allowedSet(found.connector);
  const streamsState: Record<string, StreamState> = structuredClone(stored?.streams ?? {});
  const sinceDay = stored?.since_day ?? today;
  const out = none("checked");
  const days: string[] = [];
  let privateDays = false;
  try {
    const streams = (await sync.open(found.connector, found.secrets, { tz })).filter((s) => s.tools.every((t) => allowed.has(t)) && !musicElsewhere(s.music, found.connector, accounts, mates));
    for (const stream of streams) {
      if (clock() - started > opts.budgetMs) break;
      const st = (streamsState[stream.id] ??= {});
      // First check: from the start of yesterday (the history load has what's older).
      const from = st.last !== undefined ? st.last - OVERLAP_MS : zonedToInstant(addDays(today, -1), "00:00", tz).getTime();
      // Music: a day not held is read from its start, so its count is the whole day.
      const fromDay = playSlot(from, tz).date;
      let since = stream.music && !st.plays?.[fromDay] ? zonedToInstant(fromDay, "00:00", tz).getTime() : from;
      // Last.fm and ListenBrainz keep everything and take late scrobbles (a phone that was offline): re-read from yesterday's start, which the kept play times make safe to repeat.
      if (stream.music && stream.music !== "spotify") {
        const back = opts.lookbackMs ? zonedToInstant(playSlot(clock() - opts.lookbackMs, tz).date, "00:00", tz).getTime() : zonedToInstant(addDays(today, -1), "00:00", tz).getTime();
        since = Math.min(since, back);
      }
      const r = await stream.read(since, { tz, now: clock(), state: (st.extra ??= {}), allowed });
      out.read += r.read;
      if (r.note) out.note = r.note;
      let entries = r.entries;
      if (r.plays) {
        const f = foldPlays(r.plays, st.plays ?? {}, tz);
        entries = [...entries, ...f.entries];
        out.plays += f.fresh;
        // Kept: from yesterday (re-read every check) and anything the last-seen point still reaches.
        const keepFrom = playSlot(Math.min(Math.max(r.newest ?? 0, st.last ?? 0) - OVERLAP_MS, zonedToInstant(addDays(today, -1), "00:00", tz).getTime()), tz).date;
        st.plays = Object.fromEntries(Object.entries(f.held).filter(([d]) => d >= keepFrom));
      }
      if (r.drop?.length) await dropOwn(r.drop, opts.source);
      const w = await writeRecent(entries, r.watchRead, { source: opts.source, runId: opts.runId, today, sinceDay });
      if (r.health?.length) await saveHealth(r.health, { tz, now: new Date(clock()), lifeLogSource: opts.lifeLogSource });
      if (sync.whole) {
        // Counted once each, however many checks see it: a day's chess count going from 2 to 3 is one new game.
        // Music's plays are counted by the fold above, play by play.
        const n = countNew(r.tally ?? entries.filter((e) => !(r.plays && e.entry.kind === "listened")).map(tallyOf), (st.counted ??= {}), addDays(today, -KEEP_COUNTED_DAYS));
        for (const [word, k] of Object.entries(n) as Array<[Word, number]>) {
          if (word === "watch") out.watches += k;
          else if (word === "like") out.likes += k;
          else (out.counts ??= {})[word] = ((out.counts ??= {})[word] ?? 0) + k;
        }
        days.push(...entries.map((e) => e.date));
      } else if (!r.plays) {
        out.watches += w.watched;
        out.likes += w.saved;
      }
      if (!r.private) days.push(...w.days);
      else privateDays = true;
      if (r.newest !== undefined) st.last = Math.max(st.last ?? 0, r.newest);
    }
    await patchState(connectorId, { streams: streamsState, since_day: sinceDay, last_at: iso(), lease_until: undefined, resume_at: undefined, error: undefined });
    out.days = privateDays ? [] : [...new Set(days)].filter((d) => d <= today).sort();
    console.log(`Athena your activity (${sync.source}): ${out.read} read, ${activityLine(out)}`);
    return out;
  } catch (error) {
    const w = waitAfter(error, found.connector.name);
    // What was read before the stop is kept; the next check starts from there.
    if (w.owner) {
      await patchState(connectorId, { streams: streamsState, since_day: sinceDay, lease_until: undefined });
      console.error(`Athena your activity (${sync.source}): needs the owner${w.status ? ` (${w.status})` : ""}`);
      return { ...out, state: "blocked", message: w.message };
    }
    const resume = iso(clock() + w.ms);
    await patchState(connectorId, { streams: streamsState, since_day: sinceDay, lease_until: undefined, resume_at: resume, error: w.message });
    console.error(`Athena your activity (${sync.source}): stopped${w.status ? ` (${w.status})` : ""}, trying again later`);
    return { ...out, state: "waiting", message: w.message, resume_at: resume };
  }
}

/** How long a check waits after a failure, and what the run says: an hour after a 429, 15 minutes otherwise. */
export function waitAfter(error: unknown, service: string): { ms: number; status: number; message: string; owner?: boolean } {
  const e = error as { status?: unknown; needsOwner?: unknown; owner?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : 0;
  // A sign-in or key the owner has to fix: no point waiting, the run says which account.
  if (e?.needsOwner === true || e?.owner === true || status === 401) return { ms: 0, status, message: `${service} needs signing in again`, owner: true };
  if (status === 429) return { ms: WAIT_AFTER_LIMIT_MS, status, message: `${service} asked Athena to wait` };
  return { ms: WAIT_AFTER_TROUBLE_MS, status, message: `Couldn't reach ${service}` };
}

/** Write a check's entries and Watch & read items. Returns the new watched and saved Day entries. */
async function writeRecent(entries: Array<{ date: string; entry: EntryInput }>, watchRead: WatchReadInput[] | undefined, opts: { source: string; runId?: string; today: string; sinceDay: string }): Promise<{ watched: number; saved: number; days: string[] }> {
  // A day before the check began that a Life log run already wrote is that run's: it chose its own ids.
  const old = entries.filter((e) => e.date < opts.sinceDay);
  const covered = new Set(
    (old.length
      ? await q<{ k: string }>(
          `SELECT DISTINCT source || ' ' || to_char(date, 'YYYY-MM-DD') AS k FROM day_entries WHERE source = ANY($1::text[]) AND date = ANY($2::date[]) AND ${BY_MODEL_RUN} AND NOT backfilled`,
          [[...new Set(old.map((e) => e.entry.source))], [...new Set(old.map((e) => e.date))]],
        )
      : []
    ).map((r) => r.k),
  );
  const due = entries.filter((e) => e.date <= opts.today && !covered.has(`${e.entry.source} ${e.date}`));
  const n = { watched: 0, saved: 0, days: [...new Set(due.map((e) => e.date))] };
  for (let i = 0; i < due.length; i += MAX_ENTRIES_PER_WRITE) {
    const chunk = due.slice(i, i + MAX_ENTRIES_PER_WRITE);
    const w = await writeEntries(chunk, { collection: opts.source, runId: opts.runId });
    w.outcomes.forEach((o, j) => {
      if (o.action !== "created") return;
      if (chunk[j].entry.kind === "saved") n.saved++;
      else n.watched++;
    });
  }
  if (watchRead?.length) await syncWatchRead(watchRead, { collection: opts.source });
  return n;
}

/** Counted things are kept this many days (hashes and numbers), so a re-read never counts them again. */
export const KEEP_COUNTED_DAYS = 30;

/** What an entry counts as in the run's line. */
export function wordOf(e: Pick<EntryInput, "kind" | "source">): Word | null {
  switch (e.kind) {
    case "listened":
      return "play";
    case "watched":
      return "watch";
    case "read":
      return "book";
    case "highlight":
      return "highlight";
    case "played":
      return "game";
    case "chess":
      return "chess game";
    case "posted":
      return "post";
    case "habit":
      return "habit";
    case "other":
      return e.source === "eventbrite" ? "event" : null;
    case "saved":
      return e.source === "goodreads" ? "book" : e.source === "raindrop" ? "bookmark" : e.source === "reddit" ? "save" : "like";
    default:
      return null;
  }
}

/** One entry as one thing to count: its count (a missed habit is 0, a day's chess games several). */
export function tallyOf({ date, entry }: { date: string; entry: EntryInput }): Tally {
  const word = wordOf(entry);
  return { key: `${entry.source}\u0000${entry.external_id}`, word: word ?? "save", n: word ? (entry.count ?? 1) : 0, date };
}

/** How many of each are new: each key's count above what was counted before. Updates `counted`, dropping what's older than `keepFrom`. */
export function countNew(tally: Tally[], counted: Record<string, [number, string]>, keepFrom: string): Partial<Record<Word, number>> {
  const out: Partial<Record<Word, number>> = {};
  for (const t of tally) {
    const k = createHash("sha256").update(t.key).digest("base64url").slice(0, 16);
    const before = counted[k]?.[0] ?? 0;
    if (t.n > before) out[t.word] = (out[t.word] ?? 0) + t.n - before;
    counted[k] = [Math.max(before, t.n), counted[k]?.[1] && counted[k][1] < t.date ? counted[k][1] : t.date];
  }
  for (const [k, [, d]] of Object.entries(counted)) if (d < keepFrom) delete counted[k];
  return out;
}

/** Remove this collection's own entries of a source and kind on a day that aren't kept (a busy day's single posts, once its count entry is written). */
async function dropOwn(drops: NonNullable<RecentRead["drop"]>, collection: string): Promise<void> {
  const { extKeys } = await import("../../../lib/days");
  for (const d of drops) {
    const keep = d.keep.flatMap((id) => extKeys(d.source, id));
    const gone = await q<{ id: string }>(
      `DELETE FROM day_entries WHERE source = $1 AND date = $2::date AND kind = $3 AND collection = $4 AND archived_at IS NULL AND NOT (ext_key = ANY($5::text[])) AND NOT (${BY_MODEL_RUN}) RETURNING id`,
      [d.source, d.date, d.kind, collection, keep],
    );
    if (gone.length) await touchDays([d.date]);
  }
}

/** Save a check's health days, sealed (lib/health.ts). Never logged. */
async function saveHealth(days: HealthDay[], opts: { tz: string; now: Date; lifeLogSource?: string }): Promise<void> {
  const { saveHealthDay } = await import("../../../lib/health");
  for (const day of days) await saveHealthDay(day, { tz: opts.tz, now: opts.now, ...(opts.lifeLogSource ? { lifeLogSource: opts.lifeLogSource } : {}) });
}

// ---------- The evening Life log run (runner.ts) ----------

/** Accounts in this Life log that an enabled Plays and watches collection reads: what each check reads (the run leaves those reads to it) and that collection's source. */
export async function hourlyAccounts(collection: Pick<Collection, "recipe" | "connector_ids">): Promise<Map<string, RecentSync & { collection: string; mates: string[]; provider: string }>> {
  const out = new Map<string, RecentSync & { collection: string; mates: string[]; provider: string }>();
  if (collection.recipe !== "life-log") return out;
  const [accounts, collections] = await Promise.all([listConnectors(), listCollections()]);
  for (const c of accounts) {
    const sync = directFor(c)?.recent;
    if (!sync || !collection.connector_ids.includes(c.id) || !hourlyOn(c, collections)) continue;
    const by = checkedBy(collections, c.id)[0];
    // Every listing it reads, and the account's others for a source it writes whole: Claude gets none of them.
    out.set(c.id, { ...sync, tools: [...sync.tools, ...(sync.withhold ?? [])], collection: by.source, mates: by.connector_ids, provider: c.provider });
  }
  return out;
}

/** Sources every enabled Your activity collection writes, whichever Life log (if any) has the account: a Life log writes each day's line from all of them. */
export async function activitySources(): Promise<Array<{ source: string; whole: boolean }>> {
  const [accounts, collections] = await Promise.all([listConnectors(), listCollections()]);
  const out = new Map<string, boolean>();
  for (const c of accounts) {
    const sync = hourlyOn(c, collections) ? directFor(c)?.recent : undefined;
    if (sync) out.set(sync.source, (out.get(sync.source) ?? false) || !!sync.whole);
  }
  return [...out].map(([source, whole]) => ({ source, whole }));
}

/** What the hourly check put in Days over the run's days, for its line and metrics. */
export async function hourlyNote(sources: string[], from: string, to: string): Promise<string> {
  if (!sources.length) return "";
  const days = await entriesInRange(from, to, { limit: 400 });
  const lines = days.flatMap((d) =>
    d.entries
      .filter((e) => sources.includes(e.source))
      .slice(0, 60)
      .map((e) => `- ${d.date} ${e.kind} (${e.source}): ${e.title}${e.subtitle ? ` · ${e.subtitle}` : ""}${e.count && e.count > 1 ? ` ×${e.count}` : ""}${e.kind === "habit" && e.count === 0 ? " (not done)" : ""}`),
  );
  return [
    `Read by Your activity, already in Days: ${sources.join(", ")}. Athena read them without you and you can't call their listings. Don't save their entries, health figures or metrics: Athena saved and counted them. Use what's below for each day's line.`,
    lines.length ? lines.join("\n") : "(nothing from them in these days)",
  ].join("\n");
}

/** Sources the hourly check can write for these accounts, switched on or not: a run never adds a second copy of what it wrote. */
export function checkedSources(accounts: Array<Pick<Connector, "provider" | "auth_type" | "oauth">>): string[] {
  return [...new Set(accounts.flatMap((a) => directFor(a)?.recent?.source ?? []))];
}

/** The day's entries for these sources that no run wrote (the hourly check's, the history load's): what a run's entries are checked against. */
export async function notFromRuns(date: string, sources: ReadonlySet<string>): Promise<DayEntry[]> {
  const [day] = await entriesInRange(date, date, { limit: 2000 });
  const mine = (day?.entries ?? []).filter((e) => sources.has(e.source));
  if (!mine.length) return [];
  const ids = new Set((await q<{ id: string }>(`SELECT id FROM day_entries WHERE id = ANY($1::uuid[]) AND NOT (${BY_MODEL_RUN})`, [mine.map((e) => e.id)])).map((r) => r.id));
  return mine.filter((e) => ids.has(e.id));
}

/** A run's entries for an hourly source that are already on the day (same source, kind and thing): left out. */
export function dropRepeats(entries: Array<{ date: string; entry: EntryInput }>, onDay: DayEntry[], hourly: ReadonlySet<string>): { keep: Array<{ date: string; entry: EntryInput }>; dropped: number; ratings: Array<{ id: string; rating: number }> } {
  const ratings: Array<{ id: string; rating: number }> = [];
  const keep = entries.filter(({ entry }) => {
    if (!hourly.has(entry.source)) return true;
    const there = onDay.find((e) => e.source === entry.source && e.kind === entry.kind && sameThing(e, entry));
    // The run's rating (Trakt's list_ratings) still goes on the entry the hourly check wrote.
    if (there && entry.rating && !there.rating) ratings.push({ id: there.id, rating: entry.rating });
    return !there;
  });
  return { keep, dropped: entries.length - keep.length, ratings };
}

/** Put a run's ratings on entries it didn't write, where they have none. */
export async function addRatings(ratings: Array<{ id: string; rating: number }>, date: string): Promise<void> {
  for (const r of ratings) await q(`UPDATE day_entries SET rating = $2, updated_at = now() WHERE id = $1 AND rating IS NULL`, [r.id, r.rating]);
  if (ratings.length) await touchDays([date]);
}

/** Did the hourly check add or change entries for these sources since then? The evening run still writes the day's line when it did. */
export async function hourlyChangedSince(sources: string[], since: Date | null): Promise<boolean> {
  if (!sources.length) return false;
  const rows = await q<{ n: number }>(`SELECT 1 AS n FROM day_entries WHERE source = ANY($1::text[]) AND NOT (${BY_MODEL_RUN}) AND NOT backfilled AND updated_at > $2 LIMIT 1`, [sources, (since ?? new Date(0)).toISOString()]);
  return rows.length > 0;
}

/** Trakt's ratings, read by the evening run itself: each goes on the watched entry for that title on the day it was rated, where it has none. Never a new entry. */
export async function applyTraktRatings(connectorId: string, since: number, tz: string): Promise<number> {
  const found = await getConnectorWithSecrets(connectorId);
  if (!found || found.connector.provider !== "trakt" || !(found.connector.allowed_tools ?? []).includes("list_ratings")) return 0;
  const { traktRatingsSince } = await import("./media-recent");
  const rated = await traktRatingsSince(found.connector, found.secrets, since, tz);
  let n = 0;
  for (const r of rated) {
    const stars = readRating(r.rating, "trakt");
    if (!stars) continue;
    const onDay = await notFromRuns(r.date, new Set(["trakt"]));
    for (const e of onDay.filter((e) => e.kind === "watched" && !e.rating && matchKey(e.title) === matchKey(r.title))) {
      await q(`UPDATE day_entries SET rating = $2, updated_at = now() WHERE id = $1 AND rating IS NULL`, [e.id, stars]);
      n++;
    }
    if (onDay.length) await touchDays([r.date]);
  }
  return n;
}

// ---------- A Plays and watches run (runner.ts) ----------

export interface PlaysWatchesRun {
  status: "succeeded" | "failed";
  summary: string;
  error?: string;
  stats: RunStatsJson;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const clockTime = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });

/** "6 plays, 1 watch, 2 books, 1 workout", or "Nothing new". */
export function activityLine(n: { plays: number; watches: number; likes: number; counts?: Partial<Record<Word, number>> }): string {
  const all: Partial<Record<Word, number>> = { ...n.counts, play: n.plays, watch: n.watches, like: n.likes };
  const parts = WORDS.flatMap(([one, many]) => (all[one] ? [plural(all[one]!, one, many)] : []));
  return parts.length ? parts.join(", ") : "Nothing new";
}

/** The run's line for plays, watches and likes alone (kept for the run history's older rows). */
export const playsWatchesLine = (n: { plays: number; watches: number; likes: number }) => activityLine(n);

/** One run: each chosen account that has plays and watches, read without a model. Counts only in the summary. */
export async function runPlaysWatches(collection: Pick<Collection, "connector_ids" | "source" | "label">, runId: string, opts: { clock?: () => number } = {}): Promise<PlaysWatchesRun> {
  const tz = await getOwnerTimeZone();
  const total: { plays: number; watches: number; likes: number; counts: Partial<Record<Word, number>> } = { plays: 0, watches: 0, likes: 0, counts: {} };
  const blocked: string[] = [];
  const waits: string[] = [];
  const notes: string[] = [];
  const read: Array<{ connector: Connector; days: string[] }> = [];
  let checked = 0;
  let accounts = 0;
  const lifeLogs = (await listCollections()).filter((c) => c.recipe === "life-log").sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const id of collection.connector_ids) {
    const c = await getConnector(id).catch(() => null);
    if (!c || !checksHourly(c)) continue;
    accounts++;
    if (c.status === "needs_auth" || c.status === "pending") {
      blocked.push(id);
      continue;
    }
    // A health day's line goes in the Life log that reads the account.
    const lifeLogSource = (lifeLogs.find((l) => l.connector_ids.includes(id)) ?? lifeLogs[0])?.source;
    const r = await syncRecent(id, { budgetMs: PER_ACCOUNT_MS, source: collection.source, runId, mates: collection.connector_ids, clock: opts.clock, lifeLogSource }).catch((error): SyncResult => {
      console.error("Athena your activity: a check failed", error instanceof Error ? error.message : "unknown error");
      return { state: "waiting", plays: 0, watches: 0, likes: 0, read: 0, message: `Couldn't reach ${c.name}` };
    });
    total.plays += r.plays;
    total.watches += r.watches;
    total.likes += r.likes;
    for (const [w, n] of Object.entries(r.counts ?? {}) as Array<[Word, number]>) total.counts[w] = (total.counts[w] ?? 0) + n;
    if (r.note) notes.push(r.note);
    if (r.state === "checked") checked++;
    if (r.state === "checked" && r.days) read.push({ connector: c, days: r.days });
    if (r.state === "blocked") blocked.push(id);
    if (r.state === "waiting" && r.message) waits.push(r.resume_at ? `${r.message} · trying again at ${clockTime(r.resume_at, tz)}` : r.message);
  }
  // The Life log's daily counts for what was read, from the day's entries: never from Claude (activity-metrics.ts).
  const { writeActivityMetrics } = await import("./activity-metrics");
  const metrics = await writeActivityMetrics(read, { tz, runId, fallback: collection, lifeLogs }).catch((error) => {
    console.error("Athena your activity: daily counts failed", error instanceof Error ? error.message : "unknown error");
    return 0;
  });
  const stats: RunStatsJson = {
    plays_new: total.plays,
    watches_new: total.watches,
    likes_new: total.likes,
    ...Object.fromEntries((Object.entries(total.counts) as Array<[Word, number]>).filter(([, n]) => n > 0).map(([w, n]) => [statKey(w), n])),
    ...(metrics ? { metrics } : {}),
    accounts_checked: checked,
    waiting: waits.length,
    ...(blocked.length ? { blocked_by: blocked } : {}),
  };
  const summary = [activityLine(total), ...notes, ...waits].join(". ");
  if (!accounts) return { status: "failed", summary: "", error: "None of these accounts has activity Athena can read by itself. Add a music, film, reading, game or health account.", stats };
  if (!checked && blocked.length === accounts) return { status: "failed", summary, error: "Every account needs signing in again.", stats };
  return { status: "succeeded", summary, stats };
}
