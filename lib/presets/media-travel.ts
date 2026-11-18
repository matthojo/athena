/**
 * Media servers, chess and travel reached through their own APIs: Plex,
 * Jellyfin, Lichess, Chess.com (Entertainment) and TripIt (Places and travel).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * None runs an MCP server, so Athena calls each API itself
 * (netlify/lib/connectors/{plex,jellyfin,lichess,chesscom,tripit}-direct.ts), GETs only.
 *  - Plex: the owner's Plex token. Athena finds their server's internet
 *    address through plex.tv, so there's nothing else to type.
 *  - Jellyfin: the server's https address and an API key.
 *  - Lichess, Chess.com: a username; both APIs are public.
 *  - TripIt: OAuth 1.0 with the owner's own TripIt app (TripIt has no OAuth 2).
 *    Trips are copied into Athena's Trips; nothing is ever written to TripIt.
 */
import type { ConnectorPreset } from "../connector-presets";

export type MediaTravelProvider = "plex" | "jellyfin" | "lichess" | "chesscom" | "tripit";

/** Plex's directory of the owner's servers: the account's URL, since the server is found from it. */
export const PLEX_DIRECTORY_URL = "https://clients.plex.tv";
export const TRIPIT_API_URL = "https://api.tripit.com/v1";

/** Hosts a chess profile address may be on. */
export const LICHESS_HOSTS = ["lichess.org", "www.lichess.org"];
export const CHESSCOM_HOSTS = ["www.chess.com", "chess.com"];

/** Does Athena call this service's API itself for this account? Mirrors each adapter's `handles`. */
export function mediaTravelDirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "plex" || c.provider === "jellyfin") return c.auth_type === "token";
  if (c.provider === "lichess" || c.provider === "chesscom") return c.auth_type === "none";
  if (c.provider === "tripit") return c.auth_type === "oauth";
  return false;
}

const REACHABLE = "Athena runs online, so it can only reach a server you can open from outside your home.";

/** The "is connected" sheet's lines (lib/connector-presets.ts `saves`). */
const WATCHED = [
  { title: "What you watched", sub: "On your days, under Watched" },
  { title: "Films and shows", sub: "In Watch & read, one item each" },
];
const GAMES = [{ title: "Your games", sub: "One line a day: games, wins and rating" }];

export const MEDIA_TRAVEL_PRESETS: ConnectorPreset[] = [
  {
    id: "plex",
    label: "Plex",
    tagline: "What you watch on your Plex server",
    icon: "tv",
    category: "entertainment",
    url: PLEX_DIRECTORY_URL,
    auth: "token",
    scope: "",
    readTools: ["watch_history"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Paste your Plex key and Athena finds your server. ${REACHABLE}`,
    saves: WATCHED,
    setup: {
      minutes: 2,
      steps: [
        { title: "Open Plex in your browser", sub: "Sign in, then open any film or episode in your library.", open: "https://app.plex.tv/desktop" },
        { title: "Get Info, then View XML", sub: "From the ⋯ menu. A page of code opens in a new tab." },
        { title: "Copy that page's address", sub: "All of it, from the address bar. Athena finds your key in it." },
      ],
      paste: { title: "Paste it here" },
      heads_up: `${REACHABLE} In Plex, Settings, then Remote Access should say Fully accessible outside your network.`,
    },
  },
  {
    id: "jellyfin",
    label: "Jellyfin",
    tagline: "What you watch on your Jellyfin server",
    icon: "tv",
    category: "entertainment",
    url: "",
    urlHint: "https://jellyfin.you.com",
    address: { section: "Your server", label: "Address", missing: "Paste your Jellyfin server's address." },
    auth: "token",
    scope: "",
    readTools: ["watch_history"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `The address you open Jellyfin with away from home. ${REACHABLE}`,
    saves: WATCHED,
    setup: {
      minutes: 1,
      steps: [
        { title: "Open your Jellyfin dashboard", sub: "Signed in as an administrator: Dashboard, then API Keys." },
        { title: "Make a key called Athena", sub: "Choose +, type Athena and copy the key it shows." },
      ],
      paste: { title: "Paste it here" },
      heads_up: "Athena reads only what the server's administrator watches. Anyone else on your server stays private.",
    },
  },
  {
    id: "lichess",
    label: "Lichess",
    tagline: "Your games and rating",
    icon: "game",
    category: "entertainment",
    url: "",
    urlHint: "Your Lichess username",
    address: { section: "Your Lichess", label: "Username", missing: "Add your Lichess username.", text: true },
    auth: "none",
    scope: "",
    readTools: ["list_games"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Your games are public on Lichess, so Athena only needs your username.",
    saves: GAMES,
  },
  {
    id: "chesscom",
    label: "Chess.com",
    tagline: "Your games and rating",
    icon: "game",
    category: "entertainment",
    url: "",
    urlHint: "Your Chess.com username",
    address: { section: "Your Chess.com", label: "Username", missing: "Add your Chess.com username.", text: true },
    auth: "none",
    scope: "",
    readTools: ["list_games"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: "Your games are public on Chess.com, so Athena only needs your username.",
    saves: GAMES,
  },
  {
    id: "tripit",
    label: "TripIt",
    tagline: "Your trips, flights and stays",
    icon: "suitcase",
    category: "travel",
    url: TRIPIT_API_URL,
    auth: "oauth",
    // TripIt has no scopes: read-only is Athena's own rule (GETs only).
    scope: "",
    needsOwnClient: true,
    ownClientLabel: "TripIt",
    clientIdHint: "API key",
    clientFields: { id: "API key", secret: "API secret" },
    readTools: ["list_trips"],
    recipes: ["life-log", "custom"],
    help: "Make a free TripIt app once and paste its API key and secret. Your trips then appear in Trips. Athena never changes anything in TripIt.",
    saves: [
      { title: "Your trips", sub: "Each flight, stay, train and car hire, in Trips" },
      { title: "Changes", sub: "Athena picks up a moved time or new seat each evening" },
    ],
    savesTo: "Trips",
    setup: {
      minutes: 2,
      steps: [
        { title: "Make a TripIt app", sub: "Sign in with your TripIt account and create an app called Athena. Any website address works.", open: "https://www.tripit.com/developer" },
      ],
      paste: { title: "Paste its API key and secret", sub: "TripIt shows both once the app is made." },
      heads_up: "Athena copies your trips into Trips. It never changes anything in TripIt.",
    },
  },
];
