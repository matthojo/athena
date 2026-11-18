/**
 * API keys: credentials the owner makes in the app (Settings → API keys) so
 * a client never needs the master token (MCP_BEARER_TOKEN). The app itself
 * signs in with a full key made for each device; the master token is pasted
 * once on Connect to make it and isn't kept. Each key has a scope:
 *
 *  - "capture": an iPhone Shortcut (Siri, the share sheet) and the browser
 *    extension. It opens the capture paths only (POST /api/assistant/capture,
 *    POST /api/saved and its ping, POST /api/health/day, POST
 *    /api/habits/log). A capture files with five tools and answers with a
 *    fixed line; it can't look anything up.
 *  - "mcp": Athena's tools at /mcp and nothing else: for Claude (or any MCP
 *    client) as a connector. Every /api/* path refuses it, so it can't
 *    delete, list archived items, touch connected accounts or files.
 *  - "full": REST and MCP, like the app: for a device the app is signed in
 *    on, or the owner's own scripts. It can't list, make or remove keys:
 *    that needs the master token (netlify/functions/api.ts). The one
 *    exception, for every scope: a key can remove itself (removeOwnApiKey).
 *
 * A key is shown once, when it's made; Athena keeps only its SHA-256 (in
 * settings, under 'api_keys'), and removing one stops it straight away. The
 * prefix says what it is at a glance: athc_ capture, athm_ MCP, athk_ full.
 *
 * Each change is one SQL statement on the settings row, so a request using a
 * key while another is being made or removed can't lose either change.
 * Capture keys made before API keys existed ('capture_keys') move across on
 * first read, as capture keys.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AthenaInputError, q } from "./db";

export type ApiKeyScope = "capture" | "mcp" | "full";
export const API_KEY_SCOPES: ApiKeyScope[] = ["capture", "mcp", "full"];

export interface ApiKey {
  id: string;
  /** What the owner called it: "iPhone", "Claude". */
  label: string;
  scope: ApiKeyScope;
  created_at: string;
  last_used_at: string | null;
}

interface Stored extends ApiKey {
  hash: string;
}

const SETTING = "api_keys";
const LEGACY = "capture_keys";
const PREFIX: Record<ApiKeyScope, string> = { capture: "athc_", mcp: "athm_", full: "athk_" };
const MAX_KEYS = 20;
const TOKEN = /^Bearer\s+(ath[ckm]_[A-Za-z0-9_-]{40,})$/i;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const visible = ({ hash: _hash, ...key }: Stored): ApiKey => key;

async function load(): Promise<Stored[]> {
  // Capture keys from before API keys: move them across (in one statement), once.
  await q(
    `WITH legacy AS (DELETE FROM settings WHERE key = $2 RETURNING value)
     INSERT INTO settings (key, value)
     SELECT $1, (SELECT jsonb_agg(e || '{"scope":"capture"}'::jsonb) FROM jsonb_array_elements(value) e) FROM legacy WHERE jsonb_array_length(value) > 0
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()`,
    [SETTING, LEGACY],
  );
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [SETTING]);
  return Array.isArray(row?.value) ? (row.value as Stored[]) : [];
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return (await load()).map(visible);
}

/** A new key. Its token is returned only here. */
export async function createApiKey(label: string, scope: ApiKeyScope): Promise<{ key: ApiKey; token: string }> {
  if (!API_KEY_SCOPES.includes(scope)) throw new AthenaInputError("A key is capture only, agent only or full access");
  if ((await load()).length >= MAX_KEYS) throw new AthenaInputError(`You already have ${MAX_KEYS} API keys. Remove one first.`);
  const token = `${PREFIX[scope]}${randomBytes(32).toString("base64url")}`;
  const stored: Stored = {
    id: randomUUID(),
    label: label.trim().slice(0, 60) || (scope === "capture" ? "iPhone" : scope === "mcp" ? "Claude" : "API key"),
    scope,
    created_at: new Date().toISOString(),
    last_used_at: null,
    hash: hashOf(token),
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, jsonb_build_array($2::jsonb))
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()`,
    [SETTING, JSON.stringify(stored)],
  );
  return { key: visible(stored), token };
}

/** Remove a key: anything using it stops working straight away. */
export async function removeApiKey(id: string): Promise<boolean> {
  if (!(await load()).some((k) => k.id === id)) return false;
  await q(
    `UPDATE settings SET updated_at = now(),
       value = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(value) e WHERE e->>'id' <> $2)
     WHERE key = $1`,
    [SETTING, id],
  );
  return true;
}

/** The stored key a request's bearer token belongs to, whatever its scope. */
async function keyOf(req: Request): Promise<Stored | null> {
  const token = req.headers.get("authorization")?.match(TOKEN)?.[1];
  if (!token) return null;
  const want = Buffer.from(hashOf(token));
  return (
    (await load()).find((k) => {
      const have = Buffer.from(k.hash);
      return have.length === want.length && timingSafeEqual(have, want);
    }) ?? null
  );
}

/**
 * Remove the key a request is signed with (DELETE /api/api-keys/self): how a
 * device signing out, or anything else holding a key, gives it up without
 * the master token. Any scope. False when the bearer isn't a live key.
 */
export async function removeOwnApiKey(req: Request): Promise<boolean> {
  const found = await keyOf(req);
  return found ? removeApiKey(found.id) : false;
}

/**
 * The key a request's bearer token belongs to, if its scope covers `need`
 * (a full key covers everything; a capture key only capturing; an mcp key
 * only "mcp", which is what /mcp asks for and no /api/* path does). Records
 * when it was used. Null otherwise.
 */
export async function checkApiKey(req: Request, need: ApiKeyScope): Promise<ApiKey | null> {
  const found = await keyOf(req);
  if (!found || (found.scope !== "full" && found.scope !== need)) return null;
  const now = new Date().toISOString();
  await q(
    `UPDATE settings SET
       value = (SELECT jsonb_agg(CASE WHEN e->>'id' = $2 THEN jsonb_set(e, '{last_used_at}', to_jsonb($3::text)) ELSE e END) FROM jsonb_array_elements(value) e)
     WHERE key = $1`,
    [SETTING, found.id, now],
  );
  return { ...visible(found), last_used_at: now };
}
