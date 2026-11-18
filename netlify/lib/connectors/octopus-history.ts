/**
 * How Octopus's meter history is read back: a month at a time (Octopus's
 * consumption tool takes at most 31 days), newest first, to OCTOPUS_HISTORY_MONTHS
 * back or the first month with no readings, whichever comes first.
 *
 * Two callers share these steps:
 *  - the Life log run (money-sync.ts syncMeter): as many months as fit before
 *    its deadline, its place kept in settings `money_backfill`;
 *  - the background history load on connect, Edit and "Load history again"
 *    (backfill.ts, octopusBackfill in octopus-direct.ts): a month a page, its
 *    place kept in `history_load.<id>`.
 * Both are resumable, and the days they save replace what's there, so
 * reading a month twice changes nothing.
 *
 * Pure: the reading and saving are passed in, so the tests need no network
 * or database.
 */
import { addDays } from "../../../lib/dates";
import type { HomeDayFigures } from "../../../lib/money";

/** Two years: rolling 12 months against the 12 before, and the same month last year, both priced. */
export const OCTOPUS_HISTORY_MONTHS = 24;
/** Days a step reads: under the tool's 31. */
export const STEP_DAYS = 30;

/** The same day `n` months before (the 31st becomes the month's last day). */
export function monthsBefore(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
  return `${back.toISOString().slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The oldest day history goes back to from `today`. */
export const historyFloor = (today: string): string => monthsBefore(today, OCTOPUS_HISTORY_MONTHS);

/** Reads [after, before) as days by date. */
export type ReadDays = (after: string, before: string) => Promise<Map<string, HomeDayFigures>>;

export interface MonthStep {
  days: Map<string, HomeDayFigures>;
  /** The oldest day with a reading in this step. */
  oldest?: string;
  /** Where the next step ends; none when this one came back empty or reached the floor. */
  next?: string;
}

/** One step back from `before` (exclusive): STEP_DAYS, or to the floor. */
export async function monthStep(before: string, today: string, read: ReadDays): Promise<MonthStep> {
  const floor = historyFloor(today);
  if (before <= floor) return { days: new Map() };
  const start = addDays(before, -STEP_DAYS) < floor ? floor : addDays(before, -STEP_DAYS);
  const days = await read(start, before);
  const oldest = [...days.keys()].sort()[0];
  return { days, ...(oldest ? { oldest } : {}), ...(days.size && start > floor ? { next: start } : {}) };
}

/** Where a run's backfill has got to (settings `money_backfill`). */
export interface StepState {
  /** Everything before this day is still to read. */
  before?: string;
  done?: boolean;
}

/**
 * As many steps as fit before the deadline, from where the last run stopped
 * (or `first`, the oldest day the run's recent read covers). Always takes at
 * least one step when there's time at the start. Saves after every step, so
 * a run cut off part-way carries on from there.
 */
export async function stepBack(
  state: StepState,
  opts: { today: string; first: string; deadline: number; clock?: () => number; read: ReadDays; save: (days: Map<string, HomeDayFigures>, state: StepState) => Promise<number> },
): Promise<{ state: StepState; months: number; changed: number }> {
  const clock = opts.clock ?? Date.now;
  let s: StepState = { ...state };
  let months = 0;
  let changed = 0;
  while (!s.done && clock() <= opts.deadline) {
    const step = await monthStep(s.before ?? opts.first, opts.today, opts.read);
    s = step.next ? { before: step.next } : { done: true };
    changed += await opts.save(step.days, s);
    months++;
  }
  return { state: s, months, changed };
}
