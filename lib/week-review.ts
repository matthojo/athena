/**
 * The week (or month) in review's server read: GET /api/week-review?from&to&tz.
 * Three things the app can't work out from what it already loads
 * (docs/notes/week-review-build.md):
 *
 *  - goals: which goals moved on in the period, from the goal_progress log
 *    (0041). Each change to a goal's progress adds a row (upsertGoal); the
 *    migration seeded every goal's value once, so there's always a baseline.
 *  - seen: calendar events in the period with a named person at a place
 *    (edges from the event to a person and to a place, or the event's own
 *    person). The owner counts these as seeing someone, beside logged
 *    in-person catch-ups (decision 2026-11-08).
 *  - known_places: the names of places visited in the eight weeks before
 *    the period, so the app can mark a first visit.
 */

import { addDays, isValidDate } from "./dates";
import { AthenaInputError, getOwnerTimeZone, q } from "./db";
import { placeDays } from "./places-visits";

export interface GoalMove {
  id: string;
  title: string;
  target: string;
  status: "active" | "done" | "dropped";
  /** Progress before the period began (or when the goal was first logged in it). */
  was: number;
  /** Progress at the end of the period (or now, for a period still going). */
  now: number;
}

export interface SeenEvent {
  id: string;
  title: string;
  /** The day it happened, in the owner's zone. */
  date: string;
  people: { id: string; name: string }[];
  place: string;
}

export interface WeekReviewExtras {
  from: string;
  to: string;
  goals: GoalMove[];
  seen: SeenEvent[];
  known_places: string[];
}

/** How far back a place counts as known. */
export const KNOWN_PLACE_DAYS = 56;

/**
 * What a goal's log says about a period: the value before it began, the first
 * value logged inside it and the last. Moved on when the last beats the
 * baseline: the value before, else the first inside (a goal added, or the log
 * seeded, during the period starts from there). Pure, for the tests.
 */
export function goalMovement(log: { before: number | null; first_in: number | null; last: number | null }): { was: number; now: number } | null {
  const was = log.before ?? log.first_in;
  if (was === null || log.last === null) return null;
  return log.last > was ? { was, now: log.last } : null;
}

function zoneOr(tz: string | null | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** Goals that moved on between the start of `from` and the end of `to`, in `tz`. Archived goals are left out. */
export async function goalMoves(from: string, to: string, tz: string): Promise<GoalMove[]> {
  const rows = await q<{ id: string; title: string; target: string; status: GoalMove["status"]; before: number | null; first_in: number | null; last: number | null }>(
    `WITH bounds AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS start, ($2::date + 1)::timestamp AT TIME ZONE $3 AS stop)
     SELECT g.id, g.title, g.target, g.status,
       (SELECT p.progress FROM goal_progress p, bounds b WHERE p.goal_id = g.id AND p.at < b.start ORDER BY p.at DESC LIMIT 1) AS before,
       (SELECT p.progress FROM goal_progress p, bounds b WHERE p.goal_id = g.id AND p.at >= b.start AND p.at < b.stop ORDER BY p.at ASC LIMIT 1) AS first_in,
       (SELECT p.progress FROM goal_progress p, bounds b WHERE p.goal_id = g.id AND p.at < b.stop ORDER BY p.at DESC LIMIT 1) AS last
       FROM goals g WHERE g.archived_at IS NULL`,
    [from, to, tz],
  );
  const out: GoalMove[] = [];
  for (const r of rows) {
    const m = goalMovement(r);
    if (m) out.push({ id: r.id, title: r.title, target: r.target, status: r.status, ...m });
  }
  return out.sort((a, b) => b.now - b.was - (a.now - a.was) || a.title.localeCompare(b.title));
}

/** One-off events in the period with at least one named person and a place. Declined invites, birthdays and deadlines are left out. */
export async function seenEvents(from: string, to: string, tz: string): Promise<SeenEvent[]> {
  const rows = await q<{ id: string; title: string; date: string; people: { id: string; name: string }[] | null; place: string | null }>(
    `SELECT ev.id, ev.title, to_char(COALESCE((ev.starts_at AT TIME ZONE $3)::date, ev.date), 'YYYY-MM-DD') AS date,
       (SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.id) FROM people p
         WHERE p.archived_at IS NULL AND (p.id = ev.person_id
           OR p.id IN (SELECT e.target_id FROM edges e WHERE e.source_type = 'event' AND e.source_id = ev.id AND e.target_type = 'person')
           OR p.id IN (SELECT e.source_id FROM edges e WHERE e.target_type = 'event' AND e.target_id = ev.id AND e.source_type = 'person'))) AS people,
       (SELECT pl.name FROM places pl
         WHERE pl.archived_at IS NULL AND (
           pl.id IN (SELECT e.target_id FROM edges e WHERE e.source_type = 'event' AND e.source_id = ev.id AND e.target_type = 'place')
           OR pl.id IN (SELECT e.source_id FROM edges e WHERE e.target_type = 'event' AND e.target_id = ev.id AND e.source_type = 'place'))
         ORDER BY pl.id LIMIT 1) AS place
       FROM events ev
      WHERE ev.archived_at IS NULL AND ev.recurrence = 'none' AND ev.rsvp <> 'declined'
        AND ev.kind NOT IN ('birthday', 'anniversary', 'deadline')
        AND COALESCE((ev.starts_at AT TIME ZONE $3)::date, ev.date) BETWEEN $1::date AND $2::date`,
    [from, to, tz],
  );
  return rows
    .filter((r) => r.people?.length && r.place)
    .map((r) => ({ id: r.id, title: r.title, date: r.date, people: r.people!, place: r.place! }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Names of places visited in the eight weeks before `from`. */
export async function knownPlaces(from: string): Promise<string[]> {
  const days = await placeDays(addDays(from, -KNOWN_PLACE_DAYS), addDays(from, -1));
  const names = new Set<string>();
  for (const d of days.values()) for (const p of d.places) names.add(p.name);
  return [...names].sort();
}

export async function weekReviewExtras(from: string, to: string, tz?: string | null): Promise<WeekReviewExtras> {
  if (!isValidDate(from) || !isValidDate(to) || to < from) throw new AthenaInputError("Give from and to as dates, with from first");
  if (addDays(from, 45) < to) throw new AthenaInputError("A review covers a month at most");
  const zone = zoneOr(tz, await getOwnerTimeZone());
  const [goals, seen, known] = await Promise.all([goalMoves(from, to, zone), seenEvents(from, to, zone), knownPlaces(from).catch(() => [] as string[])]);
  return { from, to, goals, seen, known_places: known };
}
