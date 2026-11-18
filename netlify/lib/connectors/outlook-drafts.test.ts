// Run: npx tsx --test netlify/lib/connectors/outlook-drafts.test.ts
// Outlook drafts: the only mail write Athena makes to Microsoft Graph, its exact shape, and everything it refuses.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canDraft, OUTLOOK_DRAFT_SCOPE, presetFor } from "../../../lib/connector-presets";
import * as F from "./fixtures/microsoft-graph";
import { microsoftTools, openMicrosoft } from "./microsoft-direct";
import { GRAPH, GraphSession, graphRetryWaits, isDraftCreate } from "./microsoft-graph";
import { outlookDraftRequest } from "./microsoft-mail";
import { callTool, type OpenConnector } from "./mcp-client";

type Reply = { status?: number; body: unknown };
type Route = (url: URL, init: RequestInit) => Reply | undefined;
const realFetch = globalThis.fetch;
let routes: Route[] = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  routes = [];
  graphRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`No fixture for ${init.method ?? "GET"} ${url.pathname}${url.search}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const path = (p: string, body: unknown, method = "GET"): Route => (url, init) => (url.pathname === `/v1.0${p}` && (init.method ?? "GET") === method ? { body } : undefined);
const mailbox: Route[] = [path("/me", F.ME), path("/me/mailFolders/inbox", F.FOLDERS.inbox)];
const fresh = { access_token: "at", refresh_token: "rt", expires_in: 3600, obtained_at: Date.now() };
const secrets = (): ConnectorSecrets => ({ ownClient: { client_id: "app-id", client_secret: "app-secret" }, tokens: { ...fresh } });

function outlook(drafts: boolean): Connector {
  const p = presetFor("outlook-mail");
  return {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Outlook",
    provider: "outlook-mail",
    account_label: "work",
    url: p.url,
    auth_type: "oauth",
    scope: drafts ? `${p.scope} ${OUTLOOK_DRAFT_SCOPE}` : p.scope,
    status: "connected",
    status_detail: "",
    tools: [],
    allowed_tools: p.readTools,
    tools_checked_at: null,
    last_used_at: null,
    server_info: {},
    oauth: {},
    has_token: true,
    has_own_client: true,
    has_client_secret: true,
    created_at: "",
    updated_at: "",
  };
}

const to = [{ emailAddress: { address: "priya@example.com" } }];
const newDraft = { subject: "Q4 budget", body: { contentType: "Text", content: "Hi Priya" }, toRecipients: to };

test("drafts are a switch per account: off by default, Mail.ReadWrite when on, never Mail.Send", () => {
  assert.equal(OUTLOOK_DRAFT_SCOPE, "Mail.ReadWrite");
  assert.ok(!presetFor("outlook-mail").scope.includes("ReadWrite"));
  assert.equal(canDraft(outlook(false)), false);
  assert.equal(canDraft(outlook(true)), true);
  // Calendar's write permission doesn't count as drafts.
  assert.equal(canDraft({ provider: "outlook-calendar", scope: "Mail.ReadWrite" }), false);
  assert.ok(!/Mail\.Send/.test(outlook(true).scope));
  assert.deepEqual(microsoftTools(outlook(false)).map((t) => t.name), ["search_threads", "get_thread", "get_message", "list_labels"]);
  assert.deepEqual(microsoftTools(outlook(true)).map((t) => t.name), ["search_threads", "get_thread", "get_message", "list_labels", "create_draft"]);
});

test("isDraftCreate: a new draft or a draft reply, exactly", () => {
  assert.equal(isDraftCreate(`${GRAPH}/me/messages`, newDraft), true);
  assert.equal(isDraftCreate(`${GRAPH}/me/messages/AAMkAG=/createReply`, { comment: "Thanks!" }), true);
  assert.equal(isDraftCreate(`${GRAPH}/me/messages/AAMkAG=/createReply`, { comment: "Thanks!", message: { toRecipients: to } }), true);
});

test("isDraftCreate refuses every send, reply, forward and move", () => {
  for (const url of [
    `${GRAPH}/me/sendMail`,
    `${GRAPH}/me/messages/AAMkAG=/send`,
    `${GRAPH}/me/messages/AAMkAG=/reply`,
    `${GRAPH}/me/messages/AAMkAG=/replyAll`,
    `${GRAPH}/me/messages/AAMkAG=/forward`,
    `${GRAPH}/me/messages/AAMkAG=/createForward`,
    `${GRAPH}/me/messages/AAMkAG=/createReplyAll`,
    `${GRAPH}/me/messages/AAMkAG=/move`,
    `${GRAPH}/me/messages/AAMkAG=/copy`,
    `${GRAPH}/me/mailFolders/drafts/messages`,
    `${GRAPH}/me/messages?$select=id`,
    `${GRAPH}/me/messages/`,
    `${GRAPH}/users/someone@example.com/messages`,
    `${GRAPH}/me/messages/a/b/createReply`,
    "https://graph.microsoft.com/beta/me/messages",
    "https://evil.example/v1.0/me/messages",
  ]) {
    assert.equal(isDraftCreate(url, newDraft), false, url);
    assert.equal(isDraftCreate(url, { comment: "x" }), false, url);
  }
});

test("isDraftCreate refuses any field beyond the words and who it's to", () => {
  const url = `${GRAPH}/me/messages`;
  assert.equal(isDraftCreate(url, { ...newDraft, ccRecipients: to }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, bccRecipients: to }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, attachments: [] }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, isDraft: false }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, body: { contentType: "HTML", content: "<b>x</b>" } }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, body: { contentType: "Text", content: "x", extra: 1 } }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, toRecipients: [{ emailAddress: { address: "a@b.io" }, type: "bcc" }] }), false);
  assert.equal(isDraftCreate(url, { ...newDraft, toRecipients: "a@b.io" }), false);
  assert.equal(isDraftCreate(url, { subject: "x", body: newDraft.body }), false);
  assert.equal(isDraftCreate(url, null), false);
  const reply = `${GRAPH}/me/messages/AAMkAG=/createReply`;
  assert.equal(isDraftCreate(reply, { comment: "x", message: { toRecipients: to, ccRecipients: to } }), false);
  assert.equal(isDraftCreate(reply, { comment: "x", message: { body: { contentType: "Text", content: "y" } } }), false);
  assert.equal(isDraftCreate(reply, { comment: 1 }), false);
  assert.equal(isDraftCreate(reply, {}), false);
});

test("create_draft's arguments become exactly those shapes, and nothing else gets through", () => {
  assert.deepEqual(outlookDraftRequest({ to: ["priya@example.com"], subject: "Q4 budget", body: "Hi Priya", includeSignature: true }), { url: `${GRAPH}/me/messages`, body: newDraft });
  assert.deepEqual(outlookDraftRequest({ to: ["priya@example.com"], subject: "Re: x", body: "Thanks!", replyToMessageId: "AAMkAG=" }), {
    url: `${GRAPH}/me/messages/AAMkAG%3D/createReply`,
    body: { comment: "Thanks!", message: { toRecipients: to } },
  });
  // The message id is encoded, so it can't add a path of its own.
  const sneaky = outlookDraftRequest({ body: "x", replyToMessageId: "abc/send" });
  assert.equal(sneaky.url, `${GRAPH}/me/messages/abc%2Fsend/createReply`);
  assert.equal(isDraftCreate(sneaky.url, sneaky.body), false);
  for (const k of ["cc", "bcc", "attachments", "htmlBody"]) assert.throws(() => outlookDraftRequest({ to: [], body: "x", [k]: ["a@b.io"] }), new RegExp(k));
  assert.throws(() => outlookDraftRequest({ to: ["Priya <priya@example.com>"], body: "x" }), /isn't a plain email address/);
});

test("GraphSession.createDraft refuses a non-draft before anything leaves Athena", async () => {
  const session = new GraphSession(outlook(true), secrets());
  await assert.rejects(session.createDraft(`${GRAPH}/me/sendMail`, newDraft as never), /never sends/);
  await assert.rejects(session.createDraft(`${GRAPH}/me/messages/AAMkAG=/send`, { comment: "x" }), /never sends/);
  await assert.rejects(session.createDraft(`${GRAPH}/me/messages`, { ...newDraft, ccRecipients: to } as never), /never sends/);
  assert.equal(calls.length, 0);
});

test("create_draft on an account with drafts on: one POST to /me/messages, in that shape", async () => {
  routes = [...mailbox, path("/me/messages", { id: "draft-1", conversationId: "conv-1", webLink: "https://outlook.office365.com/owa/?ItemID=draft-1" }, "POST")];
  const account = await openMicrosoft(outlook(true), secrets());
  const r = await account.call("create_draft", { to: ["priya@example.com"], subject: "Q4 budget", body: "Hi Priya" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text), { id: "draft-1", threadId: "conv-1", viewUrl: "https://outlook.office365.com/owa/?ItemID=draft-1" });
  const posts = calls.filter((c) => c.init.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.toString(), `${GRAPH}/me/messages`);
  assert.deepEqual(JSON.parse(String(posts[0].init.body)), newDraft);
});

test("without drafts on, create_draft isn't there and nothing is posted", async () => {
  routes = [...mailbox];
  const account = await openMicrosoft(outlook(false), secrets());
  const r = await account.call("create_draft", { to: ["priya@example.com"], subject: "x", body: "y" });
  assert.equal(r.isError, true);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 0);
});

test("callTool refuses send, reply and forward by name, and drafts for an account without them", async () => {
  routes = [...mailbox];
  const open = { connector: outlook(false), direct: await openMicrosoft(outlook(false), secrets()), close: async () => undefined } as unknown as OpenConnector;
  for (const name of ["send_message", "send_draft", "send_mail", "reply", "reply_all", "forward", "create_reply.send"]) {
    await assert.rejects(callTool(open, name, {}), /never sends/, name);
  }
  await assert.rejects(callTool(open, "create_draft", { to: [], body: "x" }), /Drafts aren't turned on/);
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 0);
});
