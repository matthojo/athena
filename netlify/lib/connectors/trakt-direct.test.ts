// Run: npx tsx --test netlify/lib/connectors/trakt-direct.test.ts
// Trakt over its own API, with fetch stubbed (fixtures/feeds-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { presetFor } from "../../../lib/connector-presets";
import * as F from "./fixtures/feeds-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./feeds-shared";
import { openTrakt, traktAdapter } from "./trakt-direct";
import { traktTokenStore } from "./trakt-api";
import { glance } from "./precheck";
import type { OpenConnector } from "./mcp-client";

beforeEach(() => {
  F.installFetch();
  lifeRetryWaits.ms = [1, 1];
});
afterEach(F.restoreFetch);

const connector = (over: Partial<Connector> = {}): Connector => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "Trakt",
  provider: "trakt",
  account_label: "",
  url: presetFor("trakt").url,
  auth_type: "oauth",
  scope: "",
  status: "connected",
  status_detail: "",
  tools: [],
  allowed_tools: presetFor("trakt").readTools,
  tools_checked_at: null,
  last_used_at: null,
  server_info: {},
  oauth: {},
  has_token: false,
  has_own_client: true,
  has_client_secret: true,
  created_at: "",
  updated_at: "",
  ...over,
});

const fresh = { access_token: "at", refresh_token: "rt", expires_in: 86400, obtained_at: Date.now() };
const secrets = (tokens: Record<string, unknown> = fresh): ConnectorSecrets => ({
  ownClient: { client_id: "trakt-app", client_secret: "trakt-secret" },
  tokens: { ...tokens },
  redirectUrl: "https://athena.example/api/connectors/oauth/callback",
});

const api = (path: string | RegExp, body: unknown, headers: Record<string, string> = {}, status = 200): F.Route => (url) =>
  url.host === "api.trakt.tv" && (typeof path === "string" ? url.pathname === path : path.test(url.pathname)) ? { status, body, headers } : undefined;
const settings = api("/users/settings", F.TRAKT_SETTINGS);

async function call(name: string, args: Record<string, unknown> = {}) {
  const account = await openTrakt(connector(), secrets(), { tz: "Europe/London" });
  const r = await account.call(name, args);
  return { ...r, json: r.isError ? null : JSON.parse(r.text) };
}

test("registered: an OAuth Trakt account is direct; its preset sits in Entertainment, feeds the Life log, own app", () => {
  assert.equal(directFor({ provider: "trakt", auth_type: "oauth", oauth: {} })?.id, "trakt");
  const p = presetFor("trakt");
  assert.equal(p.category, "entertainment");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.ok(p.needsOwnClient);
  assert.deepEqual(traktAdapter.tools(connector()).map((t) => t.name), p.readTools);
  assert.ok(traktAdapter.tools(connector()).every((t) => t.annotations.readOnlyHint));
});

test("sign-in goes to auth.trakt.tv with PKCE; the code is swapped at api.trakt.tv, with no client secret", async () => {
  const url = new URL(traktAdapter.authorizationUrl!({ clientId: "trakt-app", redirectUri: "https://a/cb", scope: "", state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://auth.trakt.tv/oauth/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "st");
  F.stub((u, init) => (u.pathname === "/oauth/token" && init.method === "POST" ? { body: { access_token: "new", refresh_token: "r2", expires_in: 86400, token_type: "bearer" } } : undefined));
  const t = await traktAdapter.exchangeCode!({ code: "c", redirectUri: "https://a/cb", verifier: "v", scope: "", client: { client_id: "trakt-app" } });
  assert.equal(t.access_token, "new");
  const sent = JSON.parse(String(F.calls[0].init.body));
  assert.equal(sent.code_verifier, "v");
  assert.equal(sent.grant_type, "authorization_code");
  assert.equal("client_secret" in sent, false);
  assert.equal(traktAdapter.noClientSecret, true);
  assert.equal(presetFor("trakt").noClientSecret, true);
});

test("list_history: episodes and films with the owner's day and time, links, counts, and Trakt's page headers as a token", async () => {
  F.stub(settings, (url) => (url.pathname === "/users/yourname/history/" ? { body: F.TRAKT_HISTORY_PAGE_1, headers: { "X-Pagination-Page": "1", "X-Pagination-Page-Count": "2" } } : undefined));
  const r = await call("list_history", { after: "2026-11-06", before: "2026-11-07", limit: 2 });
  assert.deepEqual(r.json, {
    watched: [
      { kind: "episode", show: "Severance", season: 2, episode: 3, title: "Who Is Alive?", day: "2026-11-06", time: "21:14", link: "https://trakt.tv/shows/severance/seasons/2/episodes/3" },
      { kind: "film", title: "Paddington in Peru", year: 2024, day: "2026-11-06", time: "19:02", link: "https://trakt.tv/movies/paddington-in-peru-2024" },
    ],
    count: 2,
    episodes: 1,
    films: 1,
    next_page_token: "2",
  });
  const q = F.calls.find((c) => c.url.pathname === "/users/yourname/history/")!;
  // The owner's day in London (GMT in November), as Trakt's start_at / end_at.
  assert.equal(q.url.searchParams.get("start_at"), "2026-11-06T00:00:00.000Z");
  assert.equal(q.url.searchParams.get("end_at"), "2026-11-06T23:59:59.999Z");
  assert.equal(q.init.headers && (q.init.headers as Record<string, string>)["trakt-api-key"], "trakt-app");
  assert.ok(F.calls.every((c) => (c.init.method ?? "GET") === "GET"));
});

test("list_history: the next page, and the last page has no token", async () => {
  F.stub(settings, (url) => (url.pathname === "/users/yourname/history/episodes" && url.searchParams.get("page") === "2" ? { body: F.TRAKT_HISTORY_PAGE_2, headers: { "X-Pagination-Page": "2", "X-Pagination-Page-Count": "2" } } : undefined));
  const r = await call("list_history", { type: "episodes", page_token: "2" });
  assert.equal(r.json.watched[0].title, "Goodbye, Mrs. Selvig");
  assert.equal(r.json.next_page_token, undefined);
  assert.equal((await call("list_history", { page_token: "abc" })).isError, true);
});

test("ratings, watchlist and in progress: filtered to the window, newest first", async () => {
  F.stub(settings, api("/users/yourname/ratings/", F.TRAKT_RATINGS), api("/users/yourname/watchlist/movie,show/added", F.TRAKT_WATCHLIST), api("/sync/playback", F.TRAKT_PLAYBACK));
  const ratings = await call("list_ratings", { after: "2026-11-06" });
  assert.deepEqual(ratings.json.ratings, [{ kind: "episode", show: "Severance", season: 2, episode: 3, title: "Who Is Alive?", day: "2026-11-06", time: "21:20", link: "https://trakt.tv/shows/severance/seasons/2/episodes/3", rating: "9/10" }]);
  assert.equal((await call("list_watchlist", { after: "2026-11-06" })).json.count, 0);
  assert.equal((await call("list_watchlist")).json.watchlist[0].title, "Slow Horses");
  const playing = await call("list_in_progress", { after: "2026-11-06" });
  assert.deepEqual(playing.json.in_progress, [{ kind: "film", title: "Dune", year: 2021, day: "2026-11-06", time: "22:40", link: "https://trakt.tv/movies/dune-2021", progress: "42%" }]);
});

test("a refused token: renewal refused too (Trakt's real reply) means sign in again", async () => {
  F.stub(api("/users/settings", "", {}, 401), (url) => (url.pathname === "/oauth/token" ? { status: 400, body: F.LIVE_TRAKT_DEAD_REFRESH } : undefined));
  const err = await openTrakt(connector(), secrets(), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Trakt didn't accept the sign-in. Sign in again" });
  assert.ok(traktAdapter.accountProblem(err));
});

test("a wrong client ID (Trakt's real 403) is the owner's to fix", async () => {
  F.stub(api("/users/settings", F.LIVE_TRAKT_BAD_KEY, {}, 403));
  const err = await openTrakt(connector(), secrets(), { tz: "UTC" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Trakt refused Athena's app. Check the client ID under Edit, then sign in again." });
});

test("an expired token is renewed once, and Trakt's rotated refresh token is saved", async () => {
  const saved: ConnectorSecrets = { tokens: { refresh_token: "rt" } };
  const real = traktTokenStore.save;
  traktTokenStore.save = async (_id, mutate) => mutate(saved);
  try {
    F.stub(settings, (url, init) => (url.pathname === "/oauth/token" && init.method === "POST" ? { body: { access_token: "at2", refresh_token: "rt2", expires_in: 86400 } } : undefined));
    await openTrakt(connector(), secrets({ access_token: "old", refresh_token: "rt", expires_in: 10, obtained_at: 1 }), { tz: "UTC" });
    assert.equal((saved.tokens as { refresh_token: string }).refresh_token, "rt2");
    const sent = JSON.parse(String(F.calls.find((c) => c.url.pathname === "/oauth/token")!.init.body));
    assert.equal(sent.redirect_uri, "https://athena.example/api/connectors/oauth/callback");
    assert.equal("client_secret" in sent, false);
  } finally {
    traktTokenStore.save = real;
  }
});

test("a busy Trakt is retried, then reported as passing (not the owner's problem)", async () => {
  F.stub(settings, api("/users/yourname/history/", "", { "Retry-After": "1" }, 429));
  const account = await openTrakt(connector(), secrets(), { tz: "UTC" });
  const err = await account.call("list_history", {}).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "error", detail: "Trakt is limiting how often Athena can ask right now. Try again in a few minutes." });
  assert.equal(F.calls.filter((c) => c.url.pathname === "/users/yourname/history/").length, 3);
});

test("precheck: nothing watched, rated, saved or started since the last run counts 0", async () => {
  F.stub(settings, api("/users/yourname/history/", []), api("/users/yourname/ratings/", F.TRAKT_RATINGS), api("/users/yourname/watchlist/movie,show/added", F.TRAKT_WATCHLIST), api("/sync/playback", []));
  const account = await openTrakt(connector(), secrets(), { tz: "UTC" });
  const open: OpenConnector = { connector: connector(), direct: account, close: async () => undefined };
  const all = new Set(presetFor("trakt").readTools);
  assert.equal((await glance(open, all, new Date("2026-11-07T00:00:00Z"), "UTC")).count, 0);
  assert.equal((await glance(open, all, new Date("2026-11-06T00:00:00Z"), "UTC")).count, 1);
  assert.equal((await glance(open, new Set(), new Date(), "UTC")).count, null);
});
