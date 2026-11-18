// Run: npx tsx --test netlify/lib/connectors/chess-direct.test.ts
// Lichess and Chess.com, with fetch stubbed and the replies recorded from both public APIs (fixtures/chess-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { chessSummary, lichessAddress, lichessAdapter, lichessGame, openLichess } from "./lichess-direct";
import { chesscomAddress, chesscomAdapter, chesscomClock, openChesscom } from "./chesscom-direct";
import { CHESSCOM_2026_10, CHESSCOM_2026_11, CHESSCOM_ARCHIVES, CHESSCOM_PLAYER, LICHESS_GAMES_NDJSON, LICHESS_USER } from "./fixtures/chess-recorded";

type Reply = { status?: number; body?: unknown; raw?: string };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL) => Reply | undefined> = [];
let calls: URL[] = [];

beforeEach(() => {
  calls = [];
  routes = [];
  lifeRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(init.method, "GET");
    assert.match(String((init.headers as Record<string, string>)["User-Agent"]), /Athena/);
    for (const r of routes) {
      const reply = r(url);
      if (reply) return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }
    throw new Error(`No fixture for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const at = (host: string, p: string, body: unknown, status = 200) => (url: URL) => (url.hostname === host && url.pathname === p ? { status, body } : undefined);

/** Lichess's games export as the server answers it: since/until on createdAt, newest first, max. */
const LICHESS_GAMES = (url: URL): Reply | undefined => {
  if (url.hostname !== "lichess.org" || url.pathname !== "/api/games/user/thibault") return undefined;
  const since = Number(url.searchParams.get("since") ?? 0);
  const until = Number(url.searchParams.get("until") ?? Infinity);
  const max = Number(url.searchParams.get("max") ?? Infinity);
  const lines = LICHESS_GAMES_NDJSON.trim()
    .split("\n")
    .filter((l) => {
      const c = (JSON.parse(l) as { createdAt: number }).createdAt;
      return c >= since && c <= until;
    })
    .slice(0, max);
  return { raw: lines.join("\n") + "\n" };
};
const LICHESS_ROUTES = [at("lichess.org", "/api/user/thibault", LICHESS_USER), LICHESS_GAMES];
const lichess = (url = "https://lichess.org/@/thibault") => ({ id: "c1", name: "Lichess", provider: "lichess", auth_type: "none", url, scope: "" }) as Connector;
const chesscom = (url = "https://www.chess.com/member/hikaru") => ({ id: "c2", name: "Chess.com", provider: "chesscom", auth_type: "none", url, scope: "" }) as Connector;
const CHESSCOM_ROUTES = [
  at("api.chess.com", "/pub/player/hikaru", CHESSCOM_PLAYER),
  at("api.chess.com", "/pub/player/hikaru/games/archives", CHESSCOM_ARCHIVES),
  at("api.chess.com", "/pub/player/hikaru/games/2026/10", CHESSCOM_2026_10),
  at("api.chess.com", "/pub/player/hikaru/games/2026/11", CHESSCOM_2026_11),
];

test("presets: both chess services sit in Entertainment, ask for a username only, and read", () => {
  for (const id of ["lichess", "chesscom"]) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id)!;
    assert.equal(p.category, "entertainment");
    assert.equal(p.auth, "none");
    assert.equal(p.address?.label, "Username");
    assert.equal(p.address?.text, true);
  }
  for (const t of lichessAdapter.tools(lichess())) assert.equal(classifyTool("lichess", t.name, t.annotations), "read");
  for (const t of chesscomAdapter.tools(chesscom())) assert.equal(classifyTool("chesscom", t.name, t.annotations), "read");
  assert.equal(directFor(lichess()), lichessAdapter);
  assert.equal(directFor(chesscom()), chesscomAdapter);
});

test("a username, an @name or a profile link becomes the profile address; anything else is refused before a request", () => {
  for (const v of ["thibault", " @thibault ", "https://lichess.org/@/thibault", "lichess.org/@/thibault/all"]) assert.equal(lichessAddress(v), "https://lichess.org/@/thibault", v);
  for (const v of ["Hikaru", "https://www.chess.com/member/Hikaru", "chess.com/member/hikaru", "https://www.chess.com/stats/live/blitz/hikaru"]) assert.equal(chesscomAddress(v), "https://www.chess.com/member/hikaru", v);
  for (const bad of ["", "a", "https://evil.example/@/thibault", "has space", "https://lichess.org.evil.example/@/x"]) assert.throws(() => lichessAddress(bad), /isn't a Lichess/, bad);
  assert.throws(() => chesscomAddress("https://lichess.org/@/x"), /isn't a Chess.com address/);
  assert.equal(calls.length, 0);
});

test("Lichess list_games: one local day, owner's side, rating after, Life log line", async () => {
  routes = LICHESS_ROUTES;
  const acct = await openLichess(lichess(), "Europe/London");
  const r = JSON.parse((await acct.call("list_games", { date: "2026-11-06" })).text);
  assert.deepEqual(r.items, [
    {
      date: "2026-11-06",
      time: "19:47",
      at: "2026-11-06T19:47:23Z",
      opponent: "grandchecker",
      opponent_rating: 1710,
      colour: "white",
      result: "win",
      time_control: "5+3",
      speed: "blitz",
      rated: true,
      rating_after: 1750,
      rating_change: 6,
      link: "https://lichess.org/h7BRAh6C",
    },
  ]);
  assert.deepEqual(r.summary, { games: 1, wins: 1, losses: 0, draws: 0, rating: 1750, rating_speed: "blitz", line: "Chess: 1 game, 1 win, rating 1750" });
  // The day went to Lichess as since/until in ms; no move lists asked for.
  const q = calls.find((u) => u.pathname.startsWith("/api/games/"))!.searchParams;
  assert.equal(q.get("since"), String(Date.parse("2026-11-06T00:00:00Z")));
  assert.equal(q.get("moves"), "false");
});

test("Lichess paging: next_cursor walks back through the window without repeats", async () => {
  routes = LICHESS_ROUTES;
  const acct = await openLichess(lichess(), "UTC");
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = JSON.parse((await acct.call("list_games", { after: "2026-10-20", before: "2026-11-07", limit: 2, cursor })).text);
    seen.push(...r.items.map((g: { link: string }) => g.link.split("/")[3]));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["h7BRAh6C", "PE5PRUAJ", "k8OVq8Y5", "aDN8u0zd", "QgBb1l8L", "fPQMtU5T"]);
  assert.equal(cursor, undefined);
});

test("results from the owner's side: draws, losses, black, the computer, aborted games left out", () => {
  const base = { createdAt: Date.parse("2026-11-06T10:00:00Z"), rated: false, speed: "rapid", clock: { initial: 600, increment: 0 } };
  const me = { user: { id: "jordan", name: "Jordan" }, rating: 1500, ratingDiff: -8 };
  assert.equal(lichessGame({ ...base, status: "draw", players: { white: me, black: { aiLevel: 3 } } }, "jordan", "UTC")!.result, "draw");
  const lost = lichessGame({ ...base, id: "x", status: "mate", winner: "white", players: { white: { aiLevel: 3 }, black: me } }, "jordan", "UTC")!;
  assert.deepEqual([lost.result, lost.colour, lost.opponent, lost.rating_after, lost.time_control, lost.link], ["loss", "black", "Stockfish level 3", 1492, "10+0", "https://lichess.org/x/black"]);
  assert.equal(lichessGame({ ...base, status: "aborted", players: { white: me } }, "jordan", "UTC"), null);
  assert.equal(lichessGame({ ...base, status: "mate", winner: "white", players: { white: { user: { id: "someone" } } } }, "jordan", "UTC"), null);
  assert.equal(chessSummary([]).line, undefined);
  assert.equal(chesscomClock("1/86400"), "1 day per move");
  assert.equal(chesscomClock("180+2"), "3+2");
  assert.equal(chesscomClock("600"), "10+0");
});

test("Lichess: an unknown username needs the owner; a 429 is a passing error, not a sign-in problem", async () => {
  routes = [at("lichess.org", "/api/user/thibault", { error: "Not found" }, 404)];
  const err = await openLichess(lichess(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Lichess can't find that username. Check the spelling." });
  routes = [at("lichess.org", "/api/user/thibault", LICHESS_USER), (u) => (u.pathname.startsWith("/api/games/") ? { status: 429, raw: "" } : undefined)];
  const acct = await openLichess(lichess(), "UTC");
  const r = await acct.call("list_games", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /asked Athena to slow down/);
});

test("Chess.com list_games: only the months the window touches, by end time, owner's side", async () => {
  routes = CHESSCOM_ROUTES;
  const acct = await openChesscom(chesscom(), "Europe/London");
  const r = JSON.parse((await acct.call("list_games", { date: "2026-11-06" })).text);
  assert.equal(r.count, 5);
  assert.deepEqual(r.items[0], {
    date: "2026-11-06",
    time: "18:48",
    at: "2026-11-06T18:48:10Z",
    opponent: "only_strong_moves",
    opponent_rating: 3066,
    colour: "black",
    result: "win",
    time_control: "3+0",
    speed: "blitz",
    rated: true,
    rating_after: 3465,
    link: "https://www.chess.com/game/live/186672000482",
  });
  assert.deepEqual(r.summary, { games: 5, wins: 5, losses: 0, draws: 0, rating: 3465, rating_speed: "blitz", line: "Chess: 5 games, 5 wins, rating 3465" });
  assert.ok(!calls.some((u) => u.pathname.endsWith("/2026/10") || u.pathname.endsWith("/2026/09")), "October and September aren't read for a November day");
});

test("Chess.com paging: across a month boundary, newest first, no repeats", async () => {
  routes = CHESSCOM_ROUTES;
  const acct = await openChesscom(chesscom(), "UTC");
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 6; i++) {
    const r = JSON.parse((await acct.call("list_games", { after: "2026-10-31", before: "2026-11-07", limit: 3, cursor })).text);
    seen.push(...r.items.map((g: { at: string }) => g.at));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 8);
  assert.deepEqual([...seen].sort().reverse(), seen);
  assert.equal(new Set(seen).size, 8);
  assert.equal(seen[7], "2026-10-31T19:29:21Z");
});

test("Chess.com: an unknown username needs the owner", async () => {
  routes = [at("api.chess.com", "/pub/player/hikaru", { code: 0, message: 'User "hikaru" not found.' }, 404)];
  const err = await openChesscom(chesscom(), "UTC").catch((e) => e);
  assert.equal(chesscomAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Chess.com can't find that username. Check the spelling." });
});

test("a Life log run reads both: allowed tools listed and called through mcp-client", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  routes = [...LICHESS_ROUTES, ...CHESSCOM_ROUTES];
  const c1 = { ...lichess(), allowed_tools: ["list_games"] } as Connector;
  const open1 = { connector: c1, direct: await openLichess(c1, "UTC"), close: async () => undefined };
  assert.deepEqual((await listAllowedTools(open1)).map((t) => t.name), ["list_games"]);
  assert.equal(JSON.parse((await callTool(open1, "list_games", { date: "2026-11-05" })).text).summary.line, "Chess: 1 game, 1 win, rating 1807");
  const c2 = { ...chesscom(), allowed_tools: [] } as Connector;
  const open2 = { connector: c2, direct: await openChesscom(c2, "UTC"), close: async () => undefined };
  assert.deepEqual(await listAllowedTools(open2), []);
});
