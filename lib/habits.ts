/**
 * Habits: each habit's days, from the `habit` entries Habitify, Todoist and
 * Loop write on Days (lib/day-types.ts: count 1 done, 0 not). For the
 * Library's Habits page (a year of dots, the current streak, the weekday
 * split) and Patterns' "habit done" factor. Habits aren't sealed: they're
 * entries like any other. Athena's own habits (source athena) come from
 * lib/own-habits.ts, which knows their due days.
 */
import { addDays } from "./dates";
import { q } from "./db";
import { ATHENA_SOURCE } from "./habit-rules";
import { ownMissedDays, ownSummaries, type OwnSummary } from "./own-habits";
import { ownerToday } from "./days";

export interface HabitDayMark {
  date: string;
  done: boolean;
  /** "skipped", "3 of 5 glasses". */
  note?: string;
}

export interface HabitSummary {
  name: string;
  source: string;
  /** Oldest first, only days the source said something about. */
  days: HabitDayMark[];
  done: number;
  /** Days in a row done, ending today or yesterday (today may not be ticked yet). */
  streak: number;
  longest: number;
  /** Share done per weekday, Monday first, of the days logged. null where nothing was logged. */
  weekdays: Array<number | null>;
  /** Athena's own habits: streak counts weeks for an N-a-week habit. */
  streak_unit?: "day" | "week";
  /** Athena's own habits only (lib/own-habits.ts): the habit, its words and today's count. */
  own?: OwnSummary["own"];
}

const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

/** One habit's marks summed up. `today` decides whether the streak is still running. */
export function summarise(name: string, source: string, marks: HabitDayMark[], today: string): HabitSummary {
  const days = [...marks].sort((a, b) => a.date.localeCompare(b.date));
  const doneOn = new Set(days.filter((d) => d.done).map((d) => d.date));
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    if (!d.done) {
      run = 0;
      prev = d.date;
      continue;
    }
    run = prev && addDays(prev, 1) === d.date && doneOn.has(prev) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d.date;
  }
  let streak = 0;
  for (let d = doneOn.has(today) ? today : addDays(today, -1); doneOn.has(d); d = addDays(d, -1)) streak++;
  const tally = Array.from({ length: 7 }, () => ({ done: 0, all: 0 }));
  for (const d of days) {
    const w = tally[weekday(d.date)];
    w.all++;
    if (d.done) w.done++;
  }
  return { name, source, days, done: doneOn.size, streak, longest, weekdays: tally.map((w) => (w.all ? Math.round((w.done / w.all) * 100) / 100 : null)) };
}

/** Every habit with entries in [from, to], most-done first. One habit from two sources stays two (they may differ). */
export async function habitSummaries(from: string, to: string, today: string): Promise<HabitSummary[]> {
  const rows = await q<{ date: string; title: string; source: string; count: number; note: string | null }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, title, source, count, note FROM day_entries
     WHERE kind = 'habit' AND date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL ORDER BY date`,
    [from, to],
  );
  const by = new Map<string, { name: string; source: string; marks: Map<string, HabitDayMark> }>();
  for (const r of rows) {
    // Athena's own habits are read from their schedule below, so a due day left unticked shows as missed.
    if (r.source === ATHENA_SOURCE) continue;
    const key = `${r.source}\u0000${r.title.toLowerCase()}`;
    const h = by.get(key) ?? { name: r.title, source: r.source, marks: new Map() };
    // Two entries on one day (a rerun with a new id): done wins.
    const was = h.marks.get(r.date);
    if (!was || (!was.done && r.count > 0)) h.marks.set(r.date, { date: r.date, done: r.count > 0, ...(r.note ? { note: r.note } : {}) });
    by.set(key, h);
  }
  const imported = [...by.values()].map((h) => summarise(h.name, h.source, [...h.marks.values()], today)).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
  // Athena's first, in the owner's order; archived ones last.
  const own = (await ownSummaries(from, to, today)).sort((a, b) => Number(!!a.own.archived_at) - Number(!!b.own.archived_at));
  return [...own, ...imported];
}

/** Per day: the share of habits done (0–1), for Patterns. Days with no habit logged are left out; an Athena habit's unticked due day counts as not done. */
export async function habitRates(from: string, to: string, today?: string): Promise<Map<string, number>> {
  const rows = await q<{ date: string; done: number; all: number }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, count(*) FILTER (WHERE count > 0)::int AS done, count(*)::int AS all FROM day_entries
     WHERE kind = 'habit' AND date BETWEEN $1::date AND $2::date AND archived_at IS NULL AND folded_into IS NULL GROUP BY date`,
    [from, to],
  );
  const tally = new Map(rows.map((r) => [r.date, { done: r.done, all: r.all }]));
  for (const m of await ownMissedDays(from, to, today ?? (await ownerToday()))) {
    const t = tally.get(m.date) ?? { done: 0, all: 0 };
    t.all++;
    tally.set(m.date, t);
  }
  return new Map([...tally].map(([d, t]) => [d, t.all ? t.done / t.all : 0]));
}
