/**
 * YouTube without MCP: a read-only adapter over the YouTube Data API v3
 * (www.googleapis.com/youtube/v3), registered in direct.ts. Google has no
 * YouTube MCP server (its published MCP servers cover Workspace, Maps and
 * others, not YouTube), so Athena calls the Data API itself.
 *
 * Sign-in, tokens and requests are google-api.ts's (the owner's own Google
 * OAuth client, the same one as Gmail's if they have it), with the
 * youtube.readonly scope. GoogleSession only sends GETs.
 *
 * What the API shares: liked videos (with the time each was liked), the
 * owner's playlists and what's in them, and subscriptions (with the time
 * each started). It doesn't share watch history: YouTube closed that to
 * apps in 2016. A Google Takeout import is planned for that.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import type { GoogleProvider } from "../../../lib/connector-presets";
export { YOUTUBE_READ_SCOPE } from "../../../lib/presets/api";
import { getOwnerTimeZone } from "../../../lib/db";
import { apiUrl, arg, authorizationUrl, exchangeCode, GoogleApiError, GoogleSession, ToolInputError } from "./google-api";
import type { DirectAdapter } from "./direct";
import { youtubeBackfill } from "./youtube-backfill";
import { youtubeRecent } from "./media-recent";
import {
  beforeWindow,
  compact,
  inWindow,
  lifeAccount,
  limitArg,
  local,
  READ_ONLY,
  safeZone,
  serviceAccountProblem,
  serviceFailure,
  ServiceError,
  windowArgs,
  windowSchema,
  type LifeTool,
  type Window,
} from "./feeds-shared";

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

/** Google's refusal, in YouTube's words. Token problems (GoogleTokenError) stay Google's: google-direct.ts reports them. */
export function youtubeError(error: unknown): unknown {
  if (!(error instanceof GoogleApiError)) return error;
  const r = error.reasons;
  if (error.status === 401) return new ServiceError("youtube", 401, "Google didn't accept the sign-in. Sign in again", true);
  if (error.apiDisabled) return new ServiceError("youtube", 403, `Turn on the YouTube Data API v3 in your Google Cloud project${error.project ? ` ${error.project}` : ""}, then try again.`, true);
  if (error.missingPermission) return new ServiceError("youtube", 403, "Sign in again and allow Athena to see your YouTube account.", true);
  if (r.some((x) => x === "youtubeSignupRequired" || x === "channelNotFound")) {
    return new ServiceError("youtube", 404, "This Google account has no YouTube channel. Sign in with the account you use on YouTube.", true);
  }
  if (r.includes("quotaExceeded") || r.includes("dailyLimitExceeded")) return new ServiceError("youtube", 429, "Athena has used today's YouTube allowance for your Google project. It resets at midnight Pacific time.");
  if (error.retryable) return new ServiceError("youtube", error.status === 403 ? 429 : error.status, "YouTube is busy right now. Try again in a few minutes.");
  if (error.status === 404) return new ServiceError("youtube", 404, "YouTube couldn't find that playlist.");
  return new ServiceError("youtube", error.status, `YouTube refused that (${error.status}).`);
}

interface Ctx {
  get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T>;
  likes: string;
  tz: string;
}

interface Thumbs {
  title?: string;
  publishedAt?: string;
  channelTitle?: string;
  videoOwnerChannelTitle?: string;
  description?: string;
  resourceId?: { videoId?: string; channelId?: string };
}
interface ListReply<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number };
}
type Item = { id?: string; snippet?: Thumbs; contentDetails?: { videoId?: string; itemCount?: number }; status?: { privacyStatus?: string } };

const watch = (id?: string) => (id ? `https://www.youtube.com/watch?v=${id}` : undefined);

/** A playlist row as a video: title, channel, when it was added, link. Deleted and private videos are left out. */
function video(i: Item, tz: string) {
  const s = i.snippet ?? {};
  if (!s.title || s.title === "Deleted video" || s.title === "Private video") return null;
  const id = i.contentDetails?.videoId ?? s.resourceId?.videoId;
  return { at: Date.parse(s.publishedAt ?? ""), item: compact({ title: s.title, channel: s.videoOwnerChannelTitle, ...local(s.publishedAt, tz), link: watch(id) }) };
}

const tokenArg = (args: Record<string, unknown>) => {
  const t = arg.str(args, "page_token", { max: 200 });
  if (t !== undefined && !/^[\w-]+$/.test(t)) throw new ToolInputError("page_token isn't one Athena gave");
  return t;
};

/**
 * One page of a playlist, keeping what was added in the window, newest
 * first. The liked list is newest first, so once a page reaches the
 * window's start there's no next page; other playlists are in the owner's
 * own order, so every page is worth reading.
 */
async function playlistVideos(ctx: Ctx, playlistId: string, w: Window, args: Record<string, unknown>, newestFirst: boolean) {
  const limit = limitArg(args);
  const r = await ctx.get<ListReply<Item>>("/playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: newestFirst ? limit : 50, pageToken: tokenArg(args) });
  let older = false;
  const kept: Array<{ at: number; item: Record<string, unknown> }> = [];
  for (const i of r.items ?? []) {
    const v = video(i, ctx.tz);
    if (!v || Number.isNaN(v.at)) continue;
    if (beforeWindow(v.at, w)) older = true;
    else if (inWindow(v.at, w)) kept.push(v);
  }
  kept.sort((a, b) => b.at - a.at);
  const videos = kept.map((v) => v.item);
  return { videos, count: videos.length, next_page_token: newestFirst && older ? undefined : r.nextPageToken };
}

const TOOLS: LifeTool<Ctx>[] = [
  {
    name: "list_liked_videos",
    description:
      "Videos the owner liked on YouTube, newest first: title, channel, the owner's day and time they liked it, and a link. after/before bound when it was liked. YouTube doesn't share watch history, so this is the closest signal to what they watched.",
    summary: "See videos you've liked",
    inputSchema: windowSchema(),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const w = windowArgs(args, ctx.tz);
      return compact(await playlistVideos(ctx, ctx.likes, w, args, true));
    },
  },
  {
    name: "list_playlists",
    description: "The owner's own YouTube playlists: id, title, how many videos, privacy, the day it was made, and a link. Pass an id to list_playlist_videos to see what was added.",
    summary: "See your playlists",
    inputSchema: { type: "object", properties: { page_token: { type: "string", description: "next_page_token from the previous answer." } } },
    annotations: READ_ONLY,
    async run(ctx, args) {
      const r = await ctx.get<ListReply<Item>>("/playlists", { part: "snippet,contentDetails,status", mine: "true", maxResults: 50, pageToken: tokenArg(args) });
      const playlists = (r.items ?? []).map((p) =>
        compact({ id: p.id, title: p.snippet?.title, videos: p.contentDetails?.itemCount, privacy: p.status?.privacyStatus, made_on: local(p.snippet?.publishedAt, ctx.tz).day, link: p.id ? `https://www.youtube.com/playlist?list=${p.id}` : undefined }),
      );
      return compact({ playlists, count: playlists.length, next_page_token: r.nextPageToken });
    },
  },
  {
    name: "list_playlist_videos",
    description: "Videos in one of the owner's playlists (id from list_playlists), newest-added first: title, channel, the owner's day and time it was added, and a link. after/before bound when it was added.",
    summary: "See what's in a playlist",
    inputSchema: windowSchema({ playlist_id: { type: "string", description: "The playlist's id, from list_playlists." } }, ["playlist_id"]),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const id = arg.str(args, "playlist_id", { required: true, max: 64 })!;
      if (!/^[\w-]+$/.test(id)) throw new ToolInputError("playlist_id isn't a YouTube playlist id");
      return compact(await playlistVideos(ctx, id, windowArgs(args, ctx.tz), args, id === ctx.likes));
    },
  },
  {
    name: "list_subscriptions",
    description: "Channels the owner subscribes to on YouTube, newest first, with the day each subscription started (after/before bound it) and a link. Reads up to 500 subscriptions.",
    summary: "See channels you subscribe to",
    inputSchema: windowSchema(),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const w = windowArgs(args, ctx.tz);
      const all: Array<{ at: number; item: Record<string, unknown> }> = [];
      let pageToken: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const r = await ctx.get<ListReply<Item>>("/subscriptions", { part: "snippet", mine: "true", maxResults: 50, order: "alphabetical", pageToken });
        for (const s of r.items ?? []) {
          const at = Date.parse(s.snippet?.publishedAt ?? "");
          const channel = s.snippet?.resourceId?.channelId;
          if (!Number.isNaN(at) && inWindow(at, w)) all.push({ at, item: compact({ channel: s.snippet?.title, ...local(at, ctx.tz), link: channel ? `https://www.youtube.com/channel/${channel}` : undefined }) });
        }
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      all.sort((a, b) => b.at - a.at);
      const limit = limitArg(args);
      const subscriptions = all.slice(0, limit).map((s) => s.item);
      return compact({ subscriptions, count: subscriptions.length, total_count: all.length });
    },
  },
];

export function youtubeTools() {
  return TOOLS.map(({ run: _run, ...t }) => t);
}

/** GETs to the Data API as this account, with YouTube's own words for a refusal. Also the history load's (youtube-backfill.ts). */
export function youtubeGet(connector: Pick<Connector, "id">, secrets: ConnectorSecrets) {
  // google-api.ts names the API in its own messages by provider; YouTube's are rewritten by youtubeError.
  const session = new GoogleSession({ id: connector.id, provider: "youtube" as GoogleProvider }, secrets);
  return async <T>(path: string, params: Record<string, string | number | undefined>): Promise<T> => {
    try {
      return (await session.request({ method: "GET", url: apiUrl(YOUTUBE_API, path, params) })) as T;
    } catch (error) {
      throw youtubeError(error);
    }
  };
}

/** Open a signed-in account: the owner's channel proves the sign-in, the API and the channel, and names the liked-videos playlist. */
export async function openYouTube(connector: Connector, secrets: ConnectorSecrets, opts: { tz?: string } = {}) {
  if (!secrets.tokens) throw new ServiceError("youtube", 401, "Not signed in yet", true);
  const get = youtubeGet(connector, secrets);
  const me = await get<ListReply<{ contentDetails?: { relatedPlaylists?: { likes?: string } } }>>("/channels", { part: "contentDetails", mine: "true" });
  const channel = me.items?.[0];
  if (!channel) throw new ServiceError("youtube", 404, "This Google account has no YouTube channel. Sign in with the account you use on YouTube.", true);
  const tz = safeZone(opts.tz ?? (await getOwnerTimeZone().catch(() => undefined)));
  return lifeAccount(TOOLS, { get, likes: channel.contentDetails?.relatedPlaylists?.likes || "LL", tz }, youtubeAccountProblem);
}

const youtubeAccountProblem = serviceAccountProblem("youtube");

export const youtubeAdapter: DirectAdapter = {
  id: "youtube",
  handles: (c) => c.provider === "youtube" && c.auth_type === "oauth",
  tools: youtubeTools,
  serverInfo: () => ({ website_url: "https://www.youtube.com" }),
  open: (connector, secrets) => openYouTube(connector, secrets),
  authorizationUrl,
  exchangeCode: ({ code, redirectUri, verifier, client }) => exchangeCode({ code, redirectUri, verifier, client }),
  backfill: youtubeBackfill,
  recent: youtubeRecent,
  accountProblem: youtubeAccountProblem,
  failure: (e) => serviceFailure("youtube", e),
};
