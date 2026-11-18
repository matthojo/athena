/**
 * The plumbing under microsoft-direct.ts: Microsoft's sign-in endpoints (the
 * `common` tenant, so work, school and personal accounts all work), the
 * account's access token (renewed at login.microsoftonline.com and saved back
 * sealed: Microsoft hands out a new refresh token with each renewal), and GETs
 * to Microsoft Graph with retries and plain-English failures.
 *
 * Only GETs leave this file, plus four checked shapes (allowedWrite): your
 * own reply to an invite (isRsvpPost: an event's accept, tentativelyAccept or
 * decline), a getSchedule free/busy read (isSchedulePost), a new start and
 * end for an event you organise (isMovePatch), and a new draft for an
 * account with drafts on (isDraftCreate: POST /me/messages, or createReply on
 * one message, which only make drafts). With "Let Athena add and update
 * events" on there are two more: a new event with only its title, times,
 * zone, place, description and guests (isCreatePost), and the DELETE that
 * undoes one (isCreatedDelete), which only `deleteCreated` sends, after
 * calendar_creates says Athena added that event. Nothing else is sent, so no code path can send mail,
 * flag, delete or edit anything else about an event.
 * Tokens, response bodies and request URLs (which carry search words) are
 * never logged.
 */
import { MICROSOFT_GRAPH_URL, type MicrosoftProvider } from "../../../lib/presets/microsoft";
import { oauthScope } from "../../../lib/connector-presets";
import { updateConnectorSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import type { StoredTokens } from "./google-api";
import type { ChosenCalendar } from "./calendar-choice";
import type { MailGuard } from "./mail-guard";
import { ledger } from "../../../lib/calendar-creates";

export const MICROSOFT_TENANT = "common";
export const MICROSOFT_AUTHORIZE_URL = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/authorize`;
export const MICROSOFT_TOKEN_URL = `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`;
export const GRAPH = MICROSOFT_GRAPH_URL;

const REQUEST_TIMEOUT_MS = 30_000;
/** Waits before each retry of a 429, a 5xx or a dropped connection (so two retries). Tests shorten them. */
export const graphRetryWaits = { ms: [600, 1800], maxRetryAfterMs: 5_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Errors ----------

/** Graph refused a request. `message` is plain English for the owner; `detail` is what Graph said. */
export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly provider: MicrosoftProvider,
  ) {
    super(graphMessage(status, code, detail));
    this.name = "GraphApiError";
  }

  /** The token lacks a permission this needs (declined on Microsoft's consent page, or blocked by an admin). */
  get missingPermission(): boolean {
    return this.status === 403 && /^(ErrorAccessDenied|AccessDenied|Authorization_RequestDenied|ErrorInsufficientPermissionsInAccessToken)$/i.test(this.code);
  }

  /** The account has no mailbox Graph can read (a Microsoft account without Outlook.com, or mail kept on a company's own server). */
  get noMailbox(): boolean {
    return /^(MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI|ErrorMailboxNotEnabled|ResourceNotFound.*mailbox)$/i.test(this.code) || /mailbox is either inactive, soft-deleted, or is hosted on-premise/i.test(this.detail);
  }

  /** Worth trying again shortly: throttling and Microsoft's own trouble. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 504 || this.status === 509 || (this.status >= 500 && this.code !== "ErrorInvalidRequest");
  }
}

function graphMessage(status: number, code: string, detail: string): string {
  if (status === 401) return "Microsoft didn't accept the sign-in. Sign in again";
  if (status === 403 && /^(ErrorAccessDenied|AccessDenied|Authorization_RequestDenied|ErrorInsufficientPermissionsInAccessToken)$/i.test(code)) {
    return "Sign in again and accept every permission Athena asks for. If it's a work account, your IT admin may need to allow Athena first.";
  }
  if (/^(MailboxNotEnabledForRESTAPI|MailboxNotSupportedForRESTAPI|ErrorMailboxNotEnabled)$/i.test(code) || /hosted on-premise/i.test(detail)) {
    return "This Microsoft account has no Outlook mailbox Athena can read. Sign in with the account you use for Outlook.";
  }
  if (status === 429 || status === 509) return "Microsoft is limiting how often Athena can ask right now. Try again in a few minutes.";
  if (status >= 500) return "Microsoft is having trouble right now. Try again in a few minutes.";
  if (status === 404 || status === 410) return `Not found: ${detail}`;
  return `Microsoft refused that (${status}): ${detail}`;
}

/** Graph's JSON error (`{ error: { code, message } }`) as a GraphApiError. */
export function parseGraphError(status: number, body: unknown, provider: MicrosoftProvider): GraphApiError {
  const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const e = raw && typeof raw === "object" ? (raw as { code?: unknown; message?: unknown }) : {};
  const code = typeof e.code === "string" ? e.code : `http_${status}`;
  const detail = typeof e.message === "string" && e.message.trim() ? e.message.trim().slice(0, 300) : `HTTP ${status}`;
  return new GraphApiError(status, code, detail, provider);
}

/**
 * Microsoft's token endpoint refused, there's nothing to renew the sign-in
 * with, or Microsoft couldn't be reached. `aadsts` is Entra's numeric code
 * (AADSTS70008 and so on), which says more than the OAuth error does.
 */
export class MicrosoftTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly aadsts?: number,
  ) {
    super(message);
    this.name = "MicrosoftTokenError";
  }

  /** The owner has to act (sign in again, or fix the app); otherwise it was a passing failure. */
  get needsOwner(): boolean {
    return ["invalid_grant", "no_refresh_token", "invalid_client", "unauthorized_client", "not_signed_in", "interaction_required", "consent_required", "invalid_request"].includes(this.code);
  }

  /** Microsoft refused the app itself: wrong ID or secret, an expired secret, or an app that only takes its own organisation's accounts. */
  get clientRefused(): boolean {
    return this.code === "invalid_client" || this.code === "unauthorized_client" || [7000215, 7000222, 700016, 50194, 700054].includes(this.aadsts ?? 0);
  }
}

/** What the owner should do when Microsoft refuses the app, by Entra's code. */
export function clientRefusedDetail(error: MicrosoftTokenError): string {
  if (error.aadsts === 7000222) return "The client secret has expired. Add a new one in the Entra admin centre, paste it under Edit, then sign in again.";
  if (error.aadsts === 50194) return "Your Microsoft app only accepts accounts from its own organisation. In the Entra admin centre, set it to accept any organisation's accounts and personal accounts, then sign in again.";
  if (error.aadsts === 700016) return "Microsoft can't find an app with that client ID. Check it under Edit, then sign in again.";
  return "Microsoft refused Athena's app. Check the client ID and secret under Edit, then sign in again.";
}

/** Expired, or about to be (a minute's grace). Unknown lifetimes count as fresh: a 401 says otherwise. */
function expired(t: StoredTokens): boolean {
  const at = typeof t.obtained_at === "number" ? t.obtained_at : 0;
  const life = typeof t.expires_in === "number" ? t.expires_in : 0;
  return !!at && !!life && Date.now() > at + (life - 60) * 1000;
}

/** POST to Microsoft's token endpoint (form-encoded). Retries 429 and 5xx; refusals become MicrosoftTokenError. */
async function tokenRequest(params: Record<string, string>): Promise<StoredTokens> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(MICROSOFT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < graphRetryWaits.ms.length) {
        await sleep(graphRetryWaits.ms[attempt]);
        continue;
      }
      throw new MicrosoftTokenError("unreachable", "Couldn't reach Microsoft to renew the sign-in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      return {
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expires_in: typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in) || undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        token_type: typeof body.token_type === "string" ? body.token_type : undefined,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < graphRetryWaits.ms.length) {
      await sleep(graphRetryWaits.ms[attempt]);
      continue;
    }
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    const description = typeof body?.error_description === "string" ? body.error_description : "";
    const codes = Array.isArray(body?.error_codes) ? (body.error_codes as unknown[]) : [];
    const aadsts = typeof codes[0] === "number" ? codes[0] : Number(/AADSTS(\d+)/.exec(description)?.[1]) || undefined;
    // Entra's descriptions carry a trace id and a timestamp after the first line: keep just the sentence.
    const first = description.split(/\r?\n| Trace ID:/)[0].replace(/^AADSTS\d+:\s*/, "").trim().slice(0, 200);
    throw new MicrosoftTokenError(code, first ? `${first} (${code})` : code, aadsts);
  }
}

// ---------- Sign-in (authorisation code with PKCE) ----------

/** Microsoft's consent page for the owner's app and the account's scopes. select_account so the owner picks which account each time. */
export function microsoftAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(MICROSOFT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** The callback's code, swapped for tokens. */
export async function exchangeMicrosoftCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
  scope: string;
  client: { client_id: string; client_secret?: string };
}): Promise<StoredTokens> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.client_id,
    ...(input.client.client_secret ? { client_secret: input.client.client_secret } : {}),
    code_verifier: input.verifier,
    scope: input.scope,
  });
  if (!tokens.refresh_token) throw new MicrosoftTokenError("no_refresh_token", "Microsoft gave Athena no way to renew this sign-in");
  return { ...tokens, obtained_at: Date.now() };
}

// ---------- Requests ----------

/** "/me/messages" + { $top: 10, $select: "id,subject" } → a Graph URL; empty values are left out. */
export function graphUrl(path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function retryAfterMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, graphRetryWaits.maxRetryAfterMs);
  return graphRetryWaits.ms[attempt];
}

/** Where renewed tokens are saved. Tests swap it for a stub. */
export const tokenStore = {
  save: (id: string, mutate: (s: ConnectorSecrets) => void): Promise<void> => updateConnectorSecrets(id, mutate),
};

/** One Microsoft account, signed in: its token, renewed when needed, and GETs made with it. */
export class GraphSession {
  private renewing: Promise<string> | null = null;

  constructor(
    readonly connector: Pick<Connector, "id" | "provider" | "scope">,
    private readonly secrets: ConnectorSecrets,
  ) {}

  get provider(): MicrosoftProvider {
    return this.connector.provider as MicrosoftProvider;
  }

  private get tokens(): StoredTokens | undefined {
    return this.secrets.tokens as StoredTokens | undefined;
  }

  async accessToken(): Promise<string> {
    const t = this.tokens;
    if (t?.access_token && !expired(t)) return t.access_token;
    return this.renew();
  }

  /** Renew the access token: once, however many requests are waiting for it. */
  renew(): Promise<string> {
    this.renewing ??= this.doRenew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async doRenew(): Promise<string> {
    const refreshToken = this.tokens?.refresh_token;
    if (!refreshToken) throw new MicrosoftTokenError("no_refresh_token", "Microsoft gave Athena no way to renew this sign-in");
    const client = this.secrets.ownClient;
    if (!client?.client_id) throw new MicrosoftTokenError("invalid_client", "No Microsoft app is saved for this account");
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      scope: oauthScope(this.connector),
    });
    // Microsoft usually sends a new refresh token and retires the old one in time: keep whichever is newest.
    const tokens: StoredTokens = { ...fresh, refresh_token: fresh.refresh_token ?? refreshToken, obtained_at: Date.now() };
    this.secrets.tokens = { ...tokens };
    // Saved sealed, unless the owner signed in again meanwhile (a different refresh token is stored, or none while it's under way).
    await tokenStore.save(this.connector.id, (s) => {
      if ((s.tokens as StoredTokens | undefined)?.refresh_token !== refreshToken) return;
      s.tokens = { ...tokens };
    });
    return tokens.access_token!;
  }

  /**
   * GET a Graph URL. A 401 renews the token once and tries again; 429, 5xx
   * and dropped connections are retried with backoff, honouring Retry-After.
   * `text` asks Graph for bodies as plain text instead of HTML. Resolves to
   * the JSON body; throws GraphApiError.
   */
  async get<T = Record<string, unknown>>(url: string, opts: { text?: boolean } = {}): Promise<T> {
    if (!url.startsWith(`${GRAPH}/`)) throw new Error("Athena only reads from Microsoft Graph");
    let renewed = false;
    for (let attempt = 0; ; ) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            // Times in UTC everywhere; bodies as text when asked (Graph converts HTML itself).
            Prefer: [`outlook.timezone="UTC"`, opts.text ? `outlook.body-content-type="text"` : ""].filter(Boolean).join(", "),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < graphRetryWaits.ms.length) {
          await sleep(graphRetryWaits.ms[attempt++]);
          continue;
        }
        throw new GraphApiError(503, "unreachable", "Couldn't reach Microsoft", this.provider);
      }
      if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
      const error = parseGraphError(res.status, await res.json().catch(() => null), this.provider);
      if (res.status === 401 && !renewed && this.tokens?.refresh_token) {
        renewed = true;
        await this.renew();
        continue;
      }
      if (error.retryable && attempt < graphRetryWaits.ms.length) {
        await sleep(retryAfterMs(res, attempt++));
        continue;
      }
      throw error;
    }
  }

  /**
   * The writes there are, each checked by shape (allowedWrite): an invite
   * reply, a getSchedule read (a POST, but it changes nothing) and the move
   * PATCH. A 401 renews the token once; only a 429 is retried, so nothing is
   * sent twice. Resolves to the JSON body ({} when there's none).
   */
  async write<T = Record<string, unknown>>(method: "POST" | "PATCH", url: string, body: unknown): Promise<T> {
    if (!allowedWrite(method, url, body)) throw new Error("Athena only reads from Microsoft Graph");
    return this.transmit<T>(method, url, body);
  }

  /**
   * Undo of create_event: DELETE one event, only when calendar_creates says
   * Athena added it and hasn't taken it back. Outlook sends the guests a
   * cancellation. The only way a DELETE leaves Athena for Graph.
   */
  async deleteCreated(calendarId: string, eventId: string): Promise<void> {
    const url = `${GRAPH}/me/events/${encodeURIComponent(eventId)}`;
    if (!isCreatedDelete(url, undefined) || !(await ledger.has(this.connector.id, calendarId, eventId))) throw new Error("Athena only removes events it added itself");
    await this.transmit("DELETE", url, undefined);
  }

  private async transmit<T>(method: "POST" | "PATCH" | "DELETE", url: string, body: unknown): Promise<T> {
    let renewed = false;
    for (let attempt = 0; ; ) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(method === "DELETE" ? {} : { "Content-Type": "application/json" }), Prefer: `outlook.timezone="UTC"` },
          body: method === "DELETE" ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new GraphApiError(503, "unreachable", "Couldn't reach Microsoft", this.provider);
      }
      if (res.ok) return (res.status === 202 || res.status === 204 ? {} : await res.json().catch(() => ({}))) as T;
      const error = parseGraphError(res.status, await res.json().catch(() => null), this.provider);
      if (res.status === 401 && !renewed && this.tokens?.refresh_token) {
        renewed = true;
        await this.renew();
        continue;
      }
      if (res.status === 429 && attempt < graphRetryWaits.ms.length) {
        await sleep(retryAfterMs(res, attempt++));
        continue;
      }
      throw error;
    }
  }

  /** Your reply to one invite (isRsvpPost). */
  async send(url: string, body: { sendResponse: true }): Promise<void> {
    if (!isRsvpPost(url, body)) throw new Error("Athena only reads from Microsoft Graph");
    await this.write("POST", url, body);
  }

  /** Save a draft (isDraftCreate). Never retried after a dropped connection, so it's never saved twice; 429 waits and tries again. */
  async createDraft<T = Record<string, unknown>>(url: string, body: DraftCreateBody): Promise<T> {
    if (!isDraftCreate(url, body)) throw new Error("Athena only saves drafts in Outlook, and never sends");
    return this.write<T>("POST", url, body);
  }
}

const GRAPH_RE = GRAPH.replace(/[.]/g, "\\.");
const RSVP_POST = new RegExp(`^${GRAPH_RE}/me/events/[^/?#]+/(accept|tentativelyAccept|decline)$`);

/** Is this your reply to one invite, and nothing more? `sendResponse` tells the organiser, as Outlook does. */
export function isRsvpPost(url: string, body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  return RSVP_POST.test(url) && !!b && typeof b === "object" && Object.keys(b).join() === "sendResponse" && b.sendResponse === true;
}

const NEW_DRAFT = new RegExp(`^${GRAPH_RE}/me/messages$`);
const DRAFT_REPLY = new RegExp(`^${GRAPH_RE}/me/messages/[A-Za-z0-9_=+-]+/createReply$`);

interface DraftRecipient {
  emailAddress: { address: string; name?: string };
}
/** A new draft (POST /me/messages) or a draft reply (POST …/createReply). Nothing else. */
export type DraftCreateBody =
  | { subject: string; body: { contentType: "Text"; content: string }; toRecipients: DraftRecipient[] }
  | { comment: string; message?: { toRecipients: DraftRecipient[] } };

const onlyKeys = (o: unknown, allowed: string[], required: string[] = []): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => allowed.includes(k)) && required.every((k) => k in (o as object));
const recipients = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 50 &&
  v.every((r) => onlyKeys(r, ["emailAddress"], ["emailAddress"]) && onlyKeys(r.emailAddress, ["address", "name"], ["address"]) && typeof (r.emailAddress as { address: unknown }).address === "string");

/**
 * Is this a draft and nothing more? A new message in Drafts with only a
 * subject, a plain-text body and who it's to; or a reply draft on one
 * message with only the words and who it's to. Graph's send, reply,
 * forward, sendMail, move and every other path are refused, and so is any
 * extra field (a cc, attachments, a send time, a folder).
 */
export function isDraftCreate(url: string, body: unknown): body is DraftCreateBody {
  if (NEW_DRAFT.test(url)) {
    if (!onlyKeys(body, ["subject", "body", "toRecipients"], ["subject", "body", "toRecipients"])) return false;
    const b = body.body;
    return typeof body.subject === "string" && onlyKeys(b, ["contentType", "content"], ["contentType", "content"]) && b.contentType === "Text" && typeof b.content === "string" && recipients(body.toRecipients);
  }
  if (DRAFT_REPLY.test(url)) {
    if (!onlyKeys(body, ["comment", "message"], ["comment"]) || typeof body.comment !== "string") return false;
    return body.message === undefined || (onlyKeys(body.message, ["toRecipients"], ["toRecipients"]) && recipients((body.message as { toRecipients: unknown }).toRecipients));
  }
  return false;
}

export const SCHEDULE_URL = `${GRAPH}/me/calendar/getSchedule`;
const GRAPH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const isUtcTime = (v: unknown) => {
  const t = v as Record<string, unknown> | null;
  return !!t && typeof t === "object" && Object.keys(t).sort().join() === "dateTime,timeZone" && typeof t.dateTime === "string" && GRAPH_TIME.test(t.dateTime) && t.timeZone === "UTC";
};

/**
 * Is this a getSchedule read: up to 20 addresses, a UTC range and an
 * interval, and nothing else? Graph answers with free/busy only for these.
 */
export function isSchedulePost(url: string, body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  if (url !== SCHEDULE_URL || !b || typeof b !== "object") return false;
  if (Object.keys(b).sort().join() !== "availabilityViewInterval,endTime,schedules,startTime") return false;
  const list = b.schedules;
  return (
    Array.isArray(list) && list.length >= 1 && list.length <= 20 && list.every((e) => typeof e === "string" && /^[^\s@]+@[^\s@]+$/.test(e)) &&
    isUtcTime(b.startTime) && isUtcTime(b.endTime) && Number.isInteger(b.availabilityViewInterval)
  );
}

const MOVE_PATCH = new RegExp(`^${GRAPH_RE}/me/events/[^/?#]+$`);

/**
 * Is this the move: a PATCH of one of your events with only a new start and
 * end, both in UTC, the end after the start? No title, place, guests, body
 * or anything else an event has. Graph tells the guests, as Outlook does.
 */
export function isMovePatch(url: string, body: unknown): boolean {
  const b = body as Record<string, unknown> | null;
  if (!MOVE_PATCH.test(url) || !b || typeof b !== "object" || Object.keys(b).sort().join() !== "end,start") return false;
  if (!isUtcTime(b.start) || !isUtcTime(b.end)) return false;
  return (b.end as { dateTime: string }).dateTime > (b.start as { dateTime: string }).dateTime;
}

/** A new event: only these fields, ever. */
export interface CreatePostBody {
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  body?: { contentType: "Text"; content: string };
  attendees?: Array<{ emailAddress: { address: string; name?: string } }>;
  /** Only on a block (no guests): shown as busy. */
  showAs?: "busy";
}

const CREATE_POST = new RegExp(`^${GRAPH_RE}/me/(events|calendars/[A-Za-z0-9_=+-]+/events)$`);
const isZoneTime = (v: unknown) => {
  const t = v as Record<string, unknown> | null;
  return !!t && typeof t === "object" && Object.keys(t).sort().join() === "dateTime,timeZone" && typeof t.dateTime === "string" && GRAPH_TIME.test(t.dateTime) && t.timeZone === "UTC";
};

/**
 * Is this one new event and nothing more? POST /me/events (the main
 * calendar) or /me/calendars/{id}/events, with a subject, a UTC start and
 * end, and optionally a place's name, a plain-text description and up to 50
 * guests by address. Outlook sends the invites. No online meeting, reminder,
 * importance, sensitivity, categories, recurrence or anything else.
 */
export function isCreatePost(url: string, body: unknown): body is CreatePostBody {
  if (!CREATE_POST.test(url) || !onlyKeys(body, ["subject", "start", "end", "location", "body", "attendees", "showAs"], ["subject", "start", "end"])) return false;
  if (body.showAs !== undefined && (body.showAs !== "busy" || body.attendees !== undefined)) return false;
  if (typeof body.subject !== "string" || !body.subject.trim() || body.subject.length > 300 || !isZoneTime(body.start) || !isZoneTime(body.end)) return false;
  if (body.location !== undefined && !(onlyKeys(body.location, ["displayName"], ["displayName"]) && typeof body.location.displayName === "string" && body.location.displayName.length <= 500)) return false;
  if (body.body !== undefined) {
    const b = body.body;
    if (!onlyKeys(b, ["contentType", "content"], ["contentType", "content"]) || b.contentType !== "Text" || typeof b.content !== "string" || b.content.length > 4000) return false;
  }
  if (body.attendees !== undefined && !(recipients(body.attendees) && (body.attendees as unknown[]).every((a) => /^[^\s@]+@[^\s@]+$/.test((a as { emailAddress: { address: string } }).emailAddress.address)))) return false;
  return (body.end as { dateTime: string }).dateTime > (body.start as { dateTime: string }).dateTime;
}

const CREATED_DELETE = new RegExp(`^${GRAPH_RE}/me/events/[^/?#]+$`);

/**
 * Is this the delete that undoes one create? One event, no body. Outlook
 * sends the guests a cancellation. The shape alone isn't enough: it's sent
 * only for an event in calendar_creates (microsoft-direct.ts).
 */
export function isCreatedDelete(url: string, body: unknown): boolean {
  return CREATED_DELETE.test(url) && body === undefined;
}

/**
 * Every write `write` sends: a reply, getSchedule, a draft or a new event as
 * POST, the move as PATCH. Never a DELETE: only deleteCreated sends one,
 * after checking calendar_creates.
 */
export function allowedWrite(method: string, url: string, body: unknown): boolean {
  if (method === "POST") return isRsvpPost(url, body) || isSchedulePost(url, body) || isDraftCreate(url, body) || isCreatePost(url, body);
  if (method === "PATCH") return isMovePatch(url, body);
  return false;
}

// ---------- What a tool sees ----------

export interface GraphContext {
  /** GET a Graph URL (built with graphUrl, or an @odata.nextLink Graph gave). */
  get<T = Record<string, unknown>>(url: string, opts?: { text?: boolean }): Promise<T>;
  /** Your reply to one invite (isRsvpPost): only for an account allowed to answer invites. */
  respond?(url: string, body: { sendResponse: true }): Promise<void>;
  /** Guests' free/busy (isSchedulePost): a read. */
  schedule?<T = Record<string, unknown>>(body: unknown): Promise<T>;
  /** A new start and end for one of your events (isMovePatch): only with "Let Athena add and update events" on. */
  move?(url: string, body: { start: { dateTime: string; timeZone: "UTC" }; end: { dateTime: string; timeZone: "UTC" } }): Promise<void>;
  /** Add one event (isCreatePost): only with "Let Athena add and update events" on. */
  create?<T = Record<string, unknown>>(url: string, body: CreatePostBody): Promise<T>;
  /** Undo of a create (isCreatedDelete): only for an event in calendar_creates, which the session checks first. */
  deleteCreated?(calendarId: string, eventId: string): Promise<void>;
  /** Save a draft (isDraftCreate): only for a mail account with drafts on. */
  saveDraft?<T = Record<string, unknown>>(url: string, body: DraftCreateBody): Promise<T>;
  /** The account's address (its profile's mail, or its sign-in name). */
  email: string;
  /** For times given without an offset. Graph doesn't say without another permission, so UTC unless a tool is told. */
  timeZone?: string;
  /** Calendar only: the calendars the owner switched on (calendar-choice.ts). Unset: the main one alone. */
  calendars?: () => Promise<ChosenCalendar[]>;
  /** Mail only: the owner's rules for which emails Athena reads (lib/mail-rules.ts), and the threads they kept out since the account opened. */
  mail?: MailGuard;
  now(): Date;
}

/** One of an Outlook account's tools: the same name, arguments and (compact) output as the Gmail or Google Calendar tool. */
export interface GraphTool {
  name: string;
  description: string;
  summary: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
  run(ctx: GraphContext, args: Record<string, unknown>): Promise<unknown>;
}

/** "Priya Shah <priya@example.com>", or whichever half Graph gave. */
export function person(r: { emailAddress?: { name?: string; address?: string } } | undefined | null): string {
  const name = r?.emailAddress?.name?.trim();
  const address = r?.emailAddress?.address?.trim();
  if (name && address && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`;
  return address || name || "";
}

/** Graph's "2026-11-07T09:00:00.0000000" in UTC (we ask for UTC) as ISO 8601 to the second, with Z. */
export function utcIso(dateTime: string | undefined): string | undefined {
  if (!dateTime) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(dateTime);
  if (!m) return undefined;
  return /Z|[+-]\d{2}:\d{2}$/.test(dateTime) ? new Date(Date.parse(dateTime)).toISOString().replace(/\.\d{3}Z$/, "Z") : `${m[1]}Z`;
}
