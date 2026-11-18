/**
 * Travelling today's data: the day's legs from the trips this device already
 * has (db/trips.ts, so they show offline), and live times for the legs in
 * their window from GET /api/travel/live (netlify/lib/travel-day-routes.ts).
 * Sample mode answers from db/sample-trips.ts, without a key or a request.
 * Null when there's nothing to say: offline, or the request fails.
 */

import { isSampleMode, request } from "./api";
import { loadTrips } from "./trips";
import { sampleTravelLive } from "./sample-trips";
import { deviceZone } from "../lib/time";
import { travelLegs, type Leg, type TravelLive } from "../../../lib/travel-day";
import type { Booking } from "../types";

export type DayLeg = Leg<Booking>;

export async function loadDayLegs(date: string): Promise<DayLeg[]> {
  const { items } = await loadTrips();
  return travelLegs(items, date, deviceZone());
}

export async function loadTravelLive(legs: DayLeg[], now = new Date()): Promise<TravelLive | null> {
  if (!legs.length) return null;
  if (isSampleMode()) return sampleTravelLive(legs.map((l) => l.booking), now);
  try {
    return await request<TravelLive>(`/travel/live?ids=${legs.map((l) => encodeURIComponent(l.booking.id)).join(",")}`);
  } catch {
    return null;
  }
}
