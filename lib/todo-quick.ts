/**
 * To do's quick-add line, read the way people type: "Book the MOT tomorrow
 * !high" adds "Book the MOT", due tomorrow, high priority.
 *
 * Deliberately narrow, so a title is never mangled:
 * - A priority is a word of its own starting with "!": !1 / !high,
 *   !2 / !medium / !med, !3 / !low. Anywhere in the line.
 * - A date only counts at the end of the line (optionally after "on", "by"
 *   or "due"): today, tonight, tomorrow, a weekday (Fri, Friday, next
 *   Friday), this weekend, next week, in 3 days / in 2 weeks, or a day and
 *   month (12 Dec, December 12). "Watch Tomorrow Never Dies" stays as it is.
 * - Nothing is taken if it would leave the title empty.
 *
 * The app shows what it found under the line before adding, and one tap
 * keeps the words as typed instead (views/loops.ts).
 */

import { addDays } from "./dates";
import type { TodoPriority } from "./todo-details";

export interface QuickTodo {
  title: string;
  due_on?: string;
  priority?: TodoPriority;
  /** The words that were read as a date / priority, as typed (for the preview and "keep as typed"). */
  found: { due?: string; priority?: string };
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Weekday words people type: full names and the usual short forms. */
const WEEKDAY_WORDS: Record<string, number> = Object.fromEntries(
  WEEKDAYS.flatMap((d, i) => [[d, i], [d.slice(0, 3), i]] as [string, number][]).concat([
    ["tues", 2],
    ["weds", 3],
    ["thur", 4],
    ["thurs", 4],
  ]),
);
const weekdayIndex = (word: string): number => WEEKDAY_WORDS[word.toLowerCase().replace(/\.$/, "")] ?? -1;

const monthIndex = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w || (w === "sept" && m === "september"));
};

const dayOfWeek = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The next date (today or later) that falls on `wd`; with `next`, the one in the following week. */
function nextWeekday(today: string, wd: number, next: boolean): string {
  let n = (wd - dayOfWeek(today) + 7) % 7;
  if (n === 0) n = 7;
  if (next && n < 7) n += 7;
  return addDays(today, n);
}

/** The next time a day and month comes round, this year or next. */
function nextDayMonth(today: string, day: number, month: number): string | null {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const d = `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const real = new Date(`${d}T12:00:00Z`);
    if (real.getUTCDate() !== day) return null; // 31 April
    if (d >= today) return d;
  }
  return null;
}

/** A date phrase that ends `words`: how many words it takes and the date, or null. */
function trailingDate(words: string[], today: string): { take: number; date: string } | null {
  const lower = words.map((w) => w.toLowerCase().replace(/[.,]$/, ""));
  const n = lower.length;
  const last = lower[n - 1];
  const prev = lower[n - 2];
  const prev2 = lower[n - 3];
  if (!last) return null;
  if (last === "today" || last === "tonight") return { take: 1, date: today };
  if (last === "tomorrow" || last === "tmrw" || last === "tmr") return { take: 1, date: addDays(today, 1) };
  if (prev === "next" && last === "week") return { take: 2, date: nextWeekday(today, 1, false) };
  if (prev === "this" && last === "weekend") return { take: 2, date: dayOfWeek(today) === 6 ? today : nextWeekday(today, 6, false) };
  if (prev2 === "in" && /^\d{1,3}$/.test(prev ?? "") && /^(days?|weeks?)$/.test(last)) {
    const k = Number(prev) * (last.startsWith("week") ? 7 : 1);
    if (k > 0 && k <= 365) return { take: 3, date: addDays(today, k) };
  }
  const wd = weekdayIndex(last);
  if (wd >= 0) {
    if (prev === "next") return { take: 2, date: nextWeekday(today, wd, true) };
    if (prev === "this") return { take: 2, date: nextWeekday(today, wd, false) };
    return { take: 1, date: nextWeekday(today, wd, false) };
  }
  // "12 Dec", "12th December", "Dec 12", "December 12th"
  const dayNum = (w: string | undefined) => (w && /^\d{1,2}(st|nd|rd|th)?$/.test(w) ? Number(w.replace(/\D/g, "")) : NaN);
  if (n >= 2) {
    const m1 = monthIndex(last);
    const d1 = dayNum(prev);
    if (m1 >= 0 && d1 >= 1 && d1 <= 31) {
      const date = nextDayMonth(today, d1, m1);
      if (date) return { take: 2, date };
    }
    const m2 = monthIndex(prev ?? "");
    const d2 = dayNum(last);
    if (m2 >= 0 && d2 >= 1 && d2 <= 31) {
      const date = nextDayMonth(today, d2, m2);
      if (date) return { take: 2, date };
    }
  }
  return null;
}

const PRIORITY_WORDS: Record<string, TodoPriority> = { "!1": 3, "!high": 3, "!2": 2, "!medium": 2, "!med": 2, "!3": 1, "!low": 1 };

export function parseQuickTodo(text: string, today: string): QuickTodo {
  const raw = text.replace(/\s+/g, " ").trim();
  const out: QuickTodo = { title: raw, found: {} };
  let words = raw.split(" ").filter(Boolean);

  const pIdx = words.findIndex((w) => w.toLowerCase() in PRIORITY_WORDS);
  if (pIdx >= 0 && words.length > 1) {
    out.priority = PRIORITY_WORDS[words[pIdx].toLowerCase()];
    out.found.priority = words[pIdx];
    words = words.filter((_, i) => i !== pIdx);
  }

  const date = words.length > 1 ? trailingDate(words, today) : null;
  if (date && words.length > date.take) {
    let cut = words.length - date.take;
    // "… by Friday", "… on 12 Dec", "… due tomorrow"
    if (cut > 1 && /^(on|by|due)$/i.test(words[cut - 1])) cut -= 1;
    out.due_on = date.date;
    out.found.due = words.slice(cut).join(" ");
    words = words.slice(0, cut);
  }

  out.title = words.join(" ").replace(/[\s,;:–-]+$/, "").trim() || raw;
  return out;
}
