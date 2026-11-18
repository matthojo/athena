/**
 * Leave by's travel time. Athena has no routing service, so this is the
 * distance between two spots (lib/places-visits.ts metres, from the day's
 * visits and a Place's sealed coordinates or geocoded address, the same
 * spots the maps use) turned into minutes: on foot under 1.5 km, else public
 * transport at city speed with time to get to a stop. "Why am I seeing
 * this?" says it's an estimate.
 */
import { metres } from "../places-visits";
import type { TravelMode } from "./types";

const WALK_METRES = 1_500;
/** 4.8 km/h. */
const WALK_PER_MIN = 80;
/** Door to door across a city: about 18 km/h once moving, plus 10 minutes to get going. */
const TRANSIT_PER_MIN = 300;
const TRANSIT_START = 10;
/** Beyond this it's a journey, not a hop: Trips handles those. */
const MAX_METRES = 60_000;

export function estimateTravel(from: { lat: number; lng: number }, to: { lat: number; lng: number }): { minutes: number; mode: "walk" | "transit"; metres: number } | null {
  const m = metres(from, to);
  if (!Number.isFinite(m) || m > MAX_METRES) return null;
  const up5 = (x: number) => Math.max(5, Math.ceil(x / 5) * 5);
  return m <= WALK_METRES ? { minutes: up5(m / WALK_PER_MIN), mode: "walk", metres: m } : { minutes: up5(TRANSIT_START + m / TRANSIT_PER_MIN), mode: "transit", metres: m };
}

/** On a bike: about 15 km/h, plus 5 minutes to get the bike out and lock it up. */
const CYCLE_PER_MIN = 250;
const CYCLE_START = 5;

/**
 * The estimate for a way of travelling, when no planner answered. A drive
 * gets none: without live traffic a guess would mislead, and Leave by says
 * how to add Google Maps instead. Public transport is the original estimate
 * (on foot when it's under 1.5 km).
 */
export function estimateFor(mode: TravelMode, from: { lat: number; lng: number }, to: { lat: number; lng: number }): { minutes: number; mode: TravelMode } | null {
  if (mode === "drive") return null;
  if (mode === "transit") return estimateTravel(from, to);
  const m = metres(from, to);
  if (!Number.isFinite(m) || m > MAX_METRES) return null;
  const up5 = (x: number) => Math.max(5, Math.ceil(x / 5) * 5);
  return mode === "walk" ? { minutes: up5(m / WALK_PER_MIN), mode } : { minutes: up5(CYCLE_START + m / CYCLE_PER_MIN), mode };
}

/**
 * Which planner times a journey: TfL inside London for public transport, on
 * foot and by bike; Google elsewhere, and for every drive (traffic-aware).
 * "no_key" is a drive with no Google key: never public transport instead.
 * null: no planner, so the distance estimate.
 */
export function plannerFor(mode: TravelMode, ctx: { london: boolean; tfl: boolean; google: boolean }): "tfl" | "google" | "no_key" | null {
  if (mode === "drive") return ctx.google ? "google" : "no_key";
  if (ctx.tfl && ctx.london) return "tfl";
  return ctx.google ? "google" : null;
}

/** The way this journey goes: the event's own choice, else the owner's usual. */
export function travelModeFor(prefs: { travel_mode: TravelMode; travel_by_event: Record<string, TravelMode> }, eventId: string): TravelMode {
  return prefs.travel_by_event[eventId] ?? prefs.travel_mode;
}

/** A drive's one recheck: once the leave time is this close, and while it's still more than 15 minutes away (the nudge comes at 15). */
export const RECHECK_BEFORE_LEAVE_MINUTES = 30;
export const RECHECK_AFTER_LEAVE_MINUTES = 15;
/** No recheck of an answer younger than this: the traffic hasn't had time to change. */
export const RECHECK_MIN_AGE_MINUTES = 15;

/**
 * Is a drive's cached Google answer due its one traffic recheck? Only a
 * Google drive, only once (`rechecked`), when the leave time it gives is
 * 30 to 15 minutes away, and the answer is at least 15 minutes old. It
 * always lands before Leave by's nudge (15 minutes before leaving), so the
 * nudge is made with the rechecked time, never an older one. `spare` is Leave by's minutes to spare (rules.ts).
 */
export function recheckDue(
  hit: { at: number; route: { minutes: number; mode: TravelMode; source: string } | null; rechecked?: boolean } | null,
  arriveBy: number,
  now: number,
  spare: number,
): boolean {
  if (!hit?.route || hit.rechecked || hit.route.mode !== "drive" || hit.route.source !== "google") return false;
  const untilLeave = arriveBy - (hit.route.minutes + spare) * 60_000 - now;
  return untilLeave > RECHECK_AFTER_LEAVE_MINUTES * 60_000 && untilLeave <= RECHECK_BEFORE_LEAVE_MINUTES * 60_000 && now - hit.at >= RECHECK_MIN_AGE_MINUTES * 60_000;
}
