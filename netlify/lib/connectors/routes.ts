/**
 * REST routes for connectors and collections, mounted by netlify/functions/api.ts
 * behind the same bearer token as the rest of /api/* — except the OAuth
 * callback, which a provider redirects the browser to (no bearer header can
 * ride along) and is protected by the single-use `state` instead.
 *
 *   GET    /api/connectors                      accounts, collections (with current_run and last_run), setup flags
 *                                               and setup.own_clients (names only)
 *   POST   /api/connectors                      add an account; client_from: <account id> reuses that account's own client;
 *                                               username (iCloud's Apple ID) goes with token, or key_from: <account id> copies both
 *   PATCH  /api/connectors/:id                  rename, label, scope, allowed tools, token, username, OAuth client/settings,
 *                                               google_route ("direct" or "mcp": how Gmail or Calendar reaches Google);
 *                                               custom servers: approve_tools: [names] (a changed tool, at its new text),
 *                                               use_in_ask and share_collections (booleans, both off by default)
 *   DELETE /api/connectors/:id                  remove it and its stored credentials
 *   POST   /api/connectors/:id/sign-in          → { authorization_url } to open
 *   POST   /api/connectors/:id/check            list its tools now
 *   GET    /api/connectors/oauth/callback       (no bearer) provider redirect target
 *   GET    /api/connectors/:id/calendars        calendar accounts: every calendar, how busy, and whether Athena reads it
 *                                               (PATCH `calendars: [ids]` chooses for Google and Outlook; iCloud uses `scope`)
 *   GET    /api/connectors/:id/mail             Gmail and Outlook: the owner's mail rules, and emails they kept from runs this week
 *                                               (PATCH `mail_rules` saves them, sealed)
 *   GET    /api/connectors/:id/mail/labels      the account's labels or folders a rule can name
 *   POST   /api/connectors/:id/mail/preview     { rules } → the last 24 hours under them, and the busiest senders (counts only)
 *   GET    /api/connectors/:id/watch-history    YouTube only: the owner's zone and the Life log the days go into
 *   POST   /api/connectors/:id/watch-history    YouTube only: { days, metrics, file } from a Takeout file, folded into the Life log
 *   GET    /api/connectors/:id/library          Goodreads only: the Life log the books go into, and the last import
 *   POST   /api/connectors/:id/library          Goodreads only: { days, metrics, file } from an Export library CSV, under Read
 *   GET    /api/connectors/:id/viewing          Netflix only: the Life log the days go into, and the last import
 *   POST   /api/connectors/:id/viewing          Netflix only: { days, file } from a viewing activity CSV, under Watched
 *   GET    /api/connectors/:id/backfill         accounts with history: how far loading it has got (backfill.ts), and a Takeout import that covers more
 *   POST   /api/connectors/:id/backfill         load the account's history again, from the newest page
 *   GET    /api/collections                     list (with current_run and last_run)
 *   POST   /api/collections                     create
 *   PATCH  /api/collections/:id                 edit / enable / disable
 *   DELETE /api/collections/:id                 remove (its runs go too)
 *   POST   /api/collections/:id/run             run now (in the background)
 *   GET    /api/collections/:id/runs            recent runs
 *   GET    /api/collections/:id/runs/:run/items what that run saved (names and dates)
 */
import { MOT_TOKEN_URL } from "../car-api";
import {
  approveTools,
  createConnector,
  deleteCollection,
  deleteConnector,
  getCollection,
  getConnector,
  getConnectorWithSecrets,
  hasOpenRun,
  listCollectionsWithRuns,
  listConnectors,
  listRunItems,
  listRuns,
  ownClientFrom,
  ownClientsSummary,
  queueRun,
  sameOrigin,
  setAllowedTools,
  setConnectorStatus,
  updateConnector,
  updateConnectorSecrets,
  upsertCollection,
  consumeOAuthState,
  sameOAuthSettings,
  validateOAuthSettings,
  mailSkipsSince,
  saveMailRules,
  type CollectionInput,
  type Connector,
  type ConnectorSecrets,
} from "../../../lib/connectors";
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { secretBoxConfigured } from "../../../lib/secret-box";
import {
  collectionSource,
  NO_MODEL_RECIPES,
  GOOGLE_API_URL,
  GOOGLE_MCP_URL,
  isGoogleProvider,
  presetFor,
  canRsvp,
  MOVE_MARKER,
  RSVP_SCOPE,
  type ConnectorAuthType,
  type ConnectorOAuthSettings,
  type RecipeId,
  isCustomServer,
} from "../../../lib/connector-presets";
import { isMicrosoftProvider } from "../../../lib/presets/microsoft";
import { directFor } from "./direct";
import { LifeApiError } from "./lifelog-b-http";
import { forgetBackfill } from "./money-sync";
import { withoutAccount } from "../../../lib/presets/octopus-meters";
import { icloudCalendarChoices } from "./icloud-direct";
import { readCalendarIds } from "./calendar-choice";
import { beginSignIn, CALLBACK_PATH, discoverTools, finishSignIn, hashState, ConnectorNeedsSignIn, openConnector } from "./mcp-client";
import { aiConfigured } from "./runner";
import { historyTarget, importDays, lastImport, readDays, rememberImport } from "./youtube-history";
import { backfillStatus, forgetHistory, getBackfill, startBackfill } from "./backfill";
import { importBooks, libraryTarget, readBookDays, rememberImportedBooks } from "./goodreads-library";
import { importViewing, readViewingDays, viewingTarget } from "./netflix-history";
import { sendPendingAnswers } from "../../../lib/rsvp";
import { calendarPort } from "./calendar-rsvp";
import { triggerRuns } from "./trigger";
import { readRules } from "../../../lib/mail-rules";
import { DataKeyMissing } from "../../../lib/data-box";
import { zonedToday } from "../../../lib/dates";

/** Accounts whose email the owner's mail rules govern (lib/mail-rules.ts). */
const READS_MAIL = new Set(["gmail", "outlook-mail", "fastmail"]);

/** The account opened, for its labels or the rules' preview. A sign-in problem is the owner's to fix, said plainly. */
async function withMail<T>(id: string, run: (mail: NonNullable<NonNullable<Awaited<ReturnType<typeof openConnector>>["direct"]>["mail"]>) => Promise<T>): Promise<T> {
  let open;
  try {
    open = await openConnector(id);
  } catch (error) {
    if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again`);
    throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach your email");
  }
  try {
    if (!open.direct?.mail) throw new AthenaInputError("This account reaches its email through Google's MCP server, so Athena can't count it. Your rules still apply.");
    return await run(open.direct.mail);
  } catch (error) {
    if (error instanceof AthenaInputError) throw error;
    throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach your email");
  } finally {
    await open.close();
  }
}

type Json = (data: unknown, status?: number) => Response;

/** Accounts whose calendars the owner picks in `calendars` (iCloud picks in `scope`). */
const CHOOSES_CALENDARS = new Set(["google-calendar", "outlook-calendar"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTH_TYPES = new Set<ConnectorAuthType>(["oauth", "token", "none"]);
const RECIPE_IDS = new Set<RecipeId>(["calendar-meetings", "calendar-sync", "email-digest", "work-activity", "life-log", "plays-watches", "work-sync", "home", "custom"]);

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object") return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Invalid JSON body");
}

const str = (b: Record<string, unknown>, k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);

/**
 * `google_route` in a request: how a Gmail or Google Calendar account reaches
 * Google. "direct" (Google's REST APIs, the default) or "mcp" (Google's MCP
 * server). Undefined when the request doesn't say.
 */
function googleRoute(b: Record<string, unknown>, provider: string, authType: ConnectorAuthType): "direct" | "mcp" | undefined {
  const route = str(b, "google_route");
  if (route === undefined) return undefined;
  if (!isGoogleProvider(provider) || authType !== "oauth") throw new AthenaInputError("Only Gmail and Google Calendar accounts can switch how they reach Google");
  if (route !== "direct" && route !== "mcp") throw new AthenaInputError("google_route must be direct or mcp");
  return route;
}

/** The OAuth settings with the route applied, and the address that goes with it. */
function withGoogleRoute(oauth: ConnectorOAuthSettings, provider: string, route: "direct" | "mcp"): { oauth: ConnectorOAuthSettings; url: string } {
  const next = { ...oauth };
  if (route === "mcp") next.google_route = "mcp";
  else delete next.google_route;
  const p = provider as keyof typeof GOOGLE_API_URL;
  return { oauth: next, url: route === "mcp" ? GOOGLE_MCP_URL[p] : GOOGLE_API_URL[p] };
}

function setup(origin: string, connectors: Connector[]) {
  return {
    encryption: secretBoxConfigured(),
    ai: aiConfigured(),
    callback_url: new URL(CALLBACK_PATH, origin).toString(),
    // Which account's Google or Microsoft setup a new account can reuse: names only, never the client.
    own_clients: ownClientsSummary(connectors),
  };
}

// ---------- connectors ----------

async function createFromBody(b: Record<string, unknown>) {
  const provider = str(b, "provider") ?? "custom";
  const preset = presetFor(provider);
  const authType = (str(b, "auth_type") ?? preset.auth) as ConnectorAuthType;
  if (!AUTH_TYPES.has(authType)) throw new AthenaInputError("auth_type must be oauth, token or none");
  const secrets: ConnectorSecrets = {};
  const token = str(b, "token")?.trim();
  if (authType === "token") secrets.token = token;
  // A key that goes with a username (an Apple ID): both sealed together, or both copied from another account.
  if (authType === "token" && preset.username) Object.assign(secrets, await usernameAndKey(b, preset.id, token));
  // A key with a client and token URL (DVSA's MOT History): all four sealed together.
  if (authType === "token" && preset.clientCredentials) Object.assign(secrets, clientCredentials(b));
  const clientFrom = str(b, "client_from");
  let clientId = str(b, "client_id")?.trim();
  if (authType === "oauth" && clientId) {
    secrets.ownClient = { client_id: clientId, client_secret: str(b, "client_secret")?.trim() || undefined };
  }
  if (clientFrom) {
    if (authType !== "oauth") throw new AthenaInputError("This account uses a key, so there's no Google or Microsoft setup to reuse");
    if (clientId) throw new AthenaInputError("Send client_from or a client ID, not both");
    if (!UUID_RE.test(clientFrom)) throw new AthenaInputError("client_from must be an account id");
    // Copied sealed-to-sealed on the server; the client never reaches the app.
    secrets.ownClient = await ownClientFrom(clientFrom, preset.id);
    clientId = secrets.ownClient.client_id;
  }
  if (authType === "oauth" && preset.needsOwnClient && !clientId) {
    throw new AthenaInputError(`${preset.label} needs your own OAuth client ID and secret`);
  }
  let oauth = authType === "oauth" ? validateOAuthSettings(b.oauth) : {};
  // A server Athena can't register with by itself needs your client for the endpoints you entered.
  if (oauth.authorization_endpoint && !clientId) {
    throw new AthenaInputError("With your own authorization and token URLs, add your OAuth client ID too");
  }
  // Outlook goes to Microsoft Graph, whatever address is sent.
  let url = isMicrosoftProvider(preset.id) ? preset.url : str(b, "url") || preset.url;
  // A profile or feed address (Letterboxd, Goodreads): only the service's own, refused here if not.
  url = directFor({ provider: preset.id, auth_type: authType, oauth })?.checkAddress?.(url) ?? url;
  // Gmail and Google Calendar call Google's APIs directly, unless asked to use Google's MCP server.
  if (authType === "oauth" && isGoogleProvider(preset.id)) {
    ({ oauth, url } = withGoogleRoute(oauth, preset.id, googleRoute(b, preset.id, authType) ?? "direct"));
  }
  return createConnector({
    name: str(b, "name") ?? "",
    provider: preset.id,
    account_label: str(b, "account_label"),
    url,
    auth_type: authType,
    scope: str(b, "scope") ?? preset.scope,
    oauth,
    secrets,
  });
}

/** DVSA's client ID, secret and token URL, beside its API key. The token URL must be Microsoft Entra's, so the secret goes nowhere else. */
function clientCredentials(b: Record<string, unknown>): Pick<ConnectorSecrets, "ownClient" | "tokenUrl"> {
  const client_id = str(b, "client_id")?.trim();
  const client_secret = str(b, "client_secret")?.trim();
  const tokenUrl = str(b, "token_url")?.trim();
  if (!client_id || !client_secret) throw new AthenaInputError("Paste the client ID and client secret");
  if (client_id.length > 200 || client_secret.length > 500) throw new AthenaInputError("That client ID or secret is too long");
  if (!tokenUrl || !MOT_TOKEN_URL.test(tokenUrl)) throw new AthenaInputError("Paste the token URL from DVSA's email. It starts https://login.microsoftonline.com/");
  return { ownClient: { client_id, client_secret }, tokenUrl };
}

/**
 * The username and key for a service that takes both (iCloud: an Apple ID and
 * an app-specific password). `key_from` copies them, sealed to sealed, from
 * another account that signs in the same way, so one password covers
 * Calendar and Contacts; they never reach the app.
 */
async function usernameAndKey(b: Record<string, unknown>, provider: string, token: string | undefined): Promise<Pick<ConnectorSecrets, "token" | "username">> {
  const label = presetFor(provider).username!.label;
  const from = str(b, "key_from");
  if (from) {
    if (token) throw new AthenaInputError("Send key_from or a key, not both");
    if (!UUID_RE.test(from)) throw new AthenaInputError("key_from must be an account id");
    const found = await getConnectorWithSecrets(from).catch(() => null);
    if (!found) throw new AthenaInputError("The account to copy from no longer exists");
    if (found.connector.auth_type !== "token" || presetFor(found.connector.provider).username?.label !== label || !found.secrets.token || !found.secrets.username) {
      throw new AthenaInputError(`${found.connector.name} has no ${label} to reuse`);
    }
    return { token: found.secrets.token, username: found.secrets.username };
  }
  const username = str(b, "username")?.trim();
  if (!username) throw new AthenaInputError(`Add your ${label}`);
  if (username.length > 200) throw new AthenaInputError(`That ${label} is too long`);
  return { token, username };
}

/**
 * Other accounts holding the same username and key (iCloud Calendar and
 * Contacts after key_from, either way round): a new password for one is a new
 * password for them too.
 */
async function sharingKey(id: string, pair: Pick<ConnectorSecrets, "token" | "username">): Promise<string[]> {
  const me = await getConnector(id);
  const label = me ? presetFor(me.provider).username?.label : undefined;
  if (!label || !pair.token || !pair.username) return [];
  const others = (await listConnectors()).filter((c) => c.id !== id && c.auth_type === "token" && presetFor(c.provider).username?.label === label);
  const found = await Promise.all(others.map((c) => getConnectorWithSecrets(c.id).catch(() => null)));
  return found.filter((f) => f && f.secrets.token === pair.token && f.secrets.username === pair.username).map((f) => f!.connector.id);
}

/** Google Calendar or Outlook: every calendar, through the account's own connection, so a refreshed sign-in is kept. */
async function calendarChoices(id: string) {
  let open;
  try {
    open = await openConnector(id);
  } catch (error) {
    if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again`);
    throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach the calendar");
  }
  try {
    if (!open.direct?.calendars) throw new AthenaInputError("This account can't list its calendars");
    return await open.direct.calendars();
  } catch (error) {
    if (error instanceof AthenaInputError) throw error;
    throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach the calendar");
  } finally {
    await open.close();
  }
}

/**
 * POST /api/connectors/find-address { provider, query, token | connector_id }:
 * read-only, with the key just pasted or the account's own (never sent back).
 */
async function findAddress(b: Record<string, unknown>) {
  const provider = str(b, "provider") ?? "";
  const adapter = presetFor(provider).address?.fields?.finder ? directFor({ provider, auth_type: "token", oauth: {} }) : undefined;
  if (!adapter?.findAddress) throw new AthenaInputError("That service can't look up its address", 404);
  let secrets: ConnectorSecrets = { token: str(b, "token")?.trim() || undefined };
  const from = str(b, "connector_id");
  if (!secrets.token && from) {
    if (!UUID_RE.test(from)) throw new AthenaInputError("connector_id must be an account id");
    const found = await getConnectorWithSecrets(from).catch(() => null);
    if (!found || found.connector.provider !== provider) throw new AthenaInputError("Account not found", 404);
    secrets = found.secrets;
  }
  try {
    return await adapter.findAddress(str(b, "query") ?? "", secrets);
  } catch (error) {
    if (error instanceof LifeApiError) throw new AthenaInputError(error.message);
    throw error;
  }
}

async function patchConnector(id: string, b: Record<string, unknown>) {
  if (Array.isArray(b.allowed_tools)) {
    await setAllowedTools(id, b.allowed_tools.filter((t): t is string => typeof t === "string"));
  }
  if (Array.isArray(b.approve_tools)) {
    await approveTools(id, b.approve_tools.filter((t): t is string => typeof t === "string"));
  }
  const connector = await getConnector(id);
  if (!connector) throw new AthenaInputError("Account not found", 404);
  const route = googleRoute(b, connector.provider, connector.auth_type);
  const token = str(b, "token")?.trim();
  // A new username (Apple ID) for a service that takes one with its key; sealed with it.
  const username = connector.auth_type === "token" && presetFor(connector.provider).username ? str(b, "username")?.trim() : undefined;
  if (username && username.length > 200) throw new AthenaInputError("That username is too long");
  const clientId = str(b, "client_id")?.trim();
  const clientSecret = str(b, "client_secret")?.trim();
  // DVSA's MOT History: the API key, client ID, secret and token URL are replaced together, checked as when added.
  const withClient = connector.auth_type === "token" && !!presetFor(connector.provider).clientCredentials;
  const anyClient = !!(clientId || clientSecret || str(b, "token_url"));
  if (withClient && (anyClient || token) && !(anyClient && token)) throw new AthenaInputError("Paste all four from DVSA's email: client ID, client secret, API key and token URL");
  const creds = withClient && token ? clientCredentials(b) : undefined;
  // A secret on its own replaces the stored client's secret (rotation), keeping its ID.
  const secretOnly = !withClient && !clientId && !!clientSecret && connector.has_own_client;
  // Only OAuth accounts have OAuth settings; `oauth` replaces them wholesale.
  const oauth = connector.auth_type === "oauth" && b.oauth !== undefined ? validateOAuthSettings(b.oauth) : undefined;
  const oauthChanged = !!oauth && !sameOAuthSettings(oauth, connector.oauth);
  const scope = str(b, "scope");
  // iCloud Calendar keeps the calendars it reads in `scope`: ids only, and its invites switch.
  if (scope !== undefined && connector.provider === "icloud-calendar" && (scope.length > 4000 || scope.split(/\s+/).filter(Boolean).some((id) => id !== RSVP_SCOPE["icloud-calendar"] && id !== MOVE_MARKER && !/^[\w.@%~+-]{1,200}$/.test(id)))) {
    throw new AthenaInputError("Those aren't calendar ids");
  }
  const scopeChanged = connector.auth_type === "oauth" && scope !== undefined && scope.trim() !== connector.scope;
  // An address asked for as fields (Octopus's meters) can change under Edit, checked by the adapter as when it was added.
  const fieldsAddress = presetFor(connector.provider).address?.fields ? str(b, "url") : undefined;
  const newUrl = fieldsAddress !== undefined ? directFor(connector)?.checkAddress?.(fieldsAddress) : undefined;
  const urlChanged = !!newUrl && newUrl !== connector.url;
  if (oauth) {
    const hasClient = !!clientId || connector.has_own_client;
    const hasSecret = clientId || secretOnly ? !!clientSecret : connector.has_client_secret;
    if (oauth.grant === "client_credentials" && !(hasClient && hasSecret)) throw new AthenaInputError("Client credentials need your client ID and client secret");
    if (oauth.authorization_endpoint && !hasClient) throw new AthenaInputError("With your own authorization and token URLs, add your OAuth client ID too");
  }
  // A new client, new endpoints or a new grant make the stored sign-in
  // meaningless (tokens and registrations are bound to the old server).
  const signOut = connector.auth_type === "oauth" && (!!clientId || oauthChanged);
  // A new host gets none of the old sign-in (lib/connectors.ts clears it), so the
  // address moves first and a key pasted with it is sealed for the new one.
  const hostMoved = urlChanged && !sameOrigin(connector.url, newUrl!);
  if (hostMoved) await updateConnector(id, { url: newUrl });
  // iCloud: the accounts that shared the old password get the new one too.
  const siblings = (token || username) && presetFor(connector.provider).username ? await sharingKey(id, (await getConnectorWithSecrets(id))?.secrets ?? {}) : [];
  if (token || username || signOut || scopeChanged || secretOnly) {
    for (const other of siblings) {
      await updateConnectorSecrets(other, (s) => {
        if (token) s.token = token;
        if (username) s.username = username;
      });
      await setConnectorStatus(other, "pending", "New token saved. Check tools to confirm it works");
    }
    await updateConnectorSecrets(id, (s) => {
      if (token) s.token = token;
      if (username) s.username = username;
      if (creds) Object.assign(s, creds);
      else if (clientId) s.ownClient = { client_id: clientId, client_secret: clientSecret || undefined };
      if (secretOnly && s.ownClient) {
        s.ownClient = { ...s.ownClient, client_secret: clientSecret };
        // `registered` holds a copy of your client stamped with its server, old secret included.
        delete s.registered;
        // Client credentials: the next token comes from the new secret, proving it works.
        if (connector.oauth?.grant === "client_credentials") delete s.tokens;
      }
      if (signOut) {
        delete s.registered;
        delete s.registeredRedirect;
        delete s.tokens;
        delete s.codeVerifier;
        delete s.discovery;
      }
      // Client credentials hold no refresh token: drop the access token so the next one asks for the new scope.
      if (scopeChanged && connector.oauth?.grant === "client_credentials") delete s.tokens;
    });
    if (token || username) await setConnectorStatus(id, "pending", "New token saved. Check tools to confirm it works");
    if (signOut) await setConnectorStatus(id, "needs_auth", "OAuth settings changed. Sign in again");
  }
  // Gmail and Google Calendar: switching between Google's APIs and its MCP server keeps the sign-in
  // (Google's tokens are scoped by permission, not server); other OAuth edits keep the route as it was.
  let save: { oauth?: ConnectorOAuthSettings; url?: string } = { oauth };
  if (isGoogleProvider(connector.provider) && connector.auth_type === "oauth" && (oauth || route)) {
    save = withGoogleRoute(oauth ?? connector.oauth, connector.provider, route ?? (connector.oauth.google_route === "mcp" ? "mcp" : "direct"));
    if (!route) delete save.url;
  }
  // Google Calendar and Outlook: the calendars Athena reads, kept apart from their OAuth scopes.
  const calendars = b.calendars !== undefined && CHOOSES_CALENDARS.has(connector.provider) ? readCalendarIds(b.calendars) : undefined;
  // Gmail and Outlook: which emails Athena reads, sealed under the data key.
  if (b.mail_rules !== undefined && READS_MAIL.has(connector.provider)) {
    try {
      await saveMailRules(id, readRules(b.mail_rules));
    } catch (error) {
      if (error instanceof DataKeyMissing) throw new AthenaInputError("Set ATHENA_DATA_KEY on the server before saving email rules");
      throw error;
    }
  }
  if (urlChanged) {
    save.url = newUrl;
    // A meter added later gets its history read too. Octopus's account number alone (for costs) moves no meter.
    if (connector.provider !== "octopus" || withoutAccount(connector.url) !== withoutAccount(newUrl)) {
      await forgetBackfill(id);
      await forgetHistory(id);
      // A moved account that needs a key or sign-in already says so.
      if (!token && !(hostMoved && connector.auth_type !== "none")) await setConnectorStatus(id, "pending", "New address saved. Check tools to confirm it works");
    }
  }
  // Custom servers only: whether Ask's answers may use it, and whether it may share a collection with other accounts.
  const custom = isCustomServer(connector.provider);
  const use_in_ask = custom && typeof b.use_in_ask === "boolean" ? b.use_in_ask : undefined;
  const share_collections = custom && typeof b.share_collections === "boolean" ? b.share_collections : undefined;
  // Google's API and MCP addresses are both Google's, so a route switch keeps the sign-in.
  const updated = await updateConnector(id, { name: str(b, "name"), account_label: str(b, "account_label"), scope, calendars, use_in_ask, share_collections, ...save }, { keepSignIn: !!route });
  if (!updated) throw new AthenaInputError("Account not found", 404);
  // iCloud has no sign-in to finish: answers given while its invites switch was off go out now.
  if (connector.provider === "icloud-calendar" && canRsvp(updated) && !canRsvp(connector)) await sendPendingAnswers(id, { calendar: calendarPort }).catch(() => 0);
  return updated;
}

// ---------- collections ----------

function collectionInput(b: Record<string, unknown>, existing?: { recipe: RecipeId; name: string; label: string }): CollectionInput {
  const recipe = str(b, "recipe");
  if (recipe !== undefined && !RECIPE_IDS.has(recipe as RecipeId)) throw new AthenaInputError("Unknown recipe");
  const schedule = str(b, "schedule");
  if (schedule !== undefined && !["daily", "hourly", "manual"].includes(schedule)) throw new AthenaInputError("schedule must be daily, hourly or manual");
  const ids = Array.isArray(b.connector_ids) ? b.connector_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : undefined;
  const input: CollectionInput = {
    name: str(b, "name"),
    recipe: recipe as RecipeId | undefined,
    connector_ids: ids,
    label: str(b, "label"),
    instructions: str(b, "instructions"),
    schedule: schedule as CollectionInput["schedule"],
    run_at: b.run_at === null ? null : str(b, "run_at"),
    every_hours: typeof b.every_hours === "number" ? Math.floor(b.every_hours) : b.every_hours === null ? null : undefined,
    lookback_hours: typeof b.lookback_hours === "number" ? Math.floor(b.lookback_hours) : undefined,
    lookahead_days: typeof b.lookahead_days === "number" ? Math.floor(b.lookahead_days) : undefined,
    event_push: typeof b.event_push === "boolean" ? b.event_push : undefined,
    skip_quiet: typeof b.skip_quiet === "boolean" ? b.skip_quiet : undefined,
    enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
  };
  // The source tag follows the recipe, name and label; it isn't set directly.
  const r = input.recipe ?? existing?.recipe ?? "custom";
  const name = input.name ?? existing?.name ?? "";
  const label = input.label ?? existing?.label ?? "";
  input.source = collectionSource(r, name, label);
  return input;
}

// ---------- OAuth callback ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A tiny page that sends the browser back into the app. It's a same-site
 * navigation from here, so the SameSite=Strict session cookie rides along
 * (a direct 303 from the provider's cross-site redirect wouldn't carry it).
 */
function returnPage(title: string, message: string, target: string, status = 200): Response {
  const href = escapeHtml(target);
  return new Response(
    `<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="1; url=${href}"><title>${escapeHtml(title)} · Athena</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;font:400 16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:400px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;opacity:.8}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="${href}">Back to Athena</a></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

export async function handleOAuthCallback(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const state = url.searchParams.get("state") ?? "";
  // OAuth 1.0 (TripIt) comes back with oauth_token rather than code.
  const code = url.searchParams.get("code") ?? url.searchParams.get("oauth_token");
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const id = state ? await consumeOAuthState(hashState(state)) : null;
    // Microsoft work accounts: an organisation that lets only approved apps in says so with these Entra codes.
    const adminOnly = /AADSTS(90094|90095)\b/.test(url.searchParams.get("error_description") ?? "");
    if (adminOnly) {
      const message = "Your organisation's IT admin has to approve Athena first. Ask them to allow it, then sign in again.";
      if (id) await setConnectorStatus(id, "needs_auth", "Waiting for your IT admin to approve Athena");
      return returnPage("Needs your IT admin", message, "/#/settings/accounts");
    }
    if (id) await setConnectorStatus(id, "needs_auth", `Sign-in was cancelled or refused (${providerError})`);
    return returnPage("Not connected", "The sign-in was cancelled or refused.", "/#/settings/accounts");
  }
  if (!state || !code) return returnPage("Not connected", "This page needs a sign-in response.", "/#/settings/accounts", 400);
  try {
    const id = await finishSignIn(state, code);
    // Learn the tools straight away so the account is usable; a failure here
    // leaves it connected, with "Check tools" to retry from the app.
    await discoverTools(id).catch((e) => console.error("Athena connectors: tool discovery after sign-in failed", e instanceof Error ? e.message : e));
    // Just turned on "Let Athena answer invites": the answers you gave meanwhile go to the calendar now (lib/rsvp.ts).
    await sendPendingAnswers(id, { calendar: calendarPort }).catch((e) => console.error("Athena connectors: sending answers after sign-in failed", e instanceof Error ? e.message : e));
    // An account with history: load all of it now, in the background (backfill.ts). A load that failed starts again.
    await loadHistory(id, url.origin);
    return returnPage("Connected", "Your account is connected. Taking you back to Athena…", `/#/settings/accounts?connected=${id}`);
  } catch (error) {
    const message = error instanceof AthenaInputError ? error.message : "Something went wrong finishing the sign-in.";
    if (!(error instanceof AthenaInputError)) console.error("Athena connectors: callback failed", error);
    return returnPage("Not connected", message, "/#/settings/accounts", 400);
  }
}

/** Start loading an account's history once it's connected; a load already there is left alone unless it failed or was waiting on what Athena may read. Never throws. */
async function loadHistory(id: string, origin: string, opts: { again?: boolean } = {}): Promise<void> {
  try {
    const had = await getBackfill(id);
    await startBackfill(id, origin, { again: opts.again || had?.state === "failed" || had?.state === "blocked" });
  } catch (error) {
    console.error("Athena connectors: starting the history load failed", error instanceof Error ? error.message : "unknown error");
  }
}

// ---------- dispatcher ----------

/**
 * Handle /api/connectors/* and /api/collections/*, or return null if the
 * path isn't one of ours. Throws AthenaInputError for bad input (api.ts
 * turns that into a 400/404).
 */
export async function handleConnectorRoutes(req: Request, url: URL, segments: string[], json: Json, origin: string): Promise<Response | null> {
  const [, first, second, third] = segments;
  const m = req.method;

  if (first === "connectors") {
    if (segments.length === 2) {
      if (m === "GET") {
        const [connectors, collections] = await Promise.all([listConnectors(), listCollectionsWithRuns()]);
        return json({ connectors, collections, setup: setup(origin, connectors) });
      }
      if (m === "POST") {
        if (!secretBoxConfigured()) throw new AthenaInputError("Set CONNECTOR_ENCRYPTION_KEY on the server before adding accounts (see the README)");
        return json(await createFromBody(await body(req)), 201);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    // Fill a fields address in from the service (Octopus's meters on an account number), before or after the account is added.
    if (segments.length === 3 && second === "find-address") {
      if (m !== "POST") return json({ error: "Method not allowed" }, 405);
      return json({ choices: await findAddress(await body(req)) });
    }
    if (!second || !UUID_RE.test(second)) return json({ error: "Not found" }, 404);
    if (segments.length === 3) {
      if (m === "GET") {
        const c = await getConnector(second);
        return c ? json(c) : json({ error: "Not found" }, 404);
      }
      if (m === "PATCH") {
        const patched = await patchConnector(second, await body(req));
        // History waiting on "What Athena can read": allowing a read it needs starts it.
        if ((await getBackfill(second))?.state === "blocked") await loadHistory(second, origin, { again: true });
        return json(patched);
      }
      if (m === "DELETE") return (await deleteConnector(second)) ? json({ deleted: true }) : json({ error: "Not found" }, 404);
      return json({ error: "Method not allowed" }, 405);
    }
    // Every calendar on the account, for choosing which ones Athena reads (iCloud saves the choice as `scope`, Google and Outlook as `calendars`).
    if (segments.length === 4 && third === "calendars" && m === "GET") {
      const found = await getConnectorWithSecrets(second).catch(() => null);
      if (found && CHOOSES_CALENDARS.has(found.connector.provider)) return json({ calendars: await calendarChoices(second) });
      if (!found || found.connector.provider !== "icloud-calendar") return json({ error: "Not found" }, 404);
      try {
        return json({ calendars: await icloudCalendarChoices(found.connector, found.secrets) });
      } catch (error) {
        throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach iCloud");
      }
    }
    // Gmail and Outlook: the owner's mail rules, the labels they can name, and what they'd skip.
    if (third === "mail" && (segments.length === 4 || segments.length === 5)) {
      const c = await getConnector(second);
      if (!c || !READS_MAIL.has(c.provider)) return json({ error: "Not found" }, 404);
      const fourth = segments[4];
      if (segments.length === 4 && m === "GET") {
        const today = zonedToday(new Date(), await getOwnerTimeZone());
        return json({ rules: c.mail_rules ?? readRules(null), unreadable: !!c.mail_rules_unreadable, skipped_week: await mailSkipsSince(c.id, 7, today) });
      }
      if (fourth === "labels" && m === "GET") return json({ labels: await withMail(second, (mail) => mail.labels()) });
      if (fourth === "preview" && m === "POST") {
        const rules = readRules((await body(req)).rules);
        return json(await withMail(second, (mail) => mail.preview(rules)));
      }
      return json({ error: "Not found" }, 404);
    }
    if (segments.length === 4 && third === "watch-history") {
      const c = await getConnector(second);
      if (!c || c.provider !== "youtube") return json({ error: "Not found" }, 404);
      const target = await historyTarget(c);
      if (m === "GET") return json({ tz: target.tz, collection: target.collection, metric: target.metric, source: target.source, last_import: await lastImport(c.id) });
      if (m === "POST") {
        const b = await body(req);
        const r = await importDays(target, readDays(b.days), { metrics: b.metrics !== false });
        await rememberImport(c.id, b.file);
        return json(r);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "backfill") {
      const c = await getConnector(second);
      if (!c) return json({ error: "Not found" }, 404);
      const status = await backfillStatus(c);
      if (!status.supported) return json({ error: "Not found" }, 404);
      // YouTube: watch history isn't in the API, so a Takeout import is the rest of it.
      const takeout = c.provider === "youtube" ? await lastImport(c.id) : null;
      if (m === "GET") return json({ ...status, takeout });
      if (m === "POST") {
        await startBackfill(c.id, origin, { again: true });
        return json({ ...(await backfillStatus(c)), takeout }, 202);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "library") {
      const c = await getConnector(second);
      if (!c || c.provider !== "goodreads") return json({ error: "Not found" }, 404);
      const target = await libraryTarget(c);
      if (m === "GET") return json({ tz: target.tz, collection: target.collection, metric: target.metric, source: target.source, last_import: await lastImport(c.id) });
      if (m === "POST") {
        const b = await body(req);
        const days = readBookDays(b.days);
        const r = await importBooks(target, days, { metrics: b.metrics !== false });
        await rememberImportedBooks(c.id, days);
        await rememberImport(c.id, b.file);
        return json(r);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "viewing") {
      const c = await getConnector(second);
      if (!c || c.provider !== "netflix") return json({ error: "Not found" }, 404);
      const target = await viewingTarget(c);
      if (m === "GET") return json({ collection: target.collection, source: target.source, last_import: await lastImport(c.id) });
      if (m === "POST") {
        const b = await body(req);
        const r = await importViewing(target, readViewingDays(b.days));
        await rememberImport(c.id, b.file);
        return json(r);
      }
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && m === "POST") {
      if (third === "sign-in") {
        const r = await beginSignIn(second, origin);
        return json(r.authorized ? { authorized: true } : { authorization_url: r.authorizationUrl });
      }
      if (third === "check") {
        try {
          const checked = await discoverTools(second);
          // The password works: check the accounts that share it too, which clears their sign-in problem.
          if (presetFor(checked.provider).username) {
            const mine = (await getConnectorWithSecrets(second))?.secrets ?? {};
            for (const other of await sharingKey(second, mine)) {
              if ((await getConnector(other))?.status !== "connected") await discoverTools(other).catch(() => undefined);
            }
          }
          if (checked.status === "connected") await loadHistory(second, origin);
          return json(checked);
        } catch (error) {
          // A direct account says what to fix ("Lichess can't find that username…"), not just "needs signing in".
          if (error instanceof ConnectorNeedsSignIn) {
            const c = await getConnector(second);
            throw new AthenaInputError(c && directFor(c) && c.status_detail ? c.status_detail : error.message);
          }
          throw new AthenaInputError(error instanceof Error ? error.message : "Couldn't reach the server");
        }
      }
    }
    return json({ error: "Not found" }, 404);
  }

  if (first === "collections") {
    if (segments.length === 2) {
      if (m === "GET") return json({ collections: await listCollectionsWithRuns() });
      if (m === "POST") return json(await upsertCollection(undefined, collectionInput(await body(req))), 201);
      return json({ error: "Method not allowed" }, 405);
    }
    if (!second || !UUID_RE.test(second)) return json({ error: "Not found" }, 404);
    if (segments.length === 3) {
      if (m === "GET") {
        const c = await getCollection(second);
        return c ? json(c) : json({ error: "Not found" }, 404);
      }
      if (m === "PATCH") {
        const existing = await getCollection(second);
        if (!existing) return json({ error: "Not found" }, 404);
        return json(await upsertCollection(second, collectionInput(await body(req), existing)));
      }
      if (m === "DELETE") return (await deleteCollection(second)) ? json({ deleted: true }) : json({ error: "Not found" }, 404);
      return json({ error: "Method not allowed" }, 405);
    }
    if (segments.length === 4 && third === "runs" && m === "GET") return json({ runs: await listRuns(second) });
    const fourth = segments[4];
    if (segments.length === 6 && third === "runs" && segments[5] === "items" && m === "GET") {
      if (!fourth || !UUID_RE.test(fourth)) return json({ error: "Not found" }, 404);
      const items = await listRunItems(second, fourth);
      return items ? json({ items }) : json({ error: "Not found" }, 404);
    }
    if (segments.length === 4 && third === "run" && m === "POST") {
      const c = await getCollection(second);
      if (!c) return json({ error: "Not found" }, 404);
      // Your activity, Your work, counted, Home and Calendar need no model (media-sync.ts, work-sync.ts, home-run.ts, calendar-sync.ts).
      if (!NO_MODEL_RECIPES.includes(c.recipe) && !aiConfigured()) throw new AthenaInputError("Collections need the Agent: Netlify AI Gateway isn't active on this site yet (see the README)");
      if (await hasOpenRun(second)) throw new AthenaInputError("This collection is already running");
      const run = await queueRun(second, "manual");
      await triggerRuns(origin, [run.id]);
      return json(run, 202);
    }
    return json({ error: "Not found" }, 404);
  }

  return null;
}
