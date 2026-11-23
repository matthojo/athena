import { clockOfDay, uses12Hour } from "./clock";
/**
 * Which of today's dates Home's headline leads with, as the day goes on.
 *
 * The headline used to name the day's first event all day: "Hospital
 * appointment at 09:00 is today" was still there in the afternoon (12 Nov).
 * Now it's the next one that hasn't happened: a timed event until half an
 * hour after it starts, then the one after it; an all-day date when no timed
 * one is left to come; and nothing once the day's dates are behind you, so
 * the sentence moves on to what's due and what's new.
 */
export interface HeadlineItem {
  event: { title: string; kind: string };
  days_until: number;
  /** "HH:MM", or null for all-day. */
  time: string | null;
  starts_at: string | null;
}

/** A timed event still leads for this long after it starts: you may be in it. */
export const STARTED_GRACE_MS = 30 * 60_000;

export function headlineEvent<T extends HeadlineItem>(events: T[], now: Date): T | null {
  // Birthdays on the day belong to the banner above Home's cards (home-personal.ts).
  const today = events.filter((o) => o.days_until === 0 && o.event.kind !== "birthday");
  const at = (o: T) => (o.starts_at ? new Date(o.starts_at).getTime() : NaN);
  const timed = today.filter((o) => Number.isFinite(at(o))).sort((a, b) => at(a) - at(b));
  const next = timed.find((o) => at(o) + STARTED_GRACE_MS > now.getTime());
  if (next) return next;
  return today.find((o) => !Number.isFinite(at(o))) ?? null;
}

/** The start of the headline's sentence: "Design review at 15:00 is" ("at 3:00 pm" on a 12-hour device). */
export const headlineEventWords = (o: HeadlineItem | null, hour12 = uses12Hour()): string | null => (o ? `${o.event.title}${o.time ? ` at ${clockOfDay(o.time, hour12)}` : ""} is` : null);
