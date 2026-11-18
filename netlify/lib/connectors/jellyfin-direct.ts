/**
 * Jellyfin without MCP: a narrow, read-only adapter over the owner's own
 * Jellyfin server, registered in direct.ts.
 *
 * Why not MCP: Jellyfin runs no MCP server. The account is the server's
 * https address (the URL, checked when added and again, against internal
 * addresses, each time it's opened) and an API key from the dashboard
 * (auth_type "token"). Reads: /System/Info (proves the key), /Users (finds
 * whose viewing to read), and the played films and episodes for that user,
 * by DatePlayed. GETs only; a redirect is refused rather than followed.
 *
 * An API key sees every user on the server. Athena reads one: the first
 * administrator, who is normally the owner. Jellyfin keeps one "last played"
 * date per item, so a rewatch moves an item rather than adding a second play.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { AthenaInputError } from "../../../lib/db";
import { arg, clean } from "./google-api";
import { jellyfinBackfill } from "./backfill-tools";
import { jellyfinRecent } from "./media-recent";
import type { DirectAccount, DirectAdapter } from "./direct";
import { mediaServerNet } from "./plex-direct";
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

export const JELLYFIN_UNREACHABLE =
  "Athena can't reach your Jellyfin server from the internet. Check the address opens on your phone with Wi-Fi off.";
const HOME_ADDRESS = "That address is on your home network, which Athena can't reach. Use the https address you open Jellyfin with away from home.";
const PAGE = 100;
const MAX_PAGES = 10;

/**
 * The server's address as Athena keeps it: https, no credentials, no query,
 * Jellyfin's own /web page stripped. A bare host name gets https:// in front.
 */
export function jellyfinAddress(raw: string): string {
  let v = raw.trim();
  if (!v) throw new AthenaInputError("Paste your Jellyfin server's address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new AthenaInputError("That isn't a web address. Paste the one you open Jellyfin with, like https://jellyfin.you.com.");
  }
  if (url.protocol !== "https:") throw new AthenaInputError("Athena needs your server's https address, so your key stays private. Paste the one that starts https://.");
  if (url.username || url.password) throw new AthenaInputError("Leave your username and password out of the address. Athena only needs the API key.");
  const path = url.pathname.replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("jellyfin", 401, "Jellyfin didn't accept that key. Make a new one in Dashboard, then API Keys.", true);
  if (status === 404) return new LifeApiError("jellyfin", 404, "That address doesn't look like a Jellyfin server. Check you copied all of it.", true);
  if (status >= 300 && status < 400) return new LifeApiError("jellyfin", 502, JELLYFIN_UNREACHABLE, true);
  if (status === 429) return new LifeApiError("jellyfin", 429, "Jellyfin is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("jellyfin", status, "Jellyfin is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("jellyfin", status, `Jellyfin refused that (${status})`);
}

export interface JellyfinContext {
  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  base: string;
  serverId: string;
  serverName: string;
  user: { id: string; name: string };
  tz: string;
}

interface Played {
  Id?: string;
  ServerId?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  UserData?: { LastPlayedDate?: string; PlayCount?: number; Played?: boolean };
}

const link = (ctx: Pick<JellyfinContext, "base" | "serverId">, id: string | undefined) => (id ? `${ctx.base}/web/#/details?id=${id}${ctx.serverId ? `&serverId=${ctx.serverId}` : ""}` : undefined);

/** One played item as compact JSON, in the owner's local day and time; null for anything that isn't a film or episode, or has no play date. */
export function jellyfinItem(p: Played, ctx: Pick<JellyfinContext, "base" | "serverId" | "tz">): Record<string, unknown> | null {
  const ms = Date.parse(p.UserData?.LastPlayedDate ?? "");
  if (Number.isNaN(ms)) return null;
  const at = when(ms, ctx.tz);
  const plays = p.UserData?.PlayCount && p.UserData.PlayCount > 1 ? p.UserData.PlayCount : undefined;
  if (p.Type === "Movie") return clean({ kind: "film", title: p.Name, year: p.ProductionYear, ...at, plays, id: p.Id, link: link(ctx, p.Id) });
  if (p.Type === "Episode")
    return clean({
      kind: "episode",
      show: p.SeriesName,
      season: p.ParentIndexNumber,
      episode: p.IndexNumber,
      title: p.Name,
      ...at,
      plays,
      show_id: p.SeriesId,
      link: link(ctx, p.Id),
      show_link: link(ctx, p.SeriesId),
    });
  return null;
}

/** A page of played films and episodes, last played first. Jellyfin 10.9+ answers /Items?userId=; older servers /Users/{id}/Items. */
async function playedPage(ctx: JellyfinContext, start: number): Promise<{ items: Played[]; total: number }> {
  const params = { Recursive: true, IncludeItemTypes: "Movie,Episode", Filters: "IsPlayed", SortBy: "DatePlayed", SortOrder: "Descending", EnableUserData: true, StartIndex: start, Limit: PAGE };
  let body: { Items?: Played[]; TotalRecordCount?: number };
  try {
    body = await ctx.get("/Items", { ...params, userId: ctx.user.id });
  } catch (error) {
    if (!(error instanceof LifeApiError) || error.status !== 404) throw error;
    body = await ctx.get(`/Users/${encodeURIComponent(ctx.user.id)}/Items`, params);
  }
  return { items: body.Items ?? [], total: body.TotalRecordCount ?? 0 };
}

async function watchHistory(ctx: JellyfinContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 50 });
  let start = decodeCursor<number>("jellyfin:history", args.cursor) ?? 0;
  const out: Record<string, unknown>[] = [];
  let more = false;
  // Newest first: skip what's after the window, stop at the first play before it.
  pages: for (let n = 0; n < MAX_PAGES; n++) {
    const page = await playedPage(ctx, start);
    for (let i = 0; i < page.items.length; i++) {
      const p = page.items[i];
      const ms = Date.parse(p.UserData?.LastPlayedDate ?? "");
      if (!Number.isNaN(ms) && w.after !== undefined && ms < w.after) break pages;
      const item = !Number.isNaN(ms) && inWindow(ms, w) ? jellyfinItem(p, ctx) : null;
      if (item) out.push(item);
      if (out.length === limit) {
        start += i + 1;
        // Look one ahead on this page: a next play before the window means there's nothing more.
        const nextMs = Date.parse(page.items[i + 1]?.UserData?.LastPlayedDate ?? "");
        more = start < page.total && !(w.after !== undefined && !Number.isNaN(nextMs) && nextMs < w.after);
        break pages;
      }
    }
    start += page.items.length;
    if (!page.items.length || start >= page.total) break;
    more = n === MAX_PAGES - 1;
  }
  return withItems(out, {
    count: out.length,
    films: out.filter((i) => i.kind === "film").length,
    episodes: out.filter((i) => i.kind === "episode").length,
    user: ctx.user.name,
    server: ctx.serverName,
    next_cursor: more ? encodeCursor("jellyfin:history", start) : undefined,
  });
}

export const JELLYFIN_TOOLS: LifeTool<JellyfinContext>[] = [
  {
    name: "watch_history",
    summary: "See what you've watched",
    description:
      "Films and episodes the owner watched on their Jellyfin server, last played first: each film with its year, each episode with its show, season, number and title, the owner's local date and time it was last played, plays when more than one, and a link. Jellyfin keeps only the latest play of each item, so a rewatch shows once, on its latest day. Films and shows belong in Watch & read: film external_id is id, a show's is show_id, source jellyfin. Filter with date (one local day) or after/before; page with next_cursor.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, limit: { type: "integer", minimum: 1, maximum: 100 }, ...CURSOR_PROP } },
    annotations: readOnly,
    run: watchHistory,
  },
];

interface JellyfinUser {
  Id?: string;
  Name?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
}

/** Whose viewing to read: the first administrator, else the only user. */
export function ownerUser(users: JellyfinUser[]): { id: string; name: string } | null {
  const live = users.filter((u) => u.Id && !u.Policy?.IsDisabled);
  const u = live.find((x) => x.Policy?.IsAdministrator) ?? (live.length === 1 ? live[0] : undefined);
  return u ? { id: u.Id!, name: u.Name ?? "" } : null;
}

/** Open the account: the address checked as public, /System/Info proving the key, and the owner's user found. */
export async function openJellyfin(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  let base: string;
  try {
    base = jellyfinAddress(connector.url);
  } catch (error) {
    throw new LifeApiError("jellyfin", 400, (error as Error).message, true);
  }
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("jellyfin", 401, "Paste your Jellyfin API key under Edit.", true);
  try {
    await mediaServerNet.assertPublic(new URL(base));
  } catch {
    throw new LifeApiError("jellyfin", 400, HOME_ADDRESS, true);
  }
  const host = new URL(base).hostname;
  const get = <T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> => {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), {
      service: "jellyfin",
      hosts: [host],
      headers: { Authorization: `MediaBrowser Client="Athena", Device="Athena", DeviceId="athena-${connector.id}", Version="1.0", Token="${key}"`, "X-Emby-Token": key },
      refused,
      redirect: "manual",
      typed: true,
      unreachable: JELLYFIN_UNREACHABLE,
    });
  };
  const [info, users, zone] = await Promise.all([
    get<{ Id?: string; ServerName?: string }>("/System/Info"),
    get<JellyfinUser[]>("/Users"),
    tz ? Promise.resolve(tz) : ownerZone(),
  ]);
  const user = ownerUser(Array.isArray(users) ? users : []);
  if (!user) throw new LifeApiError("jellyfin", 404, "Athena couldn't tell which Jellyfin user is you. Make sure your own user is an administrator.", true);
  return account("jellyfin", JELLYFIN_TOOLS, { get, base, serverId: info.Id ?? "", serverName: info.ServerName ?? "Jellyfin", user, tz: zone });
}

export const jellyfinAdapter: DirectAdapter = {
  backfill: jellyfinBackfill,
  recent: jellyfinRecent,
  id: "jellyfin",
  handles: (c) => c.provider === "jellyfin" && c.auth_type === "token",
  tools: () => JELLYFIN_TOOLS,
  serverInfo: () => ({ website_url: "https://jellyfin.org/" }),
  open: (connector, secrets) => openJellyfin(connector, secrets),
  checkAddress: jellyfinAddress,
  accountProblem: (e) => lifeAccountProblem("jellyfin", e),
  failure: (e) => lifeFailure("jellyfin", e),
};
