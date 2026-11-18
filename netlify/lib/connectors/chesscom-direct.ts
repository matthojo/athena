/**
 * Chess.com without MCP: a narrow, read-only adapter over Chess.com's public
 * API (api.chess.com/pub), registered in direct.ts.
 *
 * Why not MCP: Chess.com runs no MCP server, and the games are public, so the
 * account is just the owner's username (auth_type "none"; the URL Athena keeps
 * is their profile, chess.com/member/<name>). Reads: /pub/player/<name>
 * (proves it's there), its monthly archive list, and the months the window
 * touches. GETs only.
 *
 * Chess.com files games by the month they ended and dates them by end_time,
 * so that's the time the window and the owner's local date use. The rating
 * on a game is the owner's rating after it; Chess.com doesn't give the change.
 */
import type { Connector } from "../../../lib/connectors";
import { CHESSCOM_HOSTS } from "../../../lib/presets/media-travel";
import { arg, clean } from "./google-api";
import type { DirectAccount, DirectAdapter } from "./direct";
import { chessSummary, chessTool, chessUsername, clockText, type ChessGame, type ChessResult } from "./lichess-direct";
import {
  LifeApiError,
  account,
  decodeCursor,
  encodeCursor,
  getJson,
  inWindow,
  lifeAccountProblem,
  lifeFailure,
  ownerZone,
  when,
  windowOf,
  withItems,
  type LifeTool,
} from "./lifelog-b-http";
import { chesscomRecent } from "./activity-recent";

export const CHESSCOM_API_URL = "https://api.chess.com/pub";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
/** Months read in one call at most; the cursor picks up from there. */
const MAX_MONTHS = 6;

/** The profile address Athena keeps, from a username or a chess.com link. */
export function chesscomAddress(raw: string): string {
  return `https://www.chess.com/member/${chessUsername(raw, CHESSCOM_HOSTS, /^\/(member|stats\/[a-z]+\/[a-z]+)\//i, "Chess.com", NAME).toLowerCase()}`;
}

function refused(status: number): LifeApiError {
  if (status === 404 || status === 410) return new LifeApiError("chesscom", 404, "Chess.com can't find that username. Check the spelling.", true);
  if (status === 401 || status === 403) return new LifeApiError("chesscom", 401, "Chess.com refused Athena. Try again later; if it keeps happening, remove and add the account again.", true);
  if (status === 429) return new LifeApiError("chesscom", 429, "Chess.com is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("chesscom", status, "Chess.com is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("chesscom", status, `Chess.com refused that (${status})`);
}

const get = <T>(path: string): Promise<T> =>
  getJson<T>(`${CHESSCOM_API_URL}${path}`, {
    service: "chesscom",
    hosts: ["api.chess.com"],
    // Chess.com asks API clients to name themselves.
    headers: { "User-Agent": "Athena personal life log (read-only)" },
    refused,
    unreachable: "Couldn't reach Chess.com",
  });

interface Side {
  username?: string;
  rating?: number;
  result?: string;
}
interface Game {
  url?: string;
  time_control?: string;
  end_time?: number;
  rated?: boolean;
  time_class?: string;
  rules?: string;
  white?: Side;
  black?: Side;
}

const DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

/** "180+2" → "3+2", "600" → "10+0", "1/86400" → "1 day per move". */
export function chesscomClock(tc: string | undefined): string | undefined {
  if (!tc) return undefined;
  const daily = /^1\/(\d+)$/.exec(tc);
  if (daily) {
    const days = Math.round(Number(daily[1]) / 86_400);
    return `${days} day${days === 1 ? "" : "s"} per move`;
  }
  const live = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  return live ? clockText(Number(live[1]), Number(live[2] ?? 0)) : tc;
}

/** One Chess.com game from the owner's side; null when they weren't in it. */
export function chesscomGame(g: Game, me: string, tz: string): ChessGame | null {
  const colour = g.white?.username?.toLowerCase() === me ? "white" : g.black?.username?.toLowerCase() === me ? "black" : null;
  if (!colour || !g.end_time) return null;
  const mine = colour === "white" ? g.white! : g.black!;
  const theirs = colour === "white" ? g.black : g.white;
  const result: ChessResult = mine.result === "win" ? "win" : DRAWS.has(mine.result ?? "") ? "draw" : "loss";
  return clean({
    ...when(g.end_time * 1000, tz),
    opponent: theirs?.username,
    opponent_rating: theirs?.rating,
    colour,
    result,
    time_control: chesscomClock(g.time_control),
    speed: g.time_class,
    variant: g.rules && g.rules !== "chess" ? g.rules : undefined,
    rated: g.rated,
    rating_after: mine.rating,
    link: g.url?.startsWith("https://") ? g.url : undefined,
  }) as unknown as ChessGame;
}

export interface ChesscomContext {
  username: string;
  tz: string;
}

/** "YYYY/MM" for the month an epoch ms falls in, in UTC (how Chess.com files them). */
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7).replace("-", "/");

async function listGames(ctx: ChesscomContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 50 });
  const cursor = decodeCursor<{ m: string; i: number }>("chesscom:games", args.cursor);
  const { archives = [] } = await get<{ archives?: string[] }>(`/player/${encodeURIComponent(ctx.username)}/games/archives`);
  // Newest month first, only the months the window touches.
  const months = archives
    .map((a) => /\/games\/(\d{4}\/\d{2})$/.exec(a)?.[1])
    .filter((m): m is string => !!m)
    .filter((m) => (w.after === undefined || m >= monthOf(w.after)) && (w.before === undefined || m <= monthOf(w.before - 1)) && (!cursor || m <= cursor.m))
    .sort()
    .reverse();
  const out: ChessGame[] = [];
  let next: { m: string; i: number } | undefined;
  for (let n = 0; n < months.length; n++) {
    const m = months[n];
    if (n === MAX_MONTHS) {
      next = { m, i: 0 };
      break;
    }
    const { games = [] } = await get<{ games?: Game[] }>(`/player/${encodeURIComponent(ctx.username)}/games/${m}`);
    const kept = games
      .filter((g) => g.end_time && inWindow(g.end_time * 1000, w))
      .sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0))
      .map((g) => chesscomGame(g, ctx.username, ctx.tz))
      .filter((g): g is ChessGame => !!g);
    const from = cursor && m === cursor.m ? cursor.i : 0;
    const room = limit - out.length;
    out.push(...kept.slice(from, from + room));
    if (from + room < kept.length) {
      next = { m, i: from + room };
      break;
    }
    if (out.length === limit) {
      if (n + 1 < months.length) next = { m: months[n + 1], i: 0 };
      break;
    }
  }
  return withItems(out, { count: out.length, summary: chessSummary(out), username: ctx.username, next_cursor: next ? encodeCursor("chesscom:games", next) : undefined });
}

export const CHESSCOM_TOOLS: LifeTool<ChesscomContext>[] = [chessTool("Chess.com", listGames, " Chess.com dates a game by when it ended.")];

/** Open the account: the player's profile proves the username exists. */
export async function openChesscom(connector: Pick<Connector, "url">, tz?: string): Promise<DirectAccount> {
  let username: string;
  try {
    username = new URL(chesscomAddress(connector.url)).pathname.split("/").pop()!;
  } catch (error) {
    throw new LifeApiError("chesscom", 400, (error as Error).message, true);
  }
  const [player, zone] = await Promise.all([get<{ username?: string; status?: string }>(`/player/${encodeURIComponent(username)}`), tz ? Promise.resolve(tz) : ownerZone()]);
  if (player.status?.startsWith("closed")) throw new LifeApiError("chesscom", 404, "That Chess.com account is closed. Use the one you play on now.", true);
  return account("chesscom", CHESSCOM_TOOLS, { username: (player.username ?? username).toLowerCase(), tz: zone });
}

export const chesscomAdapter: DirectAdapter = {
  id: "chesscom",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: chesscomRecent,
  handles: (c) => c.provider === "chesscom" && c.auth_type === "none",
  tools: () => CHESSCOM_TOOLS,
  serverInfo: () => ({ website_url: "https://www.chess.com/" }),
  open: (connector) => openChesscom(connector),
  checkAddress: chesscomAddress,
  accountProblem: (e) => lifeAccountProblem("chesscom", e),
  failure: (e) => lifeFailure("chesscom", e),
};
