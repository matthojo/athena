/**
 * Apple Music listening history, from the data copy privacy.apple.com sends
 * (Apple Media Services). Pure, so the app (components/apple-music-import.ts),
 * the server and the tests share it, like lib/netflix-csv.ts.
 *
 * Two shapes of file, found by their columns, never their names (Apple
 * renames them between exports):
 *
 *  - "Apple Music Play Activity.csv": one row per play event. Song Name,
 *    Artist Name (newer files: Container Artist Name), Album Name, Event
 *    Start Timestamp (UTC), Play Duration Milliseconds, Media Type, End
 *    Reason Type… Plays under 30 seconds are skipped (a skip, a preview).
 *  - "Apple Music - Play History Daily Tracks.csv": one row per track per
 *    day. Track Description ("Artist - Title"), Date Played (YYYYMMDD, the
 *    listener's day), Play Duration Milliseconds, Play Count, Skip Count.
 *    A row whose plays average under 30 seconds is skipped.
 *
 * Per day, each track once: title, artist, album, minutes and plays. Its key
 * is a hash of artist and title, so the two shapes (and a newer export) give
 * the same key for the same song, and the server's ids (`<day>:<key>`,
 * lib/day-imports.ts) don't change between imports. When an export holds
 * both shapes for one day, the fuller of the two counts, never both.
 *
 * Accepts the CSV itself, or the zip Apple sends (zips inside zips too),
 * read entry by entry (`findExportFiles`). Big files are parsed a slice at a
 * time with `pause` between, so the page keeps responding.
 */
import { zonedParts } from "./dates";
import { titleKey } from "./netflix-csv";
import { AmazonExportError, bytesSource, norm, tidy, zipEntries, ZIP_LIMITS, type ByteSource, type ZipEntry } from "./amazon-export";

export { blobSource, bytesSource, isZipSource, type ByteSource } from "./amazon-export";

// ---------- Shapes ----------

export type AppleFileKind = "activity" | "daily";

export interface Track {
  /** Hash of artist and title (`trackKey`): the same song in either file shape. */
  key: string;
  title: string;
  artist?: string;
  album?: string;
  /** Whole minutes listened that day, at least 1. */
  minutes: number;
  plays: number;
}

export interface ListenDay {
  day: string;
  tracks: Track[];
}

export interface Ranked {
  name: string;
  minutes: number;
  plays: number;
}

export interface AppleMusicExport {
  /** Oldest first. */
  days: ListenDay[];
  counts: { days: number; plays: number; tracks: number; minutes: number; artists: number };
  /** Most listened to first, by minutes. */
  top: { artists: Ranked[]; tracks: Array<Ranked & { artist?: string }> };
  range: { first: string; last: string } | null;
  files: Array<{ name: string; kind: AppleFileKind }>;
  skipped: { short: number; undated: number; future: number; video: number };
}

export class AppleMusicError extends Error {
  constructor(public readonly reason: "not-zip" | "nothing" | "too-big" | "unreadable") {
    super(reason);
  }
}

/** A play shorter than this is a skip or a preview, not a listen. */
export const MIN_PLAY_MS = 30_000;

// ---------- Keys ----------

/** A short, stable key for a song (FNV-1a over artist and title as titleKey reads them). */
export function trackKey(artist: string | undefined, title: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${titleKey(artist ?? "")}|${titleKey(title) || title.toLowerCase()}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t${h.toString(36).padStart(7, "0")}`;
}

// ---------- Headers ----------

const SONG = ["songname", "contentname", "trackname", "title"];
const ARTIST = ["artistname", "containerartistname", "artist"];
const ALBUM = ["albumname", "containeralbumname", "containername", "album"];
const PLAY_MS = ["playdurationmilliseconds", "playdurationms", "playduration"];
const EVENT_TIME = ["eventstarttimestamp", "eventendtimestamp", "eventreceivedtimestamp", "eventtimestamp"];
const MEDIA = ["mediatype", "itemtype", "contentspecifictype"];
const DESCRIPTION = ["trackdescription"];
const DATE_PLAYED = ["dateplayed"];
const PLAY_COUNT = ["playcount"];

const has = (h: Set<string>, names: string[]) => names.some((n) => h.has(n));

/** Which Apple Music file this is, from its header row; null for anything else in the export. */
export function sniffApple(header: string[]): AppleFileKind | null {
  const h = new Set(header.map(norm));
  if (has(h, DESCRIPTION) && has(h, DATE_PLAYED)) return "daily";
  if (has(h, SONG) && has(h, PLAY_MS) && has(h, EVENT_TIME)) return "activity";
  return null;
}

// ---------- Zip (entry by entry; shared with lib/iplayer-export.ts) ----------

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

async function entryStream(src: ByteSource, entry: ZipEntry, upTo = entry.compressed): Promise<ReadableStream<Uint8Array>> {
  const head = new DataView((await src.read(entry.offset, entry.offset + 30)).slice().buffer);
  if (u32(head, 0) !== 0x04034b50) throw new AmazonExportError("unreadable");
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = await src.read(start, start + Math.min(upTo, entry.compressed));
  const stream = new Blob([raw as BlobPart]).stream() as ReadableStream<Uint8Array>;
  if (entry.method === 0) return stream;
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") throw new AmazonExportError("unreadable");
  return stream.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number, partial: boolean): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.byteLength;
      if (bytes >= limit) {
        if (partial) break;
        throw new AmazonExportError("too-big");
      }
    }
  } catch (err) {
    // A head read from a cut-off slice ends in a decompression error: what came out is enough.
    if (!partial || err instanceof AmazonExportError) throw err;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(bytes, limit));
  let at = 0;
  for (const p of parts) {
    if (at >= out.length) break;
    out.set(p.subarray(0, out.length - at), at);
    at += p.byteLength;
  }
  return out;
}

/** The first line of a CSV, as cells. */
export function headerOf(text: string): string[] {
  const line = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") cells.push(cur), (cur = "");
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

export interface FoundCsv<K extends string> {
  name: string;
  kind: K;
  bytes: number;
  text: () => Promise<string>;
}

/**
 * The CSVs `sniff` wants in a zip, nested zips included, each read only as
 * far as its header until it's wanted.
 */
export async function findExportFiles<K extends string>(
  src: ByteSource,
  sniff: (header: string[]) => K | null,
  opts: { progress?: (looked: number, total: number) => void; depth?: number; prefix?: string; byName?: (name: string) => string | null } = {},
): Promise<Array<FoundCsv<K>>> {
  const entries = await zipEntries(src);
  const out: Array<FoundCsv<K>> = [];
  const depth = opts.depth ?? 0;
  const prefix = opts.prefix ?? "";
  let looked = 0;
  for (const e of entries) {
    looked++;
    opts.progress?.(looked, entries.length);
    if (/(^|\/)(__MACOSX|\.)/.test(e.name)) continue;
    if (/\.zip$/i.test(e.name) && depth < ZIP_LIMITS.depth && e.size <= ZIP_LIMITS.nestedBytes) {
      try {
        const inner = await collect(await entryStream(src, e), ZIP_LIMITS.nestedBytes, false);
        out.push(...(await findExportFiles(bytesSource(inner), sniff, { depth: depth + 1, prefix: `${prefix}${e.name}/`, byName: opts.byName })));
      } catch {
        // A nested zip that won't open is skipped; the rest still comes in.
      }
      continue;
    }
    // A file the import knows by its name (Spotify's JSON), whatever its contents begin with.
    const named = opts.byName?.(e.name);
    if (named && e.size > 0 && e.size <= ZIP_LIMITS.entryBytes) {
      out.push({ name: `${prefix}${e.name}`, kind: named as K, bytes: e.size, text: async () => new TextDecoder().decode(await collect(await entryStream(src, e), ZIP_LIMITS.entryBytes + 1, false)) });
      continue;
    }
    if (!/\.csv$/i.test(e.name) || e.size === 0 || e.size > ZIP_LIMITS.entryBytes) continue;
    let kind: K | null;
    try {
      kind = sniff(headerOf(new TextDecoder().decode(await collect(await entryStream(src, e, 32 * 1024), 16 * 1024, true))));
    } catch {
      continue;
    }
    if (!kind) continue;
    out.push({
      name: `${prefix}${e.name}`,
      kind,
      bytes: e.size,
      text: async () => new TextDecoder().decode(await collect(await entryStream(src, e), ZIP_LIMITS.entryBytes + 1, false)),
    });
  }
  if (depth === 0 && out.reduce((k, f) => k + f.bytes, 0) > ZIP_LIMITS.totalBytes) throw new AmazonExportError("too-big");
  return out;
}

// ---------- Rows, a slice at a time ----------

/**
 * Every CSV row through `each`, the header first, without holding the rows:
 * a 200 MB Play Activity file never becomes a 200 MB array. `pause` is
 * awaited every `slice` characters.
 */
export async function eachCsvRow(text: string, each: (row: string[], at: number) => void, pause: () => Promise<void>, slice = 256 * 1024): Promise<void> {
  const s = text;
  const n = s.length;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let next = i + slice;
  let row: string[] = [];
  const end = () => {
    if (row.some((f) => f.trim() !== "")) each(row, i / Math.max(1, n));
    row = [];
  };
  while (i < n) {
    if (i >= next) {
      next = i + slice;
      await pause();
    }
    let field: string;
    if (s.charCodeAt(i) === 34) {
      let j = i + 1;
      let parts = "";
      for (;;) {
        const q = s.indexOf('"', j);
        if (q < 0) {
          parts += s.slice(j);
          j = n;
          break;
        }
        parts += s.slice(j, q);
        if (s.charCodeAt(q + 1) === 34) {
          parts += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      let k = j;
      while (k < n && s[k] !== "," && s[k] !== "\n" && s[k] !== "\r") k++;
      field = parts + s.slice(j, k);
      i = k;
    } else {
      let k = i;
      while (k < n && s[k] !== "," && s[k] !== "\n" && s[k] !== "\r") k++;
      field = s.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) break;
    if (s[i] === ",") {
      i++;
      if (i >= n) row.push("");
    } else {
      i += s[i] === "\r" && s[i + 1] === "\n" ? 2 : 1;
      end();
    }
  }
  if (row.length) end();
}

/** "durationwatchedseconds" is "durationwatched" with its unit: a header name plus a unit or zone, nothing else. */
export const withUnit = (header: string, name: string) => header.startsWith(name) && /^(seconds?|secs?|minutes?|mins?|ms|milliseconds?|utc|gmt|local|localtime)$/.test(header.slice(name.length));

/** Column lookup by normalised header name. */
export class Columns {
  private idx = new Map<string, number>();
  constructor(header: string[]) {
    header.forEach((h, i) => {
      const k = norm(h);
      if (!this.idx.has(k)) this.idx.set(k, i);
    });
  }
  /** The first of `names` the file has; else a column that starts with one ("Duration Watched (seconds)" for durationwatched). */
  find(names: string[]): number {
    for (const n of names) if (this.idx.has(n)) return this.idx.get(n)!;
    for (const n of names) for (const [k, i] of this.idx) if (withUnit(k, n)) return i;
    return -1;
  }
  /** The first column whose name matches. */
  match(re: RegExp): number {
    for (const [k, i] of this.idx) if (re.test(k)) return i;
    return -1;
  }
}

const NA = /^(not available|n\/a|na|none|null|undefined|-|unknown)$/i;
export const cellOf = (row: string[], i: number) => {
  if (i < 0) return "";
  const v = (row[i] ?? "").trim();
  return NA.test(v) ? "" : v;
};

// ---------- Parsing ----------

export interface AppleParseOptions {
  /** The owner's zone, for the day a UTC play falls on. Default UTC. */
  tz?: string;
  /** YYYY-MM-DD: later days are left out. Default today in `tz`. */
  today?: string;
  pause?: () => Promise<void>;
  /** 0–1 across all the files. */
  progress?: (fraction: number) => void;
}

/** "Radiohead - Weird Fishes/Arpeggi" → artist, title. Only the first " - " splits: titles often have their own. */
export function splitDescription(raw: string): { artist?: string; title: string } {
  const at = raw.indexOf(" - ");
  if (at <= 0) return { title: tidy(raw) };
  const artist = tidy(raw.slice(0, at), 200);
  const title = tidy(raw.slice(at + 3));
  return title ? { artist, title } : { title: tidy(raw) };
}

/** An instant from Apple's timestamps: "2024-03-14T10:22:31.123Z", "2024-03-14 10:22:31", epoch ms. */
function instant(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s));
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m) return null;
  const zone = !m[3] || /^(z|utc)$/i.test(m[3]) ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "20240314" or "2024-03-14" → 2024-03-14. */
function playedDay(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? null : d;
}

const num = (raw: string) => {
  const v = Number(raw.replace(/,/g, ""));
  return Number.isFinite(v) ? v : 0;
};

interface Acc {
  title: string;
  artist?: string;
  album?: string;
  ms: number;
  plays: number;
}

/**
 * Read an export's Apple Music files into days of tracks. `files` are what
 * `findExportFiles(src, sniffApple)` found, or plain texts (the tests, the
 * sample, a loose CSV).
 */
export async function parseAppleMusic(files: Array<{ name: string; text: string }>, opts: AppleParseOptions = {}): Promise<AppleMusicExport> {
  const tz = opts.tz ?? "UTC";
  const today = opts.today ?? zonedParts(new Date(), tz).date;
  const pause = opts.pause ?? (async () => undefined);
  const skipped = { short: 0, undated: 0, future: 0, video: 0 };
  // Per file shape, then day, then track: the shapes are compared, never added together.
  const byKind: Record<AppleFileKind, Map<string, Map<string, Acc>>> = { activity: new Map(), daily: new Map() };
  const read: Array<{ name: string; kind: AppleFileKind }> = [];
  const total = files.reduce((k, f) => k + f.text.length, 0) || 1;
  let done = 0;

  const put = (kind: AppleFileKind, day: string, title: string, artist: string | undefined, album: string | undefined, ms: number, plays: number) => {
    const days = byKind[kind];
    const tracks = days.get(day) ?? days.set(day, new Map()).get(day)!;
    const key = trackKey(artist, title);
    const a = tracks.get(key) ?? tracks.set(key, { title, ...(artist ? { artist } : {}), ms: 0, plays: 0 }).get(key)!;
    a.ms += ms;
    a.plays += plays;
    if (!a.album && album) a.album = album;
  };

  for (const f of files) {
    const kind = sniffApple(headerOf(f.text));
    if (!kind) {
      done += f.text.length;
      continue;
    }
    read.push({ name: f.name, kind });
    let cols: Columns | null = null;
    let c: Record<string, number> = {};
    await eachCsvRow(
      f.text,
      (row, at) => {
        if (!cols) {
          cols = new Columns(row);
          c = {
            song: cols.find(SONG),
            artist: cols.find(["artistname"]),
            container: cols.find(["containerartistname"]),
            album: cols.find(ALBUM),
            ms: cols.find(PLAY_MS),
            start: cols.find(EVENT_TIME),
            end: cols.find(["eventendtimestamp"]),
            media: cols.find(MEDIA),
            desc: cols.find(DESCRIPTION),
            date: cols.find(DATE_PLAYED),
            count: cols.find(PLAY_COUNT),
          };
          return;
        }
        opts.progress?.(Math.min(1, (done + at * f.text.length) / total));
        if (kind === "daily") {
          const day = playedDay(cellOf(row, c.date));
          if (!day) return void skipped.undated++;
          if (day > today) return void skipped.future++;
          if (/video/i.test(cellOf(row, c.media))) return void skipped.video++;
          const { artist, title } = splitDescription(cellOf(row, c.desc));
          if (!title) return void skipped.undated++;
          const ms = num(cellOf(row, c.ms));
          const plays = Math.max(1, Math.round(num(cellOf(row, c.count))) || 1);
          if (ms < MIN_PLAY_MS || ms / plays < MIN_PLAY_MS) return void skipped.short++;
          put("daily", day, title, artist, undefined, ms, plays);
          return;
        }
        const ms = num(cellOf(row, c.ms));
        const title = tidy(cellOf(row, c.song));
        // Rows with no song (lyrics shown, a radio station, an event with no play) aren't listens.
        if (!title) return;
        if (/video/i.test(cellOf(row, c.media))) return void skipped.video++;
        if (ms < MIN_PLAY_MS) return void skipped.short++;
        const when = instant(cellOf(row, c.start)) ?? instant(cellOf(row, c.end));
        if (!when) return void skipped.undated++;
        const day = zonedParts(when, tz).date;
        if (day > today) return void skipped.future++;
        const artist = tidy(cellOf(row, c.artist) || cellOf(row, c.container), 200) || undefined;
        const album = tidy(cellOf(row, c.album), 200) || undefined;
        put("activity", day, title, artist, album, ms, 1);
      },
      pause,
    );
    done += f.text.length;
    await pause();
  }

  // One day's tracks: from whichever shape has more of that day (an export can hold both).
  const allDays = new Set([...byKind.activity.keys(), ...byKind.daily.keys()]);
  const days: ListenDay[] = [];
  for (const day of [...allDays].sort()) {
    const a = byKind.activity.get(day) ?? new Map<string, Acc>();
    const d = byKind.daily.get(day) ?? new Map<string, Acc>();
    const keys = new Set([...a.keys(), ...d.keys()]);
    const tracks: Track[] = [];
    for (const key of keys) {
      const x = a.get(key);
      const y = d.get(key);
      const best = !x ? y! : !y ? x : y.ms > x.ms ? { ...y, album: y.album ?? x.album, artist: y.artist ?? x.artist } : { ...x, artist: x.artist ?? y.artist };
      tracks.push({
        key,
        title: best.title,
        ...(best.artist ? { artist: best.artist } : {}),
        ...(best.album ? { album: best.album } : {}),
        minutes: Math.max(1, Math.round(best.ms / 60_000)),
        plays: best.plays,
      });
    }
    tracks.sort((p, q) => q.minutes - p.minutes || p.title.localeCompare(q.title));
    if (tracks.length) days.push({ day, tracks });
  }
  return summarise(days, read, skipped);
}

function summarise(days: ListenDay[], files: AppleMusicExport["files"], skipped: AppleMusicExport["skipped"]): AppleMusicExport {
  const artists = new Map<string, Ranked>();
  const tracks = new Map<string, Ranked & { artist?: string }>();
  let plays = 0;
  let minutes = 0;
  for (const d of days)
    for (const t of d.tracks) {
      plays += t.plays;
      minutes += t.minutes;
      if (t.artist) {
        const k = titleKey(t.artist);
        const a = artists.get(k) ?? artists.set(k, { name: t.artist, minutes: 0, plays: 0 }).get(k)!;
        a.minutes += t.minutes;
        a.plays += t.plays;
      }
      const s = tracks.get(t.key) ?? tracks.set(t.key, { name: t.title, ...(t.artist ? { artist: t.artist } : {}), minutes: 0, plays: 0 }).get(t.key)!;
      s.minutes += t.minutes;
      s.plays += t.plays;
    }
  const rank = <R extends Ranked>(m: Map<string, R>) => [...m.values()].sort((a, b) => b.minutes - a.minutes || b.plays - a.plays || a.name.localeCompare(b.name)).slice(0, 10);
  return {
    days,
    counts: { days: days.length, plays, tracks: tracks.size, minutes, artists: artists.size },
    top: { artists: rank(artists), tracks: rank(tracks) },
    range: days.length ? { first: days[0].day, last: days[days.length - 1].day } : null,
    files,
    skipped,
  };
}

// ---------- What goes to the server ----------

/** Whole days for one request: at most 120 days or 600 tracks. */
export function batchListenDays(days: ListenDay[], maxDays = 120, maxItems = 600): ListenDay[][] {
  const out: ListenDay[][] = [];
  let cur: ListenDay[] = [];
  let n = 0;
  for (const d of days) {
    const k = Math.max(1, d.tracks.length);
    if (cur.length && (cur.length >= maxDays || n + k > maxItems)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    // A day with more tracks than one request takes is cut to its most-played.
    cur.push(k > maxItems ? { day: d.day, tracks: d.tracks.slice(0, maxItems) } : d);
    n += Math.min(k, maxItems);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The busiest months by minutes, for the preview's bars. */
export function listeningMonths(x: Pick<AppleMusicExport, "days">, k = 5): Array<{ month: string; minutes: number }> {
  const m = new Map<string, number>();
  for (const d of x.days) m.set(d.day.slice(0, 7), (m.get(d.day.slice(0, 7)) ?? 0) + d.tracks.reduce((a, t) => a + t.minutes, 0));
  return [...m.entries()].map(([month, minutes]) => ({ month, minutes })).sort((a, b) => b.minutes - a.minutes || b.month.localeCompare(a.month)).slice(0, k);
}

export { AmazonExportError as ZipError };
