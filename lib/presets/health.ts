/**
 * Health services (Strava, Oura, Withings, Whoop, Polar) reached through their own APIs. Figures are sealed (docs: security/encryption).
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * None runs an MCP server, so Athena calls each API itself
 * (netlify/lib/connectors/{strava,oura,withings,whoop,polar}-direct.ts), reads only. Each
 * signs in with the owner's own app. Tools return the day's figures to the
 * Life log run, which hands them to athena_health_day to seal; nothing here
 * stores them.
 */
import type { ConnectorPreset } from "../connector-presets";

export type HealthProvider = "strava" | "oura" | "withings" | "whoop" | "polar";

export const STRAVA_API_URL = "https://www.strava.com/api/v3";
export const OURA_API_URL = "https://api.ouraring.com/v2";
export const WITHINGS_API_URL = "https://wbsapi.withings.net";
export const WHOOP_API_URL = "https://api.prod.whoop.com/developer/v2";
export const POLAR_API_URL = "https://www.polaraccesslink.com/v3";

/** Strava: your profile and every activity, private ones included. Comma-separated, as Strava wants. */
export const STRAVA_SCOPE = "read,activity:read_all";
/** Oura: daily sleep, readiness and activity, workouts, sessions (meditation, breathing) and tags. Not heart rate series or personal details. */
export const OURA_SCOPE = "daily workout session tag";
/** Withings: measures (weight, body), activity, sleep. Comma-separated, as Withings wants. */
export const WITHINGS_SCOPE = "user.metrics,user.activity,user.sleepevents";
/** Whoop: sleep, workouts, recovery and cycles; `offline` for a refresh token. Not profile or body measurements. */
export const WHOOP_SCOPE = "read:sleep read:workout read:recovery read:cycles offline";
/** Polar AccessLink has one scope. */
export const POLAR_SCOPE = "accesslink.read_all";

/** Does Athena call this service's API itself? Yes, for every health account that signs in. */
export function healthDirect(c: { provider: string; auth_type: string }): boolean {
  return ["strava", "oura", "withings", "whoop", "polar"].includes(c.provider) && c.auth_type === "oauth";
}

const SEALED = "Athena encrypts the figures and shows them only to you, on your days and on the Health page.";

export const HEALTH_PRESETS: ConnectorPreset[] = [
  {
    id: "strava",
    label: "Strava",
    tagline: "Your runs and rides",
    icon: "flag",
    category: "health",
    url: STRAVA_API_URL,
    auth: "oauth",
    scope: STRAVA_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Strava",
    clientIdHint: "Client ID, a number",
    readTools: ["activities", "day_summary"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Make a Strava app once at strava.com/settings/api. You need a Strava subscription for that. Athena reads your activities, private ones too, and never posts. ${SEALED}`,
  },
  {
    id: "oura",
    label: "Oura",
    tagline: "Your sleep and readiness",
    icon: "bed",
    category: "health",
    url: OURA_API_URL,
    auth: "oauth",
    scope: OURA_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Oura",
    clientIdHint: "Client ID",
    readTools: ["daily_sleep", "daily_readiness", "daily_activity", "workouts", "sessions", "tags", "day_summary"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Make an Oura app once at cloud.ouraring.com/oauth/applications. Athena reads your sleep, readiness, activity and workouts, your meditation and breathing sessions, and your coffee and alcohol tags, while your Oura Membership is active. ${SEALED}`,
  },
  {
    id: "withings",
    label: "Withings",
    tagline: "Weight, activity and sleep",
    icon: "heart",
    category: "health",
    url: WITHINGS_API_URL,
    auth: "oauth",
    scope: WITHINGS_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Withings",
    clientIdHint: "Client ID",
    readTools: ["body_measures", "daily_activity", "daily_sleep", "day_summary"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Make a Withings app once at developer.withings.com/dashboard. Athena reads your weight and body measures, daily activity and sleep. ${SEALED}`,
  },
  {
    id: "whoop",
    label: "Whoop",
    tagline: "Your sleep and recovery",
    icon: "heart",
    category: "health",
    url: WHOOP_API_URL,
    auth: "oauth",
    scope: WHOOP_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Whoop",
    clientIdHint: "Client ID",
    readTools: ["sleep", "workouts", "day_summary"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Make a Whoop app once at developer-dashboard.whoop.com. Athena reads your sleep and workouts, with each night's recovery. ${SEALED}`,
  },
  {
    id: "polar",
    label: "Polar",
    tagline: "Your training and sleep",
    icon: "heart",
    category: "health",
    url: POLAR_API_URL,
    auth: "oauth",
    scope: POLAR_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Polar",
    clientIdHint: "Client ID",
    readTools: ["exercises", "daily_activity", "sleep", "day_summary", "changed_days"],
    recipes: ["life-log", "plays-watches", "custom"],
    help: `Make a Polar app once at admin.polaraccesslink.com. Athena reads your workouts and sleep, and counts your steps. ${SEALED}`,
  },
];
