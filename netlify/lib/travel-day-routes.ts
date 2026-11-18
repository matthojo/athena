/**
 * Travelling today over REST, mounted by netlify/functions/api.ts behind the
 * same bearer token:
 *
 *   GET /api/travel/live?ids=<booking id>,…   (at most 8)
 *     → { live: { [id]: { kind: "train", status } | { kind: "flight", status } | null },
 *         lines: LineStatus[], flights: "opensky", checked_at }
 *
 * The app's strip (app/src/components/travel-today.ts) asks once every 2½
 * minutes while a leg is in its live window, for just those legs. Trains go to
 * National Rail (netlify/lib/live-travel.ts), flights to OpenSky
 * (netlify/lib/live-flights.ts), and `lines` is the owner's usual
 * Tube lines that aren't on Good Service (lib/briefing-run.ts loadCommute),
 * so a travel day can say so under the strip. Each lookup fails soft: null.
 */

import { getBooking } from "../../lib/trips";
import { reminderTimeZone } from "../../lib/db";
import { zonedToday } from "../../lib/dates";
import { loadCommute } from "../../lib/briefing-run";
import { MAX_LIVE, type LegLive, type TravelLive } from "../../lib/travel-day";
import { trainStatus } from "./live-travel";
import { DEFAULT_PROVIDER, flightStatus, type FlightProvider } from "./live-flights";

type Reply = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TravelDeps {
  now?: Date;
  getBooking?: typeof getBooking;
  train?: typeof trainStatus;
  flight?: typeof flightStatus;
  provider?: FlightProvider;
  commute?: (today: string) => Promise<Awaited<ReturnType<typeof loadCommute>>>;
  tz?: () => Promise<string>;
}

/** What GET /api/travel/live answers for these booking ids. */
export async function travelLive(ids: string[], deps: TravelDeps = {}): Promise<TravelLive> {
  const now = deps.now ?? new Date();
  const provider = deps.provider ?? DEFAULT_PROVIDER;
  const tz = await (deps.tz ?? reminderTimeZone)().catch(() => "Europe/London");
  const live: Record<string, LegLive> = {};
  await Promise.all(
    ids.map(async (id) => {
      const b = await (deps.getBooking ?? getBooking)(id).catch(() => null);
      if (!b) return void (live[id] = null);
      if (b.kind === "train") {
        const s = await (deps.train ?? trainStatus)(b, { now }).catch(() => null);
        live[id] = s ? { kind: "train", status: s } : null;
      } else if (b.kind === "flight") {
        const s = await (deps.flight ?? flightStatus)(b, { now }, provider).catch(() => null);
        live[id] = s ? { kind: "flight", status: s } : null;
      } else live[id] = null;
    }),
  );
  const lines = await (deps.commute ?? loadCommute)(zonedToday(now, tz)).catch(() => []);
  return { live, lines, flights: provider.id, checked_at: now.toISOString() };
}

/** /api/travel/*; null for anything else. */
export async function handleTravelRoutes(req: Request, url: URL, segments: string[], reply: Reply, deps: TravelDeps = {}): Promise<Response | null> {
  const [, first, second] = segments;
  if (first !== "travel" || second !== "live" || segments.length !== 3) return null;
  if (req.method !== "GET") return reply({ error: "Method not allowed" }, 405);
  const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_LIVE || ids.some((id) => !UUID.test(id))) return reply({ error: `Send ids: 1 to ${MAX_LIVE} booking ids` }, 400);
  return reply(await travelLive(ids, deps));
}
