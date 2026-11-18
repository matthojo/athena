/**
 * What each artist's genres are (netlify/lib/music-genres.ts looks them
 * up): one `settings` row, key 'music_genres', whose value is { sealed:
 * <the book, sealed with the data key> }, like playlists
 * (lib/playlist-store.ts). No migration. Listed in SEALED_SETTINGS so a key
 * rotation reseals it.
 *
 * Keyed by `artistKey` (lib/genre-mix.ts), so "The xx" and "the XX" are one
 * artist. Genres are kept as the source gave them, strongest first; Music
 * folds them into families when it reads them.
 */
import { qRaw } from "./db";
import { dataKeyConfigured, openStrict, sealText } from "./data-box";

export const GENRES_KEY = "music_genres";

export interface ArtistGenres {
  /** As first seen in a play. */
  name: string;
  /** As the source gave them, strongest first; empty when it had none. */
  genres: string[];
  /** Which source answered: none when neither knew the artist. */
  from?: "spotify" | "musicbrainz";
  /** When it was last asked (ISO). */
  checked: string;
}

/** artistKey → what's known. */
export type GenreBook = Record<string, ArtistGenres>;

/** An artist nobody knew is asked again after this long. */
export const RECHECK_MS = 30 * 86_400_000;

/** Whether an artist is due a look: never asked, or asked a month ago and nobody knew. */
export function due(known: ArtistGenres | undefined, now: number): boolean {
  if (!known) return true;
  return !known.genres.length && now - Date.parse(known.checked) > RECHECK_MS;
}

export async function loadGenreBook(): Promise<GenreBook> {
  const [row] = await qRaw<{ value: { sealed?: string } }>(`SELECT value FROM settings WHERE key = $1`, [GENRES_KEY]);
  if (!row?.value?.sealed) return {};
  try {
    const book = JSON.parse(openStrict(row.value.sealed)) as GenreBook;
    return book && typeof book === "object" && !Array.isArray(book) ? book : {};
  } catch {
    return {};
  }
}

/** Add what was just learned to the book as stored now (another load may have written since). */
export async function saveGenres(learned: GenreBook): Promise<void> {
  if (!dataKeyConfigured() || !Object.keys(learned).length) return;
  const book = { ...(await loadGenreBook()), ...learned };
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [GENRES_KEY, JSON.stringify({ sealed: sealText(JSON.stringify(book)) })],
  );
}
