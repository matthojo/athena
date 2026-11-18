// Run: npx tsx --test netlify/lib/connectors/{readwise,bluesky,mastodon}-direct.test.ts
// Mastodon over its REST API, with fetch and DNS stubbed and recorded replies (fixtures/reading-social-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import * as F from "./fixtures/reading-social-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { mastodonAdapter, mastodonNet, mastodonProfileUrl, openMastodon, plainText } from "./mastodon-direct";
import { itemKinds } from "./answer-sources";
import type { OpenConnector } from "./mcp-client";

const HOST = "mastodon.social";
const connector = (url = "https://mastodon.social/@jordan") => ({ id: "md1", name: "Mastodon", provider: "mastodon", auth_type: "token", url, scope: "read" }) as Connector;
const secrets: ConnectorSecrets = { token: "masto_token_abc" };
const me = F.at(HOST, "/api/v1/accounts/verify_credentials", F.MASTO_ME);
/** Newest page, then the next by max_id, then the end. */
const statuses = F.at(HOST, "/api/v1/accounts/13179/statuses", (url) => {
  const max = url.searchParams.get("max_id");
  return !max ? F.MASTO_PAGE_1 : max === F.MASTO_PAGE_1.at(-1)!.id ? F.MASTO_PAGE_2 : [];
});
const realLookup = mastodonNet.lookup;
let looked: string[] = [];

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
  looked = [];
  mastodonNet.lookup = async (host) => {
    looked.push(host);
    return host === "evil.example" ? [{ address: "10.0.0.8", family: 4 }] : host === "v6.example" ? [{ address: "::1", family: 6 }] : host === "mapped.example" ? [{ address: "::ffff:a9fe:a9fe", family: 6 }] : [{ address: "151.101.1.1", family: 4 }];
  };
});
afterEach(() => {
  F.unstub();
  mastodonNet.lookup = realLookup;
});

const run = async (args: Record<string, unknown>, tz = "Europe/London") => JSON.parse((await (await openMastodon(connector(), secrets, tz)).call("my_posts", args)).text);

test("preset: Mastodon sits in Social, feeds the Life log, asks only to read, and Athena calls it directly", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "mastodon")!;
  assert.equal(p.category, "social");
  assert.equal(p.auth, "token");
  assert.equal(p.scope, "read");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.deepEqual(p.readTools, ["my_posts"]);
  assert.equal(classifyTool("mastodon", "my_posts", mastodonAdapter.tools(connector())[0].annotations), "read");
  assert.equal(directFor(connector()), mastodonAdapter);
  assert.ok(directApi(connector()));
});

test("address: a profile link, server, or @name@server becomes the profile link", () => {
  const ok: Array<[string, string]> = [
    ["https://mastodon.social/@jordan", "https://mastodon.social/@jordan"],
    ["mastodon.social/@jordan/117466985005297414", "https://mastodon.social/@jordan"],
    ["@jordan@hachyderm.io", "https://hachyderm.io/@jordan"],
    ["jordan@Fosstodon.org", "https://fosstodon.org/@jordan"],
    ["https://mastodon.social/@jordan@hachyderm.io", "https://hachyderm.io/@jordan"],
    ["https://social.example.org/users/jordan", "https://social.example.org/@jordan"],
    ["https://mastodon.social", "https://mastodon.social"],
  ];
  for (const [raw, want] of ok) assert.equal(mastodonProfileUrl(raw), want, raw);
  const refused = ["", "javascript:alert(1)", "https://127.0.0.1/@jordan", "https://[::1]/@jordan", "https://localhost/@jordan", "https://mastodon.local/@x", "https://box.internal/@x", "https://mastodon.social:8443/@jordan", "https://u:p@mastodon.social/@jordan", "ftp://mastodon.social", "nohost"];
  for (const bad of refused) assert.throws(() => mastodonProfileUrl(bad), /Mastodon|profile link/, bad);
});

test("a server name that resolves to an internal address gets no request, and no token", async () => {
  F.stub();
  for (const host of ["evil.example", "v6.example", "mapped.example"]) {
    const err = await openMastodon(connector(`https://${host}/@jordan`), secrets, "UTC").catch((e) => e);
    assert.equal(directFailure(err)?.status, "needs_auth");
    assert.match(directFailure(err)!.detail, /isn't a public server/);
  }
  assert.equal(F.calls.length, 0);
});

test("my_posts: one day of your own posts and replies; boosts and private mentions left out; HTML as plain text", async () => {
  F.stub(me, statuses);
  const out = await run({ date: "2026-11-06" });
  assert.equal(out.count, 2);
  assert.equal(out.posts, 1);
  assert.equal(out.replies, 1);
  assert.deepEqual(out.items[0], {
    kind: "post",
    text: "Late one.",
    date: "2026-11-06",
    time: "21:59",
    link: "https://mastodon.social/@jordan/117470000000000005",
    visibility: "unlisted",
    favourites: 442,
    boosts: 225,
    replies: 20,
  });
  assert.equal(out.items[1].kind, "reply");
  assert.equal(out.items[1].text, "@alex agreed, it's & always was.\n\nSecond line\nthird");
  const text = JSON.stringify(out);
  assert.ok(!text.includes("Someone else") && !text.includes("Psst"));
  assert.equal(out.profile, "https://mastodon.social/@jordan");
  // Boosts asked to be left out at the source too; only GETs, only to the owner's server, token as Bearer, redirects refused.
  const q = F.calls.find((c) => c.url.pathname.endsWith("/statuses"))!;
  assert.equal(q.url.searchParams.get("exclude_reblogs"), "true");
  assert.ok(F.calls.every((c) => c.url.host === HOST && (c.init.method ?? "GET") === "GET" && c.init.redirect === "error"));
  assert.ok(F.calls.every((c) => (c.init.headers as Record<string, string>).Authorization === "Bearer masto_token_abc"));
  assert.deepEqual(looked, [HOST]);
});

test("my_posts: pages by max_id, from the last status read, until the window ends", async () => {
  F.stub(me, statuses);
  const out = await run({ after: "2026-10-01", before: "2026-11-07" });
  assert.deepEqual(
    out.items.map((p: Record<string, unknown>) => p.date),
    ["2026-11-06", "2026-11-06", "2026-11-05", "2026-10-09"],
  );
  const old = out.items[2];
  assert.equal(old.text, "Our new forum: community.joinmastodon.org/");
  assert.equal(old.content_warning, "meta");
  assert.equal(old.media, 1);
  assert.equal(old.shared_link, "https://community.joinmastodon.org/");
  const pages = F.calls.filter((c) => c.url.pathname.endsWith("/statuses")).map((c) => c.url.searchParams.get("max_id"));
  assert.deepEqual(pages, [null, "117466985005297414", "117411420916699261"]);
});

test("my_posts: a limit mid-page picks up where it stopped, nothing twice", async () => {
  F.stub(me, statuses);
  const a = await run({ after: "2026-10-01", limit: 3 });
  const b = await run({ after: "2026-10-01", limit: 3, cursor: a.next_cursor });
  const links = [...a.items, ...b.items].map((p: Record<string, unknown>) => p.link);
  assert.deepEqual(links.length, 4);
  assert.equal(new Set(links).size, 4);
  assert.equal(b.next_cursor, undefined);
});

test("a token the server doesn't know (its real 401) is needs_auth, saying how to make one", async () => {
  F.stub(F.at(HOST, "/api/v1/accounts/verify_credentials", F.MASTO_BAD_TOKEN, 401));
  const err = await openMastodon(connector(), secrets, "UTC").catch((e) => e);
  const f = directFailure(err)!;
  assert.equal(f.status, "needs_auth");
  assert.match(f.detail, /Preferences, then Development/);
  assert.ok(mastodonAdapter.accountProblem(err));
});

test("a token without read (403 scope) is needs_auth too", async () => {
  F.stub(F.at(HOST, "/api/v1/accounts/verify_credentials", F.MASTO_NO_SCOPE, 403));
  const err = await openMastodon(connector(), secrets, "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "That token can't read your posts. Make a new application with read ticked, and paste its access token here." });
});

test("no token saved: needs_auth before any lookup or request", async () => {
  F.stub();
  const err = await openMastodon(connector(), {}, "UTC").catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
  assert.equal(F.calls.length, 0);
  assert.deepEqual(looked, []);
});

test("a server that's down: retried, then a passing error", async () => {
  F.stub(me, F.at(HOST, "/api/v1/accounts/13179/statuses", { error: "Bad gateway" }, 502));
  const acct = await openMastodon(connector(), secrets, "UTC");
  const err = await acct.call("my_posts", { date: "2026-11-06" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "error", detail: "mastodon.social is having trouble right now. Try again in a few minutes." });
});

test("plain text: entities, breaks and hidden link parts", () => {
  assert.equal(plainText("<p>a &lt;b&gt; &#x1F600; &nbsp;c</p>"), "a <b> 😀  c");
  assert.equal(plainText(undefined), "");
});

test("Ask names each link: posts as posts, replies as comments", async () => {
  F.stub(me, statuses);
  const acct = await openMastodon(connector(), secrets, "UTC");
  const kinds = itemKinds("mastodon", (await acct.call("my_posts", { date: "2026-11-06" })).text);
  assert.equal(kinds["https://mastodon.social/@jordan/117470000000000005"].kind, "post");
  assert.equal(kinds["https://mastodon.social/@jordan/117470000000000003"].kind, "comment");
});

test("a Life log run reads it, and precheck sees whether anything's new", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  const { glance } = await import("./precheck");
  F.stub(me, statuses);
  const c = { ...connector(), allowed_tools: ["my_posts"] } as Connector;
  const open = { connector: c, direct: await openMastodon(c, secrets, "UTC"), close: async () => undefined } as OpenConnector;
  assert.deepEqual((await listAllowedTools(open)).map((t) => t.name), ["my_posts"]);
  assert.equal(JSON.parse((await callTool(open, "my_posts", { date: "2026-11-06" })).text).count, 2);
  assert.equal((await glance(open, new Set(["my_posts"]), new Date("2026-11-06T12:00:00Z"), "UTC")).count, 1);
  assert.equal((await glance(open, new Set(["my_posts"]), new Date("2026-11-06T23:00:00Z"), "UTC")).count, 0);
});
