/**
 * BBC iPlayer viewing history, from the copy of your BBC account data the
 * BBC sends (a handful of CSVs, sometimes zipped). Pure, shared by the app
 * (components/iplayer-import.ts), the server and the tests.
 *
 * The BBC doesn't publish the file's layout and has changed its wording
 * over the years, so columns are found by header, from a list of the names
 * seen for each part:
 *  - the programme ("Programme Title", "Brand Title", "Title"…),
 *  - the episode ("Episode Title", "Episode"…), and the series when separate,
 *  - when it was watched ("Date Watched", "Watched At", "Activity Date",
 *    "Timestamp"…),
 *  - how long ("Duration Watched", "Minutes Watched", "Seconds Watched"…),
 *    in seconds, minutes, milliseconds or h:mm:ss,
 *  - the programme's id ("Episode PID", "Programme ID", "PID"…).
 * A file is iPlayer's when it has a programme and a time, and an episode,
 * an id or a duration. When a column says which BBC product a row is from
 * (iPlayer, Sounds…), only iPlayer rows are kept. With no episode column, a
 * title like "Doctor Who: Series 14: 2. The Devil's Chord" is split at its
 * colons.
 *
 * Per day, each programme once (`<day>:<programme id>`, lib/day-imports.ts):
 * the BBC's own id when the file has one, else a hash of programme and
 * episode, so the same file again gives the same ids. Watches under a minute
 * (a trailer, autoplay) are left out.
 */
import { zonedParts } from "./dates";
import { readDate, titleKey, type DateOrder } from "./netflix-csv";
import { norm, tidy } from "./amazon-export";
import { Columns, cellOf, eachCsvRow, headerOf, withUnit } from "./apple-music-export";

// ---------- Shapes ----------

export interface Programme {
  /** The BBC's id (a PID like m001abcd), else a hash of programme and episode. */
  key: string;
  title: string;
  /** "Series 14", when the file names one apart from the episode. */
  series?: string;
  /** The episode's title, or "Episode 3". */
  episode?: string;
  minutes?: number;
  /** A film or one-off: no episode. */
  film?: boolean;
}

export interface WatchDay {
  day: string;
  programmes: Programme[];
}

export interface IplayerExport {
  days: WatchDay[];
  counts: { days: number; watches: number; programmes: number; minutes: number };
  /** Most watched first, by minutes, then episodes. */
  top: Array<{ title: string; episodes: number; minutes: number }>;
  range: { first: string; last: string } | null;
  files: string[];
  skipped: { short: number; undated: number; future: number; other: number };
}

export const MIN_WATCH_MINUTES = 1;

// ---------- Headers ----------

const PROGRAMME = ["programmetitle", "programmename", "programme", "brandtitle", "brandname", "brand", "showtitle", "showname", "seriesname", "title", "contenttitle", "programtitle"];
const EPISODE = ["episodetitle", "episodename", "episode", "subtitle", "episodenumber"];
const SERIES = ["seriestitle", "series", "seriesnumber", "season"];
const WHEN = ["datewatched", "watchedat", "watcheddate", "watchedon", "dateviewed", "viewedat", "viewingdate", "activitydate", "activitytimestamp", "eventtimestamp", "playbackstart", "starttime", "timestamp", "datetime", "date"];
const PID = ["episodepid", "episodeid", "programmeid", "programmepid", "pid", "versionpid", "contentid", "itemid"];
const DURATION = ["durationwatched", "watchedduration", "minuteswatched", "secondswatched", "timewatched", "watchtime", "watchtimeseconds", "playbackduration", "viewingduration", "duration"];
const PRODUCT = ["product", "service", "platform", "productname", "application"];

const any = (h: Set<string>, names: string[]) => names.some((n) => h.has(n) || [...h].some((k) => withUnit(k, n)));

/** Is this CSV iPlayer viewing history? */
export function sniffIplayer(header: string[]): "iplayer" | null {
  const h = new Set(header.map(norm));
  if (!any(h, PROGRAMME) || !any(h, WHEN)) return null;
  return any(h, EPISODE) || any(h, PID) || any(h, DURATION) ? "iplayer" : null;
}

// ---------- Cells ----------

/** Minutes from a duration cell, reading the header for its unit; undefined when blank. */
export function readMinutes(raw: string, header: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const hms = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (hms) return (Number(hms[1] ?? 0) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 60;
  const words = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)\b|(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?)\b|(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)\b/gi;
  if (/[a-z]/i.test(s)) {
    let mins = 0;
    let found = false;
    for (const m of s.matchAll(words)) {
      found = true;
      if (m[1]) mins += Number(m[1]) * 60;
      if (m[3]) mins += Number(m[3]);
      if (m[5]) mins += Number(m[5]) / 60;
    }
    return found ? mins : undefined;
  }
  const v = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(v) || v < 0) return undefined;
  const h = norm(header);
  if (/milli|ms$/.test(h)) return v / 60_000;
  if (/second|secs?$/.test(h)) return v / 60;
  if (/minute|mins?$/.test(h)) return v;
  // A bare "Duration": a programme is rarely over five hours, so bigger numbers are seconds.
  return v > 300 ? v / 60 : v;
}

/** An instant or a day from a cell. A date with no time keeps its day. */
function readWhen(raw: string, order: DateOrder, tz: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) return zonedParts(new Date(Number(s)), tz).date;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (iso) {
    if (!iso[2]) return iso[1];
    const zone = !iso[3] || /^(z|utc|gmt)$/i.test(iso[3]) ? "Z" : iso[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const time = iso[2].indexOf(":") === 1 ? `0${iso[2]}` : iso[2];
    const d = new Date(`${iso[1]}T${time}${zone}`);
    return Number.isNaN(d.getTime()) ? null : zonedParts(d, tz).date;
  }
  // "14/03/2024 21:05" and friends: the BBC is British, so day first unless the file says otherwise.
  const dateOnly = s.replace(/[T ,]+\d{1,2}:\d{2}(:\d{2})?(\s*(AM|PM))?(\s*(UTC|GMT|Z))?$/i, "").trim();
  return readDate(dateOnly, order);
}

/** A stable key for a programme without an id. */
export function programmeKey(title: string, episode: string | undefined): string {
  let h = 0x811c9dc5;
  for (const ch of `${titleKey(title)}|${titleKey(episode ?? "")}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(36).padStart(7, "0")}`;
}

/** "Doctor Who: Series 14: 2. The Devil's Chord" → Doctor Who, "Series 14 · 2. The Devil's Chord". */
export function splitProgramme(raw: string): { title: string; series?: string; episode?: string } {
  const parts = raw.split(/:\s+/).map((p) => tidy(p)).filter(Boolean);
  if (parts.length < 2) return { title: tidy(raw) };
  if (parts.length === 2) return { title: parts[0], episode: parts[1] };
  return { title: parts[0], series: parts[1], episode: parts.slice(2).join(", ") };
}

/** How a programme's part reads on a day: "Series 14 · Boom". */
export const partLabel = (p: Pick<Programme, "series" | "episode">) => [p.series, p.episode].filter(Boolean).join(" · ");

const PID_RE = /^[bmpw][0-9a-z]{7}$/;

// ---------- Parsing ----------

export interface IplayerParseOptions {
  tz?: string;
  today?: string;
  /** Slash dates: day first unless told otherwise. */
  order?: DateOrder;
  pause?: () => Promise<void>;
  progress?: (fraction: number) => void;
}

export async function parseIplayer(files: Array<{ name: string; text: string }>, opts: IplayerParseOptions = {}): Promise<IplayerExport> {
  const tz = opts.tz ?? "Europe/London";
  const today = opts.today ?? zonedParts(new Date(), tz).date;
  const order = opts.order ?? "dmy";
  const pause = opts.pause ?? (async () => undefined);
  const skipped = { short: 0, undated: 0, future: 0, other: 0 };
  const byDay = new Map<string, Map<string, Programme>>();
  const read: string[] = [];
  let watches = 0;
  const total = files.reduce((k, f) => k + f.text.length, 0) || 1;
  let done = 0;

  for (const f of files) {
    if (!sniffIplayer(headerOf(f.text))) {
      done += f.text.length;
      continue;
    }
    read.push(f.name);
    let c: Record<string, number> | null = null;
    let durHeader = "";
    await eachCsvRow(
      f.text,
      (row, at) => {
        if (!c) {
          const cols = new Columns(row);
          c = { programme: cols.find(PROGRAMME), episode: cols.find(EPISODE), series: cols.find(SERIES), when: cols.find(WHEN), pid: cols.find(PID), dur: cols.find(DURATION), product: cols.find(PRODUCT) };
          durHeader = c.dur >= 0 ? row[c.dur] : "";
          // "Series" picked as the programme (no better column) isn't also the series.
          if (c.series === c.programme) c.series = -1;
          return;
        }
        opts.progress?.(Math.min(1, (done + at * f.text.length) / total));
        const product = cellOf(row, c.product);
        if (product && !/iplayer|\btv\b|video/i.test(product)) return void skipped.other++;
        const day = readWhen(cellOf(row, c.when), order, tz);
        if (!day) return void skipped.undated++;
        if (day > today) return void skipped.future++;
        const rawTitle = cellOf(row, c.programme);
        if (!rawTitle) return void skipped.other++;
        let title = tidy(rawTitle);
        let episode = tidy(cellOf(row, c.episode)) || undefined;
        let series: string | undefined;
        if (c.episode < 0) ({ title, series, episode } = splitProgramme(rawTitle));
        if (episode && /^\d+$/.test(episode)) episode = `Episode ${episode}`;
        const seriesCell = tidy(cellOf(row, c.series));
        if (seriesCell) {
          const s = /^\d+$/.test(seriesCell) ? `Series ${seriesCell}` : seriesCell;
          if (titleKey(s) !== titleKey(title) && !(episode ?? "").toLowerCase().includes(s.toLowerCase())) series = s;
        }
        if (!episode && series) [episode, series] = [series, undefined];
        const minutes = c.dur >= 0 ? readMinutes(cellOf(row, c.dur), durHeader) : undefined;
        if (minutes !== undefined && minutes < MIN_WATCH_MINUTES) return void skipped.short++;
        const pid = cellOf(row, c.pid).toLowerCase();
        const key = PID_RE.test(pid) ? pid : programmeKey(title, partLabel({ series, episode }));
        watches++;
        const day_ = byDay.get(day) ?? byDay.set(day, new Map()).get(day)!;
        const prev = day_.get(key);
        if (prev) {
          if (minutes !== undefined) prev.minutes = (prev.minutes ?? 0) + minutes;
          return;
        }
        day_.set(key, { key, title, ...(series ? { series } : {}), ...(episode ? { episode } : { film: true }), ...(minutes !== undefined ? { minutes } : {}) });
      },
      pause,
    );
    done += f.text.length;
    await pause();
  }

  const days: WatchDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, m]) => ({
      day,
      programmes: [...m.values()].map((p) => ({ ...p, ...(p.minutes !== undefined ? { minutes: Math.max(1, Math.round(p.minutes)) } : {}) })),
    }));

  // A programme seen with an episode anywhere is a series, not a film.
  const series = new Set(days.flatMap((d) => d.programmes.filter((p) => p.episode).map((p) => titleKey(p.title))));
  for (const d of days) for (const p of d.programmes) if (p.film && series.has(titleKey(p.title))) delete p.film;

  // Per programme: different episodes (one watched over two days counts once) and minutes.
  const top = new Map<string, { title: string; episodes: number; minutes: number; keys: Set<string> }>();
  let minutes = 0;
  for (const d of days)
    for (const p of d.programmes) {
      minutes += p.minutes ?? 0;
      const k = titleKey(p.title);
      const t = top.get(k) ?? top.set(k, { title: p.title, episodes: 0, minutes: 0, keys: new Set() }).get(k)!;
      t.keys.add(p.key);
      t.episodes = t.keys.size;
      t.minutes += p.minutes ?? 0;
    }
  return {
    days,
    counts: { days: days.length, watches, programmes: top.size, minutes },
    top: [...top.values()].map(({ keys: _keys, ...t }) => t).sort((a, b) => b.minutes - a.minutes || b.episodes - a.episodes || a.title.localeCompare(b.title)).slice(0, 10),
    range: days.length ? { first: days[0].day, last: days[days.length - 1].day } : null,
    files: read,
    skipped,
  };
}

// ---------- What goes to the server ----------

/** Whole days for one request: at most 120 days or 600 programmes. */
export function batchWatchDays(days: WatchDay[], maxDays = 120, maxItems = 600): WatchDay[][] {
  const out: WatchDay[][] = [];
  let cur: WatchDay[] = [];
  let n = 0;
  for (const d of days) {
    const k = Math.min(maxItems, Math.max(1, d.programmes.length));
    if (cur.length && (cur.length >= maxDays || n + k > maxItems)) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(d.programmes.length > maxItems ? { day: d.day, programmes: d.programmes.slice(0, maxItems) } : d);
    n += k;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** News, weather and live channels: watched, but not something to keep in Watch & read. */
export const NOT_FOR_WATCH_READ = /\b(news|weather|newsnight|breakfast|politics live|question time|bbc (one|two|three|four)|cbbc|cbeebies|parliament)\b/i;

/** The months with the most watching, for the preview's bars. */
export function watchingMonths(x: Pick<IplayerExport, "days">, k = 5): Array<{ month: string; programmes: number }> {
  const m = new Map<string, number>();
  for (const d of x.days) m.set(d.day.slice(0, 7), (m.get(d.day.slice(0, 7)) ?? 0) + d.programmes.length);
  return [...m.entries()].map(([month, programmes]) => ({ month, programmes })).sort((a, b) => b.programmes - a.programmes || b.month.localeCompare(a.month)).slice(0, k);
}
