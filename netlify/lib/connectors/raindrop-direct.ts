/**
 * Raindrop.io without MCP: a narrow, read-only adapter over Raindrop's REST
 * API (api.raindrop.io/rest/v1), registered in direct.ts.
 *
 * The account is a test token from the owner's own app in Raindrop's
 * integrations settings (developer.raindrop.io), sent as a Bearer token. A
 * test token reaches only the owner's own bookmarks. Calls, all GETs: /user
 * (does the token work?), /collections and /collections/childrens (names for
 * collection ids), and /raindrops/0 (every bookmark outside Trash, newest
 * first, 50 a page, with Raindrop's own search). Nothing is ever created,
 * moved or deleted.
 *
 * Rate limit: 120 requests a minute per user (Raindrop's X-RateLimit-Limit
 * header); a 429 is waited out by getJson.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { RAINDROP_API_URL } from "../../../lib/presets/life-b";
import { arg, clean } from "./google-api";
import { raindropBackfill } from "./backfill-tools";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  getJson,
  inWindow,
  lifeAccountProblem,
  lifeFailure,
  ownerZone,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";
import { raindropRecent } from "./activity-recent";

const BAD_TOKEN = "Raindrop.io didn't accept the token. Make a new test token in your Athena app at app.raindrop.io/settings/integrations and paste it under Edit.";
/** Raindrop's largest page. */
export const RAINDROP_PAGE = 50;

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("raindrop", 401, BAD_TOKEN, true);
  if (status === 429) return new LifeApiError("raindrop", 429, "Raindrop.io is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("raindrop", 503, "Raindrop.io is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("raindrop", status, `Raindrop.io refused that (${status})`);
}

/** A bookmark as Raindrop gives it, trimmed to what Athena reads. */
export interface Raindrop {
  _id?: number;
  title?: string;
  link?: string;
  domain?: string;
  excerpt?: string;
  type?: string;
  tags?: string[];
  important?: boolean;
  created?: string;
  collection?: { $id?: number };
}

export interface RaindropContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  /** Collection names by id, read once. */
  collections(): Promise<Map<number, string>>;
  tz: string;
}

/** Raindrop's own collection ids: -1 Unsorted, -99 Trash. */
const SPECIAL: Record<number, string> = { [-1]: "Unsorted", [-99]: "Trash" };

/** One bookmark as a row: title, site, collection, tags and when it was saved. */
export function bookmarkRow(r: Raindrop, names: Map<number, string>, tz: string): Record<string, unknown> | null {
  const created = r.created ? Date.parse(r.created) : NaN;
  const link = r.link?.trim();
  if (r._id === undefined || !Number.isFinite(created) || !link || !/^https?:\/\//i.test(link)) return null;
  const at = when(created, tz);
  const cid = r.collection?.$id;
  return clean({
    id: String(r._id),
    title: r.title?.trim() || r.domain || link,
    site: r.domain?.replace(/^www\./, "") || undefined,
    kind: r.type && r.type !== "link" ? r.type : undefined,
    collection: cid !== undefined ? (names.get(cid) ?? SPECIAL[cid]) : undefined,
    tags: r.tags?.length ? r.tags.slice(0, 20) : undefined,
    favourite: r.important || undefined,
    excerpt: r.excerpt?.trim().slice(0, 300) || undefined,
    saved_on: at.date,
    time: at.time,
    link,
  });
}

type Page = { items?: Raindrop[]; count?: number };

/** Every bookmark (collection 0: all but Trash), newest first. Raindrop pages from 0. */
const page = (ctx: RaindropContext, n: number, search?: string) => ctx.get<Page>("/raindrops/0", { sort: "-created", perpage: RAINDROP_PAGE, page: n, search });

/** What was saved in a window. Pages until the window's start, since there's no date filter. */
async function listBookmarks(ctx: RaindropContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: RAINDROP_PAGE, fallback: RAINDROP_PAGE });
  let n = decodeCursor<number>("raindrop:list", args.cursor) ?? 0;
  const names = await ctx.collections();
  const items: Record<string, unknown>[] = [];
  let next: number | undefined;
  // At most 4 pages a call, so one call stays quick.
  for (let read = 0; read < 4; read++, n++) {
    const body = await page(ctx, n);
    const got = body.items ?? [];
    for (const r of got) {
      const ms = r.created ? Date.parse(r.created) : NaN;
      if (!Number.isFinite(ms) || !inWindow(ms, w)) continue;
      const row = bookmarkRow(r, names, ctx.tz);
      if (row) items.push(row);
    }
    const oldest = got.length ? Date.parse(got.at(-1)!.created ?? "") : NaN;
    const reachedStart = w.after !== undefined && Number.isFinite(oldest) && oldest < w.after;
    if (got.length < RAINDROP_PAGE || reachedStart) break;
    if (items.length >= limit || read === 3) {
      next = n + 1;
      break;
    }
  }
  return withItems(items, { count: items.length, next_cursor: next !== undefined ? encodeCursor("raindrop:list", next) : undefined });
}

/** Raindrop's own search: words in the title, excerpt, note, link and page text, plus #tags. */
async function searchBookmarks(ctx: RaindropContext, args: Record<string, unknown>) {
  const query = arg.str(args, "query", { required: true, max: 200 })!.trim();
  const n = decodeCursor<number>("raindrop:search", args.cursor) ?? 0;
  const names = await ctx.collections();
  const body = await page(ctx, n, query);
  const items = (body.items ?? []).map((r) => bookmarkRow(r, names, ctx.tz)).filter((r): r is Record<string, unknown> => !!r);
  const total = body.count ?? items.length;
  return withItems(items, { count: total, next_cursor: (n + 1) * RAINDROP_PAGE < total ? encodeCursor("raindrop:search", n + 1) : undefined });
}

export const RAINDROP_TOOLS: LifeTool<RaindropContext>[] = [
  {
    name: "list_bookmarks",
    summary: "See the links you saved",
    description:
      "The links the owner saved in Raindrop.io, newest first: title, site, kind (article, video…), collection, tags, favourite, a short excerpt, saved_on (local date) and time, and the link. Ask one day at a time with date (YYYY-MM-DD, the owner's time zone), or use after/before. Page with next_cursor. For the Life log: one saved entry per link (title, subtitle the site, url the link, note the collection).",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        limit: { type: "integer", minimum: 1, maximum: RAINDROP_PAGE, description: "At most this many (default 50)." },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: listBookmarks,
  },
  {
    name: "search_bookmarks",
    summary: "Search your saved links",
    description: "Search the owner's Raindrop.io bookmarks with Raindrop's own search: words match the title, excerpt, note, link and saved page text; #tag finds a tag. 50 a page, newest first; page with next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find, like 'sourdough' or '#recipes'." },
        ...CURSOR_PROP,
      },
      required: ["query"],
    },
    annotations: readOnly,
    run: searchBookmarks,
  },
];

/** Open the account: /user answers for a token that works. */
export async function openRaindrop(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("raindrop", 401, "Paste your Raindrop.io test token under Edit.", true);
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${RAINDROP_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), {
      service: "raindrop",
      hosts: ["api.raindrop.io"],
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused,
      // Raindrop answers some refusals with 200 and result: false.
      bodyError: (body) => ((body as { result?: unknown } | null)?.result === false ? refused(Number((body as { status?: unknown }).status) || 400) : null),
      unreachable: "Couldn't reach Raindrop.io",
    });
  };
  let names: Promise<Map<number, string>> | undefined;
  const collections = () =>
    (names ??= Promise.all([get<{ items?: Array<{ _id?: number; title?: string }> }>("/collections"), get<{ items?: Array<{ _id?: number; title?: string }> }>("/collections/childrens")]).then(
      ([root, children]) => new Map([...(root.items ?? []), ...(children.items ?? [])].filter((c) => c._id !== undefined && c.title).map((c) => [c._id!, c.title!.trim()])),
    ));
  const [, zone] = await Promise.all([get("/user"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("raindrop", RAINDROP_TOOLS, { get, collections, tz: zone });
}

export const raindropAdapter: DirectAdapter = {
  id: "raindrop",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: raindropRecent,
  handles: (c) => c.provider === "raindrop" && c.auth_type === "token",
  tools: () => RAINDROP_TOOLS,
  serverInfo: () => ({ website_url: "https://raindrop.io/" }),
  open: (connector, secrets) => openRaindrop(connector, secrets),
  backfill: raindropBackfill,
  accountProblem: (e) => lifeAccountProblem("raindrop", e),
  failure: (e) => lifeFailure("raindrop", e),
};
