/**
 * More of the Life log, from the connectors audit:
 * ListenBrainz, Raindrop.io and Eventbrite, reached through their own APIs
 * (netlify/lib/connectors/{listenbrainz,raindrop,eventbrite}-direct.ts),
 * GETs only. Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see
 * there for the fields.
 *
 *  - ListenBrainz: no sign-in. A username or profile link; listens on
 *    ListenBrainz are public, so its API reads them without a key.
 *  - Raindrop.io: a test token from the owner's own app in Raindrop's
 *    integrations settings. A test token reaches only the owner's bookmarks.
 *  - Eventbrite: the private token of the owner's own API key. Athena reads
 *    only the orders they placed as a ticket buyer.
 *
 * All three have history, which Athena loads when the account is connected
 * (backfill-tools.ts).
 */
import type { ConnectorPreset } from "../connector-presets";

export type LifeBProvider = "listenbrainz" | "raindrop" | "eventbrite";

export const LISTENBRAINZ_API_URL = "https://api.listenbrainz.org/1";
export const RAINDROP_API_URL = "https://api.raindrop.io/rest/v1";
export const EVENTBRITE_API_URL = "https://www.eventbriteapi.com/v3";

/** Hosts a ListenBrainz profile address may be on. */
export const LISTENBRAINZ_HOSTS = ["listenbrainz.org", "www.listenbrainz.org"];

/** Does Athena call this service's API itself? Mirrors each adapter's `handles`. */
export function lifeBDirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "listenbrainz") return c.auth_type === "none";
  if (c.provider === "raindrop" || c.provider === "eventbrite") return c.auth_type === "token";
  return false;
}

export const LIFE_B_PRESETS: ConnectorPreset[] = [
  {
    id: "listenbrainz",
    label: "ListenBrainz",
    tagline: "Every song you've listened to",
    icon: "music",
    category: "entertainment",
    aliases: ["scrobbles", "music history", "MusicBrainz"],
    url: "",
    urlHint: "Your ListenBrainz username",
    address: { section: "Your ListenBrainz", label: "Username", missing: "Add your ListenBrainz username.", text: true },
    auth: "none",
    scope: "",
    readTools: ["list_listens"],
    recipes: ["life-log", "plays-watches", "custom"],
    saves: [{ title: "What you listened to", sub: "On your days, one line per album or artist" }],
    help: "Type your ListenBrainz username. Listens on ListenBrainz are public, so Athena needs no key: it reads the same list anyone can see on your profile. It never submits a listen.",
  },
  {
    id: "raindrop",
    label: "Raindrop.io",
    tagline: "Links you save to read or keep",
    icon: "bookmark",
    category: "entertainment",
    aliases: ["bookmarks", "read later", "links"],
    url: RAINDROP_API_URL,
    auth: "token",
    scope: "",
    readTools: ["list_bookmarks", "search_bookmarks"],
    recipes: ["life-log", "plays-watches", "custom"],
    saves: [{ title: "Links you saved", sub: "On your days, under Saved" }],
    setup: {
      minutes: 3,
      steps: [
        { title: "Open Raindrop's integrations", sub: "Sign in, then under For developers choose Create new app. Call it Athena.", open: "https://app.raindrop.io/settings/integrations" },
        { title: "Open the app and make a test token", sub: "Choose Create test token. It reaches only your own bookmarks." },
      ],
      paste: { title: "Paste the test token here", sub: "Athena only reads your bookmarks. It never adds, moves or deletes one." },
    },
    help: "Athena reads the links you save in Raindrop.io: title, site, collection, tags and when you saved it. Your days list what you saved; Ask can search it.",
  },
  {
    id: "eventbrite",
    label: "Eventbrite",
    tagline: "Events you've booked tickets for",
    icon: "ticket",
    category: "travel",
    aliases: ["tickets", "events", "gigs", "talks"],
    url: EVENTBRITE_API_URL,
    auth: "token",
    scope: "",
    readTools: ["list_orders"],
    recipes: ["life-log", "plays-watches", "custom"],
    saves: [{ title: "Events you went to", sub: "On your days, with the venue's name" }],
    setup: {
      minutes: 3,
      steps: [
        { title: "Open Eventbrite's API keys page", sub: "Sign in with the account you buy tickets with.", open: "https://www.eventbrite.com/platform/api-keys" },
        { title: "Create an API key", sub: "Fill in the short form; any app name and website will do. Then open the key." },
      ],
      paste: { title: "Paste the private token here", sub: "Not the API key or client secret: the one labelled Private token." },
      heads_up: "Eventbrite's private token works for your whole account, so keep it to yourself. Athena only reads your ticket orders, and never buys, cancels or changes anything.",
    },
    help: "Athena reads the orders you placed on Eventbrite: the event, its date and the venue's name. It never reads the price, your address or anything about other guests.",
  },
];
