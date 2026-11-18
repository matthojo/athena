/**
 * Starling without MCP: a narrow, read-only adapter over Starling's public
 * API (api.starlingbank.com/api/v2), registered in direct.ts. The owner makes
 * a personal access token at developer.starlingbank.com with account:read
 * and transaction:read; it doesn't expire. Starling allows about 5 requests
 * a second and 1,000 a day, so the feed is read a month at a time.
 *
 * mandates: direct debit mandates (GET /direct-debit/mandates), with the
 * optional mandate:read scope. Regular payments use them to settle bills
 * (lib/recurring.ts); a token without the scope just goes without.
 *
 * feed(after, before): spending in the main account's default space, from
 * /feed/account/{account}/category/{category}/transactions-between. Money
 * out only, settled or pending; declined, reversed and moves between your
 * own spaces are left out.
 *
 * A token without one of the two scopes is refused with 403: the account
 * shows needs_auth and says which to tick. Amounts never go into an error
 * or a log line, and these tools are never offered to Claude.
 */
import { STARLING_API_URL } from "../../../lib/presets/life";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { categoryOf, type MoneyTxn } from "../../../lib/money";
import type { Mandate } from "../../../lib/recurring";
import { ToolInputError } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { LifeApiError, WINDOW_PROPS, account, getJson, lifeAccountProblem, lifeFailure, ownerZone, readOnly, windowOf, withItems, type LifeTool } from "./lifelog-b-http";

const HOSTS = ["api.starlingbank.com"];
const MAX_DAYS = 31;

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("starling", 401, "Starling didn't accept that token. Make a new personal access token at developer.starlingbank.com and paste it under Edit.", true);
  // Starling says which scope is missing; the fix is the same either way.
  if (status === 403) return new LifeApiError("starling", 403, "That token can't read your spending. Make a new one with account:read and transaction:read ticked, and paste it under Edit.", true);
  if (status === 429) return new LifeApiError("starling", 429, "Starling is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("starling", status, "Starling is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("starling", 400, "Starling didn't understand those dates");
  return new LifeApiError("starling", status, `Starling refused that (${status})`);
}

export interface StarlingContext {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  accountUid: string;
  categoryUid: string;
  tz: string;
}

export interface RawFeedItem {
  feedItemUid: string;
  amount?: { currency?: string; minorUnits?: number };
  direction?: "IN" | "OUT";
  transactionTime?: string;
  status?: string;
  source?: string;
  spendingCategory?: string;
  counterPartyName?: string;
  counterPartyType?: string;
}

const NOT_SPENDING = new Set(["INTERNAL_TRANSFER", "STARLING_PAY_STRIPE"]);

/** Spending only, in positive minor units. */
export function starlingTxn(f: RawFeedItem): MoneyTxn | null {
  if (f.direction !== "OUT" || !f.transactionTime || !f.amount?.minorUnits) return null;
  if (f.status === "DECLINED" || f.status === "REVERSED" || f.status === "REFUNDED") return null;
  if ((f.source && NOT_SPENDING.has(f.source)) || f.counterPartyType === "CATEGORY") return null;
  const merchant = f.counterPartyName?.trim() || undefined;
  const category = categoryOf("starling", f.spendingCategory, merchant);
  if (!category) return null;
  return { id: f.feedItemUid, at: f.transactionTime, amount: f.amount.minorUnits, currency: f.amount.currency || "GBP", category, ...(merchant ? { merchant } : {}), ...(f.source === "DIRECT_DEBIT" ? { kind: "debit" as const } : {}) };
}

/** A direct debit mandate as Starling gives it (only what Athena reads). */
export interface RawMandate {
  uid?: string;
  status?: string;
  originatorName?: string;
  lastPayment?: { lastDate?: string; lastAmount?: { currency?: string; minorUnits?: number } };
}

/** Who's set up to take a direct debit, and whether it's still live. */
export function starlingMandate(m: RawMandate): Mandate | null {
  const name = m.originatorName?.trim();
  if (!name) return null;
  const last = m.lastPayment;
  const on = last?.lastDate?.slice(0, 10);
  return {
    name,
    live: (m.status ?? "").toUpperCase() === "LIVE",
    ...(on && /^\d{4}-\d{2}-\d{2}$/.test(on) ? { last_on: on } : {}),
    ...(last?.lastAmount?.minorUnits ? { last_amount: last.lastAmount.minorUnits, currency: last.lastAmount.currency || "GBP" } : {}),
  };
}

export const STARLING_TOOLS: LifeTool<StarlingContext>[] = [
  {
    name: "feed",
    summary: "See what you spent",
    description: `Spending from your main account in a window, oldest first: id, at, amount (minor units spent), currency, category (Athena's), merchant. At most ${MAX_DAYS} days a call. Default: the last 7 days.`,
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS } },
    annotations: readOnly,
    async run(ctx, args) {
      const w = windowOf(args, ctx.tz);
      const before = w.before ?? Date.now();
      const after = w.after ?? before - 7 * 86_400_000;
      if (before - after > MAX_DAYS * 86_400_000) throw new ToolInputError(`Ask for ${MAX_DAYS} days or fewer at a time`);
      const body = await ctx.get<{ feedItems?: RawFeedItem[] }>(`/feed/account/${ctx.accountUid}/category/${ctx.categoryUid}/transactions-between`, {
        minTransactionTimestamp: new Date(after).toISOString(),
        maxTransactionTimestamp: new Date(before).toISOString(),
      });
      const items = (body.feedItems ?? [])
        .map(starlingTxn)
        .filter((t): t is MoneyTxn => !!t)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      return withItems(items, {});
    },
  },
  {
    name: "mandates",
    summary: "See your direct debits",
    description: "Your direct debit mandates: who can take a payment (name), whether it's live, and the last payment taken (last_on, last_amount in minor units, currency). Needs mandate:read on the token.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
    async run(ctx) {
      let body: { mandates?: RawMandate[] };
      try {
        body = await ctx.get<{ mandates?: RawMandate[] }>("/direct-debit/mandates");
      } catch (error) {
        // A token made before mandate:read was asked for: no mandates, and the account stays fine.
        if (error instanceof LifeApiError && error.status === 403) return withItems([], { unavailable: "mandate:read isn't ticked on this token" });
        throw error;
      }
      return withItems((body.mandates ?? []).map(starlingMandate).filter((m): m is Mandate => !!m), {});
    },
  },
];

const UID = /^[0-9a-f-]{36}$/i;

/** Open with the token: the main account and its default space, which also proves account:read. */
export async function openStarling(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("starling", 401, "Paste your Starling personal access token.", true);
  const get = <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${STARLING_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return getJson<T>(url.toString(), { service: "starling", hosts: HOSTS, headers: { Authorization: `Bearer ${token}` }, refused, unreachable: "Couldn't reach Starling" });
  };
  const body = await get<{ accounts?: Array<{ accountUid?: string; defaultCategory?: string; accountType?: string }> }>("/accounts");
  const main = (body.accounts ?? []).find((a) => a.accountType === "PRIMARY") ?? body.accounts?.[0];
  if (!main?.accountUid || !main.defaultCategory || !UID.test(main.accountUid) || !UID.test(main.defaultCategory)) throw new LifeApiError("starling", 404, "Starling shows no account for this token.", true);
  return account("starling", STARLING_TOOLS, { get, accountUid: main.accountUid, categoryUid: main.defaultCategory, tz: tz ?? (await ownerZone()) });
}

export const starlingAdapter: DirectAdapter = {
  id: "starling",
  handles: (c) => c.provider === "starling" && c.auth_type === "token",
  tools: () => STARLING_TOOLS,
  serverInfo: () => ({ website_url: "https://www.starlingbank.com/" }),
  open: (connector, secrets) => openStarling(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("starling", e),
  failure: (e) => lifeFailure("starling", e),
};
