/**
 * Swarm without MCP: a narrow, read-only adapter over Foursquare's v2 API
 * (api.foursquare.com/v2), registered in direct.ts.
 *
 * The owner makes their own Foursquare app and signs in once. Foursquare's
 * user tokens don't expire and come without a refresh token; should one
 * ever carry an expiry and a refresh token, it's renewed like Strava's
 * (OAuthSession) and saved back sealed. A refused token means "sign in
 * again". The token goes in the query (`oauth_token`), as v2 wants.
 *
 * One tool, `checkins`: the owner's check-ins, newest first, with the venue,
 * its coordinates and category. It's for Athena's own sync
 * (swarm-sync.ts), which seals them; the runner never offers it to Claude.
 * Where you've been never goes into an error or a log line.
 */
import { SWARM_API_URL, SWARM_API_VERSION } from "../../../lib/presets/travel";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  OAuthSession,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  getJson,
  lifeAccountProblem,
  lifeFailure,
  lifeRetryWaits,
  ownerZone,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
  type TokenEndpoint,
} from "./lifelog-b-http";

export const SWARM_AUTHORIZE_URL = "https://foursquare.com/oauth2/authenticate";
export const SWARM_TOKEN_URL = "https://foursquare.com/oauth2/access_token";
/** Foursquare's largest page. */
export const PAGE = 250;
/** Pages one call reads at most. */
export const MAX_PAGES = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Foursquare's errors: `{ meta: { code, errorType, errorDetail } }`. Only the type is read. */
function refused(status: number, body: unknown): LifeApiError {
  const type = String((body as { meta?: { errorType?: unknown } } | null)?.meta?.errorType ?? "");
  if (status === 401 || type === "invalid_auth") return new LifeApiError("swarm", 401, "Swarm didn't accept the sign-in. Sign in again", true);
  if (type === "rate_limit_exceeded" || status === 429) return new LifeApiError("swarm", 429, "Foursquare is limiting how often Athena can ask. It tries again tonight.");
  if (status === 403 || type === "not_authorized") return new LifeApiError("swarm", 403, "Foursquare didn't let Athena see your check-ins. Sign in again and allow access.", true);
  if (status >= 500) return new LifeApiError("swarm", status, "Foursquare is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("swarm", status, `Foursquare refused that (${status})`);
}

/** Foursquare's token endpoint takes the client and code in the query, and answers `{ access_token }`. */
export async function swarmToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  const url = new URL(SWARM_TOKEN_URL);
  url.search = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret ?? "", ...params }).toString();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError("swarm", 503, "Couldn't reach Foursquare to sign in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      return clean({
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
      }) as StoredTokens;
    }
    if (res.status >= 500 && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    if (res.status >= 500) throw new LifeApiError("swarm", res.status, "Foursquare is having trouble right now. Try again in a few minutes.");
    if (body?.error === "invalid_client" || res.status === 401) throw new LifeApiError("swarm", 401, "Foursquare refused Athena's app. Check the Client ID and Client Secret under Edit, then sign in again.", true);
    throw new LifeApiError("swarm", 400, "Sign in again", true);
  }
}

const TOKEN: TokenEndpoint = { service: "swarm", url: SWARM_TOKEN_URL, label: "Foursquare", request: swarmToken };

export interface SwarmContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  tz: string;
}

interface RawCheckin {
  id?: string;
  createdAt?: number;
  type?: string;
  private?: boolean;
  venue?: {
    id?: string;
    name?: string;
    location?: { lat?: number; lng?: number; city?: string; state?: string; country?: string };
    categories?: Array<{ name?: string; primary?: boolean }>;
  };
}

interface CheckinPage {
  response?: { checkins?: { count?: number; items?: RawCheckin[] } };
}

/** One check-in in Athena's shape (lib/places-visits.ts Checkin), plus its local date and time. Null without a venue or coordinates. */
export interface SwarmCheckin {
  id: string;
  at: string;
  date: string;
  time: string;
  venue: string;
  venue_id?: string;
  category?: string;
  lat: number;
  lng: number;
  town?: string;
  private?: boolean;
}

export function shapeCheckin(c: RawCheckin, tz: string): SwarmCheckin | null {
  const lat = c.venue?.location?.lat;
  const lng = c.venue?.location?.lng;
  if (!c.id || !c.createdAt || !c.venue?.name || typeof lat !== "number" || typeof lng !== "number") return null;
  const ms = c.createdAt * 1000;
  const at = when(ms, tz);
  const category = (c.venue.categories ?? []).find((k) => k.primary)?.name ?? c.venue.categories?.[0]?.name;
  return clean({
    id: c.id,
    at: new Date(ms).toISOString(),
    date: at.date,
    time: at.time,
    venue: c.venue.name.trim().slice(0, 120),
    venue_id: c.venue.id,
    category,
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    town: c.venue.location?.city,
    private: c.private || undefined,
  }) as SwarmCheckin;
}

/** Check-ins in the window, newest first, PAGE at a time by offset; at most MAX_PAGES pages a call, then a cursor. */
async function checkins(ctx: SwarmContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: PAGE * MAX_PAGES, fallback: PAGE * MAX_PAGES });
  let offset = decodeCursor<number>("swarm:checkins", args.cursor) ?? 0;
  const items: SwarmCheckin[] = [];
  let next: number | undefined;
  for (let page = 0; page < MAX_PAGES && items.length < limit; page++) {
    const body = await ctx.get<CheckinPage>("/users/self/checkins", {
      limit: PAGE,
      offset,
      sort: "newestfirst",
      afterTimestamp: w.after === undefined ? undefined : Math.floor(w.after / 1000),
      beforeTimestamp: w.before === undefined ? undefined : Math.floor(w.before / 1000),
    });
    const list = body.response?.checkins?.items ?? [];
    for (const c of list) {
      const s = shapeCheckin(c, ctx.tz);
      // Foursquare's timestamps are whole seconds: the window is checked here too.
      if (s && (w.after === undefined || Date.parse(s.at) >= w.after) && (w.before === undefined || Date.parse(s.at) < w.before)) items.push(s);
    }
    offset += list.length;
    next = list.length === PAGE ? offset : undefined;
    if (next === undefined) break;
  }
  return withItems(items.slice(0, limit), { count: items.length, next_cursor: next !== undefined ? encodeCursor("swarm:checkins", next) : undefined });
}

export const SWARM_TOOLS: LifeTool<SwarmContext>[] = [
  {
    name: "checkins",
    summary: "See your check-ins",
    description:
      "The owner's Swarm check-ins, newest first: id, at (UTC), local date and time, venue, venue_id, category, lat, lng, town, private. Filter with date (one local day) or after/before; next_cursor pages on. Location is sealed by Athena's own sync; never put it in a note.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, limit: { type: "integer", minimum: 1, maximum: PAGE * MAX_PAGES }, ...CURSOR_PROP } },
    annotations: readOnly,
    run: checkins,
  },
];

/** Open a signed-in account: one cheap read (/users/self), which proves the sign-in works. */
export async function openSwarm(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("swarm", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const fetchOnce = async <T>(path: string, params: Record<string, string | number | undefined>, token: string): Promise<T> => {
    const url = new URL(`${SWARM_API_URL}${path}`);
    for (const [k, v] of Object.entries({ ...params, v: SWARM_API_VERSION, oauth_token: token })) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), { service: "swarm", hosts: ["api.foursquare.com"], refused, unreachable: "Couldn't reach Foursquare" });
  };
  const get = async <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    try {
      return await fetchOnce<T>(path, params, await session.accessToken());
    } catch (error) {
      if (!(error instanceof LifeApiError) || error.status !== 401 || !session.canRenew) throw error;
      return fetchOnce<T>(path, params, await session.renew());
    }
  };
  const [, zone] = await Promise.all([get("/users/self"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("swarm", SWARM_TOOLS, { get, tz: zone });
}

/** Foursquare's consent page. No PKCE; `state` comes back with the code. */
export function swarmAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(SWARM_AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: input.clientId, response_type: "code", redirect_uri: input.redirectUri, state: input.state }).toString();
  return url.toString();
}

export async function exchangeSwarmCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await swarmToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  return { ...tokens, obtained_at: Date.now() };
}

export const swarmAdapter: DirectAdapter = {
  id: "swarm",
  handles: (c) => c.provider === "swarm" && c.auth_type === "oauth",
  tools: () => SWARM_TOOLS,
  serverInfo: () => ({ website_url: "https://www.swarmapp.com/" }),
  open: (connector, secrets) => openSwarm(connector, secrets),
  authorizationUrl: swarmAuthorizationUrl,
  exchangeCode: exchangeSwarmCode,
  accountProblem: (e) => lifeAccountProblem("swarm", e),
  failure: (e) => lifeFailure("swarm", e),
};
