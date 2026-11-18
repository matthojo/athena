// Run: npx tsx --test netlify/lib/connectors/microsoft.test.ts
// Outlook over Microsoft Graph, with fetch stubbed and recorded Graph replies (fixtures/microsoft-graph.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, googleDirect, presetFor } from "../../../lib/connector-presets";
import * as F from "./fixtures/microsoft-graph";
import { directFor, directFailure } from "./direct";
import { googleAdapter } from "./google-direct";
import { authorizationUrl as googleAuthorizationUrl } from "./google-api";
import { microsoftAdapter, microsoftAccountProblem, microsoftFailure, openMicrosoft } from "./microsoft-direct";
import { graphRetryWaits, MicrosoftTokenError, tokenStore } from "./microsoft-graph";
import { parseGmailQuery } from "./microsoft-mail";
import { glance, parseGmailThreads } from "./precheck";
import type { OpenConnector } from "./mcp-client";

// ---------- a fetch stub that answers from the fixtures ----------

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };
type Route = (url: URL, init: RequestInit) => Reply | undefined;
const realFetch = globalThis.fetch;
let routes: Route[] = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];

function stub(...r: Route[]) {
  routes = r;
}

beforeEach(() => {
  calls = [];
  routes = [];
  graphRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json", ...reply.headers } });
    }
    throw new Error(`No fixture for ${init.method ?? "GET"} ${url.pathname}${url.search}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const path = (p: string | RegExp, body: unknown, status = 200): Route => (url) =>
  (typeof p === "string" ? url.pathname === `/v1.0${p}` : p.test(url.pathname)) ? { status, body } : undefined;

/** The mailbox's folders, /me and its probe: what every mail test needs. */
const mailbox: Route[] = [
  path("/me", F.ME),
  (url) => {
    const m = /^\/v1\.0\/me\/mailFolders\/(\w+)$/.exec(url.pathname);
    return m && F.FOLDERS[m[1]] ? { body: F.FOLDERS[m[1]] } : undefined;
  },
  path("/me/mailFolders", F.FOLDER_LIST),
];

const now = () => new Date("2026-11-06T12:00:00Z");
const fresh = { access_token: "at-old", refresh_token: "rt-old", expires_in: 3600, obtained_at: Date.now() };

function connector(provider: "outlook-mail" | "outlook-calendar", over: Partial<Connector> = {}): Connector {
  const p = presetFor(provider);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: p.label,
    provider,
    account_label: "work",
    url: p.url,
    auth_type: "oauth",
    scope: p.scope,
    status: "connected",
    status_detail: "",
    tools: [],
    allowed_tools: p.readTools,
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
  };
}

const secrets = (tokens: Record<string, unknown> = fresh): ConnectorSecrets => ({ ownClient: { client_id: "app-id", client_secret: "app-secret" }, tokens: { ...tokens } });

async function call(provider: "outlook-mail" | "outlook-calendar", name: string, args: Record<string, unknown> = {}) {
  const account = await openMicrosoft(connector(provider), secrets(), now);
  const r = await account.call(name, args);
  return { ...r, json: r.isError ? null : JSON.parse(r.text) };
}

// ---------- presets and the registry ----------

test("two Outlook presets: own Entra app, Graph, delegated read scopes only", () => {
  for (const id of ["outlook-mail", "outlook-calendar"]) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id)!;
    assert.ok(p, id);
    assert.equal(p.url, "https://graph.microsoft.com/v1.0");
    assert.equal(p.needsOwnClient, true);
    assert.equal(p.ownClientLabel, "Microsoft");
    assert.equal(p.category, "email-calendar");
    for (const s of p.scope.split(" ")) assert.ok(["offline_access", "User.Read", "Mail.Read", "Calendars.Read"].includes(s), `${id}: ${s}`);
  }
  assert.deepEqual(presetFor("outlook-mail").readTools, presetFor("gmail").readTools);
  assert.deepEqual(presetFor("outlook-calendar").readTools, presetFor("google-calendar").readTools);
});

test("the registry sends Google to Google, Outlook to Microsoft, everything else to MCP", () => {
  assert.equal(directFor({ provider: "gmail", auth_type: "oauth", oauth: {} }), googleAdapter);
  assert.equal(directFor({ provider: "google-calendar", auth_type: "oauth", oauth: {} }), googleAdapter);
  assert.equal(directFor({ provider: "gmail", auth_type: "oauth", oauth: { google_route: "mcp" } }), undefined);
  assert.equal(directFor({ provider: "outlook-mail", auth_type: "oauth", oauth: {} }), microsoftAdapter);
  assert.equal(directFor({ provider: "outlook-calendar", auth_type: "oauth", oauth: {} }), microsoftAdapter);
  assert.equal(directFor({ provider: "outlook-mail", auth_type: "token", oauth: {} }), undefined);
  assert.equal(directFor({ provider: "slack", auth_type: "oauth", oauth: {} }), undefined);
  // Google's predicate and sign-in page are what they were.
  assert.equal(googleAdapter.handles, googleDirect);
  const input = { clientId: "c", redirectUri: "https://athena.example/cb", scope: "s", state: "st", challenge: "ch" };
  assert.equal(googleAdapter.authorizationUrl!(input), googleAuthorizationUrl(input));
  assert.deepEqual(
    googleAdapter.tools({ provider: "gmail", scope: "https://www.googleapis.com/auth/gmail.readonly" }).map((t) => t.name),
    ["search_threads", "get_thread", "get_message", "list_labels"],
  );
});

test("Microsoft's sign-in page: common tenant, PKCE, the account's scopes, the owner picks the account", () => {
  const u = new URL(microsoftAdapter.authorizationUrl!({ clientId: "app-id", redirectUri: "https://athena.example/api/connectors/oauth/callback", scope: presetFor("outlook-mail").scope, state: "st", challenge: "ch" }));
  assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("scope"), "offline_access User.Read Mail.Read");
  assert.equal(u.searchParams.get("prompt"), "select_account");
  assert.equal(u.searchParams.get("resource"), null);
});

// ---------- mail ----------

test("Gmail's search syntax becomes Graph's: dates as the widest day, folders, flags and words", () => {
  const q = parseGmailQuery('after:2026/11/05 -in:sent -in:chats from:priya "Q1 budget" is:unread has:attachment', now());
  assert.equal(q.after?.toISOString(), "2026-11-04T10:00:00.000Z");
  assert.deepEqual(q.notFolders, ["sent"]);
  assert.equal(q.unread, true);
  assert.deepEqual(q.kql, ["from:priya", '\\"Q1 budget\\"', "hasattachments:true"]);
  assert.equal(parseGmailQuery("after:1762430400", now()).after?.toISOString(), "2025-11-06T12:00:00.000Z");
  assert.equal(parseGmailQuery("newer_than:2d", now()).after?.toISOString(), "2026-11-04T12:00:00.000Z");
});

test("search_threads: Gmail-shaped threads, newest first, without drafts, Junk or repeats, and pages on", async () => {
  stub(
    ...mailbox,
    (url) => (url.pathname === "/v1.0/me/messages" && url.searchParams.has("$skip") ? { body: F.RECENT_PAGE_2 } : undefined),
    (url) => (url.pathname === "/v1.0/me/messages" && url.searchParams.get("$filter")?.startsWith("conversationId") ? { body: { value: [] } } : undefined),
    path("/me/messages", F.RECENT_PAGE_1),
  );
  const r = await call("outlook-mail", "search_threads", { query: "after:2026/11/04", pageSize: 2 });
  assert.equal(r.isError, false);
  const list = calls.find((c) => c.url.pathname === "/v1.0/me/messages" && c.url.searchParams.has("$orderby"))!;
  assert.match(list.url.searchParams.get("$filter")!, /^receivedDateTime ge 2026-11-03T10:00:00.000Z/);
  assert.equal(list.url.searchParams.get("$orderby"), "receivedDateTime desc");
  assert.deepEqual(
    r.json.threads.map((t: { id: string }) => t.id),
    ["conv-A", "conv-B"],
  );
  const latest = r.json.threads[0].messages.at(-1);
  assert.equal(latest.sender, "Priya Shah <priya@contoso.example>");
  assert.equal(latest.date, "2026-11-06T09:30:00Z");
  assert.deepEqual(latest.labelIds, ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "Finance"]);
  assert.match(r.json.threads[0].viewUrl, /^https:\/\/outlook\.office365\.com\//);
  assert.deepEqual(r.json.threads[1].messages[0].labelIds, ["INBOX", "CATEGORY_OTHER"]);
  // Precheck reads it as it reads Gmail.
  const parsed = parseGmailThreads(r.text)!;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].subject, "RE: Budget for Q1");
  // Only GETs ever left.
  assert.ok(calls.every((c) => (c.init.method ?? "GET") === "GET"));
});

test("search_threads with words uses Graph's $search (KQL), with dates as days", async () => {
  stub(...mailbox, path("/me/messages", { value: [] }));
  const r = await call("outlook-mail", "search_threads", { query: "from:priya budget after:2026/11/01" });
  assert.deepEqual(r.json, {});
  const s = calls.find((c) => c.url.searchParams.has("$search"))!;
  assert.equal(s.url.searchParams.get("$search"), '"from:priya budget received>=2026-10-31"');
  assert.equal(s.url.searchParams.get("$orderby"), null);
});

test("search_threads pages on with a token that skips conversations already given", async () => {
  stub(
    ...mailbox,
    (url) => (url.pathname === "/v1.0/me/messages" && url.searchParams.has("$skip") ? { body: F.RECENT_PAGE_2 } : undefined),
    path("/me/messages", F.RECENT_PAGE_1),
  );
  const first = await call("outlook-mail", "search_threads", { pageSize: 1, view: "THREAD_VIEW_IDS_ONLY" });
  assert.deepEqual(first.json.threads, [{ id: "conv-A" }]);
  assert.ok(first.json.nextPageToken);
  const second = await call("outlook-mail", "search_threads", { pageSize: 5, view: "THREAD_VIEW_IDS_ONLY", pageToken: first.json.nextPageToken });
  assert.deepEqual(second.json.threads, [{ id: "conv-B" }]);
  assert.equal(second.json.nextPageToken, undefined);
  const bad = await call("outlook-mail", "search_threads", { pageToken: Buffer.from(JSON.stringify({ l: "https://evil.example/", s: 0, h: [] })).toString("base64url") });
  assert.equal(bad.isError, true);
});

test("get_thread: plain text, earlier replies dropped, attachments named and never read, drafts left out", async () => {
  stub(...mailbox, path("/me/messages/msg-3/attachments", F.ATTACHMENTS_MSG_3), path("/me/messages", F.CONVERSATION_A));
  const r = await call("outlook-mail", "get_thread", { threadId: "conv-A" });
  assert.equal(r.json.messages.length, 2);
  const [older, newer] = r.json.messages;
  assert.equal(older.id, "msg-2");
  assert.equal(older.plaintextBody, "How about £40k?");
  assert.deepEqual(older.labelIds, ["SENT"]);
  assert.equal(newer.plaintextBody, "Works for me. Let's lock it in on Friday.\n\nPriya");
  assert.deepEqual(newer.attachments, ["Q1 budget.xlsx"]);
  const conv = calls.find((c) => c.url.searchParams.get("$filter")?.startsWith("conversationId"))!;
  assert.match(String((conv.init.headers as Record<string, string>).Prefer), /outlook\.body-content-type="text"/);
  const att = calls.find((c) => c.url.pathname.endsWith("/attachments"))!;
  assert.equal(att.url.searchParams.get("$select"), "name,isInline");
});

test("get_message: a message that's gone comes back as a tool error, not an account problem", async () => {
  stub(...mailbox, path("/me/messages/nope", F.GRAPH_NOT_FOUND, 404));
  const r = await call("outlook-mail", "get_message", { messageId: "nope" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not found/);
});

test("list_labels: folders, with Outlook's own marked as system", async () => {
  stub(...mailbox);
  const r = await call("outlook-mail", "list_labels");
  assert.deepEqual(
    r.json.labels.map((l: { name: string; type: string }) => `${l.name}:${l.type}`),
    ["Inbox:system", "Sent Items:system", "Deleted Items:system", "Receipts:user"],
  );
});

// ---------- calendar ----------

test("list_events: occurrences expanded, UTC times with Z, all-day as dates, replies in Google's words", async () => {
  stub(path("/me", F.ME), path("/me/calendar", { id: "cal-1" }), path("/me/calendar/calendarView", F.CALENDAR_VIEW));
  const r = await call("outlook-calendar", "list_events", { startTime: "2026-11-09T00:00:00Z", endTime: "2026-11-17T00:00:00Z" });
  const view = calls.find((c) => c.url.pathname.endsWith("/calendarView"))!;
  assert.equal(view.url.searchParams.get("startDateTime"), "2026-11-09T00:00:00.000Z");
  assert.equal(view.url.searchParams.get("$orderby"), "start/dateTime");
  const [standup, , holiday, oof] = r.json.events;
  assert.deepEqual(standup, {
    id: "evt-standup-1",
    summary: "Standup",
    start: "2026-11-09T09:00:00Z",
    end: "2026-11-09T09:15:00Z",
    location: "Teams",
    organizer: "Priya Shah <priya@contoso.example>",
    myResponse: "maybe",
    attendees: ["Priya Shah <priya@contoso.example>: accepted", "Jordan <jordan@contoso.example> (you): maybe"],
    meetLink: "https://teams.microsoft.com/l/meetup-join/abc",
    htmlLink: "https://outlook.office365.com/owa/?itemid=evt-standup-1",
  });
  assert.equal(r.json.events[1].id, "evt-standup-2");
  assert.deepEqual([holiday.start, holiday.end, holiday.allDay, holiday.organizer, holiday.myResponse], ["2026-11-10", "2026-11-11", true, undefined, undefined]);
  assert.equal(oof.eventType, "outOfOffice");
  const onlyOof = await call("outlook-calendar", "list_events", { eventType: ["OUT_OF_OFFICE"] });
  assert.deepEqual(
    onlyOof.json.events.map((e: { id: string }) => e.id),
    ["evt-oof"],
  );
});

test("list_events pages without cutting a page short", async () => {
  stub(path("/me", F.ME), path("/me/calendar", { id: "cal-1" }), path("/me/calendar/calendarView", F.CALENDAR_VIEW));
  const first = await call("outlook-calendar", "list_events", { pageSize: 3 });
  assert.equal(first.json.events.length, 3);
  const rest = await call("outlook-calendar", "list_events", { pageSize: 3, pageToken: first.json.nextPageToken });
  assert.deepEqual(
    rest.json.events.map((e: { id: string }) => e.id),
    ["evt-oof"],
  );
});

test("search_events: nearest first, from the nearest window that has enough", async () => {
  stub(path("/me", F.ME), path("/me/calendar", { id: "cal-1" }), path("/me/calendar/calendarView", F.CALENDAR_VIEW));
  const r = await call("outlook-calendar", "search_events", { query: "standup", pageSize: 1 });
  assert.deepEqual(
    r.json.events.map((e: { id: string }) => e.id),
    ["evt-standup-1"],
  );
  assert.ok(r.json.nextPageToken);
  assert.equal(calls.filter((c) => c.url.pathname.endsWith("/calendarView")).length, 1);
});

test("get_event: the description as text and attachments by name", async () => {
  stub(path("/me", F.ME), path("/me/calendar", { id: "cal-1" }), path("/me/events/evt-standup-1/attachments", { value: [{ name: "agenda.docx", isInline: false }] }), path("/me/events/evt-standup-1", F.EVENT_DETAIL));
  const r = await call("outlook-calendar", "get_event", { eventId: "evt-standup-1" });
  assert.equal(r.json.description, "Daily standup.\n\nJoin on Teams");
  assert.deepEqual(r.json.attachments, ["agenda.docx"]);
  assert.equal(r.json.recurringEventId, "evt-standup");
  assert.equal(r.json.updated, "2026-11-01T08:00:00Z");
});

// ---------- tokens ----------

test("an expired token is renewed once, Microsoft's new refresh token saved sealed", async () => {
  const saved: ConnectorSecrets[] = [];
  const realSave = tokenStore.save;
  tokenStore.save = async (_id, mutate) => {
    const s: ConnectorSecrets = { tokens: { refresh_token: "rt-old" } };
    mutate(s);
    saved.push(s);
  };
  try {
    stub(
      (url, init) => (url.host === "login.microsoftonline.com" && init.method === "POST" ? { body: F.TOKEN_RENEWED } : undefined),
      path("/me", F.ME),
      path("/me/calendar", { id: "cal-1" }),
    );
    const s = secrets({ access_token: "at-old", refresh_token: "rt-old", expires_in: 3600, obtained_at: Date.now() - 2 * 3600_000 });
    await openMicrosoft(connector("outlook-calendar"), s, now);
    const token = calls.filter((c) => c.url.host === "login.microsoftonline.com");
    assert.equal(token.length, 1, "renewed once for two requests");
    const form = new URLSearchParams(String(token[0].init.body));
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "rt-old");
    assert.equal(form.get("scope"), "offline_access User.Read Calendars.Read");
    assert.equal((saved[0].tokens as { refresh_token: string }).refresh_token, "rt-new");
    assert.equal((s.tokens as { access_token: string }).access_token, "at-new");
    const graph = calls.filter((c) => c.url.host === "graph.microsoft.com");
    assert.ok(graph.every((c) => (c.init.headers as Record<string, string>).Authorization === "Bearer at-new"));
  } finally {
    tokenStore.save = realSave;
  }
});

test("a 401 renews and retries once; a throttled request waits and tries again", async () => {
  const realSave = tokenStore.save;
  tokenStore.save = async () => undefined;
  try {
    let meCalls = 0;
    let probe = 0;
    stub(
      (url, init) => (url.host === "login.microsoftonline.com" && init.method === "POST" ? { body: F.TOKEN_RENEWED } : undefined),
      (url) => (url.pathname === "/v1.0/me" ? (meCalls++ === 0 ? { status: 401, body: F.GRAPH_EXPIRED_TOKEN } : { body: F.ME }) : undefined),
      (url) => (url.pathname === "/v1.0/me/calendar" ? (probe++ === 0 ? { status: 429, body: F.GRAPH_THROTTLED, headers: { "Retry-After": "0" } } : { body: { id: "c" } }) : undefined),
    );
    await openMicrosoft(connector("outlook-calendar"), secrets(), now);
    assert.equal(meCalls, 2);
    assert.equal(probe, 2);
  } finally {
    tokenStore.save = realSave;
  }
});

// ---------- failures ----------

test("failures map to what the owner should do", async () => {
  // A revoked or idle-expired sign-in.
  stub((url) => (url.host === "login.microsoftonline.com" ? { status: 400, body: F.TOKEN_INVALID_GRANT } : undefined));
  const expiredSignIn = await openMicrosoft(connector("outlook-mail"), secrets({ refresh_token: "rt", access_token: "x", expires_in: 1, obtained_at: 1 }), now).catch((e) => e);
  assert.ok(expiredSignIn instanceof MicrosoftTokenError);
  assert.equal(expiredSignIn.aadsts, 70008);
  assert.deepEqual(microsoftFailure(expiredSignIn), { status: "needs_auth", detail: "Sign in again" });

  // The app's secret expired in Entra.
  stub((url) => (url.host === "login.microsoftonline.com" ? { status: 401, body: F.TOKEN_SECRET_EXPIRED } : undefined));
  const secret = await openMicrosoft(connector("outlook-mail"), secrets({ refresh_token: "rt", access_token: "x", expires_in: 1, obtained_at: 1 }), now).catch((e) => e);
  assert.equal(microsoftFailure(secret)?.status, "needs_auth");
  assert.match(microsoftFailure(secret)!.detail, /client secret has expired/);

  // A permission declined, or blocked by an admin.
  stub(path("/me", F.ME), path("/me/mailFolders/inbox", F.GRAPH_ACCESS_DENIED, 403));
  const denied = await openMicrosoft(connector("outlook-mail"), secrets(), now).catch((e) => e);
  assert.ok(microsoftAccountProblem(denied));
  assert.equal(directFailure(denied)?.status, "needs_auth");
  assert.match(directFailure(denied)!.detail, /accept every permission/);

  // A Microsoft account with no Outlook mailbox.
  stub(path("/me", F.ME), path("/me/mailFolders/inbox", F.GRAPH_NO_MAILBOX, 404));
  const none = await openMicrosoft(connector("outlook-mail"), secrets(), now).catch((e) => e);
  assert.ok(microsoftAccountProblem(none));
  assert.match(microsoftFailure(none)!.detail, /no Outlook mailbox/);

  // Microsoft's own trouble, after the retries: an error, not a sign-in.
  stub(path("/me", { error: { code: "ServiceNotAvailable", message: "x" } }, 503));
  const down = await openMicrosoft(connector("outlook-mail"), secrets(), now).catch((e) => e);
  assert.equal(microsoftFailure(down)?.status, "error");
  assert.ok(!microsoftAccountProblem(down));

  // Not signed in at all.
  const s = secrets();
  delete s.tokens;
  assert.deepEqual(microsoftFailure(await openMicrosoft(connector("outlook-mail"), s, now).catch((e) => e)), { status: "needs_auth", detail: "Not signed in yet" });
});

test("Google's failures still map through the registry as before", async () => {
  const { GoogleTokenError } = await import("./google-api");
  assert.deepEqual(directFailure(new GoogleTokenError("invalid_grant", "x")), { status: "needs_auth", detail: "Sign in again" });
  assert.equal(microsoftFailure(new GoogleTokenError("invalid_grant", "x")), null);
});

// ---------- precheck ----------

function opened(account: Awaited<ReturnType<typeof openMicrosoft>>): OpenConnector {
  return { connector: connector("outlook-mail"), direct: account, close: async () => undefined };
}

test("precheck: Outlook with no new mail counts 0, so the run can be skipped", async () => {
  stub(...mailbox, path("/me/messages", { value: [] }));
  const account = await openMicrosoft(connector("outlook-mail"), secrets(), now);
  const g = await glance(opened(account), new Set(["search_threads"]), new Date("2026-11-06T06:00:00Z"), "Europe/London");
  assert.equal(g.count, 0);
  const list = calls.find((c) => c.url.pathname === "/v1.0/me/messages")!;
  assert.match(list.url.searchParams.get("$filter")!, /^receivedDateTime ge 2026-11-05T10:00:00.000Z$/);
});

test("precheck: only mail newer than the last good run counts, and the threads go to triage", async () => {
  stub(
    ...mailbox,
    (url) => (url.pathname === "/v1.0/me/messages" && url.searchParams.has("$skip") ? { body: F.RECENT_PAGE_2 } : undefined),
    path("/me/messages", F.RECENT_PAGE_1),
  );
  const account = await openMicrosoft(connector("outlook-mail"), secrets(), now);
  const g = await glance(opened(account), new Set(["search_threads"]), new Date("2026-11-06T06:00:00Z"), "Europe/London");
  assert.equal(g.count, 1);
  assert.equal(g.threads![0].id, "conv-A");
  assert.deepEqual(g.threads![0].labels, ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "Finance"]);
});

test("precheck: no allowed search tool means it can't tell, so the run goes ahead", async () => {
  stub(...mailbox);
  const account = await openMicrosoft(connector("outlook-mail"), secrets(), now);
  assert.equal((await glance(opened(account), new Set(["get_thread"]), new Date(), "UTC")).count, null);
});

test("replies captured live from Microsoft parse as expected, with Entra's trace ids kept out of messages", async () => {
  const { parseGraphError } = await import("./microsoft-graph");
  const e401 = parseGraphError(401, F.LIVE_GRAPH_401, "outlook-mail");
  assert.equal(e401.code, "InvalidAuthenticationToken");
  assert.deepEqual(microsoftFailure(e401), { status: "needs_auth", detail: "Sign in again" });
  stub((url) => (url.host === "login.microsoftonline.com" ? { status: 400, body: F.LIVE_TOKEN_MALFORMED } : undefined));
  const err = await openMicrosoft(connector("outlook-mail"), secrets({ refresh_token: "rt", access_token: "x", expires_in: 1, obtained_at: 1 }), now).catch((e) => e);
  assert.ok(err instanceof MicrosoftTokenError);
  assert.equal(err.aadsts, 9002313);
  assert.equal(err.message, "Invalid request. Request is malformed or invalid. (invalid_grant)");
  assert.equal(microsoftFailure(err)?.status, "needs_auth");
});
