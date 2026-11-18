/**
 * Spotify's "Extended streaming history", from the privacy download
 * (Account → Privacy → Extended streaming history). Pure, so the app
 * (components/spotify-history-import.ts), the server and the tests share it,
 * like lib/apple-music-export.ts.
 *
 * The zip holds Streaming_History_Audio_*.json: arrays of plays with ts
 * (UTC), ms_played, master_metadata_track_name,
 * master_metadata_album_artist_name, master_metadata_album_album_name,
 * spotify_track_uri and skipped. Podcast and audiobook rows (episode_name,
 * spotify_episode_uri, audiobook_title) and plays under 30 seconds are left
 * out. What's left is folded as the Last.fm history load folds scrobbles:
 * one listened entry per album (or artist, without one) per local day, with
 * count, minutes and plays per hour (lib/day-hours.ts), and the same ids
 * (albumDayId in lib/day-imports.ts), so a day already loaded isn't doubled.
 */
import { zonedParts } from "./dates";
import { emptyHours } from "./day-hours";

export const MIN_PLAY_MS = 30_000;

/** A Streaming_History_Audio file, by its name (the zip's other files are left alone). */
export const sniffSpotifyName = (name: string): "audio" | null => (/(^|\/)Streaming_History_Audio_[^/]*\.json$/i.test(name) ? "audio" : null);

export interface AlbumDay {
  /** The album, or the artist when the plays had no album. */
  title: string;
  artist?: string;
  plays: number;
  /** Whole minutes, at least 1. */
  minutes: number;
  /** Plays per local hour 0-23. */
  hours: number[];
}

export interface SpotifyDay {
  day: string;
  albums: AlbumDay[];
}

export interface SpotifyHistory {
  days: SpotifyDay[];
  counts: { plays: number; days: number; albums: number; artists: number; minutes: number };
  top: { artists: Array<{ name: string; minutes: number; plays: number }>; albums: Array<{ name: string; artist?: string; plays: number }> };
  skipped: { short: number; podcasts: number; unnamed: number; future: number };
  range: { first: string; last: string } | null;
}

interface Play {
  ts?: string;
  ms_played?: number;
  master_metadata_track_name?: string | null;
  master_metadata_album_artist_name?: string | null;
  master_metadata_album_album_name?: string | null;
  episode_name?: string | null;
  spotify_episode_uri?: string | null;
  audiobook_title?: string | null;
}

const tidy = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 300) : "");

export async function parseSpotifyHistory(
  files: Array<{ name: string; text: string }>,
  opts: { tz?: string; today?: string; pause?: () => Promise<void>; progress?: (f: number) => void } = {},
): Promise<SpotifyHistory> {
  const tz = opts.tz ?? "UTC";
  const today = opts.today ?? zonedParts(new Date(), tz).date;
  const skipped = { short: 0, podcasts: 0, unnamed: 0, future: 0 };
  const days = new Map<string, Map<string, AlbumDay & { ms: number }>>();
  const artists = new Map<string, { name: string; ms: number; plays: number }>();
  const albums = new Map<string, { name: string; artist?: string; plays: number }>();
  let plays = 0;
  const audio = files.filter((f) => sniffSpotifyName(f.name));
  for (const [i, f] of audio.entries()) {
    let rows: Play[];
    try {
      const v = JSON.parse(f.text) as unknown;
      rows = Array.isArray(v) ? (v as Play[]) : [];
    } catch {
      continue;
    }
    for (const [j, r] of rows.entries()) {
      if (!r || typeof r !== "object") continue;
      if (r.episode_name || r.spotify_episode_uri || r.audiobook_title) {
        skipped.podcasts++;
        continue;
      }
      const track = tidy(r.master_metadata_track_name);
      const artist = tidy(r.master_metadata_album_artist_name);
      const album = tidy(r.master_metadata_album_album_name);
      const t = Date.parse(r.ts ?? "");
      if (!track || !Number.isFinite(t)) {
        skipped.unnamed++;
        continue;
      }
      const ms = typeof r.ms_played === "number" ? r.ms_played : 0;
      if (ms < MIN_PLAY_MS) {
        skipped.short++;
        continue;
      }
      const at = zonedParts(new Date(t), tz);
      if (at.date > today) {
        skipped.future++;
        continue;
      }
      const title = album || artist || track;
      const k = `${title.toLowerCase()}\u0000${artist.toLowerCase()}`;
      const day = days.get(at.date) ?? new Map();
      const a = day.get(k) ?? { title, ...(artist ? { artist } : {}), plays: 0, minutes: 0, hours: emptyHours(), ms: 0 };
      a.plays++;
      a.ms += ms;
      a.hours[at.hour]++;
      day.set(k, a);
      days.set(at.date, day);
      plays++;
      if (artist) {
        const x = artists.get(artist.toLowerCase()) ?? { name: artist, ms: 0, plays: 0 };
        x.ms += ms;
        x.plays++;
        artists.set(artist.toLowerCase(), x);
      }
      if (album) {
        const x = albums.get(k) ?? { name: album, ...(artist ? { artist } : {}), plays: 0 };
        x.plays++;
        albums.set(k, x);
      }
      if (j % 5000 === 4999) await opts.pause?.();
    }
    opts.progress?.((i + 1) / audio.length);
    await opts.pause?.();
  }
  const out: SpotifyDay[] = [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, m]) => ({
      day,
      albums: [...m.values()].sort((a, b) => b.plays - a.plays).map(({ ms, ...a }) => ({ ...a, minutes: Math.max(1, Math.round(ms / 60_000)) })),
    }));
  const minutes = out.reduce((k, d) => k + d.albums.reduce((s, a) => s + a.minutes, 0), 0);
  return {
    days: out,
    counts: { plays, days: out.length, albums: albums.size, artists: artists.size, minutes },
    top: {
      artists: [...artists.values()].sort((a, b) => b.ms - a.ms).slice(0, 10).map((a) => ({ name: a.name, minutes: Math.round(a.ms / 60_000), plays: a.plays })),
      albums: [...albums.values()].sort((a, b) => b.plays - a.plays).slice(0, 10),
    },
    skipped,
    range: out.length ? { first: out[0].day, last: out[out.length - 1].day } : null,
  };
}

/** Days in batches small enough for one request each (whole days, at most so many albums). */
export function batchSpotifyDays(days: SpotifyDay[], maxDays = 120, maxItems = 400): SpotifyDay[][] {
  const out: SpotifyDay[][] = [];
  let cur: SpotifyDay[] = [];
  let n = 0;
  for (const d of days) {
    const k = Math.max(1, d.albums.length);
    if (cur.length && (cur.length >= maxDays || n + k > maxItems)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(k > maxItems ? { day: d.day, albums: d.albums.slice(0, maxItems) } : d);
    n += Math.min(k, maxItems);
  }
  if (cur.length) out.push(cur);
  return out;
}
