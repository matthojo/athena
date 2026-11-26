/**
 * The keys for live travel (lib/presets/live-travel.ts): Google Maps routes,
 * TfL and National Rail. One place reads them, in this order:
 *
 *  1. the key pasted into Sources, sealed with the account's other secrets
 *     (lib/connectors.ts, docs: security/encryption), newest account first;
 *  2. the old environment variable (ATHENA_GOOGLE_ROUTES_KEY, ATHENA_TFL_KEY,
 *     ATHENA_RDM_KEY), so a deploy that set one keeps working;
 *  3. nothing: that half of live travel is off, and callers say so.
 *
 * The stored keys are read once a minute at most per function instance and
 * held in memory only. A key is never returned to the browser, never logged
 * and never put in an error message.
 */
import { getConnectorWithSecrets, listConnectors } from "../../lib/connectors";
import { TRAVEL_KEY_ENV, TRAVEL_KEY_PROVIDERS, type TravelKeyKind } from "../../lib/presets/live-travel";

export type { TravelKeyKind } from "../../lib/presets/live-travel";

export const STORED_KEYS_MS = 60_000;

export interface TravelKeyDeps {
  /** Reads an environment variable; tests pass their own. */
  env?: (name: string) => string | undefined;
  /** The stored keys, by kind; tests pass their own. Defaults to the connectors table. */
  stored?: () => Promise<Partial<Record<TravelKeyKind, string>>>;
  now?: Date;
}

export function readEnv(name: string): string | undefined {
  const fromNetlify = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name);
  return fromNetlify ?? (typeof process !== "undefined" ? process.env[name] : undefined);
}

/** Every stored travel key, from the newest account of each kind that holds one. */
async function storedFromDb(): Promise<Partial<Record<TravelKeyKind, string>>> {
  const accounts = (await listConnectors())
    .filter((c) => (TRAVEL_KEY_PROVIDERS as readonly string[]).includes(c.provider) && c.auth_type === "token" && c.has_token)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const out: Partial<Record<TravelKeyKind, string>> = {};
  for (const c of accounts) {
    const kind = c.provider as TravelKeyKind;
    if (out[kind]) continue;
    const token = (await getConnectorWithSecrets(c.id))?.secrets.token?.trim();
    if (token) out[kind] = token;
  }
  return out;
}

let memo: { at: number; keys: Partial<Record<TravelKeyKind, string>> } | null = null;

/** For tests, and after an account changes: read the stored keys afresh next time. */
export function clearTravelKeys(): void {
  memo = null;
}

async function storedKeys(deps: TravelKeyDeps): Promise<Partial<Record<TravelKeyKind, string>>> {
  if (deps.stored) return deps.stored().catch(() => ({}));
  const now = (deps.now ?? new Date()).getTime();
  if (memo && now - memo.at < STORED_KEYS_MS) return memo.keys;
  try {
    memo = { at: now, keys: await storedFromDb() };
  } catch (error) {
    // No database (a unit test) or a key that won't open: the environment still counts.
    console.error("Athena travel keys: couldn't read the stored keys", error instanceof Error ? error.name : "");
    memo = { at: now, keys: {} };
  }
  return memo.keys;
}

const fromEnv = (kind: TravelKeyKind, deps: TravelKeyDeps) => (deps.env ?? readEnv)(TRAVEL_KEY_ENV[kind])?.trim() || null;

/** The key for one service: the stored one, else the environment's, else null. */
export async function travelKey(kind: TravelKeyKind, deps: TravelKeyDeps = {}): Promise<string | null> {
  const stored = (await storedKeys(deps))[kind]?.trim();
  return stored || fromEnv(kind, deps);
}

/** Read the stored keys now, so knownTravelKey can answer without waiting. Never throws. */
export async function primeTravelKeys(deps: TravelKeyDeps = {}): Promise<void> {
  await storedKeys(deps).catch(() => undefined);
}

/**
 * Without waiting: is there a key for this service, as far as this instance
 * knows? The environment's, or a stored one read in the last minute or so
 * (primeTravelKeys). For callers that can't wait (Ask's train_status).
 */
export function knownTravelKey(kind: TravelKeyKind, deps: Pick<TravelKeyDeps, "env"> = {}): boolean {
  return !!memo?.keys[kind]?.trim() || !!fromEnv(kind, deps);
}
