/**
 * The one-off move from Life log day notes to Days (owner decision, 7 Nov
 * 2026: convert, then archive; never delete).
 *
 * Each Life log note ("life-log-<date>" in collected_items) is read section
 * by section into Day entries (lib/days.ts), its title's description becomes
 * the day's line when the day has none, and the note is archived. Health and
 * Places sections are dropped: those figures and places are already in their
 * sealed rows, which the Day reads.
 *
 * Lines the imports wrote are read with the imports' own readers, so they
 * get the ids a later import would use (lib/day-imports.ts) and re-importing
 * the same file changes nothing. Other lines are read as "title · maker ·
 * extras" with a link, a rating and a count where there is one.
 *
 * Idempotent: entries are keyed by the note and the line, archived notes
 * aren't read again, and planConversion() counts what would happen without
 * writing anything (the dry run the app shows first).
 */
import { openStrict } from "./data-box";
import { q, qRaw, sealer } from "./db";
import { goodreadsEntries, netflixFilmId, netflixUrl, youtubeEntries } from "./day-imports";
import { cleanUrl, CONVERTED, matchKey, writeEntries, type EntryInput } from "./days";

export { CONVERTED };
import type { DayEntryKind } from "./day-types";
import { BOOKS_TITLE, readImportedBooks } from "./goodreads-csv";
import { NETFLIX_TITLE, readWatched } from "./netflix-csv";
import { IMPORT_TITLE, readImported } from "./youtube-takeout";
import { toStars } from "./watch-read-sync";


const SECTION_KIND: Array<[RegExp, DayEntryKind | null]> = [
  [/^health$/i, null],
  [/^places$/i, null],
  [/^watched on youtube$/i, null],
  [/^listened on youtube music$/i, null],
  [/^watched$/i, "watched"],
  [/^listened$/i, "listened"],
  [/^read$/i, "read"],
  [/^highlights?$/i, "highlight"],
  [/^played$/i, "played"],
  [/^chess$/i, "chess"],
  [/^(liked and saved|saved|liked)$/i, "saved"],
  [/^posted$/i, "posted"],
];

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)trakt\.tv$/, "trakt"],
  [/(^|\.)letterboxd\.com$/, "letterboxd"],
  [/(^|\.)goodreads\.com$/, "goodreads"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "youtube"],
  [/(^|\.)last\.fm$/, "lastfm"],
  [/(^|\.)spotify\.com$/, "spotify"],
  [/(^|\.)steam(community|powered)\.com$/, "steam"],
  [/(^|\.)lichess\.org$/, "lichess"],
  [/(^|\.)chess\.com$/, "chesscom"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)readwise\.io$|(^|\.)amazon\.[a-z.]+$/, "readwise"],
  [/(^|\.)plex\.tv$/, "plex"],
  [/(^|\.)(listen|music)brainz\.org$/, "listenbrainz"],
  [/(^|\.)eventbrite\.[a-z.]+$/, "eventbrite"],
];

export function sourceOf(url: string | undefined): string {
  if (!url) return "life_log";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? "life_log";
  } catch {
    return "life_log";
  }
}

/** A short stable hash (FNV-1a) of a line, so the same line in the same note is the same entry. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");
const LINK = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/;
const COUNT = /^(\d[\d,]*) (episodes?|tracks?|plays?|highlights?|games?|times|posts?|videos?|songs?)$/i;
const MINUTES = /^(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i;
const RATING = /^(★{1,5}½?|½|\d+(?:\.\d+)?\s*\/\s*(?:10|5))$/;

/** Split "a · b · [c · d](…)" on the dots outside links. */
function splitDots(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      cur += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    if ((ch === "]" || ch === ")") && depth > 0) depth--;
    if (depth === 0 && text.startsWith(" · ", i)) {
      out.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/**
 * One list line of an old day note as an entry, or null for a line that
 * isn't one. "- [Severance S2E3](https://trakt.tv/…) · Who Is Alive? · 8/10"
 */
export function readNoteLine(raw: string, kind: DayEntryKind): Omit<EntryInput, "external_id"> | null {
  let text = raw.replace(/^\s*[-*+]\s+/, "").trim();
  if (!text) return null;
  let note: string | undefined;
  const started = /^(Started|Finished|Rewatch|Liked|Saved|Subscribed to|Added to [^:]+):\s*/i.exec(text);
  if (started) {
    note = started[1].toLowerCase();
    text = text.slice(started[0].length);
  }
  const parts = splitDots(text);
  let title = "";
  let url: string | undefined;
  let rating: number | undefined;
  let count: number | undefined;
  let minutes: number | undefined;
  const rest: string[] = [];
  parts.forEach((p, i) => {
    const part = p.trim();
    const link = LINK.exec(part);
    if (i === 0) {
      if (link) {
        const label = unescapeMd(link[1]).trim().split(/\s+·\s+/);
        title = label[0];
        rest.push(...label.slice(1));
        url = cleanUrl(link[2]);
        // "3 highlights from [The Wager](…)": the count before the link.
        const before = /(\d[\d,]*)\s+\w+/.exec(part.slice(0, link.index));
        if (before) count = Number(before[1].replace(/,/g, ""));
        const after = part.slice(link.index + link[0].length).trim();
        if (after) rest.push(after.replace(/^[,:]\s*/, ""));
      } else title = unescapeMd(part.replace(/[*_`]/g, ""));
      // "Severance S2E3": the show, and the episode as the subtitle.
      const ep = /^(.+?)\s+(S\d+\s?E\d+(?:\s?(?:to|–|-)\s?E?\d+)?)\b\s*(.*)$/i.exec(title);
      if (ep) {
        title = ep[1];
        rest.unshift(ep[3] ? `${ep[2]} ${ep[3]}`.trim() : ep[2]);
      }
      return;
    }
    if (link && link[0] === part) {
      url ??= cleanUrl(link[2]);
      return;
    }
    if (RATING.test(part)) {
      rating = toStars(/★|½/.test(part) ? "letterboxd" : "trakt", part.replace(/\s+/g, "")) ?? rating;
      return;
    }
    const c = COUNT.exec(part);
    if (c) {
      count = Number(c[1].replace(/,/g, ""));
      return;
    }
    const m = MINUTES.exec(part.replace(/\s+listening|\s+played/i, ""));
    if (m && (m[1] || m[2])) {
      minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
      return;
    }
    if (/^(rewatch|film|the whole album)$/i.test(part)) {
      note = note ? `${note}, ${part.toLowerCase()}` : part.toLowerCase();
      return;
    }
    rest.push(unescapeMd(part.replace(/[*_`]/g, "")));
  });
  if (!title) return null;
  let k = kind;
  if (k === "read" && /highlights?/i.test(text)) k = "highlight";
  if (k === "played" && /^chess\b/i.test(title)) k = "chess";
  const source = sourceOf(url);
  const subtitle = rest.filter(Boolean).join(" · ");
  return {
    kind: k,
    source,
    title: title.slice(0, 300),
    ...(subtitle ? { subtitle: subtitle.slice(0, 300) } : {}),
    ...(url ? { url } : {}),
    ...(rating ? { rating } : {}),
    ...(count && count > 1 ? { count } : {}),
    ...(minutes ? { minutes } : {}),
    ...(note ? { note } : {}),
  };
}

/** The description in a day note's title ("Friday 6 November · Severance, a film and a book" → "Severance, a film and a book"). Not the imports' own counts. */
export function lineFromTitle(title: string): string | null {
  if (IMPORT_TITLE.test(title) || NETFLIX_TITLE.test(title) || BOOKS_TITLE.test(title)) return null;
  const at = title.indexOf(" · ");
  if (at < 0) return null;
  const line = title.slice(at + 3).trim();
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : null;
}

export interface ParsedNote {
  line: string | null;
  entries: EntryInput[];
  /** Lines under a list section that didn't read as an entry. */
  unread: number;
}

/** A whole day note as entries. Pure: the conversion and its tests share it. */
export function parseLifeLogNote(date: string, noteId: string, title: string, body: string): ParsedNote {
  const entries: EntryInput[] = [];
  let unread = 0;
  // The imports' own lines first, under the ids a re-import would use.
  const videos = readImported(body);
  if (videos.length) entries.push(...youtubeEntries({ day: date, videos }));
  const books = readImportedBooks(body);
  if (books.length) entries.push(...goodreadsEntries({ day: date, books }));
  const bookKeys = new Set(books.map((b) => matchKey(b.title)));
  for (const w of readWatched(body)) {
    const link = w.link ? cleanUrl(LINK.exec(w.link)?.[2]) : undefined;
    const rating = w.rating ? toStars(/★|½/.test(w.rating) ? "letterboxd" : "trakt", w.rating.replace(/\s+/g, "")) : undefined;
    const extra = { ...(rating ? { rating } : {}) };
    if (w.season === undefined) {
      entries.push({ kind: "watched", source: "netflix", external_id: netflixFilmId(date, w.title), title: w.title, url: link ?? netflixUrl(w.title), ...extra });
      continue;
    }
    const label = [w.season ? `${w.season}${w.range ?? ""}` : "", w.name ?? ""].filter(Boolean).join(" · ");
    w.eps.forEach((h, i) =>
      entries.push({
        kind: "watched",
        source: "netflix",
        external_id: `${date}:${h}`,
        title: w.title,
        ...(label ? { subtitle: w.eps.length > 1 && w.season ? `${w.season} · episode ${i + 1} of ${w.eps.length}` : label } : {}),
        url: netflixUrl(w.title),
        group: w.title,
        ...(i === 0 ? extra : {}),
      }),
    );
  }
  // Then every other list line, section by section.
  let kind: DayEntryKind | null = null;
  let index = 0;
  for (const l of body.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(l);
    if (heading) {
      const found = SECTION_KIND.find(([re]) => re.test(heading[1].trim()));
      kind = found ? found[1] : "other";
      continue;
    }
    if (!kind || !/^\s*[-*+]\s+\S/.test(l)) continue;
    // Netflix's lines were read above.
    if (/\]\(https:\/\/www\.netflix\.com\/search\?q=/.test(l)) continue;
    const parsed = readNoteLine(l, kind);
    if (!parsed) {
      unread++;
      continue;
    }
    // A Goodreads line the import wrote is in already.
    if (parsed.source === "goodreads" && bookKeys.has(matchKey(parsed.title))) continue;
    entries.push({ ...parsed, external_id: `note:${noteId}:${hash(`${index++}|${l.trim()}`)}` });
  }
  return { line: lineFromTitle(title), entries, unread };
}

// ---------- The job ----------

interface NoteRow {
  id: string;
  date: string;
  source: string;
  title: string;
  body: string;
}

async function lifeLogNotes(limit: number): Promise<NoteRow[]> {
  return qRaw<NoteRow>(
    `SELECT n.id, substring(ci.external_id from 10) AS date, n.source, n.title, n.body
     FROM collected_items ci JOIN notes n ON n.id = ci.record_id
     WHERE ci.kind = 'note' AND ci.external_id ~ '^life-log-[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND n.archived_at IS NULL
     ORDER BY ci.external_id LIMIT $1`,
    [limit],
  );
}

export interface ConversionPlan {
  /** Life log notes still to convert. */
  notes: number;
  days: number;
  entries: number;
  by_kind: Partial<Record<DayEntryKind, number>>;
  /** Days that would get their line from the note's title. */
  lines: number;
  /** Notes that won't open here (a deploy without the key): left for later. */
  unreadable: number;
  /** List lines that didn't read as an entry (kept in the archived note). */
  unread_lines: number;
  first?: string;
  last?: string;
}

const MAX_NOTES = 5000;

function open(n: NoteRow): { title: string; body: string } | null {
  try {
    return { title: openStrict(n.title), body: openStrict(n.body) };
  } catch {
    return null;
  }
}

/** The dry run: what converting would do, writing nothing. */
export async function planConversion(): Promise<ConversionPlan> {
  const notes = await lifeLogNotes(MAX_NOTES);
  const plan: ConversionPlan = { notes: 0, days: 0, entries: 0, by_kind: {}, lines: 0, unreadable: 0, unread_lines: 0 };
  const days = new Set<string>();
  const lined = new Set((await q<{ date: string }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date FROM days WHERE line IS NOT NULL`)).map((r) => r.date));
  for (const n of notes) {
    const o = open(n);
    if (!o) {
      plan.unreadable++;
      continue;
    }
    plan.notes++;
    const p = parseLifeLogNote(n.date, n.id, o.title, o.body);
    days.add(n.date);
    plan.entries += p.entries.reduce((c, e) => c + (e.count ?? 1), 0);
    for (const e of p.entries) plan.by_kind[e.kind] = (plan.by_kind[e.kind] ?? 0) + (e.count ?? 1);
    if (p.line && !lined.has(n.date)) plan.lines++;
    plan.unread_lines += p.unread;
    plan.first = !plan.first || n.date < plan.first ? n.date : plan.first;
    plan.last = !plan.last || n.date > plan.last ? n.date : plan.last;
  }
  plan.days = days.size;
  return plan;
}

export interface ConversionResult {
  converted: number;
  entries: number;
  lines: number;
  /** Notes left (unreadable ones included): call again until it's 0 or only unreadable ones are left. */
  remaining: number;
  unreadable: number;
}

/**
 * Convert Life log notes to Days within `budgetMs`, then archive each one.
 * Safe to stop and call again: what's done is skipped.
 */
export async function convertLifeLogNotes(opts: { budgetMs?: number } = {}): Promise<ConversionResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 8_000);
  const notes = await lifeLogNotes(MAX_NOTES);
  const result: ConversionResult = { converted: 0, entries: 0, lines: 0, remaining: 0, unreadable: 0 };
  const s = await sealer();
  for (const n of notes) {
    if (Date.now() > deadline) {
      result.remaining++;
      continue;
    }
    const o = open(n);
    if (!o) {
      result.unreadable++;
      result.remaining++;
      continue;
    }
    const p = parseLifeLogNote(n.date, n.id, o.title, o.body);
    for (let i = 0; i < p.entries.length; i += 400) {
      const w = await writeEntries(p.entries.slice(i, i + 400).map((entry) => ({ date: n.date, entry })), { collection: CONVERTED });
      result.entries += w.created;
    }
    if (p.line) {
      const rows = await qRaw<{ date: string }>(
        `INSERT INTO days (date, line, line_by) VALUES ($1::date, $2, 'run')
         ON CONFLICT (date) DO UPDATE SET line = EXCLUDED.line, line_by = 'run', updated_at = now() WHERE days.line IS NULL RETURNING date`,
        [n.date, s.text(p.line)],
      );
      if (rows.length) result.lines++;
    } else await qRaw(`INSERT INTO days (date) VALUES ($1::date) ON CONFLICT (date) DO NOTHING`, [n.date]);
    // The day's photos come too: a note's files are now the day's.
    await qRaw(
      `INSERT INTO day_files (date, file_id) SELECT $2::date, nf.file_id FROM note_files nf JOIN files f ON f.id = nf.file_id
       WHERE nf.note_id = $1 AND f.type LIKE 'image/%' ON CONFLICT DO NOTHING`,
      [n.id, n.date],
    );
    // Archived, never deleted: it's on the Archived page, and nothing writes to it again.
    await qRaw(`UPDATE notes SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [n.id]);
    await qRaw(`UPDATE collected_items SET archived_by_collector = false WHERE record_id = $1 AND kind = 'note'`, [n.id]);
    result.converted++;
  }
  return result;
}
