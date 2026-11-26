/**
 * Polar without MCP: a narrow, read-only adapter over Polar AccessLink v3
 * (www.polaraccesslink.com/v3), registered in direct.ts.
 *
 * Followed from polar.com/accesslink-api (read 7 Nov 2026):
 *  - The owner makes their own client at admin.polaraccesslink.com and signs
 *    in at flow.polar.com with `accesslink.read_all`. The code is swapped at
 *    polarremote.com with the client in Basic auth. The answer carries
 *    `x_user_id`, and no refresh token: Polar's tokens last until revoked
 *    (a 401 means sign in again).
 *  - AccessLink only serves a user registered with the client, so the
 *    sign-in ends with POST /v3/users (`member-id`). 409 means already
 *    registered, which is fine. 403 means the owner hasn't accepted Polar's
 *    consents: needs_auth.
 *  - Reads use the non-transactional endpoints Polar now points to
 *    (exercises for the last 30 days, daily activity up to 365 days back in
 *    28-day ranges, sleep and Nightly Recharge for the last 28 days). They
 *    can be read again and again.
 *  - The older pull model (exercise and activity transactions: create,
 *    list, read, commit) is marked deprecated but still documented. Athena
 *    uses it only to learn which days have new data (`changed_days`). It
 *    commits a transaction only after every item in it was read; a failed
 *    read leaves it uncommitted, so Polar offers the same data next time.
 *    Committing loses nothing Athena needs: the figures are re-read from
 *    the non-transactional endpoints.
 *  - The only writes Athena sends are those two kinds of POST (register,
 *    open a transaction) and PUT (commit). Nothing is ever deleted.
 *
 * Figures are health content (docs: security/encryption): they go back to the run only,
 * never into an error or a log line.
 */
import { POLAR_API_URL, POLAR_SCOPE } from "../../../lib/presets/health";
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
import { addDays, newestFirst, pageDays } from "./oura-direct";
import { polarRecent } from "./activity-recent";

export const POLAR_AUTHORIZE_URL = "https://flow.polar.com/oauth2/authorization";
export const POLAR_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
const HOST = "www.polaraccesslink.com";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_CONSENT = "Polar needs you to accept its data sharing terms. Open Polar Flow, accept them, then sign in again.";

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("polar", 401, "Polar didn't accept the sign-in. Sign in again", true);
  if (status === 403) return new LifeApiError("polar", 403, NO_CONSENT, true);
  if (status === 429) return new LifeApiError("polar", 429, "Polar is limiting how often Athena can ask right now. Try again in 15 minutes.");
  if (status >= 500) return new LifeApiError("polar", status, "Polar is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("polar", 400, "Polar didn't understand those dates");
  if (status === 404) return new LifeApiError("polar", 404, "Polar has nothing for that");
  return new LifeApiError("polar", status, `Polar refused that (${status})`);
}

// ---------- Sign-in ----------

/** The code swapped at Polar's token endpoint (Basic auth). Polar answers with x_user_id and no refresh token. */
export async function polarToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens & { x_user_id?: number }> {
  if (params.grant_type !== "authorization_code") throw new LifeApiError("polar", 401, "Sign in again", true);
  const basic = Buffer.from(`${client.client_id}:${client.client_secret ?? ""}`).toString("base64");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(POLAR_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json;charset=UTF-8", Authorization: `Basic ${basic}` },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError("polar", 503, "Couldn't reach Polar to finish signing in");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && typeof body?.access_token === "string") {
      return {
        access_token: body.access_token,
        token_type: typeof body.token_type === "string" ? body.token_type : undefined,
        expires_in: Number(body.expires_in) || undefined,
        x_user_id: Number(body.x_user_id) || undefined,
      };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    if (res.status >= 500) throw new LifeApiError("polar", res.status, "Polar is having trouble right now. Try again in a few minutes.");
    const code = typeof body?.error === "string" ? body.error : "";
    if (res.status === 401 || code === "invalid_client" || code === "unauthorized_client") {
      throw new LifeApiError("polar", 401, "Polar refused Athena's app. Check the Client ID and Secret under Edit, then sign in again.", true);
    }
    throw new LifeApiError("polar", 400, "Sign in again", true);
  }
}

const TOKEN: TokenEndpoint = { service: "polar", url: POLAR_TOKEN_URL, label: "Polar", request: polarToken };

/** The writes Athena sends: register, open a transaction, commit it. Anything else is refused before it leaves. */
const WRITES: Array<[string, RegExp]> = [
  ["POST", /^\/users$/],
  ["POST", /^\/users\/\d+\/(?:exercise|activity)-transactions$/],
  ["PUT", /^\/users\/\d+\/(?:exercise|activity)-transactions\/\d+$/],
];

/** POST or PUT to AccessLink with the bearer token. 429, 5xx and dropped connections are retried. */
async function send(token: string, method: "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  if (!WRITES.some(([m, re]) => m === method && re.test(path))) throw new Error("Athena only registers with Polar and reads from it");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${POLAR_API_URL}${path}`, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new LifeApiError("polar", 503, "Couldn't reach Polar");
    }
    const parsed: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      await sleep(lifeRetryWaits.ms[attempt]);
      continue;
    }
    return { status: res.status, body: parsed };
  }
}

/** Register the owner with Athena's client: AccessLink serves nothing before this. 409 is "already registered". */
export async function registerPolarUser(token: string, userId: number): Promise<void> {
  const { status } = await send(token, "POST", "/users", { "member-id": `athena-${userId}` });
  if (status === 200 || status === 201 || status === 409) return;
  throw refused(status);
}

// ---------- Reading ----------

export interface PolarContext {
  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  /** A GET that answers undefined for "nothing that day" (204 or 404). */
  maybe<T>(path: string): Promise<T | undefined>;
  write(method: "POST" | "PUT", path: string): Promise<{ status: number; body: unknown }>;
  /** A link Polar gave (a transaction's items): read only if it's on AccessLink. */
  follow<T>(url: string): Promise<T>;
  userId?: number;
  tz: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "PT2H44M45S", "PT45M", "PT3600.000S" → minutes. */
export function durationMinutes(iso: string | undefined): number | undefined {
  const m = (iso ?? "").match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.round(Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60);
}

const round = (n: number | undefined | null, places = 0): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : undefined);
const minutesOfSeconds = (s: number | undefined | null): number | undefined => (typeof s === "number" && s >= 0 ? Math.round(s / 60) : undefined);

interface Exercise {
  id?: string;
  start_time?: string;
  start_time_utc_offset?: number;
  duration?: string;
  calories?: number;
  distance?: number;
  heart_rate?: { average?: number; maximum?: number };
  training_load?: number;
  sport?: string;
  detailed_sport_info?: string;
}

/**
 * When an exercise started. start_time is the watch's local clock, with
 * start_time_utc_offset in minutes; a start_time that carries its own offset
 * is taken as written.
 */
export function exerciseStart(e: Exercise): number | undefined {
  const raw = e.start_time ?? "";
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const local = Date.parse(`${raw}Z`);
  if (!Number.isFinite(local)) return undefined;
  return local - (Number(e.start_time_utc_offset) || 0) * 60_000;
}

/** "ROAD_RUNNING" → "road running"; health-line reads it as a run. */
export const sportType = (e: Exercise): string => (e.detailed_sport_info || e.sport || "workout").replace(/_+/g, " ").trim().toLowerCase();

function exerciseShape(e: Exercise, tz: string) {
  const ms = exerciseStart(e);
  const at = ms === undefined ? undefined : when(ms, tz);
  return clean({
    date: at?.date,
    time: at?.time,
    type: sportType(e),
    minutes: durationMinutes(e.duration),
    distance_m: round(e.distance) || undefined,
    kcal: round(e.calories) || undefined,
    average_hr: round(e.heart_rate?.average) || undefined,
    max_hr: round(e.heart_rate?.maximum) || undefined,
    training_load: round(e.training_load, 1) || undefined,
  });
}

/** Exercises Polar has from the last 30 days, in the window, newest first. */
async function exercisesIn(ctx: PolarContext, w: { after?: number; before?: number }) {
  const list = await ctx.get<Exercise[]>("/exercises");
  return (Array.isArray(list) ? list : [])
    .map((e) => ({ e, ms: exerciseStart(e) }))
    .filter((x) => x.ms !== undefined && inWindow(x.ms, w))
    .sort((a, b) => b.ms! - a.ms!)
    .map((x) => exerciseShape(x.e, ctx.tz));
}

interface Activity {
  start_time?: string;
  active_duration?: string;
  calories?: number;
  active_calories?: number;
  steps?: number;
  distance_from_steps?: number;
  daily_activity?: number;
  samples?: { date?: string };
}

const activityDate = (a: Activity): string | undefined => {
  const d = a.samples?.date ?? a.start_time?.slice(0, 10);
  return d && DAY.test(d) ? d : undefined;
};

const activityShape = (a: Activity, date?: string) =>
  clean({
    date: date ?? activityDate(a),
    steps: round(a.steps),
    active_minutes: durationMinutes(a.active_duration),
    kcal: round(a.calories) || undefined,
    active_kcal: round(a.active_calories) || undefined,
    distance_from_steps_m: round(a.distance_from_steps) || undefined,
    goal_percent: round(a.daily_activity),
  });

interface Night {
  date?: string;
  sleep_start_time?: string;
  sleep_end_time?: string;
  light_sleep?: number;
  deep_sleep?: number;
  rem_sleep?: number;
  unrecognized_sleep_stage?: number;
  total_interruption_duration?: number;
  sleep_score?: number;
  sleep_charge?: number;
  continuity?: number;
}

interface Recharge {
  date?: string;
  heart_rate_avg?: number;
  heart_rate_variability_avg?: number;
  breathing_rate_avg?: number;
  nightly_recharge_status?: number;
  ans_charge?: number;
}

/** The local day a night ends on, else Polar's own date for it. */
function nightDate(n: Night, tz: string): string | undefined {
  const end = Date.parse(n.sleep_end_time ?? "");
  if (Number.isFinite(end)) return when(end, tz).date;
  return n.date && DAY.test(n.date) ? n.date : undefined;
}

/** Minutes asleep: light, deep, REM and unstaged sleep. Interruptions don't count. */
const asleep = (n: Night): number | undefined => {
  if ([n.light_sleep, n.deep_sleep, n.rem_sleep, n.unrecognized_sleep_stage].every((v) => typeof v !== "number")) return undefined;
  return minutesOfSeconds((n.light_sleep ?? 0) + (n.deep_sleep ?? 0) + (n.rem_sleep ?? 0) + (n.unrecognized_sleep_stage ?? 0));
};

function nightShape(n: Night, tz: string, r?: Recharge) {
  const start = Date.parse(n.sleep_start_time ?? "");
  const end = Date.parse(n.sleep_end_time ?? "");
  return clean({
    date: nightDate(n, tz),
    total_minutes: asleep(n),
    deep_minutes: minutesOfSeconds(n.deep_sleep),
    rem_minutes: minutesOfSeconds(n.rem_sleep),
    light_minutes: minutesOfSeconds(n.light_sleep),
    interrupted_minutes: minutesOfSeconds(n.total_interruption_duration),
    score: round(n.sleep_score),
    sleep_charge: round(n.sleep_charge),
    continuity: round(n.continuity, 1),
    bedtime: Number.isFinite(start) ? when(start, tz).time : undefined,
    wake_time: Number.isFinite(end) ? when(end, tz).time : undefined,
    recharge_status: round(r?.nightly_recharge_status),
    ans_charge: round(r?.ans_charge, 1),
    sleeping_hr: round(r?.heart_rate_avg),
    hrv_ms: round(r?.heart_rate_variability_avg),
    breathing_rate: round(r?.breathing_rate_avg, 1),
  });
}

async function nightsIn(ctx: PolarContext, days: { from: string; to: string }) {
  const [sleepBody, rechargeBody] = await Promise.all([ctx.get<{ nights?: Night[] }>("/users/sleep"), ctx.get<{ recharges?: Recharge[] }>("/users/nightly-recharge")]);
  const recharges = new Map((rechargeBody.recharges ?? []).filter((r) => r.date).map((r) => [r.date!, r]));
  return newestFirst(
    (sleepBody.nights ?? [])
      .map((n) => nightShape(n, ctx.tz, n.date ? recharges.get(n.date) : undefined))
      .filter((n) => n.date && n.date >= days.from && n.date <= days.to),
  );
}

/** Days of activity, at most 28 a request, newest first. */
async function activitiesIn(ctx: PolarContext, days: { from: string; to: string }) {
  const list = await ctx.get<Activity[]>("/users/activities", { from: days.from, to: days.to });
  return newestFirst((Array.isArray(list) ? list : []).map((a) => activityShape(a)).filter((a) => a.date && a.date >= days.from && a.date <= days.to));
}

/** Nightly Recharge as Polar rates it, 1 (very poor) to 6 (very good); anything else is left out. */
const rechargeStatus = (r: Recharge | undefined): number | undefined => {
  const n = r?.nightly_recharge_status;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 6 ? n : undefined;
};

/** Polar's night by stage: light is Apple's core, unrecognised is asleep with no stage, interruptions are awake; in bed runs from falling asleep to waking. */
function polarStages(n: Night) {
  const start = Date.parse(n.sleep_start_time ?? "");
  const end = Date.parse(n.sleep_end_time ?? "");
  return stagesOf({
    deep: minutesOfSeconds(n.deep_sleep),
    core: minutesOfSeconds(n.light_sleep),
    rem: minutesOfSeconds(n.rem_sleep),
    asleep_unspecified: minutesOfSeconds(n.unrecognized_sleep_stage),
    awake: minutesOfSeconds(n.total_interruption_duration),
    in_bed: Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60_000 : undefined,
  });
}

/** One local day in athena_health_day's shape, from the endpoints that can be read again. */
async function healthDay(ctx: PolarContext, args: Record<string, unknown>) {
  const date = arg.str(args, "date", { required: true })!;
  if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
  const [night, recharge, activity, exercises] = await Promise.all([
    ctx.maybe<Night>(`/users/sleep/${date}`),
    ctx.maybe<Recharge>(`/users/nightly-recharge/${date}`),
    ctx.maybe<Activity>(`/users/activities/${date}`),
    exercisesIn(ctx, windowOf({ date }, ctx.tz)),
  ]);
  const a = activity ? activityShape(activity, date) : undefined;
  return {
    ...clean({ date, source: "polar", sleep_minutes: night ? asleep(night) : undefined, sleep_stages: night ? polarStages(night) : undefined, recharge: rechargeStatus(recharge), steps: a?.steps, active_minutes: a?.active_minutes }),
    workouts: exercises
      .filter((e) => e.minutes)
      .reverse()
      .map((e) => clean({ type: e.type, minutes: e.minutes, distance_m: e.distance_m, kcal: e.kcal, start: e.time })),
  };
}

// ---------- The pull model: which days have new data ----------

type Kind = "exercise" | "activity";

/**
 * Open a transaction, read each item in it, and commit it once every item
 * was read. A failed read throws before the commit, so the transaction is
 * left to lapse and Polar offers the same items next time. Answers the
 * local days the items fall on.
 */
export async function pullTransaction(ctx: PolarContext, kind: Kind): Promise<{ days: string[]; committed: boolean; available: boolean }> {
  if (!ctx.userId) throw new LifeApiError("polar", 401, "Sign in again", true);
  const base = `/users/${ctx.userId}/${kind}-transactions`;
  const opened = await ctx.write("POST", base);
  if (opened.status === 204) return { days: [], committed: false, available: true };
  // Deprecated by Polar: if it's gone, say so rather than fail the run.
  if (opened.status === 404 || opened.status === 410) return { days: [], committed: false, available: false };
  if (opened.status !== 201 && opened.status !== 200) throw refused(opened.status);
  const id = Number((opened.body as { "transaction-id"?: unknown } | null)?.["transaction-id"]);
  if (!Number.isInteger(id) || id <= 0) throw new LifeApiError("polar", 502, "Polar is having trouble right now. Try again in a few minutes.");
  const list = await ctx.get<Record<string, unknown>>(`${base}/${id}`);
  const links = (list?.[kind === "exercise" ? "exercises" : "activity-log"] ?? []) as unknown[];
  const days = new Set<string>();
  for (const link of links) {
    if (typeof link !== "string") continue;
    const item = await ctx.follow<Record<string, unknown>>(link);
    if (kind === "exercise") {
      const ms = exerciseStart({ start_time: item["start-time"] as string | undefined, start_time_utc_offset: item["start-time-utc-offset"] as number | undefined });
      if (ms !== undefined) days.add(when(ms, ctx.tz).date);
    } else if (typeof item.date === "string" && DAY.test(item.date)) days.add(item.date);
  }
  const done = await ctx.write("PUT", `${base}/${id}`);
  if (done.status !== 200 && done.status !== 204) throw refused(done.status);
  return { days: [...days].sort(), committed: true, available: true };
}

async function changedDays(ctx: PolarContext) {
  const exercise = await pullTransaction(ctx, "exercise");
  const activity = await pullTransaction(ctx, "activity");
  const days = [...new Set([...exercise.days, ...activity.days])].sort();
  return withItems(days, {
    note: !exercise.available || !activity.available ? "Polar no longer offers new-data pulls. Read recent days with day_summary instead." : undefined,
  });
}

// ---------- Tools ----------

const LIMIT = { type: "integer", minimum: 1, maximum: 28, description: "At most this many days a page (default 7)." };
const windowed = { type: "object" as const, properties: { ...WINDOW_PROPS, limit: LIMIT, ...CURSOR_PROP } };
const RULE = "Health figures: pass them on only through athena_health_day, never into a note.";

export const POLAR_TOOLS: LifeTool<PolarContext>[] = [
  {
    name: "exercises",
    summary: "See your workouts",
    description: `Workouts from the last 30 days (Polar keeps no more here), newest first: local date and time, type (Polar's sport), minutes, distance_m, kcal, average_hr, max_hr and training_load. Default: the last 7 days. ${RULE}`,
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS } },
    annotations: readOnly,
    async run(ctx, args) {
      const w = windowOf(args, ctx.tz);
      return withItems(await exercisesIn(ctx, { after: w.after ?? Date.now() - 7 * 86_400_000, before: w.before }), {});
    },
  },
  {
    name: "daily_activity",
    summary: "See your steps and activity",
    description: `Activity per local day, newest first: steps, active_minutes, kcal, active_kcal, distance_from_steps_m and goal_percent. Up to a year back. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "polar:activity", arg.int(args, "limit", { min: 1, max: 28, fallback: 7 }));
      return withItems(await activitiesIn(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "sleep",
    summary: "See how you slept",
    description: `Sleep from the last 28 days, each night on the local day it ended, newest first: total_minutes asleep, deep/rem/light and interrupted minutes, score (1–100), sleep_charge (1–5), continuity (1–5), bedtime and wake_time, and Nightly Recharge: recharge_status (1–6), ans_charge, sleeping_hr, hrv_ms, breathing_rate. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "polar:sleep", arg.int(args, "limit", { min: 1, max: 28, fallback: 7 }));
      const oldest = addDays(when(Date.now(), ctx.tz).date, -28);
      return withItems(await nightsIn(ctx, days), { next_cursor: days.from > oldest ? next : undefined });
    },
  },
  {
    name: "day_summary",
    summary: "See one day's figures",
    description:
      'One local day in athena_health_day\'s shape: { date, source: "polar", sleep_minutes?, sleep_stages? { deep, core (light), rem, awake, asleep_unspecified, in_bed }, recharge? (Nightly Recharge, 1–6), steps?, active_minutes?, workouts: [{ type, minutes, distance_m?, kcal?, start? }] }. sleep_minutes is the night ending that morning. Pass it straight to athena_health_day. Safe to read again: it uses what Polar keeps for 28 to 30 days. Fields are left out when Polar has nothing.',
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    run: healthDay,
  },
  {
    name: "changed_days",
    summary: "See which days have new data",
    description:
      "The local days (YYYY-MM-DD) with workouts or activity Polar received since the last time this was asked, oldest first, such as a watch synced days late. Asking clears them from Polar's new-data list, so call day_summary for each day returned. Also call day_summary for the last 3 days every run, whatever this returns: it keeps working if Polar retires this. Figures aren't included.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
    run: changedDays,
  },
];

/** Open a signed-in account: one cheap read (today's activity), which proves the sign-in and the registration work. */
export async function openPolar(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("polar", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const opts = { service: "polar" as const, hosts: [HOST], refused, unreachable: "Couldn't reach Polar" };
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${POLAR_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    return session.get<T>(url.toString(), opts);
  };
  const maybe = async <T>(path: string): Promise<T | undefined> => {
    try {
      const body = await get<T>(path);
      return body && typeof body === "object" && Object.keys(body).length ? body : undefined;
    } catch (error) {
      if (error instanceof LifeApiError && error.status === 404) return undefined;
      throw error;
    }
  };
  const follow = <T>(link: string): Promise<T> => {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== HOST || !url.pathname.startsWith("/v3/users/")) throw new LifeApiError("polar", 502, "Polar is having trouble right now. Try again in a few minutes.");
    return session.get<T>(url.toString(), opts);
  };
  const write = async (method: "POST" | "PUT", path: string) => {
    const r = await send(await session.accessToken(), method, path);
    if (r.status === 401 || r.status === 403) throw refused(r.status);
    return r;
  };
  const zone = tz ?? (await ownerZone());
  const today = when(Date.now(), zone).date;
  await maybe(`/users/activities/${today}`);
  return account("polar", POLAR_TOOLS, { get, maybe, follow, write, userId: Number(secrets.tokens.x_user_id) || undefined, tz: zone });
}

/** Polar Flow's consent page. No PKCE (AccessLink doesn't take it). */
export function polarAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(POLAR_AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: "code", client_id: input.clientId, redirect_uri: input.redirectUri, scope: input.scope || POLAR_SCOPE, state: input.state }).toString();
  return url.toString();
}

/** Swap the code, then register the owner with Athena's client (AccessLink serves nothing before that). */
export async function exchangePolarCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await polarToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  if (!tokens.x_user_id) throw new LifeApiError("polar", 400, "Polar didn't say whose account this is. Sign in again", true);
  await registerPolarUser(tokens.access_token!, tokens.x_user_id);
  return { ...tokens, obtained_at: Date.now() };
}

export const polarAdapter: DirectAdapter = {
  id: "polar",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: polarRecent,
  handles: (c) => c.provider === "polar" && c.auth_type === "oauth",
  tools: () => POLAR_TOOLS,
  serverInfo: () => ({ website_url: "https://flow.polar.com/" }),
  open: (connector, secrets) => openPolar(connector, secrets),
  authorizationUrl: polarAuthorizationUrl,
  exchangeCode: exchangePolarCode,
  accountProblem: (e) => lifeAccountProblem("polar", e),
  failure: (e) => lifeFailure("polar", e),
};
