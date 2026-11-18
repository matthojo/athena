// Run: npx tsx --test netlify/lib/connectors/{readwise,bluesky,mastodon}-direct.test.ts
// Bluesky over the public AppView, with fetch stubbed and recorded replies (fixtures/reading-social-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import * as F from "./fixtures/reading-social-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { blueskyAdapter, blueskyProfileUrl, openBluesky } from "./bluesky-direct";
import { itemKinds } from "./answer-sources";
import type { OpenConnector } from "./mcp-client";

const HOST = "public.api.bsky.app";
const connector = (url = "https://bsky.app/profile/jordan.bsky.social") => ({ id: "bs1", name: "Bluesky", provider: "bluesky", auth_type: "none", url, scope: "" }) as Connector;
const profile = F.at(HOST, "/xrpc/app.bsky.actor.getProfile", F.BSKY_PROFILE);
/** Page 1, page 2, then the end of the feed (an empty page, as Bluesky sends). */
const feed = F.at(HOST, "/xrpc/app.bsky.feed.getAuthorFeed", (url) => {
  const c = url.searchParams.get("cursor");
  return !c ? F.BSKY_PAGE_1 : c === F.BSKY_PAGE_1.cursor ? F.BSKY_PAGE_2 : { feed: [] };
});

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
});
afterEach(() => F.unstub());

const run = async (args: Record<string, unknown>, tz = "Europe/London") => JSON.parse((await (await openBluesky(connector(), {}, tz)).call("my_posts", args)).text);

test("preset: Bluesky sits in Social, feeds the Life log, needs no sign-in, and reads only", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "bluesky")!;
  assert.equal(p.category, "social");
  assert.equal(p.auth, "none");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.deepEqual(p.readTools, ["my_posts"]);
  assert.equal(classifyTool("bluesky", "my_posts", blueskyAdapter.tools(connector())[0].annotations), "read");
  assert.equal(directFor(connector()), blueskyAdapter);
  assert.ok(directApi(connector()));
});

test("address: a profile or post link, @handle, bare name or DID becomes the profile link", () => {
  const ok: Array<[string, string]> = [
    ["https://bsky.app/profile/Jordan.bsky.social", "https://bsky.app/profile/jordan.bsky.social"],
    ["bsky.app/profile/jordan.bsky.social/post/3mznvxo7so22q", "https://bsky.app/profile/jordan.bsky.social"],
    ["@jordan.bsky.social", "https://bsky.app/profile/jordan.bsky.social"],
    ["jordan.dev", "https://bsky.app/profile/jordan.dev"],
    ["jordan", "https://bsky.app/profile/jordan.bsky.social"],
    [`https://bsky.app/profile/${F.BSKY_DID}`, `https://bsky.app/profile/${F.BSKY_DID}`],
  ];
  for (const [raw, want] of ok) assert.equal(blueskyProfileUrl(raw), want, raw);
  for (const bad of ["", "https://evil.example/profile/jordan.bsky.social", "https://bsky.app.evil.example/profile/x.bsky.social", "javascript:alert(1)", "https://bsky.app/search?q=x", "not a handle!", "https://user:pw@bsky.app/profile/a.bsky.social", "123"]) {
    assert.throws(() => blueskyProfileUrl(bad), /Bluesky|profile link/, bad);
  }
});

test("my_posts: one day of your own posts and replies; reposts left out, quote posts kept", async () => {
  F.stub(profile, feed);
  const out = await run({ date: "2026-11-06" });
  assert.equal(out.count, 2);
  assert.equal(out.posts, 1);
  assert.equal(out.replies, 1);
  assert.deepEqual(out.items[0], {
    kind: "reply",
    text: "this is so cool",
    date: "2026-11-06",
    time: "17:31",
    link: "https://bsky.app/profile/jordan.bsky.social/post/3mznvxo7so22q",
    in_reply_to: "https://bsky.app/profile/did:plc:djuj57armcsoyzmdfeg7i4qf/post/3mznvf4jkdc2m",
    likes: 70,
    reposts: 3,
    replies: 2,
  });
  assert.equal(out.items[1].quote, true);
  assert.equal(out.items[1].quoting, "https://bsky.app/profile/did:plc:djuj57armcsoyzmdfeg7i4qf/post/3mzkeyquote");
  const text = JSON.stringify(out);
  assert.ok(!text.includes("Capuchinbird") && !text.includes("plan to vote"), "reposts are left out");
  assert.ok(!text.includes("someone.bsky.social"), "other people's handles never come back");
  // One page was enough: the 4 Nov post ends the day.
  assert.equal(F.calls.filter((c) => c.url.pathname.endsWith("getAuthorFeed")).length, 1);
  const q = F.calls.find((c) => c.url.pathname.endsWith("getAuthorFeed"))!.url.searchParams;
  assert.equal(q.get("actor"), F.BSKY_DID);
  assert.equal(q.get("filter"), "posts_with_replies");
  assert.ok(F.calls.every((c) => c.url.host === HOST && (c.init.method ?? "GET") === "GET"));
  assert.ok(F.calls.every((c) => !(c.init.headers as Record<string, string>).Authorization), "nothing signed");
});

test("my_posts: a repost of an old post doesn't end the window early; pages on with Bluesky's cursor", async () => {
  F.stub(profile, feed);
  const out = await run({ after: "2026-11-01", before: "2026-11-07" });
  assert.deepEqual(
    out.items.map((p: Record<string, unknown>) => p.date),
    ["2026-11-06", "2026-11-06", "2026-11-04", "2026-11-03"],
  );
  assert.equal(out.items[2].images, 1);
  // Embedding a starter pack isn't a quote.
  assert.equal(out.items[3].quote, undefined);
  assert.equal(F.calls.filter((c) => c.url.pathname.endsWith("getAuthorFeed")).length, 2);
  assert.equal(out.next_cursor, undefined);
});

test("my_posts: a limit mid-page picks up where it stopped, nothing twice", async () => {
  F.stub(profile, feed);
  const a = await run({ after: "2026-10-01", limit: 2 });
  const b = await run({ after: "2026-10-01", limit: 2, cursor: a.next_cursor });
  const c = await run({ after: "2026-10-01", limit: 2, cursor: b.next_cursor });
  const links = [...a.items, ...b.items, ...c.items].map((p: Record<string, unknown>) => p.link);
  assert.equal(links.length, 5);
  assert.equal(new Set(links).size, 5);
  assert.equal(c.items[0].shared_link, "https://bsky.social/about/blog");
  assert.equal(c.next_cursor, undefined);
});

test("my_posts: replies false leaves replies out", async () => {
  F.stub(profile, feed);
  const out = await run({ date: "2026-11-06", replies: false });
  assert.deepEqual(
    out.items.map((p: Record<string, unknown>) => p.kind),
    ["post"],
  );
});

test("a handle nobody has (Bluesky's real reply) is needs_auth with a plain fix", async () => {
  F.stub(F.at(HOST, "/xrpc/app.bsky.actor.getProfile", F.BSKY_NOT_FOUND, 400));
  const err = await openBluesky(connector("https://bsky.app/profile/nobody-xyz-123.bsky.social"), {}, "UTC").catch((e) => e);
  const f = directFailure(err)!;
  assert.equal(f.status, "needs_auth");
  assert.match(f.detail, /^Bluesky can't find @nobody-xyz-123\.bsky\.social\. Check the handle/);
});

test("posts hidden from logged-out apps (a 401) is needs_auth, saying which setting to change", async () => {
  F.stub(profile, F.at(HOST, "/xrpc/app.bsky.feed.getAuthorFeed", { error: "AuthRequired", message: "Authentication Required" }, 401));
  const acct = await openBluesky(connector(), {}, "UTC");
  const err = await acct.call("my_posts", { date: "2026-11-06" }).catch((e) => e);
  const f = directFailure(err)!;
  assert.equal(f.status, "needs_auth");
  assert.match(f.detail, /Logged-out visibility/);
});

test("Bluesky busy: retried, then a passing error, not a sign-in problem", async () => {
  F.stub(profile, F.at(HOST, "/xrpc/app.bsky.feed.getAuthorFeed", { error: "InternalServerError" }, 502));
  const acct = await openBluesky(connector(), {}, "UTC");
  const err = await acct.call("my_posts", { date: "2026-11-06" }).catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "error", detail: "Bluesky is having trouble right now. Try again in a few minutes." });
  assert.equal(F.calls.filter((c) => c.url.pathname.endsWith("getAuthorFeed")).length, 3);
});

test("Ask names each link: posts as posts, replies as comments", async () => {
  F.stub(profile, feed);
  const acct = await openBluesky(connector(), {}, "UTC");
  const kinds = itemKinds("bluesky", (await acct.call("my_posts", { date: "2026-11-06" })).text);
  assert.equal(kinds["https://bsky.app/profile/jordan.bsky.social/post/3mznvxo7so22q"].kind, "comment");
  assert.equal(kinds["https://bsky.app/profile/jordan.bsky.social/post/3mznquote22a"].kind, "post");
});

test("a Life log run reads it, and precheck sees whether anything's new", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  const { glance } = await import("./precheck");
  F.stub(profile, feed);
  const c = { ...connector(), allowed_tools: ["my_posts"] } as Connector;
  const open = { connector: c, direct: await openBluesky(c, {}, "UTC"), close: async () => undefined } as OpenConnector;
  assert.deepEqual((await listAllowedTools(open)).map((t) => t.name), ["my_posts"]);
  assert.equal(JSON.parse((await callTool(open, "my_posts", { date: "2026-11-06" })).text).count, 2);
  assert.equal((await glance(open, new Set(["my_posts"]), new Date("2026-11-06T12:00:00Z"), "UTC")).count, 1);
  assert.equal((await glance(open, new Set(["my_posts"]), new Date("2026-11-06T22:00:00Z"), "UTC")).count, 0);
});
