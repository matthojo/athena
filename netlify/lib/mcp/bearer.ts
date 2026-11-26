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
import { apiKeyOf, checkApiKey, type ApiKeyScope } from "../../../lib/api-keys";

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
 * Who a request is signed in as: the master token, or one API key. `id` is
 * "master" or "key:<the key's id>", what per-credential limits count by.
 */
export interface Credential {
  id: string;
  scope: ApiKeyScope | "master";
}

/**
 * The master token, or an API key (lib/api-keys.ts) whose scope covers `need`:
 * a full-access key works on /api/* and /mcp (but can't manage keys: that
 * route asks checkBearer), a capture key only for capturing, an mcp key only
 * where `need` is "mcp", which is /mcp alone. Null otherwise. Async because
 * keys live in the database. Records the key's use.
 */
export async function credentialOf(req: Request, need: ApiKeyScope = "full"): Promise<Credential | null> {
  if (checkBearer(req)) return { id: "master", scope: "master" };
  const key = await checkApiKey(req, need);
  return key ? { id: `key:${key.id}`, scope: key.scope } : null;
}

/** The credential a request carries, whatever its scope, without recording a use: for counting, not for letting in. */
export async function signedInAs(req: Request): Promise<Credential | null> {
  if (checkBearer(req)) return { id: "master", scope: "master" };
  const key = await apiKeyOf(req);
  return key ? { id: `key:${key.id}`, scope: key.scope } : null;
}

/** credentialOf, as a yes or no. */
export async function authorized(req: Request, need: ApiKeyScope = "full"): Promise<boolean> {
  return !!(await credentialOf(req, need));
}
