/**
 * Watch & read's month in numbers: what was watched each day, and for how
 * long. Days holds what happened (a film, three episodes, a video, each on
 * its date); Watch & read holds how long a title runs and its genres
 * (lib/watch-meta.ts). This puts the two together.
 *
 * Time is the source's own minutes when it gave them, otherwise the title's
 * running time (a show's: one episode's) times the plays. A play with
 * neither counts as a play and adds no time, and `timed` says how many plays
 * the time covers, so the page never passes a part off as the whole.
 *
 * Pure: GET /api/watch-stats runs it on the server, sample mode in the app.
 */
import type { WatchMeta } from "./watch-meta";
import { addPlays, filmGenres, mixOf, type GenreMix } from "./genre-mix";

export interface StatEntry {
  /** YYYY-MM-DD, the owner's local day. */
  date: string;
  kind: string;
  source: string;
  title: string;
  subtitle?: string;
  group?: string;
  count?: number;
  minutes?: number;
}

export interface StatItem {
  kind: string;
  title: string;
  meta?: WatchMeta | null;
}

export interface StatDay {
  date: string;
  /** Minutes watched that are known. */
  minutes: number;
  /** Films, episodes and videos watched. */
  plays: number;
}

export interface MonthStats {
  /** YYYY-MM. */
  month: string;
  /** Every day of the month, in order. */
  days: StatDay[];
  films: number;
  episodes: number;
  /** Different shows those episodes belong to. */
  shows: number;
  videos: number;
  plays: number;
  minutes: number;
  /** Plays whose length is known: `minutes` covers these. */
  timed: number;
  /** The genres watched most, by plays, three at most. */
  genres: string[];
  /** Films' and episodes' genres as a mix (every genre a title has), for the radar. Videos left out: YouTube's topics aren't film genres. */
  mix?: GenreMix;
}

const fold = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");

const VIDEO_SOURCES = new Set(["youtube", "youtube_music"]);
const EPISODE = /\bS\d+\s*·?\s*E\d+\b|\bepisode\b/i;

/** What a watched entry is: a video, an episode of a show, or a film. */
export function watchedAs(e: Pick<StatEntry, "source" | "subtitle" | "group">): "video" | "episode" | "film" {
  if (VIDEO_SOURCES.has(e.source)) return "video";
  return e.group || EPISODE.test(e.subtitle ?? "") ? "episode" : "film";
}

/** Days in a month, as YYYY-MM-DD. */
export function monthDays(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return [];
  const n = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export function monthStats(entries: StatEntry[], items: StatItem[], month: string): MonthStats {
  const days = new Map(monthDays(month).map((date) => [date, { date, minutes: 0, plays: 0 }]));
  // A title's running time and genres, by what it is and its name.
  const known = new Map<string, WatchMeta>();
  for (const it of items) {
    const as = it.kind === "tv" ? "episode" : it.kind === "film" ? "film" : it.kind === "video" || it.kind === "music" ? "video" : null;
    if (as && it.meta && fold(it.title)) known.set(`${as}:${fold(it.title)}`, it.meta);
  }
  const out: MonthStats = { month, days: [], films: 0, episodes: 0, shows: 0, videos: 0, plays: 0, minutes: 0, timed: 0, genres: [] };
  const shows = new Set<string>();
  const genres = new Map<string, number>();
  const mix = new Map<string, number>();
  let mixKnown = 0;
  for (const e of entries) {
    const day = days.get(e.date);
    if (!day || e.kind !== "watched") continue;
    const as = watchedAs(e);
    const plays = Math.max(1, Math.round(e.count ?? 1));
    const name = as === "episode" ? (e.group ?? e.title) : e.title;
    const meta = known.get(`${as}:${fold(name)}`);
    if (as === "film") out.films += plays;
    else if (as === "video") out.videos += plays;
    else {
      out.episodes += plays;
      shows.add(fold(name));
    }
    out.plays += plays;
    day.plays += plays;
    const minutes = e.minutes && e.minutes > 0 ? e.minutes : meta?.minutes ? meta.minutes * plays : 0;
    if (minutes) {
      out.minutes += minutes;
      out.timed += plays;
      day.minutes += minutes;
    }
    const genre = meta?.genres?.[0];
    if (genre) genres.set(genre, (genres.get(genre) ?? 0) + plays);
    const all = as === "video" ? [] : filmGenres(meta?.genres);
    if (all.length) {
      addPlays(mix, all, plays);
      mixKnown += plays;
    }
  }
  out.shows = shows.size;
  out.days = [...days.values()];
  out.genres = [...genres.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([g]) => g);
  out.mix = mixOf(mix, mixKnown);
  return out;
}

// ---------- Screen time: a run of days, set against the run before it ----------

export const DAY_PARTS = ["morning", "afternoon", "evening", "night"] as const;
export type DayPart = (typeof DAY_PARTS)[number];

/** Morning from 5, afternoon from 12, evening from 17, night from 22. */
export function dayPart(hour: number): DayPart {
  return hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 17 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
}

export interface ScreenSpan {
  /** Minutes watched that are known. */
  total: number;
  /** A day's share of that, over every day of the span that has come. */
  average: number;
  /** Of sixteen waking hours a day, the percent spent watching. */
  waking: number;
  films: number;
  shows: number;
  videos: number;
  plays: number;
}

export interface ScreenTime extends ScreenSpan {
  from: string;
  to: string;
  days: StatDay[];
  /** Plays by the part of the day they happened in, for the ones with a time. */
  parts: Record<DayPart, number>;
  /** Plays whose length is known: the minutes cover these. */
  timed: number;
  /**
   * A usual week: Monday to Sunday by half hour (7 × 48), the minutes
   * watched in that half hour on an average such day of the span. A play
   * runs on from the time it was logged for as long as it lasts.
   */
  week: number[][];
  /** The same grid in plays, at the half hour each was logged: for when no lengths are known. */
  weekPlays: number[][];
  /** The same number of days just before `from`. */
  before: ScreenSpan;
}

const WAKING_MINUTES = 16 * 60;

/** YYYY-MM-DD, n days on (or back). */
export function shiftDay(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day from one date to another, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDay(d, 1)) out.push(d);
  return out;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first weekday (0–6) and minute of the day of a time, in a zone. Null when it isn't a time. */
export function weekSlot(at: string, tz: string | undefined): { day: number; minute: number } | null {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).formatToParts(t);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = WEEKDAYS.indexOf(get("weekday"));
    const minute = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
    return day >= 0 && Number.isInteger(minute) ? { day, minute } : null;
  } catch {
    return null;
  }
}

function hourIn(at: string, tz: string | undefined): number | null {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  try {
    const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: tz }).format(t));
    return Number.isInteger(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/**
 * Screen time from `from` to `to` (inclusive), with the same length of time
 * before it for comparison. `entries` must reach back that far. `today`
 * (YYYY-MM-DD) stops the average counting days that haven't come.
 */
export function screenTime(entries: Array<StatEntry & { at?: string }>, items: StatItem[], from: string, to: string, opts: { tz?: string; today?: string } = {}): ScreenTime {
  const span = daysBetween(from, to);
  const prevFrom = shiftDay(from, -span.length);
  const known = new Map<string, WatchMeta>();
  for (const it of items) {
    const as = it.kind === "tv" ? "episode" : it.kind === "film" ? "film" : it.kind === "video" || it.kind === "music" ? "video" : null;
    if (as && it.meta && fold(it.title)) known.set(`${as}:${fold(it.title)}`, it.meta);
  }
  const blank = (): ScreenSpan => ({ total: 0, average: 0, waking: 0, films: 0, shows: 0, videos: 0, plays: 0 });
  const now = blank();
  const before = blank();
  const days = new Map(span.map((date) => [date, { date, minutes: 0, plays: 0 }]));
  const parts: Record<DayPart, number> = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  let timed = 0;
  const grid = () => Array.from({ length: 7 }, () => new Array<number>(48).fill(0));
  const week = grid();
  const weekPlays = grid();
  for (const e of entries) {
    if (e.kind !== "watched") continue;
    const inNow = e.date >= from && e.date <= to;
    const inBefore = e.date >= prevFrom && e.date < from;
    if (!inNow && !inBefore) continue;
    const as = watchedAs(e);
    const plays = Math.max(1, Math.round(e.count ?? 1));
    const meta = known.get(`${as}:${fold(as === "episode" ? (e.group ?? e.title) : e.title)}`);
    const minutes = e.minutes && e.minutes > 0 ? e.minutes : meta?.minutes ? meta.minutes * plays : 0;
    const into = inNow ? now : before;
    into.plays += plays;
    into.total += minutes;
    into[as === "film" ? "films" : as === "episode" ? "shows" : "videos"] += minutes;
    if (!inNow) continue;
    const day = days.get(e.date)!;
    day.plays += plays;
    day.minutes += minutes;
    if (minutes) timed += plays;
    const hour = e.at ? hourIn(e.at, opts.tz) : null;
    if (hour !== null) parts[dayPart(hour)] += plays;
    const slot = e.at ? weekSlot(e.at, opts.tz) : null;
    if (slot) {
      weekPlays[slot.day][Math.floor(slot.minute / 30)] += plays;
      // Its minutes, laid along the half hours from when it was logged, over midnight into the next day. A day at most.
      let left = Math.min(minutes, 24 * 60);
      let at = slot.day * 1440 + slot.minute;
      while (left > 0) {
        const room = 30 - (at % 30);
        const take = Math.min(room, left);
        const w = at % (7 * 1440);
        week[Math.floor(w / 1440)][Math.floor((w % 1440) / 30)] += take;
        left -= take;
        at += take;
      }
    }
  }
  // An average week: each weekday's minutes over how many of that weekday the span has had.
  const seen = new Array<number>(7).fill(0);
  for (const d of span) if (!opts.today || d <= opts.today) seen[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]++;
  for (let d = 0; d < 7; d++) for (let c = 0; c < 48; c++) week[d][c] = seen[d] ? Math.round((week[d][c] / seen[d]) * 10) / 10 : 0;
  const lived = opts.today ? Math.max(1, span.filter((d) => d <= opts.today!).length) : span.length;
  const settle = (s: ScreenSpan, n: number) => {
    s.average = Math.round(s.total / n);
    s.waking = Math.round((s.total / (n * WAKING_MINUTES)) * 100);
  };
  settle(now, lived);
  settle(before, span.length);
  return { from, to, days: [...days.values()], parts, timed, week, weekPlays, ...now, before };
}
