/**
 * Withings without MCP: a narrow, read-only adapter over the Withings Public
 * API (wbsapi.withings.net), registered in direct.ts.
 *
 * Withings does things its own way, and this follows its API reference
 * (developer.withings.com/api-reference, read 7 Nov 2026):
 *  - Sign-in at account.withings.com/oauth2_user/authorize2, scopes
 *    comma-separated, no PKCE.
 *  - Tokens from POST /v2/oauth2 with `action=requesttoken`. Withings
 *    documents two ways to prove the app: the client secret in the form, or
 *    a nonce and HMAC signature. Athena uses the client secret (one request,
 *    no nonce round trip). Replies are wrapped: `{ status, body }`, and
 *    status 0 is success. Access tokens last 3 hours; every renewal rotates
 *    the refresh token, saved straight back sealed.
 *  - Reads are POSTs with form fields and a Bearer token (Getmeas,
 *    Measure v2 Getactivity, Sleep v2 Getsummary). They only read: the
 *    reference documents them as data retrieval, and no other action is sent.
 *  - HTTP is 200 even for errors: the body's status says what went wrong.
 *
 * Figures are health content (docs: security/encryption): they go back to the run only,
 * never into an error or a log line.
 */
import { WITHINGS_API_URL, WITHINGS_SCOPE } from "../../../lib/presets/health";
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
import { addDays, newestFirst, pageDays } from "./oura-direct";
import { zonedParts } from "../../../lib/dates";
import { withingsRecent } from "./activity-recent";

export const WITHINGS_AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
export const WITHINGS_TOKEN_URL = `${WITHINGS_API_URL}/v2/oauth2`;
/** The only actions Athena sends, and where. Anything else is refused before it leaves. */
const READS: Record<string, string> = {
  getmeas: `${WITHINGS_API_URL}/measure`,
  getactivity: `${WITHINGS_API_URL}/v2/measure`,
  getsummary: `${WITHINGS_API_URL}/v2/sleep`,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Withings' body statuses, by family (its "Response Status" table). */
const AUTH_FAILED = (s: number) => (s >= 100 && s <= 102) || s === 200 || s === 401;
const NOT_ALLOWED = (s: number) => s === 214 || s === 277 || s === 2553 || s === 2555;
const BUSY = (s: number) => s === 601 || s === 522;

function statusError(status: number): LifeApiError {
  if (AUTH_FAILED(status)) return new LifeApiError("withings", 401, "Withings didn't accept the sign-in. Sign in again", true);
  if (NOT_ALLOWED(status)) return new LifeApiError("withings", 403, "Withings didn't let Athena read that. Sign in again and allow everything Athena asks for.", true);
  if (status === 601) return new LifeApiError("withings", 429, "Withings is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status === 522) return new LifeApiError("withings", 503, "Withings took too long to answer. Try again in a few minutes.");
  return new LifeApiError("withings", 400, `Withings refused that (status ${status})`);
}

interface Envelope<T> {
  status?: number;
  body?: T;
}

/** POST a form to Withings and unwrap `{ status, body }`. Retries 5xx, 601, 522 and dropped connections. */
async function post<T>(url: string, form: Record<string, string>, headers: Record<string, string>, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError("withings", 503, label);
    }
    const env = (await res.json().catch(() => null)) as Envelope<T> | null;
    const error =
      res.status >= 500 || !env
        ? new LifeApiError("withings", 503, "Withings is having trouble right now. Try again in a few minutes.")
        : res.status === 401
          ? statusError(401)
          : env.status === 0
            ? null
            : statusError(Number(env.status));
    if (!error) return (env!.body ?? {}) as T;
    if ((error.retryable || BUSY(Number(env?.status))) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    throw error;
  }
}

/** `action=requesttoken`, with the client secret in the form (Withings' documented "using client secret" variant). */
export async function withingsToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  let body: Record<string, unknown>;
  try {
    body = await post<Record<string, unknown>>(WITHINGS_TOKEN_URL, { action: "requesttoken", client_id: client.client_id, client_secret: client.client_secret ?? "", ...params }, {}, "Couldn't reach Withings to renew the sign-in");
  } catch (error) {
    if (error instanceof LifeApiError && error.owner) {
      throw new LifeApiError("withings", 401, "Withings didn't accept the sign-in. Check the Client ID and Secret under Edit, then sign in again.", true);
    }
    if (error instanceof LifeApiError && error.status === 400) throw new LifeApiError("withings", 400, "Sign in again", true);
    throw error;
  }
  if (typeof body.access_token !== "string") throw new LifeApiError("withings", 400, "Sign in again", true);
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expires_in: Number(body.expires_in) || undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    token_type: typeof body.token_type === "string" ? body.token_type : undefined,
  };
}

const TOKEN: TokenEndpoint = { service: "withings", url: WITHINGS_TOKEN_URL, label: "Withings", request: withingsToken };

export interface WithingsContext {
  /** One read action. */
  read<T>(action: "getmeas" | "getactivity" | "getsummary", params: Record<string, string | number | undefined>): Promise<T>;
  tz: string;
}

const num = (n: unknown, places = 0): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : undefined);
const min = (s: unknown): number | undefined => (typeof s === "number" && s >= 0 ? Math.round(s / 60) : undefined);
const RULE = "Health figures: pass them on only through athena_health_day, never into a note.";

// ---------- Body measures (Getmeas) ----------

/** Measure types Athena asks for, and what it calls them. Getmeas' meastype table. */
export const MEASURES: Record<number, { key: string; places: number }> = {
  1: { key: "weight_kg", places: 2 },
  6: { key: "fat_ratio", places: 1 },
  8: { key: "fat_mass_kg", places: 2 },
  5: { key: "fat_free_mass_kg", places: 2 },
  76: { key: "muscle_mass_kg", places: 2 },
  88: { key: "bone_mass_kg", places: 2 },
  77: { key: "hydration_kg", places: 2 },
  11: { key: "heart_pulse", places: 0 },
};

interface MeasureGroup {
  grpid?: number;
  date?: number;
  category?: number;
  measures?: Array<{ value?: number; type?: number; unit?: number }>;
}

/** Weigh-ins (and other body measures) in the window, newest first. A group is one weigh-in. */
async function measureGroups(ctx: WithingsContext, args: Record<string, unknown>, cursor?: number) {
  const w = windowOf(args, ctx.tz);
  const now = Date.now();
  const body = await ctx.read<{ measuregrps?: MeasureGroup[]; more?: number | boolean; offset?: number }>("getmeas", {
    meastypes: Object.keys(MEASURES).join(","),
    category: 1,
    startdate: Math.floor((w.after ?? now - 30 * 86_400_000) / 1000),
    enddate: Math.floor((w.before ?? now) / 1000) - (w.before ? 1 : 0),
    offset: cursor,
  });
  const items = (body.measuregrps ?? [])
    .filter((g) => g.category === undefined || g.category === 1)
    .map((g) => {
      const out: Record<string, unknown> = {};
      for (const m of g.measures ?? []) {
        const spec = MEASURES[m.type ?? -1];
        if (spec && typeof m.value === "number") out[spec.key] = num(m.value * 10 ** (m.unit ?? 0), spec.places);
      }
      const at = typeof g.date === "number" ? when(g.date * 1000, ctx.tz) : undefined;
      return { ...clean({ date: at?.date, time: at?.time }), ...(clean(out) as Record<string, unknown>), _ms: g.date ?? 0 };
    })
    .sort((a, b) => b._ms - a._ms)
    .map(({ _ms, ...rest }): Record<string, unknown> => rest);
  const more = body.more === true || body.more === 1;
  return { items, next: more && typeof body.offset === "number" ? body.offset : undefined };
}

// ---------- Activity and sleep (ymd) ----------

const ACTIVITY_FIELDS = "steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max";
const SLEEP_FIELDS = "total_sleep_time,total_timeinbed,sleep_efficiency,sleep_score,deepsleepduration,lightsleepduration,remsleepduration,wakeupcount,wakeupduration,hr_average,hr_min";

/** Every row for the days, following Withings' more/offset (at most 10 pages). */
async function ymdRows<T>(ctx: WithingsContext, action: "getactivity" | "getsummary", key: "activities" | "series", days: { from: string; to: string }, fields: string): Promise<T[]> {
  const out: T[] = [];
  let offset: number | undefined;
  for (let n = 0; n < 10; n++) {
    const body = await ctx.read<Record<string, unknown>>(action, { startdateymd: days.from, enddateymd: days.to, data_fields: fields, offset });
    out.push(...((body[key] as T[] | undefined) ?? []));
    const more = body.more === true || body.more === 1;
    offset = more && typeof body.offset === "number" ? body.offset : undefined;
    if (offset === undefined) break;
  }
  return out;
}

interface ActivityRow {
  date?: string;
  steps?: number;
  distance?: number;
  elevation?: number;
  soft?: number;
  moderate?: number;
  intense?: number;
  active?: number;
  calories?: number;
  totalcalories?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
}

async function activityDays(ctx: WithingsContext, days: { from: string; to: string }) {
  const rows = await ymdRows<ActivityRow>(ctx, "getactivity", "activities", days, ACTIVITY_FIELDS);
  return newestFirst(
    rows
      .filter((r) => r.date && r.date >= days.from && r.date <= days.to)
      .map((r) =>
        clean({
          date: r.date,
          steps: num(r.steps),
          distance_m: num(r.distance),
          floors: num(r.elevation),
          active_minutes: min(r.active ?? ((r.moderate ?? 0) + (r.intense ?? 0) || undefined)),
          light_minutes: min(r.soft),
          moderate_minutes: min(r.moderate),
          intense_minutes: min(r.intense),
          active_calories: num(r.calories),
          total_calories: num(r.totalcalories),
          average_hr: num(r.hr_average),
          min_hr: num(r.hr_min),
          max_hr: num(r.hr_max),
        }),
      ),
  );
}

interface SleepRow {
  date?: string;
  startdate?: number;
  enddate?: number;
  data?: Record<string, number | undefined>;
}

async function sleepDays(ctx: WithingsContext, days: { from: string; to: string }) {
  const rows = await ymdRows<SleepRow>(ctx, "getsummary", "series", days, SLEEP_FIELDS);
  // One row per night; on a day with two (a nap), keep the longest as the night.
  const byDay = new Map<string, SleepRow>();
  for (const r of rows) {
    if (!r.date || r.date < days.from || r.date > days.to) continue;
    const had = byDay.get(r.date);
    if (!had || (r.data?.total_sleep_time ?? 0) > (had.data?.total_sleep_time ?? 0)) byDay.set(r.date, r);
  }
  return newestFirst(
    [...byDay.values()].map((r) => {
      const d = r.data ?? {};
      const eff = d.sleep_efficiency;
      return clean({
        date: r.date,
        total_minutes: min(d.total_sleep_time),
        in_bed_minutes: min(d.total_timeinbed),
        efficiency: typeof eff === "number" ? Math.round(eff <= 1 ? eff * 100 : eff) : undefined,
        score: num(d.sleep_score),
        deep_minutes: min(d.deepsleepduration),
        light_minutes: min(d.lightsleepduration),
        rem_minutes: min(d.remsleepduration),
        wakeups: num(d.wakeupcount),
        awake_minutes: min(d.wakeupduration),
        resting_hr: num(d.hr_min),
        average_hr: num(d.hr_average),
        bedtime: typeof r.startdate === "number" ? when(r.startdate * 1000, ctx.tz).time : undefined,
        wake_time: typeof r.enddate === "number" ? when(r.enddate * 1000, ctx.tz).time : undefined,
      });
    }),
  );
}

const LIMIT = { type: "integer", minimum: 1, maximum: 31, description: "At most this many days a page (default 7)." };
const windowed = { type: "object" as const, properties: { ...WINDOW_PROPS, limit: LIMIT, ...CURSOR_PROP } };

export const WITHINGS_TOOLS: LifeTool<WithingsContext>[] = [
  {
    name: "body_measures",
    summary: "See your weight and body measures",
    description: `Weigh-ins and body measures, newest first, one per measurement: local date and time, weight_kg, fat_ratio (%), fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg, hydration_kg, heart_pulse (bpm), each only when the scale took it. Default: the last 30 days. ${RULE}`,
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, ...CURSOR_PROP } },
    annotations: readOnly,
    async run(ctx, args) {
      const { items, next } = await measureGroups(ctx, args, decodeCursor<number>("withings:meas", args.cursor));
      return withItems(items, { count: items.length, next_cursor: next !== undefined ? encodeCursor("withings:meas", next) : undefined });
    },
  },
  {
    name: "daily_activity",
    summary: "See your steps and activity",
    description: `Activity per local day, newest first: steps, distance_m, floors, active_minutes (moderate plus intense), light/moderate/intense minutes, active_calories, total_calories, average/min/max heart rate. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "withings:activity", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      return withItems(await activityDays(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "daily_sleep",
    summary: "See how you slept",
    description: `Sleep per local day (the morning the night ends), newest first: total_minutes asleep, in_bed_minutes, efficiency (%), score (0–100), deep/light/rem minutes, wakeups, awake_minutes, resting_hr (lowest), average_hr, bedtime and wake_time (local). Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "withings:sleep", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      return withItems(await sleepDays(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "day_summary",
    summary: "See one day's figures",
    description:
      'One local day in athena_health_day\'s shape: { date, source: "withings", sleep_minutes?, sleep_stages? { deep, core (light), rem, awake, in_bed }, steps?, active_minutes?, resting_hr?, weight_kg? }. weight_kg is that day\'s last weigh-in; sleep_minutes the night ending that morning. Pass it straight to athena_health_day. Fields are left out when Withings has nothing.',
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    async run(ctx, args) {
      const date = arg.str(args, "date", { required: true })!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
      const days = { from: date, to: date };
      const [meas, activity, sleepRows] = await Promise.all([measureGroups(ctx, { date }), activityDays(ctx, days), sleepDays(ctx, days)]);
      const weighIn = meas.items.find((m) => typeof m.weight_kg === "number");
      return clean({
        date,
        source: "withings",
        sleep_minutes: sleepRows[0]?.total_minutes,
        sleep_stages: stagesOf({ deep: sleepRows[0]?.deep_minutes, core: sleepRows[0]?.light_minutes, rem: sleepRows[0]?.rem_minutes, awake: sleepRows[0]?.awake_minutes, in_bed: sleepRows[0]?.in_bed_minutes }),
        steps: activity[0]?.steps,
        active_minutes: activity[0]?.active_minutes,
        resting_hr: sleepRows[0]?.resting_hr,
        weight_kg: weighIn?.weight_kg,
      });
    },
  },
];

/** Open a signed-in account: one cheap read (today's activity), which proves the sign-in works. */
export async function openWithings(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("withings", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const read = async <T>(action: "getmeas" | "getactivity" | "getsummary", params: Record<string, string | number | undefined>): Promise<T> => {
    const url = READS[action];
    if (!url) throw new Error("Athena only reads from Withings");
    const form: Record<string, string> = { action };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form[k] = String(v);
    const go = (token: string) => post<T>(url, form, { Authorization: `Bearer ${token}` }, "Couldn't reach Withings");
    try {
      return await go(await session.accessToken());
    } catch (error) {
      if (!(error instanceof LifeApiError) || error.status !== 401 || !session.canRenew) throw error;
      return go(await session.renew());
    }
  };
  const zone = tz ?? (await ownerZone());
  const today = zonedParts(new Date(), zone).date;
  await read("getactivity", { startdateymd: addDays(today, -1), enddateymd: today, data_fields: "steps" });
  return account("withings", WITHINGS_TOOLS, { read, tz: zone });
}

/** Withings' consent page: comma-separated scopes, and no PKCE (Withings doesn't take it). */
export function withingsAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(WITHINGS_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    scope: input.scope || WITHINGS_SCOPE,
    redirect_uri: input.redirectUri,
    state: input.state,
  }).toString();
  return url.toString();
}

export async function exchangeWithingsCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await withingsToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  if (!tokens.refresh_token) throw new LifeApiError("withings", 400, "Withings gave Athena no way to renew this sign-in", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const withingsAdapter: DirectAdapter = {
  id: "withings",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: withingsRecent,
  handles: (c) => c.provider === "withings" && c.auth_type === "oauth",
  tools: () => WITHINGS_TOOLS,
  serverInfo: () => ({ website_url: "https://www.withings.com/" }),
  open: (connector, secrets) => openWithings(connector, secrets),
  authorizationUrl: withingsAuthorizationUrl,
  exchangeCode: exchangeWithingsCode,
  accountProblem: (e) => lifeAccountProblem("withings", e),
  failure: (e) => lifeFailure("withings", e),
};
