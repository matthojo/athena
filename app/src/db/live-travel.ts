/**
 * A train booking's live status for the Trips card (GET /api/bookings/:id/live,
 * netlify/lib/live-travel.ts). Only asked for a train leaving in the next 3
 * hours. Null whenever there's nothing to show: the feature is off, the board
 * has nothing, we're offline, or the request fails. Sample mode answers from
 * the sample fixture (db/sample-trips.ts) without a key or a request.
 *
 * Answers are kept for 2 minutes, like the server's, so repainting a trip
 * doesn't ask again.
 */

import { isSampleMode, request } from "./api";
import { sampleFlightStatus, sampleTrainStatus } from "./sample-trips";
import { liveCandidate, type TrainStatus } from "../../../lib/live-travel-text";
import { flightCandidate, type FlightStatus } from "../../../lib/flight-text";
import type { TravelLive } from "../../../lib/travel-day";
import type { Booking } from "../types";

const KEEP_MS = 2 * 60_000;
const kept = new Map<string, { at: number; status: TrainStatus | null }>();

/** Worth asking about: a train leaving within 3 hours (or just gone). */
export const wantsLiveStatus = (b: Booking, now = new Date()): boolean => liveCandidate(b, now);

export async function loadTrainStatus(b: Booking): Promise<TrainStatus | null> {
  if (!wantsLiveStatus(b)) return null;
  if (isSampleMode()) return sampleTrainStatus(b);
  const hit = kept.get(b.id);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.status;
  try {
    const { status } = await request<{ status: TrainStatus | null }>(`/bookings/${encodeURIComponent(b.id)}/live`);
    kept.set(b.id, { at: Date.now(), status });
    return status;
  } catch {
    return null;
  }
}

// ---------- flights (OpenSky, through GET /api/travel/live) ----------

const keptFlights = new Map<string, { at: number; status: FlightStatus | null }>();

/** Worth asking about: a flight from 3 hours before it leaves until 45 minutes after it lands. */
export const wantsFlightStatus = (b: Booking, now = new Date()): boolean => flightCandidate(b, now);

export async function loadFlightStatus(b: Booking): Promise<FlightStatus | null> {
  if (!wantsFlightStatus(b)) return null;
  if (isSampleMode()) return sampleFlightStatus(b);
  const hit = keptFlights.get(b.id);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.status;
  try {
    const { live } = await request<TravelLive>(`/travel/live?ids=${encodeURIComponent(b.id)}`);
    const one = live[b.id];
    const status = one?.kind === "flight" ? one.status : null;
    keptFlights.set(b.id, { at: Date.now(), status });
    return status;
  } catch {
    return null;
  }
}
