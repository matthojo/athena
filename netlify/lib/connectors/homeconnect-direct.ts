/**
 * Home Connect without MCP: a narrow, read-only adapter over the Home
 * Connect API (api.home-connect.com/api), registered in direct.ts.
 *
 * The API's own documentation couldn't be reached from where this was
 * written (11 Nov 2026), so the calls follow aiohomeconnect, the client
 * library Home Assistant's integration uses (read the same day):
 *  - The owner registers their own app (Authorization Code Grant Flow) and
 *    signs in with `IdentifyAppliance Monitor`: enough to list appliances
 *    and read their status, never to control one. The code is exchanged at
 *    /security/oauth/token with the client in the form body, and with PKCE.
 *  - Every request carries Accept: application/vnd.bsh.sdk.v1+json, and
 *    answers `{ data }` or `{ error: { key, description } }`.
 *  - GET /api/homeappliances → data.homeappliances[]: haId, name, type,
 *    brand, vib, enumber, connected.
 *  - GET /api/homeappliances/{haId}/status → data.status[]: key, value.
 *    BSH.Common.Status.OperationState ends in Inactive, Ready, DelayedStart,
 *    Run, Pause, ActionRequired, Finished, Error or Aborting.
 *  - GET /api/homeappliances/{haId}/programs/active → data: key, name,
 *    options[] (key, value, unit). 404 when nothing is running; 409 when the
 *    appliance is offline.
 *  - 429 carries Retry-After, which can be long (the allowance is by the
 *    day): Athena never retries one, and waits until then to ask again.
 *
 * Nothing here writes: there is no PUT or DELETE, and the scope wouldn't
 * allow one. What appliances do shows when someone's home, so what's read
 * is kept sealed (lib/appliance-store.ts) and never logged.
 *
 * readAppliances costs one request, plus one per connected appliance, plus
 * one per appliance that's running.
 */
import { HOME_CONNECT_API_URL, HOME_CONNECT_AUTHORIZE_URL, HOME_CONNECT_SCOPE, HOME_CONNECT_TOKEN_URL } from "../../../lib/presets/home";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { applianceName, enumTail, programName, stateLine, typeWord, type ApplianceSnapshot } from "../../../lib/home-appliances";
import type { StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { LifeApiError, OAuthSession, account, lifeAccountProblem, lifeFailure, readOnly, withItems, type LifeTool, type TokenEndpoint } from "./lifelog-b-http";

const HOSTS = ["api.home-connect.com"];
const HEADERS = { Accept: "application/vnd.bsh.sdk.v1+json", "Accept-Language": "en-GB" };
/** At most this many appliances are read in one look. */
const MAX_APPLIANCES = 20;

/** A refusal from Home Connect. Never retried: a 429's wait can be hours, and every retry spends the day's allowance. */
export class HomeConnectError extends LifeApiError {
  constructor(
    status: number,
    message: string,
    owner = false,
    /** Home Connect's own name for it: "SDK.Error.HomeAppliance.Connection.Initialization.Failed". */
    readonly key = "",
  ) {
    super("homeconnect", status, message, owner);
    this.name = "HomeConnectError";
  }

  override get retryable(): boolean {
    return false;
  }
}

const keyOf = (body: unknown): string => {
  const key = (body as { error?: { key?: unknown } } | null)?.error?.key;
  return typeof key === "string" ? key.slice(0, 120) : "";
};

function refused(status: number, body: unknown): HomeConnectError {
  const key = keyOf(body);
  if (status === 401) return new HomeConnectError(401, "Home Connect didn't accept the sign-in. Sign in again", true, key);
  if (status === 403) return new HomeConnectError(403, "Home Connect didn't let Athena read that. Sign in again and allow what Athena asks for.", true, key);
  if (status === 429) return new HomeConnectError(429, "Home Connect is limiting how often Athena can ask. Athena will look again later.", false, key);
  if (status === 404) return new HomeConnectError(404, "Home Connect couldn't find that", false, key);
  if (status === 409) return new HomeConnectError(409, "That appliance isn't connected right now", false, key);
  if (status >= 500) return new HomeConnectError(status, "Home Connect is having trouble right now. Try again in a few minutes.", false, key);
  return new HomeConnectError(status, `Home Connect refused that (${status})`, false, key);
}

/** POST to Home Connect's token endpoint, the client in the form body. One try: a refusal is the owner's to fix. */
export async function homeConnectToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  const form = new URLSearchParams({ client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), ...params });
  let res: Response;
  try {
    res = await fetch(HOME_CONNECT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HomeConnectError(503, "Couldn't reach Home Connect to sign in");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && typeof body?.access_token === "string") {
    return {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      expires_in: Number(body.expires_in) || undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
      token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    };
  }
  if (res.status === 429) throw new HomeConnectError(429, "Home Connect is limiting how often Athena can sign in. Try again later.");
  if (res.status >= 500) throw new HomeConnectError(res.status, "Home Connect is having trouble right now. Try again in a few minutes.");
  const code = typeof body?.error === "string" ? body.error : "";
  if (code === "invalid_client" || code === "unauthorized_client") {
    throw new HomeConnectError(401, "Home Connect refused Athena's app. Check the Client ID and Secret under Edit, then sign in again.", true);
  }
  throw new HomeConnectError(400, "Sign in again", true);
}

const TOKEN: TokenEndpoint = { service: "homeconnect", url: HOME_CONNECT_TOKEN_URL, label: "Home Connect", request: homeConnectToken };

export type HomeConnectGet = <T>(path: string) => Promise<T>;

interface Listed {
  haId?: unknown;
  name?: unknown;
  type?: unknown;
  brand?: unknown;
  connected?: unknown;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const seconds = (v: unknown, unit: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && (unit === undefined || unit === "seconds") ? Math.round(v) : undefined);

/** What a status reply says: the operation state and the door. */
export function readStatus(data: unknown): { state?: string; door?: string } {
  const list = (data as { status?: unknown } | null)?.status;
  const out: { state?: string; door?: string } = {};
  for (const s of Array.isArray(list) ? list : []) {
    const key = (s as { key?: unknown }).key;
    const value = enumTail((s as { value?: unknown }).value);
    if (!value) continue;
    if (key === "BSH.Common.Status.OperationState") out.state = value;
    else if (key === "BSH.Common.Status.DoorState") out.door = value;
  }
  return out;
}

/** What an active-programme reply says: which one, how long it has run, how long is left and how far through. */
export function readProgram(data: unknown): Pick<ApplianceSnapshot, "program" | "remaining_s" | "elapsed_s" | "progress"> {
  const d = (data ?? {}) as { key?: unknown; name?: unknown; options?: unknown };
  const key = text(d.key, 160);
  if (!key) return {};
  const out: Pick<ApplianceSnapshot, "program" | "remaining_s" | "elapsed_s" | "progress"> = { program: { key, ...(text(d.name, 80) ? { name: text(d.name, 80) } : {}) } };
  for (const o of Array.isArray(d.options) ? d.options : []) {
    const { key: k, value, unit } = o as { key?: unknown; value?: unknown; unit?: unknown };
    if (k === "BSH.Common.Option.RemainingProgramTime") out.remaining_s = seconds(value, unit);
    else if (k === "BSH.Common.Option.ElapsedProgramTime") out.elapsed_s = seconds(value, unit);
    else if (k === "BSH.Common.Option.ProgramProgress" && typeof value === "number" && value >= 0 && value <= 100) out.progress = Math.round(value);
  }
  return out;
}

/** Every appliance on the account and what each is doing. An appliance that can't be read just now comes back without a state. */
export async function readAppliances(get: HomeConnectGet): Promise<ApplianceSnapshot[]> {
  const listed = await get<{ data?: { homeappliances?: Listed[] } }>("/homeappliances");
  const out: ApplianceSnapshot[] = [];
  for (const a of (listed.data?.homeappliances ?? []).slice(0, MAX_APPLIANCES)) {
    const id = text(a.haId, 120);
    // The id goes into a path: only what Home Connect's ids are made of.
    if (!id || !/^[\w.-]+$/.test(id)) continue;
    const snap: ApplianceSnapshot = { id, name: text(a.name, 80), type: text(a.type, 40) || "Appliance", brand: text(a.brand, 40), connected: a.connected === true };
    if (snap.connected) {
      try {
        Object.assign(snap, readStatus((await get<{ data?: unknown }>(`/homeappliances/${encodeURIComponent(id)}/status`)).data));
        if (snap.state === "Run" || snap.state === "Pause" || snap.state === "ActionRequired") {
          Object.assign(snap, readProgram((await get<{ data?: unknown }>(`/homeappliances/${encodeURIComponent(id)}/programs/active`)).data));
        }
      } catch (error) {
        // Offline since the list was made, or nothing running after all: this one says less. Anything else is the account's problem.
        if (!(error instanceof HomeConnectError) || (error.status !== 409 && error.status !== 404)) throw error;
        if (error.status === 409) {
          snap.connected = false;
          delete snap.state;
        }
      }
    }
    out.push(snap);
  }
  return out;
}

export function homeConnectGet(connector: Pick<Connector, "id">, secrets: ConnectorSecrets): HomeConnectGet {
  const session = new OAuthSession(TOKEN, connector, secrets);
  return <T>(path: string) => session.get<T>(`${HOME_CONNECT_API_URL}/api${path}`, { service: "homeconnect", hosts: HOSTS, headers: HEADERS, refused, unreachable: "Couldn't reach Home Connect" });
}

interface Ctx {
  get: HomeConnectGet;
}

/** One appliance as the tool tells it: plain words, no ids. */
export function applianceItem(a: ApplianceSnapshot): Record<string, unknown> {
  return {
    name: applianceName(a),
    what: typeWord(a.type),
    ...(a.brand ? { brand: a.brand } : {}),
    now: stateLine(a),
    ...(programName(a.program) ? { programme: programName(a.program) } : {}),
    ...(typeof a.remaining_s === "number" ? { minutes_left: Math.round(a.remaining_s / 60) } : {}),
    ...(typeof a.progress === "number" ? { percent_done: a.progress } : {}),
    ...(a.door ? { door: a.door.toLowerCase() } : {}),
  };
}

export const HOME_CONNECT_TOOLS: LifeTool<Ctx>[] = [
  {
    name: "appliances",
    summary: "See what your appliances are doing",
    description:
      'The owner\'s home appliances right now, read live: each one\'s name, what it is, `now` ("Running Eco 50, 1h 20m left", "Finished", "Door open", "Offline"), the programme, minutes_left and percent_done when it\'s running, and the door. For "is the washing done?" or "is the oven on?". Read-only: nothing can be started, stopped or changed. Past programmes are on the owner\'s Days, not here.',
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
    async run(ctx) {
      return withItems((await readAppliances(ctx.get)).map(applianceItem), {});
    },
  },
];

/** Open a signed-in account: the list of appliances proves the sign-in works. */
export async function openHomeConnect(connector: Connector, secrets: ConnectorSecrets): Promise<DirectAccount> {
  if (!secrets.tokens) throw new HomeConnectError(401, "Not signed in yet", true);
  const get = homeConnectGet(connector, secrets);
  await get("/homeappliances");
  return account("homeconnect", HOME_CONNECT_TOOLS, { get });
}

/** Home Connect's consent page, with PKCE. */
export function homeConnectAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(HOME_CONNECT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: input.scope || HOME_CONNECT_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeHomeConnectCode(input: { code: string; redirectUri: string; verifier: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await homeConnectToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier });
  if (!tokens.refresh_token) throw new HomeConnectError(400, "Home Connect gave Athena no way to renew this sign-in. Sign in again.", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const homeConnectAdapter: DirectAdapter = {
  id: "homeconnect",
  handles: (c) => c.provider === "home-connect" && c.auth_type === "oauth",
  tools: () => HOME_CONNECT_TOOLS,
  serverInfo: () => ({ website_url: "https://www.home-connect.com/" }),
  open: (connector, secrets) => openHomeConnect(connector, secrets),
  authorizationUrl: homeConnectAuthorizationUrl,
  exchangeCode: exchangeHomeConnectCode,
  accountProblem: (e) => lifeAccountProblem("homeconnect", e),
  failure: (e) => lifeFailure("homeconnect", e),
};
