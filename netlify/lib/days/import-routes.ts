/**
 * Backfill imports into Days, from files the owner exports from other apps.
 * The app reads each file on the device (lib/loop-csv.ts, daylio-csv.ts,
 * bearable-csv.ts, overcast-opml.ts, tfl-csv.ts) and sends days in batches;
 * entries are written through importToDays like every other import, keyed
 * by lib/day-imports.ts so the same file again adds nothing.
 *
 *  - GET  /api/days/import             { imports: { loop: LastImport | null, … }, collection, source }
 *  - GET  /api/days/import/:format     { collection, source, last_import }
 *  - POST /api/days/import/:format     { days, file: { items, days } } → BackfillResult
 *
 * Formats: loop, daylio, bearable (habits; Daylio and Bearable also mood and
 * Daylio journal text), overcast (podcast episodes), tfl (journeys).
 *
 * Apple Music and BBC iPlayer (data downloads, read on the device by
 * lib/apple-music-export.ts and lib/iplayer-export.ts) have parts, like
 * Amazon's:
 *  - POST /api/days/import/apple_music  { part: "days", days, file }
 *        Songs as listened entries. A song Last.fm already has that day
 *        (the same song, or an entry for its artist) is left out: Last.fm's
 *        entry stays the one on the day.
 *  - POST /api/days/import/iplayer      { part: "days", days, file }
 *  - POST /api/days/import/spotify_history { part: "days", days, file }
 *        Spotify's extended streaming history (lib/spotify-history.ts):
 *        one entry per album a day, with plays per hour; what Last.fm has
 *        that day is left to Last.fm, and a day a Life log run wrote only
 *        gains the hours.
 *        Programmes as watched entries; each series (as watching) and film
 *        (as watched) into Watch & read, as Netflix does. News, weather and
 *        live channels stay out of Watch & read.
 *  - POST …                             { part: "undo", entries, watch_read }
 *        What the import created: entries hidden, Watch & read items archived.
 *
 * Mood: written to `days.private` only on a day with no mood: Athena's own
 * mood always wins (integrator, 7 Nov). Journal: Daylio's notes go under
 * "From Daylio" at the end of the day's journal, once (a note already there
 * isn't added again). Bearable's symptoms and energy are health: sealed in
 * `sensitive_blobs` (domain health, source bearable), never in Days, and
 * ignored by the health merge (bearable isn't a figure source). Charges in a
 * TfL file never reach the server. Nothing here logs a value.
 */
import { AthenaInputError, archiveEntity, getOwnerTimeZone, q, qRaw } from "../../../lib/db";
import { dataKeyConfigured, DataBoxError, DataKeyMissing, openStrict, sealText } from "../../../lib/data-box";
import { isValidDate, zonedToday, zonedToInstant } from "../../../lib/dates";
import { extKeys, fillEntryHours, MAX_JOURNAL_CHARS, touchDays, type EntryInput, type Mood } from "../../../lib/days";
import { readHours } from "../../../lib/day-hours";
import type { AlbumDay, SpotifyDay } from "../../../lib/spotify-history";
import { collectionSource } from "../../../lib/connector-presets";
import { listCollections } from "../../../lib/connectors";
import {
  APPLE_MUSIC_SOURCE,
  appleMusicEntries,
  habitEntries,
  IPLAYER_SOURCE,
  iplayerEntries,
  lastfmCovers,
  notOnLastfm,
  overcastEntries,
  SPOTIFY_SOURCE,
  spotifyHistoryEntries,
  tflEntries,
  type LastfmLine,
} from "../../../lib/day-imports";
import type { ListenDay, Track } from "../../../lib/apple-music-export";
import { NOT_FOR_WATCH_READ, type Programme, type WatchDay } from "../../../lib/iplayer-export";
import { titleKey } from "../../../lib/netflix-csv";
import { syncWatchRead, type WatchReadInput } from "../../../lib/watch-read-sync";
import { habitName, type HabitDay, type HabitMark } from "../../../lib/loop-csv";
import { DAYLIO_HEADING, type MoodDay } from "../../../lib/daylio-csv";
import type { BearableDay, Symptom } from "../../../lib/bearable-csv";
import type { Episode, PodcastDay } from "../../../lib/overcast-opml";
import type { Journey, JourneyDay } from "../../../lib/tfl-csv";
import { importToDays, lastImport, rememberImport, type FoldResult, type HistoryTarget, type LastImport } from "../connectors/youtube-history";
import { AMAZON_MEMO, handleAmazonImport } from "./amazon-import";

export const IMPORT_FORMATS = ["loop", "daylio", "bearable", "overcast", "tfl"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];
const isFormat = (v: unknown): v is ImportFormat => typeof v === "string" && (IMPORT_FORMATS as readonly string[]).includes(v);

/** Per request: whole days, at most this many, and this many items (habits, episodes, journeys). */
export const MAX_DAYS = 120;
export const MAX_ITEMS = 600;

/** The import's memo key (settings `import.<id>`), beside the accounts'. */
export const memoId = (f: ImportFormat | DownloadFormat) => `file-${f}`;

type Json = (data: unknown, status?: number) => Response;

export interface BackfillResult extends FoldResult {
  /** Entries Days didn't have before. */
  added: number;
  /** Days given a mood from the file. */
  moods_set: number;
  /** Days that kept the mood the owner set. */
  moods_kept: number;
  /** Days whose journal got the file's notes. */
  journals_added: number;
  /** Days of symptoms and energy sealed with health. */
  health_days: number;
}

/** The Life log the entries belong to: the first one there is, else the one a Life log made later gets. */
export async function importTarget(): Promise<HistoryTarget> {
  const col = (await listCollections()).filter((c) => c.recipe === "life-log").sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  return { source: col?.source ?? collectionSource("life-log", "", ""), collection: col ? { id: col.id, name: col.name } : null, metric: "", tz: await getOwnerTimeZone() };
}

// ---------- Reading what the app sends ----------

const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : undefined);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The request's days, checked: whole days, real dates, sensible sizes; `item` reads each day's own part. */
function readDays<D extends { day: string }>(raw: unknown, item: (o: Record<string, unknown>, day: string) => { d: D; n: number }): D[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("days: send at least one day");
  if (raw.length > MAX_DAYS) throw new AthenaInputError(`days: at most ${MAX_DAYS} per request`);
  const seen = new Set<string>();
  let total = 0;
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const day = o.day;
    if (typeof day !== "string" || !isValidDate(day)) throw new AthenaInputError("days: each needs a day (YYYY-MM-DD)");
    if (seen.has(day)) throw new AthenaInputError(`days: ${day} is in this request twice`);
    seen.add(day);
    const { d, n } = item(o, day);
    total += n;
    if (total > MAX_ITEMS) throw new AthenaInputError(`days: at most ${MAX_ITEMS} items per request`);
    return d;
  });
}

function readHabits(o: Record<string, unknown>, day: string, required: boolean): HabitMark[] {
  const raw = o.habits ?? [];
  if (!Array.isArray(raw) || (required && !raw.length) || raw.length > 200) throw new AthenaInputError(`days: ${day} needs its habits (at most 200)`);
  return raw.map((h) => {
    const x = (h ?? {}) as Record<string, unknown>;
    const name = habitName(typeof x.name === "string" ? x.name : "");
    if (!name) throw new AthenaInputError(`days: ${day} has a habit without a name`);
    if (typeof x.done !== "boolean") throw new AthenaInputError(`days: ${day}: each habit is done (true) or skipped (false)`);
    const note = str(x.note, 60);
    return { name, done: x.done, ...(note ? { note } : {}) };
  });
}

function readMood(o: Record<string, unknown>, day: string): Pick<MoodDay, "mood" | "journal"> {
  const out: Pick<MoodDay, "mood" | "journal"> = {};
  if (o.mood !== undefined) {
    const m = int(o.mood, 1, 5);
    if (m === undefined || m !== o.mood) throw new AthenaInputError(`days: ${day}: mood is 1 to 5`);
    out.mood = m as Mood;
  }
  if (o.journal !== undefined) {
    if (typeof o.journal !== "string") throw new AthenaInputError(`days: ${day}: journal is text`);
    const j = o.journal.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_JOURNAL_CHARS);
    if (j) out.journal = j;
  }
  return out;
}

const readers: Record<ImportFormat, (raw: unknown) => Array<{ day: string }>> = {
  loop: (raw) => readDays<HabitDay>(raw, (o, day) => {
    const habits = readHabits(o, day, true);
    return { d: { day, habits }, n: habits.length };
  }),
  daylio: (raw) => readDays<MoodDay>(raw, (o, day) => {
    const habits = readHabits(o, day, false);
    const m = readMood(o, day);
    if (!habits.length && !m.mood && !m.journal) throw new AthenaInputError(`days: ${day} has nothing in it`);
    return { d: { day, habits, ...m }, n: habits.length + 1 };
  }),
  bearable: (raw) => readDays<BearableDay>(raw, (o, day) => {
    const habits = readHabits(o, day, false);
    const { mood } = readMood({ mood: o.mood }, day);
    const energy = o.energy === undefined ? undefined : int(o.energy, 1, 5);
    if (o.energy !== undefined && energy === undefined) throw new AthenaInputError(`days: ${day}: energy is 1 to 5`);
    const rawS = o.symptoms ?? [];
    if (!Array.isArray(rawS) || rawS.length > 100) throw new AthenaInputError(`days: ${day}: symptoms is a list (at most 100)`);
    const symptoms: Symptom[] = rawS.map((s) => {
      const x = (s ?? {}) as Record<string, unknown>;
      const name = habitName(typeof x.name === "string" ? x.name : "");
      if (!name) throw new AthenaInputError(`days: ${day} has a symptom without a name`);
      const severity = int(x.severity, 0, 10);
      return { name, ...(severity !== undefined ? { severity } : {}) };
    });
    if (!habits.length && !mood && !energy && !symptoms.length) throw new AthenaInputError(`days: ${day} has nothing in it`);
    return { d: { day, habits, ...(mood ? { mood } : {}), ...(energy ? { energy } : {}), ...(symptoms.length ? { symptoms } : {}) }, n: habits.length + symptoms.length + 1 };
  }),
  overcast: (raw) => readDays<PodcastDay>(raw, (o, day) => {
    const list = o.episodes;
    if (!Array.isArray(list) || !list.length) throw new AthenaInputError(`days: ${day} has no episodes`);
    const episodes = list.map((e): Episode => {
      const x = (e ?? {}) as Record<string, unknown>;
      const id = typeof x.id === "string" ? x.id.trim().slice(0, 280) : "";
      const title = str(x.title, 300);
      if (!id || !title) throw new AthenaInputError(`days: ${day} has an episode without an id or title`);
      const url = typeof x.url === "string" && /^https:\/\//.test(x.url) && x.url.length <= 2000 ? x.url : undefined;
      const minutes = int(x.minutes, 1, 1440);
      return { id, title, show: str(x.show, 200) || "A podcast", ...(url ? { url } : {}), ...(minutes ? { minutes } : {}), ...(x.partial === true ? { partial: true } : {}) };
    });
    return { d: { day, episodes }, n: episodes.length };
  }),
  tfl: (raw) => readDays<JourneyDay>(raw, (o, day) => {
    const list = o.journeys;
    if (!Array.isArray(list) || !list.length) throw new AthenaInputError(`days: ${day} has no journeys`);
    const journeys = list.map((j): Journey => {
      const x = (j ?? {}) as Record<string, unknown>;
      const title = str(x.title, 170);
      if (!title) throw new AthenaInputError(`days: ${day} has a journey without stations`);
      const start = typeof x.start === "string" && HHMM.test(x.start) ? x.start : undefined;
      const end = typeof x.end === "string" && HHMM.test(x.end) ? x.end : undefined;
      const minutes = int(x.minutes, 1, 240);
      const note = str(x.note, 40);
      return { title, ...(start ? { start } : {}), ...(end ? { end } : {}), ...(minutes ? { minutes } : {}), ...(x.bus === true ? { bus: true } : {}), ...(note ? { note } : {}) };
    });
    return { d: { day, journeys }, n: journeys.length };
  }),
};

/** The request's days for this format, checked. */
export function readImportDays(format: ImportFormat, raw: unknown): Array<{ day: string }> {
  return readers[format](raw);
}

const toEntries: Record<ImportFormat, (d: never) => EntryInput[]> = {
  loop: habitEntries("loop"),
  daylio: habitEntries("daylio"),
  bearable: habitEntries("bearable"),
  overcast: overcastEntries,
  tfl: tflEntries,
};

// ---------- Mood, journal and health ----------

interface Private {
  mood?: Mood;
  journal?: string;
}

/** The journal with the file's notes under its heading, once each; null when nothing changes. */
export function appendJournal(before: string | undefined, notes: string, heading = DAYLIO_HEADING): string | null {
  const have = before ?? "";
  const fresh = notes.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !have.includes(p));
  if (!fresh.length) return null;
  const add = `${have.includes(heading) ? "" : `${heading}\n`}${fresh.join("\n\n")}`;
  const next = (have ? `${have.trimEnd()}\n\n${add}` : add).slice(0, MAX_JOURNAL_CHARS).trimEnd();
  return next === have ? null : next;
}

/** A day's mood (only when it has none) and journal text. Athena's own mood always wins. */
async function fillPrivate(days: MoodDay[]): Promise<Pick<BackfillResult, "moods_set" | "moods_kept" | "journals_added">> {
  const out = { moods_set: 0, moods_kept: 0, journals_added: 0 };
  const want = days.filter((d) => d.mood || d.journal);
  if (!want.length) return out;
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  const rows = await qRaw<{ date: string; private: string | null }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, private FROM days WHERE date = ANY($1::date[])`, [want.map((d) => d.day)]);
  const by = new Map(rows.map((r) => [r.date, r.private]));
  const changed: string[] = [];
  for (const d of want) {
    const sealed = by.get(d.day) ?? null;
    let before: Private;
    try {
      before = sealed ? (JSON.parse(openStrict(sealed)) as Private) : {};
    } catch {
      // A day that won't open is left as it is, never overwritten.
      if (d.mood) out.moods_kept++;
      continue;
    }
    const next: Private = { ...before };
    if (d.mood) {
      if (before.mood) out.moods_kept++;
      else {
        next.mood = d.mood;
        out.moods_set++;
      }
    }
    if (d.journal) {
      const j = appendJournal(before.journal, d.journal);
      if (j) {
        next.journal = j;
        out.journals_added++;
      }
    }
    if (next.mood === before.mood && next.journal === before.journal) continue;
    await qRaw(
      `INSERT INTO days (date, private) VALUES ($1::date, $2) ON CONFLICT (date) DO UPDATE SET private = EXCLUDED.private, updated_at = now() WHERE days.private IS NOT DISTINCT FROM $3`,
      [d.day, sealText(JSON.stringify(next)), sealed],
    );
    changed.push(d.day);
  }
  if (changed.length) await touchDays(changed);
  return out;
}

/** Bearable's symptoms and energy, sealed with the day's health (source bearable). */
async function sealHealth(days: BearableDay[], tz: string): Promise<number> {
  const want = days.filter((d) => d.symptoms?.length || d.energy);
  if (!want.length) return 0;
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  let n = 0;
  for (const d of want) {
    const value = { ...(d.energy ? { energy: d.energy } : {}), ...(d.symptoms?.length ? { symptoms: d.symptoms } : {}) };
    const [prev] = await qRaw<{ ciphertext: string }>(`SELECT ciphertext FROM sensitive_blobs WHERE domain = 'health' AND source = 'bearable' AND day = $1::date`, [d.day]);
    let same = false;
    try {
      same = !!prev && openStrict(prev.ciphertext) === JSON.stringify(value);
    } catch {
      same = false;
    }
    if (same) continue;
    await qRaw(
      `INSERT INTO sensitive_blobs (domain, label, ciphertext, recorded_at, day, source)
       VALUES ('health', $1, $2, $3::timestamptz, $4::date, 'bearable')
       ON CONFLICT (domain, source, day) WHERE day IS NOT NULL
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext, label = EXCLUDED.label, recorded_at = EXCLUDED.recorded_at`,
      [`Health · ${d.day} · Bearable`, sealText(JSON.stringify(value)), zonedToInstant(d.day, "12:00", tz).toISOString(), d.day],
    );
    n++;
  }
  return n;
}

/** Write a batch of one format's days. Safe to repeat: the same days again change nothing. */
export async function importBackfill(format: ImportFormat, days: Array<{ day: string }>, opts: { now?: Date; target?: HistoryTarget } = {}): Promise<BackfillResult> {
  const target = opts.target ?? (await importTarget());
  const withEntries = days.filter((d) => toEntries[format](d as never).length);
  const { outcomes, ...fold } = await importToDays(target, withEntries, (d) => toEntries[format](d as never), { metric: null, from: `import-${format}`, now: opts.now });
  const today = zonedToday(opts.now ?? new Date(), target.tz);
  const due = days.filter((d) => d.day <= today);
  const priv = format === "daylio" || format === "bearable" ? await fillPrivate(due as MoodDay[]) : { moods_set: 0, moods_kept: 0, journals_added: 0 };
  const health_days = format === "bearable" ? await sealHealth(due as BearableDay[], target.tz) : 0;
  return { ...fold, added: outcomes.filter((o) => o.action === "created").length, ...priv, health_days };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 1_000_000) throw new AthenaInputError("That's too much for one request");
  try {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new AthenaInputError("Send JSON");
  }
}

/** Handles /api/days/import…; null for anything else. */
export async function handleImportRoutes(req: Request, segments: string[], json: Json): Promise<Response | null> {
  const [, first, second, third] = segments;
  if (first !== "days" || second !== "import" || segments.length > 4) return null;
  try {
    if (segments.length === 3) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const target = await importTarget();
      const imports: Record<string, LastImport | null> = {};
      for (const f of IMPORT_FORMATS) imports[f] = await lastImport(memoId(f));
      imports.amazon = await lastImport(AMAZON_MEMO);
      for (const f of DOWNLOAD_FORMATS) imports[f] = await lastImport(memoId(f));
      return json({ imports, collection: target.collection, source: target.source });
    }
    // The Amazon export has its own parts (orders, media, finished, undo): netlify/lib/days/amazon-import.ts.
    if (third === "amazon") return await handleAmazonImport(req, () => body(req), json);
    // Apple Music and BBC iPlayer: days and undo (below).
    if (isDownload(third)) return await handleDownloadImport(third, req, () => body(req), json);
    if (!isFormat(third)) return json({ error: "Not found" }, 404);
    if (req.method === "GET") {
      const target = await importTarget();
      return json({ collection: target.collection, source: target.source, last_import: await lastImport(memoId(third)) });
    }
    if (req.method === "POST") {
      const b = await body(req);
      const days = readImportDays(third, b.days);
      const r = await importBackfill(third, days);
      await rememberImport(memoId(third), b.file);
      return json(r);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof AthenaInputError) return json({ error: error.message }, error.status ?? 400);
    if (error instanceof DataBoxError) return json({ error: "Athena can't open or save this right now: its encryption key isn't set here." }, 503);
    throw error;
  }
}

// ---------- Apple Music and BBC iPlayer ----------

export const DOWNLOAD_FORMATS = ["apple_music", "iplayer", "spotify_history"] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];
const isDownload = (v: unknown): v is DownloadFormat => typeof v === "string" && (DOWNLOAD_FORMATS as readonly string[]).includes(v);
const DOWNLOAD_SOURCE: Record<DownloadFormat, string> = { apple_music: APPLE_MUSIC_SOURCE, iplayer: IPLAYER_SOURCE, spotify_history: SPOTIFY_SOURCE };

const TRACK_KEY = /^t[0-9a-z]{7}$/;
const PROGRAMME_KEY = /^(p[0-9a-z]{7}|[bmpw][0-9a-z]{7})$/;
const ENTRY_ID = /^\d{4}-\d{2}-\d{2}:[a-z0-9]{8}$/;
/** An album-and-day id (albumDayId): the day, then the album and artist normalised. */
const ALBUM_DAY_ID = /^\d{4}-\d{2}-\d{2}:[^\u0000-\u001f]{1,289}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNDO = 5000;

export function readListenDays(raw: unknown): ListenDay[] {
  return readDays<ListenDay>(raw, (o, day) => {
    const list = o.tracks;
    if (!Array.isArray(list) || !list.length) throw new AthenaInputError(`days: ${day} has no songs`);
    const tracks = list.map((t): Track => {
      const x = (t ?? {}) as Record<string, unknown>;
      const key = typeof x.key === "string" && TRACK_KEY.test(x.key) ? x.key : "";
      const title = str(x.title, 300);
      if (!key || !title) throw new AthenaInputError(`days: ${day} has a song without its key or title`);
      const artist = str(x.artist, 200);
      const album = str(x.album, 200);
      return { key, title, ...(artist ? { artist } : {}), ...(album ? { album } : {}), minutes: int(x.minutes, 1, 1440) ?? 1, plays: int(x.plays, 1, 1000) ?? 1 };
    });
    return { d: { day, tracks }, n: tracks.length };
  });
}

export function readSpotifyDays(raw: unknown): SpotifyDay[] {
  return readDays<SpotifyDay>(raw, (o, day) => {
    const list = o.albums;
    if (!Array.isArray(list) || !list.length) throw new AthenaInputError(`days: ${day} has no albums`);
    const albums = list.map((a): AlbumDay => {
      const x = (a ?? {}) as Record<string, unknown>;
      const title = str(x.title, 300);
      if (!title) throw new AthenaInputError(`days: ${day} has an album without its name`);
      const artist = str(x.artist, 200);
      const plays = int(x.plays, 1, 5000) ?? 1;
      const hours = readHours(x.hours);
      return { title, ...(artist ? { artist } : {}), plays, minutes: int(x.minutes, 1, 1440) ?? 1, hours: hours ?? [] };
    });
    return { d: { day, albums }, n: albums.length };
  });
}

export function readWatchDays(raw: unknown): WatchDay[] {
  return readDays<WatchDay>(raw, (o, day) => {
    const list = o.programmes;
    if (!Array.isArray(list) || !list.length) throw new AthenaInputError(`days: ${day} has no programmes`);
    const programmes = list.map((p): Programme => {
      const x = (p ?? {}) as Record<string, unknown>;
      const key = typeof x.key === "string" && PROGRAMME_KEY.test(x.key) ? x.key : "";
      const title = str(x.title, 300);
      if (!key || !title) throw new AthenaInputError(`days: ${day} has a programme without its id or title`);
      const episode = str(x.episode, 200);
      const series = episode ? str(x.series, 80) : "";
      const minutes = int(x.minutes, 1, 1440);
      return { key, title, ...(series ? { series } : {}), ...(episode ? { episode } : { film: true }), ...(minutes ? { minutes } : {}) };
    });
    return { d: { day, programmes }, n: programmes.length };
  });
}

/** The Last.fm entries on these days, opened, for leaving out what Last.fm already has. */
async function lastfmLines(days: string[]): Promise<Map<string, LastfmLine[]>> {
  const out = new Map<string, LastfmLine[]>();
  if (!days.length) return out;
  const rows = await q<{ date: string; title: string; subtitle: string | null; grp: string | null }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, title, subtitle, grp FROM day_entries WHERE source = 'lastfm' AND kind = 'listened' AND archived_at IS NULL AND date = ANY($1::date[])`,
    [days],
  );
  for (const r of rows) (out.get(r.date) ?? out.set(r.date, []).get(r.date)!).push({ title: r.title, ...(r.subtitle ? { subtitle: r.subtitle } : {}), ...(r.grp ? { group: r.grp } : {}) });
  return out;
}

export interface DownloadResult extends FoldResult {
  /** Entries Days didn't have before. */
  added: number;
  /** Days that gained one. */
  days_added: number;
  /** Minutes those entries add up to. */
  minutes_added: number;
  /** Apple Music: songs left out because Last.fm has them that day. */
  skipped_lastfm: number;
  /** iPlayer: series and films put in Watch & read, and ones there already that were filled in. */
  watch_read: { created: number; updated: number };
  ids: { entries: string[]; watch_read: string[] };
}

/** One batch of Apple Music days. Safe to repeat: the same days again add nothing. */
export async function importAppleMusic(days: ListenDay[], opts: { now?: Date; target?: HistoryTarget } = {}): Promise<DownloadResult> {
  const target = opts.target ?? (await importTarget());
  const { days: keep, skipped } = notOnLastfm(days, await lastfmLines(days.map((d) => d.day)));
  const { outcomes, ...fold } = await importToDays(target, keep.filter((d) => d.tracks.length), appleMusicEntries, { metric: null, from: "import-apple_music", now: opts.now });
  const created = outcomes.filter((o) => o.action === "created");
  return {
    ...fold,
    added: created.length,
    days_added: new Set(created.map((c) => c.day)).size,
    minutes_added: created.reduce((k, c) => k + (c.entry.minutes ?? 0), 0),
    skipped_lastfm: skipped,
    watch_read: { created: 0, updated: 0 },
    ids: { entries: created.map((c) => c.entry.external_id), watch_read: [] },
  };
}

/**
 * One batch of Spotify streaming-history days. Safe to repeat: the same days
 * again add nothing. An album Last.fm already has that day is left to it
 * (Spotify usually scrobbles there). A day a Life log run wrote for Spotify
 * under its own ids keeps its entries and only gains when they were played.
 */
export async function importSpotifyHistory(days: SpotifyDay[], opts: { now?: Date; target?: HistoryTarget } = {}): Promise<DownloadResult> {
  const target = opts.target ?? (await importTarget());
  const lastfm = await lastfmLines(days.map((d) => d.day));
  let skipped = 0;
  const kept = days.map((d) => {
    const lines = lastfm.get(d.day);
    if (!lines?.length) return d;
    const albums = d.albums.filter((a) => !lastfmCovers({ title: a.title, artist: a.artist }, lines));
    skipped += d.albums.length - albums.length;
    return { day: d.day, albums };
  });
  // Days with a Spotify entry this import didn't make: the Life log run's.
  const ours = new Set(kept.flatMap((d) => spotifyHistoryEntries(d).flatMap((e) => extKeys(SPOTIFY_SOURCE, e.external_id))));
  const theirs = new Set(
    (await q<{ date: string; ext_key: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, ext_key FROM day_entries WHERE source = $1 AND kind = 'listened' AND date = ANY($2::date[])`, [SPOTIFY_SOURCE, kept.map((d) => d.day)]))
      .filter((r) => !ours.has(r.ext_key))
      .map((r) => r.date),
  );
  await fillEntryHours(kept.filter((d) => theirs.has(d.day)).flatMap((d) => spotifyHistoryEntries(d).map((entry) => ({ date: d.day, entry }))));
  const write = kept.filter((d) => d.albums.length && !theirs.has(d.day));
  const { outcomes, ...fold } = await importToDays(target, write, spotifyHistoryEntries, { metric: null, from: "import-spotify_history", now: opts.now });
  const created = outcomes.filter((o) => o.action === "created");
  return {
    ...fold,
    added: created.length,
    days_added: new Set(created.map((c) => c.day)).size,
    minutes_added: created.reduce((k, c) => k + (c.entry.minutes ?? 0), 0),
    skipped_lastfm: skipped,
    watch_read: { created: 0, updated: 0 },
    ids: { entries: created.map((c) => c.entry.external_id), watch_read: [] },
  };
}

/** One batch of iPlayer days, and their series and films into Watch & read. Safe to repeat. */
export async function importIplayer(days: WatchDay[], opts: { now?: Date; target?: HistoryTarget } = {}): Promise<DownloadResult> {
  const target = opts.target ?? (await importTarget());
  const { outcomes, ...fold } = await importToDays(target, days, iplayerEntries, { metric: null, from: "import-iplayer", now: opts.now });
  const created = outcomes.filter((o) => o.action === "created");
  // One Watch & read item per series and film, on the first day it was watched; a series stays Watching until the owner says it's done.
  const today = zonedToday(opts.now ?? new Date(), target.tz);
  const items = new Map<string, WatchReadInput>();
  for (const d of days) {
    if (d.day > today) continue;
    for (const p of d.programmes) {
      if (NOT_FOR_WATCH_READ.test(p.title)) continue;
      const kind = p.film ? ("film" as const) : ("tv" as const);
      const k = `${kind}:${titleKey(p.title)}`;
      if (!items.has(k)) items.set(k, { kind, title: p.title, status: kind === "tv" ? "reading" : "done", at: d.day, external_id: `${kind === "tv" ? "show" : "film"}:${titleKey(p.title)}`, source: "iplayer" });
    }
  }
  const synced = items.size ? await syncWatchRead([...items.values()], { collection: target.source, now: opts.now }) : [];
  const made = synced.filter((x) => x.action === "created");
  return {
    ...fold,
    added: created.length,
    days_added: new Set(created.map((c) => c.day)).size,
    minutes_added: created.reduce((k, c) => k + (c.entry.minutes ?? 0), 0),
    skipped_lastfm: 0,
    watch_read: { created: made.length, updated: synced.filter((x) => x.action === "updated").length },
    ids: { entries: created.map((c) => c.entry.external_id), watch_read: made.map((x) => x.id).filter((id): id is string => !!id) },
  };
}

/** Archive what one Apple Music or iPlayer import created. Hidden entries stay hidden on a later import. */
export async function undoDownload(format: DownloadFormat, raw: Record<string, unknown>): Promise<{ entries: number; watch_read: number }> {
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const ids = list(raw.entries).filter((e): e is string => typeof e === "string" && (format === "spotify_history" ? ALBUM_DAY_ID : ENTRY_ID).test(e));
  const watch = list(raw.watch_read).filter((id): id is string => typeof id === "string" && UUID.test(id));
  if (ids.length + watch.length > MAX_UNDO) throw new AthenaInputError(`undo: at most ${MAX_UNDO} per request`);
  const source = DOWNLOAD_SOURCE[format];
  let entries = 0;
  const keys = ids.flatMap((e) => extKeys(source, e));
  if (keys.length) {
    const rows = await qRaw<{ date: string }>(
      `UPDATE day_entries SET archived_at = now(), updated_at = now() WHERE source = $1 AND ext_key = ANY($2::text[]) AND archived_at IS NULL RETURNING to_char(date, 'YYYY-MM-DD') AS date`,
      [source, keys],
    );
    entries = rows.length;
    if (rows.length) await touchDays([...new Set(rows.map((r) => r.date))]);
  }
  let watch_read = 0;
  if (format === "iplayer") for (const id of watch) if (await archiveEntity("reading", id)) watch_read++;
  return { entries, watch_read };
}

/** /api/days/import/apple_music, /iplayer and /spotify_history. */
async function handleDownloadImport(format: DownloadFormat, req: Request, readBody: () => Promise<Record<string, unknown>>, json: Json): Promise<Response> {
  if (req.method === "GET") {
    const target = await importTarget();
    return json({ collection: target.collection, source: target.source, last_import: await lastImport(memoId(format)) });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await readBody();
  if (b.part === "undo") return json(await undoDownload(format, b));
  if (b.part !== "days") throw new AthenaInputError("part: days or undo");
  const r = format === "apple_music" ? await importAppleMusic(readListenDays(b.days)) : format === "spotify_history" ? await importSpotifyHistory(readSpotifyDays(b.days)) : await importIplayer(readWatchDays(b.days));
  await rememberImport(memoId(format), b.file);
  return json(r);
}
