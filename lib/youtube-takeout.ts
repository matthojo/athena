/**
 * YouTube watch history from Google Takeout ("watch-history.json", or the
 * .html version), turned into Life log days.
 *
 * Shared by the app and the server, so it has no Node or DOM imports. The
 * app parses the file on the device and sends only what each day needs
 * (video id, title, channel, how many times); the server merges those days
 * into the Life log's day notes (netlify/lib/connectors/youtube-history.ts).
 *
 * What's kept: videos watched on YouTube ("Watched on YouTube") and plays on
 * YouTube Music ("Listened on YouTube Music"), by day in the owner's zone.
 * What's dropped: ads ("From Google Ads"), removed or private videos with
 * no link, and the YouTube copy of a play YouTube Music also logged.
 *
 * In a day note the import owns those two sections and nothing else. A
 * Life log run that rewrites the day keeps them (`keepImported`), and a
 * second import of the same file changes nothing: each video's count is the
 * larger of what the note has and what the file says, never the sum.
 */

import { zonedParts } from "./dates";
import { keepBooks } from "./goodreads-csv";
import { keepNetflix } from "./netflix-csv";
import { keepPlaces } from "./places-line";

export interface TakeoutWatch {
  /** The 11-character YouTube video id. */
  id: string;
  title: string;
  channel: string;
  /** When, as an ISO instant. */
  at: string;
  /** Played on YouTube Music. */
  music: boolean;
}

export interface TakeoutSkipped {
  ads: number;
  removed: number;
  music_duplicates: number;
  /** Not a watch (a visit, a search), or a date the parser couldn't read. */
  other: number;
}

export interface TakeoutParse {
  watches: TakeoutWatch[];
  skipped: TakeoutSkipped;
  /** The file's format, for the notes and the sheet's "Read 41,203 videos from…". */
  format: "json" | "html";
}

/** One video on one day. */
export interface DayVideo {
  id: string;
  title: string;
  channel: string;
  count: number;
  music: boolean;
}

export interface TakeoutDay {
  /** YYYY-MM-DD in the owner's zone. */
  day: string;
  videos: DayVideo[];
}

export const WATCHED_HEADING = "## Watched on YouTube";
export const LISTENED_HEADING = "## Listened on YouTube Music";
const HEADINGS = [WATCHED_HEADING, LISTENED_HEADING];

/** Two entries for the same video this close together are one play logged twice (YouTube and YouTube Music). */
const TWIN_MS = 3 * 60_000;

const VIDEO_ID = /^[\w-]{11}$/;

/** The video id in a watch link (youtube.com, music.youtube.com, youtu.be), or null. */
export function videoIdFrom(url: string | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:(?:www|m|music)\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([\w-]{11})/.exec(url) ?? /^https?:\/\/youtu\.be\/([\w-]{11})/.exec(url);
  return m && VIDEO_ID.test(m[1]) ? m[1] : null;
}

const emptySkipped = (): TakeoutSkipped => ({ ads: 0, removed: 0, music_duplicates: 0, other: 0 });

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "Watched Severance trailer" → "Severance trailer". English exports only add the prefix; others keep the title as it is. */
const stripWatched = (title: string) => title.replace(/^Watched\s+/, "");

const REMOVED = /^(Watched )?a video that has been removed$/i;

interface JsonEntry {
  header?: string;
  title?: string;
  titleUrl?: string;
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
  products?: string[];
  details?: Array<{ name?: string }>;
}

function isAd(details: Array<{ name?: string }> | undefined): boolean {
  return !!details?.some((d) => /From Google Ads/i.test(d.name ?? ""));
}

/** watch-history.json: an array of activity entries, newest first. */
export function parseWatchHistoryJson(text: string): TakeoutParse {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new TakeoutError("unreadable");
  }
  if (!Array.isArray(data)) throw new TakeoutError("unreadable");
  const skipped = emptySkipped();
  const watches: TakeoutWatch[] = [];
  for (const raw of data as JsonEntry[]) {
    if (!raw || typeof raw !== "object") {
      skipped.other++;
      continue;
    }
    if (isAd(raw.details)) {
      skipped.ads++;
      continue;
    }
    const title = typeof raw.title === "string" ? raw.title : "";
    const id = videoIdFrom(raw.titleUrl);
    if (!id) {
      if (REMOVED.test(title.trim()) || /^Watched /.test(title)) skipped.removed++;
      else skipped.other++;
      continue;
    }
    const at = typeof raw.time === "string" ? new Date(raw.time) : null;
    if (!at || Number.isNaN(at.getTime())) {
      skipped.other++;
      continue;
    }
    const music = raw.header === "YouTube Music" || /music\.youtube\.com/.test(raw.titleUrl ?? "");
    const shown = clean(stripWatched(title), 300);
    watches.push({
      id,
      // A private video's title is its own link.
      title: !shown || /^https?:\/\//.test(shown) ? "" : shown,
      channel: clean(raw.subtitles?.[0]?.name ?? "", 120),
      at: at.toISOString(),
      music,
    });
  }
  return finish(watches, skipped, "json");
}

// ---------- HTML ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", emsp: " ", ensp: " ", thinsp: " " };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

const text = (html: string) => decode(html.replace(/<[^>]*>/g, ""));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Zone abbreviations Takeout prints, as minutes east of UTC. IST is left out: India and Ireland share it. */
const ZONES: Record<string, number> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600,
  AST: -240, ADT: -180, NST: -210, NDT: -150, JST: 540, KST: 540, HKT: 480, SGT: 480, AWST: 480, ACST: 570, ACDT: 630, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};

function zoneOffset(zone: string): number | null {
  const z = zone.trim().toUpperCase();
  if (z in ZONES) return ZONES[z];
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(z);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * A Takeout HTML date: "6 Nov 2026, 21:14:03 GMT" (UK English) or
 * "Nov 6, 2026, 9:14:03 PM EST" (US English), as an instant. Null when it
 * isn't one of those or names a zone it can't place.
 */
export function parseTakeoutDate(raw: string): Date | null {
  const s = raw.replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  const m =
    /^(?:(\d{1,2}) ([A-Za-z]+)\.?,? (\d{4})|([A-Za-z]+)\.? (\d{1,2}),? (\d{4})),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AaPp]\.?[Mm]\.?)? (.+)$/.exec(s);
  if (!m) return null;
  const day = Number(m[1] ?? m[5]);
  const month = MONTHS.indexOf((m[2] ?? m[4]).slice(0, 3).toLowerCase());
  const year = Number(m[3] ?? m[6]);
  let hour = Number(m[7]);
  const ampm = m[10]?.replace(/\./g, "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const offset = zoneOffset(m[11]);
  if (month < 0 || offset === null || day < 1 || day > 31 || hour > 23) return null;
  const at = new Date(Date.UTC(year, month, day, hour, Number(m[8]), Number(m[9] ?? 0)) - offset * 60_000);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** watch-history.html: one "outer-cell" block per entry. */
export function parseWatchHistoryHtml(html: string): TakeoutParse {
  const skipped = emptySkipped();
  const watches: TakeoutWatch[] = [];
  const blocks = html.split(/<div class="outer-cell\b/).slice(1);
  if (!blocks.length && !/<html/i.test(html)) throw new TakeoutError("unreadable");
  for (const block of blocks) {
    const header = text(/mdl-typography--title">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "").trim();
    const caption = /mdl-typography--caption">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    if (/From Google Ads/i.test(text(caption))) {
      skipped.ads++;
      continue;
    }
    // The first content cell: "Watched <a>title</a><br><a>channel</a><br>date<br>".
    const cell = /<div class="content-cell[^"]*mdl-typography--body-1">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const links = [...cell.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
    const id = videoIdFrom(decode(links[0]?.[1] ?? ""));
    if (!id) {
      if (/^Watched\b/.test(text(cell).trim())) skipped.removed++;
      else skipped.other++;
      continue;
    }
    const parts = cell.split(/<br\s*\/?>/i).map((p) => text(p).trim()).filter(Boolean);
    const at = parseTakeoutDate(parts[parts.length - 1] ?? "");
    if (!at) {
      skipped.other++;
      continue;
    }
    const shown = clean(text(links[0][2]), 300);
    const channelLink = links[1] && !videoIdFrom(decode(links[1][1])) ? links[1] : null;
    watches.push({
      id,
      title: !shown || /^https?:\/\//.test(shown) ? "" : shown,
      channel: channelLink ? clean(text(channelLink[2]), 120) : "",
      at: at.toISOString(),
      music: header === "YouTube Music" || /music\.youtube\.com/.test(links[0][1]),
    });
  }
  return finish(watches, skipped, "html");
}

export class TakeoutError extends Error {
  constructor(public readonly reason: "unreadable" | "empty" | "not-found" | "zip") {
    super(reason);
  }
}

/** Either file, told apart by its first non-space character. */
export function parseWatchHistory(content: string): TakeoutParse {
  const first = content.replace(/^﻿/, "").trimStart()[0];
  return first === "[" ? parseWatchHistoryJson(content) : parseWatchHistoryHtml(content);
}

/** Oldest first, with YouTube's copy of a YouTube Music play dropped. */
function finish(watches: TakeoutWatch[], skipped: TakeoutSkipped, format: "json" | "html"): TakeoutParse {
  watches.sort((a, b) => a.at.localeCompare(b.at));
  const musicTimes = new Map<string, number[]>();
  for (const w of watches) if (w.music) (musicTimes.get(w.id) ?? musicTimes.set(w.id, []).get(w.id)!).push(Date.parse(w.at));
  const seen = new Set<string>();
  const kept: TakeoutWatch[] = [];
  for (const w of watches) {
    const key = `${w.id}@${w.at}@${w.music}`;
    // The same entry twice (HTML and JSON from one export, or a repeated row).
    if (seen.has(key)) {
      skipped.other++;
      continue;
    }
    seen.add(key);
    if (!w.music) {
      const t = Date.parse(w.at);
      if (musicTimes.get(w.id)?.some((m) => Math.abs(m - t) <= TWIN_MS)) {
        skipped.music_duplicates++;
        continue;
      }
    }
    kept.push(w);
  }
  return { watches: kept, skipped, format };
}

/**
 * Days in `tz`, oldest first; within a day, videos in the order first
 * watched, repeats folded into a count. The title and channel are the latest
 * the file has for that video.
 */
export function groupByDay(watches: TakeoutWatch[], tz: string): TakeoutDay[] {
  const days = new Map<string, Map<string, DayVideo>>();
  for (const w of watches) {
    const day = zonedParts(new Date(w.at), tz).date;
    const videos = days.get(day) ?? days.set(day, new Map()).get(day)!;
    const key = `${w.music ? "m" : "v"}:${w.id}`;
    const v = videos.get(key);
    if (v) {
      v.count++;
      if (w.title) v.title = w.title;
      if (w.channel) v.channel = w.channel;
    } else videos.set(key, { id: w.id, title: w.title, channel: w.channel, count: 1, music: w.music });
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, videos]) => ({ day, videos: [...videos.values()] }));
}

/**
 * Days in batches small enough for one request, never splitting a day (the
 * server's merge takes each video's larger count, so half a day would
 * undercount).
 */
export function batchDays(days: TakeoutDay[], maxDays = 31, maxVideos = 2500): TakeoutDay[][] {
  const out: TakeoutDay[][] = [];
  let cur: TakeoutDay[] = [];
  let n = 0;
  for (const d of days) {
    if (cur.length && (cur.length >= maxDays || n + d.videos.length > maxVideos)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(d);
    n += d.videos.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- The day note's sections ----------

const escapeMd = (s: string) => s.replace(/([\\[\]*_`<>])/g, "\\$1");
const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");

/** "- [Title](https://www.youtube.com/watch?v=…) · Channel · 3 times" */
function line(v: DayVideo): string {
  const link = `https://www.youtube.com/watch?v=${v.id}`;
  const title = v.title || (v.music ? "Untitled track" : "Untitled video");
  return `- [${escapeMd(title)}](${link})${v.channel ? ` · ${escapeMd(v.channel)}` : ""}${v.count > 1 ? ` · ${v.count} times` : ""}`;
}

const LINE = /^- \[((?:\\.|[^\]\\])*)\]\(https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})\)(?: · (.*?))?(?: · (\d+) times)?\s*$/;

/** A body split into the import's sections and everything else. */
function split(body: string): { rest: string[]; sections: Map<string, string[]> } {
  const rest: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const l of body.split("\n")) {
    if (/^#{1,6} /.test(l)) {
      const heading = HEADINGS.find((h) => l.trim() === h);
      current = heading ? (sections.get(heading) ?? sections.set(heading, []).get(heading)!) : null;
      if (!heading) rest.push(l);
      continue;
    }
    if (current) current.push(l);
    else rest.push(l);
  }
  return { rest, sections };
}

/** The videos in a body's import sections. */
export function readImported(body: string): DayVideo[] {
  const { sections } = split(body);
  const out: DayVideo[] = [];
  for (const [heading, lines] of sections) {
    for (const l of lines) {
      const m = LINE.exec(l);
      if (!m) continue;
      const title = unescapeMd(m[1]);
      out.push({
        id: m[2],
        title: /^Untitled (video|track)$/.test(title) ? "" : title,
        channel: m[3] ? unescapeMd(m[3]) : "",
        count: m[4] ? Number(m[4]) : 1,
        music: heading === LISTENED_HEADING,
      });
    }
  }
  return out;
}

function render(videos: DayVideo[]): string {
  const watched = videos.filter((v) => !v.music);
  const listened = videos.filter((v) => v.music);
  return [
    watched.length ? [WATCHED_HEADING, ...watched.map(line)].join("\n") : "",
    listened.length ? [LISTENED_HEADING, ...listened.map(line)].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const tidy = (lines: string[]) => lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

const join = (rest: string, sections: string) => [rest, sections].filter(Boolean).join("\n\n");

export interface MergeResult {
  body: string;
  /** Video plays (not YouTube Music) this file adds that the note didn't have. */
  added: number;
  /** YouTube Music plays it adds. */
  added_tracks: number;
  /** Videos watched that day (not YouTube Music), with repeats: videos_watched_day. */
  watched: number;
  /** Tracks played on YouTube Music that day. */
  listened: number;
  changed: boolean;
}

/**
 * A day note's body with `incoming` folded into its import sections. Each
 * video's count is the larger of the two, so importing the same file again
 * adds nothing and a newer export only adds what's new. Everything outside
 * those sections is left exactly as it was.
 */
export function mergeDay(body: string, incoming: DayVideo[]): MergeResult {
  const { rest } = split(body);
  const have = readImported(body);
  const byKey = new Map(have.map((v) => [`${v.music ? "m" : "v"}:${v.id}`, { ...v }]));
  let added = 0;
  let addedTracks = 0;
  const count = (v: DayVideo, k: number) => (v.music ? (addedTracks += k) : (added += k));
  for (const v of incoming) {
    const key = `${v.music ? "m" : "v"}:${v.id}`;
    const old = byKey.get(key);
    if (!old) {
      byKey.set(key, { ...v });
      count(v, v.count);
      continue;
    }
    if (v.count > old.count) {
      count(v, v.count - old.count);
      old.count = v.count;
    }
    if (!old.title && v.title) old.title = v.title;
    if (!old.channel && v.channel) old.channel = v.channel;
  }
  // The file's order (first watched) where it has the video; anything only the note had keeps its place after.
  const order = new Map(incoming.map((v, i) => [`${v.music ? "m" : "v"}:${v.id}`, i]));
  const videos = [...byKey.entries()]
    .map(([key, v], i) => ({ v, rank: order.get(key) ?? incoming.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.v);
  const next = join(tidy(rest), render(videos));
  return {
    body: next,
    added,
    added_tracks: addedTracks,
    watched: videos.filter((v) => !v.music).reduce((n, v) => n + v.count, 0),
    listened: videos.filter((v) => v.music).reduce((n, v) => n + v.count, 0),
    changed: next !== body,
  };
}

/**
 * The YouTube import's part of keepImported: its sections from the note a
 * run replaces, put back. The run never writes those sections itself
 * (recipes.ts), so any it did write are dropped in favour of the import's.
 */
function keepVideos(previous: string, next: string): string {
  const kept = split(previous).sections;
  if (![...kept.values()].some((lines) => lines.some((l) => LINE.test(l)))) return next;
  const imported = readImported(previous);
  return join(tidy(split(next).rest), render(imported));
}

/**
 * Each import's own part of a day note, put back when a Life log run
 * rewrites the day: (previous, next) → next with that import's lines from
 * previous. Goodreads first (its lines sit under Read, mid-note), then
 * Netflix (under Watched), then YouTube (its sections go last), then Places
 * (its section goes on top, lib/places-line.ts).
 */
const IMPORTS: Array<(previous: string, next: string) => string> = [keepBooks, keepNetflix, keepVideos, keepPlaces];

/**
 * What a Life log run saves for a day, with what every import wrote in the
 * note it replaces put back. A note no import touched is saved exactly as
 * the run wrote it.
 */
export function keepImported(previous: string, next: string): string {
  return IMPORTS.reduce((body, keep) => keep(previous, body), next);
}

/** "Friday 6 November" this year, "Friday 6 November 2023" before it. */
export function dayTitle(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const month = date.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${weekday} ${d} ${month}${today.slice(0, 4) === day.slice(0, 4) ? "" : ` ${y}`}`;
}

/** "12 YouTube videos", "1 YouTube video and 3 tracks on YouTube Music". */
export function daySummary(watched: number, listened: number): string {
  const v = watched ? `${watched} YouTube ${watched === 1 ? "video" : "videos"}` : "";
  const t = listened ? `${listened} ${listened === 1 ? "track" : "tracks"} on YouTube Music` : "";
  return [v, t].filter(Boolean).join(" and ");
}

/** A title the import wrote (so a later import may refresh its count), as opposed to one the Life log wrote. */
export const IMPORT_TITLE = / · (\d+ YouTube videos?( and \d+ tracks? on YouTube Music)?|\d+ tracks? on YouTube Music)$/;
