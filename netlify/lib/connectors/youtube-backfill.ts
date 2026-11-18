/**
 * YouTube's history on connect (backfill.ts): what the Data API shares, read
 * 50 at a time. Each page costs 1 unit of the owner's Google project
 * allowance (10,000 a day by default), so even a big account is a few
 * hundred units. A 429 (quota) pauses the load until the tick an hour on.
 *
 *  - Liked videos, newest first, each a saved Day entry on the day it was
 *    liked (note "liked").
 *  - The owner's own playlists and what's in them: a saved entry per video
 *    on the day it was added, grouped by the playlist.
 *  - Subscriptions: a saved entry per channel on the day it started.
 *
 * Liked videos also go into Watch & read as watched videos, and playlist
 * videos as saved (to watch), with the channel as who made it, so the
 * media profile has them (owner decision, 9 Nov). Subscriptions are
 * channels, not videos: Days only.
 *
 * Watch history isn't in the API (closed to apps in 2016); it comes from
 * the Takeout import (youtube-history.ts).
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import type { EntryInput } from "../../../lib/days";
import type { WatchReadInput } from "../../../lib/watch-read-sync";
import type { BackfillStream, HistoryBackfill } from "./backfill";
import { local, ServiceError } from "./feeds-shared";

type Get = <T>(path: string, params: Record<string, string | number | undefined>) => Promise<T>;

interface Snippet {
  title?: string;
  publishedAt?: string;
  videoOwnerChannelTitle?: string;
  resourceId?: { videoId?: string; channelId?: string };
}
export interface YtItem {
  id?: string;
  snippet?: Snippet;
  contentDetails?: { videoId?: string; relatedPlaylists?: { likes?: string } };
}
interface ListReply {
  items?: YtItem[];
  nextPageToken?: string;
}

const GONE = new Set(["Deleted video", "Private video"]);

/** A playlist row as a saved entry: liked (the likes list) or added to a playlist. Deleted and private videos: nothing. */
export function videoEntry(i: YtItem, tz: string, list: { id: string; title?: string; likes: boolean }): { date: string; entry: EntryInput } | null {
  const s = i.snippet ?? {};
  const videoId = i.contentDetails?.videoId ?? s.resourceId?.videoId;
  const day = local(s.publishedAt, tz).day;
  if (!s.title || GONE.has(s.title) || !videoId || !day) return null;
  return {
    date: day,
    entry: {
      kind: "saved",
      source: "youtube",
      external_id: list.likes ? `like:${videoId}` : `playlist:${list.id}:${videoId}`,
      title: s.title,
      ...(s.videoOwnerChannelTitle ? { subtitle: s.videoOwnerChannelTitle } : {}),
      at: s.publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      ...(list.likes ? { note: "liked" } : { note: `added to ${list.title ?? "a playlist"}`.slice(0, 200), group: list.title ?? "playlist" }),
    },
  };
}

/** A liked video as watched, a playlist video as to watch, for Watch & read. */
export function videoItem(e: { entry: EntryInput }, liked: boolean, list?: string): WatchReadInput {
  const id = e.entry.url!.split("v=")[1];
  return {
    kind: "video",
    title: e.entry.title,
    ...(e.entry.subtitle ? { maker: e.entry.subtitle } : {}),
    status: liked ? "done" : "queued",
    ...(e.entry.at ? { at: e.entry.at } : {}),
    url: e.entry.url,
    external_id: `video:${id}`,
    source: "youtube",
    // The playlist it was saved to, so Watch & read can shelve by playlist.
    ...(list ? { list } : {}),
  };
}

/** A subscription as a saved entry on the day it started. */
export function subscriptionEntry(i: YtItem, tz: string): { date: string; entry: EntryInput } | null {
  const s = i.snippet ?? {};
  const channel = s.resourceId?.channelId;
  const day = local(s.publishedAt, tz).day;
  if (!s.title || !channel || !day) return null;
  return { date: day, entry: { kind: "saved", source: "youtube", external_id: `sub:${channel}`, title: s.title, at: s.publishedAt, url: `https://www.youtube.com/channel/${channel}`, note: "subscribed" } };
}

const TOKEN = /^[\w-]{1,200}$/;
const lost = () => new ServiceError("youtube", 400, "Athena lost its place in your YouTube history. Load it again.");

/** Where the playlists stream is: the playlists (found on its first page), which one, and that one's next page. */
interface PlaylistCursor {
  lists: Array<{ id: string; title: string }>;
  i: number;
  token?: string;
}

export function youtubeStreams(get: Get, likes: string, tz: string): BackfillStream[] {
  const tokenOf = (cursor: string | undefined) => {
    if (cursor !== undefined && !TOKEN.test(cursor)) throw lost();
    return cursor;
  };
  return [
    {
      id: "likes",
      tools: ["list_liked_videos"],
      async page(cursor) {
        const r = await get<ListReply>("/playlistItems", { part: "snippet,contentDetails", playlistId: likes, maxResults: 50, pageToken: tokenOf(cursor) });
        const items = r.items ?? [];
        const entries = items.map((i) => videoEntry(i, tz, { id: likes, likes: true })).filter((e) => !!e);
        return { entries, watchRead: entries.map((e) => videoItem(e, true)), read: items.length, next: r.nextPageToken };
      },
    },
    {
      id: "playlists",
      tools: ["list_playlists", "list_playlist_videos"],
      async page(cursor) {
        let c: PlaylistCursor;
        if (cursor === undefined) {
          const lists: PlaylistCursor["lists"] = [];
          let pageToken: string | undefined;
          for (let n = 0; n < 20; n++) {
            const r = await get<ListReply>("/playlists", { part: "snippet", mine: "true", maxResults: 50, pageToken });
            for (const p of r.items ?? []) if (p.id && p.id !== likes && TOKEN.test(p.id)) lists.push({ id: p.id, title: (p.snippet?.title ?? "").slice(0, 120) });
            pageToken = r.nextPageToken;
            if (!pageToken) break;
          }
          if (!lists.length) return { entries: [], read: 0 };
          c = { lists, i: 0 };
        } else {
          try {
            c = JSON.parse(cursor) as PlaylistCursor;
          } catch {
            throw lost();
          }
          if (!Array.isArray(c.lists) || !Number.isInteger(c.i) || !c.lists[c.i]) throw lost();
        }
        const list = c.lists[c.i];
        const r = await get<ListReply>("/playlistItems", { part: "snippet,contentDetails", playlistId: list.id, maxResults: 50, pageToken: tokenOf(c.token) });
        const items = r.items ?? [];
        const entries = items.map((i) => videoEntry(i, tz, { id: list.id, title: list.title, likes: false })).filter((e) => !!e);
        const watchRead = entries.map((e) => videoItem(e, false, list.title || undefined));
        const next: PlaylistCursor | null = r.nextPageToken ? { ...c, token: r.nextPageToken } : c.i + 1 < c.lists.length ? { lists: c.lists, i: c.i + 1 } : null;
        // An empty playlist still moves the stream on: count it as one read.
        return { entries, watchRead, read: Math.max(items.length, 1), next: next ? JSON.stringify(next) : undefined };
      },
    },
    {
      id: "subscriptions",
      tools: ["list_subscriptions"],
      async page(cursor) {
        const r = await get<ListReply>("/subscriptions", { part: "snippet", mine: "true", maxResults: 50, order: "alphabetical", pageToken: tokenOf(cursor) });
        const items = r.items ?? [];
        return { entries: items.map((i) => subscriptionEntry(i, tz)).filter((e) => !!e), read: items.length, next: r.nextPageToken };
      },
    },
  ];
}

export const youtubeBackfill: HistoryBackfill = {
  tools: ["list_liked_videos", "list_playlists", "list_playlist_videos", "list_subscriptions"],
  async open(connector: Connector, secrets: ConnectorSecrets, ctx) {
    if (!secrets.tokens) throw new ServiceError("youtube", 401, "Not signed in yet", true);
    // Loaded here, not at the top: youtube-direct.ts registers this file's backfill.
    const { youtubeGet } = await import("./youtube-direct");
    const get = youtubeGet(connector, secrets);
    const me = await get<ListReply>("/channels", { part: "contentDetails", mine: "true" });
    const channel = me.items?.[0];
    if (!channel) throw new ServiceError("youtube", 404, "This Google account has no YouTube channel. Sign in with the account you use on YouTube.", true);
    return youtubeStreams(get, channel.contentDetails?.relatedPlaylists?.likes || "LL", ctx.tz);
  },
};
