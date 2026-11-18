/**
 * The same meeting, saved twice. A collection knows a calendar event by its
 * id alone (collected_items: source, external_id), so one meeting that
 * arrives under two ids became two events: it's on two of the owner's
 * calendars, two collections both read it, or one occurrence of a series
 * was edited and the calendar gave it a new id. Home then offered "Prepare
 * notes" for it twice (12 Nov).
 *
 * Two synced events are the same meeting when they have the same title and
 * start at the same instant (or are all-day on the same date). Titles are
 * sealed, so the candidates are found by time and compared here.
 */
import { q } from "./db";

/** Titles compared as a person reads them: case, spacing and a trailing full stop don't matter. */
export const titleKey = (title: string): string => title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");

/** A start as its instant. The database gives a Date where the type says string, so both are taken. */
const instant = (at: string | Date | null | undefined): number => (at ? new Date(at).getTime() : NaN);

type Meeting = { title: string; starts_at: string | Date | null };

export const sameMeeting = (a: Meeting, b: Meeting): boolean => {
  const at = instant(a.starts_at);
  return Number.isFinite(at) && at === instant(b.starts_at) && titleKey(a.title) !== "" && titleKey(a.title) === titleKey(b.title);
};

/**
 * A live, synced event that is this same meeting, the oldest there is.
 * `not` leaves one event out (the one being saved); with `olderThan`, only
 * a twin made before that event counts, so of two duplicates the first one
 * saved is always the one kept, whichever is looked at.
 */
export async function eventTwin(input: { title: string; starts_at?: string | null; date?: string | null; not?: string; olderThan?: string }): Promise<{ id: string } | null> {
  const key = titleKey(input.title);
  if (!key || (!input.starts_at && !input.date)) return null;
  const rows = await q<{ id: string; title: string }>(
    `SELECT e.id, e.title FROM events e
      WHERE e.archived_at IS NULL AND e.source IS NOT NULL AND e.recurrence = 'none'
        AND (($1::timestamptz IS NOT NULL AND e.starts_at = $1::timestamptz) OR ($1::timestamptz IS NULL AND e.starts_at IS NULL AND e.date = $2::date))
        AND ($3::uuid IS NULL OR e.id <> $3::uuid)
        AND ($4::uuid IS NULL OR e.created_at < (SELECT created_at FROM events WHERE id = $4::uuid))
      ORDER BY e.created_at, e.id LIMIT 20`,
    [input.starts_at ?? null, input.starts_at ? null : (input.date ?? null), input.not ?? null, input.olderThan ?? null],
  );
  return rows.find((r) => titleKey(r.title) === key) ?? null;
}
