/**
 * /api/live/* — the live channel, behind the same auth as /api/*.
 * GET /api/live/events is a Server-Sent Events stream that says which kinds
 * of thing changed (live/hub.ts, live/watch.ts); the app then pulls through
 * its usual sync. GET /api/live/ping says where the server ran.
 */
import { onShutdown, type Context } from "@netlify/server";
import { qRaw } from "../../../lib/db";
import { createHub, type Hub } from "../live/hub";
import { readChanges, readWatermarks } from "../live/watch";
import { ANON_LIMIT, fullCredential, jsonResponse, limitKey, rateLimit } from "../shared";

let hub: Hub | undefined;
const liveHub = () => (hub ??= createHub({ read: () => readWatermarks(qRaw), changes: (prev, next) => readChanges(qRaw, prev, next) }));

// End the streams as shutdown starts (not after requests drain: they are the requests), so the app reconnects to the next instance.
onShutdown(() => hub?.closeAll());

const started = Date.now();

/** The region part of the database host (e.g. "us-east-2"), never the rest of the connection string. */
function databaseRegion(): string | null {
  try {
    return new URL(process.env.NETLIFY_DB_URL ?? "").hostname.match(/\.([a-z]{2}-[a-z]+-\d)\./)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function handleLive(req: Request, context: Context): Promise<Response> {
  const who = await fullCredential(req);
  if (!who) return rateLimit(limitKey("live", null, context.ip), ANON_LIMIT) ?? jsonResponse({ error: "Unauthorized" }, 401);
  const { pathname } = new URL(req.url);
  if (pathname === "/api/live/ping") {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    return jsonResponse({
      ok: true,
      region: context.server?.region ?? null,
      node: process.version,
      uptimeMs: Date.now() - started,
      dbRegion: databaseRegion(),
      dbDriver: process.env.NETLIFY_DB_DRIVER ?? null,
    });
  }
  if (pathname === "/api/live/events") {
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const limited = rateLimit(limitKey("live", who, context.ip), 30);
    if (limited) return limited;
    // Each open stream is one of the instance's concurrent requests; Ask and Talk need the rest.
    return liveHub().open(req.signal) ?? jsonResponse({ error: "Too many live connections" }, 503, { "Retry-After": "30" });
  }
  return jsonResponse({ error: "Not found" }, 404);
}
