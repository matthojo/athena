// Run: npx tsx --test netlify/lib/connectors/rsvp.test.ts
// Answering invites (lib/rsvp.ts): the one calendar write each, refused without "Let Athena answer invites",
// and nothing but the reply allowed with it. fetch is stubbed; every request is recorded.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canRsvp, presetFor, RSVP_SCOPE, RSVP_TOOL } from "../../../lib/connector-presets";
import { fromCalendar } from "../../../lib/rsvp";
import { directTools, openGoogle } from "./google-direct";
import { GoogleSession, isRsvpPatch, retryWaits } from "./google-api";
import { microsoftTools, openMicrosoft } from "./microsoft-direct";
import { GraphSession, graphRetryWaits, isRsvpPost } from "./microsoft-graph";
import { callTool, type OpenConnector } from "./mcp-client";

type Call = { method: string; url: URL; body: unknown };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined;

beforeEach(() => {
  calls = [];
  retryWaits.ms = [1, 1];
  graphRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c) ?? { body: {} };
    return new Response(r.status === 202 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function account(provider: "google-calendar" | "outlook-calendar", answering: boolean): Connector {
  const p = presetFor(provider);
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    name: p.label,
    provider,
    account_label: "work",
    url: p.url,
    auth_type: "oauth",
    scope: answering ? `${p.scope} ${RSVP_SCOPE[provider]}` : p.scope,
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
const secrets = (): ConnectorSecrets => ({ ownClient: { client_id: "c", client_secret: "s" }, tokens: { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } });
const writes = () => calls.filter((c) => c.method !== "GET");

// ---------- the switch ----------

test("the switch is the narrow permission, and only for Google Calendar and Outlook", () => {
  assert.equal(RSVP_SCOPE["google-calendar"], "https://www.googleapis.com/auth/calendar.events");
  assert.equal(RSVP_SCOPE["outlook-calendar"], "Calendars.ReadWrite");
  assert.equal(canRsvp(account("google-calendar", false)), false);
  assert.equal(canRsvp(account("google-calendar", true)), true);
  assert.equal(canRsvp(account("outlook-calendar", true)), true);
  assert.equal(canRsvp({ provider: "gmail", scope: RSVP_SCOPE["google-calendar"] }), false);
  assert.deepEqual(["accepted", "maybe", "declined", "no reply yet", undefined].map(fromCalendar), ["going", "maybe", "declined", "none", "none"]);
});

test("without the switch the reply tool isn't offered, and calling it is refused before anything is sent", async () => {
  for (const provider of ["google-calendar", "outlook-calendar"] as const) {
    const c = account(provider, false);
    const names = (provider === "google-calendar" ? directTools(c) : microsoftTools(c)).map((t) => t.name);
    assert.ok(!names.includes(RSVP_TOOL), provider);
    const open: OpenConnector = { connector: c, direct: { tools: [], call: async () => assert.fail("never reached") }, close: async () => undefined };
    await assert.rejects(callTool(open, RSVP_TOOL, { eventId: "e1", answer: "declined" }), /isn't on/);
  }
  assert.equal(writes().length, 0);
});

test("with it on, the reply tool is offered and classed as a write (so collections and Ask's sources never see it)", async () => {
  const g = directTools(account("google-calendar", true)).find((t) => t.name === RSVP_TOOL)!;
  const m = microsoftTools(account("outlook-calendar", true)).find((t) => t.name === RSVP_TOOL)!;
  assert.equal(g.annotations.readOnlyHint, false);
  assert.equal(m.annotations.readOnlyHint, false);
  const { classifyTool } = await import("../../../lib/connector-presets");
  assert.equal(classifyTool("google-calendar", RSVP_TOOL, g.annotations), "write");
});

test("callTool refuses every other write on a direct account, and the reply on an MCP server", async () => {
  const c = account("google-calendar", true);
  const open: OpenConnector = {
    connector: c,
    direct: { tools: [{ name: "delete_event", summary: "", description: "", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } }], call: async () => assert.fail("never reached") },
    close: async () => undefined,
  };
  await assert.rejects(callTool(open, "delete_event", { eventId: "e1" }), /only reads/);
  const mcp = { connector: c, client: {} as never, close: async () => undefined } as unknown as OpenConnector;
  await assert.rejects(callTool(mcp, RSVP_TOOL, { eventId: "e1", answer: "going" }), /can't answer invites through/);
});

// ---------- Google: the attendee patch, and nothing else ----------

const EVENT_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_1?sendUpdates=all";
const ME = { attendeesOmitted: true, attendees: [{ email: "me@example.com", responseStatus: "declined" }] };

test("Google: only the attendee patch with your own reply passes the request gate", () => {
  assert.equal(isRsvpPatch({ method: "PATCH", url: EVENT_URL, body: ME }), true);
  const bad: Array<[string, string, unknown]> = [
    ["PATCH", EVENT_URL, { ...ME, summary: "Renamed" }],
    ["PATCH", EVENT_URL, { ...ME, start: { dateTime: "2026-11-10T09:00:00Z" } }],
    ["PATCH", EVENT_URL, { attendeesOmitted: true, attendees: [ME.attendees[0], { email: "x@example.com", responseStatus: "accepted" }] }],
    ["PATCH", EVENT_URL, { attendees: ME.attendees }],
    ["PATCH", EVENT_URL, { attendeesOmitted: true, attendees: [{ ...ME.attendees[0], comment: "hi" }] }],
    ["PATCH", EVENT_URL.replace("?sendUpdates=all", ""), ME],
    ["PATCH", "https://www.googleapis.com/calendar/v3/calendars/primary/events", ME],
    ["PUT", EVENT_URL, ME],
    ["DELETE", EVENT_URL, undefined],
    ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events", { summary: "New" }],
  ];
  for (const [method, url, body] of bad) assert.equal(isRsvpPatch({ method, url, body }), false, `${method} ${url} ${JSON.stringify(body)}`);
});

test("Google: the session refuses any other write before it reaches the network", async () => {
  const s = new GoogleSession(account("google-calendar", true), secrets());
  await assert.rejects(s.request({ method: "PATCH", url: EVENT_URL, body: { ...ME, summary: "x" } as never }), /only reads/);
  await assert.rejects(s.request({ method: "DELETE", url: EVENT_URL } as never), /only reads/);
  await assert.rejects(s.request({ method: "POST", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events", body: {} } as never), /only reads/);
  assert.equal(calls.length, 0);
});

test("Google: respond_to_event reads who you are on the invite, then patches only your reply", async () => {
  reply = (c) =>
    c.url.pathname.endsWith("/calendars/primary")
      ? { body: { id: "me@example.com", timeZone: "Europe/London" } }
      : c.method === "GET"
        ? { body: { id: "ev_1", status: "confirmed", attendees: [{ email: "boss@example.com", organizer: true }, { email: "me.alias@example.com", self: true, responseStatus: "needsAction" }] } }
        : { body: { id: "ev_1" } };
  const g = await openGoogle(account("google-calendar", true), secrets());
  const r = await g.call(RSVP_TOOL, { eventId: "ev_1", answer: "maybe" });
  assert.equal(r.isError, false, r.text);
  assert.equal(writes().length, 1);
  const w = writes()[0];
  assert.equal(w.method, "PATCH");
  assert.equal(w.url.toString(), EVENT_URL);
  assert.deepEqual(w.body, { attendeesOmitted: true, attendees: [{ email: "me.alias@example.com", responseStatus: "tentative" }] });
});

test("Google: an event you aren't a guest on, or that was cancelled, isn't touched", async () => {
  for (const event of [{ id: "ev_1", status: "confirmed", attendees: [{ email: "x@example.com" }] }, { id: "ev_1", status: "cancelled", attendees: [{ email: "me@example.com", self: true }] }]) {
    calls = [];
    reply = (c) => (c.url.pathname.endsWith("/calendars/primary") ? { body: { id: "me@example.com" } } : { body: event });
    const g = await openGoogle(account("google-calendar", true), secrets());
    const r = await g.call(RSVP_TOOL, { eventId: "ev_1", answer: "declined" });
    assert.equal(r.isError, true);
    assert.equal(writes().length, 0);
  }
});

test("Google: without the switch the session has no way to patch at all", async () => {
  reply = (c) => (c.url.pathname.endsWith("/calendars/primary") ? { body: { id: "me@example.com" } } : undefined);
  const g = await openGoogle(account("google-calendar", false), secrets());
  const r = await g.call(RSVP_TOOL, { eventId: "ev_1", answer: "going" });
  assert.equal(r.isError, true);
  assert.equal(writes().length, 0);
});

// ---------- Microsoft: accept, tentativelyAccept, decline ----------

const GRAPH_EVENT = "https://graph.microsoft.com/v1.0/me/events/AAMk1";

test("Microsoft: only an invite reply passes the gate", () => {
  for (const a of ["accept", "tentativelyAccept", "decline"]) assert.equal(isRsvpPost(`${GRAPH_EVENT}/${a}`, { sendResponse: true }), true, a);
  const bad: Array<[string, unknown]> = [
    [`${GRAPH_EVENT}/cancel`, { sendResponse: true }],
    [`${GRAPH_EVENT}/forward`, { sendResponse: true }],
    [`${GRAPH_EVENT}/decline`, { sendResponse: true, proposedNewTime: {} }],
    [`${GRAPH_EVENT}/decline`, { sendResponse: true, comment: "x" }],
    [GRAPH_EVENT, { sendResponse: true }],
    ["https://graph.microsoft.com/v1.0/me/sendMail", { sendResponse: true }],
    ["https://evil.example.com/v1.0/me/events/AAMk1/accept", { sendResponse: true }],
  ];
  for (const [url, body] of bad) assert.equal(isRsvpPost(url, body), false, url);
});

test("Microsoft: the session refuses anything but the reply before it reaches the network", async () => {
  const s = new GraphSession(account("outlook-calendar", true), secrets());
  await assert.rejects(s.send(`${GRAPH_EVENT}/cancel`, { sendResponse: true }), /only reads/);
  await assert.rejects(s.send("https://graph.microsoft.com/v1.0/me/sendMail", { sendResponse: true }), /only reads/);
  assert.equal(calls.length, 0);
});

test("Microsoft: respond_to_event checks the event, then posts decline and nothing else", async () => {
  reply = (c) => {
    if (c.url.pathname === "/v1.0/me") return { body: { mail: "me@example.com" } };
    if (c.url.pathname === "/v1.0/me/calendar") return { body: { id: "cal" } };
    if (c.method === "GET") return { body: { id: "AAMk1", isOrganizer: false, isCancelled: false } };
    return { status: 202 };
  };
  const m = await openMicrosoft(account("outlook-calendar", true), secrets());
  const r = await m.call(RSVP_TOOL, { eventId: "AAMk1", answer: "declined" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["POST", `${GRAPH_EVENT}/decline`, { sendResponse: true }]]);
});

test("Microsoft: your own event, or no switch, sends nothing", async () => {
  reply = (c) => {
    if (c.url.pathname === "/v1.0/me") return { body: { mail: "me@example.com" } };
    if (c.url.pathname === "/v1.0/me/calendar") return { body: { id: "cal" } };
    return { body: { id: "AAMk1", isOrganizer: true } };
  };
  for (const answering of [true, false]) {
    const m = await openMicrosoft(account("outlook-calendar", answering), secrets());
    const r = await m.call(RSVP_TOOL, { eventId: "AAMk1", answer: "going" });
    assert.equal(r.isError, true);
  }
  assert.equal(writes().length, 0);
});
