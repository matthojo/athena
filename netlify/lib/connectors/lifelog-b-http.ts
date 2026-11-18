/**
 * What the Reddit, Spotify, Last.fm and Steam adapters share (reddit-direct.ts,
 * spotify-direct.ts, lastfm-direct.ts, steam-direct.ts): GETs with retries and
 * plain-English failures, OAuth tokens renewed and saved back sealed, the
 * `after`/`before` window every tool takes, local dates in the owner's time
 * zone, and paging cursors.
 *
 * Only GETs to the API hosts leave this file (token renewal is a POST to the
 * service's own token endpoint). Keys, tokens, request URLs (Last.fm and Steam
 * put the key in the query) and response bodies are never logged.
 */
import { updateConnectorSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { DEFAULT_TZ, isValidTimeZone, zonedParts, zonedToInstant } from "../../../lib/dates";
import { ToolInputError, clean, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectToolInfo } from "./direct";
import { publicFetch } from "./icons";

export type LifeService = "reddit" | "spotify" | "lastfm" | "steam" | "strava" | "oura" | "withings" | "whoop" | "polar" | "readwise" | "bluesky" | "mastodon"
  // Media, chess and travel (plex-direct.ts, jellyfin-direct.ts, lichess-direct.ts, chesscom-direct.ts, tripit-direct.ts).
  | "plex" | "jellyfin" | "lichess" | "chesscom" | "tripit" | "swarm"
  // Habits, money and home (habitify-direct.ts, monzo-direct.ts, starling-direct.ts, octopus-direct.ts).
  | "habitify" | "monzo" | "starling" | "octopus" | "todoist"
  // More of the Life log (listenbrainz-direct.ts, raindrop-direct.ts, eventbrite-direct.ts).
  | "listenbrainz" | "raindrop" | "eventbrite"
  // Home appliances (homeconnect-direct.ts).
  | "homeconnect"
  // Fastmail email over JMAP (fastmail-direct.ts).
  | "fastmail";

const REQUEST_TIMEOUT_MS = 30_000;
/** Waits before each retry of a 429, a 5xx or a dropped connection. Tests shorten them. */
export const lifeRetryWaits = { ms: [600, 1800], maxRetryAfterMs: 5_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A service refused, or couldn't be reached. `message` is for the owner.
 * `owner` means the owner has a step to take (sign in again, fix the key or
 * the address, make the profile public): the account shows needs_auth.
 */
export class LifeApiError extends Error {
  constructor(
    readonly service: LifeService,
    readonly status: number,
    message: string,
    readonly owner = false,
  ) {
    super(message);
    this.name = "LifeApiError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** What a failure means for the account, for one service's adapter. */
export function lifeFailure(service: LifeService, error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  if (!(error instanceof LifeApiError) || error.service !== service) return null;
  return {
    status: error.owner ? "needs_auth" : "error",
    detail: error.message,
  };
}

export const lifeAccountProblem = (service: LifeService, error: unknown): boolean => error instanceof LifeApiError && error.service === service && error.owner;

function retryAfterMs(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, lifeRetryWaits.maxRetryAfterMs);
  return lifeRetryWaits.ms[attempt];
}

export interface GetOptions {
  service: LifeService;
  /** Only URLs on these hosts are fetched. */
  hosts: string[];
  headers?: Record<string, string>;
  /** The service's refusal as an error, from the status and JSON body. */
  refused(status: number, body: unknown): LifeApiError;
  /** A refusal inside a 200 (Last.fm does this for some errors), or null. */
  bodyError?(body: unknown): LifeApiError | null;
  /** Plain English for "couldn't reach it". */
  unreachable: string;
  /** "manual" for the owner's own servers (Jellyfin, Plex): a redirect is refused, not followed. "error" for a host the owner typed (Mastodon), so a token never follows a redirect elsewhere. */
  redirect?: RequestRedirect;
  /** An address the owner typed (Jellyfin, Mastodon): every connection is checked against internal addresses as it is made. */
  typed?: boolean;
}

/** GET JSON. 429, 5xx and dropped connections are retried, honouring Retry-After. */
export async function getJson<T>(url: string, opts: GetOptions): Promise<T> {
  const host = new URL(url).hostname;
  if (!opts.hosts.includes(host)) throw new Error(`Athena only reads from ${opts.hosts.join(", ")}`);
  for (let attempt = 0; ; ) {
    let res: Response;
    try {
      res = await (opts.typed ? publicFetch : fetch)(url, {
        method: "GET",
        headers: { Accept: "application/json", ...opts.headers },
        redirect: opts.redirect ?? "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt++]);
        continue;
      }
      throw new LifeApiError(opts.service, 503, opts.unreachable);
    }
    const body: unknown = res.status === 204 ? {} : await res.json().catch(() => null);
    const error = res.ok ? (opts.bodyError?.(body) ?? null) : opts.refused(res.status, body);
    if (!error) return body as T;
    if (error.retryable && attempt < lifeRetryWaits.ms.length) {
      await sleep(retryAfterMs(res, attempt++));
      continue;
    }
    throw error;
  }
}

// ---------- OAuth (Reddit, Spotify) ----------

/** Where renewed tokens are saved. Tests swap it for a stub. */
export const lifeTokenStore = {
  save: (id: string, mutate: (s: ConnectorSecrets) => void): Promise<void> => updateConnectorSecrets(id, mutate),
};

export interface TokenEndpoint {
  service: LifeService;
  url: string;
  /** Extra headers (Reddit wants a User-Agent everywhere). */
  headers?: Record<string, string>;
  /** Whose sign-in it is, in messages: "Reddit", "Spotify". */
  label: string;
  /** For token endpoints that don't take the client in Basic auth (Strava, Withings): the renewal request itself. */
  request?(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens>;
}

/** POST to a token endpoint with the client in HTTP Basic auth (both Reddit and Spotify accept it). */
export async function tokenRequest(endpoint: TokenEndpoint, client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  const basic = Buffer.from(`${client.client_id}:${client.client_secret ?? ""}`).toString("base64");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
          ...endpoint.headers,
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError(endpoint.service, 503, `Couldn't reach ${endpoint.label} to renew the sign-in`);
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
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    if (res.status >= 500) throw new LifeApiError(endpoint.service, res.status, `${endpoint.label} is having trouble right now. Try again in a few minutes.`);
    if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
      throw new LifeApiError(endpoint.service, 401, `${endpoint.label} refused Athena's app. Check the client ID and secret under Edit, then sign in again.`, true);
    }
    throw new LifeApiError(endpoint.service, 400, "Sign in again", true);
  }
}

function expired(t: StoredTokens): boolean {
  const at = typeof t.obtained_at === "number" ? t.obtained_at : 0;
  const life = typeof t.expires_in === "number" ? t.expires_in : 0;
  return !!at && !!life && Date.now() > at + (life - 60) * 1000;
}

/** One signed-in account: its access token, renewed once however many requests wait for it, and saved back sealed. */
export class OAuthSession {
  private renewing: Promise<string> | null = null;

  constructor(
    private readonly endpoint: TokenEndpoint,
    private readonly connector: Pick<Connector, "id">,
    private readonly secrets: ConnectorSecrets,
  ) {}

  private get tokens(): StoredTokens | undefined {
    return this.secrets.tokens as StoredTokens | undefined;
  }

  get canRenew(): boolean {
    return !!this.tokens?.refresh_token;
  }

  async accessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new LifeApiError(this.endpoint.service, 401, "Not signed in yet", true);
    if (t.access_token && !expired(t)) return t.access_token;
    return this.renew();
  }

  renew(): Promise<string> {
    this.renewing ??= this.doRenew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async doRenew(): Promise<string> {
    const refreshToken = this.tokens?.refresh_token;
    if (!refreshToken) throw new LifeApiError(this.endpoint.service, 401, "Sign in again", true);
    const client = this.secrets.ownClient;
    if (!client?.client_id) throw new LifeApiError(this.endpoint.service, 401, `No ${this.endpoint.label} app is saved for this account. Add it under Edit.`, true);
    const fresh = await (this.endpoint.request ?? ((c, p) => tokenRequest(this.endpoint, c, p)))(client, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const tokens: StoredTokens = {
      ...fresh,
      refresh_token: fresh.refresh_token ?? refreshToken,
      obtained_at: Date.now(),
    };
    this.secrets.tokens = { ...tokens };
    // Never over a newer sign-in: only replace the tokens this renewal started from.
    await lifeTokenStore.save(this.connector.id, (s) => {
      if ((s.tokens as StoredTokens | undefined)?.refresh_token !== refreshToken) return;
      s.tokens = { ...tokens };
    });
    return tokens.access_token!;
  }

  /** GET with the bearer token; a 401 renews once and tries again. */
  async get<T>(url: string, opts: GetOptions): Promise<T> {
    try {
      return await getJson<T>(url, {
        ...opts,
        headers: {
          ...opts.headers,
          Authorization: `Bearer ${await this.accessToken()}`,
        },
      });
    } catch (error) {
      if (!(error instanceof LifeApiError) || error.status !== 401 || !this.canRenew) throw error;
      const token = await this.renew();
      return getJson<T>(url, {
        ...opts,
        headers: { ...opts.headers, Authorization: `Bearer ${token}` },
      });
    }
  }
}

// ---------- Windows, dates and cursors ----------

/** The owner's time zone (settings.timezone), for local dates. Falls back to the default when the database can't say. */
export async function ownerZone(): Promise<string> {
  try {
    const { getOwnerTimeZone } = await import("../../../lib/db");
    const tz = await getOwnerTimeZone();
    return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-06" (the start of that day in `tz`) or an ISO 8601 time, as epoch ms. */
function instant(value: string, key: string, tz: string): number {
  if (DAY.test(value)) return zonedToInstant(value, "00:00", tz).getTime();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new ToolInputError(`${key} must be a date (YYYY-MM-DD) or an ISO 8601 time`);
  return ms;
}

export interface Window {
  /** Epoch ms, inclusive. */
  after?: number;
  /** Epoch ms, exclusive. */
  before?: number;
}

/**
 * The `after`/`before` window a tool was given, or `date` for one whole local
 * day. A bare date in `before` means the start of that day, so
 * after=2026-11-06&before=2026-11-07 is exactly 6 November.
 */
export function windowOf(args: Record<string, unknown>, tz: string): Window {
  const text = (k: string): string | undefined => {
    const v = args[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new ToolInputError(`${k} must be a string`);
    return v.trim();
  };
  const date = text("date");
  if (date) {
    if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
    const start = instant(date, "date", tz);
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    return { after: start, before: instant(next, "date", tz) };
  }
  const after = text("after");
  const before = text("before");
  const w: Window = {
    after: after ? instant(after, "after", tz) : undefined,
    before: before ? instant(before, "before", tz) : undefined,
  };
  if (w.after !== undefined && w.before !== undefined && w.after >= w.before) throw new ToolInputError("after must be earlier than before");
  return w;
}

export const inWindow = (ms: number, w: Window): boolean => (w.after === undefined || ms >= w.after) && (w.before === undefined || ms < w.before);

/** The window's schema properties, shared by every dated tool. */
export const WINDOW_PROPS = {
  date: {
    type: "string",
    description: "One whole day in the owner's time zone, YYYY-MM-DD. Overrides after and before.",
  },
  after: {
    type: "string",
    description: "From this date (YYYY-MM-DD, start of day in the owner's time zone) or ISO 8601 time, inclusive.",
  },
  before: {
    type: "string",
    description: "Up to this date (YYYY-MM-DD, start of day) or ISO 8601 time, exclusive.",
  },
};

/** An instant as the owner's local date and time, plus UTC. */
export function when(ms: number, tz: string): { date: string; time: string; at: string } {
  const p = zonedParts(new Date(ms), tz);
  return {
    date: p.date,
    time: p.time,
    at: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** Opaque paging tokens: base64url JSON, tagged so one tool's cursor can't be fed to another. */
export function encodeCursor(tag: string, value: unknown): string {
  return Buffer.from(JSON.stringify({ t: tag, v: value })).toString("base64url");
}

export function decodeCursor<T>(tag: string, raw: unknown): T | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 500) throw new ToolInputError("cursor isn't one this tool gave");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; v?: unknown };
    if (parsed.t === tag) return parsed.v as T;
  } catch {
    // fall through
  }
  throw new ToolInputError("cursor isn't one this tool gave");
}

export const CURSOR_PROP = {
  cursor: {
    type: "string",
    description: "next_cursor from the previous call, for the next page.",
  },
};

// ---------- Tools ----------

/** One tool: what Claude and the owner see, and how it runs. */
export interface LifeTool<C> extends DirectToolInfo {
  run(ctx: C, args: Record<string, unknown>): Promise<unknown>;
}

export const readOnly = { readOnlyHint: true } as const;

/** A tool's result: `items` always present (an empty day says so), the rest without empty fields. */
export const withItems = (items: unknown[], rest: Record<string, unknown>): Record<string, unknown> => ({ items, ...clean(rest) });

/** An open account over a set of tools: input mistakes and one-off refusals go back to the model; account problems are thrown. */
export function account<C>(service: LifeService, tools: LifeTool<C>[], ctx: C): DirectAccount {
  return {
    tools,
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool)
        return {
          text: `${name} isn't one of this account's tools`,
          isError: true,
        };
      try {
        return {
          text: JSON.stringify(await tool.run(ctx, args ?? {})),
          isError: false,
        };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        if (error instanceof LifeApiError && error.service === service && !error.owner && !error.retryable) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

/** The account's profile address, checked: https, on one of the service's own hosts. Throws an owner-facing error otherwise. */
export function profileUrl(service: LifeService, raw: string, hosts: string[], problem: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LifeApiError(service, 400, problem, true);
  }
  if (url.protocol !== "https:" || !hosts.includes(url.hostname.toLowerCase()) || url.username || url.password) throw new LifeApiError(service, 400, problem, true);
  return url;
}
