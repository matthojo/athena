/**
 * The rows behind Music (lib/music.ts) on the server, for GET /api/life/music.
 * Read-only, from day_entries of kind listened (not archived, not folded).
 *
 * An entry's artist and album are sealed per row with a random IV, so SQL
 * can't group by them: SQL filters, works out plays (count, else 1) and
 * caps the rows; names are grouped once opened. Rows before the period
 * fetch only the artist (for "first played"), so the bulk of a long history
 * costs one open per row, not three.
 */
import { q } from "./db";
import { isEncryptedPlaceholder } from "./encrypted";
import { artistDetail, buildMusic, nameKey, NOT_MUSIC, periodArtists, resolvePeriod, TRACK_SOURCES, type ArtistArtOf, type ArtistDetail, type FamiliesOf, type MusicData, type MusicRow } from "./music";
import { cachedArt, musicKey, sourceKey, type ArtHint } from "./art";
import { artistKey, musicFamilies } from "./genre-mix";
import { due, loadGenreBook, type GenreBook } from "./music-genre-store";
import type { DayArt } from "./day-types";
import { readHours } from "./day-hours";

/** Years of daily albums is tens of thousands of rows; past this the oldest drop off (and the page says so). */
export const MAX_MUSIC_ROWS = 150_000;

interface Row {
  date: string;
  artist: string | null;
  title: string | null;
  plays: number;
  art: DayArt | null;
}

const open = (s: string | null) => (s && !isEncryptedPlaceholder(s) ? s : null);

/** Every listened row, newest first; title and art only from `fullFrom` on (null: all of them). */
async function musicRows(fullFrom: string | null): Promise<{ rows: MusicRow[]; capped: boolean }> {
  const full = fullFrom === null ? "TRUE" : "date >= $2::date";
  const raw = await q<Omit<Row, "hours"> & { source: string; subtitle: string | null; grp: string | null; hours: string | null }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, source, subtitle, grp,
            CASE WHEN ${full} THEN title END AS title,
            CASE WHEN ${full} THEN art END AS art,
            CASE WHEN ${full} THEN hours END AS hours,
            CASE WHEN count > 0 THEN count ELSE 1 END AS plays
       FROM day_entries
      WHERE kind = 'listened' AND archived_at IS NULL AND folded_into IS NULL AND source <> ALL($1::text[])
      ORDER BY date DESC
      LIMIT ${MAX_MUSIC_ROWS + 1}`,
    fullFrom === null ? [[...NOT_MUSIC]] : [[...NOT_MUSIC], fullFrom],
  );
  const capped = raw.length > MAX_MUSIC_ROWS;
  const rows = (capped ? raw.slice(0, MAX_MUSIC_ROWS) : raw).map((r) => ({
    date: r.date,
    artist: open(r.subtitle) ?? open(r.grp),
    title: open(r.title),
    plays: Number(r.plays) || 1,
    art: r.art && typeof r.art === "object" && typeof r.art.id === "string" ? r.art : null,
    ...((TRACK_SOURCES as readonly string[]).includes(r.source) ? { track: true } : {}),
    hours: readHours(r.hours) ?? null,
  }));
  return { rows, capped };
}

// ---------- Covers ----------

/** Album covers looked up per load, at most: each is a search and an image. */
export const COVERS_PER_LOAD = 30;

/** A play's album by name, as lib/art.ts asks Deezer for it; an artist-titled play asks for nothing (the artist's stand-in covers it). */
function albumOf(r: MusicRow): ArtHint | null {
  if (!r.artist || !r.title || !musicKey(r.artist) || !musicKey(r.title) || musicKey(r.title) === musicKey(r.artist)) return null;
  return { album: { artist: r.artist, title: r.title, ...(r.track ? { track: true } : {}) } };
}
const artistOf = (name: string): ArtHint => ({ album: { artist: name } });

/**
 * Covers for plays whose source sent none, from what's already been found
 * (one query, nothing fetched): a play gets its own album's cover, and an
 * artist none of whose plays has one gets their best-known album's. What
 * hasn't been asked yet, most played first, is handed to `learn` for after
 * the reply. Rows from `from` on (null: all) are looked at.
 */
export async function withCovers(rows: MusicRow[], from: string | null, learn?: (hints: ArtHint[]) => void): Promise<{ rows: MusicRow[]; artistArt: ArtistArtOf }> {
  const albums = new Map<string, { hint: ArtHint; plays: number }>();
  const artists = new Map<string, { name: string; plays: number; covered: boolean }>();
  for (const r of rows) {
    if (!r.artist || (from && r.date < from)) continue;
    const a = artists.get(nameKey(r.artist)) ?? { name: r.artist, plays: 0, covered: false };
    a.plays += r.plays;
    a.covered ||= !!r.art;
    artists.set(nameKey(r.artist), a);
    if (r.art) continue;
    const hint = albumOf(r);
    const key = hint && sourceKey(hint);
    if (!hint || !key) continue;
    const had = albums.get(key);
    albums.set(key, { hint, plays: (had?.plays ?? 0) + r.plays });
  }
  const bare = [...artists.values()].filter((a) => !a.covered);
  const known = await cachedArt([...[...albums.values()].map((a) => a.hint), ...bare.map((a) => artistOf(a.name))]);
  const out = rows.map((r) => {
    if (r.art || (from && r.date < from)) return r;
    const hint = albumOf(r);
    const art = hint ? known.get(sourceKey(hint)!) : null;
    return art ? { ...r, art } : r;
  });
  // Still bare once albums are applied: the artist's stand-in.
  for (const r of out) if (r.art && r.artist) artists.get(nameKey(r.artist))!.covered = true;
  const artistArt: ArtistArtOf = (name) => known.get(sourceKey(artistOf(name))!) ?? undefined;
  if (learn) {
    const asks = [
      ...[...albums.entries()].filter(([k]) => !known.has(k)).map(([, a]) => a),
      ...[...artists.values()].filter((a) => !a.covered && !known.has(sourceKey(artistOf(a.name))!)).map((a) => ({ hint: artistOf(a.name), plays: a.plays })),
    ]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, COVERS_PER_LOAD)
      .map((a) => a.hint);
    if (asks.length) learn(asks);
  }
  return { rows: out, artistArt };
}

/**
 * The page for one period ("month", "year", "all" or an earlier year), its
 * genre mix from the artists looked up so far. `learn` is handed the
 * period's artists (and the span before's), most played first, when some
 * aren't looked up yet: netlify/lib/music-genres.ts asks after the reply.
 */
export async function musicData(periodId: string | null, today: string, opts: { learn?: (artists: string[]) => void; learnCovers?: (hints: ArtHint[]) => void } = {}): Promise<MusicData> {
  const p = resolvePeriod(periodId, today);
  const [{ rows: held, capped }, book] = await Promise.all([musicRows(p.from), loadGenreBook().catch((): GenreBook => ({}))]);
  // Covers only matter for what the page shows: the period's plays.
  const { rows, artistArt } = await withCovers(held, p.from, opts.learnCovers);
  const families: FamiliesOf = (a) => {
    const known = book[artistKey(a)];
    return known ? musicFamilies(known.genres) : undefined;
  };
  const data = buildMusic(rows, p.id, today, { capped, families, artistArt });
  if (opts.learn) {
    const now = Date.now();
    const names = periodArtists(rows, p.id, today).filter((n) => due(book[artistKey(n)], now));
    if (names.length) opts.learn(names);
  }
  return data;
}

/** One artist over everything held, for the artist sheet. */
export async function musicArtist(name: string, today: string): Promise<ArtistDetail | null> {
  const { rows: held } = await musicRows(null);
  const key = nameKey(name);
  const { rows, artistArt } = await withCovers(held.filter((r) => r.date <= today && r.artist && nameKey(r.artist) === key), null);
  return artistDetail(rows, name, artistArt);
}
