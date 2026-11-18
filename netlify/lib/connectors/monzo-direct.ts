/**
 * Monzo without MCP: a narrow, read-only adapter over the Monzo API
 * (api.monzo.com), registered in direct.ts. Personal use only, as Monzo's
 * developer terms allow: the owner makes their own confidential OAuth client
 * at developers.monzo.com, so Athena gets refresh tokens.
 *
 * Sign-in. Monzo's consent page (auth.monzo.com) sends a code; Athena swaps
 * it with the client ID and secret in the form body (Monzo doesn't take
 * Basic auth). Monzo then asks the owner to approve in the Monzo app: until
 * they do, every read but /ping/whoami is refused with
 * forbidden.insufficient_permissions, which reads as "approve in the app".
 *
 * Monzo's two time rules (Strong Customer Authentication):
 *  - Full history only in the 5 minutes after the owner approves. Athena
 *    notes when it first saw the account open (approved_at, kept with the
 *    tokens) and the sync reads everything while that window is open.
 *  - After that, 90 days back at most. Older windows are cut to 89 days and
 *    the answer says so (`cut_to`), rather than Monzo refusing the read.
 *  - Every 90 days the owner signs in again: the refresh is refused, the
 *    account shows needs_auth, and the existing "Sign in again" push goes.
 *
 * Amounts are money (SECURITY.md §1): they go back to money-sync.ts only,
 * never into an error or a log line, and these tools are never offered to
 * Claude (runner.ts skips sealed-sync accounts).
 */
import { MONZO_API_URL } from "../../../lib/presets/life";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { categoryOf, type MoneyTxn } from "../../../lib/money";
import { clean, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  OAuthSession,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  lifeAccountProblem,
  lifeFailure,
  lifeTokenStore,
  ownerZone,
  readOnly,
  windowOf,
  withItems,
  type LifeTool,
  type TokenEndpoint,
} from "./lifelog-b-http";

export const MONZO_AUTHORIZE_URL = "https://auth.monzo.com/";
export const MONZO_TOKEN_URL = "https://api.monzo.com/oauth2/token";
const HOSTS = ["api.monzo.com"];
/** The full-history window after approval, and how far back Monzo lets an app read after it. */
export const MONZO_FULL_HISTORY_MS = 5 * 60_000;
export const MONZO_RECENT_DAYS = 89;
const REQUEST_TIMEOUT_MS = 30_000;

/** Tokens plus when the account first opened after approval (epoch ms). */
export type MonzoTokens = StoredTokens & { approved_at?: number };

const APPROVE = "Open the Monzo app and approve Athena, then try again.";

function refused(status: number, body: unknown): LifeApiError {
  const code = (body as { code?: string } | null)?.code ?? "";
  // A bad or expired token is a 400 with bad_request.invalid_token (recorded 7 Nov 2026): a sign-in problem, renewed like a 401.
  if (status === 401 || code.includes("invalid_token")) return new LifeApiError("monzo", 401, "Monzo signed Athena out. Sign in again: Monzo asks for this every 90 days.", true);
  if (status === 403 && code.includes("insufficient_permissions")) return new LifeApiError("monzo", 403, APPROVE, true);
  if (status === 403 && code.includes("verification_required")) return new LifeApiError("monzo", 403, "Monzo only shares the last 90 days now. Ask for a shorter window.");
  if (status === 403) return new LifeApiError("monzo", 403, "Monzo refused that. Sign in again and approve Athena in the Monzo app.", true);
  if (status === 429) return new LifeApiError("monzo", 429, "Monzo is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("monzo", status, "Monzo is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("monzo", 400, "Monzo didn't understand those dates");
  return new LifeApiError("monzo", status, `Monzo refused that (${status})`);
}

/** Monzo takes the client in the form body, not Basic auth. */
async function monzoToken(client: { client_id: string; client_secret?: string }, params: Record<string, string>): Promise<StoredTokens> {
  let res: Response;
  try {
    res = await fetch(MONZO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: client.client_id, client_secret: client.client_secret ?? "" }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new LifeApiError("monzo", 503, "Couldn't reach Monzo to renew the sign-in");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && typeof body?.access_token === "string") {
    return {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      expires_in: typeof body.expires_in === "number" ? body.expires_in : undefined,
      token_type: typeof body.token_type === "string" ? body.token_type : undefined,
    };
  }
  if (res.status >= 500) throw new LifeApiError("monzo", res.status, "Monzo is having trouble right now. Try again in a few minutes.");
  if (body?.error === "invalid_client") throw new LifeApiError("monzo", 401, "Monzo refused Athena's app. Check the client ID and secret under Edit, then sign in again.", true);
  throw new LifeApiError("monzo", 401, "Monzo signed Athena out. Sign in again: Monzo asks for this every 90 days.", true);
}

const TOKEN: TokenEndpoint = { service: "monzo", url: MONZO_TOKEN_URL, label: "Monzo", request: monzoToken };

export interface MonzoContext {
  get<T>(path: string, params?: Array<[string, string]>): Promise<T>;
  accountId: string;
  /** When the owner approved (first open), epoch ms. */
  approvedAt: number;
  now(): number;
  tz: string;
}

/** A transaction as Monzo gives it (only what Athena reads). */
export interface RawMonzoTxn {
  id: string;
  created: string;
  amount: number;
  currency: string;
  category?: string;
  description?: string;
  include_in_spending?: boolean;
  decline_reason?: string;
  scheme?: string;
  merchant?: { name?: string } | string | null;
  counterparty?: { name?: string } | null;
}

/** Spending only: a card payment or debit, not declined, not a move between your own pots. Positive minor units. */
export function monzoTxn(t: RawMonzoTxn): MoneyTxn | null {
  if (t.decline_reason || t.amount >= 0) return null;
  if (t.include_in_spending === false || t.scheme === "uk_retail_pot") return null;
  const merchant = (typeof t.merchant === "object" && t.merchant?.name) || t.counterparty?.name || t.description?.trim() || undefined;
  const category = categoryOf("monzo", t.category, merchant);
  if (!category) return null;
  // bacs is a direct debit: regular payments read it as a bill (lib/recurring.ts).
  return { id: t.id, at: t.created, amount: -t.amount, currency: t.currency || "GBP", category, ...(merchant ? { merchant } : {}), ...(t.scheme === "bacs" ? { kind: "debit" as const } : {}) };
}

/** The window Monzo will answer: everything inside 5 minutes of approval, then 89 days back at most. */
export function readableWindow(ctx: Pick<MonzoContext, "approvedAt" | "now">, after: number | undefined): { after: number | undefined; cut: boolean } {
  const now = ctx.now();
  if (now - ctx.approvedAt < MONZO_FULL_HISTORY_MS) return { after, cut: false };
  const floor = now - MONZO_RECENT_DAYS * 86_400_000;
  if (after === undefined) return { after: floor, cut: false };
  if (after < floor) return { after: floor, cut: true };
  return { after, cut: false };
}

const PAGE = 100;

export const MONZO_TOOLS: LifeTool<MonzoContext>[] = [
  {
    name: "transactions",
    summary: "See what you spent",
    description:
      "Spending in a window, oldest first: id, at, amount (minor units spent), currency, category (Athena's: eating_out, takeaway, groceries…), merchant. Transfers between pots and declined payments are left out. Within 5 minutes of approval Monzo gives the whole history; after that, 90 days (cut_to says where the window was cut). Page with next_cursor.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, ...CURSOR_PROP } },
    annotations: readOnly,
    async run(ctx, args) {
      const w = windowOf(args, ctx.tz);
      const { after, cut } = readableWindow(ctx, w.after);
      // The cursor is the last id read: Monzo pages forward with since=<id>.
      const since = decodeCursor<string>("monzo:tx", args.cursor) ?? (after !== undefined ? new Date(after).toISOString() : undefined);
      const params: Array<[string, string]> = [["account_id", ctx.accountId], ["limit", String(PAGE)], ["expand[]", "merchant"]];
      if (since) params.push(["since", since]);
      if (w.before !== undefined) params.push(["before", new Date(w.before).toISOString()]);
      const body = await ctx.get<{ transactions?: RawMonzoTxn[] }>("/transactions", params);
      const raw = body.transactions ?? [];
      const items = raw.map(monzoTxn).filter((t): t is MoneyTxn => !!t);
      const last = raw[raw.length - 1];
      return withItems(items, { next_cursor: raw.length >= PAGE && last ? encodeCursor("monzo:tx", last.id) : undefined, cut_to: cut && after !== undefined ? new Date(after).toISOString().slice(0, 10) : undefined });
    },
  },
  {
    name: "pots",
    summary: "See your pots' names",
    description: "Your pots' names, so a payment from a pot can be told apart. No balances: Athena never reads them.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
    async run(ctx) {
      const body = await ctx.get<{ pots?: Array<{ id?: string; name?: string; deleted?: boolean }> }>("/pots", [["current_account_id", ctx.accountId]]);
      return withItems((body.pots ?? []).filter((p) => p.id && p.name && !p.deleted).map((p) => clean({ id: p.id, name: p.name })), {});
    },
  },
];

/** Open a signed-in account: the current account's id, which also proves the owner approved Athena in the app. */
export async function openMonzo(connector: Connector, secrets: ConnectorSecrets, opts: { tz?: string; now?: () => number } = {}): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("monzo", 401, "Not signed in yet", true);
  const now = opts.now ?? Date.now;
  const session = new OAuthSession(TOKEN, connector, secrets);
  const get = <T>(path: string, params: Array<[string, string]> = []): Promise<T> => {
    const url = new URL(`${MONZO_API_URL}${path}`);
    for (const [k, v] of params) url.searchParams.append(k, v);
    return session.get<T>(url.toString(), { service: "monzo", hosts: HOSTS, refused, unreachable: "Couldn't reach Monzo" });
  };
  const body = await get<{ accounts?: Array<{ id?: string; closed?: boolean; type?: string }> }>("/accounts", [["account_type", "uk_retail"]]);
  const acct = (body.accounts ?? []).find((a) => a.id && !a.closed);
  if (!acct?.id) throw new LifeApiError("monzo", 404, "Monzo shows no open current account for this sign-in.", true);
  const tokens = secrets.tokens as MonzoTokens;
  let approvedAt = tokens.approved_at;
  if (!approvedAt) {
    approvedAt = now();
    tokens.approved_at = approvedAt;
    const at = approvedAt;
    await lifeTokenStore.save(connector.id, (s) => {
      if (s.tokens && !(s.tokens as MonzoTokens).approved_at) (s.tokens as MonzoTokens).approved_at = at;
    });
  }
  return account("monzo", MONZO_TOOLS, { get, accountId: acct.id, approvedAt, now, tz: opts.tz ?? (await ownerZone()) });
}

export function monzoAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(MONZO_AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: input.clientId, redirect_uri: input.redirectUri, response_type: "code", state: input.state }).toString();
  return url.toString();
}

export async function exchangeMonzoCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  if (!input.client.client_secret) throw new LifeApiError("monzo", 400, "Monzo needs the client secret too. Make the client Confidential at developers.monzo.com and paste its secret.", true);
  const tokens = await monzoToken(input.client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  if (!tokens.refresh_token) throw new LifeApiError("monzo", 400, "Monzo gave Athena no way to renew this sign-in. Make the client Confidential at developers.monzo.com, then sign in again.", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const monzoAdapter: DirectAdapter = {
  id: "monzo",
  handles: (c) => c.provider === "monzo" && c.auth_type === "oauth",
  tools: () => MONZO_TOOLS,
  serverInfo: () => ({ website_url: "https://monzo.com/" }),
  open: (connector, secrets) => openMonzo(connector, secrets),
  authorizationUrl: monzoAuthorizationUrl,
  exchangeCode: exchangeMonzoCode,
  accountProblem: (e) => lifeAccountProblem("monzo", e),
  failure: (e) => lifeFailure("monzo", e),
};
