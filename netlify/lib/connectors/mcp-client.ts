/**
 * Athena as an MCP *client*: signing in to a remote MCP server (OAuth 2.1
 * with PKCE and dynamic client registration, or a static token), listing its
 * tools, and calling them — for one connector (one account) at a time.
 *
 * Every secret lives sealed in `connectors.credentials` (lib/connectors.ts,
 * lib/secret-box.ts). The OAuth provider below is the SDK's storage hook:
 * the SDK does discovery, registration, the code exchange and refreshes, and
 * calls back here to persist each result.
 *
 * Plain OAuth 2 servers that don't follow the MCP authorization spec are
 * handled through the connector's `oauth` settings:
 *  - endpoints entered by hand stand in for discovery (handed to the SDK as
 *    its cached discovery state, so it never guesses /authorize and /token);
 *  - the client-credentials grant gets a token from your client ID and
 *    secret with no browser step, and simply fetches a new one when it expires;
 *  - `token_auth` forces Basic or form-body client authentication;
 *  - `audience` is added to the authorisation and token requests.
 *
 * Two modes:
 *  - interactive (the owner pressed "Sign in" in the app): may start a new
 *    authorisation, returning the URL to send the browser to.
 *  - unattended (scheduled collection, "Check tools"): uses and refreshes the
 *    stored tokens, and if they're gone for good marks the account
 *    `needs_auth` instead of starting a sign-in nobody will finish.
 *
 * Some accounts don't go through MCP at all: Gmail and Google Calendar
 * (unless switched back to Google's MCP server) and Outlook mail and
 * calendar sign in at the provider's own OAuth endpoints, and their tools
 * call its REST API through an adapter registered in direct.ts. The
 * functions below hide that: an opened account offers the same tools either
 * way, and callTool's refusals apply to both.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  UnauthorizedError,
  type AddClientAuthentication,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  OAuthError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  consumeOAuthState,
  getConnector,
  getConnectorWithSecrets,
  markConnectorUsed,
  pinToolsFirstTime,
  recordChangedTools,
  saveConnectorSecrets,
  saveConnectorTools,
  saveServerInfo,
  setConnectorStatus,
  setOAuthState,
  toolNeedsApproval,
  toolTextHash,
  type Connector,
  type ConnectorSecrets,
  type ConnectorTool,
} from "../../../lib/connectors";
import { AthenaInputError } from "../../../lib/db";
import { canDraft, canMove, canRsvp, classifyTool, isCustomServer, CREATE_TOOL, EVENTS_SWITCH, MOVE_TOOL, oauthScope, ownClientName, presetFor, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";

/** The calendar writes behind "Let Athena add and update events", only through Athena's own adapters. */
const EVENT_WRITES = new Set([MOVE_TOOL, CREATE_TOOL, UNDO_CREATE_TOOL]);
import { publicFetch, resolveServerInfo } from "./icons";
import { notionWriteProblem } from "../../../lib/documents-rules";

/** MCP servers and their sign-in pages: never a private address, except a local server under `netlify dev`. */
const mcpFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
  process.env.NETLIFY_DEV === "true" ? fetch(input, init) : publicFetch(input, init);
import { directAccountProblem, directFailure, directFor, type DirectAccount, type DirectAdapter } from "./direct";
import { pkcePair } from "./google-api";
import { activeRules, guardedMcpGmail, mailGuard } from "./mail-guard";

const REQUEST_TIMEOUT_MS = 45_000;
/** Cap on one tool result handed to the model (characters). */
const MAX_RESULT_CHARS = 24_000;
/** Tools that send something (send_message, send_draft, reply, forward, slack_send_message, …): never called. */
const SENDS = /(^|[_\-.])(send|reply|forward)([_\-.]|$)/i;

export const CALLBACK_PATH = "/api/connectors/oauth/callback";

/** The account must be signed in again from the app. */
export class ConnectorNeedsSignIn extends Error {
  constructor(readonly connectorName: string) {
    super(`${connectorName} needs signing in again`);
    this.name = "ConnectorNeedsSignIn";
  }
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Machine-to-machine: tokens come from the client ID and secret, with no browser sign-in. */
function usesClientCredentials(connector: Pick<Connector, "auth_type" | "oauth">): boolean {
  return connector.auth_type === "oauth" && connector.oauth?.grant === "client_credentials";
}

const hasClientSecret = (secrets: ConnectorSecrets) => !!(secrets.ownClient?.client_id && secrets.ownClient.client_secret);

/**
 * Authorisation-server metadata built from the endpoints entered by hand, or
 * undefined to discover it. Browser sign-in needs both URLs; client
 * credentials only the token URL. The token URL's origin is the server
 * Athena's client and tokens are bound to.
 */
function manualServer(connector: Pick<Connector, "auth_type" | "oauth">): { url: string; metadata: OAuthMetadata } | undefined {
  const o = connector.oauth ?? {};
  const cc = usesClientCredentials(connector);
  if (!o.token_endpoint || (!cc && !o.authorization_endpoint)) return undefined;
  const url = new URL("/", o.token_endpoint).toString();
  return {
    url,
    metadata: {
      issuer: url,
      // Never used for client credentials, but the metadata shape requires one.
      authorization_endpoint: o.authorization_endpoint ?? o.token_endpoint,
      token_endpoint: o.token_endpoint,
      response_types_supported: ["code"],
      grant_types_supported: cc ? ["client_credentials"] : ["authorization_code", "refresh_token"],
      ...(o.token_auth ? { token_endpoint_auth_methods_supported: [o.token_auth] } : {}),
    },
  };
}

/** Expired, or about to be (a minute's grace), going by what the server said when it issued it. */
function tokenExpired(tokens: Record<string, unknown> | undefined): boolean {
  if (!tokens?.access_token) return true;
  const issued = typeof tokens.obtained_at === "number" ? tokens.obtained_at : 0;
  const life = typeof tokens.expires_in === "number" ? tokens.expires_in : 0;
  return !!issued && !!life && Date.now() > issued + (life - 60) * 1000;
}

class AthenaOAuthProvider implements OAuthClientProvider {
  /** Set by the SDK when a new authorisation is needed (interactive mode). */
  authorizationUrl?: URL;

  constructor(
    private readonly connector: Connector,
    readonly secrets: ConnectorSecrets,
    private readonly interactive: boolean,
  ) {}

  private persist(): Promise<void> {
    return saveConnectorSecrets(this.connector.id, this.secrets);
  }

  private get clientCredentials(): boolean {
    return usesClientCredentials(this.connector);
  }

  /** No redirect URL tells the SDK this is a non-interactive grant (client credentials). */
  get redirectUrl(): string | undefined {
    return this.clientCredentials ? undefined : this.secrets.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Athena",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: this.clientCredentials ? ["client_credentials"] : ["authorization_code", "refresh_token"],
      response_types: this.clientCredentials ? [] : ["code"],
      token_endpoint_auth_method: "none",
      ...(oauthScope(this.connector) ? { scope: oauthScope(this.connector) } : {}),
    };
  }

  /** Client credentials: the token request. Undefined lets the SDK build the authorization-code one. */
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (!this.clientCredentials) return undefined;
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope) params.set("scope", scope);
    if (this.connector.oauth?.audience) params.set("audience", this.connector.oauth.audience);
    return params;
  }

  /**
   * When the owner chose how to send their client secret, do exactly that
   * instead of letting the SDK pick from the server's metadata. Only applies
   * to your own client with a secret; a dynamically registered one says how
   * it authenticates in its registration.
   */
  get addClientAuthentication(): AddClientAuthentication | undefined {
    const method = this.connector.oauth?.token_auth;
    const own = this.secrets.ownClient;
    if (!method || !own?.client_id || !own.client_secret) return undefined;
    const { client_id, client_secret } = own;
    return (headers, params) => {
      if (method === "client_secret_basic") {
        headers.set("Authorization", `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString("base64")}`);
      } else {
        params.set("client_id", client_id);
        params.set("client_secret", client_secret);
      }
    };
  }

  async state(): Promise<string> {
    // Unattended runs must never start a sign-in: stop the SDK here.
    if (!this.interactive) throw new ConnectorNeedsSignIn(this.connector.name);
    const state = randomBytes(32).toString("base64url");
    await setOAuthState(this.connector.id, hashState(state));
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const own = this.secrets.ownClient;
    const registered = this.secrets.registered as OAuthClientInformationMixed | undefined;
    if (own?.client_id) {
      // Your own client; `registered` only carries the issuer the SDK stamped on it.
      return registered?.client_id === own.client_id ? registered : { ...own };
    }
    // A dynamic registration is tied to the redirect URI it was made with.
    if (registered && this.secrets.registeredRedirect === this.secrets.redirectUrl) return registered;
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.secrets.registered = info as Record<string, unknown>;
    this.secrets.registeredRedirect = this.secrets.redirectUrl;
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.secrets.tokens as OAuthTokens | undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Some servers omit the refresh token on refresh: keep the one we had.
    const previous = this.secrets.tokens as OAuthTokens | undefined;
    this.secrets.tokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? previous?.refresh_token,
      obtained_at: Date.now(),
    };
    await this.persist();
  }

  redirectToAuthorization(url: URL): void {
    if (this.connector.oauth?.audience) url.searchParams.set("audience", this.connector.oauth.audience);
    if (url.hostname === "accounts.google.com") {
      // Google only issues a refresh token for offline access, and only on consent.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
    }
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.secrets.codeVerifier = codeVerifier;
    await this.persist();
  }

  codeVerifier(): string {
    if (!this.secrets.codeVerifier) throw new Error("No sign-in in progress for this account");
    return this.secrets.codeVerifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.secrets.registered;
    if (scope === "all" || scope === "tokens") delete this.secrets.tokens;
    if (scope === "all" || scope === "verifier") delete this.secrets.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.secrets.discovery;
    await this.persist();
  }

  saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.secrets.discovery = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    return this.persist();
  }

  /**
   * Endpoints entered by hand win over discovery: the SDK treats them as
   * already discovered. Any protected-resource metadata (RFC 9728) found on
   * an earlier sign-in is kept, so the resource indicator is still sent.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    const stored = this.secrets.discovery as OAuthDiscoveryState | undefined;
    const manual = manualServer(this.connector);
    if (!manual) return stored;
    const same = stored?.authorizationServerUrl === manual.url;
    return {
      authorizationServerUrl: manual.url,
      authorizationServerMetadata: manual.metadata,
      resourceMetadata: same ? stored?.resourceMetadata : undefined,
      resourceMetadataUrl: same ? stored?.resourceMetadataUrl : undefined,
    };
  }
}

async function load(id: string): Promise<{ connector: Connector; secrets: ConnectorSecrets }> {
  const found = await getConnectorWithSecrets(id);
  if (!found) throw new AthenaInputError("Account not found", 404);
  return found;
}

/** What the provider is asked for: Athena's own markers left out (oauthScope). */
function scopeFor(connector: Connector): string | undefined {
  return oauthScope(connector) || undefined;
}

/** The provider refused Athena's client (wrong ID or secret, or not allowed this grant). */
const clientRejected = (error: unknown) => error instanceof InvalidClientError || error instanceof UnauthorizedClientError;

/**
 * What the server said in the body of a failed HTTP request, if anything
 * worth showing. Some servers (Google's MCP servers among them) answer a
 * request they refuse with an ordinary JSON-RPC reply — even the full tool
 * list — and signal the refusal only through the HTTP status, so a body that
 * isn't an error says nothing and is left out.
 */
function httpErrorDetail(error: StreamableHTTPError): string | undefined {
  const body = error.message.replace(/^Streamable HTTP error: (Error POSTing to endpoint|Failed to open SSE stream): /, "").trim();
  if (!body || body === error.message) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Plain text is shown (briefly); an HTML error page isn't.
    return body.startsWith("<") ? undefined : body.slice(0, 300);
  }
  const reply = parsed as { error?: { message?: unknown }; result?: { isError?: unknown; content?: unknown } };
  if (typeof reply?.error?.message === "string") return reply.error.message.slice(0, 300);
  if (reply?.result?.isError === true && Array.isArray(reply.result.content)) {
    const text = (reply.result.content as Array<{ text?: unknown }>)
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join(" ")
      .trim();
    if (text) return text.slice(0, 300);
  }
  return undefined;
}

/** An error's message, or its OAuth error code when the server sent no description. */
function describe(error: unknown): string {
  if (error instanceof StreamableHTTPError) {
    const detail = httpErrorDetail(error);
    if (error.code && error.code > 0) return `The server answered HTTP ${error.code}${detail ? `: ${detail}` : ""}`;
    return error.message.replace(/^Streamable HTTP error: /, "").slice(0, 300);
  }
  if (error instanceof OAuthError) return error.message || (error.constructor as { errorCode?: string }).errorCode || error.name;
  return error instanceof Error ? error.message : String(error);
}

/** Turn a failed sign-in into something the owner can act on. */
function signInError(connector: Connector, secrets: ConnectorSecrets, error: unknown): string {
  const message = describe(error);
  const cc = usesClientCredentials(connector);
  if (clientRejected(error)) {
    return cc
      ? `The token URL refused the client ID or secret (${message}). Check them under Edit.`
      : `${connector.name}'s provider refused the OAuth client (${message}). Check the client ID and secret under Edit.`;
  }
  const discovered = !!(secrets.discovery as OAuthDiscoveryState | undefined)?.authorizationServerMetadata;
  if (!manualServer(connector) && !discovered) {
    return cc
      ? `${connector.name}'s server doesn't publish its OAuth settings. Add the provider's token URL under OAuth settings, then try again.`
      : `${connector.name}'s server doesn't publish its OAuth settings. Add the provider's authorization and token URLs, and your own client ID, under OAuth settings, then try again.`;
  }
  if (!cc && !secrets.ownClient?.client_id && /registration/i.test(message)) {
    return `${connector.name}'s server doesn't let apps register themselves. Add your own OAuth client ID and secret, then try again.`;
  }
  return cc ? `Couldn't get a token: ${message}` : `Couldn't start sign-in: ${message}`;
}

// ---------- Interactive sign-in ----------

/**
 * Start (or restart) signing in. Returns the provider's authorisation URL to
 * send the browser to, or `authorized: true` if no browser step was needed.
 */
export async function beginSignIn(id: string, origin: string): Promise<{ authorizationUrl?: string; authorized?: true }> {
  const { connector, secrets } = await load(id);
  if (connector.auth_type !== "oauth") throw new AthenaInputError("This account signs in with a token, not OAuth");
  const direct = directFor(connector);
  if (direct) {
    const begun = await beginDirectSignIn(connector, secrets, origin, direct);
    return { authorizationUrl: await signInAddress(id, begun.authorizationUrl) };
  }
  const cc = usesClientCredentials(connector);
  if (cc && !hasClientSecret(secrets)) throw new AthenaInputError("Client credentials need your client ID and client secret. Add them under Edit.");
  // The owner asked to sign in: start fresh rather than silently refreshing,
  // and look the server's OAuth settings up again in case they've moved.
  delete secrets.tokens;
  delete secrets.codeVerifier;
  delete secrets.discovery;
  if (cc) delete secrets.redirectUrl;
  else secrets.redirectUrl = new URL(CALLBACK_PATH, origin).toString();
  const provider = new AthenaOAuthProvider(connector, secrets, true);
  await saveConnectorSecrets(id, secrets);
  let result: "AUTHORIZED" | "REDIRECT";
  try {
    result = await auth(provider, { serverUrl: connector.url, scope: scopeFor(connector), fetchFn: mcpFetch });
  } catch (error) {
    const message = describe(error);
    await setConnectorStatus(
      id,
      clientRejected(error) ? "needs_auth" : "error",
      `${cc ? "Couldn't get a token" : "Couldn't start sign-in"}: ${message}`,
    );
    throw new AthenaInputError(signInError(connector, provider.secrets, error));
  }
  if (result === "AUTHORIZED") {
    await setConnectorStatus(id, "connected");
    return { authorized: true };
  }
  if (!provider.authorizationUrl) throw new Error("The server didn't return a sign-in address");
  const authorizationUrl = await signInAddress(id, provider.authorizationUrl.toString());
  await setConnectorStatus(id, "needs_auth", "Waiting for you to finish signing in");
  return { authorizationUrl };
}

/** Is this an address the browser may be sent to for signing in: https (or a local server under `netlify dev`)? */
export function isSignInAddress(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "http:" && local && process.env.NETLIFY_DEV === "true";
  } catch {
    return false;
  }
}

/**
 * The sign-in address the app will open. A server's OAuth metadata chooses
 * it, so anything but https (a javascript: or data: URL, say) is refused.
 */
async function signInAddress(id: string, raw: string): Promise<string> {
  if (isSignInAddress(raw)) return raw;
  const detail = "The server's sign-in address isn't https, so Athena won't open it";
  await setConnectorStatus(id, "error", detail);
  throw new AthenaInputError(detail);
}

/**
 * An account reached directly (Google, Microsoft): the provider's own consent
 * page and token endpoint, the owner's client, PKCE, and the account's
 * scopes. No MCP discovery and no `resource` parameter.
 */
async function beginDirectSignIn(connector: Connector, secrets: ConnectorSecrets, origin: string, direct: DirectAdapter): Promise<{ authorizationUrl: string }> {
  if (!direct.authorizationUrl && !direct.beginSignIn) throw new AthenaInputError(`${connector.name} doesn't sign in with a browser`);
  const client = secrets.ownClient;
  if (!client?.client_id || (!client.client_secret && !direct.noClientSecret)) {
    throw new AthenaInputError(`${connector.name} needs your ${ownClientName(presetFor(connector.provider))} OAuth client ID${direct.noClientSecret ? "" : " and secret"}. Add ${direct.noClientSecret ? "it" : "them"} under Edit.`);
  }
  // Start fresh, as for any sign-in the owner asks for.
  const { verifier, challenge } = pkcePair();
  delete secrets.tokens;
  delete secrets.discovery;
  secrets.codeVerifier = verifier;
  secrets.redirectUrl = new URL(CALLBACK_PATH, origin).toString();
  await saveConnectorSecrets(connector.id, secrets);
  const state = randomBytes(32).toString("base64url");
  await setOAuthState(connector.id, hashState(state));
  // OAuth 1.0 (TripIt): a request token first, kept sealed until the callback.
  if (direct.beginSignIn) {
    const begun = await direct.beginSignIn({ client, redirectUri: secrets.redirectUrl, state }).catch(async (error) => {
      const detail = direct.failure(error)?.detail ?? "Couldn't start sign-in";
      await setConnectorStatus(connector.id, "needs_auth", detail);
      throw new AthenaInputError(detail);
    });
    secrets.codeVerifier = begun.verifier;
    await saveConnectorSecrets(connector.id, secrets);
    await setConnectorStatus(connector.id, "needs_auth", "Waiting for you to finish signing in");
    return { authorizationUrl: begun.url };
  }
  await setConnectorStatus(connector.id, "needs_auth", "Waiting for you to finish signing in");
  const scope = oauthScope(connector) || presetFor(connector.provider).scope;
  return { authorizationUrl: direct.authorizationUrl!({ clientId: client.client_id, redirectUri: secrets.redirectUrl, scope, state, challenge }) };
}

/** The OAuth callback: exchange the code for tokens. Returns the connector id. */
export async function finishSignIn(state: string, code: string): Promise<string> {
  const id = await consumeOAuthState(hashState(state));
  if (!id) throw new AthenaInputError("This sign-in link has expired or was already used. Start again from Athena.");
  const { connector, secrets } = await load(id);
  const direct = directFor(connector);
  if (direct) {
    try {
      if (!direct.exchangeCode || !secrets.ownClient?.client_id || !secrets.codeVerifier || !secrets.redirectUrl) throw new Error("No sign-in in progress for this account");
      const scope = oauthScope(connector) || presetFor(connector.provider).scope;
      secrets.tokens = { ...(await direct.exchangeCode({ code, redirectUri: secrets.redirectUrl, verifier: secrets.codeVerifier, scope, client: secrets.ownClient })) };
    } catch (error) {
      const message = describe(error);
      await setConnectorStatus(id, "error", `Sign-in failed: ${message}`);
      throw new AthenaInputError(`Sign-in failed: ${message}`);
    }
    delete secrets.codeVerifier;
    await saveConnectorSecrets(id, secrets);
    await setConnectorStatus(id, "connected");
    return id;
  }
  const provider = new AthenaOAuthProvider(connector, secrets, true);
  try {
    await auth(provider, { serverUrl: connector.url, authorizationCode: code, scope: scopeFor(connector), fetchFn: mcpFetch });
  } catch (error) {
    const message = describe(error);
    await setConnectorStatus(id, "error", `Sign-in failed: ${message}`);
    throw new AthenaInputError(`Sign-in failed: ${message}`);
  }
  delete provider.secrets.codeVerifier;
  await saveConnectorSecrets(id, provider.secrets);
  await setConnectorStatus(id, "connected");
  return id;
}

// ---------- Unattended use ----------

/** An account, open: an MCP client, or (Google, Microsoft) Athena's own adapter over the provider's API. */
export type OpenConnector =
  | { connector: Connector; client: Client; direct?: undefined; close: () => Promise<void> }
  | { connector: Connector; client?: undefined; direct: DirectAccount; close: () => Promise<void> };

/** A tool as collections and Ask see it, whichever way the account is reached. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
}

/** Connect to one account's MCP server (or the provider's API, for a direct account) with its stored credentials. */
export async function openConnector(id: string): Promise<OpenConnector> {
  const { connector, secrets } = await load(id);
  const direct = directFor(connector);
  if (direct) return openDirect(connector, secrets, direct);
  const url = new URL(connector.url);
  const headers: Record<string, string> = {};
  let authProvider: AthenaOAuthProvider | undefined;
  if (connector.auth_type === "token") {
    if (!secrets.token) throw new ConnectorNeedsSignIn(connector.name);
    headers.Authorization = `Bearer ${secrets.token}`;
  } else if (connector.auth_type === "oauth") {
    const cc = usesClientCredentials(connector);
    if (cc && !hasClientSecret(secrets)) {
      await setConnectorStatus(id, "needs_auth", "Add the client ID and secret");
      throw new ConnectorNeedsSignIn(connector.name);
    }
    if (!cc && !secrets.tokens) {
      await setConnectorStatus(id, "needs_auth", "Not signed in yet");
      throw new ConnectorNeedsSignIn(connector.name);
    }
    authProvider = new AthenaOAuthProvider(connector, secrets, false);
    // Client credentials have no refresh token: get a new access token up
    // front when it's missing or expired, rather than relying on the server
    // to answer 401 (some answer 403, or nothing useful, without a token).
    if (cc && tokenExpired(secrets.tokens)) {
      try {
        await auth(authProvider, { serverUrl: connector.url, scope: scopeFor(connector), fetchFn: mcpFetch });
      } catch (error) {
        throw await classifyFailure(connector, error);
      }
    }
  }
  const transport = new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers }, fetch: mcpFetch });
  const client = new Client({ name: "athena", version: "0.3.0" });
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw await classifyFailure(connector, error);
  }
  return { connector, client, close: () => client.close().catch(() => undefined) };
}

/** The account's stored tool list already matches what it offers directly (names and summaries)? */
const recorded = (stored: ConnectorTool[], tools: Array<{ name: string; summary: string }>) =>
  stored.map((t) => `${t.name}:${t.description}`).sort().join("\n") === tools.map((t) => `${t.name}:${t.summary}`).sort().join("\n");

/** Record a direct account's tools (Athena's own, so nothing to ask the provider) and where it connects. */
async function recordDirectTools(connector: Connector, direct: DirectAdapter): Promise<void> {
  // The account page shows each tool's plain summary; Claude gets the full description when it's listed for a run.
  const tools: ConnectorTool[] = direct.tools(connector).map((t) => ({
    name: t.name,
    description: t.summary,
    access: classifyTool(connector.provider, t.name, t.annotations),
  }));
  await saveConnectorTools(connector.id, tools, { ownTools: true });
  await saveServerInfo(connector.id, direct.serverInfo(connector));
}

/** A direct account (direct.ts), straight to the provider's API. */
async function openDirect(connector: Connector, secrets: ConnectorSecrets, adapter: DirectAdapter): Promise<OpenConnector> {
  if (connector.auth_type === "oauth" && !secrets.tokens) {
    await setConnectorStatus(connector.id, "needs_auth", "Not signed in yet");
    throw new ConnectorNeedsSignIn(connector.name);
  }
  let direct: DirectAccount;
  try {
    direct = await adapter.open(connector, secrets);
  } catch (error) {
    throw await classifyFailure(connector, error);
  }
  // First use since it went through Google's MCP server (or drafts were switched): list the tools it has now. The owner's choices are kept.
  if (connector.tools_checked_at && !recorded(connector.tools, direct.tools)) await recordDirectTools(connector, adapter);
  // It answered, so an earlier failure has passed.
  if (connector.status === "error" || connector.status === "pending") await setConnectorStatus(connector.id, "connected");
  return { connector, direct, close: async () => undefined };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** "Calendar MCP API" for calendarmcp.googleapis.com, and so on. */
function googleMcpApi(url: string): string {
  const service = /^([a-z]+?)mcp\./i.exec(hostOf(url))?.[1];
  return service ? `${service[0].toUpperCase()}${service.slice(1)} MCP API` : "service's MCP API";
}

/** Turn a connection/tool failure into a status on the account, and a clear error. */
export async function classifyFailure(connector: Connector, error: unknown): Promise<Error> {
  // The providers' own APIs (direct.ts: Google, Microsoft) say exactly what's wrong.
  const known = directFailure(error);
  if (known) {
    await setConnectorStatus(connector.id, known.status, known.detail);
    return known.status === "needs_auth" ? new ConnectorNeedsSignIn(connector.name) : new Error(`${connector.name}: ${known.detail}`);
  }
  const message = describe(error);
  const status = error instanceof StreamableHTTPError ? error.code : undefined;
  const authFailure =
    error instanceof ConnectorNeedsSignIn ||
    status === 401 ||
    error instanceof UnauthorizedError ||
    clientRejected(error) ||
    error instanceof InvalidGrantError ||
    error instanceof InvalidTokenError ||
    /\b401\b|unauthori[sz]ed|invalid_grant|invalid_token|invalid_client/i.test(message);
  // A refusal of a token we hold: the account didn't grant a permission Athena
  // asked for (Google lets you untick each one on its consent screen), or the
  // service's API is switched off for the OAuth client's project.
  if (status === 403) {
    const google = /\.googleapis\.com$/i.test(hostOf(connector.url));
    const api = google ? googleMcpApi(connector.url) : undefined;
    const detail =
      connector.auth_type === "token"
        ? "The server refused the token (HTTP 403). Check it has the access Athena needs"
        : `The server refused access (HTTP 403). Sign in again and allow every permission it asks for${
            api ? `, and check the ${api} is enabled in your Google Cloud project` : ""
          }`;
    await setConnectorStatus(connector.id, "needs_auth", detail);
    return new ConnectorNeedsSignIn(connector.name);
  }
  if (authFailure) {
    const detail =
      connector.auth_type === "token"
        ? "The server rejected the token"
        : usesClientCredentials(connector)
          ? "Couldn't get a token the server accepts. Check the client ID, secret, scope and audience"
          : "Sign in again";
    await setConnectorStatus(connector.id, "needs_auth", detail);
    return new ConnectorNeedsSignIn(connector.name);
  }
  await setConnectorStatus(connector.id, "error", message);
  return new Error(`${connector.name}: ${message}`);
}

/** List a server's tools and save them (with each one's read/write classification). */
export async function discoverTools(id: string): Promise<Connector> {
  const { connector } = await load(id);
  const direct = directFor(connector);
  if (direct) {
    // The tools are Athena's own; opening checks the sign-in and that the provider's API answers (and marks the account if not).
    await recordDirectTools(connector, direct);
    const open = await openConnector(id);
    await open.close();
    await setConnectorStatus(id, "connected");
    await markConnectorUsed(id);
    return (await getConnector(id))!;
  }
  const open = await openConnector(id);
  if (open.direct) throw new Error("This account is reached directly");
  try {
    const tools: ConnectorTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await open.client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS });
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: (t.description ?? "").slice(0, 600),
          access: classifyTool(open.connector.provider, t.name, t.annotations),
          // What the owner approves is the whole text, not the 600 characters shown.
          hash: toolTextHash(t.description, t.inputSchema),
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    // Built-in services have drawn marks in the app; only custom servers need their own logo.
    const info = await resolveServerInfo(open.client.getServerVersion() as Record<string, unknown> | undefined, open.connector.url, {
      withIcon: open.connector.provider === "custom",
      previous: open.connector.server_info,
    });
    await saveServerInfo(id, info);
    // Status first, so the row returned below says "connected".
    await setConnectorStatus(id, "connected");
    await markConnectorUsed(id);
    const saved = await saveConnectorTools(id, tools);
    return saved!;
  } catch (error) {
    throw error instanceof ConnectorNeedsSignIn ? error : await classifyFailure(open.connector, error);
  } finally {
    await open.close();
  }
}

/** Caps on a remote server's tool text handed to the model (characters). */
export const MAX_TOOL_DESCRIPTION = 900;
const MAX_SCHEMA_DESCRIPTION = 300;
const MAX_SCHEMA_CHARS = 8_000;

/** A remote tool's input schema with every description inside it cut short; one still too long is replaced by "any object". */
export function cappedSchema(schema: unknown): unknown {
  const cut = (v: unknown, depth: number): unknown => {
    if (depth > 12) return {};
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => cut(x, depth + 1));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = (k === "description" || k === "title") && typeof x === "string" ? x.slice(0, MAX_SCHEMA_DESCRIPTION) : cut(x, depth + 1);
    }
    return out;
  };
  const small = cut(schema ?? { type: "object" }, 0);
  return JSON.stringify(small).length > MAX_SCHEMA_CHARS ? { type: "object", additionalProperties: true } : small;
}

/**
 * The tools an account offers that a collection may call, with their input schemas.
 *
 * A custom server's tool is offered only while its description and schema still hash to
 * what the owner approved (tool_pins): one that changed is left out and marked on the
 * account's page. A server connected before pinning has its allowed tools pinned here.
 * Any remote server's description and schema are cut to a fixed length.
 */
export async function listAllowedTools(open: OpenConnector): Promise<ListedTool[]> {
  const allowed = new Set(open.connector.allowed_tools);
  // Re-check at run time: a tool that now looks like a write is dropped even if allowed before.
  const usable = (t: ListedTool) => allowed.has(t.name) && classifyTool(open.connector.provider, t.name, t.annotations) !== "write";
  if (open.direct) return open.direct.tools.filter(usable).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  const pinned = isCustomServer(open.connector.provider);
  const firstPins: Record<string, string> | null = pinned && !open.connector.tool_pins ? {} : null;
  const changed: Array<{ name: string; description: string; hash: string }> = [];
  const result: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await open.client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS });
    for (const t of page.tools) {
      if (!usable(t)) continue;
      if (pinned) {
        const hash = toolTextHash(t.description, t.inputSchema);
        if (firstPins) firstPins[t.name] = hash;
        else if (toolNeedsApproval(open.connector, t.name, hash)) {
          changed.push({ name: t.name, description: (t.description ?? "").slice(0, 600), hash });
          continue;
        }
      }
      result.push({ ...t, description: (t.description ?? "").slice(0, MAX_TOOL_DESCRIPTION), inputSchema: cappedSchema(t.inputSchema) });
    }
    cursor = page.nextCursor;
  } while (cursor && result.length < 200);
  if (firstPins) {
    await pinToolsFirstTime(open.connector.id, firstPins);
    open.connector.tool_pins = firstPins;
  }
  if (changed.length) await recordChangedTools(open.connector.id, changed);
  return result;
}

const capped = (text: string) =>
  text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters — narrow the query to see the rest]` : text;

/**
 * Call one tool and flatten its result to text for the model. `full` keeps the whole result, uncut:
 * only for code that parses it itself (the work sync, work-sync.ts), never for text that goes to Claude.
 */
export async function callTool(open: OpenConnector, name: string, args: Record<string, unknown>, opts: { full?: boolean } = {}): Promise<{ text: string; isError: boolean }> {
  // Athena never sends anything on the owner's behalf, whatever a server calls it.
  if (SENDS.test(name)) throw new Error(`Athena doesn't call ${name}: it never sends on your behalf`);
  // Answering invites only goes through Athena's own calendar adapters (google-calendar.ts, microsoft-calendar.ts).
  if (name === RSVP_TOOL && !open.direct) throw new AthenaInputError(`Athena can't answer invites through ${open.connector.name}'s server`);
  if (EVENT_WRITES.has(name) && !open.direct) throw new AthenaInputError(`Athena can't change events through ${open.connector.name}'s server`);
  if (open.direct) {
    // The owner's switches, not an account problem: input errors, so nothing marks the account for them.
    if (name === "create_draft" && !canDraft(open.connector)) throw new AthenaInputError(`Drafts aren't turned on for ${open.connector.name}`);
    if (name === RSVP_TOOL && !canRsvp(open.connector)) throw new AthenaInputError(`“Let Athena answer invites” isn't on for ${open.connector.name}`);
    if (EVENT_WRITES.has(name) && !canMove(open.connector)) throw new AthenaInputError(`“${EVENTS_SWITCH}” isn't on for ${open.connector.name}`);
    // The write allowlist: these, each behind its switch above. Any other write is refused.
    const tool = open.direct.tools.find((t) => t.name === name);
    if (tool && name !== "create_draft" && name !== RSVP_TOOL && !EVENT_WRITES.has(name) && classifyTool(open.connector.provider, name, tool.annotations) === "write") {
      throw new AthenaInputError(`Athena doesn't call ${name}: it only reads from ${open.connector.name}`);
    }
    try {
      const r = await open.direct.call(name, args);
      return { text: opts.full ? r.text : capped(r.text), isError: r.isError };
    } catch (error) {
      // Signed out, a permission missing, the API off: say so on the account. Anything else is this call's own failure.
      throw directAccountProblem(error) ? await classifyFailure(open.connector, error) : error;
    }
  }
  // Gmail on Google's MCP server: the owner's mail rules still apply (mail-guard.ts).
  if (open.connector.provider === "gmail") {
    const guard = mailGuard(open.connector);
    const rules = (() => {
      try {
        return activeRules(guard);
      } catch (error) {
        return error as Error;
      }
    })();
    if (rules instanceof Error) return { text: rules.message, isError: true };
    if (rules) {
      const r = await guardedMcpGmail(rules, name, args, (a) => mcpCall(open.client, name, a));
      return { text: capped(r.text), isError: r.isError };
    }
  }
  return mcpCall(open.client, name, args, opts.full);
}

/** One tool call to an MCP server, its result flattened to text. */
async function mcpCall(client: Client, name: string, args: Record<string, unknown>, full = false): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS });
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "resource" && item.resource && typeof (item.resource as { text?: unknown }).text === "string") {
      parts.push((item.resource as { text: string }).text);
    } else if (item.type === "image" || item.type === "audio") parts.push(`[${item.type} omitted]`);
  }
  if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n\n") || "(no content)";
  return { text: full ? text : capped(text), isError: result.isError === true };
}

// ---------- Notion: pages Athena creates (lib/documents.ts) ----------
//
// The one way Athena writes to a Notion account, and only with "Let Athena
// create pages" on (a parent page chosen). Kept apart from callTool: no
// collection, Ask answer or Claude reaches it. notionWriteProblem
// (lib/documents-rules.ts) allows exactly notion-create-pages under that
// parent, notion-update-page on a page in Athena's own list, and (for
// Undo) notion-move-pages of one of those pages under Athena's own
// "Removed by Athena" page; anything else is refused before it leaves Athena.

export async function callNotionWrite(
  open: OpenConnector,
  name: string,
  args: Record<string, unknown>,
  rules: { parentId: string | null; own: ReadonlySet<string>; removedId?: string | null },
): Promise<{ text: string; isError: boolean }> {
  if (open.connector.provider !== "notion" || !open.client) throw new AthenaInputError("Only Notion accounts can have pages made");
  const problem = notionWriteProblem(name, args, rules);
  if (problem) throw new AthenaInputError(`Athena won't do that in Notion: ${problem}`);
  return mcpCall(open.client, name, args);
}
