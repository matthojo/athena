// Run: npx tsx --test netlify/lib/connectors/lastfm-direct.test.ts
// Last.fm, with fetch stubbed and recorded replies (shapes as ws.audioscrobbler.com returned them, trimmed).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { lastfmAdapter, lastfmUser, openLastfm } from "./lastfm-direct";

type Reply = { status?: number; body: unknown };
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
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${url.searchParams.get("method")}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const method = (m: string, body: unknown | ((url: URL) => unknown), status = 200) => (url: URL) =>
  url.searchParams.get("method") === m ? { status, body: typeof body === "function" ? (body as (u: URL) => unknown)(url) : body } : undefined;
const connector = (url = "https://www.last.fm/user/jordanscrobbles") => ({ id: "c3", name: "Last.fm", provider: "lastfm", auth_type: "token", url, scope: "" }) as Connector;
const secrets: ConnectorSecrets = { token: "k".repeat(32) };

const INFO = { user: { name: "jordanscrobbles", playcount: "48211" } };
const SCROBBLE = (name: string, uts: number) => ({
  name,
  artist: { name: "Khruangbin", url: "https://www.last.fm/music/Khruangbin" },
  album: { "#text": "Mordechai" },
  url: `https://www.last.fm/music/Khruangbin/_/${name}`,
  loved: name === "Time" ? "1" : "0",
  date: { uts: String(uts), "#text": "06 Nov 2026, 19:00" },
});
// 6 Nov 2026 19:00 and 18:55 UTC.
const PAGE = (page: number) => ({
  recenttracks: {
    track: page === 1 ? [{ ...SCROBBLE("So We Won't Forget", 0), date: undefined, "@attr": { nowplaying: "true" } }, SCROBBLE("Time", 1793991600), SCROBBLE("Pelota", 1793991300)] : [SCROBBLE("Connaissais de Face", 1793991000)],
    "@attr": { user: "jordanscrobbles", page: String(page), perPage: "2", totalPages: "2", total: "3" },
  },
});

test("presets: Last.fm sits in Entertainment with a profile address hint and no URL", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "lastfm")!;
  assert.equal(p.category, "entertainment");
  assert.equal(p.url, "");
  assert.equal(p.urlHint, "https://www.last.fm/user/yourname");
  assert.equal(p.auth, "token");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  for (const t of lastfmAdapter.tools(connector())) assert.equal(classifyTool("lastfm", t.name, t.annotations), "read");
  assert.equal(directFor(connector()), lastfmAdapter);
});

test("the profile address: only Last.fm's own domain", () => {
  assert.equal(lastfmUser("https://www.last.fm/user/jordanscrobbles/library"), "jordanscrobbles");
  assert.equal(lastfmUser("https://last.fm/user/Some_One"), "Some_One");
  for (const bad of ["https://www.last.fm.evil.example/user/x", "https://evil.example/user/x", "http://www.last.fm/user/x", "https://www.last.fm/music/Khruangbin", "https://u:p@www.last.fm/user/x"]) {
    assert.throws(() => lastfmUser(bad), /isn't a Last.fm profile address/, bad);
  }
});

test("a bad address is refused before anything is fetched, as needs_auth", async () => {
  const err = await openLastfm(connector("https://open.spotify.com/user/x"), secrets, "UTC").catch((e) => e);
  assert.equal(calls.length, 0);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.match(directFailure(err)!.detail, /Remove this account and add it again/);
});

test("list_scrobbles: one local day, the key sent but never in the output, paging by page", async () => {
  routes = [method("user.getinfo", INFO), method("user.getrecenttracks", (url: URL) => PAGE(Number(url.searchParams.get("page"))))];
  const acct = await openLastfm(connector(), secrets, "Asia/Tokyo");
  const r = await acct.call("list_scrobbles", { date: "2026-11-07" });
  const out = JSON.parse(r.text);
  // Tokyo is UTC+9: 19:00Z on the 6th is 04:00 on the 7th.
  assert.deepEqual(out.items[0], { track: "Time", artist: "Khruangbin", album: "Mordechai", link: "https://www.last.fm/music/Khruangbin/_/Time", loved: true, date: "2026-11-07", time: "04:00", played_at: "2026-11-06T19:00:00Z" });
  assert.equal(out.items.length, 2);
  assert.equal(out.scrobbles, 3);
  assert.deepEqual(out.top_artists, [{ artist: "Khruangbin", plays: 2 }]);
  assert.equal(out.now_playing.track, "So We Won't Forget");
  const q = calls.find((c) => c.searchParams.get("method") === "user.getrecenttracks")!.searchParams;
  assert.equal(q.get("user"), "jordanscrobbles");
  assert.equal(q.get("from"), String(Date.parse("2026-11-06T15:00:00Z") / 1000));
  assert.equal(q.get("to"), String(Date.parse("2026-11-07T15:00:00Z") / 1000 - 1));
  assert.equal(q.get("api_key"), secrets.token);
  assert.doesNotMatch(r.text, /kkkk/);
  const next = JSON.parse((await acct.call("list_scrobbles", { date: "2026-11-07", cursor: out.next_cursor })).text);
  assert.equal(next.items[0].track, "Connaissais de Face");
  assert.equal(next.next_cursor, undefined);
  assert.equal((await acct.call("list_scrobbles", { date: "7 Nov" })).isError, true);
});

test("a refused key is needs_auth; hidden listening says how to fix it", async () => {
  routes = [method("user.getinfo", { error: 10, message: "Invalid API key - You must be granted a valid key by last.fm" }, 403)];
  const err = await openLastfm(connector(), secrets, "UTC").catch((e) => e);
  assert.equal(lastfmAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Last.fm didn't accept the API key. Check it at last.fm/api/accounts, then paste it under Edit." });

  routes = [method("user.getinfo", INFO), method("user.getrecenttracks", { error: 17, message: "Login: User required to be logged in" })];
  const acct = await openLastfm(connector(), secrets, "UTC");
  const hidden = await acct.call("list_scrobbles", {}).catch((e) => e);
  assert.equal(directFailure(hidden)?.status, "needs_auth");
  assert.match(directFailure(hidden)!.detail, /Hide recent listening/);

  routes = [method("user.getinfo", { error: 6, message: "User not found" })];
  const missing = await openLastfm(connector(), secrets, "UTC").catch((e) => e);
  assert.match(directFailure(missing)!.detail, /can't find that profile/);
});

test("Last.fm's passing trouble is retried, then reported as an error rather than a sign-in problem", async () => {
  let n = 0;
  routes = [(url) => (url.searchParams.get("method") === "user.getinfo" ? (n++, { body: { error: 16, message: "There was a temporary error processing your request." } }) : undefined)];
  const err = await openLastfm(connector(), secrets, "UTC").catch((e) => e);
  assert.equal(n, 3);
  assert.equal(directFailure(err)?.status, "error");
});

test("top_artists: plays per artist", async () => {
  routes = [method("user.getinfo", INFO), method("user.gettopartists", { topartists: { artist: [{ name: "Khruangbin", playcount: "212", url: "https://www.last.fm/music/Khruangbin" }], "@attr": { totalPages: "1" } } })];
  const acct = await openLastfm(connector(), secrets, "UTC");
  const out = JSON.parse((await acct.call("top_artists", { period: "1month" })).text);
  assert.deepEqual(out, { items: [{ artist: "Khruangbin", plays: 212, link: "https://www.last.fm/music/Khruangbin" }], period: "1month" });
});

test("a Life log run reads it: allowed tools listed and called, and precheck doesn't skip it", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  const { glance } = await import("./precheck");
  routes = [method("user.getinfo", INFO), method("user.getrecenttracks", (url: URL) => PAGE(Number(url.searchParams.get("page"))))];
  const c = { ...connector(), allowed_tools: ["list_scrobbles", "top_artists"] } as Connector;
  const open = { connector: c, direct: await openLastfm(c, secrets, "UTC"), close: async () => undefined };
  assert.deepEqual((await listAllowedTools(open)).map((t) => t.name), ["list_scrobbles", "top_artists"]);
  const r = await callTool(open, "list_scrobbles", { date: "2026-11-06" });
  assert.equal(JSON.parse(r.text).items[0].track, "Time");
  assert.equal((await glance(open, new Set(["list_scrobbles"]), new Date(), "UTC")).count, null);
});
