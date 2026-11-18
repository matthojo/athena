/**
 * Live flight times: OpenSky, which needs no key. Joined into
 * CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * It feeds no collection and isn't offered to Claude: Athena reads it itself,
 * for the Travelling today strip, the push before a flight, the briefing and
 * Ask's flight_status (netlify/lib/live-flights.ts, where another provider
 * would plug in). Flights use it without an account; adding it in Sources
 * only says so.
 */
import type { ConnectorPreset } from "../connector-presets";

export const OPENSKY_API_URL = "https://opensky-network.org/api";

/** Does Athena call this service's API itself? Yes: OpenSky, with nothing to sign in. */
export function flightsDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "opensky" && c.auth_type === "none";
}

export const FLIGHTS_PRESETS: ConnectorPreset[] = [
  {
    id: "opensky",
    label: "OpenSky",
    tagline: "Live flight times, no key needed",
    icon: "plane",
    category: "travel",
    aliases: ["flight status", "flights", "live flights", "flight tracker", "plane", "departures", "arrivals", "airport", "ads-b", "opensky network"],
    url: OPENSKY_API_URL,
    auth: "none",
    scope: "",
    readTools: [],
    recipes: [],
    help: "Flights already use OpenSky, so there's nothing to set up. It sees a plane once it's moving: still on the ground after its time, departed or landed. It has no gates; the terminal comes from your booking.",
    live: {
      meta: "Live flight times",
      foot: "Athena sends OpenSky only the area around an airport, never anything about you or your booking.",
      added: { title: "Flights use it now", sentence: "Your flights show departed and landed on Home and the day page." },
    },
  },
];
