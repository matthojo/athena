/**
 * Live flights, behind one seam: a FlightProvider answers "how is this
 * flight booking running?" and flightStatus asks the provider in use. Today
 * that's OpenSky, the open ADS-B network's live positions, which needs no key.
 * Another provider (one with schedules, gates and terminals) slots in by
 * implementing FlightProvider and being passed to flightStatus, or set as
 * DEFAULT_PROVIDER.
 *
 * OpenSky: Athena asks for the box around the airport a flight leaves from
 * (or, near landing, the one it lands at) and looks for the flight's callsign
 * ("BA 432" flies as BAW432). That says on the ground, departed or landed; it
 * has no schedule, gate or terminal, so the terminal comes from the booking
 * ("Heathrow T5"). A small box costs one of the 400 credits an anonymous
 * caller gets a day.
 *
 * Everything goes through publicFetch (the SSRF guard: https only, every
 * address checked as it's connected). Answers are cached in memory for 2.5
 * minutes, each request gives up after 5 seconds, and when OpenSky says slow
 * down (429, or its remaining credits running low) it's left alone until it
 * says to try again. Any failure is null: the strip says "Live times
 * unavailable" and the push goes as it would have.
 *
 * What leaves Athena: a box of latitude and longitude around an airport.
 * Never a flight number, reference, seat, name or booking id.
 */

import type { BookingLike } from "../../lib/trip-text";
import { airportByIata, callsignFor, type Airport } from "../../lib/airports";
import { zonedParts } from "../../lib/dates";
import { bookedTerminal, bookingAirports, bookingFlight, flightCandidate, type FlightProviderId, type FlightState, type FlightStatus } from "../../lib/flight-text";
import { publicFetch } from "./connectors/icons";

export type { FlightStatus } from "../../lib/flight-text";

export const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
export const TIMEOUT_MS = 5_000;
export const OPENSKY_CACHE_MS = 150_000;
/** OpenSky's anonymous credits: stop a little before they run out. */
export const OPENSKY_KEEP_CREDITS = 10;
/** Half the box around an airport, in degrees (about 20 km north to south). */
const BOX = { lat: 0.18, lon: 0.28 };

export interface FlightDeps {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: Date;
}

/** The seam: one live-flights provider. `status` is only called for a flight booking inside its live window. */
export interface FlightProvider {
  id: FlightProviderId;
  status(b: BookingLike & { details?: string }, deps: FlightDeps & { now: Date }): Promise<FlightStatus | null>;
}

// ---------- cache and limits ----------

const cache = new Map<string, { at: number; value: unknown }>();
/** Provider → when to ask again after it said slow down. */
const resting = new Map<string, number>();

/** For tests: start from nothing. */
export function clearFlightCache(): void {
  cache.clear();
  resting.clear();
}

async function cachedJson(provider: string, cacheKey: string, keepMs: number, url: string, headers: Record<string, string>, deps: FlightDeps): Promise<unknown | null> {
  const now = (deps.now ?? new Date()).getTime();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < keepMs) return hit.value;
  if ((resting.get(provider) ?? 0) > now) return null;
  const host = new URL(url).host;
  try {
    const res = await (deps.fetch ?? publicFetch)(url, { headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    if (res.status === 429 || (provider === "opensky" && Number.isFinite(remaining) && res.headers.has("x-rate-limit-remaining") && remaining <= OPENSKY_KEEP_CREDITS)) {
      const after = Number(res.headers.get("x-rate-limit-retry-after-seconds") ?? res.headers.get("retry-after"));
      resting.set(provider, now + (Number.isFinite(after) && after > 0 ? after * 1000 : 15 * 60_000));
      if (res.status === 429) {
        console.error(`Athena live flights: ${host} asked to slow down`);
        await res.body?.cancel();
        return null;
      }
    }
    if (!res.ok) {
      console.error(`Athena live flights: ${host} answered ${res.status}`);
      await res.body?.cancel();
      if (res.status === 404) cache.set(cacheKey, { at: now, value: null });
      return null;
    }
    if (res.status === 204) {
      cache.set(cacheKey, { at: now, value: null });
      return null;
    }
    const value = (await res.json()) as unknown;
    if (cache.size > 200) cache.clear();
    cache.set(cacheKey, { at: now, value });
    return value;
  } catch (error) {
    console.error(`Athena live flights: ${host} didn't answer`, error instanceof Error ? error.name : "");
    return null;
  }
}

// ---------- OpenSky ----------

/** One state vector: [icao24, callsign, origin_country, time_position, last_contact, longitude, latitude, baro_altitude, on_ground, velocity, …]. */
type StateVector = [string, string | null, string, number | null, number, number | null, number | null, number | null, boolean, number | null, ...unknown[]];

/** The aircraft flying as this callsign in OpenSky's answer, or null. */
export function findState(raw: unknown, callsign: string): { onGround: boolean; speed: number; seenAt: number } | null {
  const states = (raw as { states?: unknown } | null)?.states;
  if (!Array.isArray(states)) return null;
  for (const s of states as StateVector[]) {
    if (!Array.isArray(s) || typeof s[1] !== "string") continue;
    if (s[1].trim().toUpperCase() !== callsign) continue;
    return { onGround: s[8] === true, speed: typeof s[9] === "number" ? s[9] : 0, seenAt: typeof s[4] === "number" ? s[4] * 1000 : 0 };
  }
  return null;
}

function boxUrl(a: Airport): string {
  const u = new URL(OPENSKY_STATES_URL);
  u.searchParams.set("lamin", (a.lat - BOX.lat).toFixed(2));
  u.searchParams.set("lomin", (a.lon - BOX.lon).toFixed(2));
  u.searchParams.set("lamax", (a.lat + BOX.lat).toFixed(2));
  u.searchParams.set("lomax", (a.lon + BOX.lon).toFixed(2));
  return u.toString();
}

/**
 * What OpenSky's box says about a flight, given where the box is and the
 * booked times. On the ground at the airport it leaves from: nothing to say
 * before it's due, "delayed" once it's 15 minutes past. In the air near
 * either airport: departed. On the ground where it lands: landed.
 */
export function readOpenSky(
  seen: { onGround: boolean; speed: number } | null,
  at: "from" | "to",
  ctx: { flight: string; leaves: number; now: Date; scheduled: string | null; terminal: string | null },
): FlightStatus | null {
  if (!seen) return null;
  let state: FlightState | null = null;
  if (at === "to") state = seen.onGround ? "landed" : "departed";
  else if (!seen.onGround) state = "departed";
  else if (ctx.now.getTime() > ctx.leaves + 15 * 60_000) state = "delayed";
  if (!state) return null;
  return {
    provider: "opensky",
    flight: ctx.flight,
    state,
    late: 0,
    scheduled: ctx.scheduled,
    expected: null,
    arrives: null,
    gate: null,
    terminal: state === "delayed" ? ctx.terminal : null,
    belt: null,
    checked_at: ctx.now.toISOString(),
  };
}

async function openSkyStatus(b: BookingLike & { details?: string }, deps: FlightDeps & { now: Date }): Promise<FlightStatus | null> {
  const f = bookingFlight(b)!;
  const callsign = callsignFor(f);
  const { from, to } = bookingAirports(b);
  if (!callsign) return null;
  const now = deps.now;
  const leaves = Date.parse(String(b.starts_at));
  const lands = b.ends_at ? Date.parse(String(b.ends_at)) : leaves + 3 * 3_600_000;
  // Near landing, the airport it lands at; else (from 45 minutes before it's due to leave) the one it leaves from.
  const at: "from" | "to" | null = now.getTime() >= lands - 45 * 60_000 ? "to" : now.getTime() >= leaves - 45 * 60_000 && now.getTime() <= leaves + 2 * 3_600_000 ? "from" : null;
  const airport = at === "to" ? (to ? airportByIata(to) : null) : at === "from" ? (from ? airportByIata(from) : null) : null;
  if (!at || !airport) return null;
  const raw = await cachedJson("opensky", `opensky:${airport.icao}`, OPENSKY_CACHE_MS, boxUrl(airport), {}, deps);
  return readOpenSky(findState(raw, callsign), at, { flight: f.label, leaves, now, scheduled: b.start_tz ? zonedParts(new Date(leaves), b.start_tz).time : null, terminal: bookedTerminal(b) });
}

export const OPENSKY: FlightProvider = { id: "opensky", status: openSkyStatus };

/** The provider flights use. */
export const DEFAULT_PROVIDER: FlightProvider = OPENSKY;

/**
 * Live status for a flight booking, or null: not a flight between 3 hours
 * before and 45 minutes after it lands, no flight number, an airport we can't
 * place, or the provider has nothing. Never throws.
 */
export async function flightStatus(b: BookingLike & { details?: string }, deps: FlightDeps = {}, provider: FlightProvider = DEFAULT_PROVIDER): Promise<FlightStatus | null> {
  const now = deps.now ?? new Date();
  if (!flightCandidate(b, now)) return null;
  try {
    return await provider.status(b, { ...deps, now });
  } catch {
    return null;
  }
}
