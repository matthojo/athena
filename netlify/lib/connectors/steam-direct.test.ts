// Run: npx tsx --test netlify/lib/connectors/steam-direct.test.ts
// Steam, with fetch stubbed and recorded replies (shapes as api.steampowered.com returned them, trimmed).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { openSteam, steamAdapter, steamProfile } from "./steam-direct";

type Reply = { status?: number; body: unknown; raw?: string };
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
    for (const r of routes) {
      const reply = r(url);
      if (reply) return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": reply.raw ? "text/html" : "application/json" } });
    }
    throw new Error(`No fixture for ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const at = (p: string, body: unknown, status = 200) => (url: URL) => (url.pathname === p ? { status, body } : undefined);
const connector = (url = "https://steamcommunity.com/id/jordanplays/") => ({ id: "c4", name: "Steam", provider: "steam", auth_type: "token", url, scope: "" }) as Connector;
const secrets: ConnectorSecrets = { token: "ABCDEF0123456789ABCDEF0123456789" };
const SID = "76561197960287930";

const RESOLVE = at("/ISteamUser/ResolveVanityURL/v1/", { response: { steamid: SID, success: 1 } });
const SUMMARY = at("/ISteamUser/GetPlayerSummaries/v2/", { response: { players: [{ steamid: SID, personaname: "jordan", communityvisibilitystate: 3 }] } });
// 6 Nov 2026 20:00 UTC; 2 Nov 2026 18:00 UTC; 2024.
const OWNED = at("/IPlayerService/GetOwnedGames/v1/", {
  response: {
    game_count: 3,
    games: [
      { appid: 1145360, name: "Hades", playtime_forever: 3120, playtime_2weeks: 95, rtime_last_played: 1793995200 },
      { appid: 413150, name: "Stardew Valley", playtime_forever: 9000, playtime_2weeks: 40, rtime_last_played: 1793642400 },
      { appid: 620, name: "Portal 2", playtime_forever: 600, rtime_last_played: 1700000000 },
    ],
  },
});
const RECENT = at("/IPlayerService/GetRecentlyPlayedGames/v1/", {
  response: {
    total_count: 2,
    games: [
      { appid: 1145360, name: "Hades", playtime_2weeks: 95, playtime_forever: 3120 },
      { appid: 413150, name: "Stardew Valley", playtime_2weeks: 40, playtime_forever: 9000 },
    ],
  },
});

test("presets: Steam sits in Entertainment with a profile address hint, and says private profiles return nothing", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "steam")!;
  assert.equal(p.category, "entertainment");
  assert.equal(p.url, "");
  assert.equal(p.urlHint, "https://steamcommunity.com/id/yourname");
  assert.match(p.help, /Steam shows nothing for a private profile/);
  for (const t of steamAdapter.tools(connector())) assert.equal(classifyTool("steam", t.name, t.annotations), "read");
  assert.equal(directFor(connector()), steamAdapter);
});

test("the profile address: steamcommunity.com only, as a vanity name or a SteamID", () => {
  assert.deepEqual(steamProfile("https://steamcommunity.com/id/jordanplays/"), { vanity: "jordanplays" });
  assert.deepEqual(steamProfile(`https://steamcommunity.com/profiles/${SID}`), { steamid: SID });
  for (const bad of ["https://steamcommunity.com.evil.example/id/x", "https://store.steampowered.com/app/620", "https://steamcommunity.com/groups/x", "http://steamcommunity.com/id/x", "https://steamcommunity.com/profiles/123"]) {
    assert.throws(() => steamProfile(bad), /isn't a Steam profile address/, bad);
  }
});

test("a bad address is refused before the key leaves Athena", async () => {
  const err = await openSteam(connector("https://evil.example/id/jordanplays"), secrets, "UTC").catch((e) => e);
  assert.equal(calls.length, 0);
  assert.equal(directFailure(err)?.status, "needs_auth");
});

test("recently_played: two-week minutes, total hours, local last-played, store links", async () => {
  routes = [RESOLVE, SUMMARY, RECENT, OWNED];
  const acct = await openSteam(connector(), secrets, "Europe/London");
  const r = await acct.call("recently_played", {});
  const out = JSON.parse(r.text);
  assert.deepEqual(out.items[0], { game: "Hades", minutes_last_2_weeks: 95, hours_total: 52, last_played_date: "2026-11-06", last_played_time: "20:00", link: "https://store.steampowered.com/app/1145360" });
  assert.equal(out.minutes_last_2_weeks, 135);
  assert.doesNotMatch(r.text, /ABCDEF/);
  assert.equal(calls[0].searchParams.get("vanityurl"), "jordanplays");
  assert.ok(calls.every((c) => c.hostname === "api.steampowered.com"));
});

test("played_games: a window on last played, newest first, paged", async () => {
  routes = [SUMMARY, OWNED];
  const acct = await openSteam(connector(`https://steamcommunity.com/profiles/${SID}`), secrets, "UTC");
  const out = JSON.parse((await acct.call("played_games", { after: "2026-11-01", limit: 1 })).text);
  assert.deepEqual(out.items.map((i: { game: string }) => i.game), ["Hades"]);
  assert.equal(out.count, 2);
  assert.equal(out.games_owned, 3);
  const next = JSON.parse((await acct.call("played_games", { after: "2026-11-01", limit: 1, cursor: out.next_cursor })).text);
  assert.deepEqual(next.items.map((i: { game: string }) => i.game), ["Stardew Valley"]);
  assert.equal(next.next_cursor, undefined);
  const day = JSON.parse((await acct.call("played_games", { date: "2026-11-02" })).text);
  assert.deepEqual(day.items.map((i: { game: string }) => i.game), ["Stardew Valley"]);
});

test("a private profile is marked private, not reported as nothing played", async () => {
  routes = [RESOLVE, SUMMARY, at("/IPlayerService/GetRecentlyPlayedGames/v1/", { response: {} }), at("/IPlayerService/GetOwnedGames/v1/", { response: {} })];
  const acct = await openSteam(connector(), secrets, "UTC");
  for (const tool of ["recently_played", "played_games"]) {
    const out = JSON.parse((await acct.call(tool, {})).text);
    assert.equal(out.private, true, tool);
    assert.deepEqual(out.items, []);
    assert.match(out.note, /private/);
  }
});

test("a refused key is needs_auth; an unknown vanity name says so", async () => {
  routes = [(url) => (url.pathname.startsWith("/ISteamUser/") ? { status: 403, body: null, raw: "<html><head><title>Forbidden</title></head></html>" } : undefined)];
  const err = await openSteam(connector(), secrets, "UTC").catch((e) => e);
  assert.equal(steamAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Steam didn't accept the API key. Check it at steamcommunity.com/dev/apikey, then paste it under Edit." });

  routes = [at("/ISteamUser/ResolveVanityURL/v1/", { response: { success: 42, message: "No match" } })];
  const missing = await openSteam(connector(), secrets, "UTC").catch((e) => e);
  assert.match(directFailure(missing)!.detail, /can't find that profile/);
});

test("a Life log run reads it: allowed tools listed and called, a disallowed one left out", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  routes = [RESOLVE, SUMMARY, RECENT, OWNED];
  const c = { ...connector(), allowed_tools: ["played_games"] } as Connector;
  const open = { connector: c, direct: await openSteam(c, secrets, "UTC"), close: async () => undefined };
  assert.deepEqual((await listAllowedTools(open)).map((t) => t.name), ["played_games"]);
  const r = await callTool(open, "played_games", { date: "2026-11-06" });
  assert.deepEqual(JSON.parse(r.text).items.map((i: { game: string }) => i.game), ["Hades"]);
});
