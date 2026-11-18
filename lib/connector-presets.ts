/**
 * The services Athena knows how to sign in to, shared by the server
 * (default tool allowlists, OAuth quirks) and the PWA (the "Add an account"
 * picker). Pure data + one classifier, no I/O, so both sides can import it.
 *
 * Every preset is only a starting point: the URL, scope and allowlist are
 * editable per account, and `custom` takes any Streamable HTTP MCP server.
 */

import type { AddressFields } from "./address-fields";
import { WORK_PRESETS } from "./presets/work";
import { BUSINESS_PRESETS } from "./presets/business";
import { MICROSOFT_PRESETS, microsoftDirect } from "./presets/microsoft";
import { API_PRESETS, apiADirect } from "./presets/api";
import { API_B_PRESETS, apiBDirect } from "./presets/api-b";
import { APPLE_PRESETS, appleDirect } from "./presets/apple";
import { HEALTH_PRESETS, healthDirect } from "./presets/health";
import { MEDIA_TRAVEL_PRESETS, mediaTravelDirect } from "./presets/media-travel";
import { NETFLIX_PRESETS, netflixDirect } from "./presets/netflix";
import { TRAVEL_PRESETS, travelDirect } from "./presets/travel";
import { READING_SOCIAL_PRESETS, readingSocialDirect } from "./presets/reading-social";
import { LIFE_PRESETS, lifeDirect } from "./presets/life";
import { FLIGHTS_PRESETS, flightsDirect } from "./presets/flights";
import { LIVE_TRAVEL_PRESETS, liveTravelDirect } from "./presets/live-travel";
import { CAR_PRESETS, carDirect } from "./presets/car";
import { HOME_PRESETS, homeDirect } from "./presets/home";
import { FASTMAIL_PRESETS, fastmailDirect } from "./presets/fastmail";
import { DOCUMENTS_PRESETS, documentsDirect } from "./presets/documents";
import { LIFE_B_PRESETS, lifeBDirect } from "./presets/life-b";

export type ConnectorAuthType = "oauth" | "token" | "none";
export type RecipeId = "calendar-meetings" | "email-digest" | "work-activity" | "life-log" | "plays-watches" | "work-sync" | "home" | "custom";
export type ToolAccess = "read" | "write" | "unknown";

/** How an OAuth account gets its tokens. */
export type OAuthGrant = "authorization_code" | "client_credentials";
/** How Athena proves its client secret to the token endpoint (RFC 6749 §2.3.1). */
export type OAuthTokenAuth = "client_secret_basic" | "client_secret_post";

/**
 * OAuth settings for servers that don't follow the MCP authorization spec to
 * the letter. Nothing here is secret (the client secret lives in the sealed
 * credentials). Every field is optional; empty means "discover it".
 *  - grant: `authorization_code` (sign in with a browser, the default) or
 *    `client_credentials` (machine-to-machine: your client ID and secret are
 *    exchanged for a token, with no browser step).
 *  - authorization_endpoint / token_endpoint: for servers that don't publish
 *    OAuth metadata (RFC 8414 / RFC 9728). Set both for browser sign-in, or
 *    just the token URL for client credentials.
 *  - token_auth: force HTTP Basic or form-body client authentication instead
 *    of picking from the server's metadata.
 *  - audience: sent as `audience` on the authorisation and token requests, for
 *    providers that require one (Auth0, some Okta set-ups).
 *  - google_route: Gmail and Google Calendar only. Athena calls Google's
 *    ordinary REST APIs itself (netlify/lib/connectors/google-direct.ts)
 *    unless this is "mcp", which goes through Google's MCP server instead
 *    (in Google's Workspace Developer Preview at the time of writing).
 *    Switching keeps the sign-in: Google scopes tokens by permission, not by
 *    server.
 */
export interface ConnectorOAuthSettings {
  grant?: OAuthGrant;
  authorization_endpoint?: string;
  token_endpoint?: string;
  token_auth?: OAuthTokenAuth;
  audience?: string;
  google_route?: "mcp";
}

export const OAUTH_GRANTS: OAuthGrant[] = ["authorization_code", "client_credentials"];
export const OAUTH_TOKEN_AUTH: OAuthTokenAuth[] = ["client_secret_basic", "client_secret_post"];

/**
 * What a service is for, so the "Add an account" directory can group it.
 * Order here is the order the directory shows them in.
 */
export type ConnectorCategory =
  | "email-calendar"
  | "meetings"
  | "chat"
  | "projects"
  | "docs"
  | "engineering"
  | "design"
  | "sales-support"
  | "automation"
  | "entertainment"
  | "social"
  | "travel"
  | "health"
  | "habits"
  | "money"
  | "home"
  | "other";

export const CONNECTOR_CATEGORIES: Array<{ id: ConnectorCategory; label: string }> = [
  { id: "email-calendar", label: "Email and calendar" },
  { id: "meetings", label: "Meetings" },
  { id: "chat", label: "Chat" },
  { id: "projects", label: "Projects and tasks" },
  { id: "docs", label: "Docs and files" },
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design" },
  { id: "sales-support", label: "Sales and support" },
  { id: "automation", label: "Automation" },
  { id: "entertainment", label: "Entertainment" },
  { id: "social", label: "Social" },
  { id: "travel", label: "Places and travel" },
  { id: "health", label: "Health" },
  { id: "habits", label: "Habits and mind" },
  { id: "money", label: "Money" },
  { id: "home", label: "Home" },
  { id: "other", label: "Other" },
];

export interface ConnectorPreset {
  id: string;
  label: string;
  /** One line for the "Add an account" directory. */
  tagline: string;
  /** An icon name from app/src/components/icons.ts. */
  icon: string;
  /** Which directory group it sits in. */
  category: ConnectorCategory;
  /** Other words the directory's search finds it by ("bank", "electricity", another app's name that comes in through it). */
  aliases?: string[];
  url: string;
  auth: ConnectorAuthType;
  /** Other auth types the service also accepts (e.g. Linear API keys). */
  altAuth?: ConnectorAuthType[];
  /** Read-only OAuth scope to request; '' = what the server advertises. */
  scope: string;
  /**
   * The provider doesn't support dynamic client registration, so you bring
   * your own OAuth client (Google: a "Web application" client in Google
   * Cloud with Athena's callback URL as an authorised redirect URI).
   */
  needsOwnClient?: boolean;
  /**
   * Whose OAuth client that is, as the forms name it ("Google" → "Google
   * OAuth client", "Continue to Google"). Defaults to the preset's label.
   */
  ownClientLabel?: string;
  /** Signs in with PKCE alone (Trakt): only the client ID is asked for, never a secret. */
  noClientSecret?: boolean;
  /** What the client ID field shows before anything's typed. Defaults to Google's shape (…apps.googleusercontent.com). */
  clientIdHint?: string;
  /**
   * Placeholder for the URL field, shown when `url` is empty so the owner
   * types their own (a profile or feed address, say). Defaults to "https://…/mcp".
   */
  urlHint?: string;
  /**
   * A username that goes with the key (an Apple ID with an app-specific
   * password). Asked for beside the key and sealed with it.
   */
  username?: { label: string; placeholder: string; autocomplete?: string; inputmode?: string };
  /**
   * The URL field's own words when it isn't a profile link: a server's
   * address, or a username (`text`: no URL keyboard). `missing` is said when
   * it's left empty. The adapter's checkAddress turns a username into the
   * address Athena keeps. `fields` asks for it as labelled groups instead of
   * one box (lib/address-fields.ts), sent to checkAddress as JSON.
   */
  address?: { section: string; label: string; missing: string; text?: boolean; fields?: AddressFields };
  /** What the service calls its client ID and secret ("API key", "API secret"). */
  clientFields?: { id: string; secret: string };
  /** What a collection saves from this service, for the "is connected" sheet, when the recipe's own lines don't fit it. */
  saves?: Array<{ title: string; sub: string }>;
  /** Where that turns up ("Trips"), for the same sheet. Default: Notes. */
  savesTo?: string;
  /** Numbered setup steps (app/src/components/setup-steps.ts), for a service without steps written there. */
  setup?: PresetSetup;
  /** Tools known to only read. These are the default allowlist. */
  readTools: string[];
  /** Recipes this service feeds. */
  recipes: RecipeId[];
  help: string;
  /**
   * Read by Athena itself for live times, never by a collection or Claude
   * (lib/presets/flights.ts): what its Sources row says, the form's foot, and
   * what the "is added" sheet says.
   */
  live?: { meta: string; foot: string; added: { title: string; sentence: string } };
  /**
   * A key that comes with a client ID, a client secret and a token URL
   * (DVSA's MOT History: lib/presets/car.ts). Asked for beside the key and
   * sealed with it; `hint` is the token URL's placeholder.
   */
  clientCredentials?: { hint: string };
}

/** Setup steps as data. The key, or client ID and secret, go in `paste`, the last step. */
export interface PresetSetup {
  minutes?: number;
  steps: Array<{ title: string; sub?: string; open?: string; copyRedirect?: boolean }>;
  paste: { title: string; sub?: string };
  heads_up?: string;
}

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/**
 * Google has no drafts-only permission: gmail.compose also allows sending.
 * Athena asks for it only when you turn on drafts for an account, uses it
 * only for create_draft, and mcp-client's callTool refuses every send tool.
 */
export const GMAIL_DRAFT_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

/**
 * Outlook's draft permission. Like Google's, it's wider than drafts: it also
 * covers moving and deleting mail (not sending, which is Mail.Send, never
 * asked for). Athena uses it only for create_draft, and microsoft-graph.ts
 * refuses any write but a new draft or a draft reply (isDraftCreate).
 */
export const OUTLOOK_DRAFT_SCOPE = "Mail.ReadWrite";

/** The mail accounts drafts can be saved to, and the permission each needs. */
/**
 * Fastmail has no OAuth scopes: its API token either has "Make changes" or
 * it doesn't. This word in the account's scope is Athena's own switch; the
 * token's permission is Fastmail's, and a read-only token is refused there.
 */
export const FASTMAIL_DRAFT_MARKER = "drafts";

export const DRAFT_SCOPE: Readonly<Record<string, string>> = { gmail: GMAIL_DRAFT_SCOPE, "outlook-mail": OUTLOOK_DRAFT_SCOPE, fastmail: FASTMAIL_DRAFT_MARKER };
export const DRAFT_PROVIDERS = ["gmail", "outlook-mail", "fastmail"] as const;

/** Has this account been given draft access (lib/drafts.ts)? */
export function canDraft(c: { provider: string; scope: string }): boolean {
  const scope = DRAFT_SCOPE[c.provider];
  return !!scope && c.scope.split(/\s+/).includes(scope);
}

/**
 * "Let Athena answer invites": the one calendar write (lib/rsvp.ts). Each
 * permission also covers editing events, so it's asked for only when you
 * turn this on, and Athena uses it only for respond_to_event: Google's
 * attendee patch for your own reply, or Microsoft's accept, tentativelyAccept
 * and decline. google-api.ts and microsoft-graph.ts refuse anything else.
 * iCloud: add its provider and permission here once its branch lands.
 */
export const RSVP_SCOPE: Readonly<Record<string, string>> = {
  "google-calendar": "https://www.googleapis.com/auth/calendar.events",
  "outlook-calendar": "Calendars.ReadWrite",
  // iCloud has no OAuth scopes: Athena's own marker, kept in `scope` beside the calendars switched off (lib/presets/apple.ts).
  "icloud-calendar": "athena:answer-invites",
};
/** The tool that sends your answer to an invite (google-calendar.ts, microsoft-calendar.ts). */
export const RSVP_TOOL = "respond_to_event";

/** Has this calendar account been allowed to answer invites? */
export function canRsvp(c: { provider: string; scope: string }): boolean {
  const scope = RSVP_SCOPE[c.provider];
  return !!scope && c.scope.split(/\s+/).includes(scope);
}

/**
 * "Let Athena add and update events" (lib/scheduling.ts): its own switch,
 * kept in `scope` as Athena's marker on every calendar provider. It was
 * "Let Athena move events you organise" and keeps that marker, so an account
 * that had moving on now has adding on too. On Google and Outlook it needs
 * the same write permission as answering invites (RSVP_SCOPE), which
 * oauthScope adds at sign-in, so switching it on doesn't turn on answering.
 * move_event changes only an event's start and end, and only one the owner
 * organises; create_event adds one event with a fixed set of fields; and
 * undo_create_event deletes only an event Athena added (calendar_creates).
 * google-api.ts, microsoft-graph.ts, icloud-move.ts and icloud-create.ts
 * check the exact request.
 */
export const MOVE_MARKER = "athena:move-events";
export const MOVE_TOOL = "move_event";
export const CREATE_TOOL = "create_event";
/** Undo of create_event: deletes one event, only one Athena added. */
export const UNDO_CREATE_TOOL = "undo_create_event";
export const EVENTS_SWITCH = "Let Athena add and update events";
/** Guests' busy times (Google freeBusy, Graph getSchedule): a read, busy or free only. */
export const FREE_BUSY_TOOL = "free_busy";
/** Accounts whose history Athena loads when they're connected (netlify/lib/connectors/backfill.ts; backfill.test.ts checks the adapters agree). */
export const HISTORY_LOADS = ["trakt", "youtube", "lastfm", "spotify", "plex", "jellyfin", "letterboxd", "listenbrainz", "raindrop", "eventbrite", "octopus"] as const;


export const MOVE_PROVIDERS = ["google-calendar", "outlook-calendar", "icloud-calendar"] as const;

/** Has this calendar account been allowed to add events and move ones the owner organises ("Let Athena add and update events")? */
export function canMove(c: { provider: string; scope: string }): boolean {
  return (MOVE_PROVIDERS as readonly string[]).includes(c.provider) && c.scope.split(/\s+/).includes(MOVE_MARKER);
}

/**
 * The scope sent to the provider at sign-in and renewal: Athena's own
 * markers ("athena:…") left out, and the calendar write permission added
 * when moving is on.
 */
export function oauthScope(c: { provider: string; scope: string }): string {
  const parts = c.scope.split(/\s+/).filter((s) => s && !s.startsWith("athena:"));
  const write = RSVP_SCOPE[c.provider];
  if (canMove(c) && write && !write.startsWith("athena:") && !parts.includes(write)) parts.push(write);
  return parts.join(" ");
}

export type GoogleProvider = "gmail" | "google-calendar";

/** Google's REST APIs, which Gmail and Google Calendar accounts call directly by default. */
export const GOOGLE_API_URL: Record<GoogleProvider, string> = {
  gmail: "https://gmail.googleapis.com/gmail/v1",
  "google-calendar": "https://www.googleapis.com/calendar/v3",
};

/** Google's MCP servers, for an account switched to them (`oauth.google_route`). */
export const GOOGLE_MCP_URL: Record<GoogleProvider, string> = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  "google-calendar": "https://calendarmcp.googleapis.com/mcp/v1",
};

export function isGoogleProvider(provider: string): provider is GoogleProvider {
  return provider === "gmail" || provider === "google-calendar";
}

/**
 * Does Athena call Google's APIs itself for this account? True for every
 * Gmail and Google Calendar account that signs in with OAuth, including ones
 * added when they went through Google's MCP servers, unless it's been
 * switched back to the MCP server.
 */
export function googleDirect(c: { provider: string; auth_type: string; oauth?: ConnectorOAuthSettings | null }): boolean {
  return isGoogleProvider(c.provider) && c.auth_type === "oauth" && c.oauth?.google_route !== "mcp";
}

/** Does Athena call the service's own API for this account, rather than an MCP server? (netlify/lib/connectors/direct.ts) */
export function directApi(c: { provider: string; auth_type: string; oauth?: ConnectorOAuthSettings | null }): boolean {
  return googleDirect(c) || microsoftDirect(c) || apiADirect(c) || apiBDirect(c) || appleDirect(c) || healthDirect(c) || readingSocialDirect(c) || mediaTravelDirect(c) || netflixDirect(c) || travelDirect(c) || lifeDirect(c) || flightsDirect(c) || liveTravelDirect(c) || carDirect(c) || documentsDirect(c) || lifeBDirect(c) || homeDirect(c) || fastmailDirect(c);
}

/**
 * Presets live in one file per area so parallel work never edits the same
 * list: lib/presets/*.ts each export an array, joined below in this order,
 * always before "Other MCP server", which stays last.
 */
const CORE_PRESETS: ConnectorPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    tagline: "Search and read your email",
    icon: "mail",
    category: "email-calendar",
    url: GOOGLE_API_URL.gmail,
    auth: "oauth",
    scope: GMAIL_READ_SCOPE,
    needsOwnClient: true,
    ownClientLabel: "Google",
    readTools: ["search_threads", "get_thread", "get_message", "list_labels"],
    recipes: ["email-digest", "custom"],
    help:
      "Google doesn't let apps register themselves, so Athena uses an OAuth client from your own Google Cloud project. In that project, turn on the Gmail API, create an OAuth client (type “Web application”), add the redirect URI above, and paste the client's ID and secret. One client works for all your Google accounts. Athena asks for read-only access.",
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    tagline: "Events, attendees and descriptions",
    icon: "calendar",
    category: "email-calendar",
    url: GOOGLE_API_URL["google-calendar"],
    auth: "oauth",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    needsOwnClient: true,
    ownClientLabel: "Google",
    readTools: ["list_events", "get_event", "search_events", "list_calendars"],
    recipes: ["calendar-meetings", "custom"],
    help:
      "Google doesn't let apps register themselves, so Athena uses an OAuth client from your own Google Cloud project, the same one as for Gmail if you have it. In that project, turn on the Google Calendar API, add the redirect URI above to the client, and paste the client's ID and secret. Athena asks for read-only access.",
  },
  {
    id: "granola",
    label: "Granola",
    tagline: "Meeting notes and transcripts",
    icon: "note",
    category: "meetings",
    url: "https://mcp.granola.ai/mcp",
    auth: "oauth",
    scope: "",
    readTools: [
      "list_meetings",
      "search_meetings",
      "get_meetings",
      "get_meeting_transcript",
      "search_transcripts",
      "list_meeting_folders",
      "query_granola_meetings",
    ],
    recipes: ["calendar-meetings", "custom"],
    help: "Meeting notes and transcripts. Signs in with your Granola account. If Granola has moved its MCP endpoint, paste the new URL from their docs.",
  },
  {
    id: "linear",
    label: "Linear",
    tagline: "Issues, projects and cycles",
    icon: "project",
    category: "projects",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    altAuth: ["token"],
    scope: "",
    readTools: [
      "list_issues",
      "get_issue",
      "list_comments",
      "list_projects",
      "get_project",
      "list_teams",
      "get_team",
      "list_users",
      "get_user",
      "list_cycles",
      "list_documents",
      "get_document",
      "list_issue_statuses",
      "list_issue_labels",
      "list_milestones",
      "get_milestone",
    ],
    recipes: ["work-activity", "work-sync", "custom"],
    help: "Signs in with your Linear account. You can paste a personal API key instead.",
  },
  {
    id: "slack",
    label: "Slack",
    tagline: "Search channels and read threads",
    icon: "inbox",
    category: "chat",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth",
    scope: "",
    readTools: [
      "slack_search_public",
      "slack_search_public_and_private",
      "slack_read_channel",
      "slack_read_thread",
      "slack_search_channels",
      "slack_search_users",
      "slack_read_user_profile",
      "slack_list_user_channels",
      "slack_read_canvas",
    ],
    recipes: ["work-activity", "custom"],
    help: "Slack's hosted MCP server. If your workspace requires a registered Slack app, add its client ID and secret under “Your own sign-in client”.",
  },
  {
    id: "github",
    label: "GitHub",
    tagline: "Pull requests, commits and issues",
    icon: "folder",
    category: "engineering",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    altAuth: ["oauth"],
    scope: "",
    readTools: [
      "get_me",
      "list_pull_requests",
      "pull_request_read",
      "search_pull_requests",
      "list_commits",
      "get_commit",
      "list_issues",
      "issue_read",
      "search_issues",
      "list_branches",
    ],
    recipes: ["work-activity", "work-sync", "custom"],
    help: "GitHub's hosted MCP server. Paste a fine-grained personal access token with read-only access to the repositories you want collected.",
  },
  {
    id: "notion",
    label: "Notion",
    tagline: "Search and read pages and databases",
    icon: "library",
    category: "docs",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    scope: "",
    readTools: ["notion-search", "notion-fetch", "notion-get-users", "notion-get-self", "notion-get-comments", "notion-query-data-sources"],
    recipes: ["custom"],
    help: "Signs in with your Notion account and the pages you share with Athena.",
  },
];

const CUSTOM_PRESET: ConnectorPreset = {
  id: "custom",
  label: "Other MCP server",
  tagline: "Any remote MCP server",
  icon: "plug",
  category: "other",
  url: "",
  auth: "oauth",
  altAuth: ["token", "none"],
  scope: "",
  readTools: [],
  recipes: ["custom", "calendar-meetings", "email-digest", "work-activity"],
  help:
    "Any remote MCP server that speaks Streamable HTTP. For OAuth, Athena finds the server's sign-in settings and registers itself where it can. Otherwise, add your own client and the provider's URLs under OAuth settings, or use client credentials for server-to-server access. Every tool starts switched off: you choose what Athena may read.",
};

export const CONNECTOR_PRESETS: ConnectorPreset[] = [...CORE_PRESETS, ...WORK_PRESETS, ...BUSINESS_PRESETS, ...MICROSOFT_PRESETS, ...FASTMAIL_PRESETS, ...API_PRESETS, ...API_B_PRESETS, ...APPLE_PRESETS, ...HEALTH_PRESETS, ...READING_SOCIAL_PRESETS, ...MEDIA_TRAVEL_PRESETS, ...NETFLIX_PRESETS, ...TRAVEL_PRESETS, ...FLIGHTS_PRESETS, ...LIVE_TRAVEL_PRESETS, ...CAR_PRESETS, ...LIFE_PRESETS, ...HOME_PRESETS, ...DOCUMENTS_PRESETS, ...LIFE_B_PRESETS, CUSTOM_PRESET];

export function presetFor(id: string): ConnectorPreset {
  return CONNECTOR_PRESETS.find((p) => p.id === id) ?? CUSTOM_PRESET;
}

/** A server the owner added by address: nothing it says about its own tools is trusted. */
export function isCustomServer(provider: string): boolean {
  return presetFor(provider).id === "custom";
}

/** "Google" for Gmail; the service's own name otherwise. */
export function ownClientName(p: ConnectorPreset): string {
  return p.ownClientLabel ?? p.label;
}

/** Verbs that change something. A tool named like this is never allowed. */
const WRITE_VERBS =
  /(^|[_\-.])(create|update|upsert|delete|remove|send|reply|forward|trash|untrash|archive|unarchive|label|unlabel|move|mark|unmark|post|write|edit|add|set|save|upload|merge|assign|respond|apply|schedule|cancel|invite|share|unshare|publish|unpublish|close|reopen|resolve|unresolve|submit|react|draft|insert|patch|put|modify|rename|duplicate|restore|retire|enable|disable|trigger|run|execute|manage|activate|deactivate|accept|fork|push|approve|dismiss|import|sign|transfer|refund|pay|charge)([_\-.]|$)/i;

/**
 * Whether a tool only reads. Order matters: an explicit read-only annotation
 * or a preset's known-read list wins; then anything named like a write (or
 * annotated destructive) is a write; everything else is unknown — off by
 * default, but the owner may allow it after reading its description.
 * A custom server's read-only annotation is its own word, so it counts for
 * nothing: its tools are unknown until the owner allows them.
 */
export function classifyTool(
  presetId: string,
  name: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null,
): ToolAccess {
  // Match on words: CamelCase splits (CreateFolder → Create_Folder), and
  // GitLab's "merge request" is a noun, so list_merge_requests reads.
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/(^|[_\-.])merge[_\-.]?requests?(?=[_\-.]|$)/gi, "$1mr");
  const namedLikeWrite = WRITE_VERBS.test(words);
  if (annotations?.readOnlyHint === true && !namedLikeWrite && !isCustomServer(presetId)) return "read";
  if (presetFor(presetId).readTools.includes(name)) return "read";
  if (namedLikeWrite || annotations?.destructiveHint === true || annotations?.readOnlyHint === false) return "write";
  return "unknown";
}

export const RECIPES: Array<{ id: RecipeId; label: string; description: string; defaultTime: string }> = [
  {
    id: "calendar-meetings",
    label: "Meetings",
    description: "A note per meeting worth keeping (decisions, action items), attendees linked as people, and a daily meeting-count metric.",
    defaultTime: "07:00",
  },
  {
    id: "email-digest",
    label: "Email digest",
    description: "Action items as notes, travel bookings as trips, and orders as purchases you can track to your door. Never touches the inbox, and never stores figures from financial email.",
    defaultTime: "07:15",
  },
  {
    id: "work-activity",
    label: "Work activity",
    description: "Shipped work, decisions and blockers as notes linked to projects.",
    defaultTime: "18:30",
  },
  {
    id: "life-log",
    label: "Life log",
    description: "What you watched, played, listened to, read and posted, as a note per day, plus daily counts.",
    defaultTime: "21:30",
  },
  {
    id: "plays-watches",
    label: "Your activity",
    description: "What you played, watched, read, posted and saved, your habits and your health days, straight into your days every hour.",
    defaultTime: "08:00",
  },
  {
    id: "work-sync",
    label: "Your work, counted",
    description: "Your own Linear issues and GitHub pull requests, counted every hour for the Work page.",
    defaultTime: "08:00",
  },
  {
    id: "home",
    label: "Home",
    description: "Your energy, bank accounts and appliances, read every hour for House and Money. Kept sealed, and never shown to the AI.",
    defaultTime: "08:00",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Your own instructions, run against the accounts you pick.",
    defaultTime: "08:00",
  },
];

/** Collections Athena runs by itself, with no model: they run even without AI Gateway (media-sync.ts, work-sync.ts, home-run.ts). */
export const NO_MODEL_RECIPES: RecipeId[] = ["plays-watches", "work-sync", "home"];

/** "Email digest" + "personal" → "email-digest-personal"; custom collections use their name. */
export function collectionSource(recipe: RecipeId, name: string, label: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const base = recipe === "custom" ? slug(name) || "collection" : recipe;
  const suffix = slug(label);
  return suffix ? `${base}-${suffix}` : base;
}
