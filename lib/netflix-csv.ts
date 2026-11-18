/**
 * Netflix's viewing activity file (Account → profile → Viewing activity →
 * Download all: NetflixViewingHistory.csv, one per profile, columns Title and
 * Date), turned into Life log days.
 *
 * Shared by the app and the server, so it has no Node or DOM imports and no
 * value imports at all (lib/youtube-takeout.ts imports this for its keepers).
 * The app parses the file on the device and sends only title parts (show,
 * season, episode, or a film's title) per day; the server folds those days
 * into the Life log's day notes (netlify/lib/connectors/netflix-history.ts).
 *
 * Dates are written the way Netflix writes them for the profile's country
 * ("14/03/2024" in the UK, "3/14/24" in the US, "14.03.24" in Germany,
 * "2024/03/14" in Japan). The file itself usually settles day-first or
 * month-first (a 13 or more in either place); when it can't, the owner's
 * locale does. Dates are calendar days already: no zone maths.
 *
 * In a day note the import owns its lines under "## Watched", told apart by
 * their netflix.com search link. The link's fragment holds a short hash per
 * episode, so a second profile's file adds only the episodes that profile
 * watched, and the same file again changes nothing. A Life log run's line
 * for the same show or film that day (from Trakt or Letterboxd) is folded
 * into the Netflix line, keeping its episode numbers, rating and link, so
 * each title is listed once.
 * A run that rewrites the day keeps the lines (`keepNetflix`, through
 * keepImported).
 */

export type DateOrder = "dmy" | "mdy" | "ymd";

/** One row of the file, read. */
export interface Viewing {
  /** The show, or the film's whole title. */
  title: string;
  /** Short season as shown ("S4", "Part 5"); "" for a limited series or none. Absent for a film. */
  season?: string;
  /** The episode's title. Absent for a film. */
  episode?: string;
  /** YYYY-MM-DD */
  day: string;
}

export interface NetflixParse {
  /** Oldest first. */
  views: Viewing[];
  /** How the dates were read. */
  order: DateOrder;
  /** The file had no date that settled day-first or month-first, so the locale decided. */
  guessed: boolean;
  skipped: {
    /** No date Athena could read. */
    undated: number;
    /** Dated after today. */
    future: number;
  };
}

/** One show (one season) or one film on one day, as sent to the server. */
export interface DayWatch {
  title: string;
  /** Shows only: short season, "" for none. */
  season?: string;
  /** Shows only: the episode titles watched that day. Absent: a film. */
  episodes?: string[];
}

export interface NetflixDay {
  day: string;
  watched: DayWatch[];
}

export class NetflixError extends Error {
  constructor(public readonly reason: "unreadable" | "empty" | "full-export") {
    super(reason);
  }
}

export const WATCHED_HEADING = "## Watched";

// ---------- CSV ----------

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Control characters out, spaces tidied, and "·" (the note's separator) kept out of titles. */
const clean = (s: string, max: number) =>
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s*·\s*/g, " - ").replace(/\s+/g, " ").trim().slice(0, max);

// ---------- Dates ----------

interface RawDate {
  a: number;
  b: number;
  y: number;
  /** Year first (2024/03/14, 2024. 3. 14.). */
  ymd: boolean;
  /** Dots or dashes: always day first when the year is last. */
  dayFirst: boolean;
}

function splitDate(raw: string): RawDate | null {
  const s = raw.trim().replace(/\.$/, "");
  let m = /^(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})$/.exec(s);
  if (m) return { y: Number(m[1]), a: Number(m[3]), b: Number(m[2]), ymd: true, dayFirst: true };
  m = /^(\d{1,2})\s*([/.-])\s*(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
  return { a: Number(m[1]), b: Number(m[3]), y, ymd: false, dayFirst: m[2] !== "/" };
}

function isoDay(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || y < 2000) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Netflix writes month first for these countries (en-US "3/14/24"); everyone else day first. */
export function localeOrder(locale: string | undefined): "dmy" | "mdy" {
  return /^(en-(US|PH|CA)|en|es-US|fil)$/i.test((locale ?? "").trim()) ? "mdy" : "dmy";
}

/** One date, read in the given order; null when it isn't a real date. */
export function readDate(raw: string, order: DateOrder): string | null {
  const d = splitDate(raw);
  if (!d) return null;
  if (d.ymd) return isoDay(d.y, d.b, d.a);
  if (d.dayFirst || order !== "mdy") return isoDay(d.y, d.b, d.a);
  return isoDay(d.y, d.a, d.b);
}

/**
 * How the file's dates are written: year first, day first or month first.
 * A day over 12 in either place settles it for the whole file; otherwise
 * the owner's locale does (`guessed`). Day-first and month-first evidence
 * together means it isn't one profile's file.
 */
export function dateOrder(raws: string[], locale?: string): { order: DateOrder; guessed: boolean } {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const raw of raws) {
    const d = splitDate(raw);
    if (!d) continue;
    if (d.ymd) ymd = true;
    else if (d.dayFirst || d.a > 12) dmy = true;
    else if (d.b > 12) mdy = true;
  }
  if (dmy && mdy) throw new NetflixError("unreadable");
  if (dmy) return { order: "dmy", guessed: false };
  if (mdy) return { order: "mdy", guessed: false };
  if (ymd) return { order: "ymd", guessed: false };
  return { order: localeOrder(locale), guessed: true };
}

// ---------- Titles ----------

const SEASON = /^(?:season|series|temporada|staffel|saison|stagione|seizoen|säsong|sæson|sesong|kausi|sezon|sezóna|série|évad|сезон|sezonul)\s*(\d{1,3})$/i;
const SEASON_ALT = [/^(\d{1,3})(?:st|nd|rd|th)?\s+season$/i, /^シーズン\s*(\d{1,3})$/, /^第\s*(\d{1,3})\s*[季部]$/, /^시즌\s*(\d{1,3})$/];
const LIMITED = /^(?:limited series|miniseries|mini-series|miniserie|mini-série|minisérie|série limitée|serie limitada|limitierte serie|miniserie)$/i;
const OTHER_SEASON = /^(?:part|parte|teil|partie|deel|del|część|volume|vol\.?|volumen|book|chapter|collection|act|batch)\s+[\w.]{1,8}$/i;

/** "Season 4" → "S4", "Stranger Things 4" (for Stranger Things) → "S4", a limited series → "", "Part 5" as it is; null if it isn't a season. */
export function seasonShort(part: string, show: string): string | null {
  const p = part.trim();
  const num = SEASON.exec(p)?.[1] ?? SEASON_ALT.map((r) => r.exec(p)?.[1]).find(Boolean);
  if (num) return `S${Number(num)}`;
  if (LIMITED.test(p)) return "";
  const own = new RegExp(`^${show.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?\\s+(\\d{1,3})$`, "i").exec(p);
  if (own) return `S${Number(own[1])}`;
  if (OTHER_SEASON.test(p)) return p;
  return null;
}

/** "Show: Season 2: Episode" with its season found; null when no part is a season. */
function marked(parts: string[]): Omit<Viewing, "day"> | null {
  for (let i = 1; i < parts.length - 1; i++) {
    const show = parts.slice(0, i).join(": ");
    const s = seasonShort(parts[i], show);
    if (s !== null) return { title: show, season: s, episode: parts.slice(i + 1).join(": ") };
  }
  return null;
}

/**
 * One title, split. With a season part ("Season 2", "Limited Series",
 * "Part 3", "Stranger Things 4") it's a show. Without one, a title that
 * starts with a show found elsewhere in the file is that show; three or
 * more parts are show, season, episode; one or two parts are a film
 * ("Glass Onion: A Knives Out Mystery").
 */
export function splitTitle(raw: string, shows: ReadonlySet<string> = new Set()): Omit<Viewing, "day"> {
  const title = clean(raw, 400);
  const parts = title.split(/:\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const m = marked(parts);
    if (m) return m;
  }
  let best = "";
  for (const s of shows) if (s.length > best.length && title.startsWith(`${s}: `)) best = s;
  if (best) {
    const rest = title.slice(best.length + 2).split(/:\s+/);
    if (rest.length >= 2) return { title: best, season: rest[0] === best ? "" : rest[0], episode: rest.slice(1).join(": ") };
    return { title: best, season: "", episode: rest[0] };
  }
  if (parts.length >= 3) return { title: parts[0], season: parts[1] === parts[0] ? "" : parts[1], episode: parts.slice(2).join(": ") };
  return { title };
}

// ---------- The file ----------

/**
 * The whole file: every row with a date and a title, oldest first. `locale`
 * decides dates the file leaves open; `order` overrides it (the review's
 * "read them the other way"); `today` drops anything later.
 */
export function parseViewingActivity(text: string, opts: { locale?: string; order?: DateOrder; today?: string } = {}): NetflixParse {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  if (header.includes("profile name") && header.includes("start time")) throw new NetflixError("full-export");
  const ti = header.indexOf("title");
  const di = header.indexOf("date");
  if (ti < 0 || di < 0) throw new NetflixError("unreadable");
  const body = rows.slice(1).filter((r) => clean(r[ti] ?? "", 400));
  if (!body.length) throw new NetflixError("empty");
  const found = dateOrder(
    body.map((r) => r[di] ?? ""),
    opts.locale,
  );
  const order = opts.order ?? found.order;
  // Shows the file names with a season somewhere, so their other titles split the same way.
  const shows = new Set<string>();
  for (const r of body) {
    const parts = clean(r[ti], 400).split(/:\s+/);
    const m = parts.length >= 3 ? marked(parts) : null;
    if (m) shows.add(m.title);
  }
  const skipped = { undated: 0, future: 0 };
  const views: Viewing[] = [];
  for (const r of body) {
    const day = readDate(r[di] ?? "", order);
    if (!day) {
      skipped.undated++;
      continue;
    }
    if (opts.today && day > opts.today) {
      skipped.future++;
      continue;
    }
    views.push({ ...splitTitle(r[ti], shows), day });
  }
  // Netflix lists newest first; a stable sort keeps each day's rows in the order watched.
  views.reverse();
  views.sort((a, b) => a.day.localeCompare(b.day));
  return { views, order, guessed: opts.order ? false : found.guessed, skipped };
}

/** Each day's shows (one entry per season) and films, in the order first watched. */
export function groupViewsByDay(views: Viewing[]): NetflixDay[] {
  const days = new Map<string, Map<string, DayWatch>>();
  for (const v of views) {
    const day = days.get(v.day) ?? days.set(v.day, new Map()).get(v.day)!;
    const k = v.season === undefined ? `f|${titleKey(v.title)}` : `s|${titleKey(v.title)}|${v.season}`;
    const w = day.get(k) ?? day.set(k, v.season === undefined ? { title: v.title } : { title: v.title, season: v.season, episodes: [] }).get(k)!;
    if (w.episodes && !w.episodes.includes(v.episode ?? "")) w.episodes.push(v.episode ?? "");
  }
  return [...days.entries()].map(([day, m]) => ({ day, watched: [...m.values()] }));
}

/** Episodes plus films over these days (what the review counts). */
export function countWatched(days: NetflixDay[]): { episodes: number; films: number } {
  let episodes = 0;
  let films = 0;
  for (const d of days) for (const w of d.watched) w.episodes ? (episodes += w.episodes.length) : films++;
  return { episodes, films };
}

/** Whole days per request: at most `maxDays`, and at most `maxItems` episodes and films. */
export function batchNetflixDays(days: NetflixDay[], maxDays = 60, maxItems = 1500): NetflixDay[][] {
  const out: NetflixDay[][] = [];
  let cur: NetflixDay[] = [];
  let items = 0;
  for (const d of days) {
    const n = d.watched.reduce((k, w) => k + (w.episodes?.length ?? 1), 0);
    if (cur.length && (cur.length >= maxDays || items + n > maxItems)) {
      out.push(cur);
      cur = [];
      items = 0;
    }
    cur.push(d);
    items += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------- Matching ----------

/** A title for matching: case, accents, punctuation, "&" and a leading "The" ignored. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

/** A short, stable hash for an episode (FNV-1a), so a note can say which episodes it has without listing them. */
export function episodeHash(show: string, season: string, episode: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${titleKey(show)}|${season}|${titleKey(episode) || episode}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0").slice(-6);
}

// ---------- The day note's Watched lines ----------

/** One Netflix line in a day note. */
export interface WatchLine {
  title: string;
  /** Shows: short season ("" none). Absent: a film. */
  season?: string;
  /** Shows: one hash per episode. */
  eps: string[];
  /** The episode's title when there's just one. */
  name?: string;
  /** From the run's own line for the same title (Trakt, Letterboxd), folded in: */
  /** its episode numbers in that season ("E1–E3"), shows only, */
  range?: string;
  /** its rating ("8/10", "★★★★½"), */
  rating?: string;
  /** and its link, as "[Trakt](https://trakt.tv/…)". */
  link?: string;
}

const escapeMd = (s: string) => s.replace(/([\\[\]*_`<>])/g, "\\$1");
const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");
const SEARCH = "https://www.netflix.com/search?q=";

const lineKey = (w: Pick<WatchLine, "title" | "season">) => (w.season === undefined ? `f|${titleKey(w.title)}` : `s|${titleKey(w.title)}|${w.season}`);

/**
 * "- [Slow Horses S4](https://www.netflix.com/search?q=Slow%20Horses#e=…) · 3 episodes", "- [Glass Onion](…) · Film",
 * with Trakt's numbers, rating and link when it logged the same: "- [Slow Horses S4E1–E3](…) · 3 episodes · 8/10 · [Trakt](…)".
 */
function line(w: WatchLine): string {
  const label = w.season ? `${w.title} ${w.season}${w.range && /^S\d+$/.test(w.season) ? w.range : ""}` : w.title;
  const what = w.season === undefined ? "Film" : w.eps.length === 1 && w.name ? escapeMd(w.name) : `${w.eps.length} ${w.eps.length === 1 ? "episode" : "episodes"}`;
  const frag = w.season === undefined ? "" : `#e=${w.eps.join(".")}`;
  const tail = [what, w.rating, w.link].filter(Boolean).join(" · ");
  return `- [${escapeMd(label)}](${SEARCH}${encodeURIComponent(w.title).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}${frag}) · ${tail}`;
}

const LINE = /^- \[((?:\\.|[^\]\\])*)\]\(https:\/\/www\.netflix\.com\/search\?q=([^)#\s]*)(?:#e=([0-9a-z.]*))?\) · ((?:\\.|[^·])*?)(?: · (.+?))?\s*$/;
const LINK = /^\[[^\]]+\]\(https:\/\/[^)\s]+\)$/;

/** A line the import wrote, read back; null for anything else. */
export function readLine(l: string): WatchLine | null {
  const m = LINE.exec(l);
  if (!m) return null;
  let title: string;
  try {
    title = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const label = unescapeMd(m[1]);
  const what = unescapeMd(m[4].trim());
  const tail = (m[5] ?? "").split(" · ").map((t) => t.trim()).filter(Boolean);
  const link = tail.find((t) => LINK.test(t));
  const rating = tail.filter((t) => t !== link).join(" · ") || undefined;
  const folded = { ...(rating ? { rating } : {}), ...(link ? { link } : {}) };
  if (m[3] === undefined) return { title, eps: [], ...folded };
  const rest = label.startsWith(title) ? label.slice(title.length).trim() : "";
  const numbered = /^(S\d+)(E\d+(?:–E\d+)?)$/.exec(rest);
  const season = numbered ? numbered[1] : rest;
  const eps = m[3].split(".").filter(Boolean);
  const name = eps.length === 1 && !/^\d+ episodes?$/.test(what) ? what : undefined;
  return { title, season, eps, ...(name ? { name } : {}), ...(numbered ? { range: numbered[2] } : {}), ...folded };
}

const isHeading = (l: string) => /^#{1,6} /.test(l);
const WATCHED = /^#{1,6} Watched\s*$/i;
/** Headings that come after Watched (recipes.ts's order, then the YouTube import's sections). */
const AFTER = /^#{1,6} (Listened|Read|Played|Liked and saved|Posted|Watched on YouTube|Listened on YouTube Music)\s*$/i;

function sectionAt(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => WATCHED.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  return [start, end];
}

/** The Netflix lines in a body, under Watched. */
export function readWatched(body: string): WatchLine[] {
  const lines = body.split("\n");
  const at = sectionAt(lines);
  return at ? lines.slice(at[0] + 1, at[1]).map(readLine).filter((w): w is WatchLine => !!w) : [];
}

/**
 * Does a run's own Watched line ("Slow Horses S4E1 to E3, 3 episodes",
 * "[Dune: Part Two (2024)](…) · ★★★★") name this show or film? Its title is
 * what comes before a season, a year, "·" or a comma. A different season of
 * the same show is a different line.
 */
function sameTitle(runLine: string, w: WatchLine): boolean {
  const plain = runLine.replace(/^- /, "").replace(/\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, "$1").trim();
  if (/^(started|rewatch(ed)?)\b/i.test(plain)) return false;
  const head = plain.split(/\s+(?=·|S\d+(?:E\d+)?\b|\(\d{4}\))|,/i)[0];
  if (titleKey(unescapeMd(head)) !== titleKey(w.title)) return false;
  const theirs = /\bS(\d+)(?:E\d+)?\b/i.exec(plain)?.[1];
  const mine = /^S(\d+)$/.exec(w.season ?? "")?.[1];
  return !(theirs && mine && Number(theirs) !== Number(mine));
}

/** The rating on a run's line, if it has one. */
const ratingOf = (runLine: string) => /(\d{1,2}(?:\.\d)?\/10|★+½?|½★?)/.exec(runLine)?.[1];

/** The episodes a run's line names in a season: "S4E1 to E3" → "E1–E3", "S4E2" → "E2". */
function rangeOf(runLine: string): string | undefined {
  const m = /\bS\d+E(\d+)(?:\s*(?:to|–|—|-)\s*(?:S\d+)?E(\d+))?/i.exec(runLine);
  if (!m) return undefined;
  return m[2] && m[2] !== m[1] ? `E${Number(m[1])}–E${Number(m[2])}` : `E${Number(m[1])}`;
}

const SOURCE_NAMES: Record<string, string> = { "trakt.tv": "Trakt", "letterboxd.com": "Letterboxd" };

/** The run line's link (not Netflix's), as "[Trakt](…)". */
function linkOf(runLine: string): string | undefined {
  for (const m of runLine.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) {
    let host: string;
    try {
      host = new URL(m[1]).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host.endsWith("netflix.com")) continue;
    return `[${SOURCE_NAMES[host] ?? host}](${m[1]})`;
  }
  return undefined;
}

/**
 * `body` with its Watched section holding these Netflix lines first, then the
 * run's own lines that aren't one of these titles again. A run line for the
 * same title is folded in: its rating goes on the Netflix line.
 */
function withWatched(body: string, list: WatchLine[]): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = sectionAt(lines);
  if (!at && !list.length) return body;
  const mine = list.map((w) => ({ ...w }));
  const others = at
    ? lines.slice(at[0] + 1, at[1]).filter((l) => {
        if (!l.trim() || readLine(l)) return false;
        const w = mine.find((x) => sameTitle(l, x));
        if (!w) return true;
        // One line per title: Trakt's (or Letterboxd's) numbers, rating and link go on the Netflix line.
        const r = ratingOf(l);
        if (r) w.rating = r;
        const k = linkOf(l);
        if (k) w.link = k;
        const n = /^S\d+$/.test(w.season ?? "") ? rangeOf(l) : undefined;
        if (n) w.range = n;
        return false;
      })
    : [];
  const section = mine.length || others.length ? [WATCHED_HEADING, ...mine.map(line), ...others] : [];
  let out: string[];
  if (at) out = [...lines.slice(0, at[0]), ...section, ...(at[1] < lines.length ? [""] : []), ...lines.slice(at[1])];
  else {
    const before = lines.findIndex((l) => AFTER.test(l));
    out = before < 0 ? [...lines, "", ...section] : [...lines.slice(0, before), "", ...section, "", ...lines.slice(before)];
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface WatchMergeResult {
  body: string;
  /** Episodes and films this file adds that the note didn't have. */
  added: number;
  /** Of those, films. */
  added_films: number;
  /** The Netflix lines after the merge. */
  lines: WatchLine[];
  changed: boolean;
}

/** One request's entry as the line it becomes. */
export function toLine(w: DayWatch): WatchLine {
  if (!w.episodes) return { title: w.title, eps: [] };
  const season = w.season ?? "";
  const eps = [...new Set(w.episodes.map((e) => episodeHash(w.title, season, e)))];
  const name = w.episodes.length === 1 && w.episodes[0] ? w.episodes[0] : undefined;
  return { title: w.title, season, eps, ...(name ? { name } : {}) };
}

/**
 * A day note's body with `incoming` folded into its Watched section. An
 * episode already there (by its hash) or a film already there adds nothing,
 * so the same file again changes nothing and another profile's file adds
 * only what's new. Everything else in the note is left as it was.
 */
export function mergeWatched(body: string, incoming: DayWatch[]): WatchMergeResult {
  const have = readWatched(body);
  const byKey = new Map(have.map((w) => [lineKey(w), { ...w, eps: [...w.eps] }]));
  let added = 0;
  let addedFilms = 0;
  for (const raw of incoming) {
    const w = toLine(raw);
    const old = byKey.get(lineKey(w));
    if (!old) {
      byKey.set(lineKey(w), w);
      added += w.season === undefined ? 1 : w.eps.length;
      if (w.season === undefined) addedFilms++;
      continue;
    }
    for (const e of w.eps)
      if (!old.eps.includes(e)) {
        old.eps.push(e);
        added++;
      }
    if (old.eps.length > 1) delete old.name;
    else if (w.name && old.eps.length === 1 && old.eps[0] === w.eps[0]) old.name = w.name;
  }
  const lines = [...byKey.values()];
  const next = withWatched(body, lines);
  return { body: next, added, added_films: addedFilms, lines, changed: next !== withWatched(body, have) };
}

/**
 * What a Life log run saves for a day, with the Netflix lines from the note
 * it replaces put back (a run line for the same title folded in). A note with
 * no Netflix lines is saved exactly as the run wrote it.
 */
export function keepNetflix(previous: string, next: string): string {
  const kept = readWatched(previous);
  return kept.length ? withWatched(next, kept) : next;
}

/** "Slow Horses on Netflix", "Slow Horses and Glass Onion on Netflix", "Slow Horses, Dune and 2 more on Netflix". */
export function netflixSummary(lines: Array<Pick<WatchLine, "title">>): string {
  const names = [...new Set(lines.map((l) => l.title))];
  const said = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `${said} on Netflix`;
}

/** A title the import wrote (so a later import may refresh it). */
export const NETFLIX_TITLE = / · .+ on Netflix$/;
