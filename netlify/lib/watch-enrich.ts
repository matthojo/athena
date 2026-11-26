/**
 * Watch & read learns about its titles: the year, the running time, genres,
 * the playlists a video is in and the seasons a film suits. Stored sealed in
 * `reading_items.meta` (lib/watch-meta.ts has the shape and the rules).
 *
 * Each item is asked about once, by GET /api/reading, in the background and
 * within a budget; anything left is done on a later load. An item whose
 * sources had nothing is asked again after a fortnight.
 *
 *  - A YouTube video (any item whose link is one): the playlists it was
 *    saved to, from Days (the history load wrote them there); its length,
 *    topics and category from the Data API's `videos`, 50 ids a request
 *    (1 unit of the owner's quota), through the connected YouTube account.
 *  - A film or a show: TMDB's search and details (genres, running time,
 *    year, keywords for seasons) when the owner added a TMDB key. Without
 *    one, an item that came from Trakt is asked of Trakt.
 *  - A book: Open Library's search (first published, pages, subjects).
 *  - Anything else has no source: marked as looked at, nothing asked.
 *
 * Only titles and ids the item already holds are sent, to the service it
 * came from or the lookups art already uses (docs: security/outside-services). Never throws.
 */
import { artKeys, ArtFetchError, safeFetch, tmdbAuth } from "../../lib/art";
import { getConnectorWithSecrets, listConnectors, type Connector, type ConnectorSecrets } from "../../lib/connectors";
import { q, sealer } from "../../lib/db";
import { isEncryptedPlaceholder } from "../../lib/encrypted";
import { bookGenres, isoMinutes, mergeMeta, nameList, readMeta, sameMeta, themesFromKeywords, youtubeGenres, youtubeId, type WatchMeta } from "../../lib/watch-meta";

/** A source with nothing to say is asked again after this long. */
export const RECHECK_MS = 14 * 86_400_000;
/** Films, shows and books looked up per run: each is one or two requests. */
const TITLES_PER_RUN = 8;
const DEFAULT_BUDGET_MS = 8_000;

export interface EnrichRow {
  id: string;
  kind: string;
  title: string;
  author: string;
  url: string;
  sync: unknown;
  meta: unknown;
}

// ---------- What each source's reply says (pure) ----------

export interface YtVideo {
  id?: string;
  snippet?: { publishedAt?: string; categoryId?: string };
  contentDetails?: { duration?: string };
  topicDetails?: { topicCategories?: string[] };
}

const yearOf = (date: unknown): number | undefined => {
  const y = typeof date === "string" ? Number(/^(\d{4})/.exec(date)?.[1]) : NaN;
  return Number.isInteger(y) && y >= 1800 && y <= 2200 ? y : undefined;
};

/** A video's length, year, genres and whether it's music. */
export function youtubeVideoMeta(v: YtVideo): WatchMeta {
  const { genres, music } = youtubeGenres(v.topicDetails?.topicCategories, v.snippet?.categoryId);
  return readMeta({ year: yearOf(v.snippet?.publishedAt), minutes: isoMinutes(v.contentDetails?.duration), genres, ...(music ? { music: true } : {}) });
}

export interface TmdbDetails {
  genres?: Array<{ name?: string }>;
  runtime?: number | null;
  episode_run_time?: number[];
  release_date?: string;
  first_air_date?: string;
  keywords?: { keywords?: Array<{ name?: string }>; results?: Array<{ name?: string }> };
}

/** A film's or show's genres, running time (a show's: one episode), year and seasons. */
export function tmdbMeta(d: TmdbDetails): WatchMeta {
  const minutes = typeof d.runtime === "number" && d.runtime > 0 ? d.runtime : d.episode_run_time?.find((n) => typeof n === "number" && n > 0);
  const keywords = [...(d.keywords?.keywords ?? []), ...(d.keywords?.results ?? [])].map((k) => k.name);
  return readMeta({
    year: yearOf(d.release_date ?? d.first_air_date),
    minutes: minutes ? Math.round(minutes) : undefined,
    genres: (d.genres ?? []).map((g) => g.name),
    themes: themesFromKeywords(keywords),
  });
}

export interface TraktSummary {
  year?: number;
  runtime?: number;
  genres?: string[];
}

/** Trakt's genres are slugs ("science-fiction"): shown as words. */
export function traktMeta(t: TraktSummary): WatchMeta {
  const genres = (t.genres ?? []).filter((g): g is string => typeof g === "string").map((g) => g.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));
  return readMeta({ year: t.year, minutes: typeof t.runtime === "number" && t.runtime > 0 ? Math.round(t.runtime) : undefined, genres, themes: themesFromKeywords(genres) });
}

export interface OpenLibraryDoc {
  title?: string;
  first_publish_year?: number;
  number_of_pages_median?: number;
  subject?: string[];
}

const fold = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*[:(\[].*$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");

/** The first result that is this book (same title, subtitles and series aside), as meta. Null: none is. */
export function openLibraryMeta(docs: OpenLibraryDoc[] | undefined, title: string): WatchMeta | null {
  const want = fold(title);
  const doc = (docs ?? []).find((d) => typeof d.title === "string" && fold(d.title) === want);
  if (!doc) return null;
  return readMeta({ year: doc.first_publish_year, pages: doc.number_of_pages_median, genres: bookGenres(doc.subject) });
}

/** The Trakt path for an item a Trakt sync made: "/movies/dune-2021". Null when no source key or link says. */
export function traktPath(row: Pick<EnrichRow, "url" | "sync">): string | null {
  const keys: string[] = [];
  let state = row.sync;
  if (typeof state === "string") {
    try {
      state = JSON.parse(state);
    } catch {
      state = null;
    }
  }
  if (state && typeof state === "object" && Array.isArray((state as { keys?: unknown }).keys)) keys.push(...(state as { keys: unknown[] }).keys.filter((k): k is string => typeof k === "string"));
  const fromLink = /^https:\/\/trakt\.tv\/(movies|shows)\/([\w-]+)/i.exec(row.url ?? "");
  if (fromLink) keys.push(`trakt:${fromLink[1].toLowerCase()}:${fromLink[2].toLowerCase()}`);
  for (const k of keys) {
    const m = /^trakt:(movies|shows):([\w-]{1,200})$/.exec(k);
    if (m) return `/${m[1]}/${m[2]}`;
  }
  return null;
}

/** Playlists by video id, from the saved entries the YouTube history load wrote to Days. */
export function playlistsByVideo(entries: Array<{ url: string | null; grp: string | null }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const id = youtubeId(e.url);
    const name = (e.grp ?? "").trim();
    if (!id || !name || name === "playlist" || isEncryptedPlaceholder(name)) continue;
    out.set(id, nameList([...(out.get(id) ?? []), name], 12, 120));
  }
  return out;
}

/** Is this item due a look: never asked, or asked a fortnight ago and still bare. */
export function due(meta: WatchMeta, now: number): boolean {
  if (!meta.checked) return true;
  const bare = !meta.genres?.length && !meta.minutes && !meta.pages;
  return bare && now - Date.parse(meta.checked) > RECHECK_MS;
}

// ---------- The sources (swapped in tests) ----------

export interface EnrichSources {
  /** Details of up to 50 videos, or null when no YouTube account is connected. */
  youtubeVideos(ids: string[]): Promise<YtVideo[] | null>;
  /** Saved YouTube entries with a playlist, from Days. */
  youtubeSaves(): Promise<Array<{ url: string | null; grp: string | null }>>;
  /** TMDB's details for a title, null when it has none; undefined when there's no key. */
  tmdb(kind: "movie" | "tv", title: string, year: number | undefined): Promise<TmdbDetails | null | undefined>;
  /** Trakt's summary for a path, or undefined when no Trakt account is connected. */
  trakt(path: string): Promise<TraktSummary | null | undefined>;
  openLibrary(title: string, author: string): Promise<OpenLibraryDoc[]>;
}

async function connected(provider: string): Promise<{ connector: Connector; secrets: ConnectorSecrets } | null> {
  const found = (await listConnectors()).find((c) => c.provider === provider && c.status === "connected");
  return found ? getConnectorWithSecrets(found.id) : null;
}

const json = async <T>(url: string, headers: Record<string, string> = {}): Promise<T> => JSON.parse((await safeFetch(url, { accept: "json", headers, maxBytes: 1024 * 1024 })).toString("utf8")) as T;

const live: EnrichSources = {
  async youtubeVideos(ids) {
    const account = await connected("youtube");
    if (!account?.secrets.tokens) return null;
    // Loaded here: the connector code is heavy, and most loads have nothing to ask.
    const { youtubeGet } = await import("./connectors/youtube-direct");
    const get = youtubeGet(account.connector, account.secrets);
    const r = await get<{ items?: YtVideo[] }>("/videos", { part: "snippet,contentDetails,topicDetails", id: ids.join(","), maxResults: 50 });
    return r.items ?? [];
  },
  youtubeSaves: () => q<{ url: string | null; grp: string | null }>(`SELECT url, grp FROM day_entries WHERE source = 'youtube' AND kind = 'saved' AND grp IS NOT NULL AND archived_at IS NULL`),
  async tmdb(kind, title, year) {
    const key = await artKeys.tmdb();
    if (!key) return undefined;
    const auth = tmdbAuth(key);
    const search = new URL(`https://api.themoviedb.org/3/search/${kind}`);
    search.searchParams.set("query", title);
    search.searchParams.set("include_adult", "false");
    if (year) search.searchParams.set(kind === "movie" ? "primary_release_year" : "first_air_date_year", String(year));
    for (const [k, v] of Object.entries(auth.params)) search.searchParams.set(k, v);
    const found = await json<{ results?: Array<{ id?: number }> }>(search.toString(), auth.headers);
    const id = found.results?.find((r) => Number.isInteger(r.id) && (r.id as number) > 0)?.id;
    if (!id) return null;
    const details = new URL(`https://api.themoviedb.org/3/${kind}/${id}`);
    details.searchParams.set("append_to_response", "keywords");
    for (const [k, v] of Object.entries(auth.params)) details.searchParams.set(k, v);
    return json<TmdbDetails>(details.toString(), auth.headers);
  },
  async trakt(path) {
    const account = await connected("trakt");
    if (!account?.secrets.tokens) return undefined;
    const { TraktSession } = await import("./connectors/trakt-api");
    const r = await new TraktSession(account.connector, account.secrets).get<TraktSummary>(path, { extended: "full" });
    return r.items ?? null;
  },
  async openLibrary(title, author) {
    const u = new URL("https://openlibrary.org/search.json");
    u.searchParams.set("q", [title, author].filter(Boolean).join(" "));
    u.searchParams.set("limit", "5");
    u.searchParams.set("fields", "title,first_publish_year,number_of_pages_median,subject");
    return (await json<{ docs?: OpenLibraryDoc[] }>(u.toString())).docs ?? [];
  },
};

/** A lookup that answered "no such thing" (so don't ask again soon), as opposed to one that couldn't be reached. */
const answeredNo = (error: unknown): boolean => error instanceof ArtFetchError && error.reason === "http" && /^4\d\d$/.test(error.message) && error.message !== "429";

export interface EnrichResult {
  /** Items that were due a look. */
  due: number;
  /** Of those, how many were looked at this run. */
  looked: number;
  /** How many learned something. */
  learned: number;
}

/**
 * Look up what isn't known yet and write it. `rows` are the stored items
 * (meta and sync as stored, opened). Never throws: an item a source couldn't
 * be reached for is left for next time.
 */
export async function enrichRows(rows: EnrichRow[], opts: { sources?: EnrichSources; budgetMs?: number; now?: Date; write: (id: string, meta: WatchMeta) => Promise<void> }): Promise<EnrichResult> {
  const src = opts.sources ?? live;
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const stamp = now.toISOString();
  const todo = rows.filter((r) => r.title && !isEncryptedPlaceholder(r.title) && due(readMeta(r.meta), now.getTime()));
  const result: EnrichResult = { due: todo.length, looked: 0, learned: 0 };
  if (!todo.length) return result;

  const save = async (row: EnrichRow, learned: WatchMeta) => {
    const kept = readMeta(row.meta);
    const next = mergeMeta(kept, { ...learned, checked: stamp });
    result.looked++;
    if (!sameMeta({ ...kept, checked: undefined }, { ...next, checked: undefined })) result.learned++;
    await opts.write(row.id, next).catch(() => undefined);
  };

  // ---- YouTube: playlists from Days, the rest from the Data API ----
  const videos = todo.filter((r) => youtubeId(r.url));
  if (videos.length) {
    const lists = await src.youtubeSaves().then(playlistsByVideo, () => new Map<string, string[]>());
    for (let i = 0; i < videos.length && Date.now() < deadline; i += 50) {
      const batch = videos.slice(i, i + 50);
      let found: YtVideo[] | null;
      try {
        found = await src.youtubeVideos(batch.map((r) => youtubeId(r.url)!));
      } catch {
        // Quota, or the account needs signing in again: playlists still land, the rest waits.
        found = null;
      }
      const byId = new Map((found ?? []).map((v) => [v.id, v]));
      for (const row of batch) {
        const id = youtubeId(row.url)!;
        const learned: WatchMeta = { ...(byId.has(id) ? youtubeVideoMeta(byId.get(id)!) : {}), ...(lists.has(id) ? { lists: lists.get(id) } : {}) };
        // Not reached: keep what Days knew, and leave it due so the API is asked next time.
        if (found === null) {
          if (learned.lists?.length && !sameMeta(readMeta(row.meta), mergeMeta(readMeta(row.meta), learned))) {
            await opts.write(row.id, mergeMeta(readMeta(row.meta), learned)).catch(() => undefined);
            result.learned++;
          }
          continue;
        }
        await save(row, learned);
      }
    }
  }

  // ---- Everything else ----
  let asked = 0;
  for (const row of todo) {
    if (youtubeId(row.url)) continue;
    const kept = readMeta(row.meta);
    if (row.kind !== "film" && row.kind !== "tv" && row.kind !== "book") {
      await save(row, {});
      continue;
    }
    if (asked >= TITLES_PER_RUN || Date.now() >= deadline) continue;
    asked++;
    try {
      if (row.kind === "book") {
        await save(row, openLibraryMeta(await src.openLibrary(row.title, row.author), row.title) ?? {});
        continue;
      }
      let state: { year?: number } | null = null;
      try {
        state = typeof row.sync === "string" ? JSON.parse(row.sync) : (row.sync as { year?: number } | null);
      } catch {
        state = null;
      }
      const year = kept.year ?? (Number.isInteger(state?.year) ? state!.year : undefined);
      const fromTmdb = await src.tmdb(row.kind === "film" ? "movie" : "tv", row.title, year);
      if (fromTmdb !== undefined) {
        await save(row, fromTmdb ? tmdbMeta(fromTmdb) : {});
        continue;
      }
      const path = traktPath(row);
      const fromTrakt = path ? await src.trakt(path) : undefined;
      // No key and no Trakt account: nothing to ask. Looked at, so it isn't walked on every load.
      await save(row, fromTrakt ? traktMeta(fromTrakt) : {});
    } catch (error) {
      if (answeredNo(error)) await save(row, {});
      // Otherwise: unreachable just now. Left due.
    }
  }
  return result;
}

/** The whole of it, against the database: what GET /api/reading runs in the background. */
export async function enrichReading(opts: { budgetMs?: number } = {}): Promise<EnrichResult> {
  try {
    const rows = await q<EnrichRow>(`SELECT id, kind, title, author, url, sync, meta FROM reading_items WHERE archived_at IS NULL`);
    const s = await sealer();
    return await enrichRows(rows, {
      budgetMs: opts.budgetMs,
      // updated_at stays: learning a film's running time isn't the owner editing it.
      write: async (id, meta) => {
        // Tags are the owner's, and may have changed since the rows were read: theirs as stored now win.
        const [now] = await q<{ meta: unknown }>(`SELECT meta FROM reading_items WHERE id = $1`, [id]);
        if (!now) return;
        const tags = readMeta(now.meta).tags;
        const next = { ...meta };
        if (tags?.length) next.tags = tags;
        else delete next.tags;
        await q(`UPDATE reading_items SET meta = $2::jsonb WHERE id = $1`, [id, s.json(next)]);
      },
    });
  } catch {
    return { due: 0, looked: 0, learned: 0 };
  }
}
