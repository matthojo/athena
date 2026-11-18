/**
 * Calendar maths for events, reminders and the briefing. Shared by lib/db.ts,
 * the reminders function and the PWA, so "Coming up" and the push that fires
 * agree on what "today" is.
 *
 * The time model:
 *  - An instant (a timed one-off event, a note, a run) is stored in UTC and
 *    shown in whichever time zone is looking at it: the browser's in the app,
 *    the owner's last-reported one on the server (settings.timezone).
 *  - A calendar date (a birthday, an all-day event, a yearly anniversary) is
 *    just "YYYY-MM-DD": 4 March is 4 March everywhere, so it's never shifted.
 *  - A yearly event can also have a wall-clock "HH:MM", read in the viewer's
 *    time zone (dinner at 19:00 every year, wherever you are).
 *
 * "Today", due dates and overdue are always worked out in a zone: on the
 * server the owner's (getOwnerTimeZone() in lib/db.ts, read once per request
 * or run), in the app the device's (app/src/lib/time.ts).
 */

/** Used until a device has told Athena where the owner is. */
export const DEFAULT_TZ = "Europe/London";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True for an IANA time zone this runtime knows ("Europe/Paris", "UTC"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The device's own time zone (in the PWA), or the default. */
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  hour: number;
  minute: number;
}

function rawParts(at: Date, tz: string): Record<string, string> {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(at)) p[part.type] = part.value;
  return p;
}

/** The calendar date and wall-clock time at instant `at` in `tz`. */
export function zonedParts(at: Date, tz: string = DEFAULT_TZ): LocalParts {
  const p = rawParts(at, tz);
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, "0")}:${p.minute}`,
    hour,
    minute,
  };
}

export function zonedToday(at: Date = new Date(), tz: string = DEFAULT_TZ): string {
  return zonedParts(at, tz).date;
}

/** Offset of `tz` from UTC at `at`, in minutes (e.g. 60 in BST). */
function offsetMinutes(at: Date, tz: string): number {
  const p = rawParts(at, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant at which wall-clock `date` `time` happens in `tz`. A time in a
 * spring-forward gap resolves to the instant one hour later; in an autumn
 * overlap the earlier instant wins.
 */
export function zonedToInstant(date: string, time: string, tz: string = DEFAULT_TZ): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const wanted = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  const offsets = new Set([-24, -12, 0, 12, 24].map((hrs) => offsetMinutes(new Date(naive + hrs * 3600000), tz)));
  const matches = [...offsets]
    .map((off) => new Date(naive - off * 60000))
    .filter((c) => {
      const back = zonedParts(c, tz);
      return back.date === date && back.time === wanted;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length) return matches[0];
  // Non-existent local time (spring gap): use the offset in force just before it.
  return new Date(naive - offsetMinutes(new Date(naive - 6 * 3600000), tz) * 60000);
}

/**
 * The instant showing the same date and wall-clock time in `to` as `at` does
 * in `from`: 08:00 in London becomes 08:00 in New York.
 */
export function sameWallClock(at: Date, from: string, to: string): Date {
  if (from === to) return at;
  const p = zonedParts(at, from);
  return zonedToInstant(p.date, p.time, to);
}

// ---------- pure date-string arithmetic (no time zones involved) ----------

function toUtcMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * 86400000);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / 86400000);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** True for a real calendar date in "YYYY-MM-DD" form. */
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return fromUtcMs(toUtcMs(date)) === date;
}

/**
 * A yearly event's date within `year`. 29 February falls on 28 February in
 * non-leap years (the convention most people celebrate on).
 */
export function anniversaryInYear(date: string, year: number): string {
  const mmdd = date.slice(5);
  if (mmdd === "02-29" && !isLeapYear(year)) return `${year}-02-28`;
  return `${year}-${mmdd}`;
}

/**
 * The next date on or after `from` that an event falls on, or null for a
 * one-off event already in the past.
 */
export function nextOccurrence(
  date: string,
  recurrence: "none" | "yearly",
  from: string,
): string | null {
  if (recurrence === "none") return date >= from ? date : null;
  const fromYear = Number(from.slice(0, 4));
  const startYear = Math.max(fromYear, Number(date.slice(0, 4)));
  for (let year = startYear; year <= startYear + 1; year++) {
    const candidate = anniversaryInYear(date, year);
    if (candidate >= from && candidate >= date) return candidate;
  }
  return anniversaryInYear(date, startYear + 1);
}

/** Age someone turns (or anniversary number) on `occursOn`, given the original date. */
export function yearsSince(date: string, occursOn: string): number {
  return Number(occursOn.slice(0, 4)) - Number(date.slice(0, 4));
}

/** The fields of an event that occurrence maths needs. */
export interface DatedThing {
  /** A calendar date. For a timed one-off it's the day in the zone it was saved in; `starts_at` wins. */
  date: string;
  /** Wall-clock "HH:MM" — yearly events only. */
  time: string | null;
  /** UTC instant for a timed one-off event. */
  starts_at?: string | Date | null;
  recurrence: "none" | "yearly";
  year_known: boolean;
}

/** Where an event falls for someone in `tz`: its local day and, if timed, local time. */
export function localWhen(e: DatedThing, tz: string = DEFAULT_TZ): { date: string; time: string | null } {
  if (e.starts_at) {
    const p = zonedParts(new Date(e.starts_at), tz);
    return { date: p.date, time: p.time };
  }
  return { date: e.date, time: e.time };
}

export interface Occurrence<T extends DatedThing> {
  event: T;
  /** Local date this occurrence falls on (in the zone asked about). */
  occurs_on: string;
  days_until: number;
  /** Local "HH:MM" it starts at, or null when it's all-day. */
  time: string | null;
  /** The UTC instant it starts, when it has a time. */
  starts_at: string | null;
  /** Age turned / anniversary number, when the original year is known. */
  years: number | null;
}

/** Expand events into occurrences within [today, today + days] in `tz`, soonest first. */
export function upcomingOccurrences<T extends DatedThing>(events: T[], today: string, days: number, tz: string = DEFAULT_TZ): Occurrence<T>[] {
  const end = addDays(today, days);
  const out: Occurrence<T>[] = [];
  for (const event of events) {
    const when = localWhen(event, tz);
    const occursOn = nextOccurrence(when.date, event.recurrence, today);
    if (!occursOn || occursOn > end) continue;
    const years = event.recurrence === "yearly" && event.year_known ? yearsSince(event.date, occursOn) : null;
    const startsAt = event.starts_at
      ? new Date(event.starts_at).toISOString()
      : when.time
        ? zonedToInstant(occursOn, when.time, tz).toISOString()
        : null;
    out.push({ event, occurs_on: occursOn, days_until: daysBetween(today, occursOn), time: when.time, starts_at: startsAt, years: years && years > 0 ? years : null });
  }
  return out.sort((a, b) => a.occurs_on.localeCompare(b.occurs_on) || (a.time ?? "").localeCompare(b.time ?? ""));
}
