/**
 * Live flights in words: the shape netlify/lib/live-flights.ts returns, and
 * what the push, the briefing, Ask and the Travelling today strip say about
 * it. Pure (no Node, DOM or network), like lib/live-travel-text.ts for trains.
 *
 *   push:     "BA 432 to Lisbon: on time, gate B32, terminal 5"
 *   briefing: "BA 432 Heathrow to Lisbon at 10:40: on time, gate B32, terminal 5, ref K7Q2XB"
 *   strip:    a chip ("On time", "25 min late", "Boarding", "Departed", "Landed") and "Gate B32 · Terminal 5"
 *
 * OpenSky (the provider today) says delayed, departed or landed; the words for
 * on time, late, boarding, gates and belts are here for a provider that knows them.
 */

import { bookingLine, bookingPush, bookingStart, bookingEnd, cityName, type BookingLike } from "./trip-text";
import { airportFor, flightNumberIn, terminalIn, type FlightNumber } from "./airports";

/** Which provider answered (netlify/lib/live-flights.ts FlightProvider). Add an id here with a new provider. */
export type FlightProviderId = "opensky";

export type FlightState = "on_time" | "late" | "delayed" | "cancelled" | "boarding" | "departed" | "landed" | "diverted";

/** Where a flight is, from the live-flights provider (OpenSky today). */
export interface FlightStatus {
  provider: FlightProviderId;
  /** "BA 432" */
  flight: string;
  state: FlightState;
  /** Minutes late against the booked time: leaving (before it goes), else arriving. 0 when on time or unknown. */
  late: number;
  /** "10:40", the booked departure in the airport's own time. */
  scheduled: string | null;
  /** "11:05" when it's now expected to leave later; null otherwise. */
  expected: string | null;
  /** "13:20", when it's expected to land (or landed), in the arrival airport's time. */
  arrives: string | null;
  gate: string | null;
  terminal: string | null;
  /** The baggage belt, once landed, for a provider that knows it. */
  belt: string | null;
  /** When the provider was asked (ISO). */
  checked_at: string;
}

/** Live times for a flight show from this long before it leaves (the push goes 3 hours before)… */
export const FLIGHT_AHEAD_MINUTES = 180;
/** …until this long after it's due to land. */
export const FLIGHT_AFTER_MINUTES = 45;

const ms = (v: string | Date | null | undefined) => (v ? Date.parse(typeof v === "string" ? v : v.toISOString()) : NaN);

/** The flight number a flight booking carries: its title first ("BA 432"), then its provider and details. */
export function bookingFlight(b: Pick<BookingLike, "kind" | "title" | "provider"> & { details?: string }): FlightNumber | null {
  if (b.kind !== "flight") return null;
  return flightNumberIn(b.title, b.details, b.provider);
}

/** A flight booking worth asking about: has a number and a time, isn't cancelled, and it's between 3 hours before and 45 minutes after it lands. */
export function flightCandidate(b: BookingLike & { details?: string }, now: Date): boolean {
  if (b.kind !== "flight" || b.status === "cancelled" || b.archived_at || !b.starts_at || !bookingFlight(b)) return false;
  const leaves = ms(b.starts_at);
  const lands = Number.isFinite(ms(b.ends_at)) ? ms(b.ends_at) : leaves + 3 * 3_600_000;
  return now.getTime() >= leaves - FLIGHT_AHEAD_MINUTES * 60_000 && now.getTime() <= lands + FLIGHT_AFTER_MINUTES * 60_000;
}

/** The airports a flight booking runs between (IATA codes), from its place then city names. */
export function bookingAirports(b: Pick<BookingLike, "start_place" | "start_city" | "end_place" | "end_city">): { from: string | null; to: string | null } {
  return { from: airportFor(b.start_place, b.start_city)?.iata ?? null, to: airportFor(b.end_place, b.end_city)?.iata ?? null };
}

/** The terminal the booking itself names ("Heathrow T5"), when the provider gives none. */
export const bookedTerminal = (b: Pick<BookingLike, "start_place">): string | null => terminalIn(b.start_place);

/** "on time", "25 min late", "delayed", "cancelled", "boarding", "departed", "landed", "diverted". */
export function flightWords(s: Pick<FlightStatus, "state" | "late">): string {
  switch (s.state) {
    case "late":
      return `${s.late} min late`;
    case "on_time":
      return "on time";
    default:
      return s.state;
  }
}

/** "gate B32, terminal 5" (lower case, for sentences); "belt 7" once landed. Empty when there's nothing. */
export function flightWhere(s: FlightStatus): string {
  if (s.state === "cancelled") return "";
  if (s.state === "landed") return s.belt ? `belt ${s.belt}` : "";
  if (s.state === "departed" || s.state === "diverted") return "";
  return [s.gate ? `gate ${s.gate}` : "", s.terminal ? `terminal ${s.terminal}` : ""].filter(Boolean).join(", ");
}

/** "on time, gate B32, terminal 5" */
export function flightPhrase(s: FlightStatus): string {
  const where = flightWhere(s);
  const when = s.state === "departed" && s.arrives ? `departed, lands ${s.arrives}` : s.state === "landed" && s.arrives ? `landed ${s.arrives}` : flightWords(s);
  return where ? `${when}, ${where}` : when;
}

/** Where a flight booking goes, as people say it: "Lisbon". */
export function flightDestination(b: BookingLike): string {
  const end = bookingEnd(b);
  return end?.city || cityName(b.end_city, b.end_tz) || airportFor(b.end_place, b.end_city)?.city || b.end_place.trim();
}

/** "BA 432 to Lisbon: on time, gate B32, terminal 5": the push's first part, and Ask's answer. */
export function flightLiveLine(b: BookingLike, s: FlightStatus): string {
  const to = flightDestination(b);
  return `${s.flight}${to ? ` to ${to}` : ""}: ${flightPhrase(s)}`;
}

/** The push 3 hours before a flight with live times: how it's running first, then the seat and reference. Without them, the push as it was. */
export function flightPush(b: BookingLike, status: FlightStatus | null, ownerTz?: string): { title: string; body: string } {
  const plain = bookingPush(b, ownerTz);
  if (!status) return plain;
  const s = bookingStart(b);
  const parts = [flightLiveLine(b, status), s.time && status.state !== "cancelled" ? `departs ${status.expected ?? s.time}` : "", b.seat ? `seat ${b.seat}` : "", b.reference ? `ref ${b.reference}` : ""].filter(Boolean);
  return { title: plain.title, body: parts.join(" · ") };
}

/** The briefing's line: "BA 432 Heathrow to Lisbon at 10:40: on time, gate B32, terminal 5, ref K7Q2XB". */
export function flightBriefingLine(b: BookingLike, s: FlightStatus): string {
  const start = bookingStart(b);
  const from = airportFor(b.start_place, b.start_city)?.name ?? start.place ?? "";
  const to = flightDestination(b);
  return `${s.flight}${from ? ` ${from}` : ""}${to ? ` to ${to}` : ""}${start.time ? ` at ${start.time}` : ""}: ${flightPhrase(s)}${b.reference ? `, ref ${b.reference}` : ""}`;
}

export type ChipTone = "good" | "warn" | "bad" | "calm";

/** The strip's chip for a flight: its words and colour. */
export function flightChip(s: FlightStatus): { label: string; tone: ChipTone } {
  const words = flightWords(s);
  const tone: ChipTone =
    s.state === "on_time" || s.state === "boarding" ? "good" : s.state === "cancelled" || s.state === "diverted" ? "bad" : s.state === "late" || s.state === "delayed" ? "warn" : "calm";
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone };
}

/** Who to credit, for the chip's tooltip: "OpenSky, checked at 08:41". */
export const PROVIDER_NAME: Record<FlightProviderId, string> = { opensky: "OpenSky" };

// ---------- Ask's flight_status (lib/assistant.ts) ----------

export interface FlightStatusReportDeps {
  now: Date;
  today: string;
  tz: string;
  /** Which provider answers. */
  provider: FlightProviderId;
  lookup: (b: BookingLike) => Promise<FlightStatus | null>;
}

/** What flight_status answers: each flight with its live line, or why there's none. A lookup that fails counts as no answer. */
export async function flightStatusReport(flights: Array<BookingLike & { id?: string; details?: string }>, d: FlightStatusReportDeps): Promise<Record<string, unknown>> {
  const rows = await Promise.all(
    flights.map(async (b) => {
      const ok = flightCandidate(b, d.now);
      const live = ok ? await d.lookup(b).catch(() => null) : null;
      const why = !bookingFlight(b)
        ? "There's no flight number on this booking."
        : !ok
          ? "Live times show from 3 hours before it leaves."
          : `${PROVIDER_NAME[d.provider]} has nothing on this flight right now. It sees a plane once it's moving, from 45 minutes before it's due to leave.`;
      return {
        booking_id: b.id ?? null,
        flight: bookingLine(b, d.today, d.tz),
        ...(live ? { live: flightLiveLine(b, live), source: PROVIDER_NAME[live.provider] } : { live: null, why }),
      };
    }),
  );
  return {
    flights: rows,
    source: PROVIDER_NAME[d.provider],
    ...(rows.length ? {} : { flights_note: "No flights in the next 24 hours." }),
    source_note: "OpenSky has no gates. The terminal is the one on the booking.",
  };
}
