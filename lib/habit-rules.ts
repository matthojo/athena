/**
 * The owner's own habits (migration 0036, lib/own-habits.ts): when one is
 * due, how a tick and a target are written, streaks that skip days a habit
 * isn't due, and matching a spoken name for the Shortcut. Shared by the
 * server and the PWA, so it imports only lib/dates.
 *
 * A habit is due on chosen weekdays (`days`, a bitmask, Monday = 1 … Sunday
 * = 64) or N times a week (`per_week`, any day counts). A tick is a `habit`
 * day entry with source `athena`: count 1 done, 0 not yet; a target's
 * progress is in its note ("3 of 8 glasses"), the same words Habitify uses.
 */
import { addDays } from "./dates";

export const ATHENA_SOURCE = "athena";
export const EVERY_DAY = 127;
export const WEEKDAYS_ONLY = 31;
export const WEEKENDS_ONLY = 96;
export const MAX_HABITS = 40;
export const MAX_NAME = 60;
export const MAX_TARGET = 1000;
/** Icons a habit can wear (the app's line icons). */
export const HABIT_ICONS = ["check", "book", "cup", "leaf", "heart", "bed", "pen", "music", "target", "star", "paw", "sparkle"] as const;
export type HabitIcon = (typeof HABIT_ICONS)[number];
export const isHabitIcon = (v: unknown): v is HabitIcon => typeof v === "string" && (HABIT_ICONS as readonly string[]).includes(v);

export interface OwnHabit {
  id: string;
  name: string;
  /** Weekdays it's due, Monday = 1 … Sunday = 64. Ignored when per_week is set. */
  days: number;
  /** N times a week, on any days. */
  per_week: number | null;
  /** A count for the day ("8" glasses). null: done or not. */
  target: number | null;
  unit: string | null;
  icon: HabitIcon;
  position: number;
  /** The first day it counts from. */
  starts_on: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type HabitRule = Pick<OwnHabit, "days" | "per_week" | "starts_on">;

/** Monday 0 … Sunday 6. */
export const weekdayOf = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
export const weekStart = (date: string) => addDays(date, -weekdayOf(date));
const bit = (date: string) => 1 << weekdayOf(date);

/** A weekday habit is due on its days; a weekly one could be done on any day. Never before it starts. */
export function isDueOn(h: HabitRule, date: string): boolean {
  if (date < h.starts_on) return false;
  return h.per_week ? true : (h.days & bit(date)) !== 0;
}

/** Done this week up to and including `date`, for an N-a-week habit. */
export function doneThisWeek(done: Set<string>, date: string): number {
  let n = 0;
  for (let d = weekStart(date); d <= addDays(weekStart(date), 6); d = addDays(d, 1)) if (done.has(d)) n++;
  return n;
}

/** Whether it belongs on today's list: a weekday habit on its days; a weekly one until the week's count is met (or it was ticked today). */
export function showsOn(h: HabitRule, date: string, done: Set<string>): boolean {
  if (!isDueOn(h, date)) return false;
  if (!h.per_week) return true;
  return done.has(date) || doneThisWeek(done, date) < h.per_week;
}

/** For the evening nudge: still undone today and today matters. A weekly habit only when the days left can't spare today. */
export function needsToday(h: HabitRule, date: string, done: Set<string>): boolean {
  if (!isDueOn(h, date) || done.has(date)) return false;
  if (!h.per_week) return true;
  const left = h.per_week - doneThisWeek(done, date);
  return left > 0 && left >= 7 - weekdayOf(date);
}

/** A whole week (Monday to Sunday) that has ended before `today` with fewer ticks than the weekly number: its undone days count as missed. */
export function shortWeek(h: HabitRule, date: string, done: Set<string>, today: string): boolean {
  if (!h.per_week) return false;
  const start = weekStart(date);
  return addDays(start, 6) < today && doneThisWeek(done, date) < h.per_week;
}

/** Of several habits a name could mean, the one due today; null when both or neither are. */
export function pickDue<T>(candidates: T[], due: (h: T) => boolean): T | null {
  const d = candidates.filter(due);
  return d.length === 1 ? d[0] : null;
}

export interface Streak {
  streak: number;
  longest: number;
  unit: "day" | "week";
}

/**
 * Days in a row, skipping days it isn't due (they neither break nor add),
 * ending today; today not done yet doesn't break it. A done day it wasn't
 * due adds one. A weekly habit counts weeks that met the number, and the
 * week in progress only once it's met.
 */
export function streakOf(h: HabitRule, done: Set<string>, today: string, until = today): Streak {
  const end = until < today ? until : today;
  if (h.per_week) {
    const met = (w: string) => doneThisWeek(done, w) >= h.per_week!;
    const first = weekStart(h.starts_on);
    let streak = 0;
    let w = weekStart(end);
    if (!met(w)) w = addDays(w, -7);
    for (; w >= first && met(w); w = addDays(w, -7)) streak++;
    let longest = 0;
    let run = 0;
    for (let x = first; x <= weekStart(end); x = addDays(x, 7)) {
      if (met(x)) longest = Math.max(longest, ++run);
      else if (x !== weekStart(end)) run = 0;
    }
    return { streak, longest, unit: "week" };
  }
  let streak = 0;
  for (let d = end; d >= h.starts_on; d = addDays(d, -1)) {
    if (done.has(d)) streak++;
    else if (isDueOn(h, d) && d !== today) break;
  }
  let longest = 0;
  let run = 0;
  for (let d = h.starts_on; d <= end; d = addDays(d, 1)) {
    if (done.has(d)) longest = Math.max(longest, ++run);
    else if (isDueOn(h, d) && d !== today) run = 0;
  }
  return { streak, longest, unit: "day" };
}

// ---------- ticks and targets ----------

const OF = /^(\d+) of (\d+)\b/;

/** The entry's note for a target: "3 of 8 glasses". */
export function progressNote(progress: number, target: number, unit: string | null): string {
  return `${progress} of ${target}${unit ? ` ${unit}` : ""}`;
}

/** How far a day's entry got: the note's count for a target, else 1 done / 0 not. No entry is 0. */
export function progressOf(entry: { count?: number; note?: string | null } | null | undefined, target: number | null): number {
  if (!entry) return 0;
  const m = entry.note?.match(OF);
  if (target && m) return Number(m[1]);
  if ((entry.count ?? 1) > 0) return target ?? 1;
  return 0;
}

/** Done when the count reaches the target (or, without one, when ticked). */
export const isDone = (progress: number, target: number | null) => progress >= (target ?? 1);

/** A tap: a plain habit toggles; a target counts up one, and a tap on a full one clears it. */
export function nextTap(progress: number, target: number | null): number {
  if (!target) return progress > 0 ? 0 : 1;
  return progress >= target ? 0 : progress + 1;
}

/** Clamp a set count to 0…MAX_TARGET (a target may be passed). */
export const clampProgress = (n: number) => Math.max(0, Math.min(MAX_TARGET, Math.round(Number.isFinite(n) ? n : 0)));

// ---------- words ----------

const SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Every day", "Weekdays", "Mon, Wed, Fri", "3 times a week". */
export function scheduleWords(h: Pick<OwnHabit, "days" | "per_week">): string {
  if (h.per_week) return h.per_week === 1 ? "Once a week" : h.per_week === 7 ? "Every day" : `${h.per_week} times a week`;
  if (h.days === EVERY_DAY) return "Every day";
  if (h.days === WEEKDAYS_ONLY) return "Weekdays";
  if (h.days === WEEKENDS_ONLY) return "Weekends";
  return SHORT.filter((_, i) => h.days & (1 << i)).join(", ");
}

// ---------- names (the Shortcut, and uniqueness) ----------

/** Lower case, accents and punctuation gone, spaces tidied: "Read 20 pages!" → "read 20 pages". */
export function nameKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The habit a spoken name means: the same name in any case first; else the
 * one habit whose name starts with it ("read" → "Read 20 pages"); else the
 * one whose name it contains or that contains it. More than one is a question.
 */
export function matchHabit<T extends { name: string }>(habits: T[], said: string): { habit: T } | { error: "none" | "many"; candidates: T[] } {
  const k = nameKey(said);
  if (!k) return { error: "none", candidates: habits };
  const exact = habits.filter((h) => nameKey(h.name) === k);
  if (exact.length === 1) return { habit: exact[0] };
  const starts = habits.filter((h) => nameKey(h.name).startsWith(`${k} `) || nameKey(h.name).startsWith(k));
  if (starts.length === 1) return { habit: starts[0] };
  if (starts.length > 1) return { error: "many", candidates: starts };
  const near = habits.filter((h) => {
    const n = nameKey(h.name);
    return ` ${n} `.includes(` ${k} `) || ` ${k} `.includes(` ${n} `);
  });
  if (near.length === 1) return { habit: near[0] };
  return near.length ? { error: "many", candidates: near } : { error: "none", candidates: habits };
}
