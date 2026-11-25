/**
 * The Health page's ranges and how a range is cut into bars, shared by its
 * two tabs: Body (views/health.ts) and Wellness (views/health-wellness.ts).
 * Four weeks is a bar a day, six months a bar a week, a year a bar a month.
 */

import { addDays } from "../../../lib/dates";

export type Range = "4w" | "6m" | "1y";

export interface RangeInfo {
  id: Range;
  label: string;
  days: number;
  /** "the 4 weeks before": what a figure is compared with. */
  before: string;
  /** "these 4 weeks": for "Nothing in these 4 weeks". */
  in: string;
}

export const RANGES: RangeInfo[] = [
  { id: "4w", label: "4 weeks", days: 28, before: "the 4 weeks before", in: "these 4 weeks" },
  { id: "6m", label: "6 months", days: 182, before: "the 6 months before", in: "these 6 months" },
  { id: "1y", label: "Year", days: 364, before: "the year before", in: "this year" },
];

const utc = (day: string) => new Date(`${day}T12:00:00Z`);
export const fmt = (day: string, o: Intl.DateTimeFormatOptions): string => utc(day).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
export const shortDay = (day: string): string => fmt(day, { weekday: "short", day: "numeric", month: "short" });
export const longDay = (day: string): string => fmt(day, { weekday: "long", day: "numeric", month: "long" });

/** Monday of the day's week. */
function weekStart(day: string): string {
  const dow = (utc(day).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

export interface Bucket<T> {
  key: string;
  label: string;
  tick?: string;
  days: T[];
}

/** The range cut into what one bar shows: a day, a week or a month. */
export function buckets<T extends { date: string }>(range: Range, end: string, byDate: Map<string, T>): Bucket<T>[] {
  const out: Bucket<T>[] = [];
  if (range === "4w") {
    for (let i = 27; i >= 0; i--) {
      const d = addDays(end, -i);
      out.push({ key: d, label: shortDay(d), tick: i % 7 === 0 ? fmt(d, { day: "numeric", month: "short" }) : undefined, days: byDate.has(d) ? [byDate.get(d)!] : [] });
    }
    return out;
  }
  if (range === "6m") {
    const last = weekStart(end);
    for (let i = 25; i >= 0; i--) {
      const w = addDays(last, -7 * i);
      const days = Array.from({ length: 7 }, (_, k) => byDate.get(addDays(w, k))).filter((x): x is T => !!x && x.date <= end);
      const newMonth = i === 25 || fmt(w, { month: "short" }) !== fmt(addDays(w, -7), { month: "short" });
      out.push({ key: w, label: i === 0 && addDays(w, 6) > end ? "This week so far" : `Week of ${fmt(w, { day: "numeric", month: "short" })}`, tick: newMonth ? fmt(addDays(w, 6), { month: "short" }) : undefined, days });
    }
    return out;
  }
  const [y, m] = end.split("-").map(Number);
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1, 12));
    const prefix = dt.toISOString().slice(0, 7);
    const days = [...byDate.values()].filter((d) => d.date.startsWith(prefix) && d.date <= end);
    const monthName = dt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    out.push({ key: prefix, label: i === 0 ? `${dt.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })} so far` : monthName, tick: dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }), days });
  }
  return out;
}
