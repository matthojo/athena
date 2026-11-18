// Run: npx tsx --test netlify/lib/connectors/youtube-direct.test.ts
// YouTube over the Data API v3, with fetch stubbed (fixtures/feeds-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { presetFor } from "../../../lib/connector-presets";
import * as F from "./fixtures/feeds-recorded";
import { directFailure, directFor } from "./direct";
import { retryWaits } from "./google-api";
import { lifeRetryWaits } from "./feeds-shared";
import { openYouTube, youtubeAdapter, YOUTUBE_READ_SCOPE } from "./youtube-direct";
import { glance } from "./precheck";
import type { OpenConnector } from "./mcp-client";

beforeEach(() => {
  F.installFetch();
  retryWaits.ms = [1, 1];
  lifeRetryWaits.ms = [1, 1];
});
afterEach(F.restoreFetch);

const connector = (): Connector => ({
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "YouTube",
  provider: "youtube",
  account_label: "",
  url: presetFor("youtube").url,
  auth_type: "oauth",
  scope: YOUTUBE_READ_SCOPE,
  status: "connected",
  status_detail: "",
  tools: [],
  allowed_tools: presetFor("youtube").readTools,
  tools_checked_at: null,
  last_used_at: null,
  server_info: {},
  oauth: {},
  has_token: false,
  has_own_client: true,
  has_client_secret: true,
  created_at: "",
  updated_at: "",
});

const fresh = { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now() };
const secrets = (tokens: Record<string, unknown> = fresh): ConnectorSecrets => ({ ownClient: { client_id: "x.apps.googleusercontent.com", client_secret: "s" }, tokens: { ...tokens } });

const yt = (path: string, body: unknown, status = 200, when: (u: URL) => boolean = () => true): F.Route => (url) =>
  url.host === "www.googleapis.com" && url.pathname === `/youtube/v3${path}` && when(url) ? { status, body } : undefined;
const channel = yt("/channels", F.YT_CHANNEL);

async function call(name: string, args: Record<string, unknown> = {}) {
  const account = await openYouTube(connector(), secrets(), { tz: "Europe/London" });
  const r = await account.call(name, args);
  return { ...r, json: r.isError ? null : JSON.parse(r.text) };
}

test("registered: an OAuth YouTube account is direct, read-only scope, the owner's Google client", () => {
  assert.equal(directFor({ provider: "youtube", auth_type: "oauth", oauth: {} })?.id, "youtube");
  const p = presetFor("youtube");
  assert.equal(p.scope, "https://www.googleapis.com/auth/youtube.readonly");
  assert.equal(p.ownClientLabel, "Google");
  assert.equal(p.category, "entertainment");
  assert.match(p.help, /doesn't share your watch history/);
  const url = new URL(youtubeAdapter.authorizationUrl!({ clientId: "c", redirectUri: "https://a/cb", scope: p.scope, state: "s", challenge: "ch" }));
  assert.equal(url.host, "accounts.google.com");
  assert.equal(url.searchParams.get("scope"), YOUTUBE_READ_SCOPE);
});

test("list_liked_videos: the owner's day and time liked, channel, link; deleted videos left out; paging", async () => {
  F.stub(channel, yt("/playlistItems", F.YT_LIKES_PAGE_1, 200, (u) => u.searchParams.get("playlistId") === "LL" && !u.searchParams.has("pageToken")));
  const r = await call("list_liked_videos", { after: "2026-11-06", limit: 3 });
  assert.deepEqual(r.json, {
    videos: [
      { title: "How the Thames Barrier works", channel: "Practical Engineering", day: "2026-11-06", time: "20:05", link: "https://www.youtube.com/watch?v=vid1" },
      { title: "A week in Lisbon", channel: "Kara and Nate", day: "2026-11-06", time: "08:00", link: "https://www.youtube.com/watch?v=vid2" },
    ],
    count: 2,
    next_page_token: "CAIQAA",
  });
  // The liked list is newest first: a page that reaches past `after` has no next page.
  F.stub(channel, yt("/playlistItems", F.YT_LIKES_PAGE_2, 200, (u) => u.searchParams.get("pageToken") === "CAIQAA"));
  const next = await call("list_liked_videos", { after: "2026-11-06", page_token: "CAIQAA" });
  assert.deepEqual(next.json, { count: 0 });
  assert.equal((await call("list_liked_videos", { page_token: "../x" })).isError, true);
  assert.ok(F.calls.every((c) => (c.init.method ?? "GET") === "GET"));
});

test("playlists, a playlist's videos, and subscriptions in the window", async () => {
  F.stub(channel, yt("/playlists", F.YT_PLAYLISTS), yt("/playlistItems", F.YT_LIKES_PAGE_1), yt("/subscriptions", F.YT_SUBSCRIPTIONS));
  assert.deepEqual((await call("list_playlists")).json.playlists, [{ id: "PLabc", title: "Watch this weekend", videos: 7, privacy: "private", made_on: "2026-03-01", link: "https://www.youtube.com/playlist?list=PLabc" }]);
  const pl = await call("list_playlist_videos", { playlist_id: "PLabc", after: "2026-11-06T12:00:00Z" });
  assert.deepEqual(pl.json.videos.map((v: { title: string }) => v.title), ["How the Thames Barrier works"]);
  assert.equal(pl.json.next_page_token, "CAIQAA");
  const subs = await call("list_subscriptions", { after: "2026-11-01" });
  assert.deepEqual(subs.json, { subscriptions: [{ channel: "Tom Scott", day: "2026-11-06", time: "12:00", link: "https://www.youtube.com/channel/UCts" }], count: 1, total_count: 1 });
  assert.equal((await call("list_playlist_videos", {})).isError, true);
});

test("a refused token (YouTube's real 401) with a dead refresh token means sign in again", async () => {
  F.stub(yt("/channels", F.LIVE_YT_401, 401), (url) => (url.host === "oauth2.googleapis.com" ? { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } : undefined));
  const err = await openYouTube(connector(), secrets(), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Sign in again" });
});

test("the API switched off, and an account with no channel, both say what to do", async () => {
  F.stub(yt("/channels", F.YT_API_OFF, 403));
  const off = await openYouTube(connector(), secrets(), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(off), { status: "needs_auth", detail: "Turn on the YouTube Data API v3 in your Google Cloud project 123456789012, then try again." });
  assert.ok(youtubeAdapter.accountProblem(off));
  F.stub(yt("/channels", F.YT_NO_CHANNEL));
  const none = await openYouTube(connector(), secrets(), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(none), { status: "needs_auth", detail: "This Google account has no YouTube channel. Sign in with the account you use on YouTube." });
});

test("precheck: no likes or subscriptions since the last run counts 0", async () => {
  F.stub(channel, yt("/playlistItems", F.YT_LIKES_PAGE_2), yt("/subscriptions", F.YT_SUBSCRIPTIONS));
  const account = await openYouTube(connector(), secrets(), { tz: "UTC" });
  const open: OpenConnector = { connector: connector(), direct: account, close: async () => undefined };
  const all = new Set(presetFor("youtube").readTools);
  assert.equal((await glance(open, all, new Date("2026-11-06T13:00:00Z"), "UTC")).count, 0);
  assert.equal((await glance(open, all, new Date("2026-11-05T00:00:00Z"), "UTC")).count, 2);
});
