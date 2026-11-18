/**
 * Free time for a call or meeting: the best few slots of a given length in a
 * range, inside the owner's working hours, clear of their meetings (with a
 * buffer either side), their travel and their days off, and, where a
 * calendar let Athena see it, clear of each guest's busy times too.
 *
 * Pure: no database, no network. lib/scheduling.ts gathers the busy times
 * (calendar accounts, trips) and calls findSlots; the tests call it with
 * their own.
 *
 * Times are instants (ms since the epoch). Working hours, days and the
 * "nice time of day" scoring are read in the owner's zone, so a slot never
 * lands at 09:00 UTC when the owner means 09:00 in London; a guest's own
 * working hours (Outlook gives them, with their zone) are read in theirs.
 */
import { addDays, zonedParts, zonedToInstant } from "./dates";

/** The owner's working week (Settings → Days). Days are 0 = Sunday … 6 = Saturday; times "HH:MM" in the owner's zone. */
export interface WorkingHours {
  days: number[];
  start: string;
  end: string;
  /** Minutes kept clear before and after each meeting. */
  buffer: number;
}

export const DEFAULT_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", buffer: 10 };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** What's stored, checked: anything unreadable falls back to the default, field by field. */
export function readWorkingHours(raw: unknown): WorkingHours {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const days = Array.isArray(o.days) ? [...new Set(o.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort() : DEFAULT_HOURS.days;
  let start = typeof o.start === "string" && HHMM.test(o.start) ? o.start : DEFAULT_HOURS.start;
  let end = typeof o.end === "string" && HHMM.test(o.end) ? o.end : DEFAULT_HOURS.end;
  if (minutesOf(end) <= minutesOf(start)) [start, end] = [DEFAULT_HOURS.start, DEFAULT_HOURS.end];
  const buffer = typeof o.buffer === "number" && Number.isInteger(o.buffer) && o.buffer >= 0 && o.buffer <= 60 ? o.buffer : DEFAULT_HOURS.buffer;
  return { days: days.length ? days : DEFAULT_HOURS.days, start, end, buffer };
}

/** Something that makes the owner busy. */
export interface Busy {
  start: number;
  end: number;
  /** "event": a meeting (gets the buffer); "travel": a flight or train leg (gets TRAVEL_BUFFER). */
  kind?: "event" | "travel";
}

/** A guest whose calendar Athena could read: when they're busy, and their working hours when the calendar said. */
export interface GuestBusy {
  who: string;
  busy: Busy[];
  hours?: { days: number[]; start: string; end: string; tz: string };
}

export interface FindInput {
  /** Look from here (clamped to now + LEAD) … */
  from: number;
  /** … to here. */
  to: number;
  /** Length of the call or meeting. */
  minutes: number;
  /** The owner's zone. */
  tz: string;
  hours: WorkingHours;
  /** The owner's own busy times (declined and free-marked events already left out). */
  busy: Busy[];
  /** Whole days off in the owner's zone, "YYYY-MM-DD": all-day out of office, travel days. */
  blockedDays?: string[];
  /** Days the owner is away but not travelling: allowed, scored lower. */
  awayDays?: string[];
  guests?: GuestBusy[];
  now: number;
  /** How many to return (default 3). */
  count?: number;
}

export interface Slot {
  start: number;
  end: number;
  score: number;
}

/** Nothing sooner than this from now: time to send the invite and for it to be seen. */
export const LEAD_MINUTES = 30;
/** Kept clear either side of a flight or train. */
export const TRAVEL_BUFFER = 60;
/** Candidate starts fall on quarter hours. */
const STEP = 15;
const MIN = 60_000;
/** At most this many days are searched, however wide the range. */
const MAX_DAYS = 31;

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Local day of week (0 = Sunday) for a "YYYY-MM-DD". */
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Is [start, end) inside a guest's own working hours, read in their zone? */
function inGuestHours(slot: { start: number; end: number }, h: NonNullable<GuestBusy["hours"]>): boolean {
  const a = zonedParts(new Date(slot.start), h.tz);
  const b = zonedParts(new Date(slot.end - 1), h.tz);
  if (a.date !== b.date || !h.days.includes(weekday(a.date))) return false;
  const s = a.hour * 60 + a.minute;
  const e = b.hour * 60 + b.minute + 1;
  return s >= minutesOf(h.start) && e <= minutesOf(h.end);
}

/**
 * How good a free slot is. Higher is better. A slot that's free for everyone
 * scores by: how soon (sooner is better, gently), the time of day (late
 * morning and mid-afternoon; not the first or last hour, not lunch), landing
 * on the hour, sitting next to another meeting so free time stays in one
 * piece, and a lighter day. Away days score lower.
 */
function score(slot: { start: number; end: number }, ctx: { tz: string; dayStart: number; dayEnd: number; dayIndex: number; meetingsThatDay: number; away: boolean; busy: Busy[]; buffer: number }): number {
  const p = zonedParts(new Date(slot.start), ctx.tz);
  const startMin = p.hour * 60 + p.minute;
  const endMin = startMin + (slot.end - slot.start) / MIN;
  let s = 100;
  s -= ctx.dayIndex * 3;
  if (startMin >= 10 * 60 && endMin <= 12 * 60) s += 8;
  else if (startMin >= 14 * 60 && endMin <= 16 * 60 + 30) s += 6;
  if (startMin < ctx.dayStart + 60) s -= 4;
  if (endMin > ctx.dayEnd - 60) s -= 6;
  if (startMin < 13 * 60 && endMin > 12 * 60) s -= 7;
  if (p.minute === 0) s += 3;
  else if (p.minute === 30) s += 1;
  // Next to a meeting (just past its buffer): the rest of the day stays clear.
  const near = (gap: number) => gap >= 0 && gap <= (ctx.buffer + STEP) * MIN;
  if (ctx.busy.some((b) => b.kind !== "travel" && (near(slot.start - b.end) || near(b.start - slot.end)))) s += 4;
  s -= Math.min(ctx.meetingsThatDay, 6) * 1.5;
  if (ctx.away) s -= 10;
  return s;
}

/**
 * The best `count` slots, best first. At most one per day while other days
 * have room, so the choices are spread out; then the next best overall.
 */
export function findSlots(input: FindInput): Slot[] {
  const count = input.count ?? 3;
  const length = Math.round(input.minutes) * MIN;
  if (!(length > 0) || input.to <= input.from) return [];
  const earliest = Math.max(input.from, input.now + LEAD_MINUTES * MIN);
  const blocked = new Set(input.blockedDays ?? []);
  const away = new Set(input.awayDays ?? []);
  const dayStart = minutesOf(input.hours.start);
  const dayEnd = minutesOf(input.hours.end);
  const buffer = input.hours.buffer * MIN;
  // Each busy time, widened by what's kept clear around it.
  const mine = input.busy
    .filter((b) => b.end > b.start)
    .map((b) => {
      const pad = b.kind === "travel" ? TRAVEL_BUFFER * MIN : buffer;
      return { start: b.start - pad, end: b.end + pad };
    });
  const guests = input.guests ?? [];
  const first = zonedParts(new Date(earliest), input.tz).date;
  const last = zonedParts(new Date(input.to), input.tz).date;
  const found: Array<Slot & { day: string }> = [];
  for (let i = 0, date = first; date <= last && i < MAX_DAYS; i++, date = addDays(date, 1)) {
    if (!input.hours.days.includes(weekday(date)) || blocked.has(date)) continue;
    const open = Math.max(zonedToInstant(date, input.hours.start, input.tz).getTime(), earliest);
    const close = Math.min(zonedToInstant(date, input.hours.end, input.tz).getTime(), input.to);
    const dayFrom = zonedToInstant(date, "00:00", input.tz).getTime();
    const dayTo = zonedToInstant(addDays(date, 1), "00:00", input.tz).getTime();
    const meetingsThatDay = input.busy.filter((b) => b.kind !== "travel" && b.start < dayTo && b.end > dayFrom).length;
    // Quarter hours on the owner's clock.
    const firstStep = Math.ceil((open - dayFrom) / (STEP * MIN)) * STEP * MIN + dayFrom;
    for (let start = firstStep; start + length <= close; start += STEP * MIN) {
      const slot = { start, end: start + length };
      if (mine.some((b) => overlaps(slot, b))) continue;
      if (guests.some((g) => g.busy.some((b) => overlaps(slot, b)) || (g.hours && !inGuestHours(slot, g.hours)))) continue;
      found.push({ ...slot, day: date, score: score(slot, { tz: input.tz, dayStart, dayEnd, dayIndex: i, meetingsThatDay, away: away.has(date), busy: input.busy, buffer: input.hours.buffer }) });
    }
  }
  const ranked = found.sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: typeof ranked = [];
  const days = new Set<string>();
  for (const s of ranked) {
    if (picked.length >= count) break;
    if (days.has(s.day)) continue;
    picked.push(s);
    days.add(s.day);
  }
  for (const s of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(s) && !picked.some((p) => overlaps(p, s))) picked.push(s);
  }
  return picked.sort((a, b) => b.score - a.score || a.start - b.start).map(({ start, end, score }) => ({ start, end, score: Math.round(score * 10) / 10 }));
}

/** A calendar event, as the calendar tools give it (google-calendar.ts, microsoft-calendar.ts, icloud-calendar.ts list_events). */
export interface CalendarEventLite {
  id?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: string;
  eventType?: string;
  myResponse?: string;
  summary?: string;
  /** Marked as free (Google transparency, Outlook showAs free). */
  free?: boolean;
}

const OUT_OF_OFFICE = /out\s*of\s*(the\s*)?office|\booo\b|annual leave|\bholiday\b|\bvacation\b|day off/i;

/**
 * The owner's events as busy times and blocked days. Declined, cancelled and
 * free-marked events don't count; an all-day out-of-office (Google's
 * outOfOffice type, Outlook's oof, or a title that says so) blocks each of
 * its days; other all-day events (a birthday, a reminder) don't block.
 */
export function busyFromEvents(events: CalendarEventLite[], tz: string): { busy: Busy[]; blockedDays: string[] } {
  const busy: Busy[] = [];
  const blocked = new Set<string>();
  for (const e of events) {
    if (!e.start || !e.end || e.status === "cancelled" || e.free) continue;
    if ((e.myResponse ?? "").toLowerCase() === "declined") continue;
    const ooo = e.eventType === "outOfOffice" || e.eventType === "oof" || OUT_OF_OFFICE.test(e.summary ?? "");
    if (e.allDay) {
      if (!ooo) continue;
      // All-day ends are the day after it finishes.
      for (let d = e.start.slice(0, 10), i = 0; d < e.end.slice(0, 10) && i < 62; d = addDays(d, 1), i++) blocked.add(d);
      continue;
    }
    const start = Date.parse(e.start);
    const end = Date.parse(e.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // A timed out-of-office that covers a working day blocks it, so no slot slips in around it.
    if (ooo && end - start >= 6 * 3_600_000) {
      for (let d = zonedParts(new Date(start), tz).date, i = 0; d <= zonedParts(new Date(end - 1), tz).date && i < 62; d = addDays(d, 1), i++) blocked.add(d);
      continue;
    }
    busy.push({ start, end, kind: "event" });
  }
  return { busy, blockedDays: [...blocked].sort() };
}

/** A flight or train (lib/trips.ts bookings), for busyFromTravel. */
export interface TravelLeg {
  kind: string;
  status?: string;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string;
  end_date?: string | null;
}

/** A trip's days, for away days. */
export interface TripDays {
  starts_on: string | null;
  ends_on: string | null;
}

/**
 * Travel as busy time: each flight and train leg is busy (with
 * TRAVEL_BUFFER either side, see findSlots), and the days a leg starts or
 * ends are blocked as travel days. Days inside a trip without a leg are away
 * days: allowed, scored lower.
 */
export function busyFromTravel(legs: TravelLeg[], trips: TripDays[], tz: string): { busy: Busy[]; blockedDays: string[]; awayDays: string[] } {
  const busy: Busy[] = [];
  const blocked = new Set<string>();
  for (const b of legs) {
    if ((b.kind !== "flight" && b.kind !== "train") || b.status === "cancelled") continue;
    const start = b.starts_at ? Date.parse(b.starts_at) : NaN;
    const end = b.ends_at ? Date.parse(b.ends_at) : Number.isFinite(start) ? start + 2 * 3_600_000 : NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      busy.push({ start, end, kind: "travel" });
      blocked.add(zonedParts(new Date(start), tz).date);
      blocked.add(zonedParts(new Date(end), tz).date);
    } else {
      blocked.add(b.start_date);
      if (b.end_date) blocked.add(b.end_date);
    }
  }
  const away = new Set<string>();
  for (const t of trips) {
    if (!t.starts_on || !t.ends_on) continue;
    for (let d = t.starts_on, i = 0; d <= t.ends_on && i < 62; d = addDays(d, 1), i++) if (!blocked.has(d)) away.add(d);
  }
  return { busy, blockedDays: [...blocked].sort(), awayDays: [...away].sort() };
}
