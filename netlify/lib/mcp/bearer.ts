/**
 * Shared bearer-token auth for Athena's Netlify Functions.
 *
 * Used by both netlify/functions/mcp.ts (the MCP server) and
 * netlify/functions/api.ts (the REST API for the PWA/dashboard). The master
 * token is a single static value, set as the MCP_BEARER_TOKEN environment
 * variable; API keys (lib/api-keys.ts) are the other way in, by scope. The
 * app signs in with a full key per device, not the master token.
 *
 * The ambient `Netlify` global (used below for `Netlify.env.get`) is typed by
 * `@netlify/serverless-functions-api`, pulled in transitively wherever
 * `@netlify/functions` is imported (mcp.ts and api.ts both import `Context`
 * from it) — no separate `@types` package or local ambient declaration needed.
 */
import { timingSafeEqual } from "node:crypto";
import { checkApiKey, type ApiKeyScope } from "../../../lib/api-keys";

export function checkBearer(req: Request): boolean {
  const expected = Netlify.env.get("MCP_BEARER_TOKEN");
  if (!expected) return false;
  const match = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The master token, or an API key (lib/api-keys.ts) whose scope covers `need`:
 * a full-access key works on /api/* and /mcp (but can't manage keys: that
 * route asks checkBearer), a capture key only for capturing, an mcp key only
 * where `need` is "mcp", which is /mcp alone. Async because keys live in the
 * database.
 */
export async function authorized(req: Request, need: ApiKeyScope = "full"): Promise<boolean> {
  return checkBearer(req) || !!(await checkApiKey(req, need));
}
