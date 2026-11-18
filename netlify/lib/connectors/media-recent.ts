/**
 * The hourly check's streams (media-sync.ts), one set per account, built
 * from the history load's own readers and mappers (backfill-tools.ts,
 * trakt-backfill.ts, youtube-backfill.ts) so the ids match. Each reads from
 * a point in time, newest first: a dated tool is asked with `after`; Trakt's
 * history and YouTube's likes are paged until a page reaches back past it.
 * GETs only, the same requests a Life log run makes.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { zonedParts, zonedToInstant } from "../../../lib/dates";
import type { BackfillStream } from "./backfill";
import { letterboxdRows, listenedEntry, listenSession, mediaServerRows, spotifySavedRows } from "./backfill-tools";
import type { DirectAccount } from "./direct";
import { ServiceError } from "./feeds-shared";
import type { RecentRead, RecentStream, RecentSync } from "./media-sync";
import { historyRow, PAGE_SIZE, traktStreams, type TraktRow } from "./trakt-backfill";
import { TRAKT_READ, TraktSession } from "./trakt-api";

/** Pages a stream reads at most in one check (Last.fm: 200 plays a page). */
export const MAX_PAGES = 10;

/** A play's local day and hour. */
export function playSlot(ms: number, tz: string): { date: string; hour: number } {
  const p = zonedParts(new Date(ms), tz);
  return { date: p.date, hour: p.hour };
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isoOf = (ms: number) => new Date(ms).toISOString();

/** A row's time: played_at or at (UTC), else its day. */
function rowTime(r: Row, tz: string): number | undefined {
  const t = Date.parse(str(r.played_at) ?? str(r.at) ?? "");
  if (Number.isFinite(t)) return t;
  const day = str(r.date) ?? str(r.watched_on) ?? str(r.saved_date);
  return day ? zonedToInstant(day, str(r.time) ?? "00:00", tz).getTime() : undefined;
}

/** Pages of an account's tool from `since` (its `after`), newest first, until it says there's nothing more. */
async function* toolPages(account: Pick<DirectAccount, "call">, tool: string, args: Record<string, unknown>, list: string, since: number): AsyncGenerator<Row[]> {
  let cursor: Record<string, string> = {};
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await account.call(tool, { ...args, after: isoOf(since), ...cursor });
    if (r.isError) throw new Error(r.text.slice(0, 300));
    const body = JSON.parse(r.text) as Row;
    yield Array.isArray(body[list]) ? (body[list] as Row[]) : [];
    if (str(body.next_cursor)) cursor = { cursor: str(body.next_cursor)! };
    else if (str(body.next_page_token)) cursor = { page_token: str(body.next_page_token)! };
    else return;
  }
}

/** A dated tool (Plex, Jellyfin, Letterboxd) mapped by the history load's own mapper. */
export function recentToolStream(account: Pick<DirectAccount, "call">, spec: { tool: string; args?: Record<string, unknown>; list: string; map(rows: Row[], tz: string): Pick<RecentRead, "entries" | "watchRead"> }, tz: string): RecentStream {
  return {
    id: spec.tool,
    tools: [spec.tool],
    async read(since) {
      const out: RecentRead = { entries: [], watchRead: [], read: 0 };
      for await (const rows of toolPages(account, spec.tool, spec.args ?? {}, spec.list, since)) {
        const m = spec.map(rows, tz);
        out.entries.push(...m.entries);
        out.watchRead!.push(...(m.watchRead ?? []));
        out.read += rows.length;
        for (const r of rows) {
          const t = rowTime(r, tz);
          if (t !== undefined && t <= Date.now() + 60_000) out.newest = Math.max(out.newest ?? 0, t);
        }
      }
      return out;
    },
  };
}

/** Plays (Spotify, Last.fm, ListenBrainz), each with its time, folded by album or artist as the history load folds them. */
export function recentPlaysStream(account: Pick<DirectAccount, "call">, opts: { tool: string; source: "spotify" | "lastfm" | "listenbrainz"; limit: number }, tz: string): RecentStream {
  return {
    id: "plays",
    tools: [opts.tool],
    music: opts.source,
    async read(since) {
      const out: RecentRead = { entries: [], plays: [], read: 0 };
      for await (const rows of toolPages(account, opts.tool, { limit: opts.limit }, "items", since)) {
        out.read += rows.length;
        for (const r of rows) {
          const at = rowTime(r, tz);
          const s = listenSession(r);
          if (at === undefined || !s || at < since) continue;
          const { date } = playSlot(at, tz);
          out.plays!.push({ at, date, entry: listenedEntry(opts.source, date, s, 1) });
          out.newest = Math.max(out.newest ?? 0, at);
        }
      }
      return out;
    },
  };
}

/** A history load stream with no time filter (Trakt, YouTube likes): pages from the newest until one reaches back past `since`. */
export function untilSeen(stream: BackfillStream): RecentStream {
  return {
    id: stream.id,
    tools: stream.tools,
    async read(since) {
      const out: RecentRead = { entries: [], watchRead: [], read: 0 };
      let cursor: string | undefined;
      for (let n = 0; n < MAX_PAGES; n++) {
        const page = await stream.page(cursor);
        out.read += page.read;
        const times = [...page.entries.map((e) => Date.parse(e.entry.at ?? "")), ...(page.watchRead ?? []).map((w) => Date.parse(w.at ?? ""))].filter((t) => Number.isFinite(t));
        // Only what's newer than the start: older rows are the history load's.
        const keep = (at: string | undefined) => !at || !Number.isFinite(Date.parse(at)) || Date.parse(at) >= since;
        out.entries.push(...page.entries.filter((e) => keep(e.entry.at)));
        out.watchRead!.push(...(page.watchRead ?? []).filter((w) => keep(w.at)));
        if (times.length) out.newest = Math.max(out.newest ?? 0, ...times);
        if (!page.next || !page.read || (times.length && Math.min(...times) < since)) break;
        cursor = page.next;
      }
      return out;
    },
  };
}

/**
 * A history load stream with no useful order to stop on (a watchlist, playlists by position, subscriptions
 * alphabetically): read whole, keeping only what's dated since then. At most every `everyMs`, so a large
 * library doesn't cost a full read each hour; until then the cursor stays put and the next read covers the gap.
 */
export function fullRead(stream: BackfillStream, opts: { everyMs?: number; maxPages?: number } = {}): RecentStream {
  return {
    id: stream.id,
    tools: stream.tools,
    async read(since, ctx) {
      const now = ctx?.now ?? Date.now();
      const st = ctx?.state;
      if (opts.everyMs && st && typeof st.full === "number" && now - st.full < opts.everyMs) return { entries: [], read: 0 };
      const out: RecentRead = { entries: [], watchRead: [], read: 0 };
      const keep = (at: string | undefined) => !at || !Number.isFinite(Date.parse(at)) || Date.parse(at) >= since;
      let cursor: string | undefined;
      for (let n = 0; n < (opts.maxPages ?? MAX_PAGES * 2); n++) {
        const page = await stream.page(cursor);
        out.read += page.read;
        out.entries.push(...page.entries.filter((e) => keep(e.entry.at)));
        out.watchRead!.push(...(page.watchRead ?? []).filter((w) => keep(w.at)));
        if (!page.next || !page.read) break;
        cursor = page.next;
      }
      if (st) st.full = now;
      return { ...out, newest: now };
    },
  };
}

/** Trakt's playback progress: started and paused, a watched entry with "started, paused at 40%" (the Life log recipe), and a film partway through as reading. */
export function inProgressRows(rows: Array<TraktRow & { progress?: number; paused_at?: string }>, since: number, tz: string): Pick<RecentRead, "entries" | "watchRead"> {
  const out: Pick<RecentRead, "entries" | "watchRead"> = { entries: [], watchRead: [] };
  for (const row of rows) {
    const at = Date.parse(row.paused_at ?? "");
    if (!Number.isFinite(at) || at < since || row.id === undefined) continue;
    const h = historyRow({ ...row, watched_at: row.paused_at }, tz);
    if (!h.entry) continue;
    const note = `started, paused at ${Math.round(row.progress ?? 0)}%`;
    out.entries.push({ date: h.entry.date, entry: { ...h.entry.entry, external_id: `progress:${row.id}`, note } });
    if (h.item) out.watchRead!.push({ ...h.item, status: "reading" });
  }
  return out;
}

/** An account opened the way a run opens it, for its own tools. */
async function opened(connector: Connector, secrets: ConnectorSecrets): Promise<DirectAccount> {
  // Loaded here: direct.ts registers the adapters that use this file.
  const { directFor } = await import("./direct");
  return directFor(connector)!.open(connector, secrets);
}

const plays = (source: "spotify" | "lastfm" | "listenbrainz", tool: string, limit: number): RecentSync => ({
  source,
  tools: [tool],
  async open(connector, secrets, ctx) {
    return [recentPlaysStream(await opened(connector, secrets), { tool, source, limit }, ctx.tz)];
  },
});

const dated = (source: string, tool: string, list: string, limit: number, map: (rows: Row[], tz: string) => Pick<RecentRead, "entries" | "watchRead">): RecentSync => ({
  source,
  tools: [tool],
  async open(connector, secrets, ctx) {
    return [recentToolStream(await opened(connector, secrets), { tool, args: { limit }, list, map }, ctx.tz)];
  },
});

/** Spotify: plays, and Liked Songs and saved albums on the day saved (the history load's ids). Its top items and playlists are Music's, not the Life log's. */
export const spotifyRecent: RecentSync = {
  source: "spotify",
  tools: ["recently_played", "saved_tracks", "saved_albums"],
  withhold: ["top_items", "list_playlists", "list_playlist_tracks"],
  whole: true,
  async open(connector, secrets, ctx) {
    const account = await opened(connector, secrets);
    return [
      recentPlaysStream(account, { tool: "recently_played", source: "spotify", limit: 50 }, ctx.tz),
      recentToolStream(account, { tool: "saved_tracks", args: { limit: 50 }, list: "items", map: spotifySavedRows("tracks") }, ctx.tz),
      recentToolStream(account, { tool: "saved_albums", args: { limit: 50 }, list: "items", map: spotifySavedRows("albums") }, ctx.tz),
    ];
  },
};
export const lastfmRecent: RecentSync = { ...plays("lastfm", "list_scrobbles", 200), withhold: ["top_artists"], whole: true };
export const listenbrainzRecent: RecentSync = { ...plays("listenbrainz", "list_listens", 100), whole: true };
export const plexRecent: RecentSync = { ...dated("plex", "watch_history", "items", 100, mediaServerRows("plex")), whole: true };
export const jellyfinRecent: RecentSync = { ...dated("jellyfin", "watch_history", "items", 100, mediaServerRows("jellyfin")), whole: true };
export const letterboxdRecent: RecentSync = { ...dated("letterboxd", "list_diary", "films", 50, letterboxdRows), whole: true };

const SIX_HOURS = 6 * 3600_000;

/**
 * Trakt: history hourly, the watchlist (added that day: saved), what's partway through (a watched entry
 * "started, paused at 40%"), and ratings into Watch & read every 6 hours. The evening run puts the day's
 * ratings on its watched entries (traktRatingsSince) and writes only the line.
 */
export const traktRecent: RecentSync = {
  source: "trakt",
  tools: ["list_history", "list_ratings", "list_watchlist", "list_in_progress"],
  whole: true,
  async open(connector, secrets, ctx) {
    if (!secrets.tokens) throw new ServiceError("trakt", 401, "Not signed in yet", true);
    const session = new TraktSession(connector, secrets);
    const streams = traktStreams(session, ctx.tz);
    const progress: RecentStream = {
      id: "in_progress",
      tools: ["list_in_progress"],
      async read(since) {
        const r = await session.get<Array<TraktRow & { progress?: number; paused_at?: string }>>("/sync/playback", {});
        const rows = Array.isArray(r.items) ? r.items : [];
        return { ...inProgressRows(rows, since, ctx.tz), read: rows.length, newest: Date.now() };
      },
    };
    return [
      untilSeen(streams.find((s) => s.id === "history")!),
      fullRead(streams.find((s) => s.id === "watchlist")!, { maxPages: 5 }),
      progress,
      fullRead(streams.find((s) => s.id === "ratings")!, { everyMs: SIX_HOURS }),
    ];
  },
};

/** YouTube: liked videos hourly; videos added to the owner's playlists and new subscriptions every 6 hours (each is a whole read). */
export const youtubeRecent: RecentSync = {
  source: "youtube",
  tools: ["list_liked_videos", "list_playlists", "list_playlist_videos", "list_subscriptions"],
  whole: true,
  async open(connector, secrets, ctx) {
    if (!secrets.tokens) throw new ServiceError("youtube", 401, "Not signed in yet", true);
    const { youtubeGet } = await import("./youtube-direct");
    const { youtubeStreams } = await import("./youtube-backfill");
    const get = youtubeGet(connector, secrets);
    const me = await get<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { likes?: string } } }> }>("/channels", { part: "contentDetails", mine: "true" });
    const streams = youtubeStreams(get, me.items?.[0]?.contentDetails?.relatedPlaylists?.likes || "LL", ctx.tz);
    return [untilSeen(streams.find((s) => s.id === "likes")!), fullRead(streams.find((s) => s.id === "playlists")!, { everyMs: SIX_HOURS, maxPages: 40 }), fullRead(streams.find((s) => s.id === "subscriptions")!, { everyMs: SIX_HOURS })];
  },
};

/** Trakt's film and show ratings given since then, with the owner's day: up to five pages, whatever order Trakt sends them in. */
export async function traktRatingsSince(connector: Connector, secrets: ConnectorSecrets, since: number, tz: string, session: Pick<TraktSession, "get"> = new TraktSession(connector, secrets)): Promise<Array<{ date: string; title: string; rating: number }>> {
  if (!secrets.tokens) return [];
  const out: Array<{ date: string; title: string; rating: number }> = [];
  for (let page = 1; page <= 5; page++) {
    const r = await session.get<TraktRow[]>(TRAKT_READ.ratings, { page, limit: PAGE_SIZE });
    for (const row of Array.isArray(r.items) ? r.items : []) {
      const t = Date.parse(row.rated_at ?? "");
      const titled = row.type === "movie" ? row.movie : row.type === "show" ? row.show : undefined;
      if (!titled?.title || !row.rating || !Number.isFinite(t) || t < since) continue;
      out.push({ date: playSlot(t, tz).date, title: titled.title, rating: row.rating });
    }
    if (r.page >= r.pageCount) break;
  }
  return out;
}
