/**
 * Plex without MCP: a narrow, read-only adapter over the owner's own Plex
 * Media Server, registered in direct.ts.
 *
 * Why not MCP: Plex runs no MCP server. The account is the owner's Plex token
 * (auth_type "token"; the whole "View XML" address works too, the token is
 * taken out of it). Athena asks plex.tv for the owner's servers
 * (clients.plex.tv/api/v2/resources), picks the first one they own that
 * answers from the internet (a direct https address, else Plex's relay), and
 * reads its watch history (/status/sessions/history/all). GETs only.
 *
 * Only the server owner's viewing is read (accountID 1): other people sharing
 * the server stay out. Every server address is checked to be public, and a
 * redirect is refused rather than followed. Tokens and request URLs are never
 * logged.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { PLEX_DIRECTORY_URL } from "../../../lib/presets/media-travel";
import { arg, clean } from "./google-api";
import { plexBackfill } from "./backfill-tools";
import { plexRecent } from "./media-recent";
import type { DirectAccount, DirectAdapter } from "./direct";
import { assertPublicHost, publicFetch } from "./icons";
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
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";

/** Plex's own account owner on every server. */
export const PLEX_OWNER_ACCOUNT = 1;
const PROBE_TIMEOUT_MS = 8_000;
/** The check that a server address is public (icons.ts). Tests swap it, since they can't look names up. */
export const mediaServerNet = { assertPublic: assertPublicHost };

export const PLEX_UNREACHABLE =
  "Athena can't reach your Plex server from the internet. In Plex, open Settings, then Remote Access, and check it says Fully accessible outside your network.";

/** The token from what was pasted: the token itself, or an address with X-Plex-Token= in it. */
export function plexToken(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const inUrl = /[?&]X-Plex-Token=([A-Za-z0-9_-]{8,64})/.exec(v);
  if (inUrl) return inUrl[1];
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined;
}

function refused(status: number): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("plex", 401, "Plex didn't accept that key. Copy the View XML address again and paste it.", true);
  if (status === 429) return new LifeApiError("plex", 429, "Plex is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 300 && status < 400) return new LifeApiError("plex", 502, PLEX_UNREACHABLE, true);
  if (status >= 500) return new LifeApiError("plex", status, "Plex is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("plex", status, `Plex refused that (${status})`);
}

const headers = (token: string, clientId: string) => ({
  "X-Plex-Token": token,
  "X-Plex-Client-Identifier": clientId,
  "X-Plex-Product": "Athena",
});

interface Resource {
  name?: string;
  provides?: string;
  owned?: boolean;
  clientIdentifier?: string;
  accessToken?: string;
  connections?: Array<{ protocol?: string; uri?: string; local?: boolean; relay?: boolean }>;
}

export interface PlexServer {
  name: string;
  machineId: string;
  uri: string;
  token: string;
  relay: boolean;
}

/** Can Athena read this server address? A quick, single GET of /identity. */
async function answers(uri: string, token: string, clientId: string): Promise<boolean> {
  try {
    await mediaServerNet.assertPublic(new URL(uri));
    const res = await publicFetch(`${uri}/identity`, { method: "GET", headers: { Accept: "application/json", ...headers(token, clientId) }, redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The owner's first Plex server that answers from the internet: direct https first, then Plex's relay. */
export async function findPlexServer(token: string, clientId: string): Promise<PlexServer> {
  const list = await getJson<Resource[]>(`${PLEX_DIRECTORY_URL}/api/v2/resources?includeHttps=1&includeRelay=1`, {
    service: "plex",
    hosts: [new URL(PLEX_DIRECTORY_URL).hostname],
    headers: headers(token, clientId),
    refused,
    unreachable: "Couldn't reach Plex",
  });
  const servers = (Array.isArray(list) ? list : []).filter((r) => r.owned && (r.provides ?? "").split(",").includes("server"));
  if (!servers.length) throw new LifeApiError("plex", 404, "This Plex account has no server of its own. Sign in to Plex as the account that owns the server, then copy its key.", true);
  for (const relay of [false, true]) {
    for (const s of servers) {
      const tok = s.accessToken || token;
      for (const c of s.connections ?? []) {
        if (c.local || !!c.relay !== relay || c.protocol !== "https" || !c.uri?.startsWith("https://")) continue;
        if (await answers(c.uri, tok, clientId)) return { name: s.name ?? "Plex", machineId: s.clientIdentifier ?? "", uri: c.uri.replace(/\/+$/, ""), token: tok, relay };
      }
    }
  }
  throw new LifeApiError("plex", 503, PLEX_UNREACHABLE, true);
}

export interface PlexContext {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
  server: Pick<PlexServer, "name" | "machineId">;
  tz: string;
}

interface Played {
  ratingKey?: string;
  grandparentRatingKey?: string;
  /** "/library/metadata/123": the show, when grandparentRatingKey isn't sent. */
  grandparentKey?: string;
  type?: string;
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
  originallyAvailableAt?: string;
  viewedAt?: number;
  accountID?: number;
}

const detailsLink = (machineId: string, key: string | undefined) =>
  machineId && key ? `https://app.plex.tv/desktop/#!/server/${machineId}/details?key=${encodeURIComponent(`/library/metadata/${key}`)}` : undefined;

/** One play as compact JSON: a film, or an episode with its show, in the owner's local day and time. */
export function plexItem(p: Played, machineId: string, tz: string): Record<string, unknown> | null {
  if (!p.viewedAt) return null;
  const at = when(p.viewedAt * 1000, tz);
  const year = p.year ?? (Number(/^(\d{4})-/.exec(p.originallyAvailableAt ?? "")?.[1]) || undefined);
  const show = p.grandparentRatingKey ?? /\/library\/metadata\/(\d+)$/.exec(p.grandparentKey ?? "")?.[1];
  if (p.type === "movie")
    return clean({ kind: "film", title: p.title, year, ...at, id: p.ratingKey, link: detailsLink(machineId, p.ratingKey) });
  if (p.type === "episode")
    return clean({
      kind: "episode",
      show: p.grandparentTitle,
      season: p.parentIndex,
      episode: p.index,
      title: p.title,
      ...at,
      show_id: show,
      link: detailsLink(machineId, p.ratingKey),
      show_link: detailsLink(machineId, show),
    });
  return null;
}

async function watchHistory(ctx: PlexContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 50 });
  const offset = decodeCursor<number>("plex:history", args.cursor) ?? 0;
  const body = await ctx.get<{ MediaContainer?: { size?: number; totalSize?: number; Metadata?: Played[] } }>("/status/sessions/history/all", {
    sort: "viewedAt:desc",
    accountID: PLEX_OWNER_ACCOUNT,
    "viewedAt>": w.after === undefined ? undefined : Math.ceil(w.after / 1000),
    "viewedAt<": w.before === undefined ? undefined : Math.ceil(w.before / 1000) - 1,
    "X-Plex-Container-Start": offset,
    "X-Plex-Container-Size": limit,
  });
  const rows = body.MediaContainer?.Metadata ?? [];
  const total = body.MediaContainer?.totalSize;
  const items = rows.map((r) => plexItem(r, ctx.server.machineId, ctx.tz)).filter((x): x is Record<string, unknown> => !!x);
  const more = total !== undefined ? offset + rows.length < total : rows.length === limit;
  return withItems(items, {
    count: items.length,
    films: items.filter((i) => i.kind === "film").length,
    episodes: items.filter((i) => i.kind === "episode").length,
    server: ctx.server.name,
    next_cursor: more && rows.length ? encodeCursor("plex:history", offset + rows.length) : undefined,
  });
}

export const PLEX_TOOLS: LifeTool<PlexContext>[] = [
  {
    name: "watch_history",
    summary: "See what you've watched",
    description:
      "What the owner watched on their Plex server, newest first: each film with its year, each episode with its show, season, number and title, the owner's local date and time it was watched, and a link. Only the server owner's own viewing; music is left out. Films and shows belong in Watch & read: film external_id is id, a show's is show_id, source plex. Filter with date (one local day) or after/before; page with next_cursor.",
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, limit: { type: "integer", minimum: 1, maximum: 100 }, ...CURSOR_PROP } },
    annotations: readOnly,
    run: watchHistory,
  },
];

/** Open the account: find the owner's server through plex.tv, which proves the token works, and keep its address for the tools. */
export async function openPlex(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const token = plexToken(secrets.token);
  if (!token) throw new LifeApiError("plex", 401, "Paste your Plex key under Edit.", true);
  const clientId = `athena-${connector.id}`;
  const [server, zone] = await Promise.all([findPlexServer(token, clientId), tz ? Promise.resolve(tz) : ownerZone()]);
  const host = new URL(server.uri).hostname;
  const get = <T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> => {
    const url = new URL(`${server.uri}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return getJson<T>(url.toString(), { service: "plex", hosts: [host], headers: headers(server.token, clientId), refused, redirect: "manual", unreachable: PLEX_UNREACHABLE });
  };
  return account("plex", PLEX_TOOLS, { get, server, tz: zone });
}

export const plexAdapter: DirectAdapter = {
  backfill: plexBackfill,
  recent: plexRecent,
  id: "plex",
  handles: (c) => c.provider === "plex" && c.auth_type === "token",
  tools: () => PLEX_TOOLS,
  serverInfo: () => ({ website_url: "https://www.plex.tv/" }),
  open: (connector, secrets) => openPlex(connector, secrets),
  accountProblem: (e) => lifeAccountProblem("plex", e),
  failure: (e) => lifeFailure("plex", e),
};
