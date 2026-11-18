/**
 * Trips and purchases as words: the names, date ranges, "Arriving today" and
 * the briefing's one-liners ("Flight BA 432 to Lisbon tomorrow 07:10 from
 * Heathrow T5, ref ABC123"). Pure, so the server (briefing, pushes, MCP) and
 * the PWA (Home's Coming up, the Trips and Purchases pages) say exactly the
 * same thing. Also the normalisers that booking references, order numbers
 * and retailers are matched by (lib/trips.ts, lib/encryption.ts).
 *
 * The time rule: a booking's times are shown in the local time of where it
 * happens (its own IANA zone), with the city named when that isn't where
 * the owner is. "Today" is the owner's today.
 */

import { addDays, daysBetween, zonedParts } from "./dates";

// ---------- kinds and statuses ----------

export type BookingKind = "flight" | "train" | "hotel" | "car" | "event" | "other";
export const BOOKING_KINDS: readonly BookingKind[] = ["flight", "train", "hotel", "car", "event", "other"];
export type BookingStatus = "confirmed" | "changed" | "cancelled";
export const BOOKING_STATUSES: readonly BookingStatus[] = ["confirmed", "changed", "cancelled"];

export type PurchaseStatus = "ordered" | "dispatched" | "out_for_delivery" | "delivered" | "delayed" | "returned" | "refunded" | "cancelled";
export const PURCHASE_STATUSES: readonly PurchaseStatus[] = [
  "ordered",
  "dispatched",
  "out_for_delivery",
  "delivered",
  "delayed",
  "returned",
  "refunded",
  "cancelled",
];
/** Done with: these move down the list and are archived 30 days on. */
export const SETTLED_STATUSES: readonly PurchaseStatus[] = ["delivered", "returned", "refunded", "cancelled"];
export const isSettled = (status: PurchaseStatus): boolean => SETTLED_STATUSES.includes(status);

/** Travel from one place to another: its start is where you leave, its end where you arrive. */
export const TRANSPORT: ReadonlySet<BookingKind> = new Set(["flight", "train"]);

export const BOOKING_LABEL: Record<BookingKind, { label: string; start: string; end: string }> = {
  flight: { label: "Flight", start: "Departs", end: "Arrives" },
  train: { label: "Train", start: "Departs", end: "Arrives" },
  hotel: { label: "Hotel", start: "Check in", end: "Check out" },
  car: { label: "Car hire", start: "Pick up", end: "Drop off" },
  event: { label: "Ticket", start: "Starts", end: "Ends" },
  other: { label: "Booking", start: "Starts", end: "Ends" },
};

/**
 * How long before a booking starts its push goes: a flight early enough to
 * leave for the airport, the rest just before. A hotel's check-in time is a
 * window, not an appointment, so it gets none.
 */
export const BOOKING_PUSH_LEAD_MINUTES: Record<BookingKind, number | null> = {
  flight: 180,
  train: 30,
  hotel: null,
  car: 30,
  event: 30,
  other: 30,
};

export const PURCHASE_LABEL: Record<PurchaseStatus, string> = {
  ordered: "Ordered",
  dispatched: "Dispatched",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delayed: "Delayed",
  returned: "Returned",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

// ---------- the shapes the wording reads (server rows and app types both fit) ----------

export interface BookingLike {
  id?: string;
  kind: BookingKind;
  status: BookingStatus;
  title: string;
  provider: string;
  reference: string;
  start_date: string;
  starts_at: string | Date | null;
  start_tz: string;
  start_place: string;
  start_city: string;
  end_date: string | null;
  ends_at: string | Date | null;
  end_tz: string;
  end_place: string;
  end_city: string;
  seat: string;
  previous_starts_at?: string | Date | null;
  archived_at?: string | Date | null;
}

export interface TripLike<B extends BookingLike = BookingLike> {
  id: string;
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  archived_at?: string | Date | null;
  bookings: B[];
}

export interface PurchaseLike {
  id?: string;
  retailer: string;
  items: string[];
  status: PurchaseStatus;
  status_at: string | Date;
  expected_on: string | null;
  delivered_at?: string | Date | null;
  archived_at?: string | Date | null;
}

// ---------- matching keys ----------

/** "abc 123" and "ABC-123" are the same booking reference / order / tracking number. */
export function normaliseReference(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "Amazon.co.uk", "AMAZON" and "Amazon EU S.à r.l." all key to something containing "amazon". */
export function retailerKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^www\./, "")
    .replace(/\.(com|co|org|net|uk|de|fr|es|it|nl|ie|eu|io|shop|store)\b/g, " ")
    .replace(/\b(ltd|limited|inc|plc|llc|gmbh|sarl|s a r l|uk|online|store|shop)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/** Two retailer names that are probably the same shop. */
export function sameRetailer(a: string, b: string): boolean {
  const x = retailerKey(a);
  const y = retailerKey(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

/** A city or place name, compared ignoring case, accents and punctuation ("São Paulo" = "sao paulo"). */
export function placeKey(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------- times ----------

const iso = (v: string | Date | null | undefined): string | null => (v == null ? null : typeof v === "string" ? v : v.toISOString());

/** "Lisbon" from the booking's city, else from its zone ("Europe/Lisbon"). */
export function cityName(city: string, tz: string): string {
  if (city.trim()) return city.trim();
  return tz ? tz.split("/").pop()!.replace(/_/g, " ") : "";
}

export interface LocalMoment {
  date: string;
  /** "HH:MM" in the place's own zone, or null when only the day is known. */
  time: string | null;
  tz: string;
  city: string;
  place: string;
  /** UTC instant, when there's a time. */
  at: string | null;
}

/** Where and when a booking starts, in the place's own time. */
export function bookingStart(b: BookingLike): LocalMoment {
  const at = iso(b.starts_at);
  const local = at && b.start_tz ? zonedParts(new Date(at), b.start_tz) : null;
  return { date: local?.date ?? b.start_date, time: local?.time ?? null, tz: b.start_tz, city: cityName(b.start_city, b.start_tz), place: b.start_place, at };
}

/** Where and when it ends (arrives, checks out, drops off), or null when that isn't known. */
export function bookingEnd(b: BookingLike): LocalMoment | null {
  const at = iso(b.ends_at);
  const tz = b.end_tz || b.start_tz;
  if (!at && !b.end_date) return null;
  const local = at && tz ? zonedParts(new Date(at), tz) : null;
  return { date: local?.date ?? b.end_date!, time: local?.time ?? null, tz, city: cityName(b.end_city, tz), place: b.end_place, at };
}

/** The old start time, in the same zone, when a booking's time was changed. */
export function previousTime(b: BookingLike): string | null {
  const was = iso(b.previous_starts_at);
  if (!was || !b.start_tz) return null;
  const p = zonedParts(new Date(was), b.start_tz);
  const now = bookingStart(b);
  return p.date === now.date ? p.time : `${shortDay(p.date)} ${p.time}`;
}

// ---------- dates ----------

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

/** "12 Mar" */
export function shortDay(date: string): string {
  return DAY_MONTH.format(noon(date));
}

/**
 * A trip's dates: "12–15 Mar", "30 Mar – 2 Apr", "12 Mar", with the year
 * when it isn't this year ("28 Dec 2026 – 2 Jan 2027").
 */
export function tripDates(start: string | null, end: string | null, today?: string): string {
  if (!start) return "";
  const last = end && end > start ? end : start;
  const thisYear = (today ?? start).slice(0, 4);
  const year = (d: string) => (d.slice(0, 4) !== thisYear || start.slice(0, 4) !== last.slice(0, 4) ? ` ${d.slice(0, 4)}` : "");
  if (last === start) return `${shortDay(start)}${year(start)}`;
  const sameMonth = start.slice(0, 7) === last.slice(0, 7);
  if (sameMonth) return `${Number(start.slice(8, 10))}–${Number(last.slice(8, 10))} ${MONTH.format(noon(start))}${year(start)}`;
  return `${shortDay(start)}${start.slice(0, 4) !== last.slice(0, 4) ? year(start) : ""} – ${shortDay(last)}${year(last)}`;
}

/** "Lisbon, 12–15 Mar" */
export function tripLabel(t: Pick<TripLike, "title" | "starts_on" | "ends_on">, today?: string): string {
  const dates = tripDates(t.starts_on, t.ends_on, today);
  return dates ? `${t.title}, ${dates}` : t.title;
}

/** "today", "tomorrow", "on Friday", "on 14 March" — for sentences. */
export function relativeDay(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n > 1 && n < 7) return `on ${WEEKDAY.format(noon(date))}`;
  return `on ${shortDay(date)}`;
}

/** "Today", "Tomorrow", "Friday", "14 Mar" — for row labels. */
export function dayWord(date: string, today: string): string {
  const n = daysBetween(today, date);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return WEEKDAY.format(noon(date));
  return shortDay(date);
}

// ---------- bookings in words ----------

/** A short code like "BA 432" or "ES9014" reads better with its noun in front. */
const looksLikeCode = (title: string) => /^[A-Z0-9]{1,3}\s?\d{1,5}[A-Z]?$/i.test(title.trim());

/** "Flight BA 432 to Lisbon", "Eurostar 9014 to Paris", "Memmo Alfama", "Hertz car hire". */
export function bookingName(b: BookingLike): string {
  const title = b.title.trim() || b.provider.trim() || BOOKING_LABEL[b.kind].label;
  if (TRANSPORT.has(b.kind)) {
    const end = bookingEnd(b);
    const to = end?.city ? ` to ${end.city}` : "";
    const named = looksLikeCode(title) ? `${BOOKING_LABEL[b.kind].label} ${title}` : title;
    return /\bto\b/i.test(named) ? named : `${named}${to}`;
  }
  if (b.kind === "car" && !/\b(car|hire|rental)\b/i.test(title)) return `${title} car hire`;
  return title;
}

/** " Lisbon time" when the booking happens somewhere other than where the owner is. */
function zoneNote(m: LocalMoment, ownerTz: string | undefined): string {
  if (!m.time || !m.tz || !ownerTz || m.tz === ownerTz) return "";
  return m.city ? ` ${m.city} time` : "";
}

/**
 * One line for the briefing and pushes:
 *  - "Flight BA 432 to Lisbon tomorrow 07:10 from Heathrow T5, ref ABC123"
 *  - "Check in at Memmo Alfama today from 15:00, ref 4471"
 *  - "Pick up Hertz car hire tomorrow 10:30 at Lisbon Airport, ref K-2231"
 *  - "Fado at Clube de Fado on Friday 21:00 Lisbon time, ref TK88"
 */
export function bookingLine(b: BookingLike, today: string, ownerTz?: string): string {
  const s = bookingStart(b);
  const when = relativeDay(s.date, today);
  const at = s.time ? `${s.time}${zoneNote(s, ownerTz)}` : "";
  const ref = b.reference ? `, ref ${b.reference}` : "";
  let line: string;
  switch (b.kind) {
    case "hotel":
      line = `Check in at ${bookingName(b)} ${when}${at ? ` from ${at}` : ""}`;
      break;
    case "car":
      line = `Pick up ${bookingName(b)} ${when}${at ? ` ${at}` : ""}${s.place ? ` at ${s.place}` : ""}`;
      break;
    case "flight":
    case "train":
      line = `${bookingName(b)} ${when}${at ? ` ${at}` : ""}${s.place ? ` from ${s.place}` : ""}`;
      break;
    default:
      line = `${bookingName(b)} ${when}${at ? ` ${at}` : ""}${s.place && !bookingName(b).includes(s.place) ? ` at ${s.place}` : ""}`;
  }
  if (b.status === "cancelled") return `Cancelled: ${line}${ref}`;
  const was = b.status === "changed" ? previousTime(b) : null;
  return `${line}${ref}${was ? ` (moved from ${was})` : ""}`;
}

/** The 30-minute push: a title and one line of what you'll need at the door. */
export function bookingPush(b: BookingLike, ownerTz?: string): { title: string; body: string } {
  const s = bookingStart(b);
  const verb = BOOKING_LABEL[b.kind].start;
  const at = s.time ? `${verb} ${s.time}${zoneNote(s, ownerTz)}` : verb;
  const parts = [at, s.place, b.seat ? `seat ${b.seat}` : "", b.reference ? `ref ${b.reference}` : ""].filter(Boolean);
  return { title: bookingName(b), body: parts.join(" · ") };
}

// ---------- purchases in words ----------

/** "Kindle Paperwhite from Amazon", "Sofa cover and 2 more from IKEA", "Order from IKEA". */
export function purchaseName(p: Pick<PurchaseLike, "retailer" | "items">): string {
  const items = p.items.map((i) => i.trim()).filter(Boolean);
  if (!items.length) return `Order from ${p.retailer}`;
  const first = items[0].length > 48 ? `${items[0].slice(0, 45).trimEnd()}…` : items[0];
  return `${first}${items.length > 1 ? ` and ${items.length - 1} more` : ""} from ${p.retailer}`;
}

export type DeliveryTone = "today" | "soon" | "late" | "done" | "";

export interface DeliveryState {
  /** "Arriving today", "Out for delivery", "Arriving Thursday", "Delivered 3 Nov". */
  label: string;
  tone: DeliveryTone;
  /** Days until it's expected (negative once late), when there's a day. */
  days: number | null;
}

/** Where a purchase has got to, as the owner would say it. `today` and `tz` are the owner's. */
export function deliveryState(p: PurchaseLike, today: string, tz: string): DeliveryState {
  const statusDay = zonedParts(new Date(p.status_at), tz).date;
  switch (p.status) {
    case "delivered": {
      const day = p.delivered_at ? zonedParts(new Date(p.delivered_at), tz).date : statusDay;
      const n = daysBetween(day, today);
      return { label: n === 0 ? "Delivered today" : n === 1 ? "Delivered yesterday" : `Delivered ${shortDay(day)}`, tone: "done", days: null };
    }
    case "returned":
    case "refunded":
    case "cancelled":
      return { label: `${PURCHASE_LABEL[p.status]} ${shortDay(statusDay)}`, tone: "done", days: null };
    case "out_for_delivery":
      if (statusDay === today) return { label: "Out for delivery", tone: "today", days: 0 };
      return { label: "Did it arrive?", tone: "late", days: daysBetween(today, statusDay) };
    default: {
      if (!p.expected_on) return { label: p.status === "delayed" ? "Delayed" : p.status === "dispatched" ? "On its way" : "Ordered", tone: p.status === "delayed" ? "late" : "", days: null };
      const n = daysBetween(today, p.expected_on);
      if (n < 0) return { label: p.status === "delayed" ? "Delayed" : "Did it arrive?", tone: "late", days: n };
      const day = n === 0 ? "today" : n === 1 ? "tomorrow" : n < 7 ? WEEKDAY.format(noon(p.expected_on)) : shortDay(p.expected_on);
      if (p.status === "delayed") return { label: `Delayed, now ${day}`, tone: "late", days: n };
      return { label: `Arriving ${day}`, tone: n === 0 ? "today" : n <= 2 ? "soon" : "", days: n };
    }
  }
}

/** "Kindle Paperwhite from Amazon is out for delivery", "… arrives today". */
export function deliveryLine(p: PurchaseLike, today: string, tz: string): string {
  const state = deliveryState(p, today, tz);
  const name = purchaseName(p);
  if (p.status === "out_for_delivery" && state.tone === "today") return `${name} is out for delivery`;
  if (state.days === 0) return `${name} arrives today`;
  return `${name}: ${state.label.charAt(0).toLowerCase()}${state.label.slice(1)}`;
}

// ---------- what's coming up ----------

export interface TravelItem<T extends TripLike = TripLike> {
  trip: T;
  booking: T["bookings"][number];
  /** The booking's local start day and how far away it is (owner's today). */
  date: string;
  days_until: number;
  time: string | null;
}

/**
 * One row per trip: its next booking that starts within `days` of today
 * (the outbound flight, then the hotel, then the trip home). Cancelled and
 * archived bookings, and archived trips, are left out.
 */
export function travelComingUp<T extends TripLike>(trips: T[], today: string, now: Date, days = 6): TravelItem<T>[] {
  const end = addDays(today, days);
  const out: TravelItem<T>[] = [];
  for (const trip of trips) {
    if (trip.archived_at) continue;
    const next = trip.bookings
      .filter((b) => !b.archived_at && b.status !== "cancelled")
      .map((b) => ({ b, s: bookingStart(b) }))
      .filter(({ s }) => (s.at ? Date.parse(s.at) > now.getTime() : s.date >= today) && s.date <= end)
      .sort((x, y) => (x.s.at ?? `${x.s.date}T23:59`).localeCompare(y.s.at ?? `${y.s.date}T23:59`))[0];
    if (next) out.push({ trip, booking: next.b, date: next.s.date, days_until: daysBetween(today, next.s.date), time: next.s.time });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

export interface DeliveryItem<P extends PurchaseLike = PurchaseLike> {
  purchase: P;
  state: DeliveryState;
}

/**
 * Parcels worth a line this week: out for delivery today, or expected
 * between today and `days` from now (and ones a day or two late).
 */
export function deliveriesComingUp<P extends PurchaseLike>(purchases: P[], today: string, tz: string, days = 6): DeliveryItem<P>[] {
  const out: DeliveryItem<P>[] = [];
  for (const p of purchases) {
    if (p.archived_at || isSettled(p.status)) continue;
    const state = deliveryState(p, today, tz);
    if (state.days === null || state.days > days || state.days < -2) continue;
    out.push({ purchase: p, state });
  }
  const rank = (d: DeliveryItem) => (d.state.tone === "today" ? 0 : d.state.tone === "late" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (a.state.days ?? 0) - (b.state.days ?? 0));
}
