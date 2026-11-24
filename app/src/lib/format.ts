import { clockTime } from "./clock";
const LOCALE = "en-GB";
const RTF = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const DAY = 86_400_000;

export function relativeTime(iso: string): string {
  const diffSec = (Date.parse(iso) - Date.now()) / 1000;
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diffSec) >= secs) return RTF.format(Math.round(diffSec / secs), unit);
  }
  return "just now";
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Row timestamps: "now", "12m", "3h", "Yesterday", "Tue", "5 Nov". */
export function compactTime(iso: string, now = new Date()): string {
  const t = Date.parse(iso);
  const mins = Math.round((now.getTime() - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const today = startOfDay(now);
  if (t >= today) return `${Math.round(mins / 60)}h`;
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 6 * DAY) return new Intl.DateTimeFormat(LOCALE, { weekday: "short" }).format(t);
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(t);
}

export type DayBucket = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

export function dayBucket(iso: string, now = new Date()): DayBucket {
  const t = Date.parse(iso);
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Previous 7 days";
  if (t >= today - 30 * DAY) return "Previous 30 days";
  return "Older";
}

export function longDateTime(iso: string): string {
  return `${new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", year: "numeric" }).format(Date.parse(iso))}, ${clockTime(iso)}`;
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" }).format(Date.parse(iso));
}

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / DAY);
}

export function initials(name: string): string {
  const parts = name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Stable per-name hue, so a person's avatar keeps its colour across renders. */
export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

/** "Good evening", or "Good evening, Alex" with the name the owner asked to be called. */
export function greeting(date = new Date(), name?: string | null): string {
  const h = date.getHours();
  const words = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const n = name?.trim();
  return n ? `${words}, ${n}` : words;
}

export type DayPart = "morning" | "day" | "evening";

/** Morning from 5 to 11, evening from 6pm through the night: the aurora's two variants (styles/tokens.css). */
export function dayPart(date = new Date()): DayPart {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 18 || h < 5) return "evening";
  return "day";
}

/**
 * Keep `data-daypart` on <html> in step with the clock, so the aurora
 * follows the time of day. Checks once a minute and when the tab comes back.
 */
let following = false;
export function followDayPart(root: HTMLElement = document.documentElement): void {
  if (following) return;
  following = true;
  const set = () => {
    const part = dayPart();
    if (root.dataset.daypart !== part) root.dataset.daypart = part;
  };
  set();
  setInterval(set, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && set());
}

// Every view greets or dates through this module, so the aurora starts following the day as the app loads.

export function formatDateHeading(date = new Date()): string {
  return new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long" }).format(date);
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "Two" for 2, "14" for 14 — numbers read better as words in a sentence. */
export function countWord(n: number, lower = false): string {
  const w = n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  return lower ? w.toLowerCase() : w;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Default catch-up cadence in days (mirrors lib/db.ts DEFAULT_CATCH_UP_DAYS). */
export const DEFAULT_CATCH_UP = 60;

/** "every 2 weeks" for 14, "every month" for 30, "every 45 days" otherwise. */
export function cadenceLabel(days: number): string {
  const named: Record<number, string> = { 7: "week", 14: "2 weeks", 30: "month", 60: "2 months", 90: "3 months", 180: "6 months", 365: "year" };
  return `every ${named[days] ?? `${days} days`}`;
}

const MONTHS_LONG = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long" });
const WITH_YEAR = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", year: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat(LOCALE, { weekday: "long" });

const utc = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

/** "4 March" / "4 March 1992" from a local "YYYY-MM-DD" (no time zone shifts). */
export function calendarDate(date: string, withYear = false): string {
  return (withYear ? WITH_YEAR : MONTHS_LONG).format(utc(date));
}

/** "Today", "Tomorrow", "Thursday" (within a week), else "12 March". */
export function dayLabel(daysUntil: number, date: string): string {
  if (daysUntil === 0) return "Today";
  if (daysUntil === 1) return "Tomorrow";
  if (daysUntil < 7) return WEEKDAY.format(utc(date));
  return calendarDate(date);
}

/** "in 3 days" / "today". */
export function inDays(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}
