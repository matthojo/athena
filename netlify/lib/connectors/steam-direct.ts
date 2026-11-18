/**
 * Steam without MCP: a narrow, read-only adapter over the Steam Web API
 * (api.steampowered.com), registered in direct.ts.
 *
 * Why not MCP: Valve runs no MCP server. The account is the owner's Web API
 * key (auth_type "token") and their profile address (steamcommunity.com/id/
 * <name> or /profiles/<SteamID>), resolved to a SteamID when opened. Only
 * read methods are called: ResolveVanityURL, GetPlayerSummaries,
 * GetRecentlyPlayedGames and GetOwnedGames.
 *
 * Steam keeps totals, not sessions: minutes in the last two weeks, minutes
 * ever, and when each game was last played. A private profile (or private
 * game details) returns no games at all, even to the owner's own key; the
 * tools say so with `private: true` rather than reporting nothing played.
 *
 * The key travels in the query string, as Steam requires: request URLs are
 * never logged.
 */
import { STEAM_HOSTS } from "../../../lib/presets/api-b";
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
  profileUrl,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";
import { steamRecent } from "./activity-recent";

export const STEAM_API_URL = "https://api.steampowered.com";

const BAD_ADDRESS = "That isn't a Steam profile address. Remove this account and add it again with yours, like https://steamcommunity.com/id/yourname.";
export const STEAM_PRIVATE_NOTE = "Steam returned no games: the profile's game details are private. Set them to Public under Edit Profile, then Privacy Settings.";

/** A profile address, as a vanity name or a SteamID64. Only steamcommunity.com; throws an owner-facing error otherwise. */
export function steamProfile(raw: string): { vanity: string } | { steamid: string } {
  const url = profileUrl("steam", raw, STEAM_HOSTS, BAD_ADDRESS);
  const id = /^\/profiles\/(7656\d{13})\/?/.exec(url.pathname);
  if (id) return { steamid: id[1] };
  const vanity = /^\/id\/([A-Za-z0-9_-]{2,32})\/?/.exec(url.pathname);
  if (vanity) return { vanity: vanity[1] };
  throw new LifeApiError("steam", 400, BAD_ADDRESS, true);
}

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("steam", 401, "Steam didn't accept the API key. Check it at steamcommunity.com/dev/apikey, then paste it under Edit.", true);
  if (status === 429) return new LifeApiError("steam", 429, "Steam is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("steam", status, "Steam is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("steam", status, `Steam refused that (${status})`);
}

export interface SteamContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  steamid: string;
  tz: string;
}

interface Game {
  appid?: number;
  name?: string;
  playtime_forever?: number;
  playtime_2weeks?: number;
  rtime_last_played?: number;
}

const hours = (min: number | undefined): number | undefined => (typeof min === "number" ? Math.round(min / 6) / 10 : undefined);
const store = (appid: number | undefined): string | undefined => (appid ? `https://store.steampowered.com/app/${appid}` : undefined);

/** Every game the owner has, with last-played times. undefined when Steam returned no game list (a private profile). */
async function owned(ctx: SteamContext): Promise<Game[] | undefined> {
  const body = await ctx.get<{
    response?: { game_count?: number; games?: Game[] };
  }>("/IPlayerService/GetOwnedGames/v1/", {
    steamid: ctx.steamid,
    include_appinfo: 1,
    include_played_free_games: 1,
  });
  const r = body.response;
  if (!r || (r.game_count === undefined && !r.games)) return undefined;
  return r.games ?? [];
}

function lastPlayed(g: Game | undefined, tz: string): { last_played_date?: string; last_played_time?: string } {
  if (!g?.rtime_last_played) return {};
  const at = when(g.rtime_last_played * 1000, tz);
  return { last_played_date: at.date, last_played_time: at.time };
}

async function recentlyPlayed(ctx: SteamContext) {
  const [recent, all] = await Promise.all([
    ctx.get<{ response?: { total_count?: number; games?: Game[] } }>("/IPlayerService/GetRecentlyPlayedGames/v1/", { steamid: ctx.steamid, count: 50 }),
    owned(ctx),
  ]);
  const games = recent.response?.games;
  if (!games && !all) return { items: [], private: true, note: STEAM_PRIVATE_NOTE };
  const byApp = new Map((all ?? []).map((g) => [g.appid, g]));
  const items = (games ?? []).map((g) =>
    clean({
      game: g.name,
      minutes_last_2_weeks: g.playtime_2weeks,
      hours_total: hours(g.playtime_forever),
      ...lastPlayed(byApp.get(g.appid), ctx.tz),
      link: store(g.appid),
    }),
  );
  return withItems(items, {
    minutes_last_2_weeks: (games ?? []).reduce((sum, g) => sum + (g.playtime_2weeks ?? 0), 0),
    note: "Steam keeps totals, not sessions: minutes_last_2_weeks is a rolling two-week total.",
  });
}

/** Games last played in a window, most recent first; Steam only records the latest time each game was played. */
async function playedGames(ctx: SteamContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 50 });
  const offset = decodeCursor<number>("steam:played", args.cursor) ?? 0;
  const all = await owned(ctx);
  if (!all) return { items: [], private: true, note: STEAM_PRIVATE_NOTE };
  const played = all.filter((g) => g.rtime_last_played && inWindow(g.rtime_last_played * 1000, w)).sort((a, b) => (b.rtime_last_played ?? 0) - (a.rtime_last_played ?? 0));
  const page = played.slice(offset, offset + limit);
  return withItems(
    page.map((g) =>
      clean({
        game: g.name,
        ...lastPlayed(g, ctx.tz),
        hours_total: hours(g.playtime_forever),
        minutes_last_2_weeks: g.playtime_2weeks,
        link: store(g.appid),
      }),
    ),
    {
      count: played.length,
      games_owned: all.length,
      next_cursor: offset + limit < played.length ? encodeCursor("steam:played", offset + limit) : undefined,
    },
  );
}

export const STEAM_TOOLS: LifeTool<SteamContext>[] = [
  {
    name: "recently_played",
    summary: "See what you played lately",
    description:
      "Games the owner played on Steam in the last two weeks: game, minutes in the last two weeks, total hours, when last played (local date and time) and store link, plus the two-week total in minutes. Steam keeps totals, not sessions. private: true means Steam hid the games (a private profile), not that nothing was played.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
    run: (ctx) => recentlyPlayed(ctx),
  },
  {
    name: "played_games",
    summary: "See when you last played",
    description:
      "The owner's Steam games last played in a window, most recent first: game, last played (local date and time), total hours, minutes in the last two weeks, store link. Steam only records the latest time each game was played, so a game played on 3 and 6 November shows once, on the 6th. Filter with date (one local day) or after/before. private: true means a private profile.",
    inputSchema: {
      type: "object",
      properties: {
        ...WINDOW_PROPS,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        ...CURSOR_PROP,
      },
    },
    annotations: readOnly,
    run: playedGames,
  },
];

/** Open the account: resolve the profile address to a SteamID, and read the profile summary, which proves the key works. */
export async function openSteam(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const profile = steamProfile(connector.url);
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("steam", 401, "Paste your Steam Web API key under Edit.", true);
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${STEAM_API_URL}${path}`);
    url.searchParams.set("key", key);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    url.searchParams.set("format", "json");
    return getJson<T>(url.toString(), {
      service: "steam",
      hosts: ["api.steampowered.com"],
      refused,
      unreachable: "Couldn't reach Steam",
    });
  };
  let steamid: string;
  if ("steamid" in profile) steamid = profile.steamid;
  else {
    const r = await get<{ response?: { success?: number; steamid?: string } }>("/ISteamUser/ResolveVanityURL/v1/", { vanityurl: profile.vanity });
    if (r.response?.success !== 1 || !r.response.steamid) throw new LifeApiError("steam", 404, "Steam can't find that profile. Remove this account and add it again with your profile address.", true);
    steamid = r.response.steamid;
  }
  const [summary, zone] = await Promise.all([
    get<{ response?: { players?: Array<{ steamid?: string }> } }>("/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamid }),
    tz ? Promise.resolve(tz) : ownerZone(),
  ]);
  if (!summary.response?.players?.length) throw new LifeApiError("steam", 404, "Steam can't find that profile. Remove this account and add it again with your profile address.", true);
  return account("steam", STEAM_TOOLS, { get, steamid, tz: zone });
}

export const steamAdapter: DirectAdapter = {
  id: "steam",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: steamRecent,
  handles: (c) => c.provider === "steam" && c.auth_type === "token",
  tools: () => STEAM_TOOLS,
  serverInfo: () => ({ website_url: "https://store.steampowered.com/" }),
  open: (connector, secrets) => openSteam(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("steam", e),
  failure: (e) => lifeFailure("steam", e),
};
