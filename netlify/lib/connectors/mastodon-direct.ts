/**
 * Mastodon without MCP: the owner's own posts and replies, read from their
 * server's REST API (/api/v1), registered in direct.ts.
 *
 * The account is the owner's profile link (https://their.server/@name), which
 * says which server to ask, and an access token they make on that server
 * under Preferences → Development, with the `read` permission only. Two GETs
 * are ever sent: accounts/verify_credentials (whose token is this?) and
 * accounts/:id/statuses (their posts, newest first, paged by max_id, boosts
 * excluded).
 *
 * The server is one the owner typed, so before any request: https only, no
 * credentials in the address, no IP addresses or internal names, and the
 * name must resolve to public addresses only. Redirects are refused, so the
 * token is never sent anywhere but that server. Private mentions (direct
 * visibility) are messages and are never returned.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AthenaInputError } from "../../../lib/db";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { isInternalAddress } from "./icons";
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
import { mastodonRecent } from "./activity-recent";

const HELP = "Paste your profile link, like https://mastodon.social/@yourname";
const BAD_TOKEN =
  "Your Mastodon server didn't accept the access token. On your server, open Preferences, then Development, make a new application with only read ticked, and paste its access token here.";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function hostOk(host: string): boolean {
  const labels = host.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]) && !/(^|\.)(localhost|local|internal|lan|home|intranet|corp)$/.test(host);
}

/**
 * A pasted profile link, server address, or @name@server, as the profile link
 * Athena keeps (https://server/@name, or https://server when no name was
 * given). Refused before it's saved when it can't be a public Mastodon server.
 */
export function mastodonProfileUrl(raw: string): string {
  const s = raw.trim();
  if (!s) throw new AthenaInputError(HELP);
  const fedi = /^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9.-]+)$/.exec(s);
  let host: string;
  let name: string | undefined;
  if (fedi) {
    name = fedi[1];
    host = fedi[2];
  } else {
    if (/^[a-z][\w+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) throw new AthenaInputError(`That isn't a Mastodon link. ${HELP}`);
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      throw new AthenaInputError(`That isn't a Mastodon link. ${HELP}`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new AthenaInputError(`That isn't a Mastodon link. ${HELP}`);
    if (u.username || u.password || u.port) throw new AthenaInputError(`That address can't be a Mastodon server. ${HELP}`);
    host = u.hostname;
    const m = /^\/@([A-Za-z0-9_]{1,30})(?:@([A-Za-z0-9.-]+))?(?:\/|$)/.exec(u.pathname) ?? /^\/users\/([A-Za-z0-9_]{1,30})(?:\/|$)/.exec(u.pathname);
    // A profile on another server, seen from this one (mastodon.social/@you@your.server): theirs is the server that matters.
    if (m?.[2]) host = m[2];
    name = m?.[1];
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) || !hostOk(host)) throw new AthenaInputError(`That address can't be a Mastodon server. ${HELP}`);
  return `https://${host}${name ? `/@${name}` : ""}`;
}

/** Name resolution, swappable in tests. */
export const mastodonNet = {
  lookup: (host: string): Promise<Array<{ address: string; family: number }>> => lookup(host, { all: true }),
};

/** Refuse a server that is, or resolves to, an internal address (the same guard as custom servers' logos; docs: security/connectors). */
async function assertPublic(host: string): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await mastodonNet.lookup(host);
  } catch {
    throw new LifeApiError("mastodon", 404, `Athena can't find a server called ${host}. Check your profile link.`, true);
  }
  if (!addresses.length || addresses.some((a) => isInternalAddress(a.address))) {
    throw new LifeApiError("mastodon", 400, `${host} isn't a public server, so Athena won't send your token there. Check your profile link.`, true);
  }
}

function refused(status: number, body: unknown, host: string): LifeApiError {
  const e = body && typeof body === "object" ? String((body as { error?: unknown }).error ?? "") : "";
  if (status === 401) return new LifeApiError("mastodon", 401, BAD_TOKEN, true);
  if (status === 403 && /scope/i.test(e)) return new LifeApiError("mastodon", 403, "That token can't read your posts. Make a new application with read ticked, and paste its access token here.", true);
  if (status === 403 || status === 410) return new LifeApiError("mastodon", 403, `${host} says this account is suspended or gone. Sort it out on your server, then paste a new token.`, true);
  if (status === 404) return new LifeApiError("mastodon", 404, `${host} doesn't look like a Mastodon server. Check your profile link.`, true);
  if (status === 429) return new LifeApiError("mastodon", 429, `${host} is limiting how often Athena can ask right now. Try again in a few minutes.`);
  if (status >= 500) return new LifeApiError("mastodon", 503, `${host} is having trouble right now. Try again in a few minutes.`);
  return new LifeApiError("mastodon", status, `${host} refused that (${status})`);
}

interface Status {
  id?: string;
  created_at?: string;
  url?: string | null;
  uri?: string;
  content?: string;
  spoiler_text?: string;
  visibility?: string;
  in_reply_to_id?: string | null;
  reblog?: unknown;
  quote?: unknown;
  account?: { id?: string };
  media_attachments?: unknown[];
  card?: { url?: string } | null;
  replies_count?: number;
  reblogs_count?: number;
  favourites_count?: number;
  edited_at?: string | null;
}

export interface MastodonContext {
  statuses(maxId: string | undefined): Promise<Status[]>;
  id: string;
  profile: string;
  tz: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** A status's HTML as plain text: paragraphs and line breaks kept, tags dropped, entities decoded. */
export function plainText(html: string | undefined): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<span class="invisible">[^<]*<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** The owner's own post or reply as Athena returns it; null for boosts, private mentions and anyone else's. */
export function ownStatus(s: Status, ctx: Pick<MastodonContext, "id" | "tz">): (Record<string, unknown> & { at: number }) | null {
  if (s.reblog || s.visibility === "direct" || s.account?.id !== ctx.id) return null;
  const at = s.created_at ? Date.parse(s.created_at) : NaN;
  if (!Number.isFinite(at)) return null;
  const local = when(at, ctx.tz);
  const link = [s.url, s.uri].find((u) => typeof u === "string" && u.startsWith("https://")) ?? undefined;
  const card = s.card?.url;
  return {
    at,
    ...clean({
      kind: s.in_reply_to_id ? "reply" : "post",
      text: plainText(s.content),
      content_warning: s.spoiler_text?.trim() || undefined,
      date: local.date,
      time: local.time,
      link,
      visibility: s.visibility && s.visibility !== "public" ? s.visibility : undefined,
      quote: s.quote ? true : undefined,
      media: s.media_attachments?.length || undefined,
      shared_link: typeof card === "string" && /^https?:\/\//.test(card) ? card : undefined,
      favourites: s.favourites_count || undefined,
      boosts: s.reblogs_count || undefined,
      replies: s.replies_count || undefined,
      edited: s.edited_at ? true : undefined,
    }),
  };
}

/** Pages read in one call at most: 200 statuses. */
const MAX_PAGES = 5;

async function myPosts(ctx: MastodonContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 100 });
  const replies = args.replies !== false && args.replies !== "false";
  let maxId = decodeCursor<string>("mastodon:posts", args.cursor);
  const items: Record<string, unknown>[] = [];
  let posts = 0;
  let replyCount = 0;
  let next: string | undefined;
  let done = false;
  for (let pages = 0; pages < MAX_PAGES && !done; pages++) {
    const page = await ctx.statuses(maxId);
    if (!page.length) break;
    for (const s of page) {
      // Paging goes on from the last status read, boost or not, so none is read twice.
      const p = ownStatus(s, ctx);
      if (p && w.after !== undefined && p.at < w.after) {
        done = true;
        break;
      }
      if (p && inWindow(p.at, w) && (replies || p.kind !== "reply")) {
        if (items.length >= limit) {
          next = maxId;
          done = true;
          break;
        }
        const { at: _at, ...out } = p;
        items.push(out);
        if (p.kind === "reply") replyCount++;
        else posts++;
      }
      maxId = s.id;
    }
    if (!done && pages === MAX_PAGES - 1) next = maxId;
  }
  return withItems(items, {
    count: items.length,
    posts,
    replies: replyCount,
    profile: ctx.profile,
    next_cursor: next ? encodeCursor("mastodon:posts", next) : undefined,
  });
}

export const MASTODON_TOOLS: LifeTool<MastodonContext>[] = [
  {
    name: "my_posts",
    summary: "See what you posted",
    description:
      "The owner's own Mastodon posts and replies, newest first: kind (post or reply), text (plain), content_warning, local date and time, link, visibility when not public (unlisted, private), quote, media (a count), shared_link, favourites, boosts, replies, edited. Boosts and private mentions are left out. Ask one day with date (YYYY-MM-DD, the owner's time zone), or after/before. replies: false for top-level posts only. count is the posts on this page; page on with next_cursor. For the Life log: one posted entry per post, its first words as the title and its link; a reply is titled Replied, never who to; a post with a content_warning shows only the warning.",
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

/** Open the account: the server must be public, and verify_credentials says whose token it is. */
export async function openMastodon(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  let base: URL;
  try {
    base = new URL(mastodonProfileUrl(connector.url));
  } catch {
    throw new LifeApiError("mastodon", 400, `That isn't a Mastodon profile link. ${HELP}`, true);
  }
  const host = base.hostname;
  const token = secrets.token?.trim();
  if (!token) throw new LifeApiError("mastodon", 401, "Paste your Mastodon access token.", true);
  await assertPublic(host);
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`https://${host}/api/v1${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), {
      service: "mastodon",
      hosts: [host],
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused: (status, body) => refused(status, body, host),
      unreachable: `Couldn't reach ${host}`,
      redirect: "error",
      typed: true,
    });
  };
  const [me, zone] = await Promise.all([get<{ id?: string; username?: string; url?: string }>("/accounts/verify_credentials"), tz ? Promise.resolve(tz) : ownerZone()]);
  if (!me.id) throw new LifeApiError("mastodon", 401, BAD_TOKEN, true);
  const id = me.id;
  const profile = typeof me.url === "string" && me.url.startsWith("https://") ? me.url : base.toString();
  return account("mastodon", MASTODON_TOOLS, {
    statuses: (maxId) => get<Status[]>(`/accounts/${encodeURIComponent(id)}/statuses`, { limit: 40, exclude_reblogs: "true", max_id: maxId }),
    id,
    profile,
    tz: zone,
  });
}

export const mastodonAdapter: DirectAdapter = {
  id: "mastodon",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: mastodonRecent,
  handles: (c) => c.provider === "mastodon" && c.auth_type === "token",
  tools: () => MASTODON_TOOLS,
  serverInfo: () => ({ website_url: "https://joinmastodon.org/" }),
  open: (connector, secrets) => openMastodon(connector, secrets),
  checkAddress: mastodonProfileUrl,
  accountProblem: (e) => lifeAccountProblem("mastodon", e),
  failure: (e) => lifeFailure("mastodon", e),
};
