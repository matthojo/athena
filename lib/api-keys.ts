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
 * A key is shown once, when it's made. Athena keeps only its HMAC-SHA256
 * under a subkey of ATHENA_DATA_KEY (lib/data-box.ts apiKeyMac), with `v: 2`
 * and the id of the data key it was made under (in settings, under
 * 'api_keys'). So someone who can write to the database but doesn't hold the
 * data key can't add a key of their own. Without ATHENA_DATA_KEY no key can
 * be made and none is accepted; the master token still works. During a data
 * key rotation a key made under the previous key (ATHENA_DATA_KEY_PREVIOUS)
 * still works, and its next use stores it under the current one. An entry
 * without `v: 2` (a plain SHA-256, from before) is never accepted or listed,
 * and the next change to the list drops it. The prefix says what a key is at
 * a glance: athc_ capture, athm_ MCP, athk_ full.
 *
 * Each instance keeps the list for KEYS_CACHE_MS, so checking a key doesn't
 * read the database every time: removing a key stops it at once on the
 * instance that removed it, and everywhere else within ten seconds.
 * `last_used_at` is written at most once a minute per key.
 *
 * Each change is one SQL statement on the settings row, so a request using a
 * key while another is being made or removed can't lose either change.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { apiKeyMac, currentKeyId } from "./data-box";
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

/** A key as kept: `hash` is the token's HMAC (hex) under the api-keys subkey of data key `kid`. */
export interface Stored extends ApiKey {
  hash: string;
  v?: number;
  kid?: string;
}

const SETTING = "api_keys";
const PREFIX: Record<ApiKeyScope, string> = { capture: "athc_", mcp: "athm_", full: "athk_" };
const MAX_KEYS = 20;
const TOKEN = /^Bearer\s+(ath[ckm]_[A-Za-z0-9_-]{40,})$/i;
/** Only these entries are read: what lib/api-keys.ts stores today. */
const CURRENT = 2;
/** The same, in SQL: keeps the entries a change keeps, and drops anything older. */
const KEPT = `e->>'v' = '${CURRENT}'`;

export const NO_DATA_KEY = "API keys need ATHENA_DATA_KEY, and it isn't set on this copy of Athena. Set it (see the README), or use the access token.";

const visible = ({ hash: _hash, v: _v, kid: _kid, ...key }: Stored): ApiKey => key;
const usable = (k: Stored): boolean => k.v === CURRENT && typeof k.kid === "string" && typeof k.hash === "string";

/** Two hex MACs, compared in constant time. False when either isn't one, or they differ in length. */
export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** What's stored for a new token: its MAC under the current data key, or null without one. */
export function storedForm(token: string): Pick<Stored, "hash" | "v" | "kid"> | null {
  const m = apiKeyMac(token);
  return m ? { hash: m.mac, v: CURRENT, kid: m.kid } : null;
}

/**
 * The entry a token belongs to, and whether it was made under a previous data key (so should be stored again under
 * the current one). Only `v: 2` entries count; each is checked with its own data key's MAC. Null without a data key.
 */
export function matchKey(list: Stored[], token: string, equal: (a: string, b: string) => boolean = macEqual): { key: Stored; stale: boolean } | null {
  const current = currentKeyId();
  if (!current) return null;
  const macs = new Map<string, string | null>();
  let found: Stored | null = null;
  for (const k of list) {
    if (!usable(k)) continue;
    if (!macs.has(k.kid!)) macs.set(k.kid!, apiKeyMac(token, k.kid)?.mac ?? null);
    const mac = macs.get(k.kid!);
    // Every entry is compared, so the time taken doesn't say which one matched.
    if (mac && equal(k.hash, mac) && !found) found = k;
  }
  return found ? { key: found, stale: found.kid !== current } : null;
}

/** How long an instance trusts its copy of the key list. */
export const KEYS_CACHE_MS = 10_000;
/** `last_used_at` is written at most this often per key. */
export const USED_EVERY_MS = 60_000;

/** A value read through `read` and kept for `ms`; `forget` drops it. A read that fails isn't kept. */
export function cachedFor<T>(ms: number, read: () => Promise<T>): { get(now?: number): Promise<T>; forget(): void } {
  let held: { at: number; value: Promise<T> } | null = null;
  return {
    get(now = Date.now()) {
      if (held && now - held.at < ms) return held.value;
      const mine = (held = { at: now, value: read() });
      mine.value.catch(() => {
        if (held === mine) held = null;
      });
      return mine.value;
    },
    forget() {
      held = null;
    },
  };
}

/** Whether a key's use should be written now: false within `every` of the last write for it. */
export function useDue(seen: Map<string, number>, id: string, now: number, every = USED_EVERY_MS): boolean {
  const last = seen.get(id);
  if (last !== undefined && now - last < every) return false;
  seen.set(id, now);
  return true;
}

const keys = cachedFor(KEYS_CACHE_MS, async (): Promise<Stored[]> => {
  const [row] = await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [SETTING]);
  return Array.isArray(row?.value) ? (row.value as Stored[]) : [];
});
const usedAt = new Map<string, number>();

/** The keys: this instance's copy, or (`fresh`) read now. */
async function load(fresh = false): Promise<Stored[]> {
  if (fresh) keys.forget();
  return keys.get();
}

/** The keys that work (`v: 2`); anything older isn't shown. */
export async function listApiKeys(): Promise<ApiKey[]> {
  return (await load(true)).filter(usable).map(visible);
}

/** A new key. Its token is returned only here. Refused without ATHENA_DATA_KEY. */
export async function createApiKey(label: string, scope: ApiKeyScope): Promise<{ key: ApiKey; token: string }> {
  if (!API_KEY_SCOPES.includes(scope)) throw new AthenaInputError("A key is capture only, agent only or full access");
  if (!currentKeyId()) throw new AthenaInputError(NO_DATA_KEY);
  if ((await load(true)).filter(usable).length >= MAX_KEYS) throw new AthenaInputError(`You already have ${MAX_KEYS} API keys. Remove one first.`);
  const token = `${PREFIX[scope]}${randomBytes(32).toString("base64url")}`;
  const sealed = storedForm(token);
  if (!sealed) throw new AthenaInputError(NO_DATA_KEY);
  const stored: Stored = {
    id: randomUUID(),
    label: label.trim().slice(0, 60) || (scope === "capture" ? "iPhone" : scope === "mcp" ? "Claude" : "API key"),
    scope,
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...sealed,
  };
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, jsonb_build_array($2::jsonb))
     ON CONFLICT (key) DO UPDATE SET updated_at = now(),
       value = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(settings.value) e WHERE ${KEPT}) || EXCLUDED.value`,
    [SETTING, JSON.stringify(stored)],
  );
  keys.forget();
  return { key: visible(stored), token };
}

/** Remove a key: anything using it stops working straight away. */
export async function removeApiKey(id: string): Promise<boolean> {
  if (!(await load(true)).some((k) => k.id === id && usable(k))) return false;
  await q(
    `UPDATE settings SET updated_at = now(),
       value = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(value) e WHERE e->>'id' <> $2 AND ${KEPT})
     WHERE key = $1`,
    [SETTING, id],
  );
  keys.forget();
  usedAt.delete(id);
  return true;
}

/**
 * The stored key a request's bearer token belongs to, whatever its scope. One made under a previous data key is
 * stored again under the current one: only if it's still as it was read, so a concurrent change isn't lost.
 */
async function keyOf(req: Request): Promise<Stored | null> {
  const token = req.headers.get("authorization")?.match(TOKEN)?.[1];
  if (!token) return null;
  const hit = matchKey(await load(), token);
  if (!hit) return null;
  if (hit.stale) {
    const fresh = storedForm(token);
    if (fresh) {
      await q(
        `UPDATE settings SET updated_at = now(),
           value = (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = $2 AND e->>'kid' = $3 AND e->>'hash' = $4 THEN e || $5::jsonb ELSE e END), '[]'::jsonb) FROM jsonb_array_elements(value) e)
         WHERE key = $1`,
        [SETTING, hit.key.id, hit.key.kid, hit.key.hash, JSON.stringify(fresh)],
      ).catch((error) => console.error("Athena API keys: couldn't store a key under the current data key; it's tried again on its next use", error instanceof Error ? error.message : error));
      keys.forget();
    }
  }
  return hit.key;
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

/** The key a request's bearer token belongs to, whatever its scope, without recording a use. Null when it isn't a live key. */
export async function apiKeyOf(req: Request): Promise<ApiKey | null> {
  const found = await keyOf(req);
  return found ? visible(found) : null;
}

/**
 * The key a request's bearer token belongs to, if its scope covers `need`
 * (a full key covers everything; a capture key only capturing; an mcp key
 * only "mcp", which is what /mcp asks for and no /api/* path does). Records
 * when it was used, at most once a minute. Null otherwise.
 */
export async function checkApiKey(req: Request, need: ApiKeyScope): Promise<ApiKey | null> {
  const found = await keyOf(req);
  if (!found || (found.scope !== "full" && found.scope !== need)) return null;
  const at = Date.now();
  if (!useDue(usedAt, found.id, at)) return visible(found);
  const now = new Date(at).toISOString();
  await q(
    `UPDATE settings SET
       value = (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = $2 THEN jsonb_set(e, '{last_used_at}', to_jsonb($3::text)) ELSE e END), '[]'::jsonb) FROM jsonb_array_elements(value) e)
     WHERE key = $1`,
    [SETTING, found.id, now],
  );
  return { ...visible(found), last_used_at: now };
}
