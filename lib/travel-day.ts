/**
 * Travelling today: which of a day's bookings make its legs, when the strip
 * shows, when it asks again for live times, and how each leg reads. Pure (no
 * Node, DOM or network), so the app's strip (app/src/components/travel-today.ts),
 * the server's GET /api/travel/live and the tests share one set of rules.
 *
 *   "07:10 to Bristol · 12 min late · platform 4"
 *   "BA 432 to Lisbon · on time · gate B32"
 *
 * Rules:
 *  - Legs: the day's trains, flights, coaches and ferries, car pick-ups and
 *    hotel check-ins (a coach or ferry is an "other" booking that names one),
 *    in time order. Tickets for events aren't travel.
 *  - Shows from 05:00, or 3 hours before the first leg when that's earlier,
 *    until the last leg has arrived. After that the day page says
 *    "Travelled today"; Home lets it go.
 *  - Asks for live times every 2½ minutes while any leg is in its live window
 *    (a train from 3 hours before until 30 minutes after it leaves, a flight
 *    from 3 hours before until 45 minutes after it lands), and not at all
 *    otherwise: it waits for the next window to open, or stops.
 */

import { zonedParts, zonedToInstant } from "./dates";
import { bookingEnd, bookingName, bookingStart, cityName, type BookingLike, type TripLike } from "./trip-text";
import { liveCandidate, statusWords, trainChip, type LineStatus, type TrainStatus } from "./live-travel-text";
import { bookingFlight, flightCandidate, flightChip, flightWords, FLIGHT_AHEAD_MINUTES, FLIGHT_AFTER_MINUTES, PROVIDER_NAME, type ChipTone, type FlightProviderId, type FlightStatus } from "./flight-text";
import { LIVE_AFTER_MINUTES, LIVE_AHEAD_MINUTES, lineLine } from "./live-travel-text";

export type LegKind = "train" | "flight" | "coach" | "ferry" | "car" | "hotel";

export type TravelBooking = BookingLike & { id: string; trip_id: string; details?: string };

export interface Leg<B extends TravelBooking = TravelBooking> {
  booking: B;
  kind: LegKind;
  /** When it starts, ms. */
  at: number;
  /** When it's over (arrived, picked up, checked in), ms. */
  done: number;
}

/** What the server says about one booking (GET /api/travel/live). */
export type LegLive = { kind: "train"; status: TrainStatus } | { kind: "flight"; status: FlightStatus } | null;

export interface TravelLive {
  live: Record<string, LegLive>;
  /** The owner's usual Tube lines that aren't on Good Service (empty when fine, off, or unknown). */
  lines: LineStatus[];
  /** Which provider answered for flights. */
  flights: FlightProviderId;
  checked_at: string;
}

export const REFRESH_MS = 150_000;
/** The strip shows from this hour (local) at the latest. */
export const MORNING_HOUR = 5;
export const LEAD_MINUTES = 180;
/** At most this many legs ask for live times at once. */
export const MAX_LIVE = 8;

const COACH = /\b(coach|national express|megabus|flixbus|citylink|stagecoach|oxford tube|greyhound)\b/i;
const FERRY = /\b(ferry|ferries|stena|p ?& ?o|brittany|condor|dfds|wightlink|red funnel|calmac|caledonian macbrayne|hovertravel|irish ferries|northlink)\b/i;

/** What kind of leg a booking is, or null when it isn't travel. */
export function legKind(b: Pick<BookingLike, "kind" | "title" | "provider">): LegKind | null {
  switch (b.kind) {
    case "train":
    case "flight":
    case "car":
    case "hotel":
      return b.kind;
    case "other": {
      const text = `${b.title} ${b.provider}`;
      return FERRY.test(text) ? "ferry" : COACH.test(text) ? "coach" : null;
    }
    default:
      return null;
  }
}

const ms = (v: string | Date | null | undefined) => (v ? Date.parse(typeof v === "string" ? v : v.toISOString()) : NaN);

/** The day's legs, in time order: bookings that start on `date` in the owner's zone. Cancelled ones stay (struck through); archived ones don't. */
export function travelLegs<B extends TravelBooking>(trips: Array<TripLike<B>>, date: string, tz: string): Leg<B>[] {
  const out: Leg<B>[] = [];
  for (const t of trips) {
    if (t.archived_at) continue;
    for (const b of t.bookings) {
      const kind = legKind(b);
      const at = ms(b.starts_at);
      if (!kind || b.archived_at || !Number.isFinite(at)) continue;
      if (zonedParts(new Date(at), tz).date !== date) continue;
      const end = ms(b.ends_at);
      // A journey is over when it arrives; a car pick-up or a check-in when it starts.
      const journey = kind === "train" || kind === "flight" || kind === "coach" || kind === "ferry";
      const done = journey ? (Number.isFinite(end) ? end : at + (kind === "flight" ? 3 : 1) * 3_600_000) : at;
      out.push({ booking: b, kind, at, done });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** When the strip shows on `date`: from 05:00, or 3 hours before the first leg if that's earlier (never before midnight), until the last leg is over. */
export function stripWindow(legs: Leg[], date: string, tz: string): { from: number; until: number } | null {
  const live = legs.filter((l) => l.booking.status !== "cancelled");
  const use = live.length ? live : legs;
  if (!use.length) return null;
  const midnight = zonedToInstant(date, "00:00", tz).getTime();
  const morning = zonedToInstant(date, `${String(MORNING_HOUR).padStart(2, "0")}:00`, tz).getTime();
  const from = Math.max(midnight, Math.min(morning, use[0].at - LEAD_MINUTES * 60_000));
  const until = Math.max(...use.map((l) => l.done));
  return { from, until };
}

export type StripPhase = "before" | "travelling" | "travelled" | "none";

/** Where the day is: not yet (before the window), travelling (the strip), travelled (the summary), or no travel at all. */
export function stripPhase(legs: Leg[], date: string, tz: string, now: Date): StripPhase {
  const w = stripWindow(legs, date, tz);
  if (!w) return "none";
  const t = now.getTime();
  return t < w.from ? "before" : t <= w.until ? "travelling" : "travelled";
}

/** The window a leg asks for live times in, or null for a leg that never has any (car hire, a hotel, a coach, a ferry). */
export function liveWindow(l: Leg): { from: number; until: number } | null {
  if (l.booking.status === "cancelled") return null;
  if (l.kind === "train") return { from: l.at - LIVE_AHEAD_MINUTES * 60_000, until: l.at + LIVE_AFTER_MINUTES * 60_000 };
  if (l.kind === "flight" && bookingFlight(l.booking)) return { from: l.at - FLIGHT_AHEAD_MINUTES * 60_000, until: l.done + FLIGHT_AFTER_MINUTES * 60_000 };
  return null;
}

/** Is this leg asking right now? Same rule the server uses (liveCandidate, flightCandidate). */
export function isLive(l: Leg, now: Date): boolean {
  return l.kind === "train" ? liveCandidate(l.booking, now) : l.kind === "flight" ? flightCandidate(l.booking, now) : false;
}

/** The legs to ask about now, at most MAX_LIVE. */
export const liveLegs = <B extends TravelBooking>(legs: Leg<B>[], now: Date): Leg<B>[] => legs.filter((l) => isLive(l, now)).slice(0, MAX_LIVE);

/**
 * How long until the strip should ask again: REFRESH_MS while a leg is live,
 * else until the next leg's window opens (later today), else null (stop).
 */
export function nextRefresh(legs: Leg[], now: Date): number | null {
  const t = now.getTime();
  if (legs.some((l) => isLive(l, now))) return REFRESH_MS;
  const opens = legs
    .map(liveWindow)
    .filter((w): w is { from: number; until: number } => !!w && w.from > t)
    .map((w) => w.from - t);
  return opens.length ? Math.max(1_000, Math.min(...opens)) : null;
}

// ---------- in words ----------

const hhmm = (at: number, tz: string) => zonedParts(new Date(at), tz).time;

/** Where a leg goes, as people say it: the city ("Bristol"), else the place. */
function toCity(b: BookingLike): string {
  const end = bookingEnd(b);
  const city = end?.city || cityName(b.end_city, b.end_tz);
  // Within one city (Paddington to Heathrow), the place says more than the city.
  if (city && b.end_place.trim() && city === bookingStart(b).city) return b.end_place.trim();
  return city || b.end_place.trim();
}

export interface LegView {
  /** "07:10", in the place's own time. */
  time: string | null;
  /** "07:22" when it's now expected later. */
  expected: string | null;
  /** "GWR to Bristol", "BA 432 to Lisbon", "Hertz car hire", "Memmo Alfama". */
  title: string;
  /** "London Paddington", "Heathrow T5"; for a hotel or car, where it is. */
  from: string;
  /** "Bristol Temple Meads"; empty for a hotel or car. */
  to: string;
  chip: { label: string; tone: ChipTone; title: string } | null;
  /** "Platform 4", "Gate B32 · Terminal 5", "Belt 7". */
  where: string | null;
  /** A quiet line when there's no chip: "Live times unavailable", "Live times from 04:10", "Check in from 15:00". */
  note: string | null;
  reference: string | null;
  /** The whole leg in one line, for the screen reader and Ask: "07:10 to Bristol · 12 min late · platform 4". */
  line: string;
  cancelled: boolean;
  /** It's over: arrived, picked up, checked in. */
  past: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One leg as the strip shows it. `live` is what the server last said (undefined: not asked yet). */
export function legView(l: Leg, live: LegLive | undefined, now: Date, tz: string): LegView {
  const b = l.booking;
  const start = bookingStart(b);
  const time = start.time;
  const cancelled = b.status === "cancelled" || (live?.kind === "train" && live.status.state === "cancelled") || (live?.kind === "flight" && live.status.state === "cancelled");
  const flight = l.kind === "flight" ? bookingFlight(b) : null;
  const city = toCity(b);
  const title = flight ? `${flight.label}${city ? ` to ${city}` : ""}` : bookingName(b);
  const journey = l.kind !== "car" && l.kind !== "hotel";
  // A car or a hotel happens in one place: say what you do there.
  const from = journey ? start.place || start.city : start.place ? `${l.kind === "car" ? "Pick up at" : "Check in at"} ${start.place}` : "";
  const to = journey ? bookingEnd(b)?.place || city : "";
  const past = now.getTime() > l.done;
  const window = liveWindow(l);
  const checked = (iso: string) => zonedParts(new Date(iso), tz).time;

  let chip: LegView["chip"] = null;
  let where: string | null = null;
  let expected: string | null = null;
  if (live?.kind === "train") {
    const c = trainChip(live.status);
    chip = { label: c.label, tone: c.tone, title: `National Rail, checked at ${checked(live.status.checked_at)}` };
    where = c.platform ? `Platform ${c.platform}` : null;
    expected = live.status.state === "late" ? live.status.expected : null;
  } else if (live?.kind === "flight") {
    const s = live.status;
    const c = flightChip(s);
    chip = { label: c.label, tone: c.tone, title: `${PROVIDER_NAME[s.provider]}, checked at ${checked(s.checked_at)}` };
    where =
      s.state === "landed"
        ? s.belt
          ? `Belt ${s.belt}`
          : null
        : s.state === "departed"
          ? s.arrives
            ? `Lands ${s.arrives}`
            : null
          : s.state === "cancelled"
            ? null
            : [s.gate ? `Gate ${s.gate}` : "", s.terminal ? `Terminal ${s.terminal}` : ""].filter(Boolean).join(" · ") || null;
    expected = s.expected;
  } else if (b.status === "cancelled") {
    chip = { label: "Cancelled", tone: "bad", title: "Cancelled by the booking's email" };
  }

  let note: string | null = null;
  if (!chip) {
    if (l.kind === "hotel" && !start.place) note = "Check in";
    else if (l.kind === "car" && !start.place) note = "Pick up";
    else if (window && now.getTime() < window.from && !past) note = `Live times from ${hhmm(window.from, start.tz || tz)}`;
    else if (window && live === null && !past) note = "Live times unavailable";
  }

  // "07:10 to Bristol · 12 min late · platform 4", "BA 432 to Lisbon · on time · gate B32"
  const lead = flight ? title : l.kind === "hotel" ? `${time ? `${time} ` : ""}check in at ${title}` : l.kind === "car" ? `${time ? `${time} ` : ""}${title}` : `${time ? `${time} ` : ""}to ${city || title}`;
  const said = live?.kind === "train" ? statusWords(live.status) : live?.kind === "flight" ? flightWords(live.status) : cancelled ? "cancelled" : null;
  const labels = (s: string | null) => s?.replace(/\b(Platform|Gate|Terminal|Belt|Lands)\b/g, (w) => w.toLowerCase()) ?? null;
  const tail = chip ? [said, labels(where)] : [note === "Live times unavailable" ? "live times unavailable" : null];
  const line = [cap(lead), ...tail].filter(Boolean).join(" · ");

  return { time, expected, title, from, to, chip, where, note, reference: b.reference?.trim() || null, line, cancelled, past };
}

/** The day page's quiet summary once the last leg is in: "Heathrow Express to Heathrow, BA 432 to Lisbon, Hertz car hire and Memmo Alfama." */
export function travelledLine(legs: Leg[]): string {
  const names = legs.filter((l) => l.booking.status !== "cancelled").map((l) => (l.kind === "flight" && bookingFlight(l.booking) ? `${bookingFlight(l.booking)!.label}${toCity(l.booking) ? ` to ${toCity(l.booking)}` : ""}` : bookingName(l.booking)));
  if (!names.length) return "Everything booked for today was cancelled.";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list}.`;
}

/** The quiet line under the strip when the owner's usual lines aren't on Good Service: "Elizabeth line: part suspended · Jubilee line: minor delays". */
export function tubeLine(lines: LineStatus[]): string | null {
  return lines.length ? lines.slice(0, 3).map(lineLine).join(" · ") : null;
}
