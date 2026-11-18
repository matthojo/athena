/**
 * Goodreads, read from the owner's public shelves. Goodreads closed its API
 * to new apps in December 2020 and has no MCP server, and it retired the
 * shelf RSS feeds around 28 October 2026 (every review/list_rss address now
 * answers 404). What's left without signing in is two public widgets, read
 * as text: the shelf grid (review/grid_widget/<id>?shelf=…, the latest 30
 * books on that shelf, titles and links only), and the bookshelf widget
 * (review/custom_widget/<id>, which ignores the shelf and shows the latest
 * 10 books read, with author, the owner's rating and the start of their
 * review). Neither has dates.
 *
 * So Athena remembers when it first saw each book on each shelf (in the
 * account's sealed credentials, at most 100 per shelf), and that day is the
 * book's `noticed_on`. Books already on a shelf when the account was added
 * have none, so the first run doesn't log a whole library as today's reading.
 *
 * No sign-in, nothing fetched but www.goodreads.com, and the widget is
 * read as text (never run).
 */
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import { updateConnectorSecrets, type Connector, type ConnectorSecrets } from "../../../lib/connectors";
import { arg, decodeEntities, htmlToText, tidyText } from "./google-api";
import { bookKey } from "../../../lib/goodreads-csv";
import type { DirectAdapter } from "./direct";
import {
  compact,
  getText,
  inWindow,
  lifeAccount,
  limitArg,
  local,
  offsetArg,
  READ_ONLY,
  safeZone,
  serviceAccountProblem,
  serviceFailure,
  ServiceError,
  windowArgs,
  windowSchema,
  type LifeTool,
} from "./feeds-shared";
import { goodreadsRecent } from "./activity-recent";

const SHELVES = ["read", "currently-reading", "to-read"] as const;
type Shelf = (typeof SHELVES)[number];
const KEEP_SEEN = 100;

/**
 * A pasted profile or shelf link (or an old feed link) as the profile's
 * address, https://www.goodreads.com/user/show/<id>. Anything that isn't a
 * Goodreads member's page is refused.
 */
export function goodreadsProfileUrl(raw: string): string {
  const help = "Paste your profile link, like https://www.goodreads.com/user/show/12345-yourname";
  const s = raw.trim();
  if (!s) throw new AthenaInputError(help);
  let u: URL;
  try {
    // Something with another scheme (javascript:, ftp://) is never theirs.
    if (/^[a-z][\w+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) throw new Error();
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new AthenaInputError(`That isn't a Goodreads link. ${help}`);
  }
  const host = u.hostname.toLowerCase();
  if (!(host === "goodreads.com" || host === "www.goodreads.com" || host === "m.goodreads.com") || (u.protocol !== "https:" && u.protocol !== "http:")) {
    throw new AthenaInputError(`That isn't a Goodreads link. ${help}`);
  }
  const id = /^\/(?:user\/show|review\/list|review\/list_rss|user\/updates_rss|review\/custom_widget)\/(\d{1,12})(?:[-./?]|$)/.exec(`${u.pathname}/`)?.[1];
  if (!id) throw new AthenaInputError(`That isn't a Goodreads profile. ${help}`);
  return `https://www.goodreads.com/user/show/${id}`;
}

const userId = (profile: string) => /\/user\/show\/(\d+)$/.exec(profile)![1];

function gridUrl(id: string, shelf: Shelf): string {
  return `https://www.goodreads.com/review/grid_widget/${id}?shelf=${shelf}&sort=${shelf === "read" ? "date_read" : "date_added"}&order=d&num_books=30`;
}

/** widget_id makes Goodreads honour the length (10 is its most). */
const detailUrl = (id: string) =>
  `https://www.goodreads.com/review/custom_widget/${id}?shelf=read&sort=date_read&order=d&num_books=10&widget_id=1&show_author=1&show_rating=1&show_review=1&show_title=1&show_cover=0`;

export interface WidgetBook {
  id: string;
  title: string;
  author?: string;
  rating?: string;
  review?: string;
  link?: string;
}

/** The JavaScript string the widget assigns to widget_code, unescaped (read as text, never run). */
function widgetHtml(js: string): string | null {
  const m = /var\s+widget_code\s*=\s*'((?:\\[\s\S]|[^'\\])*)'/.exec(js);
  if (!m) return null;
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_w, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "" : c));
}

const strip = (html: string) => tidyText(decodeEntities(html.replace(/<[^>]+>/g, " ")));
const noTracking = (href: string) => decodeEntities(href).replace(/\?utm_[^"]*$/, "");

/** The books in a shelf widget, newest first; null when it isn't a widget (or says it's "not correct": no such member, or a private profile). */
export function widgetBooks(js: string): WidgetBook[] | null {
  const html = widgetHtml(js);
  if (html === null || /widget is not correct/i.test(html)) return null;
  const books: WidgetBook[] = [];
  for (const block of html.split(/<div class="gr_custom_each_container[^"]*">/).slice(1)) {
    const titleDiv = /<div class="gr_custom_title[^"]*">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const href = /href="([^"]*review\/show\/(\d+)[^"]*)"/.exec(titleDiv || block);
    const fullTitle = /<a title="([^"]*)"/.exec(block)?.[1];
    const title = fullTitle ? decodeEntities(fullTitle) : strip(titleDiv);
    if (!href || !title) continue;
    const ratingDiv = /<div class="gr_custom_rating[^"]*">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "";
    const stars = (ratingDiv.match(/_star_active\.png/g) ?? []).length;
    const author = strip(/<div class="gr_custom_author[^"]*">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "").replace(/^by\s+/i, "").replace(/\s+/g, " ");
    const reviewHtml = /<div class="gr_custom_review[^"]*">([\s\S]*?)<\/div>/.exec(block)?.[1];
    const review = reviewHtml ? tidyText(htmlToText(reviewHtml)).replace(/\s+/g, " ") : "";
    books.push(compact({ id: href[2], title, author, rating: stars ? `${stars}/5` : undefined, review: review ? (review.length > 280 ? `${review.slice(0, 280).trimEnd()}…` : review) : undefined, link: noTracking(href[1]) }) as WidgetBook);
  }
  return books;
}

/** The books in a shelf grid, newest first: id, title and link. Null when it isn't a widget (no such member, or a private profile). */
export function gridBooks(js: string): WidgetBook[] | null {
  const html = widgetHtml(js);
  if (html === null || /widget is not correct/i.test(html)) return null;
  const books: WidgetBook[] = [];
  for (const m of html.matchAll(/<a title="([^"]*)"[^>]*href="([^"]*review\/show\/(\d+)[^"]*)"/g)) {
    if (books.some((b) => b.id === m[3])) continue;
    books.push({ id: m[3], title: decodeEntities(m[1]), link: noTracking(m[2]) });
  }
  return books;
}

/** A book with when Athena first saw it on the shelf, and whether that was this look. */
type Noticed = WidgetBook & { noticed?: string; fresh?: boolean };

/** When Athena first saw each book on each shelf: review id → ISO time, or "" for a book that was there when the account was added. */
export type ShelfMemory = Partial<Record<Shelf, Record<string, string>>>;
/** goodreadsImported / goodreadsWanted: books the library import already put in the Life log (goodreads-library.ts), title key → day. */
type WithMemory = ConnectorSecrets & { goodreadsSeen?: ShelfMemory; goodreadsImported?: Record<string, string>; goodreadsWanted?: Record<string, string> };

/** Saving that memory: the sealed store in production, a stand-in in tests. */
export const goodreadsMemoryStore = {
  save: (id: string, shelf: Shelf, seen: Record<string, string>) =>
    updateConnectorSecrets(id, (s) => {
      const w = s as WithMemory;
      w.goodreadsSeen = { ...w.goodreadsSeen, [shelf]: seen };
    }),
};

/** The shelf's books with the time each was first seen, and the memory updated. Pure, for tests. */
export function notice(books: WidgetBook[], seen: Record<string, string> | undefined, now: Date): { books: Noticed[]; seen: Record<string, string>; changed: boolean } {
  const first = seen === undefined;
  const next: Record<string, string> = {};
  let changed = first;
  const out = books.map((b) => {
    let at = seen?.[b.id];
    const fresh = at === undefined && !first;
    if (at === undefined) {
      at = first ? "" : now.toISOString();
      changed = true;
    }
    next[b.id] = at;
    return { ...b, noticed: at || undefined, fresh };
  });
  // Keep books that dropped off the widget for a while, so one coming back isn't new again.
  for (const [id, at] of Object.entries(seen ?? {})) if (!(id in next) && Object.keys(next).length < KEEP_SEEN) next[id] = at;
  return { books: out, seen: next, changed };
}

interface Ctx {
  shelf: (shelf: Shelf) => Promise<Noticed[]>;
  tz: string;
}

const TOOLS: LifeTool<Ctx>[] = [
  {
    name: "list_books",
    description:
      "The latest 30 books on one of the owner's Goodreads shelves, newest first: title and link, and for recently read books the author, the owner's rating and the start of their review. shelf is read (default), currently-reading or to-read. Goodreads gives no dates, so noticed_on is the day Athena first saw the book on that shelf (it can be a day late); books that were already there when the account was added have none. after/before filter on noticed_on and leave out books without it. just_noticed counts the books on the shelf seen for the first time just now.",
    summary: "See books you've read, are reading or want to read",
    inputSchema: windowSchema({ shelf: { type: "string", enum: [...SHELVES], description: "read (default), currently-reading or to-read." } }),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const shelf = arg.oneOf(args, "shelf", SHELVES) ?? "read";
      const w = windowArgs(args, ctx.tz);
      const windowed = w.after !== undefined || w.before !== undefined;
      const limit = limitArg(args);
      const offset = offsetArg(args);
      const shelved = await ctx.shelf(shelf);
      const all = shelved.filter((b) => !windowed || (b.noticed !== undefined && inWindow(Date.parse(b.noticed), w)));
      const books = all.slice(offset, offset + limit).map(({ id: _id, noticed, fresh: _fresh, ...b }) => compact({ ...b, noticed_on: local(noticed, ctx.tz).day }));
      // just_noticed: books on the shelf that this look was the first to see (precheck's "anything new?").
      return { ...compact({ shelf, books, count: books.length, total_count: all.length, next_page_token: offset + limit < all.length ? String(offset + limit) : undefined }), just_noticed: shelved.filter((b) => b.fresh).length };
    },
  },
];

const MISSING = "Goodreads has no public shelves at that address. Check the link under Edit, and that your profile is public.";

async function fetchWidget(url: string): Promise<string> {
  const res = await getText("goodreads", url, { Accept: "text/javascript, */*;q=0.5", "User-Agent": "Athena (personal notes)" }, {
    unreachable: "Couldn't reach Goodreads right now. Athena will try again next run.",
    busy: "Goodreads is limiting how often Athena can ask right now. Try again in a few minutes.",
  });
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new ServiceError("goodreads", 404, MISSING, true);
  if (res.status !== 200) throw new ServiceError("goodreads", res.status, `Goodreads refused that (${res.status}).`);
  return res.text;
}

/** A shelf's books, with author, rating and review filled in from the bookshelf widget where it has them. */
async function fetchShelf(id: string, shelf: Shelf, details: () => Promise<WidgetBook[]>): Promise<WidgetBook[]> {
  const books = gridBooks(await fetchWidget(gridUrl(id, shelf)));
  if (!books) throw new ServiceError("goodreads", 404, MISSING, true);
  const known = new Map((await details().catch(() => [] as WidgetBook[])).map((b) => [b.id, b]));
  return books.map((b) => ({ ...b, ...known.get(b.id), title: b.title }));
}

export async function openGoodreads(connector: Pick<Connector, "id" | "url">, secrets: ConnectorSecrets, opts: { tz?: string; now?: () => Date } = {}) {
  const id = userId(goodreadsProfileUrl(connector.url));
  const memory: ShelfMemory = { ...((secrets as WithMemory).goodreadsSeen ?? {}) };
  const now = opts.now ?? (() => new Date());
  const cache = new Map<Shelf, Promise<Noticed[]>>();
  let detailed: Promise<WidgetBook[]> | null = null;
  const details = () => (detailed ??= fetchWidget(detailUrl(id)).then((js) => widgetBooks(js) ?? []));
  const shelf = (s: Shelf) => {
    let p = cache.get(s);
    if (!p) {
      p = fetchShelf(id, s, details).then(async (books) => {
        const r = notice(books, memory[s], now());
        if (r.changed) {
          memory[s] = r.seen;
          (secrets as WithMemory).goodreadsSeen = { ...memory };
          await goodreadsMemoryStore.save(connector.id, s, r.seen);
        }
        // Books the library import already logged (read on their finish day, to-read on the day added) aren't logged again.
        const w = secrets as WithMemory;
        const imported = s === "read" ? w.goodreadsImported : s === "to-read" ? w.goodreadsWanted : undefined;
        return imported ? r.books.filter((b) => !Object.hasOwn(imported, bookKey(b.title))) : r.books;
      });
      cache.set(s, p);
    }
    return p;
  };
  // The check that the profile is there and public.
  await shelf("read");
  const tz = safeZone(opts.tz ?? (await getOwnerTimeZone().catch(() => undefined)));
  return lifeAccount(TOOLS, { shelf, tz }, goodreadsAccountProblem);
}

const goodreadsAccountProblem = serviceAccountProblem("goodreads");

export const goodreadsAdapter: DirectAdapter = {
  id: "goodreads",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: goodreadsRecent,
  handles: (c) => c.provider === "goodreads" && c.auth_type === "none",
  tools: () => TOOLS.map(({ run: _run, ...t }) => t),
  serverInfo: () => ({ website_url: "https://www.goodreads.com" }),
  open: (connector, secrets) => openGoodreads(connector, secrets),
  checkAddress: goodreadsProfileUrl,
  accountProblem: goodreadsAccountProblem,
  failure: (e) => serviceFailure("goodreads", e),
};
