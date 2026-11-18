/**
 * Data access for connectors (signed-in MCP accounts), collections (what to
 * collect from them, and when), their run history, and collected-item dedup.
 *
 * The companion to lib/db.ts: that file owns the second-brain tables, this
 * one owns the connector tables from migration 0004. Server-only — it seals
 * and opens credentials with lib/secret-box.ts, and nothing here ever returns
 * a credential to a caller outside netlify/lib/connectors/.
 *
 * Collected items' titles and runs' summaries quote your content, so they're
 * encrypted at rest like the notes they describe (SECURITY.md §11): those
 * queries go through lib/db.ts's q(), which opens them.
 */
import { addDays, DEFAULT_TZ, zonedParts, zonedToInstant, zonedToday } from "./dates";
import { openJson, sealJson } from "./secret-box";
import { AthenaInputError, database, getOwnerTimeZone, lookupIndexes, matchKey, q as openQ, sealer, type EntityType } from "./db";
import { DataBoxError, openStrict, sealText } from "./data-box";
import { hasRules, readRules, type MailRules } from "./mail-rules";
import { createHash } from "node:crypto";
import { isCustomServer, OAUTH_GRANTS, OAUTH_TOKEN_AUTH, presetFor, type ConnectorAuthType, type ConnectorOAuthSettings, type RecipeId, type ToolAccess } from "./connector-presets";

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await database().sql.unsafe(text, params as never[])) as T[];
}

// ---------- Types ----------

export type ConnectorStatus = "pending" | "connected" | "needs_auth" | "error";

export interface ConnectorTool {
  name: string;
  description: string;
  access: ToolAccess;
  /** A custom server's tool: a hash of its description and input schema as last listed (toolTextHash). */
  hash?: string;
  /** Allowed, but its text is no longer what the owner approved: kept from the model until approved again. */
  changed?: boolean;
}

/** A connector as the API returns it: never any credential material. */
export interface Connector {
  id: string;
  name: string;
  provider: string;
  account_label: string;
  url: string;
  auth_type: ConnectorAuthType;
  scope: string;
  status: ConnectorStatus;
  status_detail: string;
  tools: ConnectorTool[];
  allowed_tools: string[];
  /**
   * Custom servers: each allowed tool's text hash at the moment the owner allowed it. A tool whose
   * text no longer matches is dropped until approved again. null = connected before pinning: the
   * allowed tools are pinned at their text on the next listing.
   */
  tool_pins?: Record<string, string> | null;
  /** Custom servers: offer its tools to Ask's answers, beside the other accounts. Off by default. */
  use_in_ask?: boolean;
  /** Custom servers: may share a collection with other accounts. Off by default. */
  share_collections?: boolean;
  tools_checked_at: string | null;
  last_used_at: string | null;
  /** What the server says about itself (title, website, logo as data: URIs). */
  server_info: {
    name?: string;
    title?: string;
    version?: string;
    description?: string;
    website_url?: string;
    icon?: { light?: string; dark?: string; source: "server" | "website" };
  };
  /** OAuth settings entered by hand (endpoints, grant…); empty = discover. Not secret. */
  oauth: ConnectorOAuthSettings;
  /** Google Calendar and Outlook: the calendar ids Athena reads; null = only the main one (calendar-choice.ts). */
  calendars?: string[] | null;
  /** Gmail and Outlook: which emails Athena reads (lib/mail-rules.ts); null = no rules. Sealed at rest. */
  mail_rules?: MailRules | null;
  /** The rules are stored but this deploy can't open them: the mail tools refuse rather than read without them. */
  mail_rules_unreadable?: boolean;
  /** Whether a static token / own OAuth client (and its secret) is stored (not their values). */
  has_token: boolean;
  has_own_client: boolean;
  has_client_secret: boolean;
  created_at: string;
  updated_at: string;
}

/** Everything secret about one connector, sealed together in `credentials`. */
export interface ConnectorSecrets {
  /** auth_type 'token': sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** The username that goes with the token, for services that take both (an Apple ID: lib/presets/apple.ts). */
  username?: string;
  /** DVSA's MOT History: the token URL that goes with the key and client (lib/presets/car.ts). */
  tokenUrl?: string;
  /** An OAuth client you registered yourself (e.g. Google). */
  ownClient?: { client_id: string; client_secret?: string };
  /** A client Athena registered dynamically, and the redirect URL it was registered for. */
  registered?: Record<string, unknown>;
  registeredRedirect?: string;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
  discovery?: Record<string, unknown>;
  /** The callback URL used for the sign-in in flight (deploy previews have their own). */
  redirectUrl?: string;
}

interface ConnectorRow extends Omit<Connector, "has_token" | "has_own_client" | "has_client_secret" | "mail_rules" | "mail_rules_unreadable"> {
  credentials: string | null;
  mail_rules: string | null;
}

export interface Collection {
  id: string;
  name: string;
  recipe: RecipeId;
  connector_ids: string[];
  label: string;
  source: string;
  instructions: string;
  schedule: "daily" | "hourly" | "manual";
  /** "HH:MM" in the owner's time zone (settings.timezone), for 'daily'. */
  run_at: string | null;
  every_hours: number | null;
  lookback_hours: number;
  /** Sync upcoming calendar events into Athena's events this many days ahead (0 = off). */
  lookahead_days: number;
  /** Push 30 minutes before those synced events. */
  event_push: boolean;
  /** Skip a run when the precheck finds nothing new (default), or always run. */
  skip_quiet: boolean;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface CollectionRun {
  id: string;
  collection_id: string;
  trigger: "schedule" | "manual";
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  summary: string;
  error: string;
  /** Counts (RunStats in runner.ts), plus `blocked_by`: ids of accounts that couldn't be read. */
  stats: RunStatsJson;
  created_at: string;
}

export type RunStatsJson = { [k: string]: number | string[] | undefined; blocked_by?: string[] };

/** A collection's run in flight, as GET /api/connectors shows it. */
export interface CurrentRun {
  id: string;
  status: "queued" | "running";
  started_at: string | null;
}

/** A collection's newest finished run: names and counts only. */
export interface LastRun {
  id: string;
  status: "succeeded" | "failed";
  finished_at: string | null;
  error: string;
  /** New things it wrote: notes, events, bookings, orders and to-dos (updates aren't counted). */
  saved: number;
  /** Ids of the accounts it couldn't read. */
  blocked_by: string[];
}

// ---------- Connectors ----------

const CONNECTOR_COLUMNS = `id, name, provider, account_label, url, auth_type, scope, status, status_detail, tools,
  allowed_tools, tool_pins, use_in_ask, share_collections, tools_checked_at, last_used_at, server_info, oauth, calendars, mail_rules, created_at, updated_at, credentials`;

/** The sealed rules, opened; unreadable (no key, or a key gone) is reported, never treated as "no rules". */
function openMailRules(sealed: string | null): Pick<Connector, "mail_rules" | "mail_rules_unreadable"> {
  if (!sealed) return { mail_rules: null };
  try {
    return { mail_rules: readRules(JSON.parse(openStrict(sealed))) };
  } catch {
    return { mail_rules: null, mail_rules_unreadable: true };
  }
}

// ---------- Custom servers: pinned tool text, and who they share a model with ----------

const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`
      : (JSON.stringify(v) ?? "null");

/** One hash over a tool's whole description and input schema, whatever order the server sends the keys in. */
export function toolTextHash(description: unknown, inputSchema: unknown): string {
  return createHash("sha256").update(stable([typeof description === "string" ? description : "", inputSchema ?? null])).digest("hex");
}

/** Whether a custom server's allowed tool no longer has the text the owner approved. Never true before pinning (tool_pins null). */
export function toolNeedsApproval(c: Pick<Connector, "provider" | "tool_pins">, name: string, hash: string | undefined): boolean {
  return isCustomServer(c.provider) && !!c.tool_pins && !!hash && c.tool_pins[name] !== hash;
}

function withChanged(c: Pick<Connector, "provider" | "tool_pins" | "tools" | "allowed_tools">): ConnectorTool[] {
  if (!isCustomServer(c.provider) || !c.tool_pins) return c.tools;
  const allowed = new Set(c.allowed_tools);
  return c.tools.map((t) => (allowed.has(t.name) && toolNeedsApproval(c, t.name, t.hash) ? { ...t, changed: true } : t));
}

/** Ask's answers hold every account's read tools at once: a custom server joins them only with its "Use in Ask" switch on. */
export function offeredInAsk(c: Pick<Connector, "provider" | "use_in_ask">): boolean {
  return !isCustomServer(c.provider) || c.use_in_ask === true;
}

/** The custom servers that may not share a model with the other accounts given: every one whose own switch is off. */
export function keptApart<T extends Pick<Connector, "provider" | "share_collections">>(accounts: T[]): T[] {
  return accounts.length > 1 ? accounts.filter((c) => isCustomServer(c.provider) && c.share_collections !== true) : [];
}

function present(row: ConnectorRow): Connector {
  const { credentials, mail_rules, ...rest } = row;
  let secrets: ConnectorSecrets | null = null;
  try {
    secrets = openJson<ConnectorSecrets>(credentials);
  } catch {
    // Key missing or rotated: report nothing stored rather than fail the list.
  }
  return {
    ...rest,
    tools: withChanged(rest),
    ...openMailRules(mail_rules),
    has_token: !!secrets?.token,
    has_own_client: !!secrets?.ownClient?.client_id,
    has_client_secret: !!secrets?.ownClient?.client_secret,
  };
}

/** Only https endpoints (plus localhost under `netlify dev`). */
export function validateServerUrl(raw: string, what = "MCP servers"): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AthenaInputError(what === "MCP servers" ? "That isn't a valid URL" : `${what}: that isn't a valid URL`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:" && process.env.NETLIFY_DEV === "true")) {
    throw new AthenaInputError(`${what} must use https://`);
  }
  if (url.username || url.password) throw new AthenaInputError("Put credentials in the token or client fields, not the URL");
  return url.toString();
}

/**
 * Clean up OAuth settings from the API: known keys only, URLs checked like
 * server URLs, and endpoints that make sense for the grant. Returns `{}` for
 * "discover everything" (the default).
 */
export function validateOAuthSettings(raw: unknown): ConnectorOAuthSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new AthenaInputError("oauth must be an object");
  const r = raw as Record<string, unknown>;
  const text = (k: string): string | undefined => {
    const v = r[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new AthenaInputError(`oauth.${k} must be a string`);
    return v.trim() || undefined;
  };
  const out: ConnectorOAuthSettings = {};
  const grant = text("grant");
  if (grant) {
    if (!OAUTH_GRANTS.includes(grant as never)) throw new AthenaInputError("oauth.grant must be authorization_code or client_credentials");
    if (grant !== "authorization_code") out.grant = grant as ConnectorOAuthSettings["grant"];
  }
  const tokenAuth = text("token_auth");
  if (tokenAuth) {
    if (!OAUTH_TOKEN_AUTH.includes(tokenAuth as never)) throw new AthenaInputError("oauth.token_auth must be client_secret_basic or client_secret_post");
    out.token_auth = tokenAuth as ConnectorOAuthSettings["token_auth"];
  }
  const authorize = text("authorization_endpoint");
  const token = text("token_endpoint");
  if (out.grant === "client_credentials") {
    // No browser step, so there's no authorisation URL to use.
    if (token) out.token_endpoint = validateServerUrl(token, "The token URL");
  } else {
    if (!!authorize !== !!token) throw new AthenaInputError("Enter both the authorization URL and the token URL, or leave both empty to discover them");
    if (authorize && token) {
      out.authorization_endpoint = validateServerUrl(authorize, "The authorization URL");
      out.token_endpoint = validateServerUrl(token, "The token URL");
    }
  }
  const audience = text("audience");
  if (audience) {
    if (audience.length > 500) throw new AthenaInputError("The audience is too long");
    out.audience = audience;
  }
  return out;
}

/** Same settings, ignoring key order. */
export function sameOAuthSettings(a: ConnectorOAuthSettings, b: ConnectorOAuthSettings): boolean {
  const keys: Array<keyof ConnectorOAuthSettings> = ["grant", "authorization_endpoint", "token_endpoint", "token_auth", "audience"];
  return keys.every((k) => (a[k] ?? "") === (b[k] ?? ""));
}

export async function listConnectors(): Promise<Connector[]> {
  const rows = await q<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors ORDER BY created_at ASC`);
  return rows.map(present);
}

export async function getConnector(id: string): Promise<Connector | null> {
  const [row] = await q<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE id = $1`, [id]);
  return row ? present(row) : null;
}

/** Server-side only: the connector plus its decrypted secrets. */
export async function getConnectorWithSecrets(id: string): Promise<{ connector: Connector; secrets: ConnectorSecrets } | null> {
  const [row] = await q<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE id = $1`, [id]);
  if (!row) return null;
  return { connector: present(row), secrets: openJson<ConnectorSecrets>(row.credentials) ?? {} };
}

export async function createConnector(input: {
  name: string;
  provider: string;
  account_label?: string;
  url: string;
  auth_type: ConnectorAuthType;
  scope?: string;
  oauth?: ConnectorOAuthSettings;
  secrets: ConnectorSecrets;
}): Promise<Connector> {
  const name = input.name.trim();
  if (!name) throw new AthenaInputError("Give the account a name, e.g. “Work Gmail”");
  if (input.auth_type === "token" && !input.secrets.token) throw new AthenaInputError("Paste the API key or token");
  const oauth = input.auth_type === "oauth" ? (input.oauth ?? {}) : {};
  if (oauth.grant === "client_credentials" && !(input.secrets.ownClient?.client_id && input.secrets.ownClient.client_secret)) {
    throw new AthenaInputError("Client credentials need your client ID and client secret");
  }
  const status: ConnectorStatus = input.auth_type === "oauth" ? "needs_auth" : "pending";
  const [row] = await q<ConnectorRow>(
    `INSERT INTO connectors (name, provider, account_label, url, auth_type, scope, status, credentials, oauth)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING ${CONNECTOR_COLUMNS}`,
    [
      name,
      input.provider,
      (input.account_label ?? "").trim(),
      validateServerUrl(input.url),
      input.auth_type,
      (input.scope ?? "").trim(),
      status,
      sealJson(input.secrets),
      JSON.stringify(oauth),
    ],
  );
  return present(row);
}

export async function updateConnector(
  id: string,
  patch: {
    name?: string;
    account_label?: string;
    scope?: string;
    allowed_tools?: string[];
    oauth?: ConnectorOAuthSettings;
    url?: string;
    calendars?: string[];
    tool_pins?: Record<string, string>;
    use_in_ask?: boolean;
    share_collections?: boolean;
  },
): Promise<Connector | null> {
  const [row] = await q<ConnectorRow>(
    `UPDATE connectors SET
       name = COALESCE(NULLIF($2, ''), name),
       account_label = COALESCE($3, account_label),
       scope = COALESCE($4, scope),
       allowed_tools = COALESCE($5, allowed_tools),
       oauth = COALESCE($6::jsonb, oauth),
       url = COALESCE($7, url),
       calendars = COALESCE($8, calendars),
       tool_pins = COALESCE($9::jsonb, tool_pins),
       use_in_ask = COALESCE($10, use_in_ask),
       share_collections = COALESCE($11, share_collections),
       updated_at = now()
     WHERE id = $1
     RETURNING ${CONNECTOR_COLUMNS}`,
    [
      id,
      patch.name?.trim() ?? null,
      patch.account_label?.trim() ?? null,
      patch.scope?.trim() ?? null,
      patch.allowed_tools ?? null,
      patch.oauth ? JSON.stringify(patch.oauth) : null,
      patch.url ? validateServerUrl(patch.url) : null,
      patch.calendars ?? null,
      patch.tool_pins ? JSON.stringify(patch.tool_pins) : null,
      patch.use_in_ask ?? null,
      patch.share_collections ?? null,
    ],
  );
  return row ? present(row) : null;
}

/** Save an account's mail rules, sealed; no rules at all clears the column. Throws DataKeyMissing without the data key. */
export async function saveMailRules(id: string, rules: MailRules): Promise<Connector | null> {
  const sealed = hasRules(rules) ? sealText(JSON.stringify(rules)) : null;
  const [row] = await q<ConnectorRow>(`UPDATE connectors SET mail_rules = $2, updated_at = now() WHERE id = $1 RETURNING ${CONNECTOR_COLUMNS}`, [id, sealed]);
  return row ? present(row) : null;
}

/** Emails a run's rules kept out, added to today's count for the account (counts only). */
export async function recordMailSkips(id: string, n: number, day: string): Promise<void> {
  if (!(n > 0)) return;
  await q(
    `INSERT INTO mail_skips (connector_id, day, n) VALUES ($1, $2::date, $3)
     ON CONFLICT (connector_id, day) DO UPDATE SET n = mail_skips.n + EXCLUDED.n`,
    [id, day, Math.round(n)],
  );
}

/** Emails the rules kept out of runs over the last `days` days, today included. */
export async function mailSkipsSince(id: string, days: number, today: string): Promise<number> {
  const [row] = await q<{ n: number }>(`SELECT COALESCE(sum(n), 0)::int AS n FROM mail_skips WHERE connector_id = $1 AND day > $2::date - $3::int`, [id, today, days]);
  return row?.n ?? 0;
}

/** Read-modify-write the sealed secrets. */
export async function updateConnectorSecrets(id: string, mutate: (s: ConnectorSecrets) => ConnectorSecrets | void): Promise<void> {
  const current = await getConnectorWithSecrets(id);
  if (!current) throw new AthenaInputError("Connector not found", 404);
  // Mutate a copy, and keep that copy when the mutator returns nothing.
  const copy = { ...current.secrets };
  const next = mutate(copy) ?? copy;
  await q(`UPDATE connectors SET credentials = $2, updated_at = now() WHERE id = $1`, [id, sealJson(next)]);
}

/** Replace the sealed secrets wholesale (the OAuth provider holds the latest copy). */
export async function saveConnectorSecrets(id: string, secrets: ConnectorSecrets): Promise<void> {
  await q(`UPDATE connectors SET credentials = $2, updated_at = now() WHERE id = $1`, [id, sealJson(secrets)]);
}

export async function setConnectorStatus(id: string, status: ConnectorStatus, detail = ""): Promise<void> {
  await q(`UPDATE connectors SET status = $2, status_detail = $3, updated_at = now() WHERE id = $1`, [id, status, detail.slice(0, 500)]);
}

export async function markConnectorUsed(id: string): Promise<void> {
  await q(`UPDATE connectors SET last_used_at = now() WHERE id = $1`, [id]);
}

/**
 * Record the tools a server offers. The first time, the allowlist defaults
 * to the preset's known read tools (every read tool for Athena's own direct
 * adapters, `ownTools`); a custom server has no known reads, so everything
 * of its starts off. Afterwards the owner's choices are kept (minus tools
 * that disappeared). Write tools are stripped either way.
 *
 * A custom server connected before pinning (tool_pins null) has its allowed
 * tools pinned here, at the text just listed.
 */
export async function saveConnectorTools(id: string, tools: ConnectorTool[], opts: { ownTools?: boolean } = {}): Promise<Connector | null> {
  const [current] = await q<{ allowed_tools: string[]; tools_checked_at: string | null; provider: string; tool_pins: Record<string, string> | null }>(
    `SELECT allowed_tools, tools_checked_at, provider, tool_pins FROM connectors WHERE id = $1`,
    [id],
  );
  if (!current) return null;
  const allowable = new Set(tools.filter((t) => t.access !== "write").map((t) => t.name));
  const known = new Set(presetFor(current.provider).readTools);
  const allowed = current.tools_checked_at
    ? current.allowed_tools.filter((n) => allowable.has(n))
    : tools.filter((t) => t.access === "read" && (opts.ownTools || known.has(t.name))).map((t) => t.name);
  let pins = current.tool_pins;
  if (isCustomServer(current.provider) && !opts.ownTools) {
    const hashes = new Map(tools.map((t) => [t.name, t.hash]));
    if (!pins) pins = Object.fromEntries(allowed.flatMap((n) => (hashes.get(n) ? [[n, hashes.get(n)!]] : [])));
    else pins = Object.fromEntries(Object.entries(pins).filter(([n]) => allowed.includes(n)));
  }
  const [row] = await q<ConnectorRow>(
    `UPDATE connectors SET tools = $2::jsonb, allowed_tools = $3, tool_pins = $4::jsonb, tools_checked_at = now(), updated_at = now()
     WHERE id = $1 RETURNING ${CONNECTOR_COLUMNS}`,
    [id, JSON.stringify(tools.map(({ changed: _changed, ...t }) => t)), allowed, pins ? JSON.stringify(pins) : null],
  );
  return row ? present(row) : null;
}

/** A run's listing of a custom server connected before pinning: pin its allowed tools at the text just seen. Never replaces pins already there. */
export async function pinToolsFirstTime(id: string, pins: Record<string, string>): Promise<void> {
  await q(`UPDATE connectors SET tool_pins = $2::jsonb, updated_at = now() WHERE id = $1 AND tool_pins IS NULL`, [id, JSON.stringify(pins)]);
}

/** A run found allowed tools whose text changed: store what they say now, so the account's page shows them as needing approval. */
export async function recordChangedTools(id: string, changed: Array<{ name: string; description: string; hash: string }>): Promise<void> {
  const [current] = await q<{ tools: ConnectorTool[] }>(`SELECT tools FROM connectors WHERE id = $1`, [id]);
  if (!current) return;
  const now = new Map(changed.map((t) => [t.name, t]));
  const tools = current.tools.map((t) => (now.has(t.name) ? { ...t, description: now.get(t.name)!.description, hash: now.get(t.name)!.hash } : t));
  await q(`UPDATE connectors SET tools = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(tools)]);
}

export async function saveServerInfo(id: string, info: Connector["server_info"]): Promise<void> {
  await q(`UPDATE connectors SET server_info = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(info)]);
}

/** Only tools the server lists and that aren't writes can be allowed. */
export async function setAllowedTools(id: string, names: string[]): Promise<Connector | null> {
  const connector = await getConnector(id);
  if (!connector) return null;
  const allowable = new Set(connector.tools.filter((t) => t.access !== "write").map((t) => t.name));
  const rejected = names.filter((n) => !allowable.has(n));
  if (rejected.length) throw new AthenaInputError(`These tools can't be allowed (unknown, or they change data): ${rejected.join(", ")}`);
  const allowed = [...new Set(names)];
  if (!isCustomServer(connector.provider) || !connector.tool_pins) return updateConnector(id, { allowed_tools: allowed });
  // Pin each newly allowed tool at the text the owner has just read; one already allowed keeps its pin (a changed one stays changed).
  const before = new Set(connector.allowed_tools);
  const hashes = new Map(connector.tools.map((t) => [t.name, t.hash]));
  const pins: Record<string, string> = {};
  for (const n of allowed) {
    const pin = before.has(n) ? connector.tool_pins[n] : hashes.get(n);
    if (pin) pins[n] = pin;
  }
  return updateConnector(id, { allowed_tools: allowed, tool_pins: pins });
}

/** The owner read a changed tool's new text and approved it: pin it there, so runs use it again. */
export async function approveTools(id: string, names: string[]): Promise<Connector | null> {
  const connector = await getConnector(id);
  if (!connector) return null;
  const allowed = new Set(connector.allowed_tools);
  const hashes = new Map(connector.tools.map((t) => [t.name, t.hash]));
  const rejected = names.filter((n) => !allowed.has(n) || !hashes.get(n));
  if (rejected.length) throw new AthenaInputError(`These tools aren't allowed, so there's nothing to approve: ${rejected.join(", ")}`);
  if (!connector.tool_pins) return connector;
  return updateConnector(id, { tool_pins: { ...connector.tool_pins, ...Object.fromEntries(names.map((n) => [n, hashes.get(n)!])) } });
}

// ---------- Own OAuth clients, reused across accounts ----------

/** Whose own client a provider's accounts use ("Google", "Microsoft"), or undefined if none is shared. */
export const ownClientFamily = (provider: string): string | undefined => presetFor(provider).ownClientLabel;

/**
 * The own clients the app can offer to reuse, by family: the account each
 * one would be copied from, by id and name. Never the client itself.
 * Prefers a connected account with its secret, then the oldest (where the
 * setup was first entered; the name stays put as accounts are added).
 */
export function ownClientsSummary(connectors: Connector[]): Record<string, { from: string; name: string }> {
  const out: Record<string, { from: string; name: string; rank: number }> = {};
  for (const c of [...connectors].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())) {
    const family = ownClientFamily(c.provider);
    if (!family || c.auth_type !== "oauth" || !c.has_own_client) continue;
    const rank = (c.status === "connected" ? 2 : 0) + (c.has_client_secret ? 1 : 0);
    // Oldest first, so an equal rank keeps the first account: where the setup was entered.
    if (!out[family] || rank > out[family].rank) out[family] = { from: c.id, name: c.name, rank };
  }
  return Object.fromEntries(Object.entries(out).map(([k, { from, name }]) => [k, { from, name }]));
}

/**
 * The sealed own client of account `fromId`, for a new `provider` account.
 * Only within one family (Google with Google, Microsoft with Microsoft).
 * Server-side only: the result goes straight into the new account's secrets.
 */
export async function ownClientFrom(fromId: string, provider: string): Promise<NonNullable<ConnectorSecrets["ownClient"]>> {
  const family = ownClientFamily(provider);
  const found = await getConnectorWithSecrets(fromId).catch(() => null);
  if (!found) throw new AthenaInputError("The account to copy from no longer exists");
  const client = found.secrets.ownClient;
  const theirs = ownClientFamily(found.connector.provider);
  if (!theirs || found.connector.auth_type !== "oauth") throw new AthenaInputError(`${found.connector.name} has no setup to reuse`);
  if (!family || theirs !== family) throw new AthenaInputError(`${found.connector.name}'s ${theirs} setup doesn't work for ${presetFor(provider).label}`);
  if (!client?.client_id) throw new AthenaInputError(`${found.connector.name} has no ${family} setup to reuse`);
  return { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) };
}

/** Removes the account and its stored credentials; collections lose it. */
export async function deleteConnector(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `WITH gone AS (DELETE FROM connectors WHERE id = $1 RETURNING id),
          _c AS (UPDATE collections SET connector_ids = array_remove(connector_ids, $1::uuid), updated_at = now()
                 WHERE $1::uuid = ANY(connector_ids))
     SELECT id FROM gone`,
    [id],
  );
  return rows.length > 0;
}

// ---------- OAuth state (CSRF protection for the callback) ----------

export async function setOAuthState(id: string, stateHash: string, ttlMinutes = 15): Promise<void> {
  await q(
    `UPDATE connectors SET oauth_state_hash = $2, oauth_state_expires_at = now() + make_interval(mins => $3), updated_at = now()
     WHERE id = $1`,
    [id, stateHash, ttlMinutes],
  );
}

/** Consume a state: returns the connector id once, and only while it's unexpired. */
export async function consumeOAuthState(stateHash: string): Promise<string | null> {
  const rows = await q<{ id: string }>(
    `UPDATE connectors SET oauth_state_hash = NULL, oauth_state_expires_at = NULL
     WHERE oauth_state_hash = $1 AND oauth_state_expires_at > now()
     RETURNING id`,
    [stateHash],
  );
  return rows[0]?.id ?? null;
}

// ---------- Collections ----------

const COLLECTION_COLUMNS = `id, name, recipe, connector_ids, label, source, instructions, schedule,
  to_char(run_at, 'HH24:MI') AS run_at, every_hours, lookback_hours, lookahead_days, event_push, skip_quiet, enabled, next_run_at, last_run_at, last_status,
  created_at, updated_at`;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * When a collection should next run, strictly after `after`:
 * daily → the next `run_at` in `tz` (the owner's zone); hourly → `after` + N hours; manual → never.
 */
export function computeNextRun(
  c: Pick<Collection, "schedule" | "run_at" | "every_hours" | "enabled">,
  after: Date = new Date(),
  tz: string = DEFAULT_TZ,
): Date | null {
  if (!c.enabled || c.schedule === "manual") return null;
  if (c.schedule === "hourly") return new Date(after.getTime() + Math.max(1, c.every_hours ?? 6) * 3600000);
  const time = (c.run_at ?? "07:00").slice(0, 5);
  const today = zonedToday(after, tz);
  const todayAt = zonedToInstant(today, time, tz);
  return todayAt.getTime() > after.getTime() ? todayAt : zonedToInstant(addDays(today, 1), time, tz);
}

/** Why a collection can't be saved with these custom servers beside other accounts. */
export function mixedCollectionError(names: string[]): string {
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${list} can only be collected on ${names.length > 1 ? "their" : "its"} own. Give ${names.length > 1 ? "each" : "it"} a separate collection, or turn on “Share collections” on the account's page.`;
}

export interface CollectionInput {
  name?: string;
  recipe?: RecipeId;
  connector_ids?: string[];
  label?: string;
  source?: string;
  instructions?: string;
  schedule?: Collection["schedule"];
  run_at?: string | null;
  every_hours?: number | null;
  lookback_hours?: number;
  lookahead_days?: number;
  event_push?: boolean;
  skip_quiet?: boolean;
  enabled?: boolean;
}

function validateCollection(c: Omit<Collection, "id" | "created_at" | "updated_at" | "next_run_at" | "last_run_at" | "last_status">) {
  if (!c.name.trim()) throw new AthenaInputError("Give the collection a name");
  if (c.connector_ids.length === 0) throw new AthenaInputError("Pick at least one account to collect from");
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(c.source)) throw new AthenaInputError("Invalid source label");
  if (!Number.isInteger(c.lookahead_days) || c.lookahead_days < 0 || c.lookahead_days > 60) throw new AthenaInputError("Sync 0–60 days ahead");
  if (c.recipe === "custom" && !c.instructions.trim()) throw new AthenaInputError("A custom collection needs instructions");
  if (c.schedule === "daily" && (!c.run_at || !TIME_RE.test(c.run_at.slice(0, 5)))) throw new AthenaInputError("Pick a time, e.g. 07:00");
  if (c.schedule === "hourly" && (!c.every_hours || c.every_hours < 1 || c.every_hours > 168)) {
    throw new AthenaInputError("Run every 1–168 hours");
  }
}

export async function listCollections(): Promise<Collection[]> {
  return q<Collection>(`SELECT ${COLLECTION_COLUMNS} FROM collections ORDER BY created_at ASC`);
}

export async function getCollection(id: string): Promise<Collection | null> {
  const [row] = await q<Collection>(`SELECT ${COLLECTION_COLUMNS} FROM collections WHERE id = $1`, [id]);
  return row ?? null;
}

export async function upsertCollection(id: string | undefined, input: CollectionInput, now = new Date()): Promise<Collection> {
  const existing = id ? await getCollection(id) : null;
  if (id && !existing) throw new AthenaInputError("Collection not found", 404);
  const merged = {
    name: input.name ?? existing?.name ?? "",
    recipe: input.recipe ?? existing?.recipe ?? "custom",
    connector_ids: input.connector_ids ?? existing?.connector_ids ?? [],
    label: (input.label ?? existing?.label ?? "").trim(),
    source: input.source ?? existing?.source ?? "",
    instructions: input.instructions ?? existing?.instructions ?? "",
    schedule: input.schedule ?? existing?.schedule ?? "daily",
    run_at: input.run_at !== undefined ? input.run_at : (existing?.run_at ?? null),
    every_hours: input.every_hours !== undefined ? input.every_hours : (existing?.every_hours ?? null),
    lookback_hours: input.lookback_hours ?? existing?.lookback_hours ?? 36,
    lookahead_days: input.lookahead_days ?? existing?.lookahead_days ?? 0,
    event_push: input.event_push ?? existing?.event_push ?? false,
    skip_quiet: input.skip_quiet ?? existing?.skip_quiet ?? true,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  validateCollection(merged);
  if (merged.connector_ids.length) {
    const found = await q<{ id: string; name: string; provider: string; share_collections: boolean }>(
      `SELECT id, name, provider, share_collections FROM connectors WHERE id = ANY($1::uuid[])`,
      [merged.connector_ids],
    );
    if (found.length !== new Set(merged.connector_ids).size) throw new AthenaInputError("One of those accounts no longer exists");
    // A custom server shares a collection (one model, every account's tools) only with its own switch on.
    // A collection saved before this rule can still be edited as it stands: the run leaves the server out instead.
    const sameAccounts = !!existing && existing.connector_ids.length === merged.connector_ids.length && merged.connector_ids.every((c) => existing.connector_ids.includes(c));
    // Named in the order the owner picked them.
    found.sort((a, b) => merged.connector_ids.indexOf(a.id) - merged.connector_ids.indexOf(b.id));
    const apart = sameAccounts ? [] : keptApart(found);
    if (apart.length) throw new AthenaInputError(mixedCollectionError(apart.map((c) => c.name)));
  }
  const scheduleChanged =
    !existing ||
    existing.schedule !== merged.schedule ||
    existing.run_at !== merged.run_at ||
    existing.every_hours !== merged.every_hours ||
    existing.enabled !== merged.enabled;
  const tz = await getOwnerTimeZone();
  const next = scheduleChanged ? computeNextRun(merged, now, tz) : existing?.next_run_at ? new Date(existing.next_run_at) : computeNextRun(merged, now, tz);
  const params = [
    merged.name.trim(),
    merged.recipe,
    merged.connector_ids,
    merged.label,
    merged.source,
    merged.instructions,
    merged.schedule,
    merged.schedule === "daily" ? merged.run_at : null,
    merged.schedule === "hourly" ? merged.every_hours : null,
    merged.lookback_hours,
    merged.enabled,
    next ? next.toISOString() : null,
    merged.lookahead_days,
    merged.event_push,
    merged.skip_quiet,
  ];
  const [row] = existing
    ? await q<Collection>(
        `UPDATE collections SET name = $1, recipe = $2, connector_ids = $3, label = $4, source = $5, instructions = $6,
           schedule = $7, run_at = $8, every_hours = $9, lookback_hours = $10, enabled = $11, next_run_at = $12,
           lookahead_days = $13, event_push = $14, skip_quiet = $15, updated_at = now()
         WHERE id = $16 RETURNING ${COLLECTION_COLUMNS}`,
        [...params, existing.id],
      )
    : await q<Collection>(
        `INSERT INTO collections (name, recipe, connector_ids, label, source, instructions, schedule, run_at, every_hours,
           lookback_hours, enabled, next_run_at, lookahead_days, event_push, skip_quiet)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${COLLECTION_COLUMNS}`,
        params,
      );
  return row;
}

export async function deleteCollection(id: string): Promise<boolean> {
  const rows = await q<{ id: string }>(`DELETE FROM collections WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/**
 * Claim every collection that's due: move its next_run_at on (so a second,
 * overlapping scheduler tick can't claim it too) and queue a run.
 */
export async function claimDueCollections(now = new Date(), opts: { recipes?: RecipeId[] } = {}): Promise<CollectionRun[]> {
  const tz = await getOwnerTimeZone();
  const due = await q<Collection>(
    `SELECT ${COLLECTION_COLUMNS} FROM collections
     WHERE enabled AND schedule <> 'manual' AND next_run_at IS NOT NULL AND next_run_at <= $1 AND ($2::text[] IS NULL OR recipe = ANY($2::text[]))
     ORDER BY next_run_at ASC LIMIT 20`,
    [now.toISOString(), opts.recipes ?? null],
  );
  const runs: CollectionRun[] = [];
  for (const c of due) {
    const next = computeNextRun(c, now, tz);
    const claimed = await q<{ id: string }>(
      `UPDATE collections SET next_run_at = $2 WHERE id = $1 AND next_run_at = $3 RETURNING id`,
      [c.id, next ? next.toISOString() : null, c.next_run_at],
    );
    if (claimed.length) runs.push(await queueRun(c.id, "schedule"));
  }
  return runs;
}

// ---------- Runs ----------

export async function queueRun(collectionId: string, trigger: CollectionRun["trigger"]): Promise<CollectionRun> {
  const [run] = await q<CollectionRun>(
    `INSERT INTO collection_runs (collection_id, trigger) VALUES ($1, $2) RETURNING *`,
    [collectionId, trigger],
  );
  return run;
}

/** queued → running, exactly once (a retried background invocation can't double-run). */
export async function startRun(runId: string): Promise<CollectionRun | null> {
  const [run] = await q<CollectionRun>(
    `UPDATE collection_runs SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued' RETURNING *`,
    [runId],
  );
  return run ?? null;
}

export async function finishRun(
  runId: string,
  result: { status: "succeeded" | "failed"; summary?: string; error?: string; stats?: RunStatsJson },
): Promise<void> {
  // The model's summary names what it saved, so it's sealed; if this deploy can't seal, the run is still recorded.
  let summary = "";
  try {
    summary = (await sealer()).text((result.summary ?? "").slice(0, 4000));
  } catch (error) {
    if (!(error instanceof DataBoxError)) throw error;
  }
  const [run] = await q<{ collection_id: string }>(
    `UPDATE collection_runs SET status = $2, finished_at = now(), summary = $3, error = $4, stats = $5::jsonb
     WHERE id = $1 RETURNING collection_id`,
    [runId, result.status, summary, (result.error ?? "").slice(0, 2000), JSON.stringify(result.stats ?? {})],
  );
  if (run) {
    await q(`UPDATE collections SET last_run_at = now(), last_status = $2 WHERE id = $1`, [run.collection_id, result.status]);
  }
}

export async function listRuns(collectionId: string, limit = 20): Promise<CollectionRun[]> {
  return openQ<CollectionRun>(
    `SELECT * FROM collection_runs WHERE collection_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [collectionId, limit],
  );
}

export async function hasOpenRun(collectionId: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `SELECT id FROM collection_runs WHERE collection_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
    [collectionId],
  );
  return rows.length > 0;
}

const SAVED_KEYS = ["notes_created", "events_created", "bookings_created", "purchases_created", "renewals_created", "todos", "entries_created", "plays_new", "watches_new", "likes_new", "issues_new", "prs_new"] as const;

/** What a run saved, as one number: new records, not updates (a calendar re-sync updates every event). */
export function savedCount(stats: RunStatsJson | null | undefined): number {
  return SAVED_KEYS.reduce((n, k) => n + (typeof stats?.[k] === "number" ? (stats[k] as number) : 0), 0);
}

const blockedIds = (stats: RunStatsJson | null | undefined): string[] =>
  Array.isArray(stats?.blocked_by) ? stats.blocked_by.filter((x): x is string => typeof x === "string") : [];

/** An account a run couldn't open, and why. */
export interface BlockedAccount {
  name: string;
  auth_type?: ConnectorAuthType;
  signedOut: boolean;
}

/**
 * Why a run that reached no account failed, in the owner's words:
 * "Personal Gmail is signed out", "GitHub's key stopped working",
 * "Athena couldn't reach Company wiki". Never a provider's error code.
 */
export function blockedRunError(blocked: BlockedAccount[]): string {
  if (blocked.length === 0) return "It has no accounts to read";
  const signedOut = blocked.filter((b) => b.signedOut && b.auth_type !== "token").map((b) => b.name);
  const keys = blocked.filter((b) => b.signedOut && b.auth_type === "token").map((b) => b.name);
  const down = blocked.filter((b) => !b.signedOut).map((b) => b.name);
  const and = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  return [
    signedOut.length ? `${and(signedOut)} ${signedOut.length > 1 ? "are" : "is"} signed out` : "",
    keys.length ? (keys.length > 1 ? `The keys for ${and(keys)} stopped working` : `${keys[0]}'s key stopped working`) : "",
    down.length ? `Athena couldn't reach ${and(down)}` : "",
  ]
    .filter(Boolean)
    .join(". ");
}

/** Each collection's run in flight and newest finished run, by collection id. */
export async function listRunState(): Promise<Map<string, { current_run: CurrentRun | null; last_run: LastRun | null }>> {
  const [open, done] = await Promise.all([
    q<CurrentRun & { collection_id: string }>(
      `SELECT DISTINCT ON (collection_id) collection_id, id, status, started_at FROM collection_runs
       WHERE status IN ('queued', 'running') ORDER BY collection_id, created_at DESC`,
    ),
    q<{ collection_id: string; id: string; status: LastRun["status"]; finished_at: string | null; error: string; stats: RunStatsJson }>(
      `SELECT DISTINCT ON (collection_id) collection_id, id, status, finished_at, error, stats FROM collection_runs
       WHERE status IN ('succeeded', 'failed') ORDER BY collection_id, finished_at DESC NULLS LAST, created_at DESC`,
    ),
  ]);
  const out = new Map<string, { current_run: CurrentRun | null; last_run: LastRun | null }>();
  const at = (id: string) => out.get(id) ?? out.set(id, { current_run: null, last_run: null }).get(id)!;
  for (const r of open) at(r.collection_id).current_run = { id: r.id, status: r.status, started_at: r.started_at };
  for (const r of done) {
    at(r.collection_id).last_run = { id: r.id, status: r.status, finished_at: r.finished_at, error: r.error, saved: savedCount(r.stats), blocked_by: blockedIds(r.stats) };
  }
  return out;
}

/** Collections with `current_run` and `last_run` filled in. */
export async function listCollectionsWithRuns(): Promise<Array<Collection & { current_run: CurrentRun | null; last_run: LastRun | null }>> {
  const [collections, runs] = await Promise.all([listCollections(), listRunState()]);
  return collections.map((c) => ({ ...c, current_run: null, last_run: null, ...runs.get(c.id) }));
}

/** One thing a run saved: names and dates only. */
export interface RunItem {
  /** A note or event it saved, or a day it wrote entries for (record_id is then the date). */
  kind: CollectedKind | "day";
  record_id: string;
  title: string;
  item_date: string | null;
  /** You archived it, or the collector did when its source item went away. */
  archived: boolean;
  /** Made by this run (false: an earlier one, updated now). */
  new: boolean;
}

/** At most this many items per run (a run saves at most 40 notes; a calendar can sync 150 events). */
export const RUN_ITEMS_LIMIT = 200;

/**
 * What a run saved: the collection's collected items whose `collected_at`
 * falls inside the run's window (started → finished, or now while it runs).
 * Runs of one collection never overlap, so the window is exact for it.
 * Deleted records are left out. Null when the run isn't this collection's.
 */
export async function listRunItems(collectionId: string, runId: string): Promise<RunItem[] | null> {
  // Runs since 0023 list exactly what they saved (collected_items.run_id).
  // Older runs fall back to their window, among items no run has claimed.
  // No setting (a database made from db/schema.sql) means no older runs.
  const [run] = await q<{ source: string; exact: boolean }>(
    `SELECT c.source, r.created_at >= COALESCE((SELECT (value #>> '{}')::timestamptz FROM settings WHERE key = 'run_items_exact_since'), '-infinity') AS exact
     FROM collection_runs r JOIN collections c ON c.id = r.collection_id
     WHERE r.id = $1 AND r.collection_id = $2`,
    [runId, collectionId],
  );
  if (!run) return null;
  // A Life log run writes Days (lib/days.ts): each day it wrote entries for, with that day's line.
  const days = await openQ<RunItem>(
    `SELECT 'day' AS kind, to_char(e.date, 'YYYY-MM-DD') AS record_id, COALESCE(d.line, '') AS title, to_char(e.date, 'YYYY-MM-DD') AS item_date,
            false AS archived, bool_or(e.created_at >= COALESCE(r.started_at, r.created_at)) AS new
     FROM day_entries e JOIN collection_runs r ON r.id = e.run_id LEFT JOIN days d ON d.date = e.date
     WHERE e.run_id = $1::uuid AND e.archived_at IS NULL
     GROUP BY e.date, d.line ORDER BY e.date DESC LIMIT 62`,
    [runId],
  );
  // Times compared in SQL: a JS Date would round them to the millisecond.
  const records = await openQ<RunItem>(
    `WITH r AS (SELECT COALESCE(started_at, created_at) AS from_at, finished_at FROM collection_runs WHERE id = $2::uuid)
     SELECT ci.kind, ci.record_id, ci.title, to_char(ci.item_date, 'YYYY-MM-DD') AS item_date,
            COALESCE(n.archived_at, e.archived_at) IS NOT NULL AS archived,
            COALESCE(n.created_at, e.created_at) >= r.from_at AS new
     FROM collected_items ci CROSS JOIN r
     LEFT JOIN notes n ON ci.kind = 'note' AND n.id = ci.record_id
     LEFT JOIN events e ON ci.kind = 'event' AND e.id = ci.record_id
     WHERE ci.source = $1 AND ${run.exact ? "ci.run_id = $2::uuid" : "ci.run_id IS NULL AND ci.collected_at >= r.from_at AND ci.collected_at <= COALESCE(r.finished_at, now())"}
       AND COALESCE(n.id, e.id) IS NOT NULL
     ORDER BY 6 DESC, ci.item_date DESC NULLS LAST, ci.collected_at DESC
     LIMIT ${RUN_ITEMS_LIMIT}`,
    [run.source, runId],
  );
  return [...days, ...records].slice(0, RUN_ITEMS_LIMIT);
}

/** Runs a crashed or timed-out invocation left behind (background functions stop at 15 minutes). */
export async function failStaleRuns(olderThanMinutes = 20): Promise<number> {
  const rows = await q<{ id: string; collection_id: string }>(
    `UPDATE collection_runs SET status = 'failed', finished_at = now(),
       error = CASE WHEN status = 'queued' THEN 'Never started' ELSE 'Stopped before finishing (time limit or crash)' END
     WHERE status IN ('queued', 'running') AND created_at < now() - make_interval(mins => $1)
     RETURNING id, collection_id`,
    [olderThanMinutes],
  );
  for (const r of rows) await q(`UPDATE collections SET last_status = 'failed' WHERE id = $1`, [r.collection_id]);
  return rows.length;
}

// ---------- Collected items: what each source item became ----------

export type CollectedKind = "note" | "event";

export interface CollectedItem {
  external_id: string;
  record_id: string;
  title: string;
  item_date: string | null;
  archived_by_collector: boolean;
  /** live; archived (by you, or by the collector when the source item went away); deleted (by you). */
  state: "live" | "archived" | "deleted";
}

const COLLECTED_TABLE: Record<CollectedKind, string> = { note: "notes", event: "events" };

const collectedSelect = (kind: CollectedKind) => `
  SELECT ci.external_id, ci.record_id, ci.title, to_char(ci.item_date, 'YYYY-MM-DD') AS item_date, ci.archived_by_collector,
         CASE WHEN r.id IS NULL THEN 'deleted' WHEN r.archived_at IS NOT NULL THEN 'archived' ELSE 'live' END AS state
  FROM collected_items ci LEFT JOIN ${COLLECTED_TABLE[kind]} r ON r.id = ci.record_id
  WHERE ci.source = $1 AND ci.kind = '${kind}'`;

/** What a source item became last time, and whether it's still there. */
export async function getCollected(source: string, kind: CollectedKind, externalId: string): Promise<CollectedItem | null> {
  const [row] = await openQ<CollectedItem>(`${collectedSelect(kind)} AND ci.external_id = $2`, [source, externalId]);
  return row ?? null;
}

/**
 * The items a collection holds for a window of item dates (inclusive), live
 * or archived by the collector — what a run compares against the source to
 * find cancellations. Things you archived or deleted aren't listed. Ordered
 * by date, then title (titles are encrypted, so that part is sorted here).
 */
export async function listCollected(source: string, kind: CollectedKind, from: string, to: string, limit = 200): Promise<CollectedItem[]> {
  const rows = await openQ<CollectedItem>(
    `${collectedSelect(kind)} AND ci.item_date BETWEEN $2::date AND $3::date ORDER BY ci.item_date LIMIT $4`,
    [source, from, to, limit],
  );
  return rows
    .filter((r) => r.state === "live" || (r.state === "archived" && r.archived_by_collector))
    .sort((a, b) => (a.item_date ?? "").localeCompare(b.item_date ?? "") || a.title.localeCompare(b.title));
}

/**
 * A meeting's note and its synced calendar event share the event's id: link
 * the note to the event (relation "notes_for") for every such pair this
 * collection holds, both live. Safe to run on every run; it only adds what's
 * missing, so notes written before events were synced catch up too.
 */
export async function linkCollectedMeetings(source: string): Promise<number> {
  const rows = await q<{ id: string }>(
    `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, origin)
     SELECT 'note', n.record_id, 'event', e.record_id, 'notes_for', 'manual'
     FROM collected_items n
     JOIN collected_items e ON e.source = n.source AND e.kind = 'event' AND e.external_id = n.external_id
     JOIN notes nn ON nn.id = n.record_id AND nn.archived_at IS NULL
     JOIN events ee ON ee.id = e.record_id AND ee.archived_at IS NULL
     WHERE n.source = $1 AND n.kind = 'note'
     ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO NOTHING
     RETURNING id`,
    [source],
  );
  return rows.length;
}

export async function recordCollected(input: {
  source: string;
  kind: CollectedKind;
  externalId: string;
  recordId: string;
  title: string;
  itemDate?: string | null;
  /** The run saving it (0023), so the run's items list is exact. */
  runId?: string | null;
}): Promise<void> {
  const s = await sealer();
  await q(
    `INSERT INTO collected_items (source, kind, external_id, record_id, title, item_date, run_id) VALUES ($1, $2, $3, $4, $5, $6::date, $7::uuid)
     ON CONFLICT (source, kind, external_id) DO UPDATE SET
       record_id = EXCLUDED.record_id, title = EXCLUDED.title,
       item_date = COALESCE(EXCLUDED.item_date, collected_items.item_date),
       archived_by_collector = false, collected_at = now(), run_id = EXCLUDED.run_id`,
    [input.source, input.kind, input.externalId, input.recordId, s.text(input.title.slice(0, 300)), input.itemDate ?? null, input.runId ?? null],
  );
}

export async function setArchivedByCollector(source: string, kind: CollectedKind, externalId: string, value: boolean): Promise<void> {
  await q(`UPDATE collected_items SET archived_by_collector = $4 WHERE source = $1 AND kind = $2 AND external_id = $3`, [source, kind, externalId, value]);
}

/**
 * A collection's daily count: one value per metric, collection and London day.
 * Running again the same day replaces the value instead of adding another.
 */
export async function replaceDailyMetric(input: {
  metric: string;
  value: number;
  day: string;
  source: string;
  /** The zone `day` is in. */
  tz?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await q(
    `WITH gone AS (
       DELETE FROM metrics WHERE metric = $1 AND metadata->>'source' = $3 AND metadata->>'day' = $4
     )
     INSERT INTO metrics (metric, value, recorded_at, metadata) VALUES ($1, $2, $5, $6::jsonb)`,
    [
      input.metric,
      input.value,
      input.source,
      input.day,
      zonedToInstant(input.day, "12:00", input.tz ?? DEFAULT_TZ).toISOString(),
      JSON.stringify({ ...input.metadata, source: input.source, day: input.day }),
    ],
  );
}

/**
 * Find a live person / project / organisation by name (case-insensitive) —
 * or, for people, by email — so collectors reuse records instead of adding
 * a duplicate every run. People's names and emails are encrypted, so they're
 * matched by blind index (or by plain value on rows not encrypted yet).
 */
export async function findEntityByName(kind: Extract<EntityType, "person" | "project" | "organisation">, name: string, email?: string): Promise<string | null> {
  if (kind !== "person") {
    const table = { project: "projects", organisation: "organisations" }[kind];
    const [row] = await q<{ id: string }>(
      `SELECT id FROM ${table} WHERE archived_at IS NULL AND lower(name) = lower($1) ORDER BY updated_at DESC LIMIT 1`,
      [name.trim()],
    );
    return row?.id ?? null;
  }
  const n = matchKey.name(name);
  const e = matchKey.email(email ?? "");
  // The same email beats the same name: two people can share a name, not an address.
  const [row] = await q<{ id: string }>(
    `SELECT id FROM people WHERE archived_at IS NULL AND (
       name_bidx = ANY($3::text[]) OR (name_bidx IS NULL AND name NOT LIKE 'enc:%' AND lower(trim(name)) = $1)
       OR ($2 <> '' AND (email_bidx = ANY($4::text[]) OR (email_bidx IS NULL AND email NOT LIKE 'enc:%' AND lower(trim(email)) = $2))))
     ORDER BY COALESCE($2 <> '' AND (email_bidx = ANY($4::text[]) OR (email_bidx IS NULL AND email NOT LIKE 'enc:%' AND lower(trim(email)) = $2)), false) DESC,
       updated_at DESC
     LIMIT 1`,
    [n, e, lookupIndexes("name", n), e ? lookupIndexes("email", e) : []],
  );
  return row?.id ?? null;
}

/** The window a run covers and what time it is in `tz` (the owner's zone), for the prompt ("yesterday and today"). */
export function windowDescription(lookbackHours: number, now = new Date(), tz: string = DEFAULT_TZ): { start: string; end: string; today: string } {
  return {
    start: new Date(now.getTime() - lookbackHours * 3600000).toISOString(),
    end: now.toISOString(),
    today: `${zonedToday(now, tz)} ${zonedParts(now, tz).time} (${tz})`,
  };
}
