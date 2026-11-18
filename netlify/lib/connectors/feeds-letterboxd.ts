/**
 * Letterboxd, read from the owner's public diary feed
 * (https://letterboxd.com/<name>/rss/). Letterboxd's API is invitation-only
 * and there's no Letterboxd MCP server, so the feed is the way in: no
 * sign-in, nothing stored but the address, and only letterboxd.com is ever
 * fetched. The feed holds the latest 50 or so entries, which is plenty for
 * a daily run.
 */
import { letterboxdBackfill } from "./backfill-tools";
import { letterboxdRecent } from "./media-recent";
import { AthenaInputError, getOwnerTimeZone } from "../../../lib/db";
import type { Connector } from "../../../lib/connectors";
import type { DirectAdapter } from "./direct";
import { fetchFeed, reviewText, rssItems } from "./feeds-rss";
import {
  compact,
  lifeAccount,
  limitArg,
  local,
  offsetArg,
  READ_ONLY,
  safeZone,
  serviceAccountProblem,
  serviceFailure,
  windowArgs,
  windowSchema,
  type LifeTool,
} from "./feeds-shared";

const HOSTS = ["letterboxd.com"];
/** First path parts that are Letterboxd pages, not members. */
const NOT_MEMBERS = new Set(["film", "films", "lists", "list", "members", "journal", "search", "settings", "activity", "pro", "about", "sign-in", "create-account", "tag", "director", "actor", "studio", "crew"]);

/**
 * A pasted profile, diary or feed link (or just the username) as the diary
 * feed's address. Anything that isn't a Letterboxd member is refused.
 */
export function letterboxdFeedUrl(raw: string): string {
  const help = "Paste your profile link, like https://letterboxd.com/yourname/";
  const s = raw.trim();
  if (!s) throw new AthenaInputError(help);
  let name: string | undefined;
  if (/^@?[A-Za-z0-9_]{2,15}$/.test(s)) name = s.replace(/^@/, "");
  else {
    let u: URL;
    try {
      // Something with another scheme (javascript:, ftp://) is never theirs.
      if (/^[a-z][\w+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) throw new Error();
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new AthenaInputError(`That isn't a Letterboxd link. ${help}`);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "letterboxd.com" || (u.protocol !== "https:" && u.protocol !== "http:")) throw new AthenaInputError(`That isn't a Letterboxd link. ${help}`);
    name = u.pathname.split("/").filter(Boolean)[0];
  }
  if (!name || NOT_MEMBERS.has(name.toLowerCase()) || !/^[A-Za-z0-9_]{2,15}$/.test(name)) throw new AthenaInputError(`That isn't a Letterboxd profile. ${help}`);
  return `https://letterboxd.com/${name.toLowerCase()}/rss/`;
}

interface Ctx {
  feed: () => Promise<Array<Record<string, string>>>;
  tz: string;
  profile: string;
}

export interface DiaryEntry {
  title: string;
  year?: number;
  watched_on: string;
  rating?: string;
  liked?: boolean;
  rewatch?: boolean;
  review?: string;
  link?: string;
}

/** A feed item as a diary entry; null for lists and anything without a watched date. */
export function diaryEntry(item: Record<string, string>): (DiaryEntry & { at: number }) | null {
  const day = item["letterboxd:watchedDate"];
  const title = item["letterboxd:filmTitle"];
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return null;
  const rating = Number(item["letterboxd:memberRating"]);
  const review = item.description ? reviewText(item.description) : "";
  return {
    at: Date.parse(`${day}T12:00:00Z`),
    ...(compact({
      title,
      year: Number(item["letterboxd:filmYear"]) || undefined,
      watched_on: day,
      rating: rating > 0 ? `${"★".repeat(Math.floor(rating))}${rating % 1 ? "½" : ""} (${rating}/5)` : undefined,
      liked: item["letterboxd:memberLike"] === "Yes" || undefined,
      rewatch: item["letterboxd:rewatch"] === "Yes" || undefined,
      // Letterboxd puts the poster and "Watched on …" in the description when there's no review.
      review: review && !/^Watched on /i.test(review) ? review : undefined,
      link: item.link,
    }) as DiaryEntry),
  };
}

const TOOLS: LifeTool<Ctx>[] = [
  {
    name: "list_diary",
    description:
      "Films the owner logged in their Letterboxd diary, newest first: title, year, the day they watched it (watched_on, already the owner's day), their star rating, liked, rewatch, a short review if they wrote one, and the link. after/before filter on the watched day. The feed covers about the last 50 entries.",
    summary: "See the films you've logged",
    inputSchema: windowSchema(),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const w = windowArgs(args, ctx.tz);
      const limit = limitArg(args);
      const offset = offsetArg(args);
      // A watched day is a whole day: compare it with the window's days, not instants.
      const fromDay = w.after !== undefined ? local(w.after, ctx.tz).day! : undefined;
      const toDay = w.before !== undefined ? local(w.before - 1, ctx.tz).day! : undefined;
      const all = (await ctx.feed())
        .map(diaryEntry)
        .filter((e): e is DiaryEntry & { at: number } => !!e && (!fromDay || e.watched_on >= fromDay) && (!toDay || e.watched_on <= toDay))
        .sort((a, b) => b.at - a.at);
      const page = all.slice(offset, offset + limit).map(({ at: _at, ...e }) => e);
      return compact({ profile: ctx.profile, films: page, count: page.length, total_count: all.length, next_page_token: offset + limit < all.length ? String(offset + limit) : undefined });
    },
  },
];

const MISSING = "Letterboxd has no public diary at that address. Check the username under Edit, and that your profile isn't private.";

export async function openLetterboxd(connector: Pick<Connector, "url">, opts: { tz?: string } = {}) {
  const url = letterboxdFeedUrl(connector.url);
  let cached: Promise<Array<Record<string, string>>> | null = null;
  const feed = () => (cached ??= fetchFeed("letterboxd", url, HOSTS, { name: "Letterboxd", missing: MISSING }).then(rssItems));
  // The check that the feed is there and public.
  await feed();
  const tz = safeZone(opts.tz ?? (await getOwnerTimeZone().catch(() => undefined)));
  return lifeAccount(TOOLS, { feed, tz, profile: url.replace(/rss\/$/, "") }, letterboxdAccountProblem);
}

const letterboxdAccountProblem = serviceAccountProblem("letterboxd");

export const letterboxdAdapter: DirectAdapter = {
  backfill: letterboxdBackfill,
  recent: letterboxdRecent,
  id: "letterboxd",
  handles: (c) => c.provider === "letterboxd" && c.auth_type === "none",
  tools: () => TOOLS.map(({ run: _run, ...t }) => t),
  serverInfo: () => ({ website_url: "https://letterboxd.com" }),
  open: (connector) => openLetterboxd(connector),
  checkAddress: letterboxdFeedUrl,
  accountProblem: letterboxdAccountProblem,
  failure: (e) => serviceFailure("letterboxd", e),
};
