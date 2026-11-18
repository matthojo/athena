/**
 * Spotify without MCP: a narrow, read-only adapter over the Spotify Web API
 * (api.spotify.com/v1), registered in direct.ts.
 *
 * Why not MCP: Spotify runs no MCP server of its own; the ones in MCP
 * directories are community projects. The owner makes their own app in
 * Spotify's developer dashboard (Development Mode needs the owner on
 * Premium, since February 2026) and signs in with read scopes:
 * user-read-recently-played, user-library-read, user-top-read, and (since
 * Music's playlists) playlist-read-private and playlist-read-collaborative.
 * An account signed in before those were added gets a 403 on playlists:
 * that's "sign in again", never an account error (PLAYLISTS_NEED_SIGN_IN).
 *
 * Spotify keeps only the last 50 plays, so a Life log that runs once a day
 * misses plays on a busy day: the preset's help says to run it every few hours.
 */
import { SPOTIFY_API_URL, SPOTIFY_SCOPE } from "../../../lib/presets/api-b";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { arg, clean, type StoredTokens } from "./google-api";
import { spotifyBackfill } from "./backfill-tools";
import { spotifyRecent } from "./media-recent";
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
  type LifeTool,
  type TokenEndpoint,
} from "./lifelog-b-http";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

const TOKEN: TokenEndpoint = {
  service: "spotify",
  url: SPOTIFY_TOKEN_URL,
  label: "Spotify",
};

function refused(status: number): LifeApiError {
  if (status === 401) return new LifeApiError("spotify", 401, "Spotify didn't accept the sign-in. Sign in again", true);
  if (status === 403) {
    return new LifeApiError(
      "spotify",
      403,
      "Spotify refused Athena. Check your Premium is active and your Spotify account is listed under User Management in your app's dashboard, then sign in again.",
      true,
    );
  }
  if (status === 429) return new LifeApiError("spotify", 429, "Spotify is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("spotify", status, "Spotify is having trouble right now. Try again in a few minutes.");
  if (status === 404) return new LifeApiError("spotify", 404, "Spotify couldn't find that");
  return new LifeApiError("spotify", status, `Spotify refused that (${status})`);
}

export interface SpotifyContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  tz: string;
  /** The signed-in user's Spotify id, from /me: which playlists are the owner's own. */
  me?: string;
}

interface Named {
  name?: string;
  external_urls?: { spotify?: string };
}
interface Track extends Named {
  artists?: Named[];
  album?: Named & { release_date?: string };
  duration_ms?: number;
}
interface Album extends Named {
  artists?: Named[];
  release_date?: string;
  total_tracks?: number;
}

const names = (list: Named[] | undefined): string | undefined =>
  (list ?? [])
    .map((a) => a.name)
    .filter(Boolean)
    .join(", ") || undefined;
const minutes = (ms: number | undefined): number | undefined => (typeof ms === "number" ? Math.round(ms / 6000) / 10 : undefined);

function track(t: Track | undefined) {
  return {
    track: t?.name,
    artist: names(t?.artists),
    album: t?.album?.name,
    minutes: minutes(t?.duration_ms),
    link: t?.external_urls?.spotify,
  };
}

const LIMIT = (max: number, fallback: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `At most this many (default ${fallback}).`,
});

/** Plays, newest first, walking back with Spotify's `before` cursor until the window starts or the 50 Spotify keeps run out. */
async function recentlyPlayed(ctx: SpotifyContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 50 });
  let before = decodeCursor<number>("spotify:recent", args.cursor) ?? w.before;
  const items: Record<string, unknown>[] = [];
  let next: number | undefined;
  for (let page = 0; page < 3 && items.length < limit; page++) {
    const body = await ctx.get<{
      items?: Array<{ track?: Track; played_at?: string }>;
      cursors?: { before?: string } | null;
      next?: string | null;
    }>("/me/player/recently-played", { limit: 50, before });
    let passed = false;
    for (const p of body.items ?? []) {
      const ms = Date.parse(p.played_at ?? "");
      if (!Number.isFinite(ms)) continue;
      if (w.after !== undefined && ms < w.after) {
        passed = true;
        break;
      }
      if (!inWindow(ms, w)) continue;
      const at = when(ms, ctx.tz);
      items.push(clean({ ...track(p.track), date: at.date, time: at.time, played_at: at.at }));
      if (items.length >= limit) {
        next = ms;
        break;
      }
    }
    if (items.length >= limit) break;
    const cursor = Number(body.cursors?.before);
    if (passed || !body.next || !Number.isFinite(cursor)) {
      next = undefined;
      break;
    }
    before = cursor;
    next = cursor;
  }
  const total = items.reduce((sum, i) => sum + ((i.minutes as number | undefined) ?? 0), 0);
  return withItems(items, {
    plays: items.length,
    minutes_listened: Math.round(total),
    next_cursor: next ? encodeCursor("spotify:recent", next) : undefined,
    note: "Spotify only keeps the last 50 plays: anything older is gone.",
  });
}

/** Saved tracks or albums, most recently saved first; the window filters on when each was saved. */
async function saved(ctx: SpotifyContext, kind: "tracks" | "albums", args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 50 });
  let offset = decodeCursor<number>(`spotify:${kind}`, args.cursor) ?? 0;
  const items: Record<string, unknown>[] = [];
  let next: number | undefined;
  for (let page = 0; page < 4 && items.length < limit; page++) {
    const body = await ctx.get<{
      items?: Array<{ added_at?: string; track?: Track; album?: Album }>;
      next?: string | null;
      total?: number;
    }>(`/me/${kind}`, { limit: 50, offset });
    const list = body.items ?? [];
    let passed = false;
    let i = 0;
    for (; i < list.length; i++) {
      const s = list[i];
      const ms = Date.parse(s.added_at ?? "");
      if (w.after !== undefined && Number.isFinite(ms) && ms < w.after) {
        passed = true;
        break;
      }
      if (Number.isFinite(ms) && !inWindow(ms, w)) continue;
      const at = Number.isFinite(ms) ? when(ms, ctx.tz) : undefined;
      const what =
        kind === "tracks"
          ? track(s.track)
          : {
              album: s.album?.name,
              artist: names(s.album?.artists),
              released: s.album?.release_date,
              tracks: s.album?.total_tracks,
              link: s.album?.external_urls?.spotify,
            };
      items.push(clean({ ...what, saved_date: at?.date, saved_time: at?.time }));
      if (items.length >= limit) {
        i++;
        break;
      }
    }
    if (passed) {
      next = undefined;
      break;
    }
    offset += i;
    next = body.next || i < list.length ? offset : undefined;
    if (!body.next || items.length >= limit) break;
  }
  return withItems(items, {
    count: items.length,
    next_cursor: next !== undefined ? encodeCursor(`spotify:${kind}`, next) : undefined,
  });
}

// ---------- Playlists (February 2026 API: /me/playlists, /playlists/{id}/items, `item` not `track`) ----------

/** What a playlist read says when the sign-in predates the playlist scopes. Matched by playlist-sync.ts. */
export const PLAYLISTS_NEED_SIGN_IN = "Sign in again to let Athena read your playlists";

interface Playlist extends Named {
  id?: string;
  owner?: { id?: string; display_name?: string | null };
  collaborative?: boolean;
  snapshot_id?: string;
  items?: { total?: number };
  tracks?: { total?: number };
}

/** A 403 on a playlist read: the old sign-in lacks the scope (or, for one playlist's items, it isn't the owner's). */
async function playlistRead<T>(ctx: SpotifyContext, path: string, params: Record<string, string | number | undefined>, notYours?: string): Promise<T> {
  try {
    return await ctx.get<T>(path, params);
  } catch (error) {
    if (error instanceof LifeApiError && error.status === 403) throw new LifeApiError("spotify", 403, notYours ?? PLAYLISTS_NEED_SIGN_IN, false);
    throw error;
  }
}

/** The owner's playlists, made or followed, 50 a page; mine says which they made. */
export async function listPlaylists(ctx: SpotifyContext & { me?: string }, args: Record<string, unknown>) {
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 50 });
  const offset = decodeCursor<number>("spotify:playlists", args.cursor) ?? 0;
  const body = await playlistRead<{ items?: Playlist[]; next?: string | null; total?: number }>(ctx, "/me/playlists", { limit, offset });
  const list = body.items ?? [];
  const items = list.map((p) =>
    clean({
      id: p.id,
      playlist: p.name,
      owner: p.owner?.display_name ?? p.owner?.id,
      mine: ctx.me ? p.owner?.id === ctx.me : undefined,
      collaborative: p.collaborative || undefined,
      tracks: p.items?.total ?? p.tracks?.total,
      version: p.snapshot_id,
      link: p.external_urls?.spotify,
    }),
  );
  return withItems(items, {
    total: body.total,
    next_cursor: body.next ? encodeCursor("spotify:playlists", offset + list.length) : undefined,
  });
}

/** One playlist's tracks, in order, 50 a page. Spotify only gives these for playlists the owner made or collaborates on. */
export async function listPlaylistTracks(ctx: SpotifyContext, args: Record<string, unknown>) {
  const id = arg.str(args, "playlist_id", { required: true, max: 64 })!;
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new LifeApiError("spotify", 400, "playlist_id: the id list_playlists gives");
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 50 });
  const offset = decodeCursor<number>(`spotify:pl:${id}`, args.cursor) ?? 0;
  const body = await playlistRead<{ items?: Array<{ added_at?: string | null; is_local?: boolean; item?: Track | null; track?: Track | null }>; next?: string | null; total?: number }>(
    ctx,
    `/playlists/${id}/items`,
    { limit, offset, additional_types: "track" },
    "Spotify only shares the tracks of playlists you made or collaborate on",
  );
  const list = body.items ?? [];
  const items = list
    .map((p) => {
      const t = p.item ?? p.track;
      if (!t?.name) return null;
      const ms = Date.parse(p.added_at ?? "");
      return clean({ ...track(t), added_date: Number.isFinite(ms) ? when(ms, ctx.tz).date : undefined });
    })
    .filter((x): x is Record<string, unknown> => !!x);
  return withItems(items, {
    total: body.total,
    next_cursor: body.next ? encodeCursor(`spotify:pl:${id}`, offset + list.length) : undefined,
  });
}

const RANGES = ["short_term", "medium_term", "long_term"] as const;

async function topItems(ctx: SpotifyContext, args: Record<string, unknown>) {
  const type = arg.oneOf(args, "type", ["tracks", "artists"] as const) ?? "tracks";
  const range = arg.oneOf(args, "time_range", RANGES) ?? "short_term";
  const limit = arg.int(args, "limit", { min: 1, max: 50, fallback: 20 });
  const offset = decodeCursor<number>(`spotify:top:${type}`, args.cursor) ?? 0;
  const body = await ctx.get<{
    items?: Array<Track & { genres?: string[] }>;
    next?: string | null;
  }>(`/me/top/${type}`, { time_range: range, limit, offset });
  const list = body.items ?? [];
  const items = list.map((t, i) =>
    clean(
      type === "tracks"
        ? { rank: offset + i + 1, ...track(t) }
        : {
            rank: offset + i + 1,
            artist: t.name,
            genres: (t.genres ?? []).slice(0, 3),
            link: t.external_urls?.spotify,
          },
    ),
  );
  return withItems(items, {
    time_range: range,
    next_cursor: body.next ? encodeCursor(`spotify:top:${type}`, offset + list.length) : undefined,
  });
}

export const SPOTIFY_TOOLS: LifeTool<SpotifyContext>[] = [
  {
    name: "recently_played",
    summary: "See what you played lately",
    description:
      "Tracks the owner played on Spotify, newest first: track, artist, album, length in minutes, local date and time, played_at (UTC), and link, plus plays and minutes_listened for what's returned. Spotify only keeps the last 50 plays. Filter with date (one local day) or after/before.",
    inputSchema: {
      type: "object",
      properties: { ...WINDOW_PROPS, limit: LIMIT(50, 50), ...CURSOR_PROP },
    },
    annotations: readOnly,
    run: recentlyPlayed,
  },
  {
    name: "saved_tracks",
    summary: "See songs you saved",
    description:
      "Songs the owner saved to Liked Songs, most recently saved first, with when each was saved (local date and time). Filter with date or after/before on the saved time. Page with next_cursor.",
    inputSchema: {
      type: "object",
      properties: { ...WINDOW_PROPS, limit: LIMIT(50, 50), ...CURSOR_PROP },
    },
    annotations: readOnly,
    run: (ctx, args) => saved(ctx, "tracks", args),
  },
  {
    name: "saved_albums",
    summary: "See albums you saved",
    description:
      "Albums the owner saved, most recently saved first: album, artist, release date, track count, when saved (local) and link. Filter with date or after/before on the saved time. Page with next_cursor.",
    inputSchema: {
      type: "object",
      properties: { ...WINDOW_PROPS, limit: LIMIT(50, 50), ...CURSOR_PROP },
    },
    annotations: readOnly,
    run: (ctx, args) => saved(ctx, "albums", args),
  },
  {
    name: "top_items",
    summary: "See your top songs and artists",
    description:
      "The owner's most-played tracks or artists on Spotify. type: tracks (default) or artists. time_range: short_term (about 4 weeks, default), medium_term (about 6 months) or long_term (about a year). Page with next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["tracks", "artists"] },
        time_range: { type: "string", enum: [...RANGES] },
        limit: LIMIT(50, 20),
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: topItems,
  },
  {
    name: "list_playlists",
    summary: "See your playlists",
    description: "The owner's Spotify playlists, the ones they made and the ones they follow: name, owner, mine (true when the owner made it), track count, link and id for list_playlist_tracks. Page with next_cursor.",
    inputSchema: { type: "object", properties: { limit: LIMIT(50, 50), ...CURSOR_PROP } },
    annotations: readOnly,
    run: listPlaylists,
  },
  {
    name: "list_playlist_tracks",
    summary: "See what's in a playlist",
    description: "The tracks in one of the owner's playlists, in order: track, artist, album, length, when added and link. playlist_id comes from list_playlists. Spotify only gives tracks for playlists the owner made or collaborates on. Page with next_cursor.",
    inputSchema: { type: "object", properties: { playlist_id: { type: "string" }, limit: LIMIT(50, 50), ...CURSOR_PROP }, required: ["playlist_id"] },
    annotations: readOnly,
    run: listPlaylistTracks,
  },
];

/** A signed-in GET against the Web API (tokens renewed as needed); no read of its own. */
export function spotifyGet(connector: Connector, secrets: ConnectorSecrets): SpotifyContext["get"] {
  if (!secrets.tokens) throw new LifeApiError("spotify", 401, "Not signed in yet", true);
  const session = new OAuthSession(TOKEN, connector, secrets);
  return <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${SPOTIFY_API_URL}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return session.get<T>(url.toString(), {
      service: "spotify",
      hosts: ["api.spotify.com"],
      refused,
      unreachable: "Couldn't reach Spotify",
    });
  };
}

/** Open a signed-in account: one cheap read (/me), which proves the sign-in works. */
export async function openSpotify(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const get = spotifyGet(connector, secrets);
  const [me, zone] = await Promise.all([get<{ id?: string }>("/me"), tz ? Promise.resolve(tz) : ownerZone()]);
  return account("spotify", SPOTIFY_TOOLS, { get, tz: zone, me: me?.id });
}

export function spotifyAuthorizationUrl(input: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string }): string {
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: input.scope || SPOTIFY_SCOPE,
    state: input.state,
    code_challenge_method: "S256",
    code_challenge: input.challenge,
  }).toString();
  return url.toString();
}

export async function exchangeSpotifyCode(input: { code: string; redirectUri: string; verifier: string; client: { client_id: string; client_secret?: string } }): Promise<StoredTokens> {
  const tokens = await tokenRequest(TOKEN, input.client, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  if (!tokens.refresh_token) throw new LifeApiError("spotify", 400, "Spotify gave Athena no way to renew this sign-in", true);
  return { ...tokens, obtained_at: Date.now() };
}

export const spotifyAdapter: DirectAdapter = {
  backfill: spotifyBackfill,
  recent: spotifyRecent,
  id: "spotify",
  handles: (c) => c.provider === "spotify" && c.auth_type === "oauth",
  tools: () => SPOTIFY_TOOLS,
  serverInfo: () => ({ website_url: "https://open.spotify.com/" }),
  open: (connector, secrets) => openSpotify(connector, secrets),
  authorizationUrl: spotifyAuthorizationUrl,
  exchangeCode: exchangeSpotifyCode,
  accountProblem: (e) => lifeAccountProblem("spotify", e),
  failure: (e) => lifeFailure("spotify", e),
};
