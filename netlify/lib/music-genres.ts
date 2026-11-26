/**
 * Music learns each artist's genres, for its genre radar (lib/genre-mix.ts
 * folds them into families). Kept sealed in one settings row
 * (lib/music-genre-store.ts).
 *
 * Asked by GET /api/life/music, in the background after it replies and
 * within a budget: the period's artists, most played first. Anything left
 * is asked on a later load. An artist neither source knew is asked again
 * after a month.
 *
 *  - Spotify first, when a Spotify account is connected: one search for
 *    the artist by name (`/search?type=artist`), whose artists carry their
 *    genres. Only an exact name match counts. Spotify has been listing
 *    fewer genres since 2025, so an answer with none falls through.
 *  - MusicBrainz otherwise (no key, no account): one search, whose artists
 *    carry their community tags with vote counts, strongest kept first.
 *    MusicBrainz asks for one request a second and a User-Agent naming the
 *    app (safeFetch sends one), so its lookups are spaced.
 *
 * Only the artist's name is sent: a performer, not one of the owner's
 * contacts (docs: security/outside-services). Never throws.
 */
import { ArtFetchError, safeFetch } from "../../lib/art";
import { getConnectorWithSecrets, listConnectors } from "../../lib/connectors";
import { artistKey } from "../../lib/genre-mix";
import { due, loadGenreBook, saveGenres, type ArtistGenres, type GenreBook } from "../../lib/music-genre-store";

/** Artists looked up per run. */
const ARTISTS_PER_RUN = 12;
const DEFAULT_BUDGET_MS = 8_000;
/** MusicBrainz's rate: one request a second, with a little room. */
export const MUSICBRAINZ_GAP_MS = 1_100;

// ---------- What each source's reply says (pure) ----------

export interface SpotifyArtist {
  name?: string;
  genres?: string[];
}

/** The genres of the artist whose name matches exactly; null when none does. */
export function spotifyGenres(items: SpotifyArtist[] | undefined, name: string): string[] | null {
  const key = artistKey(name);
  const hit = (items ?? []).find((a) => typeof a.name === "string" && artistKey(a.name) === key);
  if (!hit) return null;
  return (hit.genres ?? []).filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim().toLowerCase());
}

export interface MbArtist {
  name?: string;
  score?: number;
  aliases?: Array<{ name?: string }>;
  tags?: Array<{ name?: string; count?: number }>;
}

/** The best-scoring artist whose name (or an alias) matches; its tags with votes, most voted first. Null when none matches. */
export function musicbrainzGenres(artists: MbArtist[] | undefined, name: string): string[] | null {
  const key = artistKey(name);
  const named = (a: MbArtist) => [a.name, ...(a.aliases ?? []).map((x) => x.name)].some((n) => typeof n === "string" && artistKey(n) === key);
  const hit = (artists ?? []).filter((a) => (a.score ?? 0) >= 80 && named(a)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (!hit) return null;
  return (hit.tags ?? [])
    .filter((t): t is { name: string; count?: number } => typeof t.name === "string" && t.name.trim() !== "" && (t.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 10)
    .map((t) => t.name.trim().toLowerCase());
}

/** A Lucene phrase for MusicBrainz's search: quotes and backslashes escaped. */
export function mbPhrase(name: string): string {
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

// ---------- The sources (swapped in tests) ----------

export interface GenreSources {
  /** Spotify's genres for an artist; null when it has no such artist; undefined when no Spotify account is connected. */
  spotify(name: string): Promise<string[] | null | undefined>;
  /** MusicBrainz's tags for an artist; null when it has no such artist. */
  musicbrainz(name: string): Promise<string[] | null>;
  wait(ms: number): Promise<void>;
}

const json = async <T>(url: string): Promise<T> => JSON.parse((await safeFetch(url, { accept: "json", maxBytes: 512 * 1024 })).toString("utf8")) as T;

function liveSources(): GenreSources {
  // Opened once a run, on the first artist: most loads have nothing to ask.
  let spotify: Promise<((path: string, params?: Record<string, string | number | undefined>) => Promise<unknown>) | null> | null = null;
  const spotifyGet = () =>
    (spotify ??= (async () => {
      const found = (await listConnectors()).find((c) => c.provider === "spotify" && c.status === "connected");
      if (!found) return null;
      const account = await getConnectorWithSecrets(found.id);
      if (!account?.secrets.tokens) return null;
      const { spotifyGet: make } = await import("./connectors/spotify-direct");
      return make(account.connector, account.secrets);
    })().catch(() => null));
  return {
    async spotify(name) {
      const get = await spotifyGet();
      if (!get) return undefined;
      const r = (await get("/search", { q: `artist:${name}`, type: "artist", limit: 10 })) as { artists?: { items?: SpotifyArtist[] } };
      return spotifyGenres(r?.artists?.items, name);
    },
    async musicbrainz(name) {
      const u = new URL("https://musicbrainz.org/ws/2/artist");
      u.searchParams.set("query", `artist:${mbPhrase(name)}`);
      u.searchParams.set("limit", "5");
      u.searchParams.set("fmt", "json");
      // safeFetch names the app in its User-Agent, as MusicBrainz asks.
      const r = await json<{ artists?: MbArtist[] }>(u.toString());
      return musicbrainzGenres(r.artists, name);
    },
    wait: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}

/** A lookup that answered "no such thing", as opposed to one that couldn't be reached (or was told to slow down). */
const answeredNo = (error: unknown): boolean => error instanceof ArtFetchError && error.reason === "http" && /^4\d\d$/.test(error.message) && error.message !== "429";

export interface GenreRun {
  /** Artists due a look. */
  due: number;
  /** Of those, how many were asked this run. */
  looked: number;
  /** How many came back with genres. */
  learned: number;
}

/**
 * Look up the artists (most played first) not known yet, and return what
 * was learned. Never throws: an artist neither source could be reached for
 * is left for next time.
 */
export async function learnGenres(names: string[], book: GenreBook, opts: { sources?: GenreSources; budgetMs?: number; now?: Date; most?: number } = {}): Promise<{ run: GenreRun; learned: GenreBook }> {
  const src = opts.sources ?? liveSources();
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const seen = new Set<string>();
  const todo = names.filter((n) => {
    const k = artistKey(n);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return due(book[k], now.getTime());
  });
  const run: GenreRun = { due: todo.length, looked: 0, learned: 0 };
  const learned: GenreBook = {};
  let spotifyOn = true;
  let lastMb = 0;
  for (const name of todo.slice(0, opts.most ?? ARTISTS_PER_RUN)) {
    if (Date.now() >= deadline) break;
    let genres: string[] | null = null;
    let from: ArtistGenres["from"];
    let reached = false;
    if (spotifyOn) {
      try {
        const s = await src.spotify(name);
        if (s === undefined) spotifyOn = false;
        else {
          reached = true;
          if (s?.length) {
            genres = s;
            from = "spotify";
          }
        }
      } catch {
        // Signed out, or limited just now: MusicBrainz for the rest of this run.
        spotifyOn = false;
      }
    }
    if (!genres) {
      const wait = lastMb + MUSICBRAINZ_GAP_MS - Date.now();
      if (lastMb && wait > 0) {
        if (Date.now() + wait >= deadline) break;
        await src.wait(wait);
      }
      lastMb = Date.now();
      try {
        const m = await src.musicbrainz(name);
        reached = true;
        if (m?.length) {
          genres = m;
          from = "musicbrainz";
        }
      } catch (error) {
        if (answeredNo(error)) reached = true;
      }
    }
    // Neither could be reached: left due.
    if (!reached) continue;
    run.looked++;
    if (genres) run.learned++;
    learned[artistKey(name)] = { name, genres: genres ?? [], ...(from ? { from } : {}), checked: now.toISOString() };
  }
  return { run, learned };
}

/** The whole of it, against the database: what GET /api/life/music runs in the background. */
export async function learnMusicGenres(names: string[], opts: { budgetMs?: number } = {}): Promise<GenreRun> {
  try {
    const book = await loadGenreBook();
    const { run, learned } = await learnGenres(names, book, opts);
    await saveGenres(learned);
    return run;
  } catch {
    return { due: 0, looked: 0, learned: 0 };
  }
}
