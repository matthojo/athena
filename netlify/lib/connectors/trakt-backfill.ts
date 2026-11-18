/**
 * Trakt's history on connect (backfill.ts): everything watched, rated and
 * on the watchlist, read from api.trakt.tv/sync a page of 100 at a time,
 * newest first. GETs only, through TraktSession (trakt-api.ts).
 *
 *  - History: one watched Day entry per watch (Trakt's own history id, so a
 *    rewatch is its own entry), on the owner's day. An episode is the show
 *    with "S2E3 · Title"; a film is its title and year. Each film is a
 *    watched Watch & read item, each show one being watched.
 *  - Ratings: films and shows into Watch & read with the rating (out of 10,
 *    halved to stars there). A rated show counts as watched. Episode and
 *    season ratings are left out: Watch & read has no place for them.
 *  - Watchlist: films and shows as to-watch items, and a saved Day entry on
 *    the day each was added.
 *
 * The collection (what the owner owns) isn't read: owning a film says
 * nothing about having watched or liked it.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import type { EntryInput } from "../../../lib/days";
import type { WatchReadInput } from "../../../lib/watch-read-sync";
import type { BackfillPage, BackfillStream, HistoryBackfill } from "./backfill";
import { local, ServiceError } from "./feeds-shared";
import { TRAKT_READ, TraktSession } from "./trakt-api";

interface Ids {
  slug?: string;
  trakt?: number;
}
interface Titled {
  title?: string;
  year?: number;
  ids?: Ids;
}
export interface TraktRow {
  id?: number;
  type?: string;
  watched_at?: string;
  listed_at?: string;
  rated_at?: string;
  rating?: number;
  show?: Titled;
  episode?: { season?: number; number?: number; title?: string; ids?: Ids };
  movie?: Titled;
  /** /users/{id}/watched rows. */
  plays?: number;
  last_watched_at?: string;
  seasons?: Array<{ number?: number; episodes?: Array<{ number?: number; plays?: number; last_watched_at?: string }> }>;
}

export const PAGE_SIZE = 100;

const movieUrl = (m?: Titled) => (m?.ids?.slug ? `https://trakt.tv/movies/${m.ids.slug}` : undefined);
const showUrl = (s?: Titled) => (s?.ids?.slug ? `https://trakt.tv/shows/${s.ids.slug}` : undefined);
const idOf = (t?: Titled) => (t?.ids?.trakt !== undefined ? String(t.ids.trakt) : t?.ids?.slug);

/** A film or show as a Watch & read input. */
function title(kind: "film" | "tv", t: Titled, status: WatchReadInput["status"], at: string | undefined, rating?: number): WatchReadInput | null {
  if (!t.title?.trim()) return null;
  const id = idOf(t);
  return {
    kind,
    title: t.title,
    ...(t.year ? { year: t.year } : {}),
    status,
    ...(rating ? { rating } : {}),
    ...(at ? { at } : {}),
    ...(kind === "film" ? (movieUrl(t) ? { url: movieUrl(t) } : {}) : showUrl(t) ? { url: showUrl(t) } : {}),
    ...(id ? { external_id: `${kind === "film" ? "movie" : "show"}:${id}` } : {}),
    source: "trakt",
  };
}

/** One /sync/history row: its Day entry, and the film or show for Watch & read. */
export function historyRow(row: TraktRow, tz: string): { entry?: { date: string; entry: EntryInput }; item?: WatchReadInput } {
  const day = local(row.watched_at, tz).day;
  if (!day || row.id === undefined) return {};
  if (row.episode && row.show?.title) {
    const e = row.episode;
    const se = e.season !== undefined && e.number !== undefined ? `S${e.season}E${e.number}` : "";
    const link = showUrl(row.show);
    const subtitle = [se, e.title].filter(Boolean).join(" · ");
    return {
      entry: {
        date: day,
        entry: {
          kind: "watched",
          source: "trakt",
          external_id: `history:${row.id}`,
          title: row.show.title,
          ...(subtitle ? { subtitle } : {}),
          at: row.watched_at,
          ...(link ? { url: se ? `${link}/seasons/${e.season}/episodes/${e.number}` : link } : {}),
          group: row.show.title,
        },
      },
      item: title("tv", row.show, "reading", row.watched_at) ?? undefined,
    };
  }
  if (row.movie?.title) {
    return {
      entry: {
        date: day,
        entry: {
          kind: "watched",
          source: "trakt",
          external_id: `history:${row.id}`,
          title: row.movie.title,
          ...(row.movie.year ? { subtitle: String(row.movie.year) } : {}),
          at: row.watched_at,
          ...(movieUrl(row.movie) ? { url: movieUrl(row.movie) } : {}),
        },
      },
      item: title("film", row.movie, "done", row.watched_at) ?? undefined,
    };
  }
  return {};
}

/**
 * One /users/{id}/watched row, for when history comes back empty: a film is one
 * watched entry on its last watch; a show is one entry per episode with its
 * last watch (or one for the show when Trakt sends no seasons).
 */
export function watchedRow(kind: "film" | "tv", row: TraktRow, tz: string): { entries: Array<{ date: string; entry: EntryInput }>; item?: WatchReadInput } {
  const t = kind === "film" ? row.movie : row.show;
  const id = idOf(t);
  if (!t?.title || !id) return { entries: [] };
  const at = row.last_watched_at;
  const entries: Array<{ date: string; entry: EntryInput }> = [];
  if (kind === "film") {
    const day = local(at, tz).day;
    if (day) entries.push({ date: day, entry: { kind: "watched", source: "trakt", external_id: `watched:movie:${id}`, title: t.title, ...(t.year ? { subtitle: String(t.year) } : {}), at, ...(movieUrl(t) ? { url: movieUrl(t) } : {}) } });
    return { entries, item: title("film", t, "done", at) ?? undefined };
  }
  const link = showUrl(t);
  for (const s of row.seasons ?? []) {
    for (const e of s.episodes ?? []) {
      const day = local(e.last_watched_at, tz).day;
      if (!day || s.number === undefined || e.number === undefined) continue;
      entries.push({ date: day, entry: { kind: "watched", source: "trakt", external_id: `watched:episode:${id}:${s.number}:${e.number}`, title: t.title, subtitle: `S${s.number}E${e.number}`, at: e.last_watched_at, ...(link ? { url: `${link}/seasons/${s.number}/episodes/${e.number}` } : {}), group: t.title } });
    }
  }
  if (!entries.length) {
    const day = local(at, tz).day;
    if (day) entries.push({ date: day, entry: { kind: "watched", source: "trakt", external_id: `watched:show:${id}`, title: t.title, ...(t.year ? { subtitle: String(t.year) } : {}), at, ...(link ? { url: link } : {}), group: t.title } });
  }
  return { entries, item: title("tv", t, "reading", at) ?? undefined };
}

/** One /sync/ratings row: a rated film or show, as watched, with its rating. Episodes and seasons: nothing. */
export function ratingRow(row: TraktRow): WatchReadInput | null {
  if (!row.rating) return null;
  if (row.type === "movie" && row.movie) return title("film", row.movie, "done", row.rated_at, row.rating);
  if (row.type === "show" && row.show) return title("tv", row.show, "done", row.rated_at, row.rating);
  return null;
}

/** One /sync/watchlist row: a to-watch item, and a saved Day entry on the day it was added. */
export function watchlistRow(row: TraktRow, tz: string): { entry?: { date: string; entry: EntryInput }; item?: WatchReadInput } {
  const t = row.type === "movie" ? row.movie : row.type === "show" ? row.show : undefined;
  const kind = row.type === "movie" ? "film" : "tv";
  if (!t?.title) return {};
  const item = title(kind, t, "queued", row.listed_at) ?? undefined;
  const day = local(row.listed_at, tz).day;
  const id = idOf(t);
  const url = kind === "film" ? movieUrl(t) : showUrl(t);
  return {
    item,
    ...(day && id
      ? { entry: { date: day, entry: { kind: "saved", source: "trakt", external_id: `watchlist:${row.type}:${id}`, title: t.title, ...(t.year ? { subtitle: String(t.year) } : {}), at: row.listed_at, ...(url ? { url } : {}), note: "watchlist" } } }
      : {}),
  };
}

type Get = Pick<TraktSession, "get">;

/** A paged /sync list as a stream: the cursor is the page number. */
function paged(id: string, tool: string, session: Get, path: string, map: (rows: TraktRow[]) => Omit<BackfillPage, "read" | "next">): BackfillStream {
  return {
    id,
    tools: [tool],
    async page(cursor) {
      const page = cursor ? Number(cursor) : 1;
      if (!Number.isInteger(page) || page < 1) throw new ServiceError("trakt", 400, "Athena lost its place in your Trakt history. Load it again.");
      const r = await session.get<TraktRow[]>(path, { page, limit: PAGE_SIZE });
      const rows = Array.isArray(r.items) ? r.items : [];
      // Counts only: what Trakt said it has, against what came back.
      if (page === 1) console.log(`Athena backfill (trakt): ${id} reply ${r.bytes} bytes, ${rows.length} rows, Trakt counts ${r.itemCount ?? "nothing"} in all${Array.isArray(r.items) ? "" : ", not a list"}`);
      return { ...map(rows), read: rows.length, next: r.page < r.pageCount && rows.length ? String(r.page + 1) : undefined };
    },
  };
}

/**
 * Films or shows from /users/{id}/watched, only when Trakt's history has
 * nothing (it's checked with one small request first), so the same watches are
 * never loaded twice.
 */
function watchedStream(kind: "film" | "tv", session: Get, tz: string): BackfillStream {
  const type = kind === "film" ? "movies" : "shows";
  return {
    id: `watched_${type}`,
    tools: ["list_history"],
    async page(cursor) {
      const page = cursor ? Number(cursor) : 1;
      if (!Number.isInteger(page) || page < 1) throw new ServiceError("trakt", 400, "Athena lost its place in your Trakt history. Load it again.");
      if (page === 1) {
        const h = await session.get<TraktRow[]>(TRAKT_READ.history, { page: 1, limit: 1 });
        const has = (Array.isArray(h.items) && h.items.length > 0) || (h.itemCount ?? 0) > 0;
        console.log(`Athena backfill (trakt): watched_${type} ${has ? "not needed, history has items" : "used, history came back empty"}`);
        if (has) return { entries: [], watchRead: [], read: 0 };
      }
      const r = await session.get<TraktRow[]>(TRAKT_READ.watched(type), { page, limit: PAGE_SIZE, ...(kind === "tv" ? {} : { extended: "min" }) });
      const rows = Array.isArray(r.items) ? r.items : [];
      if (page === 1) console.log(`Athena backfill (trakt): watched_${type} reply ${r.bytes} bytes, ${rows.length} rows, Trakt counts ${r.itemCount ?? "nothing"} in all`);
      const out = rows.map((row) => watchedRow(kind, row, tz));
      return { entries: out.flatMap((o) => o.entries), watchRead: out.flatMap((o) => (o.item ? [o.item] : [])), read: rows.length, next: r.page < r.pageCount && rows.length ? String(r.page + 1) : undefined };
    },
  };
}

export function traktStreams(session: Get, tz: string): BackfillStream[] {
  const both = (rows: TraktRow[], f: (r: TraktRow) => { entry?: { date: string; entry: EntryInput }; item?: WatchReadInput }) => {
    const out = rows.map(f);
    // One Watch & read input per film or show a page: the newest watch, which comes first.
    const seen = new Set<string>();
    const watchRead = out.flatMap((o) => {
      const k = o.item && `${o.item.kind}:${o.item.external_id ?? o.item.title}`;
      if (!o.item || seen.has(k!)) return [];
      seen.add(k!);
      return [o.item];
    });
    return { entries: out.flatMap((o) => (o.entry ? [o.entry] : [])), watchRead };
  };
  return [
    paged("history", "list_history", session, TRAKT_READ.history, (rows) => both(rows, (r) => historyRow(r, tz))),
    watchedStream("film", session, tz),
    watchedStream("tv", session, tz),
    paged("ratings", "list_ratings", session, TRAKT_READ.ratings, (rows) => ({ entries: [], watchRead: rows.map(ratingRow).filter((x): x is WatchReadInput => !!x) })),
    paged("watchlist", "list_watchlist", session, TRAKT_READ.watchlist, (rows) => both(rows, (r) => watchlistRow(r, tz))),
  ];
}

export const traktBackfill: HistoryBackfill = {
  tools: ["list_history", "list_ratings", "list_watchlist"],
  async open(connector: Connector, secrets: ConnectorSecrets, ctx) {
    if (!secrets.tokens) throw new ServiceError("trakt", 401, "Not signed in yet", true);
    return traktStreams(new TraktSession(connector, secrets), ctx.tz);
  },
};
