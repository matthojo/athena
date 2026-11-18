/**
 * Lichess without MCP: a narrow, read-only adapter over Lichess's public API
 * (lichess.org/api), registered in direct.ts.
 *
 * Why not MCP: Lichess runs no MCP server, and the games are public, so the
 * account is just the owner's username (auth_type "none"; the URL Athena keeps
 * is their profile, lichess.org/@/<name>). Reads: /api/user/<name> (proves the
 * profile is there) and /api/games/user/<name> (NDJSON, newest first, by the
 * time each game started). GETs only.
 *
 * Also here, shared with chesscom-direct.ts: a game's result from the
 * owner's side, and the window's one line for the Life log
 * ("Chess: 4 games, 3 wins, rating 1520").
 */
import type { Connector } from "../../../lib/connectors";
import { AthenaInputError } from "../../../lib/db";
import { LICHESS_HOSTS } from "../../../lib/presets/media-travel";
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
  lifeAccountProblem,
  lifeFailure,
  lifeRetryWaits,
  ownerZone,
  readOnly,
  when,
  windowOf,
  withItems,
  type LifeService,
  type LifeTool,
} from "./lifelog-b-http";
import { lichessRecent } from "./activity-recent";

export const LICHESS_API_URL = "https://lichess.org";
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- shared with Chess.com ----------

export type ChessResult = "win" | "loss" | "draw";

/** One game, from the owner's side. */
export interface ChessGame {
  date: string;
  time: string;
  at: string;
  opponent?: string;
  opponent_rating?: number;
  colour: "white" | "black";
  result: ChessResult;
  /** "5+3", "10+0", "1 day per move". */
  time_control?: string;
  /** bullet, blitz, rapid, classical, daily or correspondence. */
  speed?: string;
  variant?: string;
  rated?: boolean;
  rating_after?: number;
  rating_change?: number;
  link?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The window's totals and its line for the Life log. The rating is the latest
 * rating after a game, in the speed played most (so blitz, not one odd bullet game).
 */
export function chessSummary(games: ChessGame[]): { games: number; wins: number; losses: number; draws: number; rating?: number; rating_speed?: string; line?: string } {
  const wins = games.filter((g) => g.result === "win").length;
  const losses = games.filter((g) => g.result === "loss").length;
  const draws = games.length - wins - losses;
  if (!games.length) return { games: 0, wins, losses, draws };
  const bySpeed = new Map<string, number>();
  for (const g of games) bySpeed.set(g.speed ?? "", (bySpeed.get(g.speed ?? "") ?? 0) + 1);
  const speed = [...bySpeed.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const latest = [...games].filter((g) => (g.speed ?? "") === speed && g.rating_after !== undefined).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const rating = latest?.rating_after;
  const parts = [`Chess: ${plural(games.length, "game")}`, wins ? plural(wins, "win") : "no wins", ...(rating !== undefined ? [`rating ${rating}`] : [])];
  return clean({ games: games.length, wins, losses, draws, rating, rating_speed: speed || undefined, line: parts.join(", ") }) as ReturnType<typeof chessSummary>;
}

/** A clock as people say it: 300 s + 3 → "5+3", 90 s → "1.5+0". */
export function clockText(initialSeconds: number, increment: number): string {
  const min = initialSeconds / 60;
  return `${Number.isInteger(min) ? min : Number(min.toFixed(2))}+${increment}`;
}

/** The username from what was typed: the name itself, an @name, or a profile address on one of `hosts` (path after `prefix`). */
export function chessUsername(raw: string, hosts: string[], prefix: RegExp, service: string, shape: RegExp): string {
  let v = raw.trim().replace(/^@/, "");
  if (/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//i.test(v)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    } catch {
      throw new AthenaInputError(`That isn't a ${service} username. Type just the name you sign in with.`);
    }
    if (!hosts.includes(url.hostname.toLowerCase())) throw new AthenaInputError(`That isn't a ${service} address. Type just your ${service} username.`);
    v = url.pathname.replace(prefix, "").split("/")[0] ?? "";
  }
  if (!shape.test(v)) throw new AthenaInputError(`That isn't a ${service} username. Type just the name you sign in with.`);
  return v;
}

export function chessTool<C>(service: string, run: LifeTool<C>["run"], extra = ""): LifeTool<C> {
  return {
    name: "list_games",
    summary: "See the games you played",
    description: `The owner's ${service} games, newest first: opponent and their rating, the owner's colour, result (win, loss or draw), time control ("5+3"), speed, whether rated, the owner's rating after the game (and the change, when ${service} gives it), the owner's local date and time, and a link. Plus summary: games, wins, losses, draws, the latest rating in the speed played most, and line, the Life log's one line for the window ("Chess: 4 games, 3 wins, rating 1520"). Filter with date (one local day) or after/before; page with next_cursor, and take summary from the first page only when there's no next_cursor.${extra}`,
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS, limit: { type: "integer", minimum: 1, maximum: 100 }, ...CURSOR_PROP } },
    annotations: readOnly,
    run,
  };
}

// ---------- Lichess ----------

const LICHESS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;

/** The profile address Athena keeps, from a username or a lichess.org link. */
export function lichessAddress(raw: string): string {
  return `${LICHESS_API_URL}/@/${chessUsername(raw, LICHESS_HOSTS, /^\/@\//, "Lichess", LICHESS_NAME)}`;
}

function lichessRefused(status: number): LifeApiError {
  if (status === 404) return new LifeApiError("lichess", 404, "Lichess can't find that username. Check the spelling.", true);
  if (status === 401 || status === 403) return new LifeApiError("lichess", 401, "Lichess refused Athena. Try again later; if it keeps happening, remove and add the account again.", true);
  // Lichess asks clients to wait a whole minute after a 429: no quick retry.
  if (status === 429) return new LifeApiError("lichess", 400, "Lichess asked Athena to slow down. Athena will try again on the next run.");
  if (status >= 500) return new LifeApiError("lichess", status, "Lichess is having trouble right now. Try again in a few minutes.");
  return new LifeApiError("lichess", status, `Lichess refused that (${status})`);
}

const HEADERS = { "User-Agent": "Athena personal life log (read-only)" };

interface LichessPlayer {
  user?: { name?: string; id?: string };
  aiLevel?: number;
  rating?: number;
  ratingDiff?: number;
}
interface LichessGame {
  id?: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  createdAt?: number;
  status?: string;
  winner?: "white" | "black";
  players?: { white?: LichessPlayer; black?: LichessPlayer };
  clock?: { initial?: number; increment?: number };
  daysPerTurn?: number;
}

/** GET NDJSON (one game a line). 5xx and dropped connections are retried. */
async function getNdjson<T>(url: string, service: LifeService, refused: (s: number) => LifeApiError): Promise<T[]> {
  if (new URL(url).hostname !== "lichess.org") throw new Error("Athena only reads from lichess.org");
  for (let attempt = 0; ; ) {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { Accept: "application/x-ndjson", ...HEADERS }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      if (attempt < lifeRetryWaits.ms.length) {
        await new Promise((r) => setTimeout(r, lifeRetryWaits.ms[attempt++]));
        continue;
      }
      throw new LifeApiError(service, 503, "Couldn't reach Lichess");
    }
    if (!res.ok) {
      const e = refused(res.status);
      if (e.retryable && attempt < lifeRetryWaits.ms.length) {
        await new Promise((r) => setTimeout(r, lifeRetryWaits.ms[attempt++]));
        continue;
      }
      throw e;
    }
    const text = await res.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  }
}

/** One Lichess game from the owner's side; null for an aborted game, or one they weren't in. */
export function lichessGame(g: LichessGame, me: string, tz: string): ChessGame | null {
  const white = g.players?.white;
  const black = g.players?.black;
  const colour = white?.user?.id === me ? "white" : black?.user?.id === me ? "black" : null;
  if (!colour || !g.createdAt || g.status === "aborted" || g.status === "noStart" || g.status === "created" || g.status === "started") return null;
  const mine = colour === "white" ? white! : black!;
  const theirs = colour === "white" ? black : white;
  const result: ChessResult = !g.winner ? "draw" : g.winner === colour ? "win" : "loss";
  const at = when(g.createdAt, tz);
  return clean({
    ...at,
    opponent: theirs?.user?.name ?? (theirs?.aiLevel ? `Stockfish level ${theirs.aiLevel}` : undefined),
    opponent_rating: theirs?.rating,
    colour,
    result,
    time_control: g.clock?.initial !== undefined ? clockText(g.clock.initial, g.clock.increment ?? 0) : g.daysPerTurn ? `${plural(g.daysPerTurn, "day")} per move` : undefined,
    speed: g.speed,
    variant: g.variant && g.variant !== "standard" ? g.variant : undefined,
    rated: g.rated,
    rating_after: mine.rating !== undefined ? mine.rating + (mine.ratingDiff ?? 0) : undefined,
    rating_change: mine.ratingDiff,
    link: g.id ? `https://lichess.org/${g.id}${colour === "black" ? "/black" : ""}` : undefined,
  }) as unknown as ChessGame;
}

export interface LichessContext {
  username: string;
  id: string;
  tz: string;
}

async function listGames(ctx: LichessContext, args: Record<string, unknown>) {
  const w = windowOf(args, ctx.tz);
  const limit = arg.int(args, "limit", { min: 1, max: 100, fallback: 50 });
  const until = decodeCursor<number>("lichess:games", args.cursor) ?? (w.before === undefined ? undefined : w.before - 1);
  const url = new URL(`${LICHESS_API_URL}/api/games/user/${encodeURIComponent(ctx.username)}`);
  const params: Record<string, string | number | undefined> = { since: w.after, until, max: limit + 1, moves: "false", pgnInJson: "false", tags: "false", clocks: "false", evals: "false", opening: "false", sort: "dateDesc" };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const raw = await getNdjson<LichessGame>(url.toString(), "lichess", lichessRefused);
  const page = raw.slice(0, limit);
  const games = page.map((g) => lichessGame(g, ctx.id, ctx.tz)).filter((g): g is ChessGame => !!g);
  const last = page[page.length - 1]?.createdAt;
  const next = raw.length > limit && last ? encodeCursor("lichess:games", last - 1) : undefined;
  return withItems(games, { count: games.length, summary: chessSummary(games), username: ctx.username, next_cursor: next });
}

export const LICHESS_TOOLS: LifeTool<LichessContext>[] = [chessTool("Lichess", listGames, " Aborted games are left out.")];

/** Open the account: the profile proves the username exists and isn't closed. */
export async function openLichess(connector: Pick<Connector, "url">, tz?: string): Promise<DirectAccount> {
  let username: string;
  try {
    username = new URL(lichessAddress(connector.url)).pathname.replace(/^\/@\//, "");
  } catch (error) {
    throw new LifeApiError("lichess", 400, (error as Error).message, true);
  }
  const [user, zone] = await Promise.all([
    getJson<{ id?: string; username?: string; disabled?: boolean; closed?: boolean }>(`${LICHESS_API_URL}/api/user/${encodeURIComponent(username)}`, {
      service: "lichess",
      hosts: ["lichess.org"],
      headers: HEADERS,
      refused: lichessRefused,
      unreachable: "Couldn't reach Lichess",
    }),
    tz ? Promise.resolve(tz) : ownerZone(),
  ]);
  if (!user.id || user.disabled || user.closed) throw new LifeApiError("lichess", 404, "That Lichess account is closed. Use the one you play on now.", true);
  return account("lichess", LICHESS_TOOLS, { username: user.username ?? username, id: user.id, tz: zone });
}

export const lichessAdapter: DirectAdapter = {
  id: "lichess",
  /** Your activity: read every hour without a model (activity-recent.ts). */
  recent: lichessRecent,
  handles: (c) => c.provider === "lichess" && c.auth_type === "none",
  tools: () => LICHESS_TOOLS,
  serverInfo: () => ({ website_url: "https://lichess.org/" }),
  open: (connector) => openLichess(connector),
  checkAddress: lichessAddress,
  accountProblem: (e) => lifeAccountProblem("lichess", e),
  failure: (e) => lifeFailure("lichess", e),
};
