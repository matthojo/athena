/**
 * Watch & read: the list of books, films, TV shows, articles, videos,
 * podcasts, music and games to get to (it was the reading list, and it's
 * still the `reading_items` table). The words for it live here, shared by
 * the app and the server (Ask's receipts), so they never drift apart.
 *
 * The stored status is the same for every kind: queued (not started),
 * reading (in progress) and done (finished). Only the words change with the
 * kind: a film is "To watch · Watching · Watched", an album "To listen ·
 * Listening · Listened". A list that mixes kinds uses the neutral words
 * ("Up next · In progress · Finished").
 *
 * No imports: the app bundles this file too.
 */

/** In the order the app offers them. "tv" is a TV show; "music" an album or a song. */
export const READING_KINDS = ["book", "film", "tv", "article", "video", "podcast", "music", "game", "paper", "other"] as const;
export type ReadingKind = (typeof READING_KINDS)[number];

export const READING_STATUSES = ["queued", "reading", "done"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

/** What the owner sees the list called. */
export const WATCH_READ = "Watch & read";

type StatusWords = Readonly<Record<ReadingStatus, string>>;

const READ: StatusWords = { queued: "To read", reading: "Reading", done: "Read" };
const WATCH: StatusWords = { queued: "To watch", reading: "Watching", done: "Watched" };
const LISTEN: StatusWords = { queued: "To listen", reading: "Listening", done: "Listened" };
const PLAY: StatusWords = { queued: "To play", reading: "Playing", done: "Played" };
/** For a mixed list (group headings) and for "Other". */
export const NEUTRAL_STATUS: StatusWords = { queued: "Up next", reading: "In progress", done: "Finished" };

export interface KindWords {
  /** "Film", "TV show". */
  label: string;
  /** "To watch", "Watching", "Watched". */
  status: StatusWords;
  /** What the author field is called for this kind ("Director", "Artist"); null hides it. */
  maker: string | null;
}

export const KIND_WORDS: Readonly<Record<ReadingKind, KindWords>> = {
  book: { label: "Book", status: READ, maker: "By" },
  film: { label: "Film", status: WATCH, maker: "Director" },
  // A show's "by" is rarely known or useful; progress ("Up to S2") goes in the notes.
  tv: { label: "TV show", status: WATCH, maker: null },
  article: { label: "Article", status: READ, maker: "By" },
  video: { label: "Video", status: WATCH, maker: "Channel" },
  podcast: { label: "Podcast", status: LISTEN, maker: "Show" },
  music: { label: "Music", status: LISTEN, maker: "Artist" },
  game: { label: "Game", status: PLAY, maker: "Studio" },
  paper: { label: "Paper", status: READ, maker: "By" },
  other: { label: "Other", status: NEUTRAL_STATUS, maker: "By" },
};

/** The kind's words, falling back to the neutral ones for a kind this build doesn't know. */
export const kindWords = (kind: string): KindWords => KIND_WORDS[kind as ReadingKind] ?? KIND_WORDS.other;

// ---------- Progress: how far through it you are (0042) ----------

/**
 * A position is pages (a book), episodes (a show, a podcast) or a percent
 * (anything, an ebook's own %). Pages and episodes can have a total; a
 * percent never does. No progress means only the status is known.
 */
export const PROGRESS_UNITS = ["page", "episode", "percent"] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

export interface ReadingProgress {
  unit: ProgressUnit;
  /** Pages read, episodes seen, or the percent (0–100). */
  done: number;
  /** Out of how many pages or episodes; null when unknown, and always null for a percent. */
  total: number | null;
}

/** What the sheet offers first for a kind: pages for books and papers, episodes for shows and podcasts, a percent for the rest. */
export const defaultProgressUnit = (kind: string): ProgressUnit => (kind === "book" || kind === "paper" ? "page" : kind === "tv" || kind === "podcast" ? "episode" : "percent");

const MAX_COUNT = 100_000;
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : null);

/**
 * Read progress from the API, MCP, Ask or the app. undefined: not given
 * (leave it). null: clear it. Otherwise a valid position, or a message
 * saying what's wrong (the caller turns it into a 400).
 */
export function parseProgress(raw: unknown): ReadingProgress | null | undefined | { problem: string } {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { problem: "progress should be { unit, done, total } or null" };
  const r = raw as Record<string, unknown>;
  const unit = r.unit;
  if (!(PROGRESS_UNITS as readonly unknown[]).includes(unit)) return { problem: "progress.unit should be 'page', 'episode' or 'percent'" };
  const done = whole(r.done);
  if (done === null || done < 0 || done > MAX_COUNT) return { problem: "progress.done should be a whole number, 0 or more" };
  if (unit === "percent") {
    if (done > 100) return { problem: "A percent goes up to 100" };
    if (r.total !== undefined && r.total !== null) return { problem: "A percent has no total" };
    return { unit, done, total: null };
  }
  if (r.total === undefined || r.total === null || r.total === "") return { unit: unit as ProgressUnit, done, total: null };
  const total = whole(r.total);
  if (total === null || total < 1 || total > MAX_COUNT) return { problem: "progress.total should be a whole number, 1 or more" };
  if (done > total) return { problem: `${done} is more than the total of ${total}` };
  return { unit: unit as ProgressUnit, done, total };
}

/** From the stored columns; null when nothing's kept or the row doesn't make sense. */
export function progressFromColumns(unit: unknown, done: unknown, total: unknown): ReadingProgress | null {
  if (unit === null || unit === undefined) return null;
  const p = parseProgress({ unit, done, total });
  return p && !("problem" in p) ? p : null;
}

/** 0–1 for a bar: finished is full, a percent or a count with a total is its share, a count with no total is unknown (null). */
export function progressFraction(p: ReadingProgress | null | undefined, status?: ReadingStatus): number | null {
  if (status === "done") return 1;
  if (!p) return status === "queued" ? 0 : null;
  if (p.unit === "percent") return p.done / 100;
  return p.total ? Math.min(1, p.done / p.total) : null;
}

/** "45%", "Page 120 of 300", "Episode 4 of 8", "Page 120". */
export function progressWords(p: ReadingProgress): string {
  if (p.unit === "percent") return `${p.done}%`;
  const noun = p.unit === "page" ? "Page" : "Episode";
  return p.total ? `${noun} ${p.done} of ${p.total}` : `${noun} ${p.done}`;
}
