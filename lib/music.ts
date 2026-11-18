/**
 * Music in the Library (#/music, GET /api/life/music): what the owner played,
 * built only from Days' `listened` entries (lib/days.ts). No store of its own.
 *
 * An entry is one album (or artist, or track) on one day: title = the album
 * (the artist when the tracks came from many albums; a track for Apple
 * Music's download), subtitle and group = the artist, count = plays that
 * day. Plays are count, else 1. Podcasts (Overcast) and audiobooks
 * (Audible) are listened entries too, and are left out.
 *
 * Pure: lib/music-data.ts reads the rows on the server, db/sample-music.ts
 * makes them up in sample mode, and both hand them to buildMusic.
 */
import type { DayArt } from "./day-types";
import { addPlays, mixOf, type GenreMix } from "./genre-mix";

/** Listened sources that aren't music. */
export const NOT_MUSIC = ["overcast", "audible"] as const;

/** One listened entry, opened. title and art are null for rows before the period (only the artist is needed there). */
export interface MusicRow {
  date: string;
  artist: string | null;
  title: string | null;
  plays: number;
  art: DayArt | null;
  /** A single track, not an album (Apple Music's download): kept out of Top albums. */
  track?: boolean;
  /** Plays per local hour 0-23, when the source gave play times (lib/day-hours.ts). */
  hours?: number[] | null;
}

/** Listened sources whose title is a track, never an album. */
export const TRACK_SOURCES = ["apple_music"] as const;

export type MusicPeriodKind = "month" | "year" | "all" | "past";
export interface MusicPeriod {
  /** "month", "year", "all", or an earlier year ("2024"). */
  id: string;
  kind: MusicPeriodKind;
  label: string;
  /** null for all time. */
  from: string | null;
  to: string;
}

export interface MusicArtist {
  name: string;
  plays: number;
  /** The first day this artist was ever played (across the whole history held). */
  first: string;
  art?: DayArt;
}

export interface MusicAlbum {
  title: string;
  artist: string;
  plays: number;
  art?: DayArt;
}

export interface MusicPoint {
  /** The bucket's first day. */
  from: string;
  plays: number;
  /** A day of this month still to come: an empty slot, so the chart keeps its width. */
  ahead?: boolean;
}

export interface MusicTimeline {
  unit: "day" | "week" | "month" | "year";
  points: MusicPoint[];
  takeaway: string;
}

export interface MusicDay {
  date: string;
  plays: number;
  /** Most played first, at most three. */
  artists: string[];
  art?: DayArt;
}

export interface MusicData {
  today: string;
  period: MusicPeriod;
  /** The choices for the switch: this month, this year, earlier years with music, all time. */
  periods: Array<{ id: string; label: string }>;
  /** Any music at all, in any period. False: no music source yet. */
  has_music: boolean;
  plays: number;
  days: number;
  artists: number;
  /** The same span before (last month to the same day, last year to the same date, the year before). None for all time. */
  previous?: { label: string; plays: number; change: number | null };
  top_artists: MusicArtist[];
  /** Albums when the period has any; else its most played tracks. */
  top_albums: MusicAlbum[];
  albums_are: "albums" | "tracks";
  timeline: MusicTimeline;
  /** When the owner listens: weekday × hour from the plays that have a time. */
  when: ListeningTimes;
  /** Artists first played in the period; empty for all time. */
  new_artists: MusicArtist[];
  new_count: number;
  recent: MusicDay[];
  /** The genre mix (lib/genre-mix.ts), when the artists' genres were handed in. */
  genres?: MusicGenres;
  /** The history held was cut at the row cap: the oldest days are missing. */
  capped?: boolean;
}

export interface MusicGenres {
  now: GenreMix;
  /** The same span before (previous's), on the same terms; none for all time. */
  before: GenreMix | null;
  /** Of the period's plays, the share whose artist has a known genre (0–1). */
  covered: number;
  /** Artists in the period not looked up yet: the radar fills in as they are. */
  learning: number;
}

/**
 * An artist's genre families: undefined when not looked up yet, empty when
 * looked up and none known.
 */
export type FamiliesOf = (artist: string) => string[] | undefined;

export interface ArtistDetail {
  name: string;
  plays: number;
  days: number;
  first: string;
  last: string;
  unit: "month" | "year";
  points: MusicPoint[];
  albums: MusicAlbum[];
  albums_are: "albums" | "tracks";
  art?: DayArt;
}

export const TOP_ARTISTS = 10;
export const TOP_ALBUMS = 12;
export const NEW_ARTISTS = 5;
export const RECENT_DAYS = 20;

// ---------- Dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthWord = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];
const shortDay = (d: string) => `${Number(d.slice(8, 10))} ${SHORT[Number(d.slice(5, 7)) - 1]}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The Monday on or before. */
export function mondayOf(date: string): string {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}
/** The same day in the month before, clipped to its length (31 March → 28 or 29 February). */
function monthBefore(date: string): string {
  let y = Number(date.slice(0, 4));
  let m = Number(date.slice(5, 7)) - 1;
  if (m === 0) {
    m = 12;
    y--;
  }
  return `${y}-${pad(m)}-${pad(Math.min(Number(date.slice(8, 10)), lastDay(y, m)))}`;
}
function yearBefore(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const m = Number(date.slice(5, 7));
  return `${y}-${pad(m)}-${pad(Math.min(Number(date.slice(8, 10)), lastDay(y, m)))}`;
}

// ---------- Periods ----------

const YEAR = /^\d{4}$/;

/** A period id as asked for, checked against today. Unknown ids fall back to this month. */
export function resolvePeriod(id: string | null | undefined, today: string): MusicPeriod {
  const y = today.slice(0, 4);
  if (id === "year") return { id, kind: "year", label: y, from: `${y}-01-01`, to: today };
  if (id === "all") return { id, kind: "all", label: "All time", from: null, to: today };
  if (id && YEAR.test(id) && id < y && id >= "1990") return { id, kind: "past", label: id, from: `${id}-01-01`, to: `${id}-12-31` };
  return { id: "month", kind: "month", label: `${monthWord(today)} ${y}`, from: `${today.slice(0, 7)}-01`, to: today };
}

/** The span to compare against: the same days before. None for all time. */
export function previousSpan(p: MusicPeriod): { from: string; to: string; label: string } | null {
  if (!p.from) return null;
  if (p.kind === "month") {
    const from = monthBefore(p.from);
    return { from, to: monthBefore(p.to), label: monthWord(from) };
  }
  if (p.kind === "year") return { from: yearBefore(p.from), to: yearBefore(p.to), label: "this point last year" };
  const y = String(Number(p.from.slice(0, 4)) - 1);
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: y };
}

/** Rise or fall against before as a fraction (0.12 = 12% more); null when before had nothing. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}

// ---------- Grouping ----------

/** Names match without case or extra spaces. */
export const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

interface Acc {
  name: string;
  plays: number;
  art?: DayArt;
  artPlays: number;
}

function bump(m: Map<string, Acc>, key: string, name: string, plays: number, art: DayArt | null, artPlays = plays) {
  const a = m.get(key) ?? { name: name.trim(), plays: 0, artPlays: 0 };
  a.plays += plays;
  // The cover of the album played most carries the artist.
  if (art && artPlays > a.artPlays) {
    a.art = art;
    a.artPlays = artPlays;
  }
  m.set(key, a);
}

const byPlays = <T extends { plays: number; name?: string; title?: string }>(a: T, b: T) => b.plays - a.plays || (a.name ?? a.title ?? "").localeCompare(b.name ?? b.title ?? "");
const inSpan = (d: string, from: string | null, to: string) => (!from || d >= from) && d <= to;
const named = (r: MusicRow) => !!r.title && !!r.artist && nameKey(r.title) !== nameKey(r.artist);
const isAlbum = (r: MusicRow) => named(r) && !r.track;

type Shelf = Map<string, Acc & { artist: string }>;
function shelve(m: Shelf, k: string, r: MusicRow) {
  const a = m.get(k) ?? { name: r.title!, artist: r.artist!, plays: 0, artPlays: 0 };
  a.plays += r.plays;
  if (r.art && !a.art) a.art = r.art;
  m.set(k, a);
}
/** Albums, or tracks when there are no albums at all. */
const shelfOf = (albums: Shelf, tracks: Shelf) => (albums.size || !tracks.size ? { list: [...albums.values()], are: "albums" as const } : { list: [...tracks.values()], are: "tracks" as const });

/** First day each artist was played, over every row held. */
export function firstPlayed(rows: MusicRow[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const r of rows) {
    if (!r.artist) continue;
    const k = nameKey(r.artist);
    const f = first.get(k);
    if (!f || r.date < f) first.set(k, r.date);
  }
  return first;
}

// ---------- The timeline ----------

function buckets(p: MusicPeriod, rows: MusicRow[]): { unit: MusicTimeline["unit"]; starts: string[] } {
  const to = p.to;
  if (p.kind === "month") {
    // Every day of the month; the days still to come are empty slots (see timeline).
    const starts: string[] = [];
    const end = `${p.from!.slice(0, 7)}-${pad(lastDay(Number(p.from!.slice(0, 4)), Number(p.from!.slice(5, 7))))}`;
    for (let d = p.from!; d <= end; d = addDays(d, 1)) starts.push(d);
    return { unit: "day", starts };
  }
  const from = p.from ?? rows.reduce((m, r) => (r.date < m ? r.date : m), to);
  const months: string[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${pad(m)}` <= to.slice(0, 7); m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${pad(m)}-01`);
  // Over three years of months is too many columns for a phone: years instead.
  if (months.length > 36) {
    const years: string[] = [];
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) years.push(`${y}-01-01`);
    return { unit: "year", starts: years };
  }
  return { unit: "month", starts: months };
}

const bucketOf = (unit: MusicTimeline["unit"], d: string) => (unit === "day" ? d : unit === "week" ? mondayOf(d) : unit === "month" ? `${d.slice(0, 7)}-01` : `${d.slice(0, 4)}-01-01`);

export function bucketLabel(unit: MusicTimeline["unit"], from: string, long = false): string {
  if (unit === "day") return long ? `${WEEKDAYS[new Date(`${from}T12:00:00Z`).getUTCDay()]} ${shortDay(from)}` : shortDay(from);
  if (unit === "week") return long ? `the week of ${shortDay(from)}` : shortDay(from);
  if (unit === "month") return long ? `${monthWord(from)} ${from.slice(0, 4)}` : SHORT[Number(from.slice(5, 7)) - 1];
  return from.slice(0, 4);
}

const n = (v: number) => v.toLocaleString("en-GB");

/** One plain line about the timeline: the busiest stretch, and how the latest one compares. */
export function timelineTakeaway(t: Omit<MusicTimeline, "takeaway">, p: MusicPeriod): string {
  const pts = t.points.filter((x) => !x.ahead);
  const total = pts.reduce((s, x) => s + x.plays, 0);
  if (!total) return "";
  const best = pts.reduce((b, x) => (x.plays > b.plays ? x : b), pts[0]);
  const word = t.unit;
  // Inside one year the month says enough: "April", not "April 2026".
  const name = t.unit === "month" && p.kind !== "all" && p.from?.slice(0, 4) === p.to.slice(0, 4) ? monthWord(best.from) : bucketLabel(t.unit, best.from, true);
  const busiest = t.unit === "day" || t.unit === "week" ? `The busiest ${word} was ${name}, with ${n(best.plays)} plays.` : `${name.charAt(0).toUpperCase()}${name.slice(1)} was the busiest ${word}, with ${n(best.plays)} plays.`;
  const played = pts.filter((x) => x.plays > 0).length;
  if (played === 1) return `All ${n(total)} plays came ${t.unit === "day" ? "on" : "in"} ${name}.`;
  // A period still running: say where the latest stretch stands against the usual one.
  if (p.kind !== "past" && pts.length >= 3) {
    const done = pts.slice(0, -1).filter((x) => x.plays > 0);
    const usual = done.length ? done.reduce((s, x) => s + x.plays, 0) / done.length : 0;
    const last = pts[pts.length - 1];
    if (usual && last.plays > usual * 1.25 && last !== best) return `${busiest} ${t.unit === "day" ? "Today" : `This ${word}`} is already above the usual ${n(Math.round(usual))}.`;
  }
  return busiest;
}

function timeline(p: MusicPeriod, rows: MusicRow[]): MusicTimeline {
  const { unit, starts } = buckets(p, rows);
  const sums = new Map(starts.map((s) => [s, 0]));
  for (const r of rows) {
    let b = bucketOf(unit, r.date);
    if (b < starts[0]) b = starts[0];
    if (sums.has(b)) sums.set(b, sums.get(b)! + r.plays);
  }
  const t = { unit, points: starts.map((from) => ({ from, plays: sums.get(from)!, ...(from > p.to ? { ahead: true } : {}) })) };
  return { ...t, takeaway: timelineTakeaway(t, p) };
}

// ---------- When: day of week × hour ----------

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface ListeningTimes {
  /** 7 rows, Monday first, × 24 local hours: plays. */
  cells: number[][];
  max: number;
  /** Plays with a time; the rest of the period's plays have none. */
  timed: number;
  /** "You play most on weekday evenings, 8–10pm." Empty with nothing timed. */
  takeaway: string;
}

const weekdayIndex = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

/** "8pm", "12am", "11am". */
export function clockHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${hh % 12 === 0 ? 12 : hh % 12}${hh < 12 ? "am" : "pm"}`;
}

/** "8–10pm", "11am–1pm", "11pm–1am". */
export function hourRange(from: number, to: number): string {
  const a = clockHour(from);
  const b = clockHour(to);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

const PART = (h: number) => (h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "late night");
const PARTS: Record<string, string> = { morning: "mornings", afternoon: "afternoons", evening: "evenings", "late night": "late nights" };

/** The plain line: which days, which part of the day, and the busiest two hours in it. */
export function timesTakeaway(cells: number[][]): string {
  const total = cells.flat().reduce((s, v) => s + v, 0);
  if (!total) return "";
  const sum = (rows: number[]) => Array.from({ length: 24 }, (_, h) => rows.reduce((s, r) => s + cells[r][h], 0));
  const weekdays = sum([0, 1, 2, 3, 4]);
  const weekend = sum([5, 6]);
  // Per day, so five weekdays don't outweigh two weekend days by number alone.
  const perWeekday = weekdays.reduce((s, v) => s + v, 0) / 5;
  const perWeekend = weekend.reduce((s, v) => s + v, 0) / 2;
  const group = perWeekend > perWeekday * 1.3 ? "weekend" : perWeekday > perWeekend * 1.3 ? "weekday" : "";
  const profile = group === "weekend" ? weekend : group === "weekday" ? weekdays : sum([0, 1, 2, 3, 4, 5, 6]);
  // The busiest two hours running (11pm into midnight counts).
  let best = 0;
  for (let h = 1; h < 24; h++) if (profile[h] + profile[(h + 1) % 24] > profile[best] + profile[(best + 1) % 24]) best = h;
  const part = PART(best);
  const range = hourRange(best, best + 2);
  return group ? `You play most on ${group} ${PARTS[part]}, ${range}.` : `You play most ${part === "late night" ? "late at night" : `in the ${part}`}, ${range}, weekdays and weekends alike.`;
}

export function listeningTimes(rows: MusicRow[]): ListeningTimes {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let timed = 0;
  for (const r of rows) {
    if (!r.hours) continue;
    const row = cells[weekdayIndex(r.date)];
    for (let h = 0; h < 24; h++) {
      row[h] += r.hours[h] ?? 0;
      timed += r.hours[h] ?? 0;
    }
  }
  return { cells, max: Math.max(0, ...cells.flat()), timed, takeaway: timesTakeaway(cells) };
}

// ---------- The page ----------

/** Plays from an entry's count: count, else 1. */
export const playsOf = (count: number | null | undefined) => (count && count > 0 ? count : 1);

/**
 * Everything the page shows for one period, from every listened row held
 * (any order). Rows before the period may carry only the artist.
 */
/** A span's plays as a genre mix; artists not looked up yet counted apart. */
export function musicMix(rows: MusicRow[], families: FamiliesOf): { mix: GenreMix; plays: number; learning: Set<string> } {
  const tally = new Map<string, number>();
  const learning = new Set<string>();
  let known = 0;
  let plays = 0;
  for (const r of rows) {
    plays += r.plays;
    if (!r.artist) continue;
    const f = families(r.artist);
    if (f === undefined) learning.add(nameKey(r.artist));
    if (!f?.length) continue;
    addPlays(tally, f, r.plays);
    known += r.plays;
  }
  return { mix: mixOf(tally, known), plays, learning };
}

/** The artists of a period, then of the span before it, most played first: who the genre lookup asks about. */
export function periodArtists(all: MusicRow[], periodId: string | null | undefined, today: string): string[] {
  const period = resolvePeriod(periodId, today);
  const prev = previousSpan(period);
  const rank = (rows: MusicRow[]) => {
    const by = new Map<string, Acc>();
    for (const r of rows) if (r.artist) bump(by, nameKey(r.artist), r.artist, r.plays, null);
    return [...by.values()].sort(byPlays).map((a) => a.name);
  };
  const rows = all.filter((r) => r.date <= today);
  return [...new Set([...rank(rows.filter((r) => inSpan(r.date, period.from, period.to))), ...(prev ? rank(rows.filter((r) => inSpan(r.date, prev.from, prev.to))) : [])])];
}

/** An artist's stand-in cover when none of their plays has one: their best-known album's (Deezer's, lib/art.ts). */
export type ArtistArtOf = (artist: string) => DayArt | undefined;

export function buildMusic(all: MusicRow[], periodId: string | null | undefined, today: string, opts: { capped?: boolean; families?: FamiliesOf; artistArt?: ArtistArtOf } = {}): MusicData {
  const period = resolvePeriod(periodId, today);
  const rows = all.filter((r) => r.date <= today);
  const first = firstPlayed(rows);
  const here = rows.filter((r) => inSpan(r.date, period.from, period.to));
  const prev = previousSpan(period);

  const artists = new Map<string, Acc>();
  const albums: Shelf = new Map();
  const tracks: Shelf = new Map();
  const days = new Map<string, { plays: number; artists: Map<string, Acc> }>();
  let plays = 0;
  for (const r of here) {
    plays += r.plays;
    const day = days.get(r.date) ?? { plays: 0, artists: new Map() };
    day.plays += r.plays;
    days.set(r.date, day);
    if (r.artist) {
      const k = nameKey(r.artist);
      // An album's cover carries the artist; a track's (Apple Music) or a mixed day's only when no album has one.
      bump(artists, k, r.artist, r.plays, r.art, isAlbum(r) ? r.plays : r.plays / 1000);
      bump(day.artists, k, r.artist, r.plays, r.art);
    }
    if (named(r)) shelve(r.track ? tracks : albums, `${nameKey(r.artist!)}\u0000${nameKey(r.title!)}`, r);
  }
  const shelf = shelfOf(albums, tracks);
  const asArtist = ([k, a]: [string, Acc]): MusicArtist => {
    const art = a.art ?? opts.artistArt?.(a.name);
    return { name: a.name, plays: a.plays, first: first.get(k)!, ...(art ? { art } : {}) };
  };
  const ranked = [...artists.entries()].sort((x, y) => byPlays(x[1], y[1]));
  const fresh = period.from ? ranked.filter(([k]) => first.get(k)! >= period.from!) : [];

  const before = prev ? rows.filter((r) => inSpan(r.date, prev.from, prev.to)).reduce((s, r) => s + r.plays, 0) : 0;
  const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))].filter((y) => y < today.slice(0, 4)).sort().reverse();

  return {
    today,
    period,
    periods: [
      { id: "month", label: "This month" },
      { id: "year", label: "This year" },
      ...years.map((y) => ({ id: y, label: y })),
      { id: "all", label: "All time" },
    ],
    has_music: rows.length > 0,
    plays,
    days: days.size,
    artists: artists.size,
    ...(prev ? { previous: { label: prev.label, plays: before, change: change(plays, before) } } : {}),
    top_artists: ranked.slice(0, TOP_ARTISTS).map(asArtist),
    top_albums: shelf.list
      .sort(byPlays)
      .slice(0, TOP_ALBUMS)
      .map((a) => ({ title: a.name, artist: a.artist, plays: a.plays, ...(a.art ? { art: a.art } : {}) })),
    albums_are: shelf.are,
    timeline: timeline(period, here),
    when: listeningTimes(here),
    new_artists: fresh.slice(0, NEW_ARTISTS).map(asArtist),
    new_count: fresh.length,
    recent: [...days.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, RECENT_DAYS)
      .map(([date, d]) => {
        const top = [...d.artists.values()].sort(byPlays);
        const art = top.find((a) => a.art)?.art ?? (top[0] ? opts.artistArt?.(top[0].name) : undefined);
        return { date, plays: d.plays, artists: top.slice(0, 3).map((a) => a.name), ...(art ? { art } : {}) };
      }),
    ...(opts.families ? { genres: genresOf(here, prev ? rows.filter((r) => inSpan(r.date, prev.from, prev.to)) : null, opts.families) } : {}),
    ...(opts.capped ? { capped: true } : {}),
  };
}

function genresOf(here: MusicRow[], before: MusicRow[] | null, families: FamiliesOf): MusicGenres {
  const now = musicMix(here, families);
  return {
    now: now.mix,
    before: before ? musicMix(before, families).mix : null,
    covered: now.plays ? now.mix.known / now.plays : 0,
    learning: now.learning.size,
  };
}

/** One artist over the whole history: plays by month (by year past three years), top albums, first and last day. Null when never played. */
export function artistDetail(all: MusicRow[], name: string, artistArt?: ArtistArtOf): ArtistDetail | null {
  const key = nameKey(name);
  const rows = all.filter((r) => r.artist && nameKey(r.artist) === key).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  const p: MusicPeriod = { id: "artist", kind: "past", label: "", from: `${first.slice(0, 7)}-01`, to: last };
  const t = timeline(p, rows);
  const albums: Shelf = new Map();
  const tracks: Shelf = new Map();
  let art: DayArt | undefined;
  let artPlays = 0;
  for (const r of rows) if (named(r)) shelve(r.track ? tracks : albums, nameKey(r.title!), r);
  const shelf = shelfOf(albums, tracks);
  const top = shelf.list.sort(byPlays);
  for (const a of top)
    if (a.art && a.plays > artPlays) {
      art = a.art;
      artPlays = a.plays;
    }
  return {
    name: rows[rows.length - 1].artist!,
    plays: rows.reduce((s, r) => s + r.plays, 0),
    days: new Set(rows.map((r) => r.date)).size,
    first,
    last,
    unit: t.unit === "year" ? "year" : "month",
    points: t.points,
    albums: top.slice(0, 6).map((a) => ({ title: a.name, artist: a.artist, plays: a.plays, ...(a.art ? { art: a.art } : {}) })),
    albums_are: shelf.are,
    ...((art ?? artistArt?.(name)) ? { art: art ?? artistArt!(name) } : {}),
  };
}
