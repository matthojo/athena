/**
 * Leave by's travel time from a live planner, when one is set up:
 *
 *  - In London (both ends inside Greater London): the TfL Journey Planner,
 *    with the same TfL key as the line statuses (netlify/lib/live-travel.ts),
 *    walking and public transport, arriving by the event's start.
 *  - Elsewhere, with a Google Maps key: Google's Routes API
 *    (computeRoutes), TRANSIT arriving by the start, then WALK if transit has
 *    no route.
 *  - The owner's way of travelling (Settings → Notifications, or the event's
 *    own choice; lib/proactive/travel.ts plannerFor): on foot and by bike go
 *    to TfL in London and Google elsewhere (WALK, BICYCLE). A drive always
 *    goes to Google (DRIVE, TRAFFIC_AWARE, leaving now), never TfL; with no
 *    Google key it's "no_key", and Leave by says how to add one rather than
 *    timing it as public transport.
 *  - Otherwise null, and the caller keeps its distance estimate
 *    (lib/proactive/travel.ts), labelled as one.
 *
 * Keys come from Sources (lib/presets/live-travel.ts) through travelKey()
 * (netlify/lib/travel-key.ts), else ATHENA_TFL_KEY and
 * ATHENA_GOOGLE_ROUTES_KEY in the environment.
 *
 * What leaves Athena: the two coordinates and the arrival time (plus the
 * key). No name, address or event title. A TfL answer is cached for 10
 * minutes per event and a Google one until the event starts (a drive is
 * asked once more when its leave time is 30 minutes away: recheckDue) (the `settings` row `leave_by_route`: minutes, mode and
 * source only, no coordinates), and the caller asks only for the next event,
 * within 90 minutes of it, once per 5-minute run.
 */
import { qRaw } from "../../../lib/db";
import { travelKey, type TravelKeyDeps } from "../travel-key";
import { plannerFor, recheckDue } from "../../../lib/proactive/travel";
import { LEAVE_SPARE_MINUTES } from "../../../lib/proactive/rules";
import type { TravelMode } from "../../../lib/proactive/types";

export const TFL_JOURNEY_URL = "https://api.tfl.gov.uk/Journey/JourneyResults";
export const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
export const ROUTE_CACHE_MS = 10 * 60_000;
export const ROUTE_WITHIN_MS = 90 * 60_000;
const TIMEOUT_MS = 5_000;

export type RouteSource = "tfl" | "google";
export interface Route {
  minutes: number;
  mode: TravelMode;
  source: RouteSource;
  /** A drive's answer from its one traffic recheck near the leave time (recheckDue). */
  rechecked?: boolean;
}

type Spot = { lat: number; lng: number };

export interface RouteDeps {
  fetch?: typeof fetch;
  now?: Date;
  env?: (name: string) => string | undefined;
  /** The keys stored in Sources; tests pass their own (travel-key.ts). */
  stored?: TravelKeyDeps["stored"];
  cache?: { get(key: string): Promise<{ at: number; route: Route | null; rechecked?: boolean } | null>; set(key: string, v: { at: number; route: Route | null; rechecked?: boolean }): Promise<void> };
}

/** Greater London, roughly: TfL's planner covers it. */
export const inLondon = (p: Spot) => p.lat > 51.28 && p.lat < 51.7 && p.lng > -0.52 && p.lng < 0.34;

const fixed = (n: number) => n.toFixed(5);

/** The London wall clock TfL wants: "yyyyMMdd" and "HHmm". */
function londonClock(at: Date): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}${p.month}${p.day}`, time: `${p.hour}${p.minute}` };
}

/** A TfL JourneyResults answer → the quickest journey. */
export function readTfl(raw: unknown): Route | null {
  const journeys = (raw as { journeys?: Array<{ duration?: number; legs?: Array<{ mode?: { id?: string } }> }> })?.journeys;
  if (!Array.isArray(journeys)) return null;
  const best = journeys.filter((j) => typeof j.duration === "number" && j.duration > 0).sort((a, b) => a.duration! - b.duration!)[0];
  if (!best) return null;
  const walk = (best.legs ?? []).every((l) => l.mode?.id === "walking");
  return { minutes: Math.round(best.duration!), mode: walk ? "walk" : "transit", source: "tfl" };
}

/** A computeRoutes answer ("duration": "1534s") → minutes. */
export function readGoogle(raw: unknown, mode: TravelMode): Route | null {
  const d = (raw as { routes?: Array<{ duration?: string }> })?.routes?.[0]?.duration;
  const s = typeof d === "string" ? Number(d.replace(/s$/, "")) : NaN;
  return Number.isFinite(s) && s > 0 ? { minutes: Math.max(1, Math.round(s / 60)), mode, source: "google" } : null;
}

async function getJson(f: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown | null> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`Athena leave by: ${new URL(url).host} answered ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (error) {
    console.error(`Athena leave by: ${new URL(url).host} didn't answer`, error instanceof Error ? error.name : "");
    return null;
  }
}

const TFL_MODES: Partial<Record<TravelMode, string>> = { walk: "walking", cycle: "cycle" };

async function tfl(from: Spot, to: Spot, arriveBy: Date, appKey: string, f: typeof fetch, how: TravelMode = "transit"): Promise<Route | null> {
  const url = new URL(`${TFL_JOURNEY_URL}/${fixed(from.lat)},${fixed(from.lng)}/to/${fixed(to.lat)},${fixed(to.lng)}`);
  const { date, time } = londonClock(arriveBy);
  url.searchParams.set("date", date);
  url.searchParams.set("time", time);
  url.searchParams.set("timeIs", "Arriving");
  url.searchParams.set("mode", TFL_MODES[how] ?? "walking,tube,bus,dlr,overground,elizabeth-line,national-rail,tram");
  url.searchParams.set("app_key", appKey);
  const r = readTfl(await getJson(f, url.toString(), { headers: { Accept: "application/json" } }));
  return r && TFL_MODES[how] ? { ...r, mode: how } : r;
}

/** The body computeRoutes is sent for each way of travelling. A drive is traffic-aware, leaving now (Google takes no arrival time for one). */
export function googleBody(from: Spot, to: Spot, arriveBy: Date, mode: "TRANSIT" | "WALK" | "BICYCLE" | "DRIVE"): Record<string, unknown> {
  const point = (p: Spot) => ({ location: { latLng: { latitude: Number(fixed(p.lat)), longitude: Number(fixed(p.lng)) } } });
  return {
    origin: point(from),
    destination: point(to),
    travelMode: mode,
    ...(mode === "TRANSIT" ? { arrivalTime: arriveBy.toISOString() } : {}),
    ...(mode === "DRIVE" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
  };
}

async function google(from: Spot, to: Spot, arriveBy: Date, apiKey: string, f: typeof fetch, how: TravelMode = "transit"): Promise<Route | null> {
  const ask = (mode: "TRANSIT" | "WALK" | "BICYCLE" | "DRIVE") =>
    getJson(f, GOOGLE_ROUTES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "routes.duration" },
      body: JSON.stringify(googleBody(from, to, arriveBy, mode)),
    });
  if (how === "drive") return readGoogle(await ask("DRIVE"), "drive");
  if (how === "cycle") return readGoogle(await ask("BICYCLE"), "cycle");
  if (how === "walk") return readGoogle(await ask("WALK"), "walk");
  return readGoogle(await ask("TRANSIT"), "transit") ?? readGoogle(await ask("WALK"), "walk");
}

const ROUTE_KEY = "leave_by_route";
/** The real cache: one `settings` row, holding the latest answer per event (no coordinates). */
const dbCache: NonNullable<RouteDeps["cache"]> = {
  async get(key) {
    const [row] = await qRaw<{ value: { key?: string; at?: number; route?: Route | null; rechecked?: boolean } }>(`SELECT value FROM settings WHERE key = $1`, [ROUTE_KEY]);
    return row?.value?.key === key && typeof row.value.at === "number" ? { at: row.value.at, route: row.value.route ?? null, rechecked: row.value.rechecked === true } : null;
  },
  async set(key, v) {
    await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ROUTE_KEY, JSON.stringify({ key, ...v })]);
  },
};

/**
 * The live route for one event, or null (no planner set up, not within 90
 * minutes, or the planner didn't answer). `eventKey` keys the 10-minute cache.
 */
export async function liveRoute(from: Spot, to: Spot, arriveBy: Date, eventKey: string, deps: RouteDeps = {}, how: TravelMode = "transit"): Promise<Route | null | "no_key"> {
  const now = (deps.now ?? new Date()).getTime();
  if (arriveBy.getTime() - now > ROUTE_WITHIN_MS || arriveBy.getTime() <= now) return null;
  const keys = { env: deps.env, stored: deps.stored, now: deps.now };
  const [tflKey, googleKey] = await Promise.all([travelKey("tfl", keys), travelKey("google-routes", keys)]);
  const planner = plannerFor(how, { london: inLondon(from) && inLondon(to), tfl: !!tflKey, google: !!googleKey });
  if (planner === "no_key") return "no_key";
  if (!planner) return null;
  const useTfl = planner === "tfl";
  const cache = deps.cache ?? dbCache;
  // Each way of travelling is its own answer: changing an event from transit to drive asks again.
  if (how !== "transit") eventKey = `${eventKey}:${how}`;
  const hit = await cache.get(eventKey).catch(() => null);
  const f = deps.fetch ?? fetch;
  // A drive is asked once more, with the traffic near the leave time: one extra billed call per event and way of travelling, never more.
  if (!useTfl && hit && recheckDue(hit, arriveBy.getTime(), now, LEAVE_SPARE_MINUTES)) {
    const fresh = await google(from, to, arriveBy, googleKey!, f, how);
    // No answer: keep the first one, and don't ask again.
    const route = fresh ? { ...fresh, rechecked: true } : hit.route;
    await cache.set(eventKey, { at: now, route, rechecked: true }).catch(() => undefined);
    return route;
  }
  // TfL is free, so its answer is refreshed every 10 minutes. Google is billed, so it's asked once per event (and a drive once more, above) and kept until it starts.
  if (hit && (now - hit.at < ROUTE_CACHE_MS || (!useTfl && hit.route?.source !== "tfl"))) return hit.route;
  const route = useTfl ? await tfl(from, to, arriveBy, tflKey!, f, how) : await google(from, to, arriveBy, googleKey!, f, how);
  await cache.set(eventKey, { at: now, route }).catch(() => undefined);
  return route;
}
