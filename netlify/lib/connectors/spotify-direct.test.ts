// Run: npx tsx --test netlify/lib/connectors/spotify-direct.test.ts
// Spotify over the Web API, with fetch stubbed and recorded replies (shapes as api.spotify.com returned them, trimmed).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { openSpotify, spotifyAdapter, spotifyAuthorizationUrl } from "./spotify-direct";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];
const realSave = lifeTokenStore.save;

beforeEach(() => {
  calls = [];
  routes = [];
  lifeRetryWaits.ms = [1, 1];
  lifeTokenStore.save = async () => undefined;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json", ...reply.headers } });
    }
    throw new Error(`No fixture for ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lifeTokenStore.save = realSave;
});

const at = (p: string, body: unknown, status = 200) => (url: URL) => (url.pathname === p ? { status, body } : undefined);
const connector = { id: "c2", name: "Spotify", provider: "spotify", auth_type: "oauth", url: "https://api.spotify.com/v1", scope: "" } as Connector;
const secrets = (): ConnectorSecrets => ({ tokens: { access_token: "a1", refresh_token: "r1", expires_in: 3600, obtained_at: Date.now() }, ownClient: { client_id: "cid", client_secret: "cs" } });

const ME = { display_name: "Jordan", id: "jordan", type: "user" };
const TRACK = (name: string, ms: number) => ({
  name,
  duration_ms: ms,
  artists: [{ name: "Floating Points" }, { name: "Pharoah Sanders" }],
  album: { name: "Promises", release_date: "2021-03-26" },
  external_urls: { spotify: `https://open.spotify.com/track/${name}` },
});
const PLAY = (name: string, playedAt: string) => ({ track: TRACK(name, 380_000), played_at: playedAt, context: null });
const RECENT_1 = {
  items: [PLAY("m1", "2026-11-06T22:30:00.000Z"), PLAY("m2", "2026-11-06T09:15:00.000Z")],
  next: "https://api.spotify.com/v1/me/player/recently-played?before=1794042900000&limit=50",
  cursors: { after: "1794090600000", before: "1794042900000" },
};
const RECENT_2 = { items: [PLAY("m3", "2026-11-05T23:30:00.000Z")], next: null, cursors: { after: "1793993400000", before: "1793993400000" } };
/** Spotify's paging: two plays a page, before the `before` cursor. */
function recent(url: URL) {
  const before = Number(url.searchParams.get("before") ?? Infinity);
  const all = [...RECENT_1.items, ...RECENT_2.items].filter((p) => Date.parse(p.played_at) < before);
  const items = all.slice(0, 2);
  const last = items.length ? String(Date.parse(items[items.length - 1].played_at)) : undefined;
  return { items, next: all.length > 2 ? "more" : null, cursors: last ? { after: String(Date.parse(items[0].played_at)), before: last } : null };
}

test("presets: Spotify sits in Entertainment, reads only, and the help says to run every few hours", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "spotify")!;
  assert.equal(p.category, "entertainment");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.equal(p.scope, "user-read-recently-played user-library-read user-top-read playlist-read-private playlist-read-collaborative");
  assert.match(p.help, /last 50 plays/);
  assert.match(p.help, /every few hours/);
  for (const t of spotifyAdapter.tools(connector)) assert.equal(classifyTool("spotify", t.name, t.annotations), "read");
  assert.equal(directFor(connector), spotifyAdapter);
});

test("sign-in uses PKCE and the read scopes", () => {
  const url = new URL(spotifyAuthorizationUrl({ clientId: "cid", redirectUri: "https://athena.example/cb", scope: "user-read-recently-played user-library-read user-top-read", state: "s", challenge: "ch" }));
  assert.equal(url.host, "accounts.spotify.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
});

test("recently_played: one local day, local times, totals, and paging back with Spotify's cursor", async () => {
  routes = [at("/v1/me", ME), (url) => (url.pathname === "/v1/me/player/recently-played" ? { body: recent(url) } : undefined)];
  // New York: 22:30Z on the 6th is 17:30 on the 6th; 23:30Z on the 5th is 18:30 on the 5th.
  const acct = await openSpotify(connector, secrets(), "America/New_York");
  const out = JSON.parse((await acct.call("recently_played", { date: "2026-11-06" })).text);
  assert.deepEqual(
    out.items.map((i: { track: string; date: string; time: string }) => [i.track, i.date, i.time]),
    [
      ["m1", "2026-11-06", "17:30"],
      ["m2", "2026-11-06", "04:15"],
    ],
  );
  assert.equal(out.items[0].artist, "Floating Points, Pharoah Sanders");
  assert.equal(out.items[0].album, "Promises");
  assert.equal(out.items[0].minutes, 6.3);
  assert.equal(out.items[0].link, "https://open.spotify.com/track/m1");
  assert.equal(out.plays, 2);
  assert.equal(out.minutes_listened, 13);
  assert.equal(out.next_cursor, undefined);
  // The day's end went to Spotify as `before` (midnight on the 7th, New York).
  assert.equal(calls.find((c) => c.url.pathname.endsWith("recently-played"))!.url.searchParams.get("before"), String(Date.parse("2026-11-07T05:00:00Z")));
  assert.ok(calls.every((c) => c.init.method === "GET"));

  const limited = JSON.parse((await acct.call("recently_played", { limit: 1 })).text);
  assert.equal(limited.items.length, 1);
  const rest = JSON.parse((await acct.call("recently_played", { cursor: limited.next_cursor })).text);
  assert.equal(rest.items[0].track, "m2");
});

test("saved_tracks: filtered on when each was saved, paging by offset", async () => {
  const page = (offset: number) => ({
    items: [
      { added_at: "2026-11-06T10:00:00Z", track: TRACK(`s${offset}`, 200_000) },
      { added_at: "2026-11-02T10:00:00Z", track: TRACK(`t${offset}`, 200_000) },
    ],
    next: null,
    total: 2,
  });
  routes = [at("/v1/me", ME), (url) => (url.pathname === "/v1/me/tracks" ? { body: page(Number(url.searchParams.get("offset"))) } : undefined)];
  const acct = await openSpotify(connector, secrets(), "UTC");
  const out = JSON.parse((await acct.call("saved_tracks", { after: "2026-11-05" })).text);
  assert.deepEqual(out.items, [{ track: "s0", artist: "Floating Points, Pharoah Sanders", album: "Promises", minutes: 3.3, link: "https://open.spotify.com/track/s0", saved_date: "2026-11-06", saved_time: "10:00" }]);
  assert.equal(out.next_cursor, undefined);
});

test("top_items: ranked artists", async () => {
  routes = [at("/v1/me", ME), at("/v1/me/top/artists", { items: [{ name: "Bonobo", genres: ["downtempo"], external_urls: { spotify: "https://open.spotify.com/artist/b" } }], next: "x" })];
  const acct = await openSpotify(connector, secrets(), "UTC");
  const out = JSON.parse((await acct.call("top_items", { type: "artists" })).text);
  assert.deepEqual(out.items[0], { rank: 1, artist: "Bonobo", genres: ["downtempo"], link: "https://open.spotify.com/artist/b" });
  assert.ok(out.next_cursor);
  assert.equal((await acct.call("top_items", { type: "podcasts" })).isError, true);
});

test("a refused token: renewed once, then needs_auth; 403 explains Premium and User Management", async () => {
  routes = [at("/api/token", { error: "invalid_grant", error_description: "Refresh token revoked" }, 400), at("/v1/me", { error: { status: 401, message: "The access token expired" } }, 401)];
  const err = await openSpotify(connector, secrets(), "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Sign in again" });
  assert.equal(calls.filter((c) => c.url.pathname === "/api/token").length, 1);

  routes = [at("/v1/me", { error: { status: 403, message: "Check settings on developer.spotify.com/dashboard, the user may not be registered." } }, 403)];
  const forbidden = await openSpotify(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(directFailure(forbidden)?.status, "needs_auth");
  assert.match(directFailure(forbidden)!.detail, /Premium/);

  routes = [at("/api/token", { error: "invalid_client" }, 400), at("/v1/me", {}, 401)];
  const client = await openSpotify(connector, secrets(), "UTC").catch((e) => e);
  assert.match(directFailure(client)!.detail, /refused Athena's app/);
});

test("429 is retried, honouring Retry-After", async () => {
  let n = 0;
  routes = [(url) => (url.pathname === "/v1/me" ? (n++ === 0 ? { status: 429, body: {}, headers: { "Retry-After": "0" } } : { body: ME }) : undefined)];
  await openSpotify(connector, secrets(), "UTC");
  assert.equal(n, 2);
});

test("a Life log run reads it through the collection path", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  routes = [at("/v1/me", ME), (url) => (url.pathname === "/v1/me/player/recently-played" ? { body: recent(url) } : undefined)];
  const c = { ...connector, allowed_tools: ["recently_played", "saved_tracks", "saved_albums", "top_items"] } as Connector;
  const open = { connector: c, direct: await openSpotify(c, secrets(), "UTC"), close: async () => undefined };
  assert.equal((await listAllowedTools(open)).length, 4);
  assert.equal(JSON.parse((await callTool(open, "recently_played", { date: "2026-11-06" })).text).plays, 2);
});

test("playlists: /me/playlists paged with offsets, items under `item` (the February 2026 API), mine from /me", async () => {
  const me = at("/v1/me", { id: "owner1" });
  const pl = (i: number, owner = "owner1") => ({ id: `pl${i}xxxxxxxxxxxx`, name: `List ${i}`, owner: { id: owner, display_name: owner === "owner1" ? "Me" : "Priya" }, snapshot_id: `v${i}`, items: { total: 3 }, external_urls: { spotify: `https://open.spotify.com/playlist/${i}` } });
  routes.push(me, (url) => (url.pathname === "/v1/me/playlists" ? { body: url.searchParams.get("offset") === "0" ? { items: [pl(1), pl(2, "priya")], next: "https://api.spotify.com/v1/me/playlists?offset=2", total: 3 } : { items: [pl(3)], next: null, total: 3 } } : undefined));
  routes.push((url) => (url.pathname === "/v1/playlists/pl1xxxxxxxxxxxx/items" ? { body: { items: [{ added_at: "2026-11-01T10:00:00Z", item: { name: "Low Tide", artists: [{ name: "Mara Vell" }], album: { name: "Tidal Hours" } } }, { added_at: null, track: { name: "Old Field", artists: [{ name: "Ostra" }] } }, { item: null }], next: null, total: 3 } } : undefined));
  const acct = await openSpotify(connector, secrets(), "Europe/London");
  const p1 = JSON.parse((await acct.call("list_playlists", {})).text);
  assert.deepEqual(p1.items.map((x: { playlist: string; mine: boolean }) => [x.playlist, x.mine]), [["List 1", true], ["List 2", false]]);
  assert.ok(p1.next_cursor);
  const p2 = JSON.parse((await acct.call("list_playlists", { cursor: p1.next_cursor })).text);
  assert.deepEqual(p2.items.map((x: { playlist: string }) => x.playlist), ["List 3"]);
  assert.equal(p2.next_cursor, undefined);
  assert.equal(calls.find((c) => c.url.pathname === "/v1/me/playlists" && c.url.searchParams.get("offset") === "2")?.url.searchParams.get("limit"), "50");
  const t = JSON.parse((await acct.call("list_playlist_tracks", { playlist_id: "pl1xxxxxxxxxxxx" })).text);
  assert.deepEqual(t.items.map((x: { track: string; artist?: string }) => [x.track, x.artist]), [["Low Tide", "Mara Vell"], ["Old Field", "Ostra"]], "item, or the older track field; an empty item is skipped");
  assert.equal(t.items[0].added_date, "2026-11-01");
  assert.ok(calls.every((c) => !c.url.pathname.endsWith("/tracks")), "never the removed /tracks path");
});

test("playlists: a sign-in from before the playlist scopes is 'sign in again', not an account problem", async () => {
  const { PLAYLISTS_NEED_SIGN_IN } = await import("./spotify-direct");
  routes.push(at("/v1/me", { id: "owner1" }), at("/v1/me/playlists", { error: { status: 403, message: "Insufficient client scope" } }, 403));
  routes.push(at("/v1/playlists/someoneelse123/items", { error: { status: 403, message: "Forbidden" } }, 403));
  const acct = await openSpotify(connector, secrets(), "Europe/London");
  const r = await acct.call("list_playlists", {});
  assert.equal(r.isError, true);
  assert.equal(r.text, PLAYLISTS_NEED_SIGN_IN);
  const other = await acct.call("list_playlist_tracks", { playlist_id: "someoneelse123" });
  assert.equal(other.isError, true);
  assert.match(other.text, /only shares the tracks of playlists you made/);
  assert.ok(CONNECTOR_PRESETS.find((p) => p.id === "spotify")?.scope?.includes("playlist-read-private"));
  assert.equal(classifyTool("spotify", "list_playlists", { readOnlyHint: true }), "read");
});

test("playlist sync: pages the list, reads tracks only for the owner's own, reuses unchanged ones, and spots a missing scope", async () => {
  const { collectSpotifyPlaylists } = await import("./playlist-sync");
  const { PLAYLISTS_NEED_SIGN_IN } = await import("./spotify-direct");
  const seen: string[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    seen.push(`${name}:${args.playlist_id ?? ""}:${args.cursor ?? ""}`);
    if (name === "list_playlists")
      return { isError: false, text: JSON.stringify(args.cursor ? { items: [{ id: "c", playlist: "Followed", owner: "Sam", mine: false, tracks: 9, version: "c1" }] } : { items: [{ id: "a", playlist: "Mine", owner: "Me", mine: true, tracks: 60, version: "a2" }, { id: "b", playlist: "Same", owner: "Me", mine: true, tracks: 2, version: "b1" }], next_cursor: "n" }) };
    return { isError: false, text: JSON.stringify(args.cursor ? { items: Array.from({ length: 10 }, (_, i) => ({ track: `t${50 + i}`, artist: "Ostra" })) } : { items: Array.from({ length: 50 }, (_, i) => ({ track: `t${i}`, artist: i % 2 ? "Ostra" : "Halden, Ostra" })), next_cursor: "m" }) };
  };
  const before = new Map([["b", { id: "b", name: "Same", mine: true, tracks: 2, version: "b1", items: [{ track: "kept" }], top_artists: [] }]]);
  const got = await collectSpotifyPlaylists(call, before, Date.now() + 10_000);
  assert.notEqual(got, "needs_sign_in");
  if (got === "needs_sign_in") return;
  assert.deepEqual(got.playlists.map((p) => p.name), ["Mine", "Same", "Followed"]);
  assert.equal(got.playlists[0].items?.length, 60, "two pages of tracks");
  assert.deepEqual(got.playlists[0].top_artists?.[0], { name: "Ostra", tracks: 60 });
  assert.deepEqual(got.playlists[1].items, [{ track: "kept" }], "unchanged version: not read again");
  assert.equal(got.playlists[2].items, undefined, "a followed playlist's tracks aren't asked for");
  assert.equal(got.read, 1);
  assert.deepEqual(seen.filter((s) => s.startsWith("list_playlist_tracks")), ["list_playlist_tracks:a:", "list_playlist_tracks:a:m"]);
  assert.equal(await collectSpotifyPlaylists(async () => ({ isError: true, text: PLAYLISTS_NEED_SIGN_IN }), new Map(), Date.now() + 1000), "needs_sign_in");
});
