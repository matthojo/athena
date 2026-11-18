/**
 * Goodreads' "Export library" CSV, into Days (lib/goodreads-csv.ts has the
 * parser; lib/day-imports.ts what a book becomes).
 *
 * The app parses the file on the device and sends the books by day, in
 * batches. A finished book is a read entry on the day it was finished; a
 * to-read book is a saved entry on the day it was added. Every book also
 * goes into Watch & read with its stars.
 */
import { AthenaInputError } from "../../../lib/db";
import { isValidDate } from "../../../lib/dates";
import { updateConnectorSecrets, type Connector } from "../../../lib/connectors";
import { bookKey, type DayBook, type LibraryDay } from "../../../lib/goodreads-csv";
import { goodreadsEntries } from "../../../lib/day-imports";
import { historyTarget, importToDays, type FoldResult, type HistoryTarget } from "./youtube-history";
import { syncWatchRead } from "../../../lib/watch-read-sync";

export const MAX_DAYS = 200;
export const MAX_BOOKS = 1000;
/** What the import fills (before the account suffix); the Life log's own name for it. */
export const BOOKS_METRIC = "books_finished_day";

/** The same Life log as YouTube's import, with the books metric. */
export async function libraryTarget(account: Connector): Promise<HistoryTarget> {
  const t = await historyTarget(account);
  return { ...t, metric: t.metric.replace(/^videos_watched_day/, BOOKS_METRIC) };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The request's days, checked: real dates, Goodreads ids, sensible sizes. */
export function readBookDays(raw: unknown): LibraryDay[] {
  if (!Array.isArray(raw) || !raw.length) throw new AthenaInputError("days: send at least one day");
  if (raw.length > MAX_DAYS) throw new AthenaInputError(`days: at most ${MAX_DAYS} per request`);
  const seen = new Set<string>();
  let total = 0;
  return raw.map((d) => {
    const day = (d as { day?: unknown })?.day;
    const books = (d as { books?: unknown })?.books;
    if (typeof day !== "string" || !isValidDate(day)) throw new AthenaInputError("days: each needs a day (YYYY-MM-DD)");
    if (seen.has(day)) throw new AthenaInputError(`days: ${day} is in this request twice`);
    seen.add(day);
    if (!Array.isArray(books) || !books.length) throw new AthenaInputError(`days: ${day} has no books`);
    total += books.length;
    if (total > MAX_BOOKS) throw new AthenaInputError(`days: at most ${MAX_BOOKS} books per request`);
    return {
      day,
      books: books.map((b): DayBook => {
        const o = (b ?? {}) as Record<string, unknown>;
        if (typeof o.id !== "string" || !/^\d{1,12}$/.test(o.id)) throw new AthenaInputError(`days: ${day} has a book without a Goodreads id`);
        const title = str(o.title, 300);
        if (!title) throw new AthenaInputError(`days: ${day} has a book without a title`);
        const rating = typeof o.rating === "number" && Number.isInteger(o.rating) && o.rating >= 1 && o.rating <= 5 ? o.rating : 0;
        return { id: o.id, title, author: str(o.author, 120), rating: o.want === true ? 0 : rating, ...(o.want === true ? { want: true } : {}) };
      }),
    };
  });
}

export interface LibraryResult extends FoldResult {
  /** Books Days didn't have before. */
  added: number;
  /** Of those, to-read books (under Liked and saved). */
  added_to_read: number;
  /** Books put in Watch & read, and ones there already that were filled in or re-rated. */
  watch_read: { created: number; updated: number };
}

/** Write a batch of days as Day entries, and every book into Watch & read. Safe to repeat. */
export async function importBooks(target: HistoryTarget, days: LibraryDay[], opts: { metrics: boolean; now?: Date }): Promise<LibraryResult> {
  const { outcomes, ...r } = await importToDays(target, days, goodreadsEntries, {
    metric: opts.metrics ? target.metric : null,
    metricValue: (d) => d.books.filter((b) => !b.want).length,
    from: "goodreads-library",
    now: opts.now,
  });
  const created = outcomes.filter((o) => o.action === "created");
  const added = created.length;
  const addedToRead = created.filter((o) => o.entry.kind === "saved").length;
  // Every book also lands in Watch & read with its stars: finished on its day, to-read as up next.
  const synced = await syncWatchRead(
    days.flatMap((d) =>
      d.books.map((b) => ({
        kind: "book" as const,
        title: b.title,
        maker: b.author || undefined,
        status: b.want ? ("queued" as const) : ("done" as const),
        rating: b.rating || undefined,
        at: d.day,
        url: `https://www.goodreads.com/book/show/${b.id}`,
        external_id: `book:${b.id}`,
        source: "goodreads" as const,
      })),
    ),
    { collection: target.source, now: opts.now },
  );
  const watch_read = { created: synced.filter((x) => x.action === "created").length, updated: synced.filter((x) => x.action === "updated").length };
  return { ...r, added, added_to_read: addedToRead, watch_read };
}

/** At most this many titles remembered per account. */
const MAX_REMEMBERED = 20_000;

/**
 * The books the import put in the Life log, by title key → day, kept sealed
 * with the account's other memory (feeds-goodreads.ts `goodreadsImported`
 * for finished books, `goodreadsWanted` for to-read). The Life log's shelf
 * tool leaves these out of those shelves, so a run doesn't log a book again
 * on the day it first notices it.
 */
export async function rememberImportedBooks(connectorId: string, days: LibraryDay[]): Promise<void> {
  await updateConnectorSecrets(connectorId, (s) => {
    const w = s as { goodreadsImported?: Record<string, string>; goodreadsWanted?: Record<string, string> };
    const read = { ...w.goodreadsImported };
    const want = { ...w.goodreadsWanted };
    for (const d of days) for (const b of d.books) (b.want ? want : read)[bookKey(b.title)] = d.day;
    const cap = (m: Record<string, string>) => {
      const keys = Object.keys(m);
      return keys.length > MAX_REMEMBERED ? Object.fromEntries(keys.slice(-MAX_REMEMBERED).map((k) => [k, m[k]])) : m;
    };
    w.goodreadsImported = cap(read);
    w.goodreadsWanted = cap(want);
  });
}
