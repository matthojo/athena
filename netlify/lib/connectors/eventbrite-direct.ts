/**
 * Eventbrite without MCP: a narrow, read-only adapter over Eventbrite's v3
 * API (www.eventbriteapi.com/v3), registered in direct.ts.
 *
 * The account is the private token of the owner's own API key
 * (eventbrite.com/platform/api-keys), sent as a Bearer token. Calls, both
 * GETs: /users/me/ (does the token work?) and /users/me/orders/ with the
 * event and its venue expanded, paged with Eventbrite's continuation token
 * (eventbrite.com/platform/api#/reference/order). Nothing is ever bought,
 * cancelled or changed.
 *
 * Kept from an order: the event's name, start and end (the venue's local
 * time), its link, whether it's online, the venue's name and town, and the
 * order's status. Never the price, the buyer's name, email or address, or
 * anything about other attendees: those fields are dropped here and never
 * reach Claude.
 *
 * Rate limit: 2,000 calls an hour per token (Eventbrite's documented
 * default); a 429 is waited out by getJson.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { EVENTBRITE_API_URL } from "../../../lib/presets/life-b";
import { arg, clean } from "./google-api";
import { eventbriteBackfill } from "./backfill-tools";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  getJson,
  lifeAccountProblem,
  lifeFailure,
  ownerZone,
  readOnly,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";
import { eventbriteRecent } from "./activity-recent";

const BAD_TOKEN = "Eventbrite didn't accept the token. Copy the private token again from your API key at eventbrite.com/platform/api-keys and paste it under Edit.";

function refused(status: number, body: unknown): LifeApiError {
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 401 || code === "INVALID_AUTH" || code === "NO_AUTH") return new LifeApiError("eventbrite", 401, BAD_TOKEN, true);
  if (status === 403) return new LifeApiError("eventbrite", 403, "Eventbrite won't let this token read your orders. Use the private token of an API key on the account you buy tickets with.", true);
  if (status === 429) return new LifeApiError("eventbrite", 429, "Eventbrite is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("eventbrite", 503, "Eventbrite is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("eventbrite", status, `Eventbrite refused that (${status})`);
}

interface When {
  timezone?: string;
  /** The venue's local time, "2026-11-20T19:00:00". */
  local?: string;
  utc?: string;
}

/** An order as Eventbrite gives it with event and event.venue expanded, trimmed to what Athena reads. */
export interface EventbriteOrder {
  id?: string;
  status?: string;
  event_id?: string;
  event?: {
    id?: string;
    name?: { text?: string };
    start?: When;
    end?: When;
    url?: string;
    online_event?: boolean;
    venue?: { name?: string; address?: { city?: string } } | null;
  };
}

interface OrdersPage {
  orders?: EventbriteOrder[];
  pagination?: { continuation?: string; has_more_items?: boolean };
}

export interface EventbriteContext {
  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T>;
  tz: string;
}

/** Orders that still stand. Refunded, deleted and transferred ones are left out. */
const LIVE = new Set(["placed", "started", "pending"]);

const minutesBetween = (a?: string, b?: string): number | undefined => {
  const ms = a && b ? Date.parse(b) - Date.parse(a) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms < 7 * 86_400_000 ? Math.round(ms / 60_000) : undefined;
};

/** One order as a row: the event, when and where (by name), and the order id. */
export function orderRow(o: EventbriteOrder): Record<string, unknown> | null {
  const e = o.event;
  const name = e?.name?.text?.trim();
  const local = e?.start?.local;
  if (!o.id || !name || !local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  if (o.status && !LIVE.has(o.status)) return null;
  return clean({
    order_id: o.id,
    event: name,
    date: local.slice(0, 10),
    time: local.slice(11, 16),
    minutes: minutesBetween(e?.start?.utc, e?.end?.utc),
    venue: e?.online_event ? "Online" : e?.venue?.name?.trim() || undefined,
    town: e?.online_event ? undefined : e?.venue?.address?.city?.trim() || undefined,
    online: e?.online_event || undefined,
    link: e?.url?.startsWith("https://") ? e.url : undefined,
    start_utc: e?.start?.utc,
  });
}

const WHEN = ["all", "past", "upcoming"] as const;
const FILTER: Record<(typeof WHEN)[number], string> = { all: "all", past: "past", upcoming: "current_future" };

/** The owner's ticket orders, by when the event happens. */
async function listOrders(ctx: EventbriteContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const which = arg.oneOf(args, "when", WHEN) ?? "all";
  const continuation = decodeCursor<string>("eventbrite:orders", args.cursor);
  const body = await ctx.get<OrdersPage>("/users/me/orders/", { expand: "event,event.venue", time_filter: FILTER[which], continuation });
  const rows = (body.orders ?? [])
    .map(orderRow)
    .filter((r): r is Record<string, unknown> => !!r)
    .filter((r) => {
      const at = Date.parse(String(r.start_utc ?? ""));
      return !Number.isFinite(at) || ((w.after === undefined || at >= w.after) && (w.before === undefined || at < w.before));
    })
    .sort((a, b) => String(b.start_utc ?? "").localeCompare(String(a.start_utc ?? "")));
  const next = body.pagination?.has_more_items && body.pagination.continuation ? encodeCursor("eventbrite:orders", body.pagination.continuation) : undefined;
  return withItems(rows, { count: rows.length, when: which, next_cursor: next });
}

export const EVENTBRITE_TOOLS: LifeTool<EventbriteContext>[] = [
  {
    name: "list_orders",
    summary: "See the events you booked",
    description:
      "Events the owner booked tickets for on Eventbrite, latest first: event name, date and time (the venue's local time), minutes, venue name and town (or Online), and the event's link. Refunded and cancelled orders are left out. when: all (default), past or upcoming. Filter by when the event starts with date (YYYY-MM-DD) or after/before; Eventbrite pages by order, so follow next_cursor for older ones. For the Life log: one other entry per event on the day it happened, title the event, subtitle the venue, url the link, group \"Events\". Never a price or who else went: Athena doesn't read them.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        when: { type: "string", enum: [...WHEN], description: "all (default), past or upcoming." },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: listOrders,
  },
];

/** Open the account: /users/me/ answers for a token that works. */
export async function openEventbrite(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("eventbrite", 401, "Paste your Eventbrite private token under Edit.", true);
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${EVENTBRITE_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return getJson<T>(url.toString(), {
      service: "eventbrite",
      hosts: ["www.eventbriteapi.com"],
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused,
      unreachable: "Couldn't reach Eventbrite",
    });
  };
  const [, zone] = await Promise.all([get("/users/me/"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("eventbrite", EVENTBRITE_TOOLS, { get, tz: zone });
}

export const eventbriteAdapter: DirectAdapter = {
  id: "eventbrite",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: eventbriteRecent,
  handles: (c) => c.provider === "eventbrite" && c.auth_type === "token",
  tools: () => EVENTBRITE_TOOLS,
  serverInfo: () => ({ website_url: "https://www.eventbrite.com/" }),
  open: (connector, secrets) => openEventbrite(connector, secrets),
  backfill: eventbriteBackfill,
  accountProblem: (e) => lifeAccountProblem("eventbrite", e),
  failure: (e) => lifeFailure("eventbrite", e),
};
