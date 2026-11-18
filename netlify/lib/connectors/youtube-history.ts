/**
 * YouTube watch history from Google Takeout, into Days (lib/youtube-takeout.ts
 * has the parser; lib/day-imports.ts what a video becomes).
 *
 * The app parses the file on the device and sends days in batches; each
 * batch lands here. Each video a day is one Day entry (watched, or listened
 * for YouTube Music), keyed by the day and the video's id, so the same file
 * again changes nothing. Entries you hid stay hidden. The day's metric is
 * written when asked. Every other import (Goodreads, Netflix) goes through
 * importToDays too.
 */
import { AthenaInputError, getOwnerTimeZone, q } from "../../../lib/db";
import { isValidDate, zonedToday } from "../../../lib/dates";
import { MAX_ENTRIES_PER_WRITE, writeEntries, type EntryInput } from "../../../lib/days";
import { youtubeEntries } from "../../../lib/day-imports";
import { collectionSource } from "../../../lib/connector-presets";
import { listCollections, replaceDailyMetric, type Connector } from "../../../lib/connectors";
import type { DayVideo, TakeoutDay } from "../../../lib/youtube-takeout";

/** Per request: whole days only, at most this many. */
export const MAX_DAYS = 62;
export const MAX_VIDEOS = 4000;
/** The metric the import fills, before the account suffix. */
export const WATCHED_METRIC = "videos_watched_day";

export interface HistoryTarget {
  /** collected_items.source and notes.source for the day notes. */
  source: string;
  /** The Life log collection the days belong to, when there is one. */
  collection: { id: string; name: string } | null;
  /** videos_watched_day plus this. */
  metric: string;
  tz: string;
}

/**
 * Whose Life log the days go into: the Life log collection that reads this
 * account, else the only (or first) Life log there is, else the source a
 * Life log with this account's label would get, so one made later picks the
 * days up.
 */
export async function historyTarget(account: Connector): Promise<HistoryTarget> {
  const lifeLogs = (await listCollections()).filter((c) => c.recipe === "life-log").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const col = lifeLogs.find((c) => c.connector_ids.includes(account.id)) ?? lifeLogs[0] ?? null;
  const label = col ? col.label : account.account_label;
  const suffix = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    source: col?.source ?? collectionSource("life-log", "", label),
    collection: col ? { id: col.id, name: col.name } : null,
    metric: `${WATCHED_METRIC}${suffix ? `_${suffix}` : ""}`,
    tz: await getOwnerTimeZone(),
  };
}

export interface ImportResult {
  days_created: number;
  days_updated: number;
  /** Already had everything this batch had. */
  days_unchanged: number;
  /** You archived or deleted that day's note. */
  days_skipped: number;
  /** Videos the notes didn't have before (with repeats; not YouTube Music). */
  added: number;
  /** YouTube Music plays likewise. */
  added_tracks: number;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/** The request body's days, checked: whole days, real dates, video ids that are video ids. */
export function readDays(raw: unknown): TakeoutDay[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("days: send at least one day");
  if (raw.length > MAX_DAYS) throw new AthenaInputError(`days: at most ${MAX_DAYS} per request`);
  const seen = new Set<string>();
  let total = 0;
  return raw.map((d) => {
    const day = (d as { day?: unknown })?.day;
    const videos = (d as { videos?: unknown })?.videos;
    if (typeof day !== "string" || !isValidDate(day)) throw new AthenaInputError("days: each needs a day (YYYY-MM-DD)");
    if (seen.has(day)) throw new AthenaInputError(`days: ${day} is in this request twice`);
    seen.add(day);
    if (!Array.isArray(videos) || !videos.length) throw new AthenaInputError(`days: ${day} has no videos`);
    total += videos.length;
    if (total > MAX_VIDEOS) throw new AthenaInputError(`days: at most ${MAX_VIDEOS} videos per request`);
    return {
      day,
      videos: videos.map((v): DayVideo => {
        const o = (v ?? {}) as Record<string, unknown>;
        if (typeof o.id !== "string" || !/^[\w-]{11}$/.test(o.id)) throw new AthenaInputError(`days: ${day} has a video without a YouTube id`);
        const count = typeof o.count === "number" && Number.isInteger(o.count) && o.count > 0 ? Math.min(o.count, 500) : 1;
        return { id: o.id, title: str(o.title, 300), channel: str(o.channel, 120), count, music: o.music === true };
      }),
    };
  });
}

export interface FoldResult {
  days_created: number;
  days_updated: number;
  days_unchanged: number;
  /** Days still to come, and days whose entries you hid. */
  days_skipped: number;
}

/**
 * Write days of an import as Day entries (lib/days.ts), the one path every
 * import shares (Goodreads' and Netflix's too). Safe to repeat: the same
 * days again change nothing. Returns what happened per day, and each
 * entry's outcome in the order `toEntries` gave them.
 */
export async function importToDays<D extends { day: string }>(
  target: HistoryTarget,
  days: D[],
  toEntries: (d: D) => EntryInput[],
  opts: { metric: string | null; metricValue?: (d: D) => number; from: string; now?: Date },
): Promise<FoldResult & { outcomes: Array<{ day: string; entry: EntryInput; action: "created" | "updated" | "unchanged" | "skipped" }> }> {
  const now = opts.now ?? new Date();
  const today = zonedToday(now, target.tz);
  const result: FoldResult = { days_created: 0, days_updated: 0, days_unchanged: 0, days_skipped: 0 };
  const items: Array<{ date: string; entry: EntryInput }> = [];
  const due = days.filter((d) => {
    if (d.day > today) result.days_skipped++;
    return d.day <= today;
  });
  for (const d of due) for (const entry of toEntries(d)) items.push({ date: d.day, entry });
  const outcomes: Array<{ day: string; entry: EntryInput; action: "created" | "updated" | "unchanged" | "skipped" }> = [];
  const perDay = new Map<string, Set<string>>();
  for (let i = 0; i < items.length; i += MAX_ENTRIES_PER_WRITE) {
    const chunk = items.slice(i, i + MAX_ENTRIES_PER_WRITE);
    const w = await writeEntries(chunk, { collection: target.source });
    w.outcomes.forEach((o, j) => {
      outcomes.push({ day: chunk[j].date, entry: chunk[j].entry, action: o.action });
      const set = perDay.get(chunk[j].date) ?? new Set<string>();
      set.add(o.action);
      perDay.set(chunk[j].date, set);
    });
    for (const day of w.new_days) (perDay.get(day) ?? perDay.set(day, new Set()).get(day)!).add("new_day");
  }
  for (const d of due) {
    const seen = perDay.get(d.day) ?? new Set<string>();
    if (seen.has("new_day")) result.days_created++;
    else if (seen.has("created") || seen.has("updated")) result.days_updated++;
    else if (seen.size === 1 && seen.has("skipped")) result.days_skipped++;
    else result.days_unchanged++;
    const value = opts.metricValue?.(d) ?? 0;
    if (opts.metric && value > 0) {
      await replaceDailyMetric({ metric: opts.metric, value, day: d.day, source: target.source, tz: target.tz, metadata: { from: opts.from } });
    }
  }
  return { ...result, outcomes };
}

/** Write a batch of Takeout days as Day entries. Safe to repeat: the same days again change nothing. */
export async function importDays(target: HistoryTarget, days: TakeoutDay[], opts: { metrics: boolean; now?: Date }): Promise<ImportResult> {
  const r = await importToDays(target, days, youtubeEntries, {
    metric: opts.metrics ? target.metric : null,
    metricValue: (d) => d.videos.filter((v) => !v.music).reduce((n, v) => n + v.count, 0),
    from: "youtube-takeout",
    now: opts.now,
  });
  const { outcomes, ...days_ } = r;
  const added = outcomes.filter((o) => o.action === "created");
  return {
    ...days_,
    added: added.filter((o) => o.entry.source === "youtube").reduce((n, o) => n + (o.entry.count ?? 1), 0),
    added_tracks: added.filter((o) => o.entry.source === "youtube_music").reduce((n, o) => n + (o.entry.count ?? 1), 0),
  };
}

// ---------- When each account last imported (every device sees it) ----------

/** settings key per account. Counts and a time only, nothing from the file. */
const IMPORT_KEY = (connectorId: string) => `import.${connectorId}`;

export interface LastImport {
  at: string;
  /** Videos or books in the file. */
  items: number;
  days: number;
  /** Goodreads: of `items`, books to read. */
  to_read?: number;
}

export async function lastImport(connectorId: string): Promise<LastImport | null> {
  const [row] = await q<{ value: LastImport }>(`SELECT value FROM settings WHERE key = $1`, [IMPORT_KEY(connectorId)]);
  return row?.value?.at ? row.value : null;
}

/** After a batch lands: the file's size as the app counted it, and now. */
export async function rememberImport(connectorId: string, file: unknown, now = new Date()): Promise<void> {
  const f = (file ?? {}) as { items?: unknown; days?: unknown; to_read?: unknown };
  const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, 10_000_000) : null);
  const items = count(f.items);
  const days = count(f.days);
  if (items === null || days === null) return;
  const toRead = count(f.to_read);
  const value: LastImport = { at: now.toISOString(), items, days, ...(toRead ? { to_read: Math.min(toRead, items) } : {}) };
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [IMPORT_KEY(connectorId), JSON.stringify(value)]);
}
