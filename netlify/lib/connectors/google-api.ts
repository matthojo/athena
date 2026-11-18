/**
 * The plumbing under google-direct.ts: Google's own OAuth endpoints, the
 * account's access token (renewed at oauth2.googleapis.com and saved back
 * sealed), and requests to Google's REST APIs with retries and plain-English
 * failures. Shared helpers for the Gmail and Calendar tools live here too.
 *
 * Only these requests leave this file: GETs, the one POST that saves a
 * Gmail draft (DRAFTS_URL), the freeBusy POST that reads guests' busy times
 * (isFreeBusyPost), the PATCH that sets your own reply to a calendar invite
 * (isRsvpPatch) and the PATCH that gives an event you organise a new start
 * and end (isMovePatch), the insert of one new event with only its title,
 * times, zone, place, description and guests (isCreateInsert), and the
 * DELETE that undoes it (isCreatedDelete), which only `deleteCreated` sends,
 * after calendar_creates says Athena added that event. `request` refuses
 * anything else, so no code path can send, label, delete or change anything
 * else about an event. Tokens, response bodies and
 * request URLs (which carry search words) are never logged.
 */
import { createHash, randomBytes } from "node:crypto";
import { GOOGLE_API_URL, type GoogleProvider } from "../../../lib/connector-presets";
import { updateConnectorSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import type { ChosenCalendar } from "./calendar-choice";
import type { MailGuard } from "./mail-guard";
import { ledger } from "../../../lib/calendar-creates";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** The one request that isn't a GET: create_draft saving a Gmail draft. */
export const DRAFTS_URL = `${GOOGLE_API_URL.gmail}/users/me/drafts`;

const REQUEST_TIMEOUT_MS = 30_000;
/** Waits before each retry of a 429, a 5xx or a dropped connection (so two retries). Tests shorten them. */
export const retryWaits = { ms: [600, 1800], maxRetryAfterMs: 5_000 };

export const API_NAME: Record<GoogleProvider, string> = { gmail: "Gmail API", "google-calendar": "Google Calendar API" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Errors ----------

/** Google's API refused a request. `message` is plain English for the owner; `detail` is what Google said. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly reasons: string[],
    readonly detail: string,
    readonly provider: GoogleProvider,
    readonly project?: string,
  ) {
    super(plainMessage(status, reasons, detail, provider, project));
    this.name = "GoogleApiError";
  }

  /** The API is switched off in the OAuth client's Google Cloud project. */
  get apiDisabled(): boolean {
    return this.status === 403 && isDisabled(this.reasons);
  }

  /** The token lacks a permission this needs (unticked on Google's consent screen, or never asked for). */
  get missingPermission(): boolean {
    return this.status === 403 && isMissingPermission(this.reasons);
  }

  /** Worth trying again shortly: rate limits (429, and the 403s Google uses for them) and server errors. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || (this.status === 403 && isRateLimit(this.reasons));
  }
}

const isDisabled = (reasons: string[]) => reasons.some((r) => r === "SERVICE_DISABLED" || r === "accessNotConfigured");
const isMissingPermission = (reasons: string[]) => reasons.some((r) => r === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || r === "insufficientPermissions");
const isRateLimit = (reasons: string[]) => reasons.some((r) => /^(rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED|quotaExceeded)$/.test(r));

function plainMessage(status: number, reasons: string[], detail: string, provider: GoogleProvider, project?: string): string {
  if (status === 401) return "Google didn't accept the sign-in. Sign in again";
  if (status === 403 && isDisabled(reasons)) return `Turn on the ${API_NAME[provider]} in your Google Cloud project${project ? ` ${project}` : ""}, then try again.`;
  if (status === 403 && isMissingPermission(reasons)) return "Sign in again and allow every permission Athena asks for.";
  if (status === 429 || (status === 403 && isRateLimit(reasons))) return "Google is limiting how often Athena can ask right now. Try again in a few minutes.";
  if (status >= 500) return "Google is having trouble right now. Try again in a few minutes.";
  if (status === 404 || status === 410) return `Not found: ${detail}`;
  return `Google refused that (${status}): ${detail}`;
}

interface GoogleErrorBody {
  message?: unknown;
  errors?: Array<{ reason?: unknown }>;
  details?: Array<{ reason?: unknown; metadata?: { consumer?: unknown; containerInfo?: unknown } }>;
}

/** Google's JSON error (`{ error: { code, message, errors[], details[] } }`) as a GoogleApiError. */
export function parseApiError(status: number, body: unknown, provider: GoogleProvider): GoogleApiError {
  const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const e: GoogleErrorBody = raw && typeof raw === "object" ? (raw as GoogleErrorBody) : {};
  const detail = typeof e.message === "string" && e.message.trim() ? e.message.trim().slice(0, 300) : `HTTP ${status}`;
  const errors = Array.isArray(e.errors) ? e.errors : [];
  const details = Array.isArray(e.details) ? e.details : [];
  const reasons = [...errors.map((x) => x?.reason), ...details.map((d) => d?.reason)].filter((r): r is string => typeof r === "string");
  // "projects/123456789012" in the error's details, or "…in project 123456789012…" in its message.
  const consumer = details.map((d) => d?.metadata?.consumer ?? d?.metadata?.containerInfo).find((c): c is string => typeof c === "string");
  const project = consumer?.replace(/^projects\//, "") || /\bin project ([\w-]+)/.exec(detail)?.[1];
  return new GoogleApiError(status, reasons, detail, provider, project);
}

/**
 * Google's token endpoint refused (invalid_grant: the sign-in was revoked or
 * expired; invalid_client: wrong client ID or secret), there's nothing to
 * renew the sign-in with, or Google couldn't be reached to renew it.
 */
export class GoogleTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }

  /** The owner has to act (sign in again, or fix the client); otherwise it was a passing failure. */
  get needsOwner(): boolean {
    return ["invalid_grant", "no_refresh_token", "invalid_client", "unauthorized_client", "not_signed_in"].includes(this.code);
  }

  get clientRefused(): boolean {
    return this.code === "invalid_client" || this.code === "unauthorized_client";
  }
}

/** A tool's arguments were wrong: told to the model as a tool error, never the account's problem. */
export class ToolInputError extends Error {}

// ---------- Tokens ----------

export interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** When Athena got it (ms), so expiry can be judged without asking Google. */
  obtained_at?: number;
  scope?: string;
  token_type?: string;
}

/** Expired, or about to be (a minute's grace). Unknown lifetimes count as fresh: a 401 says otherwise. */
function expired(t: StoredTokens): boolean {
  const at = typeof t.obtained_at === "number" ? t.obtained_at : 0;
  const life = typeof t.expires_in === "number" ? t.expires_in : 0;
  return !!at && !!life && Date.now() > at + (life - 60) * 1000;
}

/** POST to Google's token endpoint (form-encoded). Retries 429 and 5xx; refusals become GoogleTokenError. */
async function tokenRequest(params: Record<string, string>): Promise<StoredTokens> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < retryWaits.ms.length) {
        await sleep(retryWaits.ms[attempt]);
        continue;
      }
      throw new GoogleTokenError("unreachable", "Couldn't reach Google to renew the sign-in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      return {
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        token_type: typeof body.token_type === "string" ? body.token_type : undefined,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retryWaits.ms.length) {
      await sleep(retryWaits.ms[attempt]);
      continue;
    }
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    const description = typeof body?.error_description === "string" ? body.error_description.slice(0, 200) : "";
    throw new GoogleTokenError(code, description ? `${description} (${code})` : code);
  }
}

// ---------- Sign-in (authorisation code with PKCE, at Google's own endpoints) ----------

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * Google's consent page. Offline access with prompt=consent, so Google issues
 * a refresh token every time. No `resource` parameter: that's an MCP thing,
 * and these tokens are for Google's APIs.
 */
export function authorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

/** The callback's code, swapped for tokens. */
export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
  verifier: string;
  client: { client_id: string; client_secret?: string };
}): Promise<StoredTokens> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.client_id,
    ...(input.client.client_secret ? { client_secret: input.client.client_secret } : {}),
    code_verifier: input.verifier,
  });
  return { ...tokens, obtained_at: Date.now() };
}

// ---------- Requests ----------

export type GoogleRequest =
  | { method: "GET"; url: string }
  | { method: "POST"; url: typeof DRAFTS_URL | typeof FREEBUSY_URL; body: unknown }
  | { method: "PATCH"; url: string; body: RsvpPatch | MovePatch }
  | { method: "POST"; url: string; body: CreateInsert }
  | { method: "DELETE"; url: string };

/** Guests' busy times: a POST, but a read. */
export const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Is this a freeBusy read: a range and up to 20 addresses, nothing else? Google answers with busy times only. */
export function isFreeBusyPost(req: { method: string; url: string; body?: unknown }): boolean {
  if (req.method !== "POST" || req.url !== FREEBUSY_URL) return false;
  const b = req.body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Object.keys(b).sort().join() !== "items,timeMax,timeMin") return false;
  if (typeof b.timeMin !== "string" || typeof b.timeMax !== "string" || !RFC3339.test(b.timeMin) || !RFC3339.test(b.timeMax)) return false;
  const items = b.items;
  return (
    Array.isArray(items) && items.length >= 1 && items.length <= 20 &&
    items.every((i) => !!i && typeof i === "object" && Object.keys(i).join() === "id" && typeof (i as { id: unknown }).id === "string" && EMAIL.test((i as { id: string }).id))
  );
}

/** The move: a new start and end, nothing else. */
export interface MovePatch {
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
}

const isWhen = (v: unknown) => {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return false;
  const keys = Object.keys(t).sort().join();
  if (keys !== "dateTime" && keys !== "dateTime,timeZone") return false;
  return typeof t.dateTime === "string" && RFC3339.test(t.dateTime) && (t.timeZone === undefined || (typeof t.timeZone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(t.timeZone)));
};

/**
 * Is this the move of one event and nothing more? A PATCH with only start
 * and end (each a dateTime with its offset, and maybe the event's own time
 * zone), the end after the start, and sendUpdates=all so guests are told.
 */
export function isMovePatch(req: { method: string; url: string; body?: unknown }): boolean {
  if (req.method !== "PATCH" || !RSVP_URL.test(req.url)) return false;
  const b = req.body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Object.keys(b).sort().join() !== "end,start" || !isWhen(b.start) || !isWhen(b.end)) return false;
  return Date.parse((b.end as { dateTime: string }).dateTime) > Date.parse((b.start as { dateTime: string }).dateTime);
}

/** A new event: only these fields, ever. */
export interface CreateInsert {
  summary: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; displayName?: string }>;
  /** Only on a block, with "Block time as Focus time" on: Google's Focus time, which may decline meetings booked over it. */
  eventType?: "focusTime";
  focusTimeProperties?: FocusTimeProperties;
}

/** The one Focus time Athena sets: decline only new invites that clash, and Do not disturb in Chat. */
export const FOCUS_TIME_PROPERTIES = { autoDeclineMode: "declineOnlyNewConflictingInvitations", chatStatus: "doNotDisturb" } as const;
export type FocusTimeProperties = typeof FOCUS_TIME_PROPERTIES;

const INSERT_URL = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/?#]+\/events\?sendUpdates=all$/;
const CREATE_KEYS = ["attendees", "description", "end", "location", "start", "summary", "eventType", "focusTimeProperties"];

/**
 * Is this the insert of one new event and nothing more? events.insert with
 * sendUpdates=all (so guests get Google's invite), and a body of a title,
 * start and end (each a dateTime with its offset, maybe a time zone), and
 * optionally a place, a description and up to 50 guests as { email,
 * displayName? }. No conferencing, reminders, colour, visibility, recurrence,
 * attachments or anything else Google takes.
 */
export function isCreateInsert(req: { method: string; url: string; body?: unknown }): boolean {
  if (req.method !== "POST" || !INSERT_URL.test(req.url)) return false;
  const b = req.body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b) || !Object.keys(b).every((k) => CREATE_KEYS.includes(k))) return false;
  if (typeof b.summary !== "string" || !b.summary.trim() || b.summary.length > 300 || !isWhen(b.start) || !isWhen(b.end)) return false;
  if (b.location !== undefined && (typeof b.location !== "string" || b.location.length > 500)) return false;
  // Focus time: both fields or neither, exactly these values, and only on a block (no guests).
  if (b.eventType !== undefined || b.focusTimeProperties !== undefined) {
    const p = b.focusTimeProperties as Record<string, unknown> | null;
    if (b.eventType !== "focusTime" || !p || typeof p !== "object" || Object.keys(p).sort().join() !== "autoDeclineMode,chatStatus") return false;
    if (p.autoDeclineMode !== FOCUS_TIME_PROPERTIES.autoDeclineMode || p.chatStatus !== FOCUS_TIME_PROPERTIES.chatStatus || b.attendees !== undefined) return false;
  }
  if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > 4000)) return false;
  if (b.attendees !== undefined) {
    const list = b.attendees;
    if (!Array.isArray(list) || list.length > 50) return false;
    const ok = list.every((a) => {
      const o = a as Record<string, unknown> | null;
      return (
        !!o && typeof o === "object" && Object.keys(o).every((k) => k === "email" || k === "displayName") &&
        typeof o.email === "string" && EMAIL.test(o.email) && (o.displayName === undefined || (typeof o.displayName === "string" && o.displayName.length <= 200))
      );
    });
    if (!ok) return false;
  }
  return Date.parse((b.end as { dateTime: string }).dateTime) > Date.parse((b.start as { dateTime: string }).dateTime);
}

/**
 * Is this the delete that undoes one create? One event, with sendUpdates=all
 * so guests get a cancellation. The shape alone isn't enough: the tool sends
 * it only for an event in calendar_creates (lib/calendar-creates.ts).
 */
export function isCreatedDelete(req: { method: string; url: string; body?: unknown }): boolean {
  return req.method === "DELETE" && RSVP_URL.test(req.url) && req.body === undefined;
}

/** The body of the one calendar write: only your own reply, with every other attendee left out (attendeesOmitted). */
export interface RsvpPatch {
  attendeesOmitted: true;
  attendees: [{ email: string; responseStatus: "accepted" | "tentative" | "declined" | "needsAction" }];
}

const RSVP_URL = /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/[^/?#]+\/events\/[^/?#]+\?sendUpdates=all$/;

/**
 * Is this the attendee patch for your own reply, and nothing more? One
 * attendee, an email and a reply status: no title, time, place, guests or
 * anything else an event has.
 */
export function isRsvpPatch(req: { method: string; url: string; body?: unknown }): boolean {
  if (req.method !== "PATCH" || !RSVP_URL.test(req.url)) return false;
  const b = req.body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Object.keys(b).sort().join() !== "attendees,attendeesOmitted" || b.attendeesOmitted !== true) return false;
  const list = b.attendees;
  if (!Array.isArray(list) || list.length !== 1) return false;
  const a = list[0] as Record<string, unknown>;
  return (
    !!a && typeof a === "object" && Object.keys(a).sort().join() === "email,responseStatus" &&
    typeof a.email === "string" && /^[^\s@]+@[^\s@]+$/.test(a.email) &&
    ["accepted", "tentative", "declined", "needsAction"].includes(a.responseStatus as string)
  );
}

/** "…/threads" + { q, maxResults, metadataHeaders: [a, b] } → a URL; empty values are left out, arrays repeat the key. */
export function apiUrl(base: string, path: string, params: Record<string, string | number | boolean | string[] | undefined> = {}): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(one));
  }
  return url.toString();
}

function retryAfterMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, retryWaits.maxRetryAfterMs);
  return retryWaits.ms[attempt];
}

/** One Google account, signed in: its token, renewed when needed, and requests made with it. */
export class GoogleSession {
  private renewing: Promise<string> | null = null;

  constructor(
    readonly connector: Pick<Connector, "id" | "provider">,
    private readonly secrets: ConnectorSecrets,
  ) {}

  get provider(): GoogleProvider {
    return this.connector.provider as GoogleProvider;
  }

  private get tokens(): StoredTokens | undefined {
    return this.secrets.tokens as StoredTokens | undefined;
  }

  async accessToken(): Promise<string> {
    const t = this.tokens;
    if (t?.access_token && !expired(t)) return t.access_token;
    return this.renew();
  }

  /** Renew the access token with the refresh token: once, however many requests are waiting for it. */
  renew(): Promise<string> {
    this.renewing ??= this.doRenew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async doRenew(): Promise<string> {
    const refreshToken = this.tokens?.refresh_token;
    if (!refreshToken) throw new GoogleTokenError("no_refresh_token", "Google gave Athena no way to renew this sign-in");
    const client = this.secrets.ownClient;
    if (!client?.client_id) throw new GoogleTokenError("invalid_client", "No Google OAuth client is saved for this account");
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    });
    // Google rarely sends a new refresh token on renewal: keep the one we have.
    const tokens: StoredTokens = { ...fresh, refresh_token: fresh.refresh_token ?? refreshToken, obtained_at: Date.now() };
    this.secrets.tokens = { ...tokens };
    // Saved sealed, unless the owner signed in again meanwhile (a different refresh token is stored, or none while it's under way).
    await updateConnectorSecrets(this.connector.id, (s) => {
      if ((s.tokens as StoredTokens | undefined)?.refresh_token !== refreshToken) return;
      s.tokens = { ...tokens };
    });
    return tokens.access_token!;
  }

  /**
   * A request to Google's API. GETs, plus the one POST that saves a draft; a
   * 401 renews the token once and tries again; 429, 5xx and dropped
   * connections are retried with backoff (a draft only on 429, so it can't
   * be saved twice). Resolves to the JSON body; throws GoogleApiError.
   */
  async request(req: GoogleRequest): Promise<unknown> {
    const draft = req.method === "POST" && req.url === DRAFTS_URL;
    const freeBusy = isFreeBusyPost(req);
    // A DELETE never passes here: only deleteCreated sends one, after checking calendar_creates.
    if (req.method !== "GET" && !draft && !freeBusy && !isRsvpPatch(req) && !isMovePatch(req) && !isCreateInsert(req)) throw new Error("Athena only reads from Google");
    return this.send(req);
  }

  /**
   * Undo of create_event: DELETE one event with sendUpdates=all, only when
   * calendar_creates says Athena added it and hasn't taken it back. This is
   * the only way a DELETE leaves Athena for Google.
   */
  async deleteCreated(calendarId: string, eventId: string): Promise<void> {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`;
    if (!isCreatedDelete({ method: "DELETE", url }) || !(await ledger.has(this.connector.id, calendarId, eventId))) throw new Error("Athena only removes events it added itself");
    await this.send({ method: "DELETE", url });
  }

  private async send(req: GoogleRequest): Promise<unknown> {
    const freeBusy = isFreeBusyPost(req);
    // Writes are never retried after a dropped connection, and only on 429 otherwise, so nothing is done twice. freeBusy is a read.
    const post = req.method !== "GET" && !freeBusy;
    const hasBody = req.method !== "GET" && req.method !== "DELETE";
    let renewed = false;
    for (let attempt = 0; ; ) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(req.url, {
          method: req.method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(hasBody ? { "Content-Type": "application/json" } : {}) },
          body: hasBody ? JSON.stringify((req as { body: unknown }).body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (!post && attempt < retryWaits.ms.length) {
          await sleep(retryWaits.ms[attempt++]);
          continue;
        }
        throw new GoogleApiError(503, ["unreachable"], "Couldn't reach Google", this.provider);
      }
      if (res.ok) return res.status === 204 ? {} : await res.json().catch(() => ({}));
      const error = parseApiError(res.status, await res.json().catch(() => null), this.provider);
      if (res.status === 401 && !renewed && this.tokens?.refresh_token) {
        renewed = true;
        await this.renew();
        continue;
      }
      if (error.retryable && (!post || res.status === 429) && attempt < retryWaits.ms.length) {
        await sleep(retryAfterMs(res, attempt++));
        continue;
      }
      throw error;
    }
  }
}

// ---------- What a tool sees ----------

export interface GoogleContext {
  /** GET a Google API URL (built with apiUrl). */
  get<T = Record<string, unknown>>(url: string): Promise<T>;
  /** POST users/me/drafts: the only Gmail write there is. */
  saveDraft<T = Record<string, unknown>>(body: unknown): Promise<T>;
  /** PATCH your own reply to one invite (isRsvpPatch). */
  patchRsvp?<T = Record<string, unknown>>(url: string, body: RsvpPatch): Promise<T>;
  /** Guests' busy times (isFreeBusyPost): a read. */
  freeBusy?<T = Record<string, unknown>>(body: unknown): Promise<T>;
  /** A new start and end for an event you organise (isMovePatch): only with "Let Athena add and update events" on. */
  patchMove?<T = Record<string, unknown>>(url: string, body: MovePatch): Promise<T>;
  /** Add one event (isCreateInsert): only with "Let Athena add and update events" on. */
  insertEvent?<T = Record<string, unknown>>(url: string, body: CreateInsert): Promise<T>;
  /** Undo of an insert (isCreatedDelete): only for an event in calendar_creates, which the session checks first. */
  deleteCreated?(calendarId: string, eventId: string): Promise<void>;
  /** The account's address (Gmail's profile, or the primary calendar's id). */
  email: string;
  /** Calendar only: the owner's calendar time zone, for times given without an offset. */
  timeZone?: string;
  /** Calendar only: the calendars the owner switched on (calendar-choice.ts). Unset: the primary alone. */
  calendars?: () => Promise<ChosenCalendar[]>;
  /** Mail only: the owner's rules for which emails Athena reads (lib/mail-rules.ts), and the threads they kept out since the account opened. */
  mail?: MailGuard;
  now(): Date;
}

/** One of an account's tools: the same name, arguments and (compact) output as Google's MCP server's. */
export interface DirectTool {
  name: string;
  /** For Claude: what it does and how to call it. */
  description: string;
  /** For the owner, on the account's page: a few plain words. */
  summary: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
  run(ctx: GoogleContext, args: Record<string, unknown>): Promise<unknown>;
}

// ---------- Small shared helpers for the tools ----------

/** A tool's arguments, checked. Claude sends them, so nothing is trusted. */
export const arg = {
  str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    const v = args[key];
    if (v === undefined || v === null || v === "") {
      if (opts.required) throw new ToolInputError(`${key} is required`);
      return undefined;
    }
    if (typeof v !== "string") throw new ToolInputError(`${key} must be a string`);
    if (opts.max && v.length > opts.max) throw new ToolInputError(`${key} is too long`);
    return v;
  },
  int(args: Record<string, unknown>, key: string, opts: { min: number; max: number; fallback: number }): number {
    const v = args[key];
    if (v === undefined || v === null || v === "") return opts.fallback;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolInputError(`${key} must be a number`);
    return Math.min(opts.max, Math.max(opts.min, Math.floor(n)));
  },
  bool(args: Record<string, unknown>, key: string): boolean {
    return args[key] === true || args[key] === "true";
  },
  strings(args: Record<string, unknown>, key: string, max = 100): string[] {
    const v = args[key];
    if (v === undefined || v === null) return [];
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new ToolInputError(`${key} must be a list of strings`);
    if (list.length > max) throw new ToolInputError(`${key} has too many entries`);
    return (list as string[]).map((s) => s.trim()).filter(Boolean);
  },
  oneOf<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
    const v = arg.str(args, key);
    if (v === undefined) return undefined;
    if (!values.includes(v as T)) throw new ToolInputError(`${key} must be one of ${values.join(", ")}`);
    return v as T;
  },
};

/** Drop empty fields (undefined, null, "", []) so the JSON Claude reads stays short. */
export function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Run `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "", zwj: "", shy: "", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", pound: "£", euro: "€", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Tidy plain text: Unix line ends, no invisible padding, no trailing spaces, at most one blank line in a row. */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍⁠﻿͏­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The most HTML htmlToText reads. Its callers keep 3,000 to 20,000 characters of the result. */
export const MAX_HTML_TO_TEXT = 500_000;

/** Remove every `open … close` span in one forward pass. An opener with no closer is left as it is. */
function dropSpans(s: string, open: string, close: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = s.indexOf(open, at);
    const end = start < 0 ? -1 : s.indexOf(close, start + open.length);
    if (end < 0) return out + s.slice(at);
    out += s.slice(at, start);
    at = end + close.length;
  }
}

/**
 * Rewrite each `<name …>…</name>` element in one forward pass: `swap` gets
 * the opening tag and what's inside, and returns the replacement. Opening
 * tags that fail `only` are left alone without looking for their closer, and
 * once a name has no closer ahead it isn't looked for again, so unclosed
 * tags cost one scan, not one each.
 */
function swapElements(s: string, names: string, swap: (tag: string, inner: string) => string, only?: RegExp): string {
  // [^<>]* stops at the next "<": a run of "<a <a <a" is read once.
  const opener = new RegExp(`<(${names})\\b[^<>]*>`, "gi");
  const unclosed = new Set<string>();
  let out = "";
  let at = 0;
  for (let m = opener.exec(s); m; m = opener.exec(s)) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name) || (only && !only.test(m[0]))) continue;
    const closer = new RegExp(`</${name}\\s*>`, "gi");
    closer.lastIndex = opener.lastIndex;
    const c = closer.exec(s);
    if (!c) {
      unclosed.add(name);
      continue;
    }
    out += s.slice(at, m.index) + swap(m[0], s.slice(opener.lastIndex, c.index));
    at = opener.lastIndex = closer.lastIndex;
  }
  return out + s.slice(at);
}

/**
 * HTML (an email body, a calendar description) as readable text: blocks and
 * line breaks kept, scripts, styles and comments dropped, links written out
 * when they're short enough to be useful (tracking and booking links matter
 * for orders and trips).
 *
 * The input is third-party text, so it is capped first and every step is a
 * single forward pass: no pattern here can be made to rescan (security
 * review M19).
 */
export function htmlToText(html: string): string {
  const capped = html.length > MAX_HTML_TO_TEXT ? html.slice(0, MAX_HTML_TO_TEXT) : html;
  const noBlocks = swapElements(dropSpans(capped, "<!--", "-->"), "script|style|head|title|noscript", () => "");
  const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  const s = swapElements(noBlocks, "a", (tag, inner) => {
    const h = HREF.exec(tag)!;
    const href = decodeEntities(h[1] ?? h[2] ?? h[3] ?? "").trim();
    const text = tidyText(decodeEntities(inner.replace(/<[^<>]+>/g, " ")));
    if (!/^https?:\/\//i.test(href) || href.length > 300 || !text || text === href) return text || "";
    return `${text} (${href})`;
  }, HREF)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|section|article|header|footer|hr)\b[^<>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^<>]+>/g, "");
  return tidyText(decodeEntities(s));
}
