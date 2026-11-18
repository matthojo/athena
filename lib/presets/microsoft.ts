/**
 * Microsoft 365: Outlook mail and calendar, and related Microsoft services.
 * Joined into CONNECTOR_PRESETS by lib/connector-presets.ts; see there for the fields.
 *
 * Outlook mail and calendar don't go through MCP: Microsoft's own MCP servers
 * for them need a Microsoft 365 Copilot licence and a work tenant. Athena
 * calls Microsoft Graph itself (netlify/lib/connectors/microsoft-*.ts), with
 * the owner's own Entra app, read-only scopes, and the same tool names as
 * Gmail and Google Calendar, so recipes, precheck and Ask read them unchanged.
 */
import type { ConnectorPreset } from "../connector-presets";

export type MicrosoftProvider = "outlook-mail" | "outlook-calendar";

/** Microsoft Graph, which both Outlook presets call directly. */
export const MICROSOFT_GRAPH_URL = "https://graph.microsoft.com/v1.0";

/** Delegated, read-only. offline_access is what gives Athena a refresh token. */
export const OUTLOOK_MAIL_SCOPE = "offline_access User.Read Mail.Read";
export const OUTLOOK_CALENDAR_SCOPE = "offline_access User.Read Calendars.Read";

export function isMicrosoftProvider(provider: string): provider is MicrosoftProvider {
  return provider === "outlook-mail" || provider === "outlook-calendar";
}

/** Does Athena call Microsoft Graph itself for this account? Every Outlook account that signs in with OAuth. */
export function microsoftDirect(c: { provider: string; auth_type: string }): boolean {
  return isMicrosoftProvider(c.provider) && c.auth_type === "oauth";
}

const ENTRA_STEPS =
  "At entra.microsoft.com, open App registrations, then New registration. Name it Athena, pick the account type that includes personal Microsoft accounts, and under Redirect URI choose Web and paste the address above. Then copy the Application (client) ID, and under Certificates & secrets add a secret (24 months is the longest) and copy its Value.";

/** An Entra client ID is a GUID. */
const CLIENT_ID_HINT = "Application (client) ID";

export const MICROSOFT_PRESETS: ConnectorPreset[] = [
  {
    id: "outlook-mail",
    label: "Outlook",
    tagline: "Search and read your email",
    icon: "mail",
    category: "email-calendar",
    url: MICROSOFT_GRAPH_URL,
    auth: "oauth",
    scope: OUTLOOK_MAIL_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Microsoft",
    readTools: ["search_threads", "get_thread", "get_message", "list_labels"],
    recipes: ["email-digest", "custom"],
    clientIdHint: CLIENT_ID_HINT,
    help: `Register Athena with Microsoft once, free. ${ENTRA_STEPS} One registration covers Outlook Calendar and all your Microsoft accounts. Athena can read your mail but never send, move or delete it.`,
  },
  {
    id: "outlook-calendar",
    label: "Outlook Calendar",
    tagline: "Events, attendees and descriptions",
    icon: "calendar",
    category: "email-calendar",
    url: MICROSOFT_GRAPH_URL,
    auth: "oauth",
    scope: OUTLOOK_CALENDAR_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Microsoft",
    readTools: ["list_events", "get_event", "search_events", "list_calendars"],
    recipes: ["calendar-meetings", "custom"],
    clientIdHint: CLIENT_ID_HINT,
    help: `If you registered Athena for Outlook, paste the same ID and secret. If not, register it once, free. ${ENTRA_STEPS} Athena can read your calendar but never change it.`,
  },
];
