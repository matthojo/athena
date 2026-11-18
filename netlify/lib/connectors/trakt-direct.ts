/**
 * Trakt without MCP: a read-only adapter over Trakt's own API, registered
 * in direct.ts. Trakt publishes no MCP server of its own (the ones listed in
 * MCP directories are third-party, and run locally or by someone else), so
 * Athena calls api.trakt.tv itself with the owner's own Trakt app (PKCE, no client secret).
 *
 * Tools: what the owner watched (episodes and films), their watchlist, their
 * ratings, and what they've started and paused. GETs only (trakt-api.ts).
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { getOwnerTimeZone } from "../../../lib/db";
import { arg, ToolInputError } from "./google-api";
import type { DirectAdapter } from "./direct";
import {
  compact,
  inWindow,
  lifeAccount,
  limitArg,
  local,
  offsetArg,
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
import { exchangeTraktCode, TRAKT_READ, traktAuthorizationUrl, TraktSession } from "./trakt-api";
import { traktBackfill } from "./trakt-backfill";
import { traktRecent } from "./media-recent";

interface Ids {
  slug?: string;
  trakt?: number;
  imdb?: string;
}
interface Show {
  title?: string;
  year?: number;
  ids?: Ids;
}
interface Episode {
  season?: number;
  number?: number;
  title?: string;
  ids?: Ids;
}
interface Movie {
  title?: string;
  year?: number;
  ids?: Ids;
}
/** One row from /sync/history, /watchlist, /ratings or /playback: the media plus when. */
interface Row {
  type?: string;
  watched_at?: string;
  listed_at?: string;
  rated_at?: string;
  paused_at?: string;
  rating?: number;
  progress?: number;
  show?: Show;
  episode?: Episode;
  movie?: Movie;
  season?: { number?: number };
}

interface Ctx {
  session: Pick<TraktSession, "get">;
  tz: string;
  username: string;
}

const showLink = (s?: Show) => (s?.ids?.slug ? `https://trakt.tv/shows/${s.ids.slug}` : undefined);

/** A row as compact JSON: what it is, with the owner's day and time for `at`. */
export function media(row: Row, at: string | undefined, tz: string): Record<string, unknown> {
  const when = local(at, tz);
  if (row.episode && row.show) {
    const e = row.episode;
    const link = showLink(row.show);
    return compact({
      kind: "episode",
      show: row.show.title,
      season: e.season,
      episode: e.number,
      title: e.title,
      ...when,
      link: link && e.season !== undefined && e.number !== undefined ? `${link}/seasons/${e.season}/episodes/${e.number}` : link,
    });
  }
  if (row.movie) return compact({ kind: "film", title: row.movie.title, year: row.movie.year, ...when, link: row.movie.ids?.slug ? `https://trakt.tv/movies/${row.movie.ids.slug}` : undefined });
  if (row.show) return compact({ kind: row.type === "season" ? "season" : "show", title: row.show.title, year: row.show.year, season: row.season?.number, ...when, link: showLink(row.show) });
  return compact({ kind: row.type ?? "item", ...when });
}

const KIND = ["all", "episodes", "movies"] as const;
const kindProp = { type: { type: "string", enum: [...KIND], description: "episodes, movies or all (default)." } };
const isoOf = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());

function pageArg(args: Record<string, unknown>): number {
  const t = arg.str(args, "page_token", { max: 6 });
  if (t === undefined) return 1;
  if (!/^\d+$/.test(t) || Number(t) < 1) throw new ToolInputError("page_token isn't one Athena gave");
  return Number(t);
}

/**
 * Lists Trakt doesn't sort or filter by date (watchlist, ratings): read up to
 * 500 rows, keep the window, newest first, and page through them here.
 */
async function byDate(ctx: Ctx, path: string, when: (r: Row) => string | undefined, w: Window, args: Record<string, unknown>) {
  const rows: Row[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ctx.session.get<Row[]>(path, { page, limit: 100 });
    rows.push(...(Array.isArray(r.items) ? r.items : []));
    if (page >= r.pageCount) break;
  }
  const kept = rows
    .map((r) => ({ r, at: Date.parse(when(r) ?? "") }))
    .filter((x) => !Number.isNaN(x.at) && inWindow(x.at, w))
    .sort((a, b) => b.at - a.at);
  const limit = limitArg(args);
  const offset = offsetArg(args);
  return { kept, page: kept.slice(offset, offset + limit), next: offset + limit < kept.length ? String(offset + limit) : undefined };
}

const TOOLS: LifeTool<Ctx>[] = [
  {
    name: "list_history",
    description:
      "What the owner watched on Trakt (scrobbled or checked in), newest first: each episode with its show, season, number and title, and each film with its year, the owner's day and time it was watched, and a link. type is episodes, movies or all. after/before bound when it was watched. Rewatches appear once per watch.",
    summary: "See what you've watched",
    inputSchema: windowSchema(kindProp),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const type = arg.oneOf(args, "type", KIND) ?? "all";
      const w = windowArgs(args, ctx.tz);
      const page = pageArg(args);
      const r = await ctx.session.get<Row[]>(type === "all" ? TRAKT_READ.history : TRAKT_READ.historyOf(type), {
        start_at: isoOf(w.after),
        end_at: isoOf(w.before === undefined ? undefined : w.before - 1),
        page,
        limit: limitArg(args),
      });
      const rows = Array.isArray(r.items) ? r.items : [];
      const watched = rows.map((row) => media(row, row.watched_at, ctx.tz));
      return compact({ watched, count: watched.length, episodes: watched.filter((m) => m.kind === "episode").length, films: watched.filter((m) => m.kind === "film").length, next_page_token: r.page < r.pageCount ? String(r.page + 1) : undefined });
    },
  },
  {
    name: "list_watchlist",
    description: "Films and shows on the owner's Trakt watchlist, newest first, with the owner's day they added each (after/before bound that day) and a link.",
    summary: "See your watchlist",
    inputSchema: windowSchema(),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const w = windowArgs(args, ctx.tz);
      const { kept, page, next } = await byDate(ctx, TRAKT_READ.watchlist, (r) => r.listed_at, w, args);
      const items = page.map(({ r }) => media(r, r.listed_at, ctx.tz));
      return compact({ watchlist: items, count: items.length, total_count: kept.length, next_page_token: next });
    },
  },
  {
    name: "list_ratings",
    description: "What the owner rated on Trakt (out of 10), newest first: films, shows, seasons and episodes, with the day they rated it (after/before bound it) and a link.",
    summary: "See what you've rated",
    inputSchema: windowSchema(),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const w = windowArgs(args, ctx.tz);
      const { kept, page, next } = await byDate(ctx, TRAKT_READ.ratings, (r) => r.rated_at, w, args);
      const items = page.map(({ r }) => ({ ...media(r, r.rated_at, ctx.tz), rating: r.rating !== undefined ? `${r.rating}/10` : undefined }));
      return compact({ ratings: items, count: items.length, total_count: kept.length, next_page_token: next });
    },
  },
  {
    name: "list_in_progress",
    description: "Films and episodes the owner started and paused (Trakt's playback progress), newest first: how far in (percent) and the day they paused (after/before bound it).",
    summary: "See what you're partway through",
    inputSchema: windowSchema(kindProp),
    annotations: READ_ONLY,
    async run(ctx, args) {
      const type = arg.oneOf(args, "type", KIND) ?? "all";
      const w = windowArgs(args, ctx.tz);
      const r = await ctx.session.get<Row[]>(type === "all" ? "/sync/playback" : `/sync/playback/${type}`, { start_at: isoOf(w.after), end_at: isoOf(w.before === undefined ? undefined : w.before - 1) });
      const rows = (Array.isArray(r.items) ? r.items : [])
        .map((row) => ({ row, at: Date.parse(row.paused_at ?? "") }))
        .filter((x) => !Number.isNaN(x.at) && inWindow(x.at, w))
        .sort((a, b) => b.at - a.at);
      const limit = limitArg(args);
      const offset = offsetArg(args);
      const items = rows.slice(offset, offset + limit).map(({ row }) => ({ ...media(row, row.paused_at, ctx.tz), progress: row.progress !== undefined ? `${Math.round(row.progress)}%` : undefined }));
      return compact({ in_progress: items, count: items.length, total_count: rows.length, next_page_token: offset + limit < rows.length ? String(offset + limit) : undefined });
    },
  },
];

export function traktTools() {
  return TOOLS.map(({ run: _run, ...t }) => t);
}

/** Open a signed-in account: /users/settings proves the sign-in and the app work, and names the account. */
export async function openTrakt(connector: Connector, secrets: ConnectorSecrets, opts: { tz?: string } = {}) {
  if (!secrets.tokens) throw new ServiceError("trakt", 401, "Not signed in yet", true);
  const session = new TraktSession(connector, secrets);
  const settings = await session.get<{ user?: { username?: string } }>("/users/settings");
  const tz = safeZone(opts.tz ?? (await getOwnerTimeZone().catch(() => undefined)));
  return lifeAccount(TOOLS, { session, tz, username: settings.items.user?.username ?? "" }, traktAccountProblem);
}

const traktAccountProblem = serviceAccountProblem("trakt");

export const traktAdapter: DirectAdapter = {
  id: "trakt",
  handles: (c) => c.provider === "trakt" && c.auth_type === "oauth",
  tools: traktTools,
  serverInfo: () => ({ website_url: "https://trakt.tv" }),
  open: (connector, secrets) => openTrakt(connector, secrets),
  noClientSecret: true,
  authorizationUrl: traktAuthorizationUrl,
  exchangeCode: exchangeTraktCode,
  backfill: traktBackfill,
  recent: traktRecent,
  accountProblem: traktAccountProblem,
  failure: (e) => serviceFailure("trakt", e),
};
