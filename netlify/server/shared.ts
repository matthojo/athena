/**
 * What every route on the server shares: the bearer check, the per-IP rate
 * limiter (Netlify Server has no `rateLimit` setting, so the limits the old
 * assistant.ts and talk.ts functions declared are counted here), and `warm`,
 * a place to keep clients and caches for the life of an instance.
 * See docs/netlify-server.md.
 */
import { onShutdown } from "@netlify/server";
import { authorized } from "../lib/mcp/bearer";

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

// ---------- rate limiter ----------

const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

/**
 * At most `limit` requests a minute for `key` (area + IP), counted before any
 * other work, as the platform rule did. Null when allowed, else the 429.
 * The count lives in this instance's memory: config.scale.max is 1, so there
 * is one count.
 */
export function rateLimit(key: string, limit: number, now = Date.now()): Response | null {
  if (windows.size > 5000) for (const [k, w] of windows) if (now - w.start >= WINDOW_MS) windows.delete(k);
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) windows.set(key, (w = { start: now, count: 0 }));
  w.count += 1;
  if (w.count <= limit) return null;
  const retry = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  return jsonResponse({ error: "Too many requests" }, 429, { "Retry-After": String(retry) });
}

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
