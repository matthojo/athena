/**
 * Bluesky without MCP or a sign-in: the owner's own posts and replies, read
 * from Bluesky's public AppView (public.api.bsky.app), registered in direct.ts.
 *
 * The account is the owner's profile link (bsky.app/profile/<handle>); a bare
 * handle is turned into one when the account is added. Only two XRPC queries
 * are called, both GETs: app.bsky.actor.getProfile (does the profile exist?)
 * and app.bsky.feed.getAuthorFeed (posts and replies, paged by its cursor).
 * These are the same posts anyone can see without an account, so nothing is
 * stored but the address.
 *
 * Reposts are left out (a repost is someone else's post); a quote post is the
 * owner's own words, so it stays, marked `quote: true`. Other people's handles
 * are never returned: replies and quotes point at the other post by link only,
 * written with its DID, not a username.
 */
import { AthenaInputError } from "../../../lib/db";
import { BLUESKY_APPVIEW_URL, BLUESKY_HOSTS } from "../../../lib/presets/reading-social";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean } from "./google-api";
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
import { blueskyRecent } from "./activity-recent";

const HELP = "Paste your profile link, like https://bsky.app/profile/you.bsky.social, or just your handle.";

/** A Bluesky handle: dot-separated labels of letters, digits and hyphens; the last one isn't all digits. */
const HANDLE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]{3,253})$/;

/**
 * A pasted profile or post link, an @handle or a DID, as the profile link
 * Athena keeps. A single word is taken as a bsky.social handle. Anything
 * that isn't a Bluesky profile is refused before it's saved.
 */
export function blueskyProfileUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new AthenaInputError(HELP);
  let who: string;
  if (/^https?:\/\//i.test(s) || /^(www\.)?bsky\.app\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new AthenaInputError(`That isn't a Bluesky link. ${HELP}`);
    }
    if (!BLUESKY_HOSTS.includes(u.hostname.toLowerCase()) || u.username || u.password) throw new AthenaInputError(`That isn't a Bluesky link. ${HELP}`);
    const m = /^\/profile\/([^/?#]+)/i.exec(u.pathname);
    if (!m) throw new AthenaInputError(`That isn't a Bluesky profile. ${HELP}`);
    who = decodeURIComponent(m[1]);
  } else if (/^[a-z][\w+.-]*:\/\//i.test(s) || (/^[a-z]+:/i.test(s) && !/^did:/i.test(s))) {
    // Another scheme (javascript:, ftp://) is never a handle.
    throw new AthenaInputError(`That isn't a Bluesky link. ${HELP}`);
  } else {
    who = s.replace(/^@/, "");
  }
  who = who.trim().toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(who) && !/^\d+$/.test(who)) who = `${who}.bsky.social`;
  if (!HANDLE.test(who) && !DID.test(who)) throw new AthenaInputError(`That isn't a Bluesky handle. ${HELP}`);
  return `https://bsky.app/profile/${who}`;
}

/** The handle or DID in a profile link Athena saved. */
export function blueskyActor(url: string): string {
  const m = /^https:\/\/bsky\.app\/profile\/([^/?#]+)$/.exec(url.trim());
  if (!m) throw new LifeApiError("bluesky", 400, `That isn't a Bluesky profile link. ${HELP}`, true);
  return m[1];
}

type XrpcError = { error?: string; message?: string };

function refused(status: number, body: unknown, who = "that profile"): LifeApiError {
  const e = (body && typeof body === "object" ? body : {}) as XrpcError;
  const msg = `${e.error ?? ""} ${e.message ?? ""}`;
  if (status === 401 || e.error === "AuthRequired" || /logged.?out|unauthenticated/i.test(msg)) {
    return new LifeApiError(
      "bluesky",
      401,
      "Bluesky hides your posts from apps that aren't signed in. Turn off Logged-out visibility in Bluesky, under Settings, then Privacy and security.",
      true,
    );
  }
  if (/not found|could not find|unable to resolve/i.test(msg) || e.error === "ProfileNotFound") {
    return new LifeApiError("bluesky", 404, `Bluesky can't find ${who}. Check the handle in your profile link.`, true);
  }
  if (e.error === "AccountTakedown" || e.error === "AccountDeactivated" || /deactivated|suspended|taken ?down/i.test(msg)) {
    return new LifeApiError("bluesky", 403, "Bluesky says this account is deactivated or suspended, so Athena can't read its posts.", true);
  }
  if (status === 429) return new LifeApiError("bluesky", 429, "Bluesky is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("bluesky", 503, "Bluesky is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("bluesky", status, `Bluesky refused that (${status}${e.error ? `, ${e.error}` : ""})`);
}

interface PostView {
  uri?: string;
  author?: { did?: string; handle?: string };
  record?: {
    $type?: string;
    text?: string;
    createdAt?: string;
    reply?: { parent?: { uri?: string }; root?: { uri?: string } };
    langs?: string[];
  };
  embed?: {
    $type?: string;
    images?: unknown[];
    external?: { uri?: string; title?: string };
    record?: { uri?: string; record?: { uri?: string } };
    media?: { $type?: string; images?: unknown[]; external?: { uri?: string } };
  };
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  indexedAt?: string;
}

export interface FeedItem {
  post?: PostView;
  reason?: { $type?: string };
}

interface FeedPage {
  feed?: FeedItem[];
  cursor?: string;
}

export interface BlueskyContext {
  feed(cursor: string | undefined): Promise<FeedPage>;
  did: string;
  handle: string;
  tz: string;
}

const ms = (s: string | undefined): number | undefined => {
  const n = s ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** When a post was made: its own createdAt, unless that's missing or claims a time after Bluesky first saw it. */
function postedAt(p: PostView): number | undefined {
  const created = ms(p.record?.createdAt);
  const indexed = ms(p.indexedAt);
  if (created === undefined) return indexed;
  if (indexed !== undefined && created > indexed + 60_000) return indexed;
  return created;
}

/** at://did/app.bsky.feed.post/rkey → its page on bsky.app. `handle` only for the owner's own posts. */
export function postLink(uri: string | undefined, handle?: string): string | undefined {
  const m = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]+)$/.exec(uri ?? "");
  return m ? `https://bsky.app/profile/${handle ?? m[1]}/post/${m[2]}` : undefined;
}

const isRepost = (i: FeedItem) => i.reason?.$type === "app.bsky.feed.defs#reasonRepost";

/** The owner's own post or reply as Athena returns it; null for reposts, pins and anyone else's post. */
export function ownPost(i: FeedItem, ctx: Pick<BlueskyContext, "did" | "handle" | "tz">): (Record<string, unknown> & { at: number }) | null {
  const p = i.post;
  if (!p || isRepost(i) || i.reason || p.author?.did !== ctx.did) return null;
  if (p.record?.$type && p.record.$type !== "app.bsky.feed.post") return null;
  const at = postedAt(p);
  if (at === undefined) return null;
  const e = p.embed;
  const quoted = e?.$type?.startsWith("app.bsky.embed.record#") ? e.record?.uri : e?.$type?.startsWith("app.bsky.embed.recordWithMedia#") ? (e.record?.record?.uri ?? e.record?.uri) : undefined;
  const images = (e?.images?.length ?? 0) + (e?.media?.images?.length ?? 0);
  const shared = e?.external?.uri ?? e?.media?.external?.uri;
  // A quote post quotes a post; embedding a list or starter pack isn't one.
  const quoting = postLink(quoted);
  const local = when(at, ctx.tz);
  const parent = p.record?.reply?.parent?.uri;
  return {
    at,
    ...clean({
      kind: parent ? "reply" : "post",
      text: p.record?.text?.trim(),
      date: local.date,
      time: local.time,
      link: postLink(p.uri, ctx.handle),
      in_reply_to: parent ? postLink(parent) : undefined,
      quote: quoting ? true : undefined,
      quoting,
      images: images || undefined,
      shared_link: typeof shared === "string" && /^https?:\/\//.test(shared) ? shared : undefined,
      likes: p.likeCount || undefined,
      reposts: p.repostCount || undefined,
      replies: p.replyCount || undefined,
      quotes: p.quoteCount || undefined,
    }),
  };
}

/** Pages read in one call at most: 500 posts. */
const MAX_PAGES = 5;

type Cursor = { c?: string; skip: number };

async function myPosts(ctx: BlueskyContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 100 });
  const replies = args.replies !== false && args.replies !== "false";
  let cur: Cursor = decodeCursor<Cursor>("bluesky:posts", args.cursor) ?? { skip: 0 };
  const items: Record<string, unknown>[] = [];
  let posts = 0;
  let replyCount = 0;
  let next: Cursor | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await ctx.feed(cur.c);
    const feed = page.feed ?? [];
    let past = false;
    let seen = 0;
    for (const i of feed) {
      const p = ownPost(i, ctx);
      if (!p) {
        // A repost or someone else's post, dated by the repost: it says nothing about where the owner's posts end.
        continue;
      }
      if (w.after !== undefined && p.at < w.after) {
        past = true;
        break;
      }
      if (!inWindow(p.at, w) || (!replies && p.kind === "reply")) continue;
      if (seen++ < cur.skip) continue;
      if (items.length >= limit) {
        next = { c: cur.c, skip: seen - 1 };
        break;
      }
      const { at: _at, ...out } = p;
      items.push(out);
      if (p.kind === "reply") replyCount++;
      else posts++;
    }
    if (next || past || !page.cursor || !feed.length) break;
    cur = { c: page.cursor, skip: 0 };
    if (pages === MAX_PAGES - 1) next = cur;
  }
  return withItems(items, {
    count: items.length,
    posts,
    replies: replyCount,
    profile: `https://bsky.app/profile/${ctx.handle}`,
    next_cursor: next ? encodeCursor("bluesky:posts", next) : undefined,
  });
}

export const BLUESKY_TOOLS: LifeTool<BlueskyContext>[] = [
  {
    name: "my_posts",
    summary: "See what you posted",
    description:
      "The owner's own Bluesky posts and replies, newest first: kind (post or reply), text, local date and time, link, likes, reposts, replies, quotes, images (a count), shared_link, and for a reply or quote post the other post's link only (in_reply_to, quoting). Reposts are left out; quote posts stay, marked quote: true. Ask one day with date (YYYY-MM-DD, the owner's time zone), or after/before. replies: false for top-level posts only. count is the posts on this page; page on with next_cursor. For the Life log: one posted entry per post, its first words as the title and its link; a reply is titled Replied, never who to.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        replies: { type: "boolean", description: "false to leave replies out (default true)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many a page (default 100)." },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: myPosts,
  },
];

/** Open the account: getProfile proves the profile exists and gives its DID, which the feed is checked against. */
export async function openBluesky(connector: Connector, _secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const actor = blueskyActor(connector.url);
  const get = <T>(method: string, params: Record<string, string | number | undefined>): Promise<T> => {
    const url = new URL(`${BLUESKY_APPVIEW_URL}/xrpc/${method}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), {
      service: "bluesky",
      hosts: [new URL(BLUESKY_APPVIEW_URL).hostname],
      headers: { "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused: (status, body) => refused(status, body, `@${actor}`),
      unreachable: "Couldn't reach Bluesky",
    });
  };
  const [profile, zone] = await Promise.all([get<{ did?: string; handle?: string }>("app.bsky.actor.getProfile", { actor }), tz ? Promise.resolve(tz) : ownerZone()]);
  if (!profile.did) throw new LifeApiError("bluesky", 404, `Bluesky can't find @${actor}. Check the handle in your profile link.`, true);
  const did = profile.did;
  // A handle that moved still has its DID; links use the handle Bluesky gives now.
  const handle = profile.handle && profile.handle !== "handle.invalid" ? profile.handle : did;
  return account("bluesky", BLUESKY_TOOLS, {
    feed: (cursor) => get<FeedPage>("app.bsky.feed.getAuthorFeed", { actor: did, filter: "posts_with_replies", limit: 100, cursor }),
    did,
    handle,
    tz: zone,
  });
}

export const blueskyAdapter: DirectAdapter = {
  id: "bluesky",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: blueskyRecent,
  handles: (c) => c.provider === "bluesky" && c.auth_type === "none",
  tools: () => BLUESKY_TOOLS,
  serverInfo: () => ({ website_url: "https://bsky.app/" }),
  open: (connector, secrets) => openBluesky(connector, secrets),
  checkAddress: blueskyProfileUrl,
  accountProblem: (e) => lifeAccountProblem("bluesky", e),
  failure: (e) => lifeFailure("bluesky", e),
};
