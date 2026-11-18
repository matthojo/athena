/**
 * Home's memory: the shapes shared by the server (lib/day-firsts.ts,
 * lib/day-prefs.ts, GET /api/days/firsts and /api/days/memories) and the
 * app (app/src/db/memories-app.ts). Imports nothing.
 */

export type DayFirstKind = "place" | "person" | "run" | "book";

export interface DayFirst {
  kind: DayFirstKind;
  /** The day of the first time. */
  date: string;
  /** The place, the person, the book; for a run, "run". */
  name: string;
  /** Times since: days back at the place, catch-ups since. */
  since?: number;
  /** A run's distance, one decimal. */
  km?: number;
}

export interface MemoryDay {
  date: string;
  /** People you saw or called that day (catch-ups in person, meetings and calls). */
  people: Array<{ name: string; archived: boolean }>;
  /** True when every catch-up that day was a call. */
  call?: boolean;
  /** The day's places line ("Work, lunch at Dishoom, then Hampstead Heath"), when there is one. */
  line?: string;
  /** Named stops, not home or work, in the order of the day. */
  places: string[];
}

export interface MemoryContext {
  around: string;
  firsts: DayFirst[];
  days: MemoryDay[];
  /** The owner's "Never nudge about" topics, lower case. */
  never: string[];
}

export interface MemoryPrefs {
  on: boolean;
  /** Days (YYYY-MM-DD) hidden from memories for good, oldest first. */
  hidden: string[];
}
