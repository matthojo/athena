/**
 * The owner's taste across their whole history, for Ask's `taste` tool
 * (lib/answer.ts): "what kind of films do I like?", "which YouTube channels
 * do I watch most?". Read-only.
 *
 * From Watch & read: finished and rated films, shows and books, with their
 * stars. From Days: the shows and films watched most, the channels liked
 * and subscribed to, and the artists played most. Backfilled history
 * (netlify/lib/connectors/backfill.ts) counts the same as anything else.
 * Titles are sealed at rest; q() opens them, and everything is counted
 * here, never in SQL.
 */
import { q } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { listReading } from "./memory";
import { ratingField } from "./watch-read-sync";

export const TASTE_AREAS = ["films", "tv", "books", "youtube", "music"] as const;
export type TasteArea = (typeof TASTE_AREAS)[number];

interface Rated {
  title: string;
  by?: string;
  stars?: number;
  finished?: string;
}

export interface Taste {
  /** The first and last day the history covers. */
  from: string | null;
  to: string | null;
  films?: { finished: number; rated: Rated[]; watched_most: Array<{ title: string; times: number }> };
  tv?: { finished: number; rated: Rated[]; watched_most: Array<{ show: string; episodes: number }> };
  books?: { finished: number; rated: Rated[] };
  youtube?: { liked: number; channels_liked_most: Array<{ channel: string; likes: number }>; subscriptions: number; playlists: Array<{ playlist: string; videos: number }> };
  music?: { artists_played_most: Array<{ artist: string; plays: number }>; saved_songs: number; saved_albums: number };
}

const TOP = 25;
const top = <T>(m: Map<string, number>, f: (k: string, n: number) => T, n = TOP) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => f(k, v));
const bump = (m: Map<string, number>, k: string | null | undefined, by = 1) => {
  if (!k || isEncryptedPlaceholder(k)) return;
  m.set(k, (m.get(k) ?? 0) + by);
};

interface EntryRow {
  date: string;
  kind: string;
  source: string;
  title: string;
  subtitle: string | null;
  grp: string | null;
  note: string | null;
  count: number;
}

/**
 * `from` and `to` (YYYY-MM-DD, either or both) narrow it to a stretch of
 * time: "who did I play most in 2024?". Days' entries count by their day,
 * finished titles by the day they were finished (those without one drop out).
 */
export async function tasteProfile(opts: { area?: TasteArea; from?: string; to?: string } = {}): Promise<Taste> {
  const want = (a: TasteArea) => !opts.area || opts.area === a;
  const span = !!(opts.from || opts.to);
  const inSpan = (d: string | undefined) => !span || (!!d && (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to));
  const [items, field, rows] = await Promise.all([
    listReading({ limit: 5000 }),
    ratingField({ create: false }),
    q<EntryRow>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, source, title, subtitle, grp, note, count FROM day_entries
       WHERE archived_at IS NULL AND folded_into IS NULL AND kind IN ('watched', 'listened', 'saved')
         AND ($1::date IS NULL OR date >= $1::date) AND ($2::date IS NULL OR date <= $2::date) LIMIT 100000`,
      [opts.from ?? null, opts.to ?? null],
    ),
  ]);
  const stars = new Map<string, number>();
  if (field) {
    for (const v of await q<{ entity_id: string; value: string }>(`SELECT entity_id, value FROM custom_values WHERE field_id = $1`, [field.id])) {
      try {
        const n = JSON.parse(v.value);
        if (typeof n === "number") stars.set(v.entity_id, n);
      } catch {
        // sealed or not a number: leave it out
      }
    }
  }
  const dates = rows.map((r) => r.date).sort();
  const out: Taste = { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };

  const rated = (kind: string) => {
    const done = items.filter((i) => i.kind === kind && i.status === "done" && !isEncryptedPlaceholder(i.title));
    const list = done
      .map((i): Rated => ({ title: i.title, ...(i.author ? { by: i.author } : {}), ...(stars.has(i.id) ? { stars: stars.get(i.id) } : {}), ...(i.finished_at ? { finished: new Date(i.finished_at).toISOString().slice(0, 10) } : {}) }))
      .filter((r) => r.stars !== undefined && inSpan(r.finished))
      .sort((a, b) => b.stars! - a.stars! || (b.finished ?? "").localeCompare(a.finished ?? ""));
    // The best and the worst say the most about taste.
    const rated = list.length > TOP * 2 ? [...list.slice(0, TOP), ...list.slice(-10)] : list;
    return { finished: span ? done.filter((i) => inSpan(i.finished_at ? new Date(i.finished_at).toISOString().slice(0, 10) : undefined)).length : done.length, rated };
  };

  const watched = rows.filter((r) => r.kind === "watched");
  if (want("films")) {
    const films = new Map<string, number>();
    for (const r of watched) if (!r.grp && r.source !== "youtube" && r.source !== "iplayer") bump(films, r.title);
    out.films = { ...rated("film"), watched_most: top(films, (title, times) => ({ title, times })).filter((f) => f.times > 1) };
  }
  if (want("tv")) {
    const shows = new Map<string, number>();
    for (const r of watched) if (r.grp && r.source !== "youtube") bump(shows, r.grp, r.count || 1);
    out.tv = { ...rated("tv"), watched_most: top(shows, (show, episodes) => ({ show, episodes })) };
  }
  if (want("books")) out.books = rated("book");
  if (want("youtube")) {
    const yt = rows.filter((r) => r.source === "youtube" && r.kind === "saved");
    const channels = new Map<string, number>();
    const playlists = new Map<string, number>();
    for (const r of yt) {
      if (r.note === "liked") bump(channels, r.subtitle);
      else if (r.note !== "subscribed") bump(playlists, r.grp);
    }
    out.youtube = {
      liked: yt.filter((r) => r.note === "liked").length,
      channels_liked_most: top(channels, (channel, likes) => ({ channel, likes })),
      subscriptions: yt.filter((r) => r.note === "subscribed").length,
      playlists: top(playlists, (playlist, videos) => ({ playlist, videos }), 10),
    };
  }
  if (want("music")) {
    const artists = new Map<string, number>();
    for (const r of rows) if (r.kind === "listened" && r.source !== "overcast" && r.source !== "audible") bump(artists, r.grp ?? r.subtitle, r.count || 1);
    out.music = {
      artists_played_most: top(artists, (artist, plays) => ({ artist, plays })),
      saved_songs: rows.filter((r) => r.source === "spotify" && r.note === "liked song").length,
      saved_albums: rows.filter((r) => r.source === "spotify" && r.note === "saved album").length,
    };
  }
  return out;
}
