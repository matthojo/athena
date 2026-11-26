/**
 * What every route on the server shares: the bearer check, the rate limiter
 * (Netlify Server has no `rateLimit` setting, so the limits the old
 * assistant.ts and talk.ts functions declared are counted here), and `warm`,
 * a place to keep clients and caches for the life of an instance.
 *
 * A request is counted against the credential it's signed in with (the
 * master token, or one API key), so a key's limit is the same from every
 * network and one key can't use up another's. A request with no credential
 * Athena knows is counted by address instead (an IPv6 address by its /64),
 * in one bucket for the whole server.
 */
import { onShutdown } from "@netlify/server";
import { authorized, credentialOf, signedInAs, type Credential } from "../lib/mcp/bearer";

// netlify/lib/mcp/bearer.ts reads its secret through the `Netlify` global that
// functions get. Where the server runtime doesn't set one, read process.env.
const g = globalThis as { Netlify?: unknown };
g.Netlify ??= {
  env: {
    get: (key: string) => process.env[key],
    has: (key: string) => key in process.env,
    toObject: () => ({ ...process.env }),
  },
};

// lib/ai.ts onServer(): Ask's time caps that only existed for the function limit are longer here.
process.env.ATHENA_RUNTIME = "server";

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** The same check /api/* makes (master token or a full API key). Null when allowed, else the 401 to return. */
export async function requireAuth(req: Request): Promise<Response | null> {
  return (await authorized(req)) ? null : jsonResponse({ error: "Unauthorized" }, 401);
}

/** The same check, as the credential that passed it (master token or a full API key), or null. */
export const fullCredential = (req: Request): Promise<Credential | null> => credentialOf(req, "full");

/** True for the master token or a full key: what /api/* asks for. */
export const isFull = (who: Credential | null): boolean => who?.scope === "master" || who?.scope === "full";

// ---------- rate limiter ----------

const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

/** Requests a minute from one address (an IPv6 /64) that carry no credential Athena knows, across the whole server. */
export const ANON_LIMIT = 30;

/**
 * At most `limit` requests a minute for `key`. Null when allowed, else the
 * 429. The count lives in this instance's memory: config.scale.max is 1, so
 * there is one count.
 */
export function rateLimit(key: string, limit: number, now = Date.now()): Response | null {
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) windows.set(key, (w = { start: now, count: 0 }));
  w.count += 1;
  if (w.count <= limit) return null;
  const retry = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  return jsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(retry) });
}

/**
 * What an address is counted as: an IPv4 address as it is (also when written
 * as IPv6, ::ffff:a.b.c.d), an IPv6 address by its first 64 bits, since one
 * home or phone is usually given a whole /64. Pure.
 */
export function ipBucket(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!v.includes(":")) return v;
  const [head, tail] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

/** The key a request is counted under in `area`: its credential's, or its address's (one for every area) when it has none. Pure. */
export function limitKey(area: string, who: Pick<Credential, "id"> | null, ip: string): string {
  return who ? `${area}:${who.id}` : `anon:${ipBucket(ip)}`;
}

/**
 * Count a request before any other work: against `limit` a minute for its
 * credential in `area`, or ANON_LIMIT for its address when it carries none.
 * Says who it's signed in as, whatever the key's scope: the route, or
 * /api/*'s dispatcher, still checks the scope it needs.
 */
export async function countRequest(req: Request, area: string, limit: number, ip: string): Promise<{ who: Credential | null; limited: Response | null }> {
  const who = await signedInAs(req).catch(() => null);
  return { who, limited: rateLimit(limitKey(area, who, ip), who ? limit : ANON_LIMIT) };
}

// ---------- daily caps ----------

const days = new Map<string, { day: string; count: number }>();

/**
 * At most `limit` a day (UTC) for `key`; false once it's spent. In this
 * instance's memory like the minute counts: config.scale.max is 1, so it's
 * the only count, and a restart starts the day's count again.
 */
export function dailyCap(key: string, limit: number, now = Date.now()): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  let d = days.get(key);
  if (!d || d.day !== day) days.set(key, (d = { day, count: 0 }));
  d.count += 1;
  return d.count <= limit;
}

/** Drop finished minute windows and past days' counts. */
export function pruneCounts(now = Date.now()): number {
  for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
  const today = new Date(now).toISOString().slice(0, 10);
  for (const [k, d] of days) if (d.day !== today) days.delete(k);
  return windows.size + days.size;
}

// Every 30 s rather than on a request, so no request pays for it. Unref'd: it never keeps the process up.
setInterval(() => pruneCounts(), 30_000).unref?.();

// ---------- warm registry ----------

const warmed = new Map<string, { value: unknown; close?: (value: never) => unknown }>();

/**
 * Get-or-create by key: the first call runs `create` and keeps what it
 * returns for the life of this instance; later calls get the same value.
 * `close` runs at shutdown, once requests in progress have drained. A value
 * is a cache, never the source of truth: an instance stops after 5 idle
 * minutes and at 8 hours. If `create` returns a promise that rejects, the key
 * is forgotten so the next call tries again.
 */
export function warm<T>(key: string, create: () => T, close?: (value: Awaited<T>) => unknown): T {
  const hit = warmed.get(key);
  if (hit) return hit.value as T;
  const value = create();
  warmed.set(key, { value, close: close as (value: never) => unknown });
  if (value instanceof Promise) value.catch(() => warmed.get(key)?.value === value && warmed.delete(key));
  return value;
}

onShutdown(async ({ drained }) => {
  await drained;
  const entries = [...warmed.values()];
  warmed.clear();
  await Promise.all(
    entries.map(async ({ value, close }) => {
      if (!close) return;
      try {
        await close((await value) as never);
      } catch (error) {
        console.warn("Athena server: closing a warm value failed:", error instanceof Error ? error.message : error);
      }
    }),
  );
});
