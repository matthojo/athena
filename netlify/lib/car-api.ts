/**
 * The two government APIs behind the car (lib/car.ts), read only:
 *
 *  - DVLA Vehicle Enquiry: POST {VES_URL} with x-api-key and
 *    { registrationNumber } in the body (DVLA keeps the registration out of
 *    the URL on purpose). 404 is "no such vehicle".
 *  - DVSA MOT History: a client-credentials token from Microsoft Entra (the
 *    token URL DVSA emails, scope https://tapi.dvsa.gov.uk/.default), then
 *    GET {MOT_URL}/{registration} with Authorization: Bearer and X-API-Key.
 *    The token is held in memory until a minute before it expires.
 *
 * Keys come from the Sources accounts "dvla" and "dvsa-mot"
 * (lib/presets/car.ts), sealed with the account's other secrets. What leaves
 * Athena: the registration, to these two hosts only, and the keys. Nothing is
 * logged but a host and a status code; a registration never goes in a log
 * line or an error message.
 */
import { getConnectorWithSecrets, listConnectors } from "../../lib/connectors";
import type { Lookup } from "../../lib/car-sync";

export const VES_URL = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
export const MOT_URL = "https://history.mot.api.gov.uk/v1/trade/vehicles/registration";
export const MOT_SCOPE = "https://tapi.dvsa.gov.uk/.default";
/** DVSA's token URL is Microsoft Entra's, for DVSA's tenant: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token. */
export const MOT_TOKEN_URL = /^https:\/\/login\.microsoftonline\.com\/[A-Za-z0-9.-]{1,80}\/oauth2\/v2\.0\/token$/;
const TIMEOUT_MS = 8_000;

export interface DvsaCreds {
  client_id: string;
  client_secret: string;
  api_key: string;
  token_url: string;
}

export interface CarKeys {
  dvla: string | null;
  mot: DvsaCreds | null;
}

/** The newest account of each kind that holds a key. */
export async function carKeys(): Promise<CarKeys> {
  const accounts = (await listConnectors()).filter((c) => (c.provider === "dvla" || c.provider === "dvsa-mot") && c.auth_type === "token" && c.has_token).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const out: CarKeys = { dvla: null, mot: null };
  for (const c of accounts) {
    const s = (await getConnectorWithSecrets(c.id))?.secrets;
    const token = s?.token?.trim();
    if (!token) continue;
    if (c.provider === "dvla" && !out.dvla) out.dvla = token;
    if (c.provider === "dvsa-mot" && !out.mot && s?.ownClient?.client_id && s.ownClient.client_secret && s.tokenUrl) {
      out.mot = { client_id: s.ownClient.client_id, client_secret: s.ownClient.client_secret, api_key: token, token_url: s.tokenUrl };
    }
  }
  return out;
}

async function call(f: typeof fetch, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    console.error(`Athena car: ${new URL(url).host} didn't answer`, error instanceof Error ? error.name : "");
    return null;
  }
}

const busy = (who: string) => `${who} is busy right now. Athena tries again tomorrow, or now with Check again.`;

/** One DVLA lookup. */
export async function vesLookup(registration: string, key: string | null, f: typeof fetch = fetch): Promise<Lookup<unknown>> {
  if (!key) return { none: true };
  const res = await call(f, VES_URL, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ registrationNumber: registration }),
  });
  if (!res) return { error: "DVLA didn't answer." };
  if (res.ok) return { ok: await res.json().catch(() => null) };
  if (res.status === 404) return { notFound: true };
  console.error(`Athena car: DVLA answered ${res.status}`);
  if (res.status === 403 || res.status === 401) return { error: "DVLA didn't accept the key. Paste it again in Sources." };
  if (res.status === 400) return { error: "DVLA couldn't read that registration." };
  return { error: busy("DVLA") };
}

let motToken: { for: string; token: string; until: number } | null = null;

/** For tests. */
export function clearMotToken(): void {
  motToken = null;
}

async function dvsaToken(c: DvsaCreds, f: typeof fetch, now: number): Promise<string | { error: string }> {
  if (motToken && motToken.for === c.client_id && motToken.until > now) return motToken.token;
  if (!MOT_TOKEN_URL.test(c.token_url)) return { error: "The DVSA token URL doesn't look like the one DVSA sent. Add the account again." };
  const res = await call(f, c.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.client_id, client_secret: c.client_secret, scope: MOT_SCOPE }).toString(),
  });
  if (!res) return { error: "DVSA's sign-in didn't answer." };
  if (!res.ok) {
    console.error(`Athena car: DVSA sign-in answered ${res.status}`);
    return { error: res.status === 400 || res.status === 401 ? "DVSA didn't accept the client ID and secret. Add them again in Sources." : busy("DVSA") };
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) return { error: "DVSA's sign-in answered without a token." };
  motToken = { for: c.client_id, token: body.access_token, until: now + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
  return motToken.token;
}

/** One MOT History lookup. */
export async function motLookup(registration: string, creds: DvsaCreds | null, f: typeof fetch = fetch, now = Date.now()): Promise<Lookup<unknown>> {
  if (!creds) return { none: true };
  const token = await dvsaToken(creds, f, now);
  if (typeof token !== "string") return token;
  const res = await call(f, `${MOT_URL}/${encodeURIComponent(registration)}`, {
    headers: { Authorization: `Bearer ${token}`, "X-API-Key": creds.api_key, Accept: "application/json" },
  });
  if (!res) return { error: "DVSA didn't answer." };
  if (res.ok) return { ok: await res.json().catch(() => null) };
  if (res.status === 404) return { notFound: true };
  console.error(`Athena car: DVSA answered ${res.status}`);
  if (res.status === 401) clearMotToken();
  if (res.status === 401 || res.status === 403) return { error: "DVSA didn't accept the API key. Add it again in Sources." };
  if (res.status === 400) return { error: "DVSA couldn't read that registration." };
  return { error: busy("DVSA") };
}

/** The lookups the sync uses, with the stored keys read once. */
export async function carLookups(f: typeof fetch = fetch, keys?: CarKeys) {
  const k = keys ?? (await carKeys().catch(() => ({ dvla: null, mot: null })));
  return { keys: k, ves: (reg: string) => vesLookup(reg, k.dvla, f), mot: (reg: string) => motLookup(reg, k.mot, f) };
}

/**
 * "Check connection" for each account: one call that sends nothing about the
 * owner. A registration too short to be real ("A") is refused by the service
 * with 400 only once the key itself has been accepted; a bad key gets 403.
 */
export async function checkCarKey(provider: "dvla" | "dvsa-mot", secrets: { token?: string; ownClient?: { client_id: string; client_secret?: string }; tokenUrl?: string }, f: typeof fetch = fetch): Promise<void> {
  const key = secrets.token?.trim() ?? "";
  if (!key) throw new CarKeyError(`Paste your ${provider === "dvla" ? "DVLA" : "DVSA"} API key.`, true);
  if (provider === "dvla") {
    const r = await vesLookup("A", key, f);
    if ("error" in r && !/registration/.test(r.error)) throw new CarKeyError(r.error, /key/.test(r.error));
    return;
  }
  const c = secrets.ownClient;
  if (!c?.client_id || !c.client_secret) throw new CarKeyError("Paste the client ID and client secret DVSA sent.", true);
  if (!secrets.tokenUrl || !MOT_TOKEN_URL.test(secrets.tokenUrl)) throw new CarKeyError("Paste the token URL from DVSA's email. It starts https://login.microsoftonline.com/.", true);
  clearMotToken();
  const r = await motLookup("A", { client_id: c.client_id, client_secret: c.client_secret, api_key: key, token_url: secrets.tokenUrl }, f);
  if ("error" in r && !/registration/.test(r.error)) throw new CarKeyError(r.error, /accept|token URL/.test(r.error));
}

export class CarKeyError extends Error {
  constructor(message: string, readonly owner = false) {
    super(message);
    this.name = "CarKeyError";
  }
}
