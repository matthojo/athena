/**
 * What the Life log's direct adapters share (Trakt, YouTube, Letterboxd,
 * Goodreads; registered in direct.ts):
 *  - one tool contract: `after` / `before` (a day in the owner's time zone or
 *    an exact time), `limit` and `page_token`, answered with compact JSON:
 *    titles, creators, the local day and time, a link, a `count` and a
 *    `next_page_token` when there's more;
 *  - one error type, ServiceError, that says whether the owner has to act
 *    (needs_auth) or it will pass (error), in plain English;
 *  - GET-only requests with a timeout, retries for 429 and 5xx, and a cap on
 *    how much of a reply is read.
 *
 * Nothing here logs a token, a URL with an account name in it, or a reply.
 */
import { zonedParts, zonedToInstant, DEFAULT_TZ, isValidTimeZone } from "../../../lib/dates";
import { ToolInputError, arg } from "./google-api";
import type { DirectAccount, DirectToolInfo } from "./direct";

export type LifeService = "trakt" | "youtube" | "letterboxd" | "goodreads";

const REQUEST_TIMEOUT_MS = 20_000;
/** Waits before each retry of a 429, a 5xx or a dropped connection. Tests shorten them. */
export const lifeRetryWaits = { ms: [700, 2000], maxRetryAfterMs: 5_000 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A service turned Athena down. `message` is for the owner; `needsOwner` means only they can fix it. */
export class ServiceError extends Error {
  constructor(
    readonly service: LifeService,
    readonly status: number,
    message: string,
    readonly needsOwner = false,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The adapter's failure(): needs_auth when the owner has a step to take, error otherwise. Null when it's another service's. */
export function serviceFailure(service: LifeService, error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  if (!(error instanceof ServiceError) || error.service !== service) return null;
  return { status: error.needsOwner ? "needs_auth" : "error", detail: error.message };
}

export const serviceAccountProblem = (service: LifeService) => (error: unknown) => error instanceof ServiceError && error.service === service && error.needsOwner;

// ---------- requests ----------

export interface FetchedText {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * One GET, retried on 429 (honouring Retry-After, within reason), 5xx and
 * dropped connections. Reads at most `maxBytes`. Redirects are handed back,
 * not followed, so the caller decides where it may go.
 */
export async function getText(service: LifeService, url: string, headers: Record<string, string>, opts: { maxBytes?: number; unreachable: string; busy: string }): Promise<FetchedText> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await sleep(lifeRetryWaits.ms[attempt]);
        continue;
      }
      throw new ServiceError(service, 503, opts.unreachable);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < lifeRetryWaits.ms.length) {
      const seconds = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, lifeRetryWaits.maxRetryAfterMs) : lifeRetryWaits.ms[attempt]);
      continue;
    }
    if (res.status === 429) throw new ServiceError(service, 429, opts.busy);
    if (res.status >= 500) throw new ServiceError(service, res.status, opts.unreachable);
    return { status: res.status, headers: res.headers, text: await readCapped(res, opts.maxBytes ?? 2_000_000) };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---------- the window ----------

export interface Window {
  /** Inclusive, ms. */
  after?: number;
  /** Exclusive, ms. */
  before?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-06" is that day's start in the owner's time zone; anything with a time is that instant. */
function bound(value: string | undefined, key: string, tz: string): number | undefined {
  if (value === undefined) return undefined;
  if (DAY.test(value)) return zonedToInstant(value, "00:00", tz).getTime();
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new ToolInputError(`${key} must be a date (YYYY-MM-DD) or a time (ISO 8601)`);
  return at;
}

export function windowArgs(args: Record<string, unknown>, tz: string): Window {
  const w = { after: bound(arg.str(args, "after", { max: 40 }), "after", tz), before: bound(arg.str(args, "before", { max: 40 }), "before", tz) };
  if (w.after !== undefined && w.before !== undefined && w.after >= w.before) throw new ToolInputError("after must be earlier than before");
  return w;
}

export const inWindow = (at: number, w: Window) => (w.after === undefined || at >= w.after) && (w.before === undefined || at < w.before);

/** Older than the window: a newest-first listing can stop here. */
export const beforeWindow = (at: number, w: Window) => w.after !== undefined && at < w.after;

/** An instant as the owner's day and time: { day: "2026-11-06", time: "21:14" }. */
export function local(at: number | string | undefined, tz: string): { day?: string; time?: string } {
  const ms = typeof at === "string" ? Date.parse(at) : at;
  if (ms === undefined || Number.isNaN(ms)) return {};
  const p = zonedParts(new Date(ms), tz);
  return { day: p.date, time: p.time };
}

export const safeZone = (tz: string | undefined) => (tz && isValidTimeZone(tz) ? tz : DEFAULT_TZ);

// ---------- the tool contract ----------

const WINDOW_PROPS = {
  after: { type: "string", description: "Only items on or after this: a day (YYYY-MM-DD, the owner's time zone) or an ISO 8601 time." },
  before: { type: "string", description: "Only items before this (exclusive): a day (YYYY-MM-DD) or an ISO 8601 time." },
  limit: { type: "integer", description: "Items per page, 1 to 50 (default 25)." },
  page_token: { type: "string", description: "next_page_token from the previous answer, for the next page." },
};

export function windowSchema(extra: Record<string, unknown> = {}, required?: string[]): DirectToolInfo["inputSchema"] {
  return { type: "object", properties: { ...extra, ...WINDOW_PROPS }, ...(required ? { required } : {}) };
}

export const limitArg = (args: Record<string, unknown>) => arg.int(args, "limit", { min: 1, max: 50, fallback: 25 });

/** An offset page token ("25"), as the feeds use. */
export function offsetArg(args: Record<string, unknown>): number {
  const t = arg.str(args, "page_token", { max: 12 });
  if (t === undefined) return 0;
  if (!/^\d+$/.test(t)) throw new ToolInputError("page_token isn't one Athena gave");
  return Number(t);
}

export interface LifeTool<C> extends DirectToolInfo {
  run(ctx: C, args: Record<string, unknown>): Promise<unknown>;
}

/** Drop empty fields so the JSON stays short. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out as Partial<T>;
}

/** An open account over a set of tools: input errors and one-off refusals go back to Claude; account problems are thrown. */
export function lifeAccount<C>(tools: LifeTool<C>[], ctx: C, accountProblem: (e: unknown) => boolean): DirectAccount {
  return {
    tools: tools.map(({ run: _run, ...info }) => info),
    async call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { text: `${name} isn't one of this account's tools`, isError: true };
      try {
        return { text: JSON.stringify(await tool.run(ctx, args ?? {})), isError: false };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        if (error instanceof ServiceError && !accountProblem(error) && !error.retryable) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

export const READ_ONLY = { readOnlyHint: true } as const;
