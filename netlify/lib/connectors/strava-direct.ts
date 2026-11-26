/**
 * Strava without MCP: a narrow, read-only adapter over the Strava API v3
 * (www.strava.com/api/v3), registered in direct.ts.
 *
 * The owner makes their own app (Single Player Mode: only they can sign in to
 * it) and signs in with `read,activity:read_all`. Strava takes the client in
 * the form body, not Basic auth, and has no PKCE: the challenge is left out.
 * Tokens last six hours; every renewal rotates the refresh token, which is
 * saved straight back sealed.
 *
 * Read limits are 100 requests per 15 minutes. Calories are only on an
 * activity's own page, so a call reads at most DETAIL_CAP of those.
 *
 * Figures are health content (docs: security/encryption): they go back to the run only,
 * never into an error or a log line.
 */
import { STRAVA_API_URL, STRAVA_SCOPE } from "../../../lib/presets/health";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { ToolInputError, arg, clean, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  OAuthSession,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  inWindow,
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
import { stravaRecent } from "./activity-recent";

export const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
/** Activities whose own page (for calories) one call reads. */
export const DETAIL_CAP = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strava's error body: `{ message, errors: [{ resource, field, code }] }`. Only the codes are read. */
function missingPermission(body: unknown): boolean {
  const errors = (body as { errors?: Array<{ field?: unknown; code?: unknown }> } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e?.code === "missing" && /permission/i.test(String(e?.field ?? "")));
}

const NO_PERMISSION = "Strava didn't let Athena see your activities. Sign in again and leave every box ticked.";

function refused(status: number, body: unknown): LifeApiError {
  if (status === 401) {
    if (missingPermission(body)) return new LifeApiError("strava", 403, NO_PERMISSION, true);
    return new LifeApiError("strava", 401, "Strava didn't accept the sign-in. Sign in again", true);
  }
  if (status === 403) return new LifeApiError("strava", 403, NO_PERMISSION, true);
  if (status === 429) return new LifeApiError("strava", 429, "Strava is limiting how often Athena can ask. Try again in 15 minutes.");
  if (status >= 500) return new LifeApiError("strava", status, "Strava is having trouble right now. Try again in a few minutes.");
  if (status === 404) return new LifeApiError("strava", 404, "Strava couldn't find that");
  return new LifeApiError("strava", status, `Strava refused that (${status})`);
}

/** POST to Strava's token endpoint with the client in the form body. Retries 429, 5xx and dropped connections. */
export async function stravaToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  const form = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret ?? "", ...params });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(STRAVA_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError("strava", 503, "Couldn't reach Strava to renew the sign-in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      const expiresAt = Number(body.expires_at);
      const expiresIn = Number(body.expires_in) || (Number.isFinite(expiresAt) ? Math.round(expiresAt - Date.now() / 1000) : undefined);
      return {
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expires_in: expiresIn,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        token_type: typeof body.token_type === "string" ? body.token_type : undefined,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    if (res.status >= 500) throw new LifeApiError("strava", res.status, "Strava is having trouble right now. Try again in a few minutes.");
    const errors = (body?.errors ?? []) as Array<{ resource?: unknown; field?: unknown }>;
    const appProblem = res.status === 401 || (Array.isArray(errors) && errors.some((e) => e?.resource === "Application" || /client/i.test(String(e?.field ?? ""))));
    if (appProblem) throw new LifeApiError("strava", 401, "Strava refused Athena's app. Check the Client ID and Client Secret under Edit, then sign in again.", true);
    throw new LifeApiError("strava", 400, "Sign in again", true);
  }
}

const TOKEN: TokenEndpoint = { service: "strava", url: STRAVA_TOKEN_URL, label: "Strava", request: stravaToken };

export interface StravaContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  tz: string;
}

interface Activity {
  id?: number;
  name?: string;
  type?: string;
  sport_type?: string;
  start_date?: string;
  moving_time?: number;
  elapsed_time?: number;
  distance?: number;
  total_elevation_gain?: number;
  average_heartrate?: number;
  has_heartrate?: boolean;
  calories?: number;
  private?: boolean;
  manual?: boolean;
  map?: { summary_polyline?: string | null };
}

const round = (n: number | undefined, places = 0): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : undefined);
const minutes = (s: number | undefined): number | undefined => (typeof s === "number" && s > 0 ? Math.round(s / 60) : undefined);

/** "TrailRun" → "trail run"; the Life log reads it as words. */
export const activityType = (a: Activity): string =>
  (a.sport_type || a.type || "Workout")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^E /, "E-")
    .toLowerCase();

function shape(a: Activity, tz: string, kcal?: number) {
  const ms = Date.parse(a.start_date ?? "");
  const at = Number.isFinite(ms) ? when(ms, tz) : undefined;
  return clean({
    name: a.name,
    type: activityType(a),
    date: at?.date,
    time: at?.time,
    moving_minutes: minutes(a.moving_time),
    elapsed_minutes: minutes(a.elapsed_time),
    distance_m: round(a.distance) || undefined,
    elevation_m: round(a.total_elevation_gain) || undefined,
    average_hr: a.has_heartrate === false ? undefined : round(a.average_heartrate),
    kcal: round(kcal) || undefined,
    private: a.private || undefined,
    manual: a.manual || undefined,
    link: a.id ? `https://www.strava.com/activities/${a.id}` : undefined,
  });
}

/** Calories, from each activity's own page; at most DETAIL_CAP, in order. A failed read leaves kcal out rather than failing the call. */
async function caloriesFor(ctx: StravaContext, list: Activity[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const a of list.slice(0, DETAIL_CAP)) {
    if (!a.id) continue;
    try {
      const d = await ctx.get<Activity>(`/activities/${a.id}`);
      if (typeof d.calories === "number" && d.calories > 0) out.set(a.id, d.calories);
    } catch (error) {
      if (error instanceof LifeApiError && (error.owner || error.status === 429)) throw error;
    }
  }
  return out;
}

const PER_PAGE = 50;
const seconds = (ms: number | undefined) => (ms === undefined ? undefined : Math.floor(ms / 1000));

/** Activities in the window, newest first, by Strava page. Stops at three pages a call. */
async function activitiesIn(ctx: StravaContext, args: Record<string, unknown>, limit: number) {
  const w = windowOf(args, ctx.tz);
  let page = decodeCursor<number>("strava:activities", args.cursor) ?? 1;
  const found: Activity[] = [];
  let next: number | undefined;
  for (let n = 0; n < 3 && found.length < limit; n++, page++) {
    const list = await ctx.get<Activity[]>("/athlete/activities", { after: seconds(w.after === undefined ? undefined : w.after - 1000), before: seconds(w.before), page, per_page: PER_PAGE });
    if (!Array.isArray(list)) break;
    for (const a of list) {
      const ms = Date.parse(a.start_date ?? "");
      if (Number.isFinite(ms) && inWindow(ms, w)) found.push(a);
    }
    next = list.length === PER_PAGE ? page + 1 : undefined;
    if (next === undefined) break;
  }
  found.sort((a, b) => Date.parse(b.start_date ?? "") - Date.parse(a.start_date ?? ""));
  return { found: found.slice(0, limit), next };
}

async function listActivities(ctx: StravaContext, args: Record<string, unknown>) {
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 30 });
  const { found, next } = await activitiesIn(ctx, args, limit);
  const kcal = await caloriesFor(ctx, found);
  const items = found.map((a) => shape(a, ctx.tz, a.id ? kcal.get(a.id) : undefined));
  return withItems(items, {
    count: items.length,
    moving_minutes: items.reduce((s, i) => s + ((i.moving_minutes as number | undefined) ?? 0), 0),
    next_cursor: next ? encodeCursor("strava:activities", next) : undefined,
    note: found.length > DETAIL_CAP ? `kcal is read for the first ${DETAIL_CAP} only.` : undefined,
  });
}

/** One local day, in athena_health_day's shape: workouts only (Strava doesn't count steps or sleep). */
async function healthDay(ctx: StravaContext, args: Record<string, unknown>) {
  const date = arg.str(args, "date", { required: true })!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
  const { found } = await activitiesIn(ctx, { date }, 100);
  const kcal = await caloriesFor(ctx, found);
  const workouts = found
    .slice()
    .reverse()
    .map((a) =>
      clean({
        type: activityType(a),
        minutes: minutes(a.moving_time) ?? minutes(a.elapsed_time) ?? 0,
        distance_m: round(a.distance) || undefined,
        kcal: a.id ? round(kcal.get(a.id)) : undefined,
        start: Number.isFinite(Date.parse(a.start_date ?? "")) ? when(Date.parse(a.start_date!), ctx.tz).time : undefined,
        name: a.name?.trim() || undefined,
        elevation_m: round(a.total_elevation_gain) || undefined,
        route: a.map?.summary_polyline && a.map.summary_polyline.length <= 8000 ? a.map.summary_polyline : undefined,
      }),
    );
  return { date, source: "strava", workouts };
}

export const STRAVA_TOOLS: LifeTool<StravaContext>[] = [
  {
    name: "activities",
    summary: "See your activities",
    description:
      "The owner's Strava activities, newest first: name, type (run, ride, walk…), local date and time, moving and elapsed minutes, distance_m, elevation_m, average_hr, kcal (Strava's estimate, first 10 only), private, manual, and link. Plus count and moving_minutes for what's returned. Filter with date (one local day) or after/before. Health figures: pass them on only through athena_health_day, never into a note.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 30)." }, ...CURSOR_PROP } },
    annotations: readOnly,
    run: listActivities,
  },
  {
    name: "day_summary",
    summary: "See one day's workouts",
    description:
      "One local day in athena_health_day's shape: { date, source: \"strava\", workouts: [{ type, minutes, distance_m?, kcal?, start?, name?, elevation_m?, route? }] }, oldest first. Pass it straight to athena_health_day. An empty list means no activities that day.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    run: healthDay,
  },
];

/** Open a signed-in account: one cheap read (/athlete), which proves the sign-in works. */
export async function openStrava(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("strava", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${STRAVA_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return session.get<T>(url.toString(), { service: "strava", hosts: ["www.strava.com"], refused, unreachable: "Couldn't reach Strava" });
  };
  const [, zone] = await Promise.all([get("/athlete"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("strava", STRAVA_TOOLS, { get, tz: zone });
}

/** Strava's consent page. No PKCE (Strava doesn't take it); approval_prompt=auto skips the page on a repeat sign-in. */
export function stravaAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    approval_prompt: "auto",
    scope: input.scope || STRAVA_SCOPE,
    state: input.state,
  }).toString();
  return url.toString();
}

export async function exchangeStravaCode(input: { code: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await stravaToken(input.client, { grant_type: "authorization_code", code: input.code });
  if (!tokens.refresh_token) throw new LifeApiError("strava", 400, "Strava gave Athena no way to renew this sign-in", true);
  // Strava lets the owner untick boxes on its consent page; without activity:read nothing can be read.
  if (tokens.scope && !/activity:read/.test(tokens.scope)) throw new LifeApiError("strava", 403, NO_PERMISSION, true);
  return { ...tokens, obtained_at: Date.now() };
}

export const stravaAdapter: DirectAdapter = {
  id: "strava",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: stravaRecent,
  handles: (c) => c.provider === "strava" && c.auth_type === "oauth",
  tools: () => STRAVA_TOOLS,
  serverInfo: () => ({ website_url: "https://www.strava.com/" }),
  open: (connector, secrets) => openStrava(connector, secrets),
  authorizationUrl: stravaAuthorizationUrl,
  exchangeCode: exchangeStravaCode,
  accountProblem: (e) => lifeAccountProblem("strava", e),
  failure: (e) => lifeFailure("strava", e),
};
