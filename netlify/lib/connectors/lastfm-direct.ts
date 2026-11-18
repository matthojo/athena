/**
 * Last.fm without MCP: a narrow, read-only adapter over the Last.fm API
 * (ws.audioscrobbler.com/2.0), registered in direct.ts.
 *
 * Why not MCP: Last.fm runs no MCP server of its own. Reading someone's
 * scrobbles needs only an API key and their username, so the account is the
 * owner's API key (auth_type "token") and their profile address
 * (last.fm/user/<name>), which is how Athena knows whose history to read.
 * Last.fm's web sign-in (auth.getSession) would also name the user, but it
 * signs every call with the shared secret and returns ?token= without a
 * state, which the shared OAuth callback doesn't take; and it isn't needed to
 * read. Only methods that read are called (user.getInfo,
 * user.getRecentTracks, user.getTopArtists), so nothing is ever scrobbled.
 *
 * The key travels in the query string, as Last.fm requires: request URLs are
 * never logged.
 */
import { LASTFM_HOSTS } from "../../../lib/presets/api-b";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean } from "./google-api";
import { lastfmBackfill } from "./backfill-tools";
import { lastfmRecent } from "./media-recent";
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
  profileUrl,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";

export const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";

const BAD_ADDRESS = "That isn't a Last.fm profile address. Remove this account and add it again with yours, like https://www.last.fm/user/yourname.";

/** "https://www.last.fm/user/someone/library" → "someone". Only Last.fm's own hosts; throws an owner-facing error otherwise. */
export function lastfmUser(raw: string): string {
  const url = profileUrl("lastfm", raw, LASTFM_HOSTS, BAD_ADDRESS);
  const m = /^\/user\/([^/]+)/i.exec(url.pathname);
  const name = m ? decodeURIComponent(m[1]).trim() : "";
  if (!/^[A-Za-z0-9_.\- ]{1,64}$/.test(name)) throw new LifeApiError("lastfm", 400, BAD_ADDRESS, true);
  return name;
}

/** Last.fm's error codes (last.fm/api/errorcodes), as plain English. */
function lastfmError(code: number, status: number): LifeApiError {
  if (code === 10 || code === 26) return new LifeApiError("lastfm", 401, "Last.fm didn't accept the API key. Check it at last.fm/api/accounts, then paste it under Edit.", true);
  if (code === 17) return new LifeApiError("lastfm", 403, "Your recent listening is hidden on Last.fm. Turn off Hide recent listening in Last.fm's privacy settings, then try again.", true);
  if (code === 6) return new LifeApiError("lastfm", 404, "Last.fm can't find that profile. Remove this account and add it again with your profile address.", true);
  if (code === 29) return new LifeApiError("lastfm", 429, "Last.fm is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (code === 8 || code === 11 || code === 16) return new LifeApiError("lastfm", 503, "Last.fm is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("lastfm", 400, `Last.fm refused that (error ${code})`);
}

const errorCode = (body: unknown): number | undefined => {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof e === "number" ? e : undefined;
};

function refused(status: number, body: unknown): LifeApiError {
  const code = errorCode(body);
  if (code !== undefined) return lastfmError(code, status);
  if (status === 429) return lastfmError(29, status);
  if (status >= 500) return lastfmError(16, status);
  if (status === 403 || status === 401) return lastfmError(10, status);
  return new LifeApiError("lastfm", status, `Last.fm refused that (${status})`);
}

export interface LastfmContext {
  get<T>(method: string, params?: Record<string, string | number | undefined>): Promise<T>;
  user: string;
  tz: string;
}

type Text = { "#text"?: string; name?: string } | string | undefined;
const text = (v: Text): string | undefined => (typeof v === "string" ? v : (v?.["#text"] ?? v?.name))?.trim() || undefined;

interface Scrobble {
  name?: string;
  artist?: Text;
  album?: Text;
  url?: string;
  loved?: string;
  date?: { uts?: string };
  "@attr"?: { nowplaying?: string };
}

const asList = <T>(v: T | T[] | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);

/** Scrobbles in a window, newest first, 200 a page. A day with more than 200 pages on with next_cursor. */
async function listScrobbles(ctx: LastfmContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 200, fallback: 200 });
  const page = decodeCursor<number>("lastfm:recent", args.cursor) ?? 1;
  const body = await ctx.get<{
    recenttracks?: {
      track?: Scrobble | Scrobble[];
      "@attr"?: { page?: string; totalPages?: string; total?: string };
    };
  }>("user.getrecenttracks", {
    user: ctx.user,
    limit,
    page,
    extended: 1,
    from: w.after !== undefined ? Math.floor(w.after / 1000) : undefined,
    // Last.fm's `to` is inclusive, the window's `before` isn't.
    to: w.before !== undefined ? Math.ceil(w.before / 1000) - 1 : undefined,
  });
  const tracks = asList(body.recenttracks?.track);
  let nowPlaying: Record<string, unknown> | undefined;
  const items: Record<string, unknown>[] = [];
  for (const t of tracks) {
    const item = {
      track: t.name?.trim(),
      artist: text(t.artist),
      album: text(t.album),
      link: t.url,
      loved: t.loved === "1" || undefined,
    };
    if (t["@attr"]?.nowplaying === "true") {
      nowPlaying = clean(item);
      continue;
    }
    const uts = Number(t.date?.uts);
    if (!Number.isFinite(uts)) continue;
    const at = when(uts * 1000, ctx.tz);
    items.push(clean({ ...item, date: at.date, time: at.time, played_at: at.at }));
  }
  const attr = body.recenttracks?.["@attr"];
  const pages = Number(attr?.totalPages) || 1;
  // A fold of the page by artist, for "an album played through" lines.
  const byArtist = new Map<string, number>();
  for (const i of items) if (i.artist) byArtist.set(i.artist as string, (byArtist.get(i.artist as string) ?? 0) + 1);
  return withItems(items, {
    scrobbles: Number(attr?.total) || items.length,
    top_artists: [...byArtist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([artist, plays]) => ({ artist, plays })),
    now_playing: nowPlaying,
    next_cursor: page < pages ? encodeCursor("lastfm:recent", page + 1) : undefined,
  });
}

const PERIODS = ["7day", "1month", "3month", "6month", "12month", "overall"] as const;

async function topArtists(ctx: LastfmContext, args: Record<string, unknown>) {
  const period = arg.oneOf(args, "period", PERIODS) ?? "7day";
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 20 });
  const page = decodeCursor<number>("lastfm:top", args.cursor) ?? 1;
  const body = await ctx.get<{
    topartists?: {
      artist?: Array<{ name?: string; playcount?: string; url?: string }> | { name?: string };
      "@attr"?: { totalPages?: string };
    };
  }>("user.gettopartists", {
    user: ctx.user,
    period,
    limit,
    page,
  });
  const list = asList(
    body.topartists?.artist as Array<{
      name?: string;
      playcount?: string;
      url?: string;
    }>,
  );
  const pages = Number(body.topartists?.["@attr"]?.totalPages) || 1;
  return withItems(
    list.map((a) =>
      clean({
        artist: a.name,
        plays: Number(a.playcount) || undefined,
        link: a.url,
      }),
    ),
    {
      period,
      next_cursor: page < pages ? encodeCursor("lastfm:top", page + 1) : undefined,
    },
  );
}

export const LASTFM_TOOLS: LifeTool<LastfmContext>[] = [
  {
    name: "list_scrobbles",
    summary: "See what you listened to",
    description:
      "The owner's full Last.fm listening history (scrobbles), newest first: track, artist, album, loved, local date and time, link; plus the total scrobbles in the window and the page's top artists. Ask one day at a time with date (YYYY-MM-DD, the owner's time zone), or use after/before. Up to 200 a page; page on with next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "At most this many a page (default 200).",
        },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: listScrobbles,
  },
  {
    name: "top_artists",
    summary: "See your top artists",
    description: "The owner's most-scrobbled artists on Last.fm with play counts. period: 7day (default), 1month, 3month, 6month, 12month or overall. Page with next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: topArtists,
  },
];

/** Open the account: the profile address names the user, and user.getInfo proves the key works and the profile exists. */
export async function openLastfm(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const user = lastfmUser(connector.url);
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("lastfm", 401, "Paste your Last.fm API key under Edit.", true);
  const get = <T>(method: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(LASTFM_API_URL);
    url.searchParams.set("method", method);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    url.searchParams.set("api_key", key);
    url.searchParams.set("format", "json");
    return getJson<T>(url.toString(), {
      service: "lastfm",
      hosts: ["ws.audioscrobbler.com"],
      headers: { "User-Agent": "Athena/1.0 (personal life log, read-only)" },
      refused,
      bodyError: (body) => (errorCode(body) !== undefined ? lastfmError(errorCode(body)!, 200) : null),
      unreachable: "Couldn't reach Last.fm",
    });
  };
  const [info, zone] = await Promise.all([get<{ user?: { name?: string } }>("user.getinfo", { user }), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("lastfm", LASTFM_TOOLS, {
    get,
    user: info.user?.name || user,
    tz: zone,
  });
}

export const lastfmAdapter: DirectAdapter = {
  backfill: lastfmBackfill,
  recent: lastfmRecent,
  id: "lastfm",
  handles: (c) => c.provider === "lastfm" && c.auth_type === "token",
  tools: () => LASTFM_TOOLS,
  serverInfo: () => ({ website_url: "https://www.last.fm/" }),
  open: (connector, secrets) => openLastfm(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("lastfm", e),
  failure: (e) => lifeFailure("lastfm", e),
};
