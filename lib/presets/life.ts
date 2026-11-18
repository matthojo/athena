/**
 * Habits, money and home: Habitify, Monzo, Starling and Octopus Energy,
 * reached through their own APIs (netlify/lib/connectors/{habitify,monzo,
 * starling,octopus}-direct.ts), GETs only. Joined into CONNECTOR_PRESETS by
 * lib/connector-presets.ts; see there for the fields.
 *
 *  - Habitify: the owner's API key (Habitify → Settings → API key). The Life
 *    log turns each habit's day into a `habit` entry.
 *  - Monzo: the owner's own app at developers.monzo.com (confidential, so it
 *    gets refresh tokens). Monzo asks for approval in its app, and gives the
 *    full history only in the 5 minutes after that; then 90 days.
 *  - Starling: a personal access token with account:read and transaction:read.
 *  - Octopus Energy: the API key, plus the electricity meter's MPAN and
 *    serial, the gas meter's MPRN and serial, or both (octopus-meters.ts).
 *
 * Money and home figures are sealed (lib/money.ts) and read by Athena itself
 * in the Home collection's hourly runs, with no model (money-sync.ts,
 * netlify/lib/home/home-run.ts): their tools are never offered to Claude.
 */
import type { ConnectorPreset } from "../connector-presets";
import { OCTOPUS_API_URL, OCTOPUS_FIELDS } from "./octopus-meters";

export { OCTOPUS_API_URL };

export type LifeProvider = "habitify" | "monzo" | "starling" | "octopus";

export const HABITIFY_API_URL = "https://api.habitify.me";
export const MONZO_API_URL = "https://api.monzo.com";
export const STARLING_API_URL = "https://api.starlingbank.com/api/v2";

/** Monzo has no OAuth scopes: an app sees what the owner approves in the Monzo app. */
export const MONZO_SCOPE = "";
export const STARLING_SCOPES = ["account:read", "transaction:read"];

/** Services whose figures Athena reads itself and seals, never offered to Claude. */
export const SEALED_SYNC_PROVIDERS = ["monzo", "starling", "octopus"] as const;
export const isSealedSync = (provider: string): boolean => (SEALED_SYNC_PROVIDERS as readonly string[]).includes(provider);

/** Does Athena call this service's API itself? Yes, for every one here. */
export function lifeDirect(c: { provider: string; auth_type: string }): boolean {
  if (c.provider === "monzo") return c.auth_type === "oauth";
  // Todoist: its hosted MCP server when signed in; its API directly with a personal token (todoist-direct.ts).
  if (c.provider === "todoist") return c.auth_type === "token";
  return ["habitify", "starling", "octopus"].includes(c.provider) && c.auth_type === "token";
}

const MONEY_SEALED = "Athena encrypts what you spent and where, and shows it only to you: on the Money page, and on Days if you turn it on in Settings → Days. It never reads your balance and never moves money.";

export const LIFE_PRESETS: ConnectorPreset[] = [
  {
    id: "habitify",
    label: "Habitify",
    tagline: "The habits you tick off each day",
    icon: "checklist",
    category: "habits",
    url: HABITIFY_API_URL,
    auth: "token",
    scope: "",
    aliases: ["habit tracker", "streaks", "routines"],
    readTools: ["habits_on", "habit_logs"],
    recipes: ["life-log", "plays-watches", "custom"],
    setup: {
      minutes: 2,
      steps: [
        { title: "Open Habitify on your phone", sub: "Or the web app at app.habitify.me." },
        { title: "Go to Settings, then API key", sub: "Copy the key it shows." },
      ],
      paste: { title: "Paste the key here", sub: "Athena only reads your habits. It never ticks one off or changes a goal." },
    },
    help: "Athena reads each day's habits from Habitify: done, skipped or missed, and how far you got on a counted goal. They show as chips on each day.",
  },
  {
    id: "monzo",
    label: "Monzo",
    tagline: "What you spent and where",
    icon: "wallet",
    category: "money",
    url: MONZO_API_URL,
    auth: "oauth",
    scope: MONZO_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Monzo",
    clientIdHint: "oauth2client_…",
    aliases: ["bank", "spending", "card"],
    readTools: ["transactions", "pots"],
    recipes: ["home"],
    saves: [{ title: "What you spent and where", sub: "Each day's payments, for Money and your regular payments" }],
    savesTo: "Money",
    setup: {
      minutes: 5,
      steps: [
        { title: "Sign in at developers.monzo.com", sub: "With the email on your Monzo account. Monzo sends a link to it.", open: "https://developers.monzo.com/" },
        { title: "Make a new OAuth client", sub: "Name it Athena, set Confidentiality to Confidential, and paste this redirect URL.", copyRedirect: true },
      ],
      paste: { title: "Paste the client ID and secret", sub: "Then sign in. Monzo asks you to approve Athena in the Monzo app." },
      heads_up: "For your full history: approve Athena in the Monzo app, turn on Home (or add Monzo to it), then press Run now within 5 minutes. Monzo only shares older payments in those 5 minutes; after that it shares the last 90 days. Monzo also asks you to sign in again every 90 days, and Athena reminds you when it's time.",
    },
    help: MONEY_SEALED,
  },
  {
    id: "starling",
    label: "Starling",
    tagline: "What you spent and where",
    icon: "wallet",
    category: "money",
    url: STARLING_API_URL,
    auth: "token",
    scope: STARLING_SCOPES.join(" "),
    aliases: ["bank", "spending", "card"],
    readTools: ["feed", "mandates"],
    recipes: ["home"],
    saves: [{ title: "What you spent and where", sub: "Each day's payments, for Money and your regular payments" }],
    savesTo: "Money",
    setup: {
      minutes: 3,
      steps: [
        { title: "Sign in at developer.starlingbank.com", sub: "With your Starling account.", open: "https://developer.starlingbank.com/" },
        { title: "Open Personal Access, then make a token", sub: "Tick account:read, transaction:read and mandate:read, nothing else. mandate:read lets Athena tell your bills apart." },
      ],
      paste: { title: "Paste the token here", sub: "It doesn't expire. Delete it in Starling's portal to stop Athena reading." },
    },
    help: MONEY_SEALED,
  },
  {
    id: "octopus",
    label: "Octopus Energy",
    tagline: "Your electricity and gas, half hour by half hour",
    icon: "home",
    category: "home",
    url: "",
    auth: "token",
    scope: "",
    aliases: ["electricity", "energy", "smart meter", "gas", "kwh"],
    address: { section: "Your meters", label: "Meters", missing: OCTOPUS_FIELDS.none, text: true, fields: OCTOPUS_FIELDS },
    urlHint: "1200012345678 21L1234567",
    readTools: ["consumption"],
    recipes: ["home"],
    saves: [{ title: "Energy, half hour by half hour", sub: "For House, priced at your tariff when you add your account number" }],
    savesTo: "House",
    setup: {
      minutes: 2,
      steps: [
        { title: "Sign in at octopus.energy/dashboard/developer", sub: "Your Octopus account's developer page.", open: "https://octopus.energy/dashboard/new/accounts/personal-details/api-access" },
        { title: "Copy your API key", sub: "The same page lists your meters: an MPAN and serial for electricity, an MPRN and serial for gas." },
        { title: "Add your meters below the key", sub: "Electricity, gas or both. Or type your account number and Athena finds them. Switch on m³ if your gas meter is a SMETS2 smart meter." },
      ],
      paste: { title: "Paste the API key here", sub: "Athena only reads your meters. You need a smart meter for half-hourly figures." },
    },
    help: "Athena reads how much electricity and gas you used each half hour, from whichever meters you add. Half-hourly use shows when you're home, so Athena encrypts it and shows it only to you: on the House page, and on Days if you turn Home on in Settings → Days.",
  },
];
