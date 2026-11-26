/**
 * Places and travel: Swarm (Foursquare) check-ins, reached through its own
 * API with the owner's own Foursquare app. Joined into CONNECTOR_PRESETS by
 * lib/connector-presets.ts; see there for the fields.
 *
 * Athena reads check-ins only (netlify/lib/connectors/swarm-direct.ts) and
 * never checks in. Where you've been is sealed (docs: security/encryption):
 * check-ins go straight into lib/places-visits.ts, never through
 * Claude (netlify/lib/connectors/swarm-sync.ts). Google Maps Timeline isn't
 * an account: it's a file, imported from the Places page.
 */
import type { ConnectorPreset } from "../connector-presets";

export const SWARM_API_URL = "https://api.foursquare.com/v2";
/** Foursquare's v2 API wants a version date on every call. */
export const SWARM_API_VERSION = "20240601";

/** Does Athena call this service's API itself? Yes, for a Swarm account that signs in. */
export function travelDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "swarm" && c.auth_type === "oauth";
}

export const TRAVEL_PRESETS: ConnectorPreset[] = [
  {
    id: "swarm",
    label: "Swarm",
    tagline: "Your check-ins",
    icon: "pin",
    category: "travel",
    url: SWARM_API_URL,
    auth: "oauth",
    scope: "",
    needsOwnClient: true,
    ownClientLabel: "Foursquare",
    clientIdHint: "Client ID",
    readTools: ["checkins"],
    recipes: ["life-log", "custom"],
    help: "Make a Foursquare app once at foursquare.com/developers and add Athena's callback address to it. Athena reads your check-ins each night and never checks in. Where you've been is encrypted and only shown to you.",
  },
];
