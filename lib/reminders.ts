/**
 * Custom reminders ("remind me to call the plumber at 17:00"): the pure
 * scheduling maths, shared by lib/db.ts, the reminders function and the PWA.
 *
 * A reminder stores the instant it next fires (`remind_at`). Days and times
 * are read in a time zone: the owner's on the server, the device's in the app.
 * Repeating reminders keep their wall-clock time in the owner's zone when they
 * move on, so a daily 08:00 reminder stays at 08:00 across the clocks
 * changing, and (lib/db.ts alignReminders) when the owner's zone changes.
 */

import { addDays, isValidDate, zonedParts, zonedToInstant } from "./dates";

export type ReminderRepeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export const REMINDER_REPEATS: readonly ReminderRepeat[] = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"];

export const REPEAT_LABELS: Record<ReminderRepeat, string> = {
  none: "Once",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `date` moved on by `months`, keeping the day of month from `anchorDay`
 * where the month has it and otherwise using its last day (31 Jan → 28 Feb
 * → 31 Mar), so a monthly reminder never drifts.
 */
export function addMonths(date: string, months: number, anchorDay = Number(date.slice(8, 10))): string {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday, for a "YYYY-MM-DD" date. */
function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function step(date: string, repeat: Exclude<ReminderRepeat, "none">, anchorDay: number): string {
  switch (repeat) {
    case "daily":
      return addDays(date, 1);
    case "weekdays": {
      let next = addDays(date, 1);
      while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
      return next;
    }
    case "weekly":
      return addDays(date, 7);
    case "monthly":
      return addMonths(date, 1, anchorDay);
    case "yearly":
      return addMonths(date, 12, anchorDay);
  }
}

/**
 * When a reminder that was due at `remindAt` fires next, strictly after
 * `after` (normally now). Missed occurrences are skipped rather than sent in
 * a burst. Null for a one-off reminder.
 *
 * `anchorDay` is the day of month the reminder was set for (monthly/yearly),
 * so 31st-of-the-month reminders come back to the 31st. Days and the
 * wall-clock time are kept in `tz` (the owner's zone).
 */
export function nextRemindAt(remindAt: Date, repeat: ReminderRepeat, after: Date, anchorDay: number | undefined, tz: string): Date | null {
  if (repeat === "none") return null;
  const { date, time } = zonedParts(remindAt, tz);
  const anchor = anchorDay ?? Number(date.slice(8, 10));
  let next = date;
  let at = remindAt;
  // Bounded: a decade of daily steps is far more than any real backlog.
  for (let i = 0; i < 4000 && at.getTime() <= after.getTime(); i++) {
    next = step(next, repeat, anchor);
    at = zonedToInstant(next, time, tz);
  }
  return at;
}

/** Parse "HH:MM" (or "H:MM"), 24h. */
export function parseLocalTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** A local date + time in `tz` as an instant, or null if either is malformed. */
export function localToInstant(date: string, time: string, tz: string): Date | null {
  const t = parseLocalTime(time);
  if (!isValidDate(date) || !t) return null;
  return zonedToInstant(date, t, tz);
}

/** "Tomorrow at 09:00", "Today at 17:30", "Fri 14 Nov at 08:00", "14 Nov 2027 at 08:00", as seen in `tz`. */
export function describeWhen(at: Date, now: Date, tz: string): string {
  const { date, time } = zonedParts(at, tz);
  const today = zonedParts(now, tz).date;
  const [y, m, d] = date.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  let day: string;
  if (date === today) day = "Today";
  else if (date === addDays(today, 1)) day = "Tomorrow";
  else if (date === addDays(today, -1)) day = "Yesterday";
  else if (date > today && date <= addDays(today, 6))
    day = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(noon);
  else if (date.slice(0, 4) === today.slice(0, 4))
    day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(noon);
  else day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(noon);
  return `${day} at ${time}`;
}
