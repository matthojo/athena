/**
 * Live trains and Tube lines in words: the shapes netlify/lib/live-travel.ts
 * returns, and what the push, the briefing, Ask and the Trips card say about
 * them. Pure (no Node, DOM or network), so the server and the app word a
 * delay the same way.
 *
 *   push:     "07:10 to Bristol Temple Meads: on time, platform 4"
 *             "07:10 to Bristol Temple Meads: 12 min late, platform 4"
 *   briefing: "07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref TL4K88QW"
 *             "Elizabeth line: part suspended"
 *   card:     a chip, "12 min late" and "Platform 4"
 */

import { zonedParts } from "./dates";
import { bookingLine, bookingPush, bookingStart, type BookingLike } from "./trip-text";
import { crsFor, stationName } from "./stations";

/** Where a train is, from the departure board at the station it leaves from. */
export interface TrainStatus {
  /** The station it leaves from, and the one the booking is to (when known). */
  from: string;
  to: string | null;
  /** "07:10", the booked time. */
  scheduled: string;
  /** "07:22" when the board expects it later; null when on time, cancelled or unknown. */
  expected: string | null;
  /** Minutes late (0 when on time). */
  late: number;
  state: "on_time" | "late" | "delayed" | "cancelled";
  platform: string | null;
  /** Where the booking goes: "Bristol Temple Meads". */
  destination: string;
  /** National Rail's reason for a delay or cancellation, when it gives one. */
  reason: string | null;
  /** When the board was read (ISO). */
  checked_at: string;
}

/** A TfL line that isn't running normally. */
export interface LineStatus {
  id: string;
  /** "Elizabeth line", "DLR". */
  name: string;
  /** TfL's severity: 10 is Good Service; lower is worse. */
  severity: number;
  /** TfL's words, as said: "part suspended", "minor delays". */
  description: string;
  reason: string | null;
}

/** Live times only make sense this close to leaving: the boards show about this far ahead. */
export const LIVE_AHEAD_MINUTES = 180;
/** And for a little while after, in case it's late. */
export const LIVE_AFTER_MINUTES = 30;

/** Bookings that get live times: a train in Great Britain, not cancelled, leaving within the next 3 hours (or just gone). */
export function liveCandidate(b: BookingLike, now: Date): boolean {
  if (b.kind !== "train" || b.status === "cancelled" || b.archived_at || !b.starts_at) return false;
  if (b.start_tz && b.start_tz !== "Europe/London") return false;
  const at = Date.parse(typeof b.starts_at === "string" ? b.starts_at : b.starts_at.toISOString());
  return at >= now.getTime() - LIVE_AFTER_MINUTES * 60_000 && at <= now.getTime() + LIVE_AHEAD_MINUTES * 60_000;
}

/** The station codes a train booking runs between, from its place (then its city) names. */
export function bookingStations(b: Pick<BookingLike, "start_place" | "start_city" | "end_place" | "end_city">): { from: string | null; to: string | null } {
  return { from: crsFor(b.start_place) ?? crsFor(b.start_city), to: crsFor(b.end_place) ?? crsFor(b.end_city) };
}

/** The booked departure as the board shows it: "07:10", UK time. */
export function boardTime(b: BookingLike): string | null {
  if (!b.starts_at) return null;
  return zonedParts(new Date(typeof b.starts_at === "string" ? b.starts_at : b.starts_at.toISOString()), "Europe/London").time;
}

/** "on time", "12 min late", "delayed", "cancelled". */
export function statusWords(s: Pick<TrainStatus, "state" | "late">): string {
  switch (s.state) {
    case "on_time":
      return "on time";
    case "late":
      return `${s.late} min late`;
    case "delayed":
      return "delayed";
    case "cancelled":
      return "cancelled";
  }
}

/** "on time, platform 4", "12 min late", "cancelled". */
export function statusPhrase(s: TrainStatus): string {
  return `${statusWords(s)}${s.platform && s.state !== "cancelled" ? `, platform ${s.platform}` : ""}`;
}

/** "07:10 to Bristol Temple Meads: on time, platform 4": the push's first part, and Ask's answer. */
export function trainLiveLine(s: TrainStatus): string {
  return `${s.scheduled} to ${s.destination}: ${statusPhrase(s)}`;
}

/** The booking's own name for where it's going, else the board's. */
export function destinationName(b: Pick<BookingLike, "end_place" | "end_city">, to: string | null, board: string | null): string {
  return (to && stationName(to)) || b.end_place.trim() || board || b.end_city.trim() || "";
}

/**
 * The 30-minute push for a train with live times: the status first, then
 * what you need at the door. Without them, the push as it was (trip-text's bookingPush).
 */
export function trainPush(b: BookingLike, status: TrainStatus | null, ownerTz?: string): { title: string; body: string } {
  const plain = bookingPush(b, ownerTz);
  if (!status) return plain;
  const parts = [trainLiveLine(status), b.seat ? `seat ${b.seat}` : "", b.reference ? `ref ${b.reference}` : ""].filter(Boolean);
  return { title: plain.title, body: parts.join(" · ") };
}

/** The briefing's line for a train today with live times: "07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref TL4K88QW". */
export function trainBriefingLine(b: BookingLike, s: TrainStatus): string {
  const from = stationName(s.from) ?? (bookingStart(b).place || s.from);
  return `${s.scheduled} ${from} to ${s.destination}: ${statusPhrase(s)}${b.reference ? `, ref ${b.reference}` : ""}`;
}

/** "Elizabeth line: part suspended". */
export function lineLine(l: LineStatus): string {
  return `${l.name}: ${l.description}`;
}

/** The card's chip: what it says, and its colour. */
export function trainChip(s: TrainStatus): { label: string; platform: string | null; tone: "good" | "warn" | "bad" } {
  const words = statusWords(s);
  return {
    label: words.charAt(0).toUpperCase() + words.slice(1),
    platform: s.state === "cancelled" ? null : s.platform,
    tone: s.state === "on_time" ? "good" : s.state === "cancelled" ? "bad" : "warn",
  };
}

// ---------- Ask's train_status (lib/assistant.ts) ----------

export interface TrainStatusReportDeps {
  now: Date;
  /** The owner's today and zone, for the plain booking line. */
  today: string;
  tz: string;
  /** Which halves have keys (netlify/lib/live-travel.ts liveTravelConfigured). */
  on: { trains: boolean; lines: boolean };
  /** A booking's live status, or null. */
  lookup: (b: BookingLike) => Promise<TrainStatus | null>;
  /** The owner's lines that aren't on Good Service. */
  commute: () => Promise<LineStatus[]>;
}

/**
 * What train_status answers: each train with its live line, or why there's
 * none, and the owner's lines that aren't on Good Service. A lookup that
 * fails counts as no answer, never an error.
 */
export async function trainStatusReport(trains: Array<BookingLike & { id?: string }>, d: TrainStatusReportDeps): Promise<Record<string, unknown>> {
  const rows = await Promise.all(
    trains.map(async (b) => {
      const live = d.on.trains ? await d.lookup(b).catch(() => null) : null;
      const why = !d.on.trains
        ? "Live train times aren't switched on (no Rail Data Marketplace key)."
        : !liveCandidate(b, d.now)
          ? "Live times show from 3 hours before it leaves."
          : "National Rail has nothing on it right now.";
      return {
        booking_id: b.id ?? null,
        train: bookingLine(b, d.today, d.tz),
        ...(live ? { live: trainLiveLine(live), ...(live.reason ? { reason: live.reason } : {}) } : { live: null, why }),
      };
    }),
  );
  const lines = d.on.lines ? (await d.commute().catch(() => [])).map(lineLine) : [];
  return {
    trains: rows,
    ...(rows.length ? {} : { trains_note: "No train bookings in the next 24 hours." }),
    ...(d.on.lines ? { lines_not_good: lines } : { lines_note: "Tube line status isn't switched on (no TfL key)." }),
  };
}
