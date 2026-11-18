// Run: npx tsx --test netlify/lib/connectors/{readwise,bluesky,mastodon}-direct.test.ts
// Readwise over its v2 API, with fetch stubbed and recorded replies (fixtures/reading-social-recorded.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import * as F from "./fixtures/reading-social-recorded";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { openReadwise, readwiseAdapter, sourceName } from "./readwise-direct";
import { itemKinds } from "./answer-sources";
import type { OpenConnector } from "./mcp-client";

const HOST = "readwise.io";
const connector = (extra: Partial<Connector> = {}) => ({ id: "rw1", name: "Readwise", provider: "readwise", auth_type: "token", url: "https://readwise.io/api/v2", scope: "", ...extra }) as Connector;
const secrets: ConnectorSecrets = { token: "rw_token_0123456789" };
const auth = F.at(HOST, "/api/v2/auth/", {}, 204);
/** Export pages by cursor: none → page 1 (Wager, essay; more to come), "p2" → page 2 (Apple Books). */
const exportPages = F.at(HOST, "/api/v2/export/", (url) =>
  url.searchParams.get("pageCursor") === "p2" ? { count: 1, nextPageCursor: null, results: [F.APPLE] } : { count: 3, nextPageCursor: "p2", results: [F.ESSAY, F.WAGER] },
);

beforeEach(() => {
  lifeRetryWaits.ms = [1, 1];
});
afterEach(() => F.unstub());

const run = async (tool: string, args: Record<string, unknown>, tz = "Europe/London") => JSON.parse((await (await openReadwise(connector(), secrets, tz)).call(tool, args)).text);

test("preset: Readwise Reader is Readwise's own MCP server, read scope only, for Ask and not the Life log; its writes are refused", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "readwise-reader")!;
  assert.equal(p.category, "entertainment");
  assert.equal(p.url, "https://mcp2.readwise.io/mcp");
  assert.equal(p.auth, "oauth");
  assert.equal(p.scope, "read");
  assert.ok(!p.needsOwnClient, "Athena registers itself");
  assert.deepEqual(p.recipes, ["custom"]);
  assert.equal(directFor({ provider: "readwise-reader", auth_type: "oauth", oauth: {} }), undefined);
  // Readwise's tools as its docs describe them: the ones that change anything never classify as reads.
  for (const t of ["create_document", "add_tags_to_document", "remove_tags_from_highlight", "move_documents", "bulk_edit_document_metadata", "create_highlight", "delete_highlight", "update_highlight", "add_highlight_note"])
    assert.equal(classifyTool("readwise-reader", t), "write", t);
  assert.equal(classifyTool("readwise-reader", "search_documents", { readOnlyHint: true }), "read");
});

test("preset: Readwise sits in Entertainment, feeds the Life log, reads only, and Athena calls it directly", () => {
  const p = CONNECTOR_PRESETS.find((x) => x.id === "readwise")!;
  assert.equal(p.category, "entertainment");
  assert.equal(p.auth, "token");
  assert.deepEqual(p.recipes, ["life-log", "plays-watches", "custom"]);
  assert.deepEqual(p.readTools, readwiseAdapter.tools(connector()).map((t) => t.name));
  for (const t of readwiseAdapter.tools(connector())) assert.equal(classifyTool("readwise", t.name, t.annotations), "read");
  assert.equal(directFor(connector()), readwiseAdapter);
  assert.ok(directApi(connector()));
});

test("list_highlights: one day by when it reached Readwise, grouped by book, most first; discarded ones left out; the token goes as Token", async () => {
  F.stub(auth, exportPages);
  const out = await run("list_highlights", { date: "2026-11-06", by: "added" });
  assert.equal(out.count, 4);
  assert.equal(out.books, 2);
  assert.equal(out.by, "added");
  assert.deepEqual(
    out.items.map((b: Record<string, unknown>) => [b.title, b.author, b.kind, b.source, b.highlights_count, b.link]),
    [
      ["The Wager", "David Grann", "book", "Kindle", 3, "https://readwise.io/bookreview/41"],
      ["How to Do Great Work", "Paul Graham", "article", "Reader", 1, "https://paulgraham.com/greatwork.html"],
    ],
  );
  const wager = out.items[0].highlights;
  assert.deepEqual(wager[1], { text: "The sea was a great leveller.", note: "Like the café scene", highlighted_on: "2026-11-06", time: "21:10", added_on: "2026-11-06", link: "https://readwise.io/open/1001" });
  assert.deepEqual(wager[2].tags, ["history"]);
  assert.ok(!JSON.stringify(out).includes("A line he deleted"));
  // Readwise is asked from just before the day starts in London (GMT in November).
  const exp = F.calls.find((c) => c.url.pathname === "/api/v2/export/")!;
  assert.equal(exp.url.searchParams.get("updatedAfter"), "2026-11-05T23:59:59.000Z");
  assert.equal((exp.init.headers as Record<string, string>).Authorization, "Token rw_token_0123456789");
  assert.ok(F.calls.every((c) => c.url.host === HOST && (c.init.method ?? "GET") === "GET"));
  assert.equal(out.next_cursor !== undefined, true);
});

test("list_highlights: by default a highlight is on the day it was made; by added finds a late Kindle sync and names its day", async () => {
  F.stub(auth, exportPages);
  // 5 Nov: the Kindle highlight made that evening, though it reached Readwise on the 6th.
  const read = await run("list_highlights", { date: "2026-11-05" });
  assert.equal(read.by, "highlighted");
  assert.equal(read.count, 1);
  assert.equal(read.items[0].highlights[0].text, "Mutiny is a matter of perspective.");
  assert.equal(read.items[0].highlights[0].added_on, "2026-11-06");
  assert.deepEqual(read.days, ["2026-11-05"]);
  // 6 Nov by default: only what was made that day.
  const made = await run("list_highlights", { date: "2026-11-06" });
  assert.equal(made.count, 3);
  // What reached Readwise since the 6 Nov run started points back at the 5th too, so the run rewrites both days.
  const fresh = await run("list_highlights", { after: "2026-11-06T00:00:00Z", by: "added", text: false });
  assert.deepEqual(fresh.days, ["2026-11-05", "2026-11-06"]);
  assert.equal(fresh.count, 4);
});

test("list_highlights: text false gives the Life log counts per book, without the words", async () => {
  F.stub(auth, exportPages);
  const out = await run("list_highlights", { date: "2026-11-06", text: false, by: "added" });
  assert.equal(out.items[0].highlights_count, 3);
  for (const word of ["leveller", "Scurvy", "café", "Curiosity", "readwise.io/open"]) assert.ok(!JSON.stringify(out).includes(word), word);
});

test("list_highlights: pages on with Readwise's own cursor until it runs out", async () => {
  F.stub(auth, exportPages);
  const first = await run("list_highlights", { after: "2026-10-01", before: "2026-11-07" });
  assert.equal(first.count, 5);
  const second = await run("list_highlights", { after: "2026-10-01", before: "2026-11-07", cursor: first.next_cursor });
  assert.equal(F.calls.filter((c) => c.url.pathname === "/api/v2/export/").at(-1)!.url.searchParams.get("pageCursor"), "p2");
  assert.deepEqual(
    second.items.map((b: Record<string, unknown>) => [b.title, b.source]),
    [["Four Thousand Weeks", "Apple Books"]],
  );
  assert.equal(second.next_cursor, undefined);
  // Another tool's cursor isn't taken.
  const acct = await openReadwise(connector(), secrets, "UTC");
  assert.equal((await acct.call("search_highlights", { query: "x", cursor: first.next_cursor })).isError, true);
});

test("list_highlights: no window means the last week, never the whole library", async () => {
  F.stub(auth, exportPages);
  await run("list_highlights", {});
  const after = Date.parse(F.calls.find((c) => c.url.pathname === "/api/v2/export/")!.url.searchParams.get("updatedAfter")!);
  assert.ok(Math.abs(Date.now() - 7 * 86_400_000 - after) < 60_000);
});

test("search_highlights: every word, in text, note, tags, title or author, accents ignored, across pages", async () => {
  F.stub(auth, exportPages);
  const cafe = await run("search_highlights", { query: "cafe" });
  assert.deepEqual(
    cafe.items.map((h: Record<string, unknown>) => [h.book, h.text]),
    [["The Wager", "The sea was a great leveller."]],
  );
  assert.equal((await run("search_highlights", { query: "paul curiosity" })).items[0].book_link, "https://paulgraham.com/greatwork.html");
  assert.equal((await run("search_highlights", { query: "craft" })).count, 2);
  assert.equal((await run("search_highlights", { query: "history scurvy" })).count, 1);
  // Page 2 is read too: the Apple Books highlight is found.
  const weeks = await run("search_highlights", { query: "control" });
  assert.equal(weeks.items[0].book, "Four Thousand Weeks");
  assert.equal(weeks.next_cursor, undefined);
  const none = await run("search_highlights", { query: "zebra" });
  assert.deepEqual(none.items, []);
  assert.equal(none.count, 0);
});

test("search_highlights: a query is required", async () => {
  F.stub(auth, exportPages);
  const acct = await openReadwise(connector(), secrets, "UTC");
  const r = await acct.call("search_highlights", {});
  assert.deepEqual(r, { text: "query is required", isError: true });
});

test("a token Readwise doesn't know (its real 401) is needs_auth, with a plain fix", async () => {
  F.stub(F.at(HOST, "/api/v2/auth/", F.READWISE_BAD_TOKEN, 401));
  const err = await openReadwise(connector(), secrets, "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), {
    status: "needs_auth",
    detail: "Readwise didn't accept the access token. Copy it again at readwise.io/access_token and paste the new one here.",
  });
  assert.ok(readwiseAdapter.accountProblem(err));
});

test("a token revoked mid-run is an account problem, not a tool error", async () => {
  F.stub(auth, F.at(HOST, "/api/v2/export/", F.READWISE_BAD_TOKEN, 401));
  const acct = await openReadwise(connector(), secrets, "UTC");
  const err = await acct.call("list_highlights", { date: "2026-11-06" }).catch((e) => e);
  assert.equal(directFailure(err)?.status, "needs_auth");
});

test("no token saved: needs_auth before any request", async () => {
  F.stub();
  const err = await openReadwise(connector(), {}, "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Paste your Readwise access token." });
  assert.equal(F.calls.length, 0);
});

test("429 is waited out and retried", async () => {
  let n = 0;
  F.stub(auth, (url) => (url.pathname === "/api/v2/export/" ? (n++ === 0 ? { status: 429, body: { detail: "Request was throttled." }, headers: { "Retry-After": "0" } } : { body: { count: 0, nextPageCursor: null, results: [] } }) : undefined));
  const out = await run("list_highlights", { date: "2026-11-06" });
  assert.deepEqual(out.items, []);
  assert.equal(n, 2);
});

test("source names read as people say them", () => {
  assert.equal(sourceName("kindle"), "Kindle");
  assert.equal(sourceName("ibooks"), "Apple Books");
  assert.equal(sourceName("reader"), "Reader");
  assert.equal(sourceName("some_new_app"), "Some new app");
  assert.equal(sourceName(undefined), undefined);
});

test("Ask names each link: books as books, articles as pages", async () => {
  F.stub(auth, exportPages);
  const acct = await openReadwise(connector(), secrets, "UTC");
  const kinds = itemKinds("readwise", (await acct.call("list_highlights", { date: "2026-11-06", by: "added" })).text);
  assert.equal(kinds["https://readwise.io/bookreview/41"].kind, "book");
  assert.equal(kinds["https://paulgraham.com/greatwork.html"].kind, "page");
});

test("a Life log run reads it, and precheck counts what's new since the last run", async () => {
  const { listAllowedTools, callTool } = await import("./mcp-client");
  const { glance } = await import("./precheck");
  F.stub(auth, exportPages);
  const c = { ...connector(), allowed_tools: ["list_highlights", "search_highlights"] } as Connector;
  const open = { connector: c, direct: await openReadwise(c, secrets, "UTC"), close: async () => undefined } as OpenConnector;
  assert.deepEqual((await listAllowedTools(open)).map((t) => t.name), ["list_highlights", "search_highlights"]);
  const r = await callTool(open, "list_highlights", { date: "2026-11-06", text: false, by: "added" });
  assert.equal(JSON.parse(r.text).items[0].title, "The Wager");
  assert.ok(((await glance(open, new Set(["list_highlights"]), new Date("2026-11-06T00:00:00Z"), "UTC")).count ?? 0) > 0);
  // The glance asks what reached Readwise since the last run, so a late Kindle sync wakes the run.
  assert.equal(F.calls.filter((c) => c.url.pathname === "/api/v2/export/").at(-1)!.url.searchParams.get("updatedAfter"), "2026-11-05T23:59:59.000Z");
  F.stub(auth, F.at(HOST, "/api/v2/export/", { count: 0, nextPageCursor: null, results: [] }));
  assert.equal((await glance(open, new Set(["list_highlights"]), new Date("2026-11-07T00:00:00Z"), "UTC")).count, 0);
});
