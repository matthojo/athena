/**
 * AI spend: what every model call cost, a daily budget for all of
 * Athena, and an optional cap for each assistant:
 *
 *  - The gateway reports tokens, not money, so a call's cost is its tokens times the published prices
 *    (lib/model-prices.ts), kept in dollars in `ai_usage` with the owner's day it fell on.
 *  - At the budget everything stops until midnight in the owner's zone, Ask included. An assistant past its own
 *    cap stops; the rest carries on. It's checked before each call (checkBudget); a call already started finishes.
 *    Jev's injection check alone may go a little past both (GUARD_HEADROOM_USD), so spending can't switch it off.
 *  - The owner reads and sets money in their own currency (Profile → Region), dollars when it names none.
 *
 * Every call says what it was for through an AsyncLocalStorage scope set where work starts (withSpendScope): Ask's
 * routes, team runs and chats, and scheduled jobs. With no scope, a call is background work.
 *
 * lib/ai.ts calls the hook this file registers (useSpendHook) before and after each createMessage and
 * streamMessage. Code that reaches a model another way records its own use (recordUsage): lib/voice.ts, lib/jev.ts
 * and netlify/lib/connectors/runner.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { useSpendHook } from "./ai";
import { claimReminder, getOwnerTimeZone, qRaw, releaseReminder } from "./db";
import { DEFAULT_TZ, isValidTimeZone, zonedToday, zonedToInstant } from "./dates";
import { loadRate, loadRates, rateFrom, type Rate } from "./fx";
import { picturePrice, providerOf, tokenCost, type PricedProvider, type TokenUsage } from "./model-prices";
import {
  allowStep,
  budgetReplyText,
  budgetState,
  MAX_BUDGET,
  money,
  NEAR_AT,
  overLimits,
  SPEND_AREAS,
  type AssistantCap,
  type BudgetNotice,
  type BudgetState,
  type SpendArea,
  type SpendLine,
  type SpendView,
  type UncheckedNotice,
} from "./spend-types";

export type { BudgetNotice, SpendView } from "./spend-types";
export { GUARD_HEADROOM_USD } from "./spend-types";

// ---------- what a call is for ----------

export interface SpendScope {
  area: SpendArea;
  /** The Team assistant the work is for. Its cap counts everything under its id, pictures included. */
  assistantId?: string | null;
  /** The background job ("briefing", "collect", "routine"): kept with the row for the record. */
  job?: string | null;
  /** Run anyway: this one Ask message goes ahead when today's spend can't be read. */
  runAnyway?: boolean;
}

const scopes = new AsyncLocalStorage<SpendScope>();

/** Run `fn` with every model call inside it counted as `scope`. */
export function withSpendScope<T>(scope: SpendScope, fn: () => T): T {
  // Run anyway covers the whole message, so an assistant it hands to inside the same message keeps it.
  const runAnyway = scope.runAnyway ?? scopes.getStore()?.runAnyway ?? false;
  return scopes.run({ area: scope.area, assistantId: scope.assistantId ?? null, job: scope.job ?? null, ...(runAnyway ? { runAnyway } : {}) }, fn);
}

/** The current scope; background work when none was set. */
export function spendScope(): SpendScope {
  return scopes.getStore() ?? { area: "background", assistantId: null, job: null };
}

// ---------- the budget ----------

export const BUDGET_KEY = "ai_budget";

/** The `ai_budget` settings row. Amounts are in `currency`, the currency they were set in. */
export interface BudgetRow {
  daily: number | null;
  currency: string;
  /** Each assistant's own cap, by id. */
  assistants: Record<string, number>;
  /** "Allow more" for one day only: on top of the daily budget, and on top of each assistant's cap. */
  extra?: { day: string; all: number; assistants: Record<string, number> };
}

const EMPTY: BudgetRow = { daily: null, currency: "USD", assistants: {} };

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_BUDGET;

export function readBudget(value: unknown): BudgetRow {
  const v = value as Partial<BudgetRow> | null;
  if (!v || typeof v !== "object") return { ...EMPTY, assistants: {} };
  const assistants: Record<string, number> = {};
  for (const [id, cap] of Object.entries(v.assistants ?? {})) if (positive(cap)) assistants[id] = cap;
  const extra = v.extra && typeof v.extra.day === "string" ? { day: v.extra.day, all: positive(v.extra.all) ? v.extra.all : 0, assistants: Object.fromEntries(Object.entries(v.extra.assistants ?? {}).filter(([, n]) => positive(n))) } : undefined;
  return { daily: positive(v.daily) ? v.daily : null, currency: typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? v.currency : "USD", assistants, ...(extra ? { extra } : {}) };
}

/** True when nothing is limited: no daily budget and no caps. Then checks cost nothing. */
const unlimited = (b: BudgetRow) => b.daily === null && !Object.keys(b.assistants).length;

interface Config {
  budget: BudgetRow;
  tz: string;
  at: number;
}
let config: Config | null = null;
/** The owner's zone as last read: a call kept for later still falls on the owner's day. */
let lastTz = DEFAULT_TZ;
/** The budget as last read, kept when the database goes away: a budget known to be set is never skipped. */
let lastKnown: BudgetRow | null = null;
/** A budget change on another instance reaches this one within this long. */
const CONFIG_MS = 10_000;

/** Tests, and every change made here, read the row again. `all` also forgets the last budget known (a fresh instance). */
export function forgetBudget(all = false): void {
  config = null;
  if (all) lastKnown = null;
}

async function loadConfig(now = Date.now()): Promise<Config> {
  if (config && now - config.at < CONFIG_MS) return config;
  const rows = await qRaw<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key IN ($1, 'timezone')`, [BUDGET_KEY]);
  const tzValue = rows.find((r) => r.key === "timezone")?.value;
  config = { budget: readBudget(rows.find((r) => r.key === BUDGET_KEY)?.value), tz: isValidTimeZone(tzValue) ? tzValue : DEFAULT_TZ, at: now };
  lastKnown = config.budget;
  lastTz = config.tz;
  return config;
}

async function saveBudget(b: BudgetRow): Promise<void> {
  await qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [BUDGET_KEY, JSON.stringify(b)]);
  forgetBudget();
}

/** Today's limits in dollars, with what "Allow more" added. Null for one that isn't set. */
function limitsUsd(b: BudgetRow, day: string, rate: number, assistantId?: string | null): { all: number | null; mine: number | null } {
  const extra = b.extra?.day === day ? b.extra : undefined;
  const all = b.daily === null ? null : (b.daily + (extra?.all ?? 0)) / rate;
  const cap = assistantId ? b.assistants[assistantId] : undefined;
  const mine = cap === undefined ? null : (cap + (extra?.assistants[assistantId!] ?? 0)) / rate;
  return { all, mine };
}

/** The next midnight in the owner's zone after `now`. */
export function nextMidnight(now: Date, tz: string): Date {
  const today = zonedToday(now, tz);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return zonedToInstant(tomorrow, "00:00", tz);
}

/**
 * Thrown before a model call when a budget is known to be set but today's spend can't be read (the database is
 * away): the call isn't made, so nothing runs past a budget Athena can't see. Ask's reply offers Run anyway for that
 * one message (mintRunAnyway); assistant runs and background work wait and try again at their next pass.
 */
export class BudgetUnchecked extends Error {
  readonly code = "budget_unchecked";
  constructor() {
    super("Athena couldn't check today's AI budget, so it didn't run that. Try again in a minute.");
    this.name = "BudgetUnchecked";
  }
}

// ---------- Run anyway ----------

/**
 * Run anyway: when Ask can't check today's budget, its reply carries a one-time token. The app
 * sends the same message again with it (`run_anyway`), and that one message runs without the check. A token is
 * honoured once and for RUN_ANYWAY_MS. It's signed, so another instance knows it; each instance remembers the tokens
 * it has taken until they expire. It only skips a check that can't be made: once today's spend can be read again, the
 * budget applies as usual.
 */
export const RUN_ANYWAY_MS = 15 * 60_000;
const taken = new Map<string, number>();
let localKey: Buffer | null = null;

function runAnywayKey(): Buffer {
  const env = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get("MCP_BEARER_TOKEN") ?? process.env.MCP_BEARER_TOKEN;
  if (env) return createHmac("sha256", env).update("athena run anyway v1").digest();
  // No token on this site (a local run): a key for this process only.
  return (localKey ??= randomBytes(32));
}

const runAnywayMac = (body: string) => createHmac("sha256", runAnywayKey()).update(body).digest("base64url");

/** A token that lets one Ask message run without the budget check. */
export function mintRunAnyway(now = Date.now()): string {
  const body = `${(now + RUN_ANYWAY_MS).toString(36)}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${runAnywayMac(body)}`;
}

/** True once for a token mintRunAnyway made that hasn't expired; false for anything else, and every time after. */
export function takeRunAnyway(token: unknown, now = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 200) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, mac] = parts;
  const want = Buffer.from(runAnywayMac(`${exp}.${nonce}`));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  const until = parseInt(exp, 36);
  if (!Number.isFinite(until) || until < now || until > now + RUN_ANYWAY_MS) return false;
  for (const [n, t] of taken) if (t < now) taken.delete(n);
  if (taken.has(nonce)) return false;
  taken.set(nonce, until);
  return true;
}

/** Thrown before a model call once today's budget, or the assistant's own cap, is used. The message is the owner's. */
export class BudgetReached extends Error {
  readonly code = "budget_reached";
  constructor(readonly notice: BudgetNotice) {
    super(budgetReplyText(notice));
    this.name = "BudgetReached";
  }
}

export interface SpendDeps {
  now?: Date;
  fetch?: typeof fetch;
  /** Where the budget's pushes go; lib/push.ts sendToAll when not given (a test's stand-in). */
  send?: (payload: { title: string; body: string; url: string; tag?: string }) => Promise<unknown>;
}

/** The currency the owner reads money in, from their Region; dollars when it names none. */
export interface Display {
  currency: string;
  locale: string;
}

async function display(): Promise<Display> {
  // lib/profile.ts reads (and opens) the owner's profile, so it's loaded only when money is shown.
  const { loadOwnerRegion } = await import("./profile");
  const region = await loadOwnerRegion().catch(() => null);
  return { currency: region?.currency ?? "USD", locale: region?.language ?? "en-GB" };
}

/** The display currency, falling back to dollars when Athena has no rate for it yet. */
async function displayWithRate(deps: SpendDeps, fetchIfDue: boolean): Promise<{ shown: Display; rate: Rate; missing: boolean }> {
  const wanted = await display();
  const rate = fetchIfDue ? await loadRate(wanted.currency, deps) : rateFrom(await loadRates({ ...deps, noFetch: true }), wanted.currency, deps.now ?? new Date());
  if (rate) return { shown: wanted, rate, missing: false };
  return { shown: { currency: "USD", locale: wanted.locale }, rate: { currency: "USD", value: 1, as_of: new Date().toISOString(), stale: false }, missing: wanted.currency !== "USD" };
}

/** The budget's own rate: units of its currency to $1. */
async function budgetRate(b: BudgetRow, deps: SpendDeps): Promise<number> {
  if (b.currency === "USD") return 1;
  return rateFrom(await loadRates({ ...deps, noFetch: true }), b.currency, deps.now ?? new Date())?.value ?? 1;
}

/** Spent today in dollars: all of Athena, and one assistant. */
async function spentToday(day: string, assistantId?: string | null): Promise<{ all: number; mine: number }> {
  const [row] = await qRaw<{ all: string | number; mine: string | number }>(
    `SELECT coalesce(sum(usd), 0) AS all, coalesce(sum(usd) FILTER (WHERE assistant_id = $2::uuid), 0) AS mine FROM ai_usage WHERE day = $1::date`,
    [day, assistantId ?? null],
  );
  return { all: Number(row?.all ?? 0), mine: Number(row?.mine ?? 0) };
}

async function assistantName(id: string): Promise<string | null> {
  try {
    const { getAssistant } = await import("./team");
    return (await getAssistant(id))?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Before a model call: throws BudgetReached when today's budget is used, or the scope's assistant has used its own
 * cap. Costs one cached settings read when nothing is limited. When today's spend can't be read and a budget is known
 * to be set, throws BudgetUnchecked, unless the scope is Run anyway: then the call goes ahead and its cost is kept
 * until the database is back. Calls kept from earlier are written first, and count until they are.
 * `headroom`: dollars a call may still go past each limit (Jev's injection check, GUARD_HEADROOM_USD).
 */
export async function checkBudget(scope: SpendScope = spendScope(), deps: SpendDeps = {}, opts: { headroom?: number } = {}): Promise<void> {
  const now = deps.now ?? new Date();
  let cfg: Config;
  let spent: { all: number; mine: number };
  let limits: { all: number | null; mine: number | null };
  let day: string;
  try {
    cfg = await loadConfig(now.getTime());
    if (pending.length) await flushPending(cfg, now, deps).catch((e) => warn("record", "calls kept for later still couldn't be written", e));
    if (unlimited(cfg.budget)) return;
    day = zonedToday(now, cfg.tz);
    limits = limitsUsd(cfg.budget, day, await budgetRate(cfg.budget, deps), scope.assistantId);
    if (limits.all === null && limits.mine === null) return;
    spent = await spentToday(day, scope.assistantId);
    // Calls kept for later count until they're written.
    const held = pendingOn(day, scope.assistantId);
    spent = { all: spent.all + held.all, mine: spent.mine + held.mine };
  } catch (error) {
    if (scope.runAnyway) {
      warn("anyway", "the budget couldn't be checked; the owner chose Run anyway for this message", error);
      return;
    }
    // A budget known to be set is kept to: the call waits until Athena can see today's spend again. With none known
    // (a new instance that has never read the database), the call goes ahead; it needs the database anyway.
    if (lastKnown && !unlimited(lastKnown)) {
      warn("check", "the budget couldn't be checked, so the call wasn't made", error);
      throw new BudgetUnchecked();
    }
    warn("check", "the budget couldn't be checked and none is known, so the call goes ahead", error);
    return;
  }
  const { all: overAll, mine: overMine } = overLimits(spent, limits, opts.headroom ?? 0);
  if (!overAll && !overMine) return;
  const { shown, rate } = await displayWithRate(deps, false).catch(() => ({ shown: { currency: "USD", locale: "en-GB" }, rate: { value: 1 } as Rate }));
  const step = allowStep(rate.value);
  const resets = nextMidnight(now, cfg.tz).toISOString();
  if (overAll) throw new BudgetReached({ scope: "all", currency: shown.currency, locale: shown.locale, limit: round2(limits.all! * rate.value), step, resets_at: resets });
  throw new BudgetReached({ scope: "assistant", assistant_id: scope.assistantId!, name: await assistantName(scope.assistantId!), currency: shown.currency, locale: shown.locale, limit: round2(limits.mine! * rate.value), step, resets_at: resets });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A problem said once per kind every ten minutes: a database that's down mustn't fill the log at every call. */
const warned = new Map<string, number>();
function warn(kind: string, line: string, error: unknown): void {
  const last = warned.get(kind) ?? 0;
  if (Date.now() - last < 600_000) return;
  warned.set(kind, Date.now());
  console.warn(`Athena spend: ${line}:`, error instanceof Error ? error.message : error);
}

// ---------- recording ----------

export interface UsageInput {
  /** Inferred from the model id when not given. */
  provider?: PricedProvider;
  model: string;
  usage?: TokenUsage | null;
  /** Pictures made by the call, priced per picture. */
  images?: number;
  /** Who it was for; the current scope when not given. */
  scope?: SpendScope;
}

export interface RecordedUsage {
  usd: number;
  estimated: boolean;
  day: string;
}

/**
 * Keep what a model call cost. Never throws: a row that can't be written is kept in memory and written once the
 * database answers again (at the next call, check or retry, oldest first). Once a budget is set, it also sends the
 * day's push at 80% and at the budget, once each.
 */
export async function recordUsage(input: UsageInput, deps: SpendDeps = {}): Promise<RecordedUsage | null> {
  const now = deps.now ?? new Date();
  const scope = input.scope ?? spendScope();
  const provider = input.provider ?? providerOf(input.model);
  const tokens = tokenCost(provider, input.model, input.usage ?? {});
  const pictures = input.images ? picturePrice(provider, input.model) : null;
  const usd = tokens.price + (pictures ? pictures.price * input.images! : 0);
  const estimated = (tokens.estimated && hasTokens(input.usage)) || !!pictures?.estimated;
  const u = input.usage ?? {};
  const row = (day: string): PendingRow => ({
    day,
    usd,
    assistantId: scope.assistantId ?? null,
    params: [now.toISOString(), day, scope.area, scope.assistantId ?? null, scope.job ?? null, provider, input.model.slice(0, 200), int(u.input_tokens), int(u.output_tokens), int(u.cache_read_input_tokens), int(u.cache_creation_input_tokens), int(u.audio_input_tokens), input.images ?? 0, usd, estimated],
  });
  let day = zonedToday(now, lastTz);
  try {
    const cfg = await loadConfig(now.getTime());
    day = zonedToday(now, cfg.tz);
    const flushed = pending.length ? await flushPending(null, now, deps) : 0;
    await insertUsage(row(day).params);
    if (cfg.budget.daily !== null) await tellOwner(cfg, day, usd + flushed, now, deps).catch((e) => warn("push", "the budget push failed", e));
    return { usd, estimated, day };
  } catch (error) {
    keepForLater(row(day));
    warn("record", "a model call's cost couldn't be written yet; it's kept and written when the database answers", error);
    return null;
  }
}

const INSERT_USAGE = `INSERT INTO ai_usage (at, day, area, assistant_id, job, provider, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, audio_tokens, images, usd, estimated)
  VALUES ($1, $2::date, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;
const insertUsage = (params: unknown[]) => qRaw(INSERT_USAGE, params).then(() => undefined);

// ---------- calls kept for later ----------

/** A call whose row couldn't be written: kept here, oldest first, until the database answers. */
interface PendingRow {
  day: string;
  usd: number;
  assistantId: string | null;
  params: unknown[];
}
const pending: PendingRow[] = [];
/** Past this many waiting rows the oldest is dropped, and the log says what it cost. */
const MAX_PENDING = 5_000;
const RETRY_FIRST_MS = 30_000;
const RETRY_MOST_MS = 5 * 60_000;
let retryMs = RETRY_FIRST_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<number> | null = null;

function keepForLater(row: PendingRow): void {
  pending.push(row);
  if (pending.length > MAX_PENDING) {
    const lost = pending.shift()!;
    console.error(`Athena spend: ${MAX_PENDING} calls are waiting to be written, so the oldest ($${lost.usd.toFixed(4)} on ${lost.day}) was dropped.`);
  }
  scheduleRetry();
}

function scheduleRetry(): void {
  if (retryTimer || !pending.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushPending(null, new Date(), {})
      .then(() => {
        retryMs = RETRY_FIRST_MS;
      })
      .catch(() => {
        retryMs = Math.min(retryMs * 2, RETRY_MOST_MS);
      })
      .finally(scheduleRetry);
  }, retryMs);
  // A waiting retry never keeps a function alive; the next call or check writes them too.
  (retryTimer as { unref?: () => void }).unref?.();
}

/** What's waiting to be written for `day`: all of Athena, and one assistant. It counts toward the budget meanwhile. */
function pendingOn(day: string, assistantId?: string | null): { all: number; mine: number } {
  let all = 0;
  let mine = 0;
  for (const r of pending) {
    if (r.day !== day) continue;
    all += r.usd;
    if (assistantId && r.assistantId === assistantId) mine += r.usd;
  }
  return { all, mine };
}

/**
 * Write the calls kept for later, oldest first, each dropped from memory once it's written. Returns what was written
 * for today, in dollars. With `cfg`, the day's pushes are sent for it (recordUsage sends them itself, with its call).
 */
async function flushPending(cfg: Config | null, now: Date, deps: SpendDeps): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    const today = zonedToday(now, cfg?.tz ?? lastTz);
    let added = 0;
    while (pending.length) {
      const r = pending[0];
      await insertUsage(r.params);
      pending.shift();
      if (r.day === today) added += r.usd;
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryMs = RETRY_FIRST_MS;
    if (cfg && added && cfg.budget.daily !== null) await tellOwner(cfg, today, added, now, deps).catch((e) => warn("push", "the budget push failed", e));
    return added;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** For tests: how many calls are waiting to be written, and what they cost in dollars. */
export function pendingUsage(): { count: number; usd: number } {
  return { count: pending.length, usd: pending.reduce((s, r) => s + r.usd, 0) };
}

/** For tests: write what's waiting now. Throws while the database is away. */
export const flushPendingUsage = (deps: SpendDeps = {}): Promise<number> => flushPending(null, deps.now ?? new Date(), deps);

const int = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const hasTokens = (u: TokenUsage | null | undefined) => !!u && Object.values(u).some((v) => typeof v === "number" && v > 0);

/** The pushes: one at 80% of today's budget and one at the budget, each once a day, outside quiet hours. */
async function tellOwner(cfg: Config, day: string, added: number, now: Date, deps: SpendDeps): Promise<void> {
  const rate = await budgetRate(cfg.budget, deps);
  const { all: limit } = limitsUsd(cfg.budget, day, rate);
  if (limit === null) return;
  const { all: spent } = await spentToday(day);
  const before = spent - added;
  const crossed = spent >= limit && before < limit ? "cap" : spent >= limit * NEAR_AT && before < limit * NEAR_AT ? "near" : null;
  if (!crossed) return;
  const push = await import("./push");
  if (!deps.send && !(await push.pushConfigured())) return;
  const { inQuietHours } = await import("./nudges");
  const prefs = await push.loadNotificationPrefs();
  if (inQuietHours(now, cfg.tz, prefs.quiet)) return;
  const key = `spend:${crossed}:${day}`;
  if (!(await claimReminder(key))) return;
  const { shown, rate: r } = await displayWithRate(deps, false);
  const m = (usd: number) => money(round2(usd * r.value), shown.currency, shown.locale);
  const payload =
    crossed === "cap"
      ? { title: "Today's AI budget is used", body: `${m(limit)} of ${m(limit)}. Athena has stopped until midnight. Open AI spend to allow more.`, url: "/#/settings/spend", tag: "spend" }
      : { title: "80% of today's AI budget used", body: `${m(spent)} of ${m(limit)}. Athena stops at ${m(limit)} until midnight.`, url: "/#/settings/spend", tag: "spend" };
  try {
    await (deps.send ?? push.sendToAll)(payload);
  } catch (error) {
    await releaseReminder(key);
    throw error;
  }
}

// ---------- what the owner sees ----------

interface UsageGroup {
  day: string;
  area: SpendArea;
  assistant_id: string | null;
  usd: string | number;
  estimated: boolean;
}

/** The days from `first` to `last`, inclusive, as YYYY-MM-DD. */
function daysFrom(last: string, count: number): string[] {
  const [y, m, d] = last.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1, d - (count - 1 - i))).toISOString().slice(0, 10));
}

/** The split, in a fixed order: Ask, each assistant by spend, background work, pictures. Lines with nothing are left out, except Ask. */
function linesOf(groups: UsageGroup[], rate: number, names: Map<string, string>): SpendLine[] {
  const by = new Map<string, SpendLine>();
  for (const g of groups) {
    const key = g.area === "assistant" ? `assistant:${g.assistant_id ?? ""}` : g.area;
    const line = by.get(key) ?? { area: g.area, ...(g.area === "assistant" ? { assistant_id: g.assistant_id ?? undefined, name: g.assistant_id ? names.get(g.assistant_id) ?? null : null } : {}), spent: 0, estimated: false };
    line.spent += Number(g.usd) * rate;
    line.estimated ||= g.estimated;
    by.set(key, line);
  }
  const all = [...by.values()].map((l) => ({ ...l, spent: round4(l.spent) }));
  const order = (l: SpendLine) => SPEND_AREAS.indexOf(l.area);
  return all.sort((a, b) => order(a) - order(b) || b.spent - a.spent);
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** GET /api/spend: today, the last 7 days, the budget and each assistant's cap, in the owner's currency. */
export async function spendView(deps: SpendDeps = {}): Promise<SpendView> {
  const now = deps.now ?? new Date();
  forgetBudget();
  const cfg = await loadConfig(now.getTime());
  const today = zonedToday(now, cfg.tz);
  const days = daysFrom(today, 7);
  const [{ shown, rate, missing }, groups, models, team] = await Promise.all([
    displayWithRate(deps, true),
    qRaw<UsageGroup>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, CASE WHEN area = 'assistant' AND assistant_id IS NULL THEN 'background' ELSE area END AS area, assistant_id, sum(usd) AS usd, bool_or(estimated) AS estimated
         FROM ai_usage WHERE day BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3`,
      [days[0], today],
    ),
    qRaw<{ provider: string; model: string }>(`SELECT DISTINCT provider, model FROM ai_usage WHERE estimated AND day BETWEEN $1::date AND $2::date ORDER BY model LIMIT 20`, [days[0], today]),
    import("./team").then((t) => t.listAssistants()).catch(() => []),
  ]);
  const names = new Map(team.map((a) => [a.id, a.name]));
  // Money is kept in the budget's own currency; it's shown in the owner's.
  const bRate = await budgetRate(cfg.budget, deps);
  const toShown = (amount: number) => round2((amount / bRate) * rate.value);
  const b = cfg.budget;
  const extra = b.extra?.day === today ? b.extra : undefined;
  const todayGroups = groups.filter((g) => g.day === today);
  const todayLines = linesOf(todayGroups, rate.value, names);
  const spent = round4(todayLines.reduce((s, l) => s + l.spent, 0));
  const daily = b.daily === null ? null : toShown(b.daily);
  const extraShown = extra ? toShown(extra.all) : 0;
  const limit = daily === null ? null : round2(daily + extraShown);
  const mine = (id: string) => round4(todayGroups.filter((g) => g.assistant_id === id).reduce((s, g) => s + Number(g.usd) * rate.value, 0));
  const assistants: AssistantCap[] = team.map((a) => {
    const cap = b.assistants[a.id] === undefined ? null : toShown(b.assistants[a.id]);
    const more = extra?.assistants[a.id] ? toShown(extra.assistants[a.id]) : 0;
    const s = mine(a.id);
    return { assistant_id: a.id, name: a.name, spent: s, cap, extra: more, state: budgetState(s, cap === null ? null : cap + more) };
  });
  return {
    currency: shown.currency,
    locale: shown.locale,
    rate: shown.currency === "USD" ? null : { value: rate.value, as_of: rate.as_of, stale: rate.stale },
    rate_missing: missing,
    today: { day: today, spent, estimated: todayLines.some((l) => l.estimated), lines: todayLines },
    week: {
      days: days.map((day) => {
        const g = groups.filter((x) => x.day === day);
        return { day, spent: round4(g.reduce((s, x) => s + Number(x.usd) * rate.value, 0)), estimated: g.some((x) => x.estimated) };
      }),
      spent: round4(groups.reduce((s, x) => s + Number(x.usd) * rate.value, 0)),
      lines: linesOf(groups, rate.value, names),
    },
    budget: { daily, extra: extraShown, limit, state: budgetState(spent, limit), resets_at: nextMidnight(now, cfg.tz).toISOString(), step: allowStep(rate.value) },
    assistants,
    estimated_models: models.map((m) => m.model),
  };
}

export class SpendInputError extends Error {
  readonly status = 400;
}

/** A budget amount from the app: a positive number up to MAX_BUDGET, null to clear, or an error in the owner's words. */
function amount(v: unknown, what: string): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_BUDGET) return Math.round(v * 100) / 100;
  throw new SpendInputError(`${what} needs to be an amount above zero, or left empty for none.`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/spend/budget: amounts in the owner's currency. A budget can only be set in a currency Athena has a rate
 * for (dollars always), so the budget can always be checked.
 */
export async function setBudget(body: unknown, deps: SpendDeps = {}): Promise<SpendView> {
  const patch = (body ?? {}) as { daily?: unknown; assistants?: unknown };
  if (typeof patch !== "object" || (patch.daily === undefined && patch.assistants === undefined)) throw new SpendInputError("Send a daily budget, or an assistant's cap.");
  const { shown, missing } = await displayWithRate(deps, true);
  if (missing) throw new SpendInputError("Athena couldn't get today's exchange rate for your currency. Try again in a minute.");
  forgetBudget();
  const cfg = await loadConfig((deps.now ?? new Date()).getTime());
  const was = cfg.budget;
  // Amounts already kept in another currency (the Region changed) move into the owner's current one.
  const fromRate = await budgetRate(was, deps);
  const toRate = (await loadRate(shown.currency, deps))?.value ?? 1;
  const move = (n: number) => (was.currency === shown.currency ? n : round2((n / fromRate) * toRate));
  const next: BudgetRow = {
    daily: was.daily === null ? null : move(was.daily),
    currency: shown.currency,
    assistants: Object.fromEntries(Object.entries(was.assistants).map(([id, n]) => [id, move(n)])),
    ...(was.extra ? { extra: { day: was.extra.day, all: move(was.extra.all), assistants: Object.fromEntries(Object.entries(was.extra.assistants).map(([id, n]) => [id, move(n)])) } } : {}),
  };
  if (patch.daily !== undefined) next.daily = amount(patch.daily, "The daily budget");
  if (patch.assistants !== undefined) {
    if (!patch.assistants || typeof patch.assistants !== "object") throw new SpendInputError("Send each assistant's cap by its id.");
    for (const [id, v] of Object.entries(patch.assistants as Record<string, unknown>)) {
      if (!UUID.test(id)) throw new SpendInputError("That assistant isn't known.");
      const cap = amount(v, "A cap");
      if (cap === null) delete next.assistants[id];
      else next.assistants[id] = cap;
    }
  }
  await saveBudget(next);
  return spendView(deps);
}

/** POST /api/spend/allow-more: today only, one step more for all of Athena, or for one assistant's cap. */
export async function allowMore(body: unknown, deps: SpendDeps = {}): Promise<SpendView> {
  const id = (body as { assistant_id?: unknown } | null)?.assistant_id;
  if (id !== undefined && (typeof id !== "string" || !UUID.test(id))) throw new SpendInputError("That assistant isn't known.");
  const now = deps.now ?? new Date();
  forgetBudget();
  const cfg = await loadConfig(now.getTime());
  const b = cfg.budget;
  if (id ? b.assistants[id] === undefined : b.daily === null) throw new SpendInputError(id ? "That assistant has no cap of its own." : "There's no daily budget to raise.");
  const day = zonedToday(now, cfg.tz);
  const step = allowStep(b.currency === "USD" ? 1 : await budgetRate(b, deps));
  const extra = b.extra?.day === day ? { ...b.extra, assistants: { ...b.extra.assistants } } : { day, all: 0, assistants: {} as Record<string, number> };
  if (id) extra.assistants[id] = (extra.assistants[id] ?? 0) + step;
  else extra.all += step;
  await saveBudget({ ...b, extra });
  return spendView(deps);
}

/** Ask's reply when the budget stopped it: its words, and the notice block with "Allow more". */
export function budgetReply(error: BudgetReached): { text: string; sources: []; related: []; searched: string; skipped: []; found: true; flagged: false; budget: BudgetNotice } {
  return { text: error.message, sources: [], related: [], searched: "", skipped: [], found: true, flagged: false, budget: error.notice };
}

/** Ask's words when today's budget couldn't be checked. */
export const UNCHECKED_REPLY = "I couldn't check today's AI budget just now, so I haven't answered this yet.";

/** Ask's reply when today's budget couldn't be checked: its words, and the notice block with Run anyway. */
export function uncheckedReply(now = Date.now()): { text: string; sources: []; related: []; searched: string; skipped: []; found: true; flagged: false; budget: UncheckedNotice } {
  return { text: UNCHECKED_REPLY, sources: [], related: [], searched: "", skipped: [], found: true, flagged: false, budget: { scope: "unchecked", run_anyway: mintRunAnyway(now) } };
}

/** Turn a BudgetReached or BudgetUnchecked into Ask's reply; anything else goes on up. */
export function replyIfBudget<T>(error: unknown): T {
  if (error instanceof BudgetReached) return budgetReply(error) as unknown as T;
  if (error instanceof BudgetUnchecked) return uncheckedReply() as unknown as T;
  throw error;
}

/** Today's budget couldn't be checked (BudgetUnchecked, here or as a code that came back from elsewhere). */
export const isBudgetUnchecked = (error: unknown): boolean => error instanceof BudgetUnchecked || (error as { code?: unknown } | null)?.code === "budget_unchecked";

/** How a stopped run or call reads in a log or a run's error line. */
export const isBudgetReached = (error: unknown): error is BudgetReached => error instanceof BudgetReached || (error as { code?: unknown } | null)?.code === "budget_reached";

// ---------- the hook in lib/ai.ts ----------

useSpendHook({
  before: () => checkBudget(),
  after: (model, usage) => recordUsage({ model, usage }).then(() => undefined),
});

/** For tests: today's day in the owner's zone. */
export async function ownerDay(now = new Date()): Promise<string> {
  return zonedToday(now, await getOwnerTimeZone());
}

export type { BudgetState };
