/**
 * Reddit without MCP: a narrow, read-only adapter over Reddit's OAuth API
 * (oauth.reddit.com), registered in direct.ts.
 *
 * Why not MCP: Reddit runs no MCP server of its own; the ones listed in MCP
 * directories are community projects. The owner registers their own Reddit
 * "web app" (Reddit checks new apps by hand) and signs in with read scopes
 * only: identity, history, read. No privatemessages, vote, submit or edit.
 *
 * Only the owner's own listings are read (posts, comments, saved, upvoted),
 * for the username Reddit's /api/v1/me returns; no tool takes a username, so
 * no other profile can be asked for. Items from private communities keep only
 * the community's name. Other people's usernames are never returned. Every
 * request sends a descriptive User-Agent, as Reddit's API rules require.
 */
import { REDDIT_API_URL, REDDIT_SCOPE } from "../../../lib/presets/api-b";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean, clip, type StoredTokens } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import {
  CURSOR_PROP,
  LifeApiError,
  OAuthSession,
  WINDOW_PROPS,
  account,
  decodeCursor,
  encodeCursor,
  inWindow,
  lifeAccountProblem,
  lifeFailure,
  ownerZone,
  readOnly,
  tokenRequest,
  when,
  windowOf,
  withItems,
  type GetOptions,
  type LifeTool,
  type TokenEndpoint,
} from "./lifelog-b-http";
import { redditRecent } from "./activity-recent";

export const REDDIT_AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
export const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
/** Reddit's rule: <platform>:<app ID>:<version> (by /u/<username>). The username is added once it's known. */
export const REDDIT_USER_AGENT = "web:athena-life-log:1.0 (personal, read-only)";

const TOKEN: TokenEndpoint = {
  service: "reddit",
  url: REDDIT_TOKEN_URL,
  label: "Reddit",
  headers: { "User-Agent": REDDIT_USER_AGENT },
};

function refused(status: number, body: unknown): LifeApiError {
  // Reddit's network block (an HTML page, not the API's JSON) isn't the owner's to fix.
  if (status === 403 && (body === null || typeof body !== "object")) {
    return new LifeApiError("reddit", 503, "Reddit is blocking Athena's server for now. Athena will try again on the next run.");
  }
  if (status === 401) return new LifeApiError("reddit", 401, "Reddit didn't accept the sign-in. Sign in again", true);
  if (status === 403) {
    return new LifeApiError(
      "reddit",
      403,
      "Reddit refused Athena. If you made the Reddit app recently, Reddit may not have approved it yet. Otherwise sign in again and allow everything Athena asks for.",
      true,
    );
  }
  if (status === 429) return new LifeApiError("reddit", 429, "Reddit is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("reddit", status, "Reddit is having trouble right now. Try again in a few minutes.");
  if (status === 404) return new LifeApiError("reddit", 404, "Reddit couldn't find that");
  return new LifeApiError("reddit", status, `Reddit refused that (${status})`);
}

export interface RedditContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  /** The signed-in account's username, from /api/v1/me. */
  name: string;
  tz: string;
}

interface Thing {
  kind: string;
  data: Record<string, unknown> & {
    name?: string;
    created_utc?: number;
    permalink?: string;
    author?: string;
    subreddit_name_prefixed?: string;
    subreddit_type?: string;
  };
}
interface Listing {
  data?: { children?: Thing[]; after?: string | null };
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One post or comment, compact. Private communities keep only their name; no one else's username is ever included. */
export function redditItem(t: Thing, ctx: Pick<RedditContext, "name" | "tz">): Record<string, unknown> {
  const d = t.data;
  const at = n(d.created_utc) !== undefined ? when(d.created_utc! * 1000, ctx.tz) : undefined;
  const kind = t.kind === "t1" ? "comment" : "post";
  const base = {
    kind,
    community: s(d.subreddit_name_prefixed),
    date: at?.date,
    time: at?.time,
  };
  if (d.subreddit_type === "private") return clean({ ...base, private: true });
  const own = !!d.author && d.author === ctx.name;
  const link = d.permalink ? `https://www.reddit.com${d.permalink}` : undefined;
  if (kind === "comment") {
    return clean({
      ...base,
      on: s(d.link_title),
      text: s(d.body) && clip(s(d.body)!, own ? 400 : 200),
      link,
      score: n(d.score),
      mine: own || undefined,
    });
  }
  const external = d.is_self ? undefined : (s(d.url_overridden_by_dest) ?? s(d.url));
  return clean({
    ...base,
    title: s(d.title),
    text: own && s(d.selftext) ? clip(s(d.selftext)!, 300) : undefined,
    link,
    points_to: external && external !== link ? external : undefined,
    score: n(d.score),
    comments: n(d.num_comments),
    nsfw: d.over_18 === true || undefined,
    mine: own || undefined,
  });
}

type Where = "submitted" | "comments" | "saved" | "upvoted";

/**
 * Walk one of the owner's listings, newest first. Posts and comments carry
 * their own dates, so the window filters them and paging stops once it's
 * passed. Saved and upvoted come in the order you saved them, with no saved
 * date, so the window doesn't apply to them.
 */
async function listing(ctx: RedditContext, where: Where, args: Record<string, unknown>) {
  const dated = where === "submitted" || where === "comments";
  const w = dated ? windowOf(args, ctx.tz) : {};
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 25 });
  let after = decodeCursor<string>(`reddit:${where}`, args.cursor);
  const items: Record<string, unknown>[] = [];
  let next: string | undefined;
  pages: for (let page = 0; page < 5; page++) {
    const body = await ctx.get<Listing>(`/user/${encodeURIComponent(ctx.name)}/${where}`, { limit: 100, after, raw_json: 1, sort: dated ? "new" : undefined });
    const children = body.data?.children ?? [];
    for (const t of children) {
      const ms = (n(t.data.created_utc) ?? 0) * 1000;
      if (dated && w.after !== undefined && ms < w.after) {
        next = undefined;
        break pages;
      }
      if (dated && !inWindow(ms, w)) continue;
      items.push(redditItem(t, ctx));
      if (items.length >= limit) {
        // More may follow this one: carry on from it next time.
        next = t.data.name;
        break pages;
      }
    }
    after = body.data?.after ?? undefined;
    next = after;
    if (!after) break;
  }
  return withItems(items, {
    count: items.length,
    next_cursor: next ? encodeCursor(`reddit:${where}`, next) : undefined,
    note: dated ? undefined : "Reddit doesn't say when you saved or upvoted something: newest first, and date is when it was posted.",
  });
}

const LIST_PROPS = {
  ...WINDOW_PROPS,
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "At most this many items (default 25).",
  },
  ...CURSOR_PROP,
};
const UNDATED_PROPS = { limit: LIST_PROPS.limit, ...CURSOR_PROP };

export const REDDIT_TOOLS: LifeTool<RedditContext>[] = [
  {
    name: "my_posts",
    summary: "See your posts",
    description:
      "The owner's own Reddit posts, newest first: title, community, local date and time, link, score and comment count. Filter with date (one local day) or after/before. Page with next_cursor.",
    inputSchema: { type: "object", properties: LIST_PROPS },
    annotations: readOnly,
    run: (ctx, args) => listing(ctx, "submitted", args),
  },
  {
    name: "my_comments",
    summary: "See your comments",
    description:
      "The owner's own Reddit comments, newest first: the post it was on, community, the comment's text (shortened), local date and time, link and score. Filter with date (one local day) or after/before. Page with next_cursor.",
    inputSchema: { type: "object", properties: LIST_PROPS },
    annotations: readOnly,
    run: (ctx, args) => listing(ctx, "comments", args),
  },
  {
    name: "my_saved",
    summary: "See what you saved",
    description: "Posts and comments the owner saved, most recently saved first. Reddit gives no saved date, so there's no date filter: date is when the item was posted. Page with next_cursor.",
    inputSchema: { type: "object", properties: UNDATED_PROPS },
    annotations: readOnly,
    run: (ctx, args) => listing(ctx, "saved", args),
  },
  {
    name: "my_upvoted",
    summary: "See what you upvoted",
    description: "Posts the owner upvoted, most recently upvoted first. Reddit gives no upvote date, so there's no date filter: date is when the post was made. Page with next_cursor.",
    inputSchema: { type: "object", properties: UNDATED_PROPS },
    annotations: readOnly,
    run: (ctx, args) => listing(ctx, "upvoted", args),
  },
];

/** Open a signed-in account: who it is (/api/v1/me), which proves the sign-in works. */
export async function openReddit(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  if (!secrets.tokens) throw new LifeApiError("reddit", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  let agent = REDDIT_USER_AGENT;
  const opts = (): GetOptions => ({
    service: "reddit",
    hosts: ["oauth.reddit.com"],
    headers: { "User-Agent": agent },
    refused,
    unreachable: "Couldn't reach Reddit",
  });
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${REDDIT_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return session.get<T>(url.toString(), opts());
  };
  const [me, zone] = await Promise.all([get<{ name?: string }>("/api/v1/me", { raw_json: 1 }), tz ? Promise.resolve(tz) : ownerZone()]);
  const name = s(me.name);
  if (!name) throw new LifeApiError("reddit", 401, "Reddit didn't say which account this is. Sign in again", true);
  agent = `web:athena-life-log:1.0 (personal, read-only; by /u/${name})`;
  return account("reddit", REDDIT_TOOLS, { get, name, tz: zone });
}

/** Reddit's consent page. duration=permanent is what gives Athena a refresh token. Reddit doesn't take PKCE; the state still binds the callback. */
export function redditAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const url = new URL(REDDIT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    state: input.state,
    redirect_uri: input.redirectUri,
    duration: "permanent",
    scope: input.scope || REDDIT_SCOPE,
  }).toString();
  return url.toString();
}

export async function exchangeRedditCode(input: { code: string; redirectUri: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await tokenRequest(TOKEN, input.client, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  if (!tokens.refresh_token) throw new LifeApiError("reddit", 400, "Reddit gave Athena no way to renew this sign-in", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const redditAdapter: DirectAdapter = {
  id: "reddit",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: redditRecent,
  handles: (c) => c.provider === "reddit" && c.auth_type === "oauth",
  tools: () => REDDIT_TOOLS,
  serverInfo: () => ({ website_url: "https://www.reddit.com/" }),
  open: (connector, secrets) => openReddit(connector, secrets),
  authorizationUrl: redditAuthorizationUrl,
  exchangeCode: exchangeRedditCode,
  accountProblem: (e) => lifeAccountProblem("reddit", e),
  failure: (e) => lifeFailure("reddit", e),
};
