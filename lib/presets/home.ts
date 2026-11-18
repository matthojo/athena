/**
 * Home: appliances Athena reads itself, without MCP.
 *
 * Home Connect (Bosch, Siemens, Neff, Gaggenau): the official API at
 * api.home-connect.com, read-only (netlify/lib/connectors/homeconnect-direct.ts).
 * The owner registers their own app at developer.home-connect.com and signs
 * in; Athena asks for IdentifyAppliance and Monitor only, never Control or
 * Settings, so it can see what an appliance is doing and can't start, stop
 * or change anything.
 */
import type { ConnectorPreset } from "../connector-presets";

export const HOME_CONNECT_API_URL = "https://api.home-connect.com";
export const HOME_CONNECT_AUTHORIZE_URL = `${HOME_CONNECT_API_URL}/security/oauth/authorize`;
export const HOME_CONNECT_TOKEN_URL = `${HOME_CONNECT_API_URL}/security/oauth/token`;
/** Which appliances there are, and what each is doing. Not Control or Settings. */
export const HOME_CONNECT_SCOPE = "IdentifyAppliance Monitor";
/** The Days source for a finished programme. */
export const HOME_CONNECT_SOURCE = "home_connect";

/** Does Athena call this service's API itself? Yes, once signed in. */
export function homeDirect(c: { provider: string; auth_type: string }): boolean {
  return c.provider === "home-connect" && c.auth_type === "oauth";
}

export const HOME_PRESETS: ConnectorPreset[] = [
  {
    id: "home-connect",
    label: "Home Connect",
    tagline: "Your dishwasher, washing machine and oven",
    icon: "home",
    category: "home",
    aliases: ["bosch", "siemens", "neff", "gaggenau", "dishwasher", "washing machine", "washer", "dryer", "oven", "appliance", "appliances"],
    url: HOME_CONNECT_API_URL,
    auth: "oauth",
    scope: HOME_CONNECT_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Home Connect",
    clientIdHint: "Client ID, 64 letters and numbers",
    readTools: ["appliances"],
    recipes: ["home", "custom"],
    saves: [
      { title: "Each finished programme", sub: "On the day it ended: which appliance, which programme and how long." },
      { title: "What each appliance is doing", sub: "On the House page, as of the last look." },
    ],
    savesTo: "Days and House",
    setup: {
      minutes: 5,
      steps: [
        { title: "Sign in at developer.home-connect.com", sub: "Make a free developer account with the same email as your Home Connect app.", open: "https://developer.home-connect.com/" },
        { title: "Register an application", sub: "Under Applications, choose Register Application. Name it Athena, pick Authorization Code Grant Flow, and paste this address as the Redirect URI.", open: "https://developer.home-connect.com/applications/add", copyRedirect: true },
      ],
      paste: { title: "Paste its Client ID and Client Secret here", sub: "From the application's page. Then sign in with your Home Connect account." },
    },
    help: "Once Home reads it, Athena looks at your appliances every 15 minutes and never starts, stops or changes one: it asks Home Connect only for permission to see them. A programme's start and end are known to the nearest look. What your appliances do shows when you're home, so Athena encrypts it and shows it only to you: on Days, on the House page, and to Ask when you ask about an appliance.",
  },
];
