/**
 * The Life log's daily counts for what Your activity reads:
 * books_finished_day, game_minutes_day, chess_games_day,
 * posts_made_day, highlights_made_day and the film, episode, video and
 * track counts, worked out from the day's entries in Days, never by Claude.
 * Written under the Life log's own name and source (its label as the
 * suffix), the way the imports write theirs (youtube-history.ts
 * historyTarget), so the series carries on from what Claude used to write.
 *
 * Each hourly check recounts the days it read; the evening Life log run
 * recounts its window after Claude, so a source Claude still reads (in a
 * count shared with a covered one, like posts) is in the figure too. A rerun
 * replaces the day's value. A source that isn't read gets no metric; one
 * read with nothing that day gets 0.
 */
import { listCollections, replaceDailyMetric, type Collection, type Connector } from "../../../lib/connectors";
import { q } from "../../../lib/db";
import type { DayEntryKind } from "../../../lib/days";
import { TOP_NOTE } from "./activity-recent";

interface Row {
  id: string;
  date: string;
  kind: DayEntryKind;
  source: string;
  count: number;
  minutes: number | null;
  note: string | null;
  grp: string | null;
  folded_into: string | null;
}

const WATCHING = ["trakt", "letterboxd", "plex", "jellyfin"];

/** A metric, the sources that make it, and its value from the day's entries (undefined: leave the day without one). */
export const METRICS: Array<{ name: string; sources: string[]; value(rows: Row[]): number | undefined }> = [
  { name: "books_finished_day", sources: ["goodreads"], value: (rs) => rs.filter((r) => r.source === "goodreads" && r.kind === "read" && r.note === "finished").length },
  { name: "highlights_made_day", sources: ["readwise"], value: (rs) => sum(rs.filter((r) => r.source === "readwise" && r.kind === "highlight")) },
  {
    name: "game_minutes_day",
    sources: ["steam"],
    // Minutes come from the day before's total: with a game that has none, the day's figure isn't known.
    value: (rs) => {
      const games = rs.filter((r) => r.source === "steam" && r.kind === "played");
      return games.some((g) => g.minutes === null) ? undefined : games.reduce((n, g) => n + (g.minutes ?? 0), 0);
    },
  },
  { name: "chess_games_day", sources: ["lichess", "chesscom"], value: (rs) => sum(rs.filter((r) => r.kind === "chess" && (r.source === "lichess" || r.source === "chesscom"))) },
  // A busy day's most liked posts are in its count entry already.
  { name: "posts_made_day", sources: ["reddit", "bluesky", "mastodon"], value: (rs) => sum(rs.filter((r) => r.kind === "posted" && ["reddit", "bluesky", "mastodon"].includes(r.source) && r.note !== TOP_NOTE)) },
  // Watched entries folded together (Trakt and Letterboxd, or into Netflix's) are one film or episode.
  { name: "episodes_watched_day", sources: WATCHING, value: (rs) => sum(watched(rs).filter((r) => r.grp)) },
  { name: "films_watched_day", sources: WATCHING, value: (rs) => watched(rs).filter((r) => !r.grp).length },
  { name: "videos_saved_day", sources: ["youtube"], value: (rs) => sum(rs.filter((r) => r.source === "youtube" && r.kind === "saved" && !r.folded_into)) },
  { name: "tracks_played_day", sources: ["spotify", "lastfm", "listenbrainz"], value: (rs) => sum(rs.filter((r) => r.kind === "listened" && ["spotify", "lastfm", "listenbrainz"].includes(r.source))) },
];

const sum = (rs: Row[]) => rs.reduce((n, r) => n + r.count, 0);

/** The day's watched films and episodes from a watching source, once each: a copy folded into another entry counts as that entry. */
function watched(rs: Row[]): Row[] {
  const byId = new Map(rs.map((r) => [r.id, r]));
  const out = new Map<string, Row>();
  for (const r of rs) {
    if (r.kind !== "watched" || !WATCHING.includes(r.source)) continue;
    const top = r.folded_into ? (byId.get(r.folded_into) ?? r) : r;
    out.set(top.id, { ...top, count: Math.max(top.count, r.count), grp: top.grp ?? r.grp });
  }
  return [...out.values()];
}

/** The metrics these providers make: Claude doesn't send them for a Life log whose accounts Your activity reads. */
export function metricsFor(providers: Iterable<string>): string[] {
  const p = new Set(providers);
  return METRICS.filter((m) => m.sources.some((s) => p.has(s))).map((m) => m.name);
}

const suffixOf = (label: string) => {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s ? `_${s}` : "";
};

/** Every day's value of each metric these accounts make, from Days. */
export async function metricValues(dates: string[], providers: Iterable<string>): Promise<Array<{ name: string; day: string; value: number }>> {
  const names = new Set(metricsFor(providers));
  if (!dates.length || !names.size) return [];
  const rows = await q<Row>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, kind, source, count, minutes, note, grp, folded_into FROM day_entries WHERE date = ANY($1::date[]) AND archived_at IS NULL`,
    [dates],
  );
  const out: Array<{ name: string; day: string; value: number }> = [];
  for (const day of [...new Set(dates)].sort()) {
    const on = rows.filter((r) => r.date === day);
    for (const m of METRICS) {
      if (!names.has(m.name)) continue;
      const value = m.value(on);
      if (value !== undefined) out.push({ name: m.name, day, value });
    }
  }
  return out;
}

/**
 * Recount the days each account was read for, in each Life log that reads
 * it (or the Your activity collection itself when none does). Returns how
 * many values were written.
 */
export async function writeActivityMetrics(
  read: Array<{ connector: Pick<Connector, "id" | "provider">; days: string[] }>,
  opts: { tz: string; runId?: string; fallback?: Pick<Collection, "source" | "label">; lifeLogs?: Collection[] },
): Promise<number> {
  if (!read.some((r) => r.days.length)) return 0;
  const lifeLogs = opts.lifeLogs ?? (await listCollections()).filter((c) => c.recipe === "life-log");
  // Each day with the providers read for it: a day only one account was read for gets only that account's counts.
  const targets = new Map<string, { target: Pick<Collection, "source" | "label">; days: Map<string, Set<string>> }>();
  for (const r of read) {
    const logs: Array<Pick<Collection, "source" | "label">> = lifeLogs.filter((l) => l.connector_ids.includes(r.connector.id));
    // An account no Life log has: its counts go with the first Life log (it writes the line from Days anyway), else under Your activity.
    if (!logs.length) {
      const first = [...lifeLogs].sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? opts.fallback;
      if (first) logs.push(first);
    }
    for (const l of logs) {
      const t = targets.get(l.source) ?? { target: l, days: new Map<string, Set<string>>() };
      for (const d of r.days) t.days.set(d, (t.days.get(d) ?? new Set<string>()).add(r.connector.provider));
      targets.set(l.source, t);
    }
  }
  let n = 0;
  for (const { target, days } of targets.values()) {
    for (const [day, providers] of days) {
      for (const v of await metricValues([day], providers)) {
        await replaceDailyMetric({ metric: `${v.name}${suffixOf(target.label)}`, value: v.value, day: v.day, source: target.source, tz: opts.tz, metadata: { by: "your-activity", ...(opts.runId ? { run_id: opts.runId } : {}) } });
        n++;
      }
    }
  }
  return n;
}
