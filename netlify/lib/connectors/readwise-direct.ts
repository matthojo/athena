/**
 * Readwise without MCP: a narrow, read-only adapter over Readwise's v2 API
 * (readwise.io/api/v2), registered in direct.ts.
 *
 * The account is the owner's access token (readwise.io/access_token), sent as
 * `Authorization: Token …`. Only two endpoints are called, both GETs:
 * /auth/ (does the token work?) and /export/ (books and articles with their
 * highlights, paged with Readwise's own cursor, filtered by updatedAfter).
 * Nothing is ever written to Readwise.
 *
 * Highlights go to Claude whole, so Ask can search and quote them. The Life
 * log prompt is told to write one line per book ("3 highlights from The
 * Wager"), never the highlights (docs/notes/readwise-social.md).
 */
import { READWISE_API_URL } from "../../../lib/presets/reading-social";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { ToolInputError, arg, clean } from "./google-api";
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
  type Window,
} from "./lifelog-b-http";
import { readwiseRecent } from "./activity-recent";

const HOSTS = ["readwise.io"];
const BAD_TOKEN = "Readwise didn't accept the access token. Copy it again at readwise.io/access_token and paste the new one here.";

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("readwise", 401, BAD_TOKEN, true);
  if (status === 429) return new LifeApiError("readwise", 429, "Readwise is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("readwise", 503, "Readwise is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("readwise", status, `Readwise refused that (${status})`);
}

/** Readwise's names for where a highlight came from, as people say them. */
const SOURCES: Record<string, string> = {
  kindle: "Kindle",
  ibooks: "Apple Books",
  apple_books: "Apple Books",
  reader: "Reader",
  instapaper: "Instapaper",
  pocket: "Pocket",
  kobo: "Kobo",
  goodreads: "Goodreads",
  medium: "Medium",
  twitter: "X",
  snipd: "Snipd",
  airr: "Airr",
  pdf: "PDF",
  web_clipper: "Web",
  api_article: "Web",
  manual: "Added by hand",
  supplemental: "Readwise",
  readwise: "Readwise",
};

export function sourceName(raw: string | undefined): string | undefined {
  const s = raw?.trim().toLowerCase();
  if (!s) return undefined;
  return SOURCES[s] ?? s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** What the export returns, trimmed to what Athena reads. */
export interface ExportHighlight {
  id?: number;
  text?: string;
  note?: string;
  location?: number | null;
  location_type?: string;
  highlighted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  is_discard?: boolean;
  is_deleted?: boolean;
  tags?: Array<{ name?: string }>;
  readwise_url?: string;
}

export interface ExportBook {
  user_book_id?: number;
  title?: string;
  readable_title?: string;
  author?: string | null;
  source?: string;
  category?: string;
  source_url?: string | null;
  unique_url?: string | null;
  readwise_url?: string;
  book_tags?: Array<{ name?: string }>;
  highlights?: ExportHighlight[];
}

interface ExportPage {
  count?: number;
  nextPageCursor?: string | number | null;
  results?: ExportBook[];
}

export interface ReadwiseContext {
  exportPage(updatedAfter: string | undefined, cursor: string | undefined): Promise<ExportPage>;
  tz: string;
}

const BY = ["added", "highlighted"] as const;
type By = (typeof BY)[number];

const ms = (s: string | null | undefined): number | undefined => {
  const n = s ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** When a highlight counts: when it reached Readwise ("added"), or when you made it ("highlighted", which Kindle and Apple Books know). */
const stamp = (h: ExportHighlight, by: By): number | undefined => (by === "highlighted" ? (ms(h.highlighted_at) ?? ms(h.created_at)) : (ms(h.created_at) ?? ms(h.updated_at)));

const live = (h: ExportHighlight) => !h.is_discard && !h.is_deleted && !!h.text?.trim();

/** A book's own link: the article itself for things read on the web, its Readwise page otherwise. */
const bookLink = (b: ExportBook): string | undefined => {
  const web = b.category && b.category !== "books" ? (b.source_url ?? b.unique_url ?? undefined) : undefined;
  return [web, b.readwise_url].find((u) => typeof u === "string" && u.startsWith("https://")) ?? undefined;
};

const kindOf = (category: string | undefined): string => (category === "books" ? "book" : category === "articles" ? "article" : category === "tweets" ? "post" : category === "podcasts" ? "podcast" : category || "book");

function bookHead(b: ExportBook) {
  return {
    title: (b.readable_title || b.title || "Untitled").trim(),
    author: b.author?.trim() || undefined,
    kind: kindOf(b.category),
    source: sourceName(b.source),
    link: bookLink(b),
  };
}

function highlightOut(h: ExportHighlight, tz: string, withText: boolean) {
  const at = ms(h.highlighted_at);
  const local = at !== undefined ? when(at, tz) : undefined;
  return clean({
    text: withText ? h.text?.trim() : undefined,
    note: withText ? h.note?.trim() || undefined : undefined,
    highlighted_on: local?.date,
    time: local?.time,
    added_on: ms(h.created_at) !== undefined ? when(ms(h.created_at)!, tz).date : undefined,
    tags: withText ? (h.tags ?? []).map((t) => t.name?.trim()).filter((t): t is string => !!t) : undefined,
    link: withText && h.readwise_url?.startsWith("https://") ? h.readwise_url : undefined,
  });
}

/** Ask for the export from just before the window opens, so nothing on its edge is missed. */
const updatedAfter = (w: Window): string | undefined => (w.after !== undefined ? new Date(w.after - 1000).toISOString() : undefined);

const DEFAULT_DAYS = 7;

async function listHighlights(ctx: ReadwiseContext, args: Record<string, unknown>) {
  let w = windowOf(args, ctx.tz);
  // Without a window the export is the whole library: the last week instead.
  if (w.after === undefined) w = { after: (w.before ?? Date.now()) - DEFAULT_DAYS * 86_400_000, before: w.before };
  const by = arg.oneOf(args, "by", BY) ?? "highlighted";
  const withText = args.text !== false && args.text !== "false";
  const cursor = decodeCursor<string>("readwise:list", args.cursor);
  const page = await ctx.exportPage(updatedAfter(w), cursor);
  const items: Record<string, unknown>[] = [];
  let count = 0;
  for (const b of page.results ?? []) {
    const hs = (b.highlights ?? []).filter((h) => live(h) && inWindow(stamp(h, by) ?? NaN, w));
    if (!hs.length) continue;
    hs.sort((a, z) => (stamp(a, by) ?? 0) - (stamp(z, by) ?? 0));
    count += hs.length;
    items.push(clean({ ...bookHead(b), highlights_count: hs.length, highlights: hs.map((h) => highlightOut(h, ctx.tz, withText)) }));
  }
  items.sort((a, z) => (z.highlights_count as number) - (a.highlights_count as number));
  const next = page.nextPageCursor;
  // The days these highlights were made on, for "by added": a late Kindle sync points back at earlier days.
  const days = new Set<string>();
  for (const b of page.results ?? [])
    for (const h of b.highlights ?? []) {
      const made = ms(h.highlighted_at) ?? ms(h.created_at);
      if (live(h) && inWindow(stamp(h, by) ?? NaN, w) && made !== undefined) days.add(when(made, ctx.tz).date);
    }
  return withItems(items, {
    count,
    books: items.length,
    by,
    days: [...days].sort(),
    next_cursor: next !== undefined && next !== null && next !== "" ? encodeCursor("readwise:list", String(next)) : undefined,
  });
}

/** Lower case, accents off, so "cafe" finds "café". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const SEARCH_PAGES = 4;
const SEARCH_BUDGET_MS = 7_000;

async function searchHighlights(ctx: ReadwiseContext, args: Record<string, unknown>) {
  const query = arg.str(args, "query", { required: true, max: 200 })!.trim();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) throw new ToolInputError("query is required");
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 20 });
  const started = Date.now();
  let cursor = decodeCursor<string>("readwise:search", args.cursor);
  const matches: Array<Record<string, unknown> & { at: number }> = [];
  let searched = 0;
  let pages = 0;
  for (;;) {
    const page = await ctx.exportPage(updatedAfter(w), cursor);
    pages++;
    for (const b of page.results ?? []) {
      searched++;
      const head = bookHead(b);
      const about = fold([head.title, head.author, ...(b.book_tags ?? []).map((t) => t.name)].filter(Boolean).join(" "));
      for (const h of b.highlights ?? []) {
        if (!live(h)) continue;
        const at = stamp(h, "highlighted") ?? 0;
        if ((w.after !== undefined || w.before !== undefined) && !inWindow(at, w)) continue;
        const hay = `${about} ${fold(`${h.text ?? ""} ${h.note ?? ""} ${(h.tags ?? []).map((t) => t.name).join(" ")}`)}`;
        if (words.every((word) => hay.includes(word))) matches.push({ at, book: head.title, author: head.author, kind: head.kind, source: head.source, book_link: head.link, ...highlightOut(h, ctx.tz, true) });
      }
    }
    const next = page.nextPageCursor;
    cursor = next !== undefined && next !== null && next !== "" ? String(next) : undefined;
    if (!cursor || pages >= SEARCH_PAGES || Date.now() - started > SEARCH_BUDGET_MS) break;
  }
  matches.sort((a, z) => z.at - a.at);
  return withItems(
    matches.slice(0, limit).map(({ at: _at, ...m }) => m),
    {
      count: matches.length,
      books_searched: searched,
      // Not every page was read: there may be more, from earlier.
      next_cursor: cursor ? encodeCursor("readwise:search", cursor) : undefined,
    },
  );
}

export const READWISE_TOOLS: LifeTool<ReadwiseContext>[] = [
  {
    name: "list_highlights",
    summary: "See what you highlighted",
    description:
      "The owner's Readwise highlights in a window, by book or article: title, author, kind, source (Kindle, Apple Books, Reader…), link, highlights_count, each highlight's text, note, tags, highlighted_on and added_on; days lists the days they were made on. by: highlighted (default) or added (reached Readwise; Kindle can be days late). date (YYYY-MM-DD, owner's zone) or after/before; none means 7 days. text: false gives counts only. Page with next_cursor. For the Life log: call with by: added, after = the window's start, text: false; then for each day in days (a late sync can name earlier days), call with date and text: false and save that day's highlight entries, one per book or article (title \"The Wager\", subtitle \"David Grann\", count 3, note \"Kindle\") with its link. Never quote a highlight or note in an entry. highlights_made_day is that day's count.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        by: { type: "string", enum: [...BY], description: "added (default) or highlighted." },
        text: { type: "boolean", description: "false for counts per book without the highlights' words (default true)." },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: listHighlights,
  },
  {
    name: "search_highlights",
    summary: "Search your highlights",
    description:
      "Find the owner's Readwise highlights that contain every word of query, in the highlight, its note or tags, or the book's title and author; newest first, with the book, author, source, text, note and highlighted_on. after/before (by when highlighted) narrow it and make it faster. Reads up to 4 pages of the library a call; next_cursor means older books are still unread.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to find, like 'habit' or 'Morgan Housel'." },
        ...WINDOW_PROPS,
        limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many highlights (default 20)." },
        ...CURSOR_PROP,
      },
      required: ["query"],
    },
    annotations: readOnly,
    run: searchHighlights,
  },
];

/** Open the account: /auth/ answers 204 for a token that works. */
export async function openReadwise(_connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("readwise", 401, "Paste your Readwise access token.", true);
  const get = <T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const url = new URL(`${READWISE_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return getJson<T>(url.toString(), {
      service: "readwise",
      hosts: HOSTS,
      headers: { Authorization: `Token ${token}`, "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused,
      unreachable: "Couldn't reach Readwise",
    });
  };
  const [, zone] = await Promise.all([get<unknown>("/auth/"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("readwise", READWISE_TOOLS, {
    exportPage: (after, cursor) => get<ExportPage>("/export/", { updatedAfter: after, pageCursor: cursor }),
    tz: zone,
  });
}

export const readwiseAdapter: DirectAdapter = {
  id: "readwise",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: readwiseRecent,
  handles: (c) => c.provider === "readwise" && c.auth_type === "token",
  tools: () => READWISE_TOOLS,
  serverInfo: () => ({ website_url: "https://readwise.io/" }),
  open: (connector, secrets) => openReadwise(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("readwise", e),
  failure: (e) => lifeFailure("readwise", e),
};
