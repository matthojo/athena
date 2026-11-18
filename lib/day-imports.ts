/**
 * What each import's days become as Day entries (lib/days.ts). Pure, so the
 * imports, the conversion of old Life log notes and the tests agree on one
 * id per thing: a Netflix episode converted from an old note and the same
 * episode in a later import are the same entry.
 *
 *  - YouTube (Takeout): `<day>:<video id>`, one entry per video a day, with
 *    its plays as count. YouTube Music plays are listened, source
 *    youtube_music.
 *  - Netflix: `<day>:<episode hash>` per episode (netflix-csv episodeHash),
 *    `<day>:film:<title key>` per film.
 *  - Goodreads: `book:<id>` for a finished book, `want:<id>` for to-read.
 *    One entry per book, on the day it was finished or added.
 *  - Habits (Loop, Daylio activities, Bearable factors): `<day>:<habit key>`
 *    per source, one entry per habit a day: done, or skipped (count 0).
 *  - Overcast: `ep:<Overcast id or audio address>`, one entry per episode,
 *    on the day it was first seen played (a later export keeps that day).
 *  - TfL: `<day>:<start time>:<journey key>`, one entry per journey.
 *  - Amazon export: `<day>:<ASIN>` per book, title or episode a day
 *    (Kindle read, Audible listened, Prime Video watched), the title as
 *    the group so covers can be found; minutes when the export gives them.
 *  - Apple Music: `<day>:<track key>` per song a day (apple-music-export
 *    trackKey, a hash of artist and title), listened, with plays as count.
 *    A Last.fm entry that day for the same song or its artist keeps its
 *    place and the Apple one isn't written (`notOnLastfm`).
 *  - BBC iPlayer: `<day>:<programme id>` per programme a day (the BBC's
 *    PID, else a hash of programme and episode), watched.
 */
import type { EntryInput } from "./days";
import { episodeHash, titleKey, type NetflixDay } from "./netflix-csv";
import type { LibraryDay } from "./goodreads-csv";
import type { TakeoutDay } from "./youtube-takeout";
import { habitKey, type HabitDay, type HabitMark } from "./loop-csv";
import type { PodcastDay } from "./overcast-opml";
import type { JourneyDay } from "./tfl-csv";
import type { MediaDay, MediaSource } from "./amazon-export";
import type { ListenDay, Track } from "./apple-music-export";
import type { WatchDay } from "./iplayer-export";
import type { SpotifyDay } from "./spotify-history";

export const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const netflixUrl = (title: string) => `https://www.netflix.com/search?q=${encodeURIComponent(title)}`;
export const goodreadsUrl = (id: string) => `https://www.goodreads.com/book/show/${id}`;

export const youtubeId = (day: string, videoId: string) => `${day}:${videoId}`;
export const netflixEpisodeId = (day: string, show: string, season: string, episode: string) => `${day}:${episodeHash(show, season, episode)}`;
export const netflixFilmId = (day: string, title: string) => `${day}:film:${titleKey(title)}`;
export const goodreadsId = (bookId: string, want: boolean) => `${want ? "want" : "book"}:${bookId}`;

export function youtubeEntries(d: TakeoutDay): EntryInput[] {
  return d.videos.map((v) => ({
    kind: v.music ? "listened" : "watched",
    source: v.music ? "youtube_music" : "youtube",
    external_id: youtubeId(d.day, v.id),
    title: v.title || "A video that's no longer on YouTube",
    ...(v.channel ? { subtitle: v.channel } : {}),
    url: youtubeUrl(v.id),
    ...(v.count > 1 ? { count: v.count } : {}),
    ...(v.music && v.channel ? { group: v.channel } : {}),
  }));
}

export function netflixEntries(d: NetflixDay): EntryInput[] {
  return d.watched.flatMap((w): EntryInput[] => {
    if (!w.episodes) return [{ kind: "watched", source: "netflix", external_id: netflixFilmId(d.day, w.title), title: w.title, url: netflixUrl(w.title) }];
    const season = w.season ?? "";
    return w.episodes.map((ep) => ({
      kind: "watched",
      source: "netflix",
      external_id: netflixEpisodeId(d.day, w.title, season, ep),
      title: w.title,
      ...(season || ep ? { subtitle: [season, ep].filter(Boolean).join(" · ") } : {}),
      url: netflixUrl(w.title),
      group: w.title,
    }));
  });
}

export function goodreadsEntries(d: LibraryDay): EntryInput[] {
  return d.books.map((b) => ({
    kind: b.want ? "saved" : "read",
    source: "goodreads",
    external_id: goodreadsId(b.id, !!b.want),
    title: b.title,
    ...(b.author ? { subtitle: b.author } : {}),
    url: goodreadsUrl(b.id),
    ...(b.rating && !b.want ? { rating: b.rating } : {}),
    note: b.want ? "want to read" : "finished",
  }));
}

// ---------- Habits, podcasts and journeys (backfill imports) ----------

/** The sources the backfill imports write, as `day_entries.source`. */
export const HABIT_SOURCES = ["loop", "daylio", "bearable"] as const;
export type HabitSource = (typeof HABIT_SOURCES)[number];

/** How a habit is stored: a `habit` entry (lib/day-types.ts), in group "habit". */
export const HABIT_AS = { kind: "habit", group: "habit" } as const satisfies Pick<EntryInput, "kind" | "group">;
/** A skipped habit's count (migration 0034 allows 0). */
export const SKIPPED_COUNT = 0;

/** The entry's group for a commute, so journeys share one card. */
export const COMMUTE_GROUP = "commute";

export const habitId = (day: string, name: string) => `${day}:${habitKey(name)}`;
export const overcastId = (id: string) => `ep:${id}`;
const journeyKey = (title: string) => habitKey(title).slice(0, 60);
export const tflId = (day: string, start: string | undefined, title: string, n: number) => `${day}:${start ?? `n${n}`}:${journeyKey(title)}`;

/** A habit done (count 1), or skipped (count 0, note "skipped"). */
export function habitEntry(source: HabitSource, day: string, h: HabitMark): EntryInput {
  return {
    ...HABIT_AS,
    source,
    external_id: habitId(day, h.name),
    title: h.name,
    ...(h.done ? {} : { count: SKIPPED_COUNT }),
    ...(h.note ? { note: h.note } : {}),
  };
}

export const habitEntries = (source: HabitSource) => (d: HabitDay): EntryInput[] => d.habits.map((h) => habitEntry(source, d.day, h));

export function overcastEntries(d: PodcastDay): EntryInput[] {
  return d.episodes.map((e) => ({
    kind: "listened",
    source: "overcast",
    external_id: overcastId(e.id),
    title: e.title,
    subtitle: e.show,
    group: e.show,
    ...(e.url ? { url: e.url } : {}),
    ...(e.minutes ? { minutes: e.minutes } : {}),
    ...(e.partial ? { note: "part played" } : {}),
  }));
}

export function tflEntries(d: JourneyDay): EntryInput[] {
  return d.journeys.map((j, i) => ({
    kind: "other",
    source: "tfl",
    external_id: tflId(d.day, j.start, j.title, i),
    title: j.title,
    ...(j.start ? { subtitle: j.end ? `${j.start}–${j.end}` : j.start } : {}),
    group: COMMUTE_GROUP,
    ...(j.minutes ? { minutes: j.minutes } : {}),
    ...(j.note ? { note: j.note } : {}),
  }));
}

// ---------- Amazon export (Kindle, Audible, Prime Video) ----------

export const AMAZON_SOURCES = ["kindle", "audible", "prime_video"] as const satisfies readonly MediaSource[];
const AMAZON_KIND: Record<MediaSource, EntryInput["kind"]> = { kindle: "read", audible: "listened", prime_video: "watched" };

export const amazonId = (day: string, key: string) => `${day}:${key}`;

export function amazonEntries(d: MediaDay): EntryInput[] {
  return d.items.map((x) => ({
    kind: AMAZON_KIND[x.source],
    source: x.source,
    external_id: amazonId(d.day, x.key),
    title: x.title,
    ...(x.subtitle ? { subtitle: x.subtitle } : {}),
    // A film's title is its own group; a show's episodes and a book's days share the title.
    group: x.title,
    ...(x.minutes ? { minutes: x.minutes } : {}),
  }));
}

// ---------- Apple Music and BBC iPlayer (data downloads) ----------

export const APPLE_MUSIC_SOURCE = "apple_music";
export const IPLAYER_SOURCE = "iplayer";

export const appleMusicId = (day: string, key: string) => `${day}:${key}`;
export const iplayerId = (day: string, key: string) => `${day}:${key}`;
export const iplayerUrl = (pid: string) => (/^[bmpw][0-9a-z]{7}$/.test(pid) ? `https://www.bbc.co.uk/iplayer/episode/${pid}` : undefined);

export function appleMusicEntries(d: ListenDay): EntryInput[] {
  return d.tracks.map((t) => ({
    kind: "listened",
    source: APPLE_MUSIC_SOURCE,
    external_id: appleMusicId(d.day, t.key),
    title: t.title,
    ...(t.artist ? { subtitle: t.artist, group: t.artist } : {}),
    ...(t.plays > 1 ? { count: t.plays } : {}),
    minutes: t.minutes,
  }));
}

export function iplayerEntries(d: WatchDay): EntryInput[] {
  return d.programmes.map((p) => {
    const url = iplayerUrl(p.key);
    return {
      kind: "watched",
      source: IPLAYER_SOURCE,
      external_id: iplayerId(d.day, p.key),
      title: p.title,
      ...(p.episode ? { subtitle: [p.series, p.episode].filter(Boolean).join(" · "), group: p.title } : {}),
      ...(url ? { url } : {}),
      ...(p.minutes ? { minutes: p.minutes } : {}),
    };
  });
}

// ---------- Music folded by album and day (Last.fm and ListenBrainz loads, Spotify's streaming history, the hourly sync) ----------

/**
 * The id of a day's listening to one album (or the artist, without one):
 * `<day>:<album and artist, normalised>`. Every writer that folds plays this
 * way uses it, so the same day from two of them is one entry, not two.
 */
export const albumDayId = (day: string, title: string, artist?: string) => `${day}:${titleKey(`${title}\u0000${artist ?? ""}`)}`.slice(0, 300);

export const SPOTIFY_SOURCE = "spotify";

/** A day of Spotify's streaming history as listened entries, one per album. */
export function spotifyHistoryEntries(d: SpotifyDay): EntryInput[] {
  return d.albums.map((a) => ({
    kind: "listened",
    source: SPOTIFY_SOURCE,
    external_id: albumDayId(d.day, a.title, a.artist),
    title: a.title,
    ...(a.artist ? { subtitle: a.artist, group: a.artist } : {}),
    ...(a.plays > 1 ? { count: a.plays } : {}),
    minutes: a.minutes,
    hours: a.hours,
  }));
}

/** What a Last.fm entry says, enough to match: its title, subtitle (artist) and group. */
export type LastfmLine = Pick<EntryInput, "title" | "subtitle" | "group">;

/**
 * Does a Last.fm entry already cover this song? The Life log writes Last.fm
 * as one entry per song, album or artist session (recipes.ts: title the
 * song, album or artist; subtitle and group the artist), so a match on the
 * song's title, or on its artist anywhere in the entry, means Last.fm has it.
 */
export function lastfmCovers(t: Pick<Track, "title" | "artist">, lines: LastfmLine[]): boolean {
  const title = titleKey(t.title);
  const artist = t.artist ? titleKey(t.artist) : "";
  return lines.some((l) => {
    const keys = [l.title, l.subtitle, l.group].filter((x): x is string => !!x).map(titleKey);
    if (titleKey(l.title) === title && (!artist || !l.subtitle || titleKey(l.subtitle) === artist)) return true;
    return !!artist && keys.includes(artist);
  });
}

/** The Apple Music days without the songs Last.fm already has on that day, and how many were left out. */
export function notOnLastfm(days: ListenDay[], lastfm: ReadonlyMap<string, LastfmLine[]>): { days: ListenDay[]; skipped: number } {
  let skipped = 0;
  const out = days.map((d) => {
    const lines = lastfm.get(d.day);
    if (!lines?.length) return d;
    const tracks = d.tracks.filter((t) => !lastfmCovers(t, lines));
    skipped += d.tracks.length - tracks.length;
    return { day: d.day, tracks };
  });
  return { days: out, skipped };
}
