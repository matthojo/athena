/**
 * Whoop without MCP: a narrow, read-only adapter over the WHOOP API v2
 * (api.prod.whoop.com/developer/v2), registered in direct.ts.
 *
 * Followed from developer.whoop.com (read 7 Nov 2026):
 *  - The owner makes their own app and signs in with
 *    `read:sleep read:workout read:recovery read:cycles offline`; without
 *    `offline` WHOOP gives no refresh token. No PKCE. The client goes in
 *    the form body. Access tokens last about an hour; every renewal rotates
 *    the refresh token (the old one stops working), saved straight back
 *    sealed. Renewal sends `scope=offline`, as WHOOP's example does.
 *  - Collections (sleep, recovery, workout, cycle) take start, end, limit
 *    (at most 25) and nextToken, and answer `{ records, next_token }`,
 *    newest first. Records only carry `score` once WHOOP has scored them.
 *  - v1 is no longer supported; ids are UUIDs in v2.
 *
 * Days: a night belongs to the morning it ends (as Oura and the Life log
 * have it). Recovery has no time of its own: it's joined to its sleep.
 *
 * Figures are health content (docs: security/encryption): they go back to the run only,
 * never into an error or a log line.
 */
import { WHOOP_API_URL, WHOOP_SCOPE } from "../../../lib/presets/health";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { stagesOf } from "../../../lib/sleep-stages";
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
import { whoopRecent } from "./activity-recent";

export const WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
/** WHOOP's page size cap. */
const PAGE = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("whoop", 401, "Whoop didn't accept the sign-in. Sign in again", true);
  if (status === 403) return new LifeApiError("whoop", 403, "Whoop didn't let Athena read that. Sign in again and allow everything Athena asks for.", true);
  if (status === 429) return new LifeApiError("whoop", 429, "Whoop is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("whoop", status, "Whoop is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("whoop", 400, "Whoop didn't understand those dates");
  if (status === 404) return new LifeApiError("whoop", 404, "Whoop couldn't find that");
  return new LifeApiError("whoop", status, `Whoop refused that (${status})`);
}

/** POST to WHOOP's token endpoint, the client in the form body. Retries 429, 5xx and dropped connections. */
export async function whoopToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  const form = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret ?? "", ...params });
  if (params.grant_type === "refresh_token") form.set("scope", "offline");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(WHOOP_TOKEN_URL, {
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
      throw new LifeApiError("whoop", 503, "Couldn't reach Whoop to renew the sign-in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      return {
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expires_in: Number(body.expires_in) || undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        token_type: typeof body.token_type === "string" ? body.token_type : undefined,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    if (res.status >= 500) throw new LifeApiError("whoop", res.status, "Whoop is having trouble right now. Try again in a few minutes.");
    const code = typeof body?.error === "string" ? body.error : "";
    if (res.status === 401 || code === "invalid_client" || code === "unauthorized_client") {
      throw new LifeApiError("whoop", 401, "Whoop refused Athena's app. Check the Client ID and Secret under Edit, then sign in again.", true);
    }
    throw new LifeApiError("whoop", 400, "Sign in again", true);
  }
}

const TOKEN: TokenEndpoint = { service: "whoop", url: WHOOP_TOKEN_URL, label: "Whoop", request: whoopToken };

export interface WhoopContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  tz: string;
}

interface Page<T> {
  records?: T[];
  next_token?: string | null;
}

interface Sleep {
  id?: string;
  start?: string;
  end?: string;
  nap?: boolean;
  score_state?: string;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      disturbance_count?: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
}

interface Recovery {
  sleep_id?: string;
  cycle_id?: number;
  score_state?: string;
  score?: { recovery_score?: number; resting_heart_rate?: number; hrv_rmssd_milli?: number; spo2_percentage?: number; skin_temp_celsius?: number; user_calibrating?: boolean };
}

interface WhoopWorkout {
  id?: string;
  start?: string;
  end?: string;
  sport_name?: string;
  score_state?: string;
  score?: { strain?: number; average_heart_rate?: number; max_heart_rate?: number; kilojoule?: number; distance_meter?: number; altitude_gain_meter?: number };
}

const round = (n: number | undefined, places = 0): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : undefined);
const minutesOf = (ms: number | undefined): number | undefined => (typeof ms === "number" && ms >= 0 ? Math.round(ms / 60_000) : undefined);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every record from start to end, following next_token; at most `max` (and 20 pages). */
async function collect<T>(ctx: WhoopContext, path: string, range: { start?: number; end?: number }, max: number, token?: string): Promise<{ records: T[]; next?: string }> {
  const records: T[] = [];
  let next = token;
  for (let n = 0; n < 20 && records.length < max; n++) {
    const body = await ctx.get<Page<T>>(path, { start: iso(range.start), end: iso(range.end), limit: PAGE, nextToken: next });
    records.push(...(body.records ?? []));
    next = body.next_token || undefined;
    if (!next) break;
  }
  return { records, next };
}

/** Minutes asleep: light, deep (slow wave) and REM. Awake time in bed doesn't count. */
const asleep = (s: Sleep): number | undefined => {
  const st = s.score?.stage_summary;
  if (!st) return undefined;
  return minutesOf((st.total_light_sleep_time_milli ?? 0) + (st.total_slow_wave_sleep_time_milli ?? 0) + (st.total_rem_sleep_time_milli ?? 0));
};

function sleepShape(s: Sleep, tz: string, recovery?: Recovery) {
  const end = Date.parse(s.end ?? "");
  const start = Date.parse(s.start ?? "");
  const st = s.score?.stage_summary;
  return clean({
    date: Number.isFinite(end) ? when(end, tz).date : undefined,
    nap: s.nap || undefined,
    scored: s.score_state === "SCORED" ? undefined : false,
    total_minutes: asleep(s),
    in_bed_minutes: minutesOf(st?.total_in_bed_time_milli),
    awake_minutes: minutesOf(st?.total_awake_time_milli),
    deep_minutes: minutesOf(st?.total_slow_wave_sleep_time_milli),
    rem_minutes: minutesOf(st?.total_rem_sleep_time_milli),
    light_minutes: minutesOf(st?.total_light_sleep_time_milli),
    performance: round(s.score?.sleep_performance_percentage),
    efficiency: round(s.score?.sleep_efficiency_percentage),
    consistency: round(s.score?.sleep_consistency_percentage),
    respiratory_rate: round(s.score?.respiratory_rate, 1),
    bedtime: Number.isFinite(start) ? when(start, tz).time : undefined,
    wake_time: Number.isFinite(end) ? when(end, tz).time : undefined,
    recovery: round(recovery?.score?.recovery_score),
    resting_hr: round(recovery?.score?.resting_heart_rate),
    hrv_ms: round(recovery?.score?.hrv_rmssd_milli),
    calibrating: recovery?.score?.user_calibrating || undefined,
  });
}

/** "functional-fitness" → "functional fitness"; health-line reads "running" as a run. */
export const sportType = (w: WhoopWorkout): string => (w.sport_name || "workout").replace(/[-_]+/g, " ").trim().toLowerCase();

function workoutShape(w: WhoopWorkout, tz: string) {
  const start = Date.parse(w.start ?? "");
  const end = Date.parse(w.end ?? "");
  const at = Number.isFinite(start) ? when(start, tz) : undefined;
  return clean({
    date: at?.date,
    time: at?.time,
    type: sportType(w),
    minutes: Number.isFinite(end - start) && end > start ? Math.round((end - start) / 60_000) : undefined,
    strain: round(w.score?.strain, 1),
    distance_m: round(w.score?.distance_meter) || undefined,
    elevation_m: round(w.score?.altitude_gain_meter) || undefined,
    kcal: w.score?.kilojoule ? round(w.score.kilojoule / 4.184) : undefined,
    average_hr: round(w.score?.average_heart_rate),
    max_hr: round(w.score?.max_heart_rate),
  });
}

/** The window as instants: the tool's after/before, or the last 7 days. */
function rangeOf(args: Record<string, unknown>, tz: string): { start: number; end?: number } {
  const w = windowOf(args, tz);
  return { start: w.after ?? Date.now() - 7 * 86_400_000, end: w.before };
}

/** Sleeps in the window, joined to their recovery. A night counts where it ends. */
async function sleepsIn(ctx: WhoopContext, args: Record<string, unknown>, limit: number) {
  const r = rangeOf(args, ctx.tz);
  const { records, next } = await collect<Sleep>(ctx, "/activity/sleep", { start: r.start - 86_400_000, end: r.end }, limit, decodeCursor<string>("whoop:sleep", args.cursor));
  const inside = records.filter((s) => {
    const end = Date.parse(s.end ?? "");
    return Number.isFinite(end) && inWindow(end, { after: r.start, before: r.end });
  });
  const { records: recoveries } = inside.length ? await collect<Recovery>(ctx, "/recovery", { start: r.start - 86_400_000, end: r.end }, 200) : { records: [] };
  const byId = new Map(recoveries.filter((x) => x.sleep_id).map((x) => [x.sleep_id!, x]));
  return { items: inside.slice(0, limit).map((s) => sleepShape(s, ctx.tz, s.id ? byId.get(s.id) : undefined)), next };
}

async function workoutsIn(ctx: WhoopContext, args: Record<string, unknown>, limit: number) {
  const r = rangeOf(args, ctx.tz);
  const { records, next } = await collect<WhoopWorkout>(ctx, "/activity/workout", r, limit, decodeCursor<string>("whoop:workouts", args.cursor));
  const inside = records.filter((w) => {
    const start = Date.parse(w.start ?? "");
    return Number.isFinite(start) && inWindow(start, { after: r.start, before: r.end });
  });
  return { items: inside.slice(0, limit).map((w) => workoutShape(w, ctx.tz)), next };
}

/** One local day in athena_health_day's shape, recovery included. Strain has no field there, so it stays in workouts. */
async function healthDay(ctx: WhoopContext, args: Record<string, unknown>) {
  const date = arg.str(args, "date", { required: true })!;
  if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
  const [{ items: nights }, { items: workouts }] = await Promise.all([sleepsIn(ctx, { date }, 100), workoutsIn(ctx, { date }, 100)]);
  const main = nights.filter((n) => !n.nap).sort((a, b) => (b.total_minutes ?? 0) - (a.total_minutes ?? 0))[0];
  return {
    ...clean({
      date,
      source: "whoop",
      sleep_minutes: main?.total_minutes,
      // Whoop's slow wave sleep is deep; its light sleep is Apple's core.
      sleep_stages: main ? stagesOf({ deep: main.deep_minutes, core: main.light_minutes, rem: main.rem_minutes, awake: main.awake_minutes, in_bed: main.in_bed_minutes }) : undefined,
      resting_hr: main?.resting_hr, recovery: main?.recovery }),
    workouts: workouts
      .filter((w) => w.minutes)
      .reverse()
      .map((w) => clean({ type: w.type, minutes: w.minutes, distance_m: w.distance_m, kcal: w.kcal, start: w.time, elevation_m: w.elevation_m })),
  };
}

const LIMIT = { type: "integer", minimum: 1, maximum: 100, description: "At most this many (default 25)." };
const windowed = { type: "object" as const, properties: { ...WINDOW_PROPS, limit: LIMIT, ...CURSOR_PROP } };
const RULE = "Health figures: pass them on only through athena_health_day, never into a note.";
const page = (tag: string, next: string | undefined) => (next ? encodeCursor(tag, next) : undefined);

export const WHOOP_TOOLS: LifeTool<WhoopContext>[] = [
  {
    name: "sleep",
    summary: "See how you slept",
    description: `Sleeps, newest first, each on the local day it ended: nap, total_minutes asleep, in_bed/awake/deep/rem/light minutes, performance, efficiency and consistency (%), respiratory_rate, bedtime and wake_time (local), and that night's recovery (0–100), resting_hr and hrv_ms. scored: false while Whoop is still working it out. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { items, next } = await sleepsIn(ctx, args, arg.int(args, "limit", { min: 1, max: 100, fallback: 25 }));
      return withItems(items, { next_cursor: page("whoop:sleep", next) });
    },
  },
  {
    name: "workouts",
    summary: "See your workouts",
    description: `Workouts, newest first: local date and time, type (Whoop's sport), minutes, strain (0–21), distance_m, elevation_m, kcal, average_hr and max_hr. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { items, next } = await workoutsIn(ctx, args, arg.int(args, "limit", { min: 1, max: 100, fallback: 25 }));
      return withItems(items, { next_cursor: page("whoop:workouts", next) });
    },
  },
  {
    name: "day_summary",
    summary: "See one day's figures",
    description:
      'One local day in athena_health_day\'s shape: { date, source: "whoop", sleep_minutes?, sleep_stages? { deep (slow wave), core (light), rem, awake, in_bed }, resting_hr?, recovery?, workouts: [{ type, minutes, distance_m?, kcal?, start?, elevation_m? }] }. sleep_minutes is the night ending that morning; resting_hr and recovery (0–100) are from that night\'s recovery. Pass it straight to athena_health_day. Fields are left out when Whoop has nothing (strap not worn, not scored yet).',
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    run: healthDay,
  },
];

/** Open a signed-in account: one cheap read (the latest recovery), which proves the sign-in works. */
export async function openWhoop(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("whoop", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${WHOOP_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return session.get<T>(url.toString(), { service: "whoop", hosts: ["api.prod.whoop.com"], refused, unreachable: "Couldn't reach Whoop" });
  };
  const [, zone] = await Promise.all([get("/recovery", { limit: 1 }), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("whoop", WHOOP_TOOLS, { get, tz: zone });
}

/** WHOOP's consent page. No PKCE; the state is Athena's usual 43 characters (WHOOP asks for at least 8). */
export function whoopAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: input.clientId, response_type: "code", redirect_uri: input.redirectUri, scope: input.scope || WHOOP_SCOPE, state: input.state }).toString();
  return url.toString();
}

export async function exchangeWhoopCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await whoopToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  if (!tokens.refresh_token) throw new LifeApiError("whoop", 400, "Whoop gave Athena no way to renew this sign-in. Sign in again and allow offline access.", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const whoopAdapter: DirectAdapter = {
  id: "whoop",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: whoopRecent,
  handles: (c) => c.provider === "whoop" && c.auth_type === "oauth",
  tools: () => WHOOP_TOOLS,
  serverInfo: () => ({ website_url: "https://www.whoop.com/" }),
  open: (connector, secrets) => openWhoop(connector, secrets),
  authorizationUrl: whoopAuthorizationUrl,
  exchangeCode: exchangeWhoopCode,
  accountProblem: (e) => lifeAccountProblem("whoop", e),
  failure: (e) => lifeFailure("whoop", e),
};
