/**
 * Outlook mail and Outlook Calendar without MCP: a narrow, read-only adapter
 * over Microsoft Graph (graph.microsoft.com/v1.0), registered in direct.ts.
 *
 * Why not MCP: Microsoft's own MCP servers for Outlook (Work IQ Mail and
 * Calendar, in Agent 365) need a Microsoft 365 Copilot licence and a work
 * tenant, so most accounts can't use them; Graph works for any work, school
 * or personal account with the owner's own Entra app.
 *
 * The tools keep Gmail's and Google Calendar's names, arguments and JSON
 * fields (microsoft-mail.ts, microsoft-calendar.ts), so collections,
 * precheck and Ask treat an Outlook account as they treat a Google one.
 * Read-only by construction: microsoft-graph.ts only sends GETs, plus an
 * invite reply for a calendar allowed to answer invites, and a new draft for
 * a mail account allowed to save drafts (never a send).
 */
import { microsoftDirect, type MicrosoftProvider } from "../../../lib/presets/microsoft";
import { canDraft, canMove, canRsvp, CREATE_TOOL, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";

/** The calendar writes behind "Let Athena add and update events" (canMove). */
const EVENT_WRITES = new Set([MOVE_TOOL, CREATE_TOOL, UNDO_CREATE_TOOL]);
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { ToolInputError } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { OUTLOOK_MAIL_TOOLS, outlookPreview, outlookRuleLabels } from "./microsoft-mail";
import { mailGuard, skippedCount } from "./mail-guard";
import { OUTLOOK_CALENDAR_TOOLS, chosenOutlookCalendars, outlookCalendarChoices } from "./microsoft-calendar";
import { once } from "./calendar-choice";
import {
  GraphApiError,
  GraphSession,
  MicrosoftTokenError,
  clientRefusedDetail,
  exchangeMicrosoftCode,
  graphUrl,
  microsoftAuthorizationUrl,
  SCHEDULE_URL,
  type GraphContext,
  type GraphTool,
} from "./microsoft-graph";

export function microsoftTools(connector: Pick<Connector, "provider" | "scope">): GraphTool[] {
  // create_draft only once "Let Athena save drafts" is on for it.
  if (connector.provider === "outlook-mail") return OUTLOOK_MAIL_TOOLS.filter((t) => t.name !== "create_draft" || canDraft(connector));
  // respond_to_event only once "Let Athena answer invites" is on for it.
  // move_event, create_event and undo_create_event only with "Let Athena add and update events" on.
  if (connector.provider === "outlook-calendar") return OUTLOOK_CALENDAR_TOOLS.filter((t) => (t.name !== RSVP_TOOL || canRsvp(connector)) && (!EVENT_WRITES.has(t.name) || canMove(connector)));
  return [];
}

const WEBSITE: Record<MicrosoftProvider, string> = { "outlook-mail": "https://outlook.office.com/mail/", "outlook-calendar": "https://outlook.office.com/calendar/" };

/**
 * Open a signed-in account: who it is (/me), and one cheap read of the
 * mailbox or calendar, which proves the sign-in works and that the account
 * has an Outlook mailbox Graph can reach.
 */
export async function openMicrosoft(connector: Connector, secrets: ConnectorSecrets, now: () => Date = () => new Date()): Promise<DirectAccount> {
  if (!secrets.tokens) throw new MicrosoftTokenError("not_signed_in", "Not signed in yet");
  const session = new GraphSession(connector, secrets);
  const probe = connector.provider === "outlook-mail" ? "/me/mailFolders/inbox" : "/me/calendar";
  const [me] = await Promise.all([
    session.get<{ mail?: string | null; userPrincipalName?: string }>(graphUrl("/me", { $select: "mail,userPrincipalName" })),
    session.get(graphUrl(probe, { $select: "id" })),
  ]);
  const ctx: GraphContext = {
    get: (url, opts) => session.get(url, opts),
    respond: canRsvp(connector) ? (url, body) => session.send(url, body) : undefined,
    schedule: connector.provider === "outlook-calendar" ? (body) => session.write("POST", SCHEDULE_URL, body) : undefined,
    move: canMove(connector) ? async (url, body) => void (await session.write("PATCH", url, body)) : undefined,
    create: canMove(connector) ? (url, body) => session.write("POST", url, body) : undefined,
    deleteCreated: canMove(connector)
      ? async (calendarId, eventId) => {
          try {
            await session.deleteCreated(calendarId, eventId);
          } catch (error) {
            if (error instanceof GraphApiError && (error.status === 404 || error.status === 410)) return;
            if (error instanceof Error && /only removes events it added/.test(error.message)) throw new ToolInputError(error.message);
            throw error;
          }
        }
      : undefined,
    saveDraft: connector.provider === "outlook-mail" && canDraft(connector) ? (url, body) => session.createDraft(url, body) : undefined,
    email: me.mail || me.userPrincipalName || "",
    // Calendar: only the calendars the owner switched on (the main one alone until they choose), read once per open.
    calendars: connector.provider === "outlook-calendar" ? once(() => chosenOutlookCalendars({ get: (u) => session.get(u) }, connector.calendars)) : undefined,
    // Outlook mail: the owner's rules, checked by every mail tool (microsoft-mail.ts).
    mail: connector.provider === "outlook-mail" ? mailGuard(connector) : undefined,
    now,
  };
  const tools = microsoftTools(connector);
  return {
    tools,
    calendars: connector.provider === "outlook-calendar" ? () => outlookCalendarChoices(ctx, connector.calendars) : undefined,
    mail: connector.provider === "outlook-mail" ? { labels: () => outlookRuleLabels(ctx), preview: (rules) => outlookPreview(ctx, rules), skipped: () => skippedCount(ctx.mail) } : undefined,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { text: `${name} isn't one of this account's tools`, isError: true };
      try {
        return { text: JSON.stringify(await tool.run(ctx, args ?? {})), isError: false };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        // Answering not granted is about invites, not the account: reading still works.
        if (name === "create_draft" && error instanceof GraphApiError && error.missingPermission) {
          return { text: "Microsoft hasn't given Athena permission to save drafts in this account yet. Turn it off and on again, and finish signing in.", isError: true };
        }
        if (name === RSVP_TOOL && error instanceof GraphApiError && error.missingPermission) {
          return { text: "Microsoft hasn't given Athena permission to answer invites yet. Turn it off and on again, and finish signing in.", isError: true };
        }
        if (EVENT_WRITES.has(name) && error instanceof GraphApiError && error.missingPermission) {
          return { text: "Microsoft hasn't given Athena permission to change events yet. Turn “Let Athena add and update events” off and on again, and finish signing in.", isError: true };
        }
        // One request Microsoft turned down (not found, a query it can't run): the model can try another way.
        if (error instanceof GraphApiError && !microsoftAccountProblem(error) && !error.retryable) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

/** A failure the owner has to fix (sign in again, accept a permission, fix the app, use another account). */
export function microsoftAccountProblem(error: unknown): boolean {
  if (error instanceof MicrosoftTokenError) return error.needsOwner;
  if (error instanceof GraphApiError) return error.status === 401 || error.missingPermission || error.noMailbox;
  return false;
}

/** What a failure means for the account: needs_auth when the owner has a step to take, error otherwise. Null when it isn't Microsoft's. */
export function microsoftFailure(error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  if (error instanceof MicrosoftTokenError) {
    if (error.clientRefused) return { status: "needs_auth", detail: clientRefusedDetail(error) };
    if (error.code === "not_signed_in") return { status: "needs_auth", detail: "Not signed in yet" };
    if (error.needsOwner) return { status: "needs_auth", detail: "Sign in again" };
    return { status: "error", detail: "Microsoft is having trouble right now. Try again in a few minutes." };
  }
  if (error instanceof GraphApiError) {
    if (error.status === 401) return { status: "needs_auth", detail: "Sign in again" };
    if (error.missingPermission || error.noMailbox) return { status: "needs_auth", detail: error.message };
    return { status: "error", detail: error.message };
  }
  return null;
}

export const microsoftAdapter: DirectAdapter = {
  id: "microsoft",
  handles: microsoftDirect,
  tools: microsoftTools,
  serverInfo: (c) => ({ website_url: WEBSITE[c.provider as MicrosoftProvider] }),
  open: (connector, secrets) => openMicrosoft(connector, secrets),
  authorizationUrl: microsoftAuthorizationUrl,
  exchangeCode: exchangeMicrosoftCode,
  accountProblem: microsoftAccountProblem,
  failure: microsoftFailure,
};
