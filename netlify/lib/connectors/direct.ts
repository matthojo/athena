/**
 * Accounts Athena reaches without MCP: it calls the service's own REST API
 * through a narrow, read-only adapter, and offers the same kind of tools an
 * MCP server would. mcp-client.ts asks `directFor(connector)` first; when an
 * adapter takes the account, sign-in, opening, listing tools, calling them
 * and reporting failures all go through that adapter, and MCP isn't used.
 *
 * Registered: Google (Gmail, Google Calendar: google-direct.ts) and Microsoft
 * (Outlook mail and calendar: microsoft-direct.ts), and for the Life log
 * Trakt, YouTube, Letterboxd and Goodreads. A new API-only service
 * adds one adapter here; the interface is in docs/notes/connectors-microsoft.md.
 */
import type { HistoryBackfill } from "./backfill";
import type { RecentSync } from "./media-sync";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import type { StoredTokens } from "./google-api";
import type { CalendarChoice } from "./calendar-choice";
import type { MailAccount } from "./mail-guard";
import { googleAdapter } from "./google-direct";
import { microsoftAdapter } from "./microsoft-direct";
import { traktAdapter } from "./trakt-direct";
import { youtubeAdapter } from "./youtube-direct";
import { letterboxdAdapter } from "./feeds-letterboxd";
import { goodreadsAdapter } from "./feeds-goodreads";
import { redditAdapter } from "./reddit-direct";
import { spotifyAdapter } from "./spotify-direct";
import { lastfmAdapter } from "./lastfm-direct";
import { steamAdapter } from "./steam-direct";
import { icloudAdapter } from "./icloud-direct";
import { stravaAdapter } from "./strava-direct";
import { ouraAdapter } from "./oura-direct";
import { withingsAdapter } from "./withings-direct";
import { tripitAdapter } from "./tripit-direct";
import { plexAdapter } from "./plex-direct";
import { jellyfinAdapter } from "./jellyfin-direct";
import { lichessAdapter } from "./lichess-direct";
import { chesscomAdapter } from "./chesscom-direct";
import { readwiseAdapter } from "./readwise-direct";
import { blueskyAdapter } from "./bluesky-direct";
import { mastodonAdapter } from "./mastodon-direct";
import { whoopAdapter } from "./whoop-direct";
import { polarAdapter } from "./polar-direct";
import { netflixAdapter } from "./netflix-history";
import { swarmAdapter } from "./swarm-direct";
import { habitifyAdapter } from "./habitify-direct";
import { monzoAdapter } from "./monzo-direct";
import { starlingAdapter } from "./starling-direct";
import { octopusAdapter } from "./octopus-direct";
import { todoistAdapter } from "./todoist-direct";
import { flightsAdapter } from "./flights-direct";
import { liveTravelAdapter } from "./live-travel-direct";
import { carAdapter } from "./car-direct";
import { googleDocsAdapter } from "./google-docs";
import { listenbrainzAdapter } from "./listenbrainz-direct";
import { raindropAdapter } from "./raindrop-direct";
import { eventbriteAdapter } from "./eventbrite-direct";
import { homeConnectAdapter } from "./homeconnect-direct";
import { fastmailAdapter } from "./fastmail-direct";

/** A tool as the account offers it: what Claude reads and what the owner sees. */
export interface DirectToolInfo {
  name: string;
  /** For Claude: what it does and how to call it. */
  description: string;
  /** For the owner, on the account's page: a few plain words. */
  summary: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
}

/** An account, open and signed in. */
export interface DirectAccount {
  tools: DirectToolInfo[];
  /** Run one tool. A request that went wrong comes back as `isError`; a problem with the account (accountProblem) is thrown. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Calendar accounts: every calendar, how busy, and whether Athena reads it (calendar-choice.ts). */
  calendars?(): Promise<CalendarChoice[]>;
  /** Gmail and Outlook mail: labels for the owner's rules, the rules' preview, and what they kept out (mail-guard.ts). */
  mail?: MailAccount;
}

/** One meter (or the like) to pick: which group it fills and with what. */
export interface AddressChoice {
  group: string;
  values: Record<string, string>;
  label: string;
}

export interface DirectAdapter {
  /** "google", "microsoft": for logs and tests. */
  id: string;
  /** Does this adapter reach the account? */
  handles(connector: Pick<Connector, "provider" | "auth_type" | "oauth">): boolean;
  /** The tools the account offers, without opening it. */
  tools(connector: Pick<Connector, "provider" | "scope">): DirectToolInfo[];
  /** What the account page shows about where it connects. */
  serverInfo(connector: Pick<Connector, "provider">): Connector["server_info"];
  /** Open a signed-in account: one cheap read that proves the sign-in works. Throws on failure (see `failure`). */
  open(connector: Connector, secrets: ConnectorSecrets): Promise<DirectAccount>;
  /**
   * The provider's consent page for the owner's own OAuth client, with PKCE.
   * Only for adapters whose accounts sign in with OAuth; an adapter for API
   * keys (auth_type "token") or open feeds ("none") leaves this and
   * exchangeCode out, and Athena never starts a browser sign-in for it.
   */
  /** Signs in with PKCE alone: the account needs a client ID and no client secret, and none is sent. */
  noClientSecret?: boolean;
  authorizationUrl?(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string;
  /**
   * For OAuth 1.0 (TripIt), instead of authorizationUrl: get a request token
   * first, and return the consent page and what to keep until the callback
   * (sealed as the account's codeVerifier). The callback's oauth_token then
   * reaches exchangeCode as `code`.
   */
  beginSignIn?(input: { client: { client_id: string; client_secret?: string }; redirectUri: string; state: string }): Promise<{ url: string; verifier: string }>;
  /** The callback's code, swapped for tokens (stored sealed by the caller). */
  exchangeCode?(input: { code: string; redirectUri: string; verifier: string; scope: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens>;
  /**
   * For an account added by its address (a profile or feed): the address
   * Athena keeps, or an AthenaInputError saying what to paste instead. Called
   * when the account is added, so a wrong address never gets saved.
   */
  checkAddress?(url: string): string;
  /**
   * Fill a fields address in from the service itself (Octopus: the meters on
   * an account number), read-only, with the key given or the account's own.
   */
  findAddress?(query: string, secrets: ConnectorSecrets): Promise<AddressChoice[]>;
  /** An account with history: read all of it on connect, page by page, without a model (backfill.ts). */
  backfill?: HistoryBackfill;
  /** New plays and watches, read every hour without a model (media-sync.ts). */
  recent?: RecentSync;
  /** A failure the owner has to fix (sign in again, allow a permission…), rather than one request going wrong. */
  accountProblem(error: unknown): boolean;
  /** What a failure means for the account, in the existing statuses; null when it isn't this adapter's. */
  failure(error: unknown): { status: "needs_auth" | "error"; detail: string } | null;
}

export const DIRECT_ADAPTERS: DirectAdapter[] = [
  googleAdapter,
  microsoftAdapter,
  // Life log (Trakt, YouTube, Letterboxd, Goodreads: trakt-direct.ts, youtube-direct.ts, feeds-*.ts).
  traktAdapter,
  youtubeAdapter,
  letterboxdAdapter,
  goodreadsAdapter,
  // Life log (Reddit, Spotify, Last.fm, Steam: reddit-direct.ts, spotify-direct.ts, lastfm-direct.ts, steam-direct.ts).
  redditAdapter,
  spotifyAdapter,
  lastfmAdapter,
  steamAdapter,
  // iCloud Calendar and Contacts, over CalDAV and CardDAV (icloud-direct.ts).
  icloudAdapter,
  // Health (Strava, Oura, Withings: strava-direct.ts, oura-direct.ts, withings-direct.ts).
  stravaAdapter,
  ouraAdapter,
  withingsAdapter,
  // Media, chess and travel (plex-direct.ts, jellyfin-direct.ts, lichess-direct.ts, chesscom-direct.ts, tripit-direct.ts).
  plexAdapter,
  jellyfinAdapter,
  lichessAdapter,
  chesscomAdapter,
  tripitAdapter,
  // Life log (Readwise, Bluesky, Mastodon: readwise-direct.ts, bluesky-direct.ts, mastodon-direct.ts).
  readwiseAdapter,
  blueskyAdapter,
  mastodonAdapter,
  // Whoop and Polar (whoop-direct.ts, polar-direct.ts).
  whoopAdapter,
  polarAdapter,
  // Netflix: import-only, nothing to call (netflix-history.ts).
  netflixAdapter,
  // Places and travel (Swarm: swarm-direct.ts).
  swarmAdapter,
  // Habits, money and home (habitify-direct.ts, monzo-direct.ts, starling-direct.ts, octopus-direct.ts). Money and home are read by money-sync.ts, never by Claude.
  habitifyAdapter,
  monzoAdapter,
  starlingAdapter,
  octopusAdapter,
  // Todoist with a personal token (todoist-direct.ts); signed in with OAuth it stays on the hosted MCP server.
  todoistAdapter,
  // Live flight times (OpenSky: flights-direct.ts). No tools: Athena asks them itself (live-flights.ts).
  flightsAdapter,
  // Live travel keys (Google Maps routes, TfL, National Rail: live-travel-direct.ts). No tools: Athena asks them itself (live-travel.ts, directions.ts).
  liveTravelAdapter,
  // The car (DVLA, DVSA MOT history: car-direct.ts). No tools: the car sync asks them itself (car-api.ts).
  carAdapter,
  // Google Docs: "Send to Google Docs" only, drive.file. No tools: Athena writes to it itself (google-docs.ts, lib/documents.ts).
  googleDocsAdapter,
  // More of the Life log, from the connectors audit (listenbrainz-direct.ts, raindrop-direct.ts, eventbrite-direct.ts).
  listenbrainzAdapter,
  raindropAdapter,
  eventbriteAdapter,
  // Home appliances (homeconnect-direct.ts): read-only, and looked at every 15 minutes by home/appliance-sync.ts.
  homeConnectAdapter,
  // Fastmail email over JMAP with an API token (fastmail-direct.ts): read-only, Gmail's tool names.
  fastmailAdapter,
];

/** The adapter that reaches this account directly, or undefined when it goes through MCP. */
export function directFor(connector: Pick<Connector, "provider" | "auth_type" | "oauth">): DirectAdapter | undefined {
  return DIRECT_ADAPTERS.find((a) => a.handles(connector));
}

/** The first adapter that recognises a failure, and what it means for the account. */
export function directFailure(error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  for (const a of DIRECT_ADAPTERS) {
    const f = a.failure(error);
    if (f) return f;
  }
  return null;
}

/** Is this a failure the owner has to fix, by any adapter's reckoning? */
export function directAccountProblem(error: unknown): boolean {
  return DIRECT_ADAPTERS.some((a) => a.accountProblem(error));
}
