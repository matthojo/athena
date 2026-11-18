/**
 * Oura without MCP: a narrow, read-only adapter over the Oura API v2
 * (api.ouraring.com/v2/usercollection), registered in direct.ts.
 *
 * Sign-in: Oura marks personal access tokens deprecated (checked 7 Nov 2026),
 * so the owner makes their own OAuth app and signs in with `daily workout`
 * and PKCE. Oura takes the client in Basic auth. Refresh tokens are single
 * use: each renewal's new one is saved straight back sealed. Oura wants a
 * User-Agent on every request.
 *
 * Days are Oura's own `day`: a night's sleep belongs to the morning it ends.
 * end_date is sent a day late and results filtered to the asked days, so the
 * window is right whether Oura treats end_date as inclusive or not.
 *
 * Figures are health content (SECURITY.md §1): they go back to the run only,
 * never into an error or a log line.
 */
import { OURA_API_URL, OURA_SCOPE } from "../../../lib/presets/health";
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
  ownerZone,
  readOnly,
  tokenRequest,
  when,
  windowOf,
  withItems,
  type LifeTool,
  type TokenEndpoint,
} from "./lifelog-b-http";
import { zonedParts } from "../../../lib/dates";
import { ouraRecent } from "./activity-recent";

export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const USER_AGENT = "Athena/1.0 (personal, read-only)";

const TOKEN: TokenEndpoint = { service: "oura", url: OURA_TOKEN_URL, label: "Oura", headers: { "User-Agent": USER_AGENT } };

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("oura", 401, "Oura didn't accept the sign-in. Sign in again", true);
  if (status === 403) return new LifeApiError("oura", 403, "Oura stopped sharing your data. Check your Oura Membership is active, then sign in again.", true);
  if (status === 429) return new LifeApiError("oura", 429, "Oura is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("oura", status, "Oura is having trouble right now. Try again in a few minutes.");
  if (status === 400 || status === 422) return new LifeApiError("oura", status, "Oura didn't understand those dates");
  return new LifeApiError("oura", status, `Oura refused that (${status})`);
}

export interface OuraContext {
  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  tz: string;
}

// ---------- Days ----------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MAX_DAYS = 62;

/** The local days a window covers, first and last inclusive. No window: the last 7 days, today included. */
export function daysOf(args: Record<string, unknown>, tz: string): { from: string; to: string } {
  const w = windowOf(args, tz);
  const today = zonedParts(new Date(), tz).date;
  const to = w.before !== undefined ? zonedParts(new Date(w.before - 1), tz).date : today;
  const from = w.after !== undefined ? zonedParts(new Date(w.after), tz).date : addDays(to, -6);
  if (Date.parse(to) - Date.parse(from) > MAX_DAYS * 86_400_000) throw new ToolInputError(`Ask for ${MAX_DAYS} days or fewer at a time`);
  return { from, to };
}

interface Page<T> {
  data?: T[];
  next_token?: string | null;
}

/** Every document for the days, following next_token (at most 10 pages). */
async function collect<T extends { day?: string }>(ctx: OuraContext, path: string, days: { from: string; to: string }, fields?: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let n = 0; n < 10; n++) {
    const body = await ctx.get<Page<T>>(path, { start_date: days.from, end_date: addDays(days.to, 1), next_token: token, fields });
    for (const d of body.data ?? []) if (d.day && d.day >= days.from && d.day <= days.to) out.push(d);
    token = body.next_token || undefined;
    if (!token) break;
  }
  return out;
}

const min = (s: number | null | undefined): number | undefined => (typeof s === "number" && s >= 0 ? Math.round(s / 60) : undefined);
const num = (n: number | null | undefined, places = 0): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** places) / 10 ** places : undefined);
const clock = (iso: string | undefined, tz: string): string | undefined => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? when(ms, tz).time : undefined;
};

/** Days, newest first, paged by date (a cursor is the next page's last day). */
export function pageDays(args: Record<string, unknown>, tz: string, tag: string, limit: number) {
  const days = daysOf(args, tz);
  const to = decodeCursor<string>(tag, args.cursor) ?? days.to;
  if (!DAY.test(to)) throw new ToolInputError("cursor isn't one this tool gave");
  const from = Date.parse(days.from) > Date.parse(addDays(to, -(limit - 1))) ? days.from : addDays(to, -(limit - 1));
  const next = from > days.from ? encodeCursor(tag, addDays(from, -1)) : undefined;
  return { days: { from, to }, next };
}

export const newestFirst = <T extends { date?: unknown }>(items: T[]) => items.sort((a, b) => String(b.date).localeCompare(String(a.date)));

// ---------- Sleep ----------

interface SleepPeriod {
  day?: string;
  type?: string | null;
  total_sleep_duration?: number | null;
  time_in_bed?: number;
  efficiency?: number | null;
  deep_sleep_duration?: number | null;
  rem_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  awake_time?: number | null;
  lowest_heart_rate?: number | null;
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  bedtime_start?: string;
  bedtime_end?: string;
}

/** The night that day's figures come from: Oura's long_sleep (the longest, if two), else the longest confirmed sleep. */
function mainSleep(periods: SleepPeriod[]): SleepPeriod | undefined {
  const real = periods.filter((p) => p.type !== "deleted" && p.type !== "rest");
  const pool = real.some((p) => p.type === "long_sleep") ? real.filter((p) => p.type === "long_sleep") : real;
  return pool.sort((a, b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0];
}

async function sleepDays(ctx: OuraContext, days: { from: string; to: string }) {
  const [scores, periods] = await Promise.all([
    collect<{ day?: string; score?: number | null }>(ctx, "/usercollection/daily_sleep", days, "day,score"),
    collect<SleepPeriod>(ctx, "/usercollection/sleep", days),
  ]);
  const byDay = new Map<string, SleepPeriod[]>();
  for (const p of periods) byDay.set(p.day!, [...(byDay.get(p.day!) ?? []), p]);
  const all = new Set([...scores.map((s) => s.day!), ...byDay.keys()]);
  return newestFirst(
    [...all].map((day) => {
      const list = byDay.get(day) ?? [];
      const main = mainSleep(list);
      const naps = list.filter((p) => p !== main && (p.type === "sleep" || p.type === "late_nap"));
      return clean({
        date: day,
        score: num(scores.find((s) => s.day === day)?.score),
        total_minutes: min(main?.total_sleep_duration),
        in_bed_minutes: min(main?.time_in_bed),
        efficiency: num(main?.efficiency),
        deep_minutes: min(main?.deep_sleep_duration),
        rem_minutes: min(main?.rem_sleep_duration),
        light_minutes: min(main?.light_sleep_duration),
        awake_minutes: min(main?.awake_time),
        resting_hr: num(main?.lowest_heart_rate),
        average_hr: num(main?.average_heart_rate, 1),
        average_hrv: num(main?.average_hrv),
        bedtime: clock(main?.bedtime_start, ctx.tz),
        wake_time: clock(main?.bedtime_end, ctx.tz),
        naps: naps.length || undefined,
        nap_minutes: naps.length ? min(naps.reduce((s, p) => s + (p.total_sleep_duration ?? 0), 0)) : undefined,
      });
    }),
  );
}

// ---------- Readiness, activity, workouts ----------

interface Activity {
  day?: string;
  steps?: number;
  active_calories?: number;
  total_calories?: number;
  high_activity_time?: number;
  medium_activity_time?: number;
  low_activity_time?: number;
  score?: number | null;
  equivalent_walking_distance?: number;
}

const activeMinutes = (a: Activity | undefined): number | undefined =>
  a && (a.high_activity_time !== undefined || a.medium_activity_time !== undefined) ? Math.round(((a.high_activity_time ?? 0) + (a.medium_activity_time ?? 0)) / 60) : undefined;

async function activityDays(ctx: OuraContext, days: { from: string; to: string }) {
  const list = await collect<Activity>(ctx, "/usercollection/daily_activity", days, "day,steps,active_calories,total_calories,high_activity_time,medium_activity_time,low_activity_time,score,equivalent_walking_distance");
  return newestFirst(
    list.map((a) =>
      clean({
        date: a.day,
        steps: num(a.steps),
        active_calories: num(a.active_calories),
        total_calories: num(a.total_calories),
        active_minutes: activeMinutes(a),
        high_minutes: min(a.high_activity_time),
        medium_minutes: min(a.medium_activity_time),
        low_minutes: min(a.low_activity_time),
        walking_distance_m: num(a.equivalent_walking_distance),
        score: num(a.score),
      }),
    ),
  );
}

interface Workout {
  day?: string;
  activity?: string;
  calories?: number | null;
  distance?: number | null;
  start_datetime?: string;
  end_datetime?: string;
  intensity?: string;
  source?: string;
  label?: string | null;
}

const workoutMinutes = (w: Workout): number => {
  const ms = Date.parse(w.end_datetime ?? "") - Date.parse(w.start_datetime ?? "");
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
};
const workoutType = (w: Workout): string => (w.activity || "workout").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

async function workoutList(ctx: OuraContext, days: { from: string; to: string }) {
  const list = await collect<Workout>(ctx, "/usercollection/workout", days);
  return list
    .sort((a, b) => Date.parse(b.start_datetime ?? "") - Date.parse(a.start_datetime ?? ""))
    .map((w) =>
      clean({
        date: w.day,
        time: clock(w.start_datetime, ctx.tz),
        type: workoutType(w),
        label: w.label || undefined,
        minutes: workoutMinutes(w),
        distance_m: num(w.distance) || undefined,
        kcal: num(w.calories) || undefined,
        intensity: w.intensity,
        source: w.source,
      }),
    );
}

// ---------- Sessions and tags (food, drink and mind) ----------

interface Session {
  day?: string;
  start_datetime?: string;
  end_datetime?: string;
  type?: string;
  mood?: string | null;
}

/** Session types that count as mindful minutes: meditation and breathing. Naps, rest and body status don't. */
export const MINDFUL_SESSIONS = ["meditation", "breathing"];

const spanMinutes = (a?: string, b?: string): number => {
  const ms = Date.parse(b ?? "") - Date.parse(a ?? "");
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 0;
};

interface EnhancedTag {
  tag_type_code?: string | null;
  custom_name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  start_day?: string;
  end_day?: string | null;
  comment?: string | null;
}

/**
 * What a tag counts as, only when Oura's code says so plainly: a coffee or
 * caffeine tag is one cup (lib/health-line.ts MG_PER_COFFEE), an alcohol tag
 * one drink. Custom tags, "no caffeine", "no alcohol" and anything else count
 * as nothing (their own names are the owner's words, never guessed at).
 */
export function tagKind(t: Pick<EnhancedTag, "tag_type_code">): "caffeine" | "alcohol" | null {
  const code = (t.tag_type_code ?? "").toLowerCase();
  // Oura doesn't publish its codes (checked 7 Nov 2026): the code's last word decides, and any "no"/"free"/"less" word rules it out.
  if (!code || code === "custom" || /(^|_)(no|non|free|less|without|avoid\w*|skip\w*)(_|$)/.test(code)) return null;
  if (/(^|_)(caffeine|coffee|espresso)$/.test(code)) return "caffeine";
  if (/(^|_)(alcohol|beer|wine|spirits)$/.test(code)) return "alcohol";
  return null;
}
const MG_PER_COFFEE = 95;

/** A 403 from sessions or tags means the sign-in predates those permissions. */
function scopeMissing(what: string): LifeApiError {
  return new LifeApiError("oura", 403, `Oura hasn't shared your ${what} with Athena. Sign in to Oura again and allow ${what}.`, true);
}
const isRefused = (e: unknown) => e instanceof LifeApiError && e.status === 403;

async function sessionList(ctx: OuraContext, days: { from: string; to: string }) {
  const list = await collect<Session>(ctx, "/usercollection/session", days);
  return list
    .sort((a, b) => Date.parse(b.start_datetime ?? "") - Date.parse(a.start_datetime ?? ""))
    .map((x) => clean({ date: x.day, time: clock(x.start_datetime, ctx.tz), type: x.type, minutes: spanMinutes(x.start_datetime, x.end_datetime), mindful: MINDFUL_SESSIONS.includes(x.type ?? "") || undefined, mood: x.mood || undefined }));
}

async function tagList(ctx: OuraContext, days: { from: string; to: string }) {
  const out: EnhancedTag[] = [];
  let token: string | undefined;
  for (let n = 0; n < 10; n++) {
    const body = await ctx.get<Page<EnhancedTag>>("/usercollection/enhanced_tag", { start_date: days.from, end_date: addDays(days.to, 1), next_token: token });
    for (const t of body.data ?? []) if (t.start_day && t.start_day >= days.from && t.start_day <= days.to) out.push(t);
    token = body.next_token || undefined;
    if (!token) break;
  }
  return out
    .sort((a, b) => Date.parse(b.start_time ?? "") - Date.parse(a.start_time ?? ""))
    .map((t) => clean({ date: t.start_day, time: clock(t.start_time ?? undefined, ctx.tz), code: t.tag_type_code || undefined, name: t.custom_name || undefined, counts_as: tagKind(t) ?? undefined }));
}

/** The day's food, drink and mind figures from sessions and tags. A sign-in without those permissions gives none, not an error. */
async function foodAndMind(ctx: OuraContext, date: string): Promise<Record<string, unknown>> {
  const days = { from: date, to: date };
  const [sessions, tags] = await Promise.all([sessionList(ctx, days).catch((e) => (isRefused(e) ? null : Promise.reject(e))), tagList(ctx, days).catch((e) => (isRefused(e) ? null : Promise.reject(e)))]);
  const mindful = sessions?.filter((x) => x.mindful).reduce((n, x) => n + (x.minutes as number), 0);
  const cups = (tags ?? []).filter((t) => t.counts_as === "caffeine");
  const drinks = (tags ?? []).filter((t) => t.counts_as === "alcohol").length;
  const times = cups.map((t) => t.time as string | undefined).filter((x): x is string => !!x).sort();
  return clean({
    mindful_minutes: mindful || undefined,
    caffeine_mg: cups.length ? cups.length * MG_PER_COFFEE : undefined,
    caffeine_last: cups.length ? times.pop() : undefined,
    caffeine_after_14_mg: cups.length ? cups.filter((t) => typeof t.time === "string" && Number((t.time as string).slice(0, 2)) >= 14).length * MG_PER_COFFEE : undefined,
    alcohol_drinks: drinks || undefined,
  });
}

const LIMIT = { type: "integer", minimum: 1, maximum: 31, description: "At most this many days a page (default 7)." };
const windowed = { type: "object" as const, properties: { ...WINDOW_PROPS, limit: LIMIT, ...CURSOR_PROP } };
const RULE = "Health figures: pass them on only through athena_health_day, never into a note.";

export const OURA_TOOLS: LifeTool<OuraContext>[] = [
  {
    name: "daily_sleep",
    summary: "See how you slept",
    description: `Sleep per local day, newest first. A night belongs to the morning it ends. score (0–100), total_minutes asleep, in_bed_minutes, efficiency (%), deep/rem/light/awake minutes, resting_hr (lowest), average_hr, average_hrv, bedtime and wake_time (local), naps and nap_minutes. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:sleep", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      return withItems(await sleepDays(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "daily_readiness",
    summary: "See your readiness",
    description: `Readiness per local day, newest first: score (0–100) and temperature_deviation (°C from your baseline). Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:readiness", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      const list = await collect<{ day?: string; score?: number | null; temperature_deviation?: number | null }>(ctx, "/usercollection/daily_readiness", days, "day,score,temperature_deviation");
      return withItems(newestFirst(list.map((r) => clean({ date: r.day, score: num(r.score), temperature_deviation: num(r.temperature_deviation, 2) }))), { next_cursor: next });
    },
  },
  {
    name: "daily_activity",
    summary: "See your steps and activity",
    description: `Activity per local day, newest first: steps, active_calories, total_calories, active_minutes (medium plus high), high/medium/low minutes, walking_distance_m and score. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:activity", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      return withItems(await activityDays(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "workouts",
    summary: "See your workouts",
    description: `Workouts Oura logged or detected, newest first: date, local start time, type, label, minutes, distance_m, kcal, intensity, source (manual, autodetected, confirmed, workout_heart_rate). Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:workouts", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      return withItems(await workoutList(ctx, days), { next_cursor: next });
    },
  },
  {
    name: "sessions",
    summary: "See your meditation and breathing sessions",
    description: `Sessions from the Oura app, newest first: date, local start time, type (meditation, breathing, relaxation, nap, rest, body_status), minutes, mindful (true for meditation and breathing: these are mindful minutes) and mood. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:sessions", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      try {
        return withItems(await sessionList(ctx, days), { next_cursor: next });
      } catch (e) {
        throw isRefused(e) ? scopeMissing("sessions") : e;
      }
    },
  },
  {
    name: "tags",
    summary: "See your tags",
    description: `Tags you added in the Oura app, newest first: date, local time, code (Oura's tag type), name (a custom tag's own name) and counts_as: "caffeine" (one coffee) or "alcohol" (one drink), only when Oura's code says so. Default: the last 7 days. ${RULE}`,
    inputSchema: windowed,
    annotations: readOnly,
    async run(ctx, args) {
      const { days, next } = pageDays(args, ctx.tz, "oura:tags", arg.int(args, "limit", { min: 1, max: 31, fallback: 7 }));
      try {
        return withItems(await tagList(ctx, days), { next_cursor: next });
      } catch (e) {
        throw isRefused(e) ? scopeMissing("tags") : e;
      }
    },
  },
  {
    name: "day_summary",
    summary: "See one day's figures",
    description:
      'One local day in athena_health_day\'s shape: { date, source: "oura", sleep_minutes?, sleep_stages? { deep, core (light), rem, awake, in_bed }, steps?, active_minutes?, resting_hr?, mindful_minutes?, caffeine_mg?, caffeine_last?, caffeine_after_14_mg?, alcohol_drinks?, workouts: [{ type, minutes, distance_m?, kcal?, start? }] }. Mindful minutes are meditation and breathing sessions; caffeine and drinks come from coffee and alcohol tags (one cup is 95 mg). sleep_minutes is the night ending that morning. Pass it straight to athena_health_day. Fields are left out when Oura has nothing (ring not worn).',
    inputSchema: { type: "object", properties: { date: { type: "string", description: "The local day, YYYY-MM-DD." } }, required: ["date"] },
    annotations: readOnly,
    async run(ctx, args) {
      const date = arg.str(args, "date", { required: true })!;
      if (!DAY.test(date)) throw new ToolInputError("date must be YYYY-MM-DD");
      const days = { from: date, to: date };
      const [sleep, activity, workouts, extra] = await Promise.all([sleepDays(ctx, days), activityDays(ctx, days), workoutList(ctx, days), foodAndMind(ctx, date)]);
      return {
        ...clean({
          date,
          source: "oura",
          sleep_minutes: sleep[0]?.total_minutes,
          sleep_stages: stagesOf({ deep: sleep[0]?.deep_minutes, core: sleep[0]?.light_minutes, rem: sleep[0]?.rem_minutes, awake: sleep[0]?.awake_minutes, in_bed: sleep[0]?.in_bed_minutes }),
          steps: activity[0]?.steps,
          active_minutes: activity[0]?.active_minutes,
          resting_hr: sleep[0]?.resting_hr,
          ...extra,
        }),
        workouts: workouts.reverse().map((w) => clean({ type: w.type, minutes: w.minutes, distance_m: w.distance_m, kcal: w.kcal, start: w.time })),
      };
    },
  },
];

/** Open a signed-in account: one cheap read (today's readiness score), which proves the sign-in works. */
export async function openOura(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("oura", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${OURA_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    return session.get<T>(url.toString(), { service: "oura", hosts: ["api.ouraring.com"], headers: { "User-Agent": USER_AGENT }, refused, unreachable: "Couldn't reach Oura" });
  };
  const zone = tz ?? (await ownerZone());
  const today = zonedParts(new Date(), zone).date;
  await get("/usercollection/daily_readiness", { start_date: today, end_date: addDays(today, 1), fields: "day" });
  return account("oura", OURA_TOOLS, { get, tz: zone });
}

export function ouraAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(OURA_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    // An account saved before sessions and tags keeps its old scope: signing in again asks for these too.
    scope: [...new Set([...(input.scope || "").split(/\s+/), ...OURA_SCOPE.split(" ")].filter(Boolean))].join(" "),
    state: input.state,
    code_challenge_method: "S256",
    code_challenge: input.challenge,
  }).toString();
  return url.toString();
}

export async function exchangeOuraCode(input: { code: string; redirectUri: string; verifier: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await tokenRequest(TOKEN, input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier });
  if (!tokens.refresh_token) throw new LifeApiError("oura", 400, "Oura gave Athena no way to renew this sign-in", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const ouraAdapter: DirectAdapter = {
  id: "oura",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: ouraRecent,
  handles: (c) => c.provider === "oura" && c.auth_type === "oauth",
  tools: () => OURA_TOOLS,
  serverInfo: () => ({ website_url: "https://ouraring.com/" }),
  open: (connector, secrets) => openOura(connector, secrets),
  authorizationUrl: ouraAuthorizationUrl,
  exchangeCode: exchangeOuraCode,
  accountProblem: (e) => lifeAccountProblem("oura", e),
  failure: (e) => lifeFailure("oura", e),
};
