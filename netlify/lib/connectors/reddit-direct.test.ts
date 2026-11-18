// Run: npx tsx --test netlify/lib/connectors/{reddit,spotify,lastfm,steam}-direct.test.ts
// Reddit over its OAuth API, with fetch stubbed and recorded replies (shapes as reddit.com returned them, trimmed).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits, lifeTokenStore } from "./lifelog-b-http";
import { openReddit, redditAdapter, redditAuthorizationUrl, REDDIT_USER_AGENT } from "./reddit-direct";

type Reply = { status?: number; body: unknown };
const realFetch = globalThis.fetch;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];
let saved: ConnectorSecrets[] = [];
const realSave = lifeTokenStore.save;

beforeEach(() => {
  calls = [];
  routes = [];
  saved = [];
  lifeRetryWaits.ms = [1, 1];
  lifeTokenStore.save = async (_id, mutate) => {
    const s: ConnectorSecrets = { tokens: { refresh_token: "r1" } };
    mutate(s);
    saved.push(s);
  };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  lifeTokenStore.save = realSave;
});

const at = (p: string, body: unknown, status = 200) => (url: URL) => (url.pathname === p ? { status, body } : undefined);
const connector = { id: "c1", name: "Reddit", provider: "reddit", auth_type: "oauth", url: "https://oauth.reddit.com", scope: "identity history read" } as Connector;
const secrets = (): ConnectorSecrets => ({ tokens: { access_token: "a1", refresh_token: "r1", expires_in: 3600, obtained_at: Date.now() }, ownClient: { client_id: "cid", client_secret: "cs" } });

const ME = { name: "jordan_h", id: "abc" };
// 6 Nov 2026 21:10 UTC, 5 Nov 2026 09:00 UTC, 1 Nov 2026 12:00 UTC.
const POST = (name: string, created: number, extra: Record<string, unknown> = {}) => ({
  kind: "t3",
  data: { name, created_utc: created, author: "jordan_h", title: `Post ${name}`, subreddit_name_prefixed: "r/espresso", subreddit_type: "public", permalink: `/r/espresso/comments/${name}/x/`, is_self: true, selftext: "My grinder setup", score: 12, num_comments: 3, ...extra },
});
const SUBMITTED_1 = { data: { after: "t3_c", children: [POST("t3_a", 1793999400), POST("t3_b", 1793869200), POST("t3_c", 1793868600)] } };
const SUBMITTED_2 = { data: { after: null, children: [POST("t3_d", 1793534400)] } };

test("presets: Reddit sits in Social, feeds the Life log, and every tool reads", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "reddit")!;
  assert.equal(p.category, "social");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.equal(p.scope, "identity history read");
  for (const t of redditAdapter.tools(connector)) assert.equal(classifyTool("reddit", t.name, t.annotations), "read");
  assert.equal(directFor(connector), redditAdapter);
  assert.equal(directFor({ ...connector, auth_type: "token" }), undefined);
});

test("sign-in asks for a permanent grant with read scopes only", () => {
  const url = new URL(redditAuthorizationUrl({ clientId: "cid", redirectUri: "https://athena.example/api/connectors/oauth/callback", scope: "identity history read", state: "s" }));
  assert.equal(url.origin + url.pathname, "https://www.reddit.com/api/v1/authorize");
  assert.equal(url.searchParams.get("duration"), "permanent");
  assert.equal(url.searchParams.get("scope"), "identity history read");
});

test("my_posts: the owner's own posts in a local-day window, with a User-Agent on every request", async () => {
  routes = [at("/api/v1/me", ME), (url) => (url.pathname === "/user/jordan_h/submitted" ? { body: url.searchParams.get("after") ? SUBMITTED_2 : SUBMITTED_1 } : undefined)];
  const acct = await openReddit(connector, secrets(), "Europe/London");
  const r = await acct.call("my_posts", { date: "2026-11-05" });
  assert.equal(r.isError, false);
  const out = JSON.parse(r.text);
  assert.deepEqual(
    out.items.map((i: { title: string; date: string; time: string }) => [i.title, i.date, i.time]),
    [
      ["Post t3_b", "2026-11-05", "09:00"],
      ["Post t3_c", "2026-11-05", "08:50"],
    ],
  );
  assert.equal(out.items[0].link, "https://www.reddit.com/r/espresso/comments/t3_b/x/");
  assert.equal(out.items[0].community, "r/espresso");
  assert.equal(out.items[0].text, "My grinder setup");
  // Older than the window on page two: paging stops, no cursor.
  assert.equal(out.next_cursor, undefined);
  for (const c of calls) {
    assert.match(new Headers(c.init.headers).get("User-Agent") ?? "", /^web:athena-life-log:1\.0/);
    assert.equal(c.init.method, "GET");
  }
  assert.ok(calls.some((c) => /by \/u\/jordan_h/.test(new Headers(c.init.headers).get("User-Agent") ?? "")));
  assert.match(REDDIT_USER_AGENT, /read-only/);
});

test("paging: a limit stops mid-page and the cursor carries on from the last item", async () => {
  routes = [at("/api/v1/me", ME), (url) => (url.pathname === "/user/jordan_h/submitted" ? { body: url.searchParams.get("after") === "t3_a" ? { data: { after: null, children: SUBMITTED_1.data.children.slice(1) } } : SUBMITTED_1 } : undefined)];
  const acct = await openReddit(connector, secrets(), "UTC");
  const first = JSON.parse((await acct.call("my_posts", { limit: 1 })).text);
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  const second = JSON.parse((await acct.call("my_posts", { limit: 5, cursor: first.next_cursor })).text);
  assert.deepEqual(second.items.map((i: { title: string }) => i.title), ["Post t3_b", "Post t3_c"]);
  // Another tool's cursor is refused.
  const wrong = await acct.call("my_comments", { cursor: first.next_cursor });
  assert.equal(wrong.isError, true);
});

test("saved: others' items keep no username; private communities keep only their name", async () => {
  const saved = {
    data: {
      after: null,
      children: [
        { kind: "t1", data: { name: "t1_x", created_utc: 1793999400, author: "someone_else", body: "Try a finer grind.", link_title: "Sour shots?", subreddit_name_prefixed: "r/espresso", subreddit_type: "public", permalink: "/r/espresso/comments/q/x/c1/" } },
        POST("t3_p", 1793999400, { author: "another", subreddit_name_prefixed: "r/secretclub", subreddit_type: "private", title: "Hidden" }),
      ],
    },
  };
  routes = [at("/api/v1/me", ME), at("/user/jordan_h/saved", saved)];
  const acct = await openReddit(connector, secrets(), "UTC");
  const out = JSON.parse((await acct.call("my_saved", {})).text);
  assert.equal(out.items[0].kind, "comment");
  assert.equal(out.items[0].on, "Sour shots?");
  assert.doesNotMatch(JSON.stringify(out), /someone_else|another|Hidden/);
  assert.deepEqual(out.items[1], { kind: "post", community: "r/secretclub", date: "2026-11-06", time: "21:10", private: true });
  assert.match(out.note, /doesn't say when you saved/);
});

test("an expired token is renewed once and saved; a refused renewal means sign in again", async () => {
  let tried = 0;
  routes = [
    (url) => (url.pathname === "/api/v1/access_token" ? { body: { access_token: "a2", expires_in: 3600, token_type: "bearer" } } : undefined),
    (url, init) => (url.pathname === "/api/v1/me" ? (new Headers(init.headers).get("Authorization") === "Bearer a2" ? { body: ME } : (tried++, { status: 401, body: { message: "Unauthorized", error: 401 } })) : undefined),
  ];
  await openReddit(connector, secrets(), "UTC");
  assert.equal(tried, 1);
  assert.equal(saved.length, 1);
  assert.equal((saved[0].tokens as { access_token: string }).access_token, "a2");
  // Reddit refuses a dead refresh token with 200 and an error.
  routes = [at("/api/v1/access_token", { error: "invalid_grant" }), at("/api/v1/me", { message: "Unauthorized", error: 401 }, 401)];
  const err = await openReddit(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(redditAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Sign in again" });
});

test("403: needs the owner (an app not yet approved, or a permission declined)", async () => {
  routes = [at("/api/v1/me", { message: "Forbidden", error: 403 }, 403)];
  const err = await openReddit(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.match(directFailure(err)!.detail, /may not have approved it yet/);
});

test("Reddit's network block (a live HTML 403) is a passing error, not a sign-in problem", async () => {
  const BLOCKED = "<!doctype html><html><head><title>Blocked</title></head><body>whoa there, pardner!</body></html>";
  let n = 0;
  globalThis.fetch = (async () => (n++, new Response(BLOCKED, { status: 403, headers: { "Content-Type": "text/html" } }))) as typeof fetch;
  const err = await openReddit(connector, secrets(), "UTC").catch((e) => e);
  assert.equal(n, 3);
  assert.equal(redditAdapter.accountProblem(err), false);
  assert.equal(directFailure(err)?.status, "error");
  assert.match(directFailure(err)!.detail, /blocking Athena's server/);
});

test("a Life log run reads it through the collection path", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  routes = [at("/api/v1/me", ME), at("/user/jordan_h/comments", { data: { after: null, children: [] } })];
  const c = { ...connector, allowed_tools: ["my_posts", "my_comments", "my_saved", "my_upvoted"] } as Connector;
  const open = { connector: c, direct: await openReddit(c, secrets(), "UTC"), close: async () => undefined };
  assert.equal((await listAllowedTools(open)).length, 4);
  assert.deepEqual(JSON.parse((await callTool(open, "my_comments", { date: "2026-11-06" })).text), { items: [], count: 0 });
});
