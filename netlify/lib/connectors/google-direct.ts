/**
 * Gmail and Google Calendar without Google's MCP servers: a narrow,
 * read-only adapter over Google's ordinary REST APIs
 * (gmail.googleapis.com/gmail/v1, www.googleapis.com/calendar/v3).
 *
 * Why: Google's MCP servers are in Google's Workspace Developer Preview, and
 * their tools refuse accounts that aren't enrolled in it. The REST APIs only
 * need the Gmail API or the Google Calendar API turned on in the project the
 * owner's OAuth client lives in. Same client, same scopes, same stored
 * tokens: Google scopes a token by permission, not by server.
 *
 * mcp-client.ts sends a Gmail or Google Calendar account here unless it has
 * been switched back to the MCP server (`oauth.google_route`, googleDirect()
 * in lib/connector-presets.ts). Everything else (collections, recipes,
 * allowlists, drafts, Ask) calls the same tools as before:
 *  - Gmail: search_threads, get_thread, get_message, list_labels, and
 *    create_draft only for an account with drafts on (google-gmail.ts);
 *  - Calendar: list_calendars, list_events, search_events, get_event, and
 *    respond_to_event only for an account allowed to answer invites
 *    (google-calendar.ts).
 *
 * Read-only by construction (google-api.ts): GETs, plus the one POST that
 * saves a draft. mcp-client's callTool refuses send, reply and forward
 * tools before anything reaches here.
 */
import { canDraft, canMove, canRsvp, CREATE_TOOL, GOOGLE_API_URL, googleDirect, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL, type GoogleProvider } from "../../../lib/connector-presets";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { GoogleApiError, GoogleSession, GoogleTokenError, ToolInputError, DRAFTS_URL, FREEBUSY_URL, apiUrl, authorizationUrl, exchangeCode, type CreateInsert, type DirectTool, type GoogleContext, type MovePatch, type RsvpPatch } from "./google-api";
import type { DirectAdapter } from "./direct";
import { GMAIL_TOOLS, gmailPreview, gmailRuleLabels } from "./google-gmail";
import { mailGuard, skippedCount, type MailAccount } from "./mail-guard";
import { CALENDAR_TOOLS, chosenGoogleCalendars, googleCalendarChoices } from "./google-calendar";
import { once, type CalendarChoice } from "./calendar-choice";

export interface GoogleDirect {
  tools: DirectTool[];
  /** Run one tool. A request that went wrong comes back as `isError`; a problem with the account (accountProblem) is thrown. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Google Calendar: every calendar, for the owner to choose which ones Athena reads. */
  calendars?(): Promise<CalendarChoice[]>;
  /** Gmail: the owner's mail rules' labels, preview and count (mail-guard.ts). */
  mail?: MailAccount;
}

/** The calendar writes behind "Let Athena add and update events" (canMove). */
export const EVENT_WRITES = new Set([MOVE_TOOL, CREATE_TOOL, UNDO_CREATE_TOOL]);

/** The tools an account offers: create_draft only once drafts are on for it. */
export function directTools(connector: Pick<Connector, "provider" | "scope">): DirectTool[] {
  if (connector.provider === "gmail") return GMAIL_TOOLS.filter((t) => t.name !== "create_draft" || canDraft(connector));
  // respond_to_event only once "Let Athena answer invites" is on for it; move_event only with "Let Athena add and update events";
  // create_event and undo_create_event go with it.
  if (connector.provider === "google-calendar") return CALENDAR_TOOLS.filter((t) => (t.name !== RSVP_TOOL || canRsvp(connector)) && (!EVENT_WRITES.has(t.name) || canMove(connector)));
  return [];
}

/** What the account page shows about where it connects (there's no server to report itself). */
export function directServerInfo(provider: GoogleProvider): Connector["server_info"] {
  return { website_url: provider === "gmail" ? "https://mail.google.com" : "https://calendar.google.com" };
}

/**
 * Open a signed-in account. Like an MCP server's handshake, one cheap read
 * (Gmail's profile, or the primary calendar) proves the sign-in works and
 * the API is on, and gives the account's address and time zone.
 */
export async function openGoogle(connector: Connector, secrets: ConnectorSecrets): Promise<GoogleDirect> {
  if (!secrets.tokens) throw new GoogleTokenError("not_signed_in", "Not signed in yet");
  const session = new GoogleSession(connector, secrets);
  const provider = connector.provider as GoogleProvider;
  let email = "";
  let timeZone: string | undefined;
  if (provider === "gmail") {
    const profile = (await session.request({ method: "GET", url: `${GOOGLE_API_URL.gmail}/users/me/profile` })) as { emailAddress?: string };
    email = profile.emailAddress ?? "";
  } else {
    const primary = (await session.request({ method: "GET", url: apiUrl(GOOGLE_API_URL[provider], "/calendars/primary", { fields: "id,timeZone" }) })) as {
      id?: string;
      timeZone?: string;
    };
    email = primary.id ?? "";
    timeZone = primary.timeZone;
  }
  const get = async <T>(url: string) => (await session.request({ method: "GET", url })) as T;
  const ctx: GoogleContext = {
    get,
    saveDraft: async <T>(body: unknown) => (await session.request({ method: "POST", url: DRAFTS_URL, body })) as T,
    patchRsvp: canRsvp(connector) ? async <T>(url: string, body: RsvpPatch) => (await session.request({ method: "PATCH", url, body })) as T : undefined,
    freeBusy: provider === "google-calendar" ? async <T>(body: unknown) => (await session.request({ method: "POST", url: FREEBUSY_URL, body })) as T : undefined,
    patchMove: canMove(connector) ? async <T>(url: string, body: MovePatch) => (await session.request({ method: "PATCH", url, body })) as T : undefined,
    insertEvent: canMove(connector) ? async <T>(url: string, body: CreateInsert) => (await session.request({ method: "POST", url, body })) as T : undefined,
    deleteCreated: canMove(connector)
      ? async (calendarId: string, eventId: string) => {
          try {
            await session.deleteCreated(calendarId, eventId);
          } catch (error) {
            // Already gone from Google: nothing left to take back.
            if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) return;
            if (error instanceof Error && /only removes events it added/.test(error.message)) throw new ToolInputError(error.message);
            throw error;
          }
        }
      : undefined,
    email,
    timeZone,
    // Calendar: only the calendars the owner switched on (the primary alone until they choose), read once per open.
    calendars: provider === "google-calendar" ? once(() => chosenGoogleCalendars({ get }, connector.calendars)) : undefined,
    // Gmail: the owner's rules, checked by every mail tool (google-gmail.ts).
    mail: provider === "gmail" ? mailGuard(connector) : undefined,
    now: () => new Date(),
  };
  const tools = directTools(connector);
  return {
    tools,
    calendars: provider === "google-calendar" ? () => googleCalendarChoices(ctx, connector.calendars) : undefined,
    mail: provider === "gmail" ? { labels: () => gmailRuleLabels(ctx), preview: (rules) => gmailPreview(ctx, rules), skipped: () => skippedCount(ctx.mail) } : undefined,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { text: `${name} isn't one of this account's tools`, isError: true };
      try {
        return { text: JSON.stringify(await tool.run(ctx, args ?? {})), isError: false };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        if (error instanceof GoogleApiError) {
          // Drafts not granted is about drafts, not the account: reading still works.
          if (name === "create_draft" && error.missingPermission) return { text: "Google hasn't given Athena permission to save drafts in this account yet.", isError: true };
          if (name === RSVP_TOOL && error.missingPermission) return { text: "Google hasn't given Athena permission to answer invites yet. Turn it off and on again, and finish signing in.", isError: true };
          if (EVENT_WRITES.has(name) && error.missingPermission) return { text: "Google hasn't given Athena permission to change events yet. Turn “Let Athena add and update events” off and on again, and finish signing in.", isError: true };
          // One request Google turned down (not found, a bad query, a calendar the owner can't see).
          if (!accountProblem(error) && !error.retryable) return { text: error.message, isError: true };
        }
        throw error;
      }
    },
  };
}

/** A failure the owner has to fix (sign in again, allow a permission, turn the API on), rather than one request going wrong. */
export function accountProblem(error: unknown): boolean {
  if (error instanceof GoogleTokenError) return error.needsOwner;
  if (error instanceof GoogleApiError) return error.status === 401 || error.apiDisabled || error.missingPermission;
  return false;
}

/**
 * What a failure means for the account, in the existing statuses: needs_auth
 * when signing in again (or fixing the client) is the way out, error when it's
 * something else. Null when it isn't one of Google's.
 */
export function googleFailure(error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  if (error instanceof GoogleTokenError) {
    if (error.clientRefused) return { status: "needs_auth", detail: "Google refused Athena's OAuth client. Check the client ID and secret under Edit, then sign in again." };
    if (error.code === "not_signed_in") return { status: "needs_auth", detail: "Not signed in yet" };
    if (error.needsOwner) return { status: "needs_auth", detail: "Sign in again" };
    return { status: "error", detail: "Google is having trouble right now. Try again in a few minutes." };
  }
  if (error instanceof GoogleApiError) {
    if (error.status === 401) return { status: "needs_auth", detail: "Sign in again" };
    if (error.missingPermission) return { status: "needs_auth", detail: error.message };
    return { status: "error", detail: error.message };
  }
  return null;
}

/** Gmail and Google Calendar in direct.ts's registry: the functions above, unchanged. */
export const googleAdapter: DirectAdapter = {
  id: "google",
  handles: googleDirect,
  tools: directTools,
  serverInfo: (c) => directServerInfo(c.provider as GoogleProvider),
  open: openGoogle,
  authorizationUrl,
  exchangeCode: ({ code, redirectUri, verifier, client }) => exchangeCode({ code, redirectUri, verifier, client }),
  accountProblem,
  failure: googleFailure,
};
