/**
 * Goodreads "Export library" CSV, turned into Life log days: each book you
 * finished goes under "Read" on the day Goodreads says you finished it (or,
 * with no finish date, the day you shelved it), and each book you want to
 * read goes under "Liked and saved" on the day you added it.
 *
 * Shared by the app and the server, so it has no Node or DOM imports (and
 * no value imports from lib/youtube-takeout.ts, which imports this). The app
 * parses the file on the device and sends only id, title, author, rating and
 * day per book; the server folds those days into the Life log's day notes
 * (netlify/lib/connectors/goodreads-library.ts).
 *
 * In a day note the import owns its lines under "## Read" and "## Liked and
 * saved" and nothing else:
 * a Life log run's own Read lines (from Goodreads' shelf widget, linked to
 * review pages) stay beside them. Imported lines link to the book page
 * (goodreads.com/book/show/<id>), which is how they're told apart. A Life log
 * run that rewrites the day keeps them (`keepBooks`, through keepImported),
 * and importing the same file again adds nothing.
 */

export interface LibraryBook {
  /** Goodreads' Book Id. */
  id: string;
  title: string;
  author: string;
  /** Your rating, 1 to 5; 0 when you didn't rate it. */
  rating: number;
  /** Date Read, YYYY-MM-DD (Date Added when `added` or `want`). */
  day: string;
  /** On your to-read shelf: goes under Liked and saved, not Read. */
  want?: boolean;
  /** Finished, but Goodreads has no finish date: on the day you added it. */
  added?: boolean;
}

export interface LibraryParse {
  /** Finished and to-read books, oldest first. */
  books: LibraryBook[];
  skipped: {
    /** Currently reading, with no Date Read. */
    reading: number;
    /** No usable date at all. */
    undated: number;
  };
}

/** One book on one day, as sent to the server. */
export interface DayBook {
  id: string;
  title: string;
  author: string;
  rating: number;
  /** To read: under Liked and saved. */
  want?: boolean;
}

export interface LibraryDay {
  day: string;
  books: DayBook[];
}

export class LibraryError extends Error {
  constructor(public readonly reason: "unreadable" | "empty") {
    super(reason);
  }
}

export const READ_HEADING = "## Read";
export const SAVED_HEADING = "## Liked and saved";

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

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** "2023/05/14" (what Goodreads writes) or "2023-05-14", checked; null otherwise. */
export function readDate(raw: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || y < 1900) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The export: one row per book on any shelf. Finished books go on their
 * Date Read, or their Date Added without one; to-read books on their Date
 * Added. Currently reading is left to the Life log run.
 */
export function parseLibrary(text: string): LibraryParse {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const at = { id: col("book id"), title: col("title"), author: col("author"), rating: col("my rating"), read: col("date read"), added: col("date added"), shelf: col("exclusive shelf") };
  if (at.id < 0 || at.title < 0 || at.read < 0) throw new LibraryError("unreadable");
  const skipped = { reading: 0, undated: 0 };
  const byId = new Map<string, LibraryBook>();
  for (const r of rows.slice(1)) {
    const id = (r[at.id] ?? "").trim();
    const title = clean(r[at.title] ?? "", 300);
    if (!/^\d{1,12}$/.test(id) || !title) continue;
    const shelf = (at.shelf >= 0 ? r[at.shelf] : "")?.trim().toLowerCase();
    const read = readDate(r[at.read] ?? "");
    const added = at.added >= 0 ? readDate(r[at.added] ?? "") : null;
    let book: Pick<LibraryBook, "day" | "want" | "added">;
    if (read) book = { day: read };
    else if (shelf === "read" && added) book = { day: added, added: true };
    else if (shelf === "to-read" && added) book = { day: added, want: true };
    else {
      if (shelf === "currently-reading") skipped.reading++;
      else skipped.undated++;
      continue;
    }
    const rating = Number((r[at.rating] ?? "").trim());
    byId.set(id, { id, title, author: clean(r[at.author] ?? "", 120), rating: !book.want && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0, ...book });
  }
  if (!byId.size && !skipped.reading && !skipped.undated) throw new LibraryError("empty");
  const books = [...byId.values()].sort((a, b) => a.day.localeCompare(b.day) || a.title.localeCompare(b.title));
  return { books, skipped };
}

/** Days oldest first, books in title order within a day. */
export function groupBooksByDay(books: LibraryBook[]): LibraryDay[] {
  const days = new Map<string, DayBook[]>();
  for (const b of books) (days.get(b.day) ?? days.set(b.day, []).get(b.day)!).push({ id: b.id, title: b.title, author: b.author, rating: b.rating, ...(b.want ? { want: true } : {}) });
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => ({ day, books: list }));
}

/** Whole days per request, at most `maxDays`. */
export function batchBookDays(days: LibraryDay[], maxDays = 120): LibraryDay[][] {
  const out: LibraryDay[][] = [];
  for (let i = 0; i < days.length; i += maxDays) out.push(days.slice(i, i + maxDays));
  return out;
}

// ---------- The day note's Read lines ----------

const escapeMd = (s: string) => s.replace(/([\\[\]*_`<>])/g, "\\$1");
const unescapeMd = (s: string) => s.replace(/\\(.)/g, "$1");

/** "- [Dune](https://www.goodreads.com/book/show/44767458) · Frank Herbert · ★★★★" */
function line(b: DayBook): string {
  return `- [${escapeMd(b.title)}](https://www.goodreads.com/book/show/${b.id})${b.author ? ` · ${escapeMd(b.author)}` : ""}${b.rating ? ` · ${"★".repeat(b.rating)}` : ""}`;
}

const LINE = /^- \[((?:\\.|[^\]\\])*)\]\(https:\/\/www\.goodreads\.com\/book\/show\/(\d+)\)(?: · ((?:\\.|[^·])*?))?(?: · (★{1,5}))?\s*$/;

/** A line the import wrote, read back; null for anything else. */
function readLine(l: string, want: boolean): DayBook | null {
  const m = LINE.exec(l);
  if (!m) return null;
  return { id: m[2], title: unescapeMd(m[1]), author: m[3] ? unescapeMd(m[3].trim()) : "", rating: m[4] ? m[4].length : 0, ...(want ? { want: true } : {}) };
}

const isHeading = (l: string) => /^#{1,6} /.test(l);

/** The import's two sections: where each sits in a day note (recipes.ts's order, then the YouTube import's sections). */
const SECTIONS = [
  { want: false, heading: READ_HEADING, is: /^#{1,6} Read\s*$/i, after: /^#{1,6} (Played|Liked and saved|Posted|Watched on YouTube|Listened on YouTube Music)\s*$/i },
  { want: true, heading: SAVED_HEADING, is: /^#{1,6} Liked and saved\s*$/i, after: /^#{1,6} (Posted|Watched on YouTube|Listened on YouTube Music)\s*$/i },
];
type Section = (typeof SECTIONS)[number];

/** Where a section sits, as line indexes [heading, end), or null. */
function sectionAt(lines: string[], sec: Section): [number, number] | null {
  const start = lines.findIndex((l) => sec.is.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isHeading(lines[end])) end++;
  return [start, end];
}

/** The books the import put in a body: finished ones under Read, to-read ones under Liked and saved. */
export function readImportedBooks(body: string): DayBook[] {
  const lines = body.split("\n");
  return SECTIONS.flatMap((sec) => {
    const at = sectionAt(lines, sec);
    return at ? lines.slice(at[0] + 1, at[1]).map((l) => readLine(l, sec.want)).filter((b): b is DayBook => !!b) : [];
  });
}

/**
 * A book's title for matching across Goodreads' own pages: lower case, the
 * series in brackets dropped ("Dune (Dune #1)" and "Dune (Dune, #1)" are
 * one book), punctuation and spacing ignored.
 */
export function bookKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\([^)]*#[^)]*\)\s*$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const sameTitle = (a: string, b: string) => bookKey(a) === bookKey(b);

/**
 * `body` with one section holding `books` (the import's lines) first, then
 * whatever else was there that isn't one of those books again.
 */
function withSection(body: string, sec: Section, books: DayBook[]): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = sectionAt(lines, sec);
  const others = at
    ? lines.slice(at[0] + 1, at[1]).filter((l) => {
        if (!l.trim() || readLine(l, sec.want)) return false;
        // The run's own line for a book the import has: one line is enough.
        const t = /^- (?:[\w ]+: )?\[((?:\\.|[^\]\\])*)\]/.exec(l)?.[1];
        return !(t && books.some((b) => sameTitle(unescapeMd(t), b.title)));
      })
    : [];
  if (!at && !books.length) return body;
  const section = books.length || others.length ? [sec.heading, ...books.map(line), ...others] : [];
  let out: string[];
  if (at) out = [...lines.slice(0, at[0]), ...section, ...(at[1] < lines.length ? [""] : []), ...lines.slice(at[1])];
  else {
    const before = lines.findIndex((l) => sec.after.test(l));
    out = before < 0 ? [...lines, "", ...section] : [...lines.slice(0, before), "", ...section, "", ...lines.slice(before)];
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** `body` with both sections holding these books. */
function withBooks(body: string, books: DayBook[]): string {
  return SECTIONS.reduce((next, sec) => withSection(next, sec, books.filter((b) => !!b.want === sec.want)), body);
}

export interface BookMergeResult {
  body: string;
  /** Books this file adds that the note didn't have (finished and to-read). */
  added: number;
  /** Of those, to-read books. */
  added_to_read: number;
  /** Finished books from the import, after the merge: books_finished_day. */
  finished: number;
  books: DayBook[];
  changed: boolean;
}

const keyOf = (b: DayBook) => `${b.want ? "w" : "r"}:${b.id}`;

/**
 * A day note's body with `incoming` folded into its sections. A book
 * already there (by Goodreads id and section) is kept, with a newer rating
 * or title if the file has one, so the same file again changes nothing.
 * Everything else in the note is left as it was.
 */
export function mergeBooks(body: string, incoming: DayBook[]): BookMergeResult {
  const have = readImportedBooks(body);
  const byId = new Map(have.map((b) => [keyOf(b), { ...b }]));
  let added = 0;
  let addedToRead = 0;
  for (const b of incoming) {
    const old = byId.get(keyOf(b));
    if (!old) {
      byId.set(keyOf(b), { ...b });
      added++;
      if (b.want) addedToRead++;
      continue;
    }
    if (b.rating) old.rating = b.rating;
    if (b.title) old.title = b.title;
    if (b.author) old.author = b.author;
  }
  const books = [...byId.values()];
  const next = withBooks(body, books);
  // Compared with the note as the import would write it unchanged, so stray spacing alone isn't a change.
  return { body: next, added, added_to_read: addedToRead, finished: books.filter((b) => !b.want).length, books, changed: next !== withBooks(body, have) };
}

/**
 * What a Life log run saves for a day, with the import's lines from the
 * note it replaces put back. The run's own lines in those sections stay,
 * except one for a book the import already lists. A note with no imported
 * books is saved exactly as the run wrote it.
 */
export function keepBooks(previous: string, next: string): string {
  const kept = readImportedBooks(previous);
  return kept.length ? withBooks(next, kept) : next;
}

/** "Finished Dune", "Finished 3 books", or for to-read only "Dune to read", "3 books to read". */
export function booksSummary(books: DayBook[]): string {
  const done = books.filter((b) => !b.want);
  if (done.length) return done.length === 1 ? `Finished ${done[0].title}` : `Finished ${done.length} books`;
  return books.length === 1 ? `${books[0].title} to read` : `${books.length} books to read`;
}

/** A title the import wrote (so a later import may refresh it). */
export const BOOKS_TITLE = / · (Finished .+|.+ to read)$/;
