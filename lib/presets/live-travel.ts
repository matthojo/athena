/**
 * Live travel keys: Google Maps routes, TfL and National Rail live
 * departures, each a key the owner pastes. Joined into CONNECTOR_PRESETS by
 * lib/connector-presets.ts; see there for the fields.
 *
 * Like OpenSky (flights.ts), none of them feeds a collection or is offered to
 * Claude: Athena calls them itself, for Leave by (netlify/lib/proactive/
 * directions.ts), the briefing, the travel strip and Ask's train_status
 * (netlify/lib/live-travel.ts). Those read the key through travelKey()
 * (netlify/lib/travel-key.ts): the stored key first, then the old
 * environment variable, so a deploy that set one keeps working.
 *
 * "Check connection" makes one small read-only call with the key
 * (netlify/lib/connectors/live-travel-direct.ts).
 */
import type { ConnectorPreset } from "../connector-presets";

export type TravelKeyKind = "google-routes" | "tfl" | "national-rail";
export const TRAVEL_KEY_PROVIDERS: readonly TravelKeyKind[] = ["google-routes", "tfl", "national-rail"];
export const isTravelKeyProvider = (p: string): p is TravelKeyKind => (TRAVEL_KEY_PROVIDERS as readonly string[]).includes(p);

/** The environment variable each key used to live in, still read when no key is stored. */
export const TRAVEL_KEY_ENV: Record<TravelKeyKind, string> = {
  "google-routes": "ATHENA_GOOGLE_ROUTES_KEY",
  tfl: "ATHENA_TFL_KEY",
  "national-rail": "ATHENA_RDM_KEY",
};

/** Does Athena call this service's API itself? Yes, for each of these with a key. */
export function liveTravelDirect(c: { provider: string; auth_type: string }): boolean {
  return isTravelKeyProvider(c.provider) && c.auth_type === "token";
}

export const LIVE_TRAVEL_PRESETS: ConnectorPreset[] = [
  {
    id: "google-routes",
    label: "Google Maps",
    tagline: "Journey times for Leave by",
    icon: "car",
    category: "travel",
    aliases: ["google maps", "routes", "directions", "routes api", "leave by", "journey time", "travel time"],
    url: "https://routes.googleapis.com",
    auth: "token",
    scope: "",
    readTools: [],
    recipes: [],
    setup: {
      minutes: 6,
      steps: [
        { title: "Make a project in Google Cloud", sub: "Any name. Google asks for a billing account, but Routes has a monthly free allowance, and Athena asks once for each upcoming event, or twice for a drive.", open: "https://console.cloud.google.com/projectcreate" },
        { title: "Turn on the Routes API", sub: "In that project, under APIs and services.", open: "https://console.cloud.google.com/apis/library/routes.googleapis.com" },
        { title: "Make an API key", sub: "Under Credentials. Then edit it and restrict it to the Routes API, so it can't be used for anything else.", open: "https://console.cloud.google.com/apis/credentials" },
      ],
      paste: { title: "Paste the key here", sub: "Athena checks it with one short walking route." },
    },
    help: "Outside London, Leave by asks Google how long the trip takes by public transport, or on foot. Athena sends two map coordinates and the time you need to arrive. It never sends a name, an address or what the event is.",
    live: {
      meta: "Journey times for Leave by",
      foot: "Athena sends Google two coordinates and an arrival time, never a name or an address.",
      added: { title: "Leave by uses it now", sentence: "Outside London, Leave by times come from Google instead of an estimate from the distance." },
    },
  },
  {
    id: "tfl",
    label: "TfL live",
    tagline: "Tube lines and London journey times",
    icon: "train",
    category: "travel",
    aliases: ["transport for london", "tube", "underground", "line status", "elizabeth line", "overground", "dlr", "journey planner", "leave by"],
    url: "https://api.tfl.gov.uk",
    auth: "token",
    scope: "",
    readTools: [],
    recipes: [],
    setup: {
      minutes: 3,
      steps: [
        { title: "Sign up at api-portal.tfl.gov.uk", sub: "It's free.", open: "https://api-portal.tfl.gov.uk/signup" },
        { title: "Subscribe to the 500 Requests per min product", sub: "Under Products. Then copy the primary key from your profile." },
      ],
      paste: { title: "Paste the key here", sub: "Athena checks it by reading one line's status." },
    },
    help: "Athena reads which Tube, Elizabeth line, Overground and DLR lines are disrupted, for the briefing and your commute. In London, Leave by asks TfL's Journey Planner how long the trip takes, sending two map coordinates and the time you need to arrive. It never sends a name, an address or what the event is.",
    live: {
      meta: "Line status and London journey times",
      foot: "Athena sends TfL two coordinates and an arrival time, never a name or an address.",
      added: { title: "Athena uses it now", sentence: "The briefing says when your lines are disrupted, and Leave by in London uses TfL's journey times." },
    },
  },
  {
    id: "national-rail",
    label: "National Rail",
    tagline: "Live departures for your train bookings",
    icon: "train",
    category: "travel",
    aliases: ["trains", "rail", "departures", "live departure board", "darwin", "rail data marketplace", "platform", "delays"],
    url: "https://api1.raildata.org.uk",
    auth: "token",
    scope: "",
    readTools: [],
    recipes: [],
    setup: {
      minutes: 4,
      steps: [
        { title: "Sign up at raildata.org.uk", sub: "The Rail Data Marketplace. It's free.", open: "https://raildata.org.uk/" },
        { title: "Subscribe to Live Departure Board", sub: "Search the catalogue for it. Then open the product's Specification tab and copy the consumer key." },
      ],
      paste: { title: "Paste the consumer key here", sub: "Athena checks it by reading one row of a departure board." },
    },
    help: "From 3 hours before a booked train leaves, Athena reads the departure board for it: on time, late, cancelled and the platform. It sends only the two station codes and a time window. It never sends a name or your booking.",
    live: {
      meta: "Live departures",
      foot: "Athena sends National Rail two station codes, never a name or your booking.",
      added: { title: "Your trains use it now", sentence: "Train bookings show live times and platforms from 3 hours before they leave." },
    },
  },
];
