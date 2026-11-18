// Run: npx tsx --test netlify/lib/connectors/create-events.test.ts
// Adding events, at the adapters: create_event sends exactly one new event with only the allowed
// fields, behind "Let Athena add and update events"; Undo deletes only an event Athena added
// (calendar_creates, stubbed here as `ledger.has`), and every other delete is refused before the
// network. fetch is stubbed; every request is recorded with its headers.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canMove, classifyTool, CREATE_TOOL, EVENTS_SWITCH, MOVE_MARKER, presetFor, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { ledger } from "../../../lib/calendar-creates";
import { directTools, openGoogle } from "./google-direct";
import { GoogleSession, isCreateInsert, isCreatedDelete, isMovePatch, retryWaits } from "./google-api";
import { microsoftTools, openMicrosoft } from "./microsoft-direct";
import { allowedWrite, GraphSession, graphRetryWaits, isCreatePost, isCreatedDelete as isGraphDelete, isDraftCreate } from "./microsoft-graph";
import { icloudTools } from "./icloud-direct";
import { ICLOUD_CALENDAR_TOOLS, type IcloudCalendarContext } from "./icloud-calendar";
import { DavSession, davRetryWaits } from "./icloud-dav";
import { isNewEventIcs, newEventIcs } from "./icloud-create";
import { readCreateArgs } from "./calendar-create";
import { callTool, type OpenConnector } from "./mcp-client";

type Call = { method: string; url: URL; body: unknown; headers: Record<string, string> };
const realFetch = globalThis.fetch;
const realHas = ledger.has;
let calls: Call[] = [];
let reply: (c: Call) => { status?: number; body?: unknown; text?: string; etag?: string } | undefined = () => undefined;
/** What calendar_creates holds, as "connector|calendar|event". */
let created = new Set<string>();

beforeEach(() => {
  calls = [];
  created = new Set();
  reply = () => undefined;
  retryWaits.ms = [1, 1];
  graphRetryWaits.ms = [1, 1];
  davRetryWaits.ms = [1, 1];
  ledger.has = async (connector, calendar, event) => created.has(`${connector}|${calendar}|${event}`);
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const raw = init.body ? String(init.body) : undefined;
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // iCalendar text stays text.
    }
    const c = { method: init.method ?? "GET", url: new URL(String(input)), body, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = reply(c) ?? { body: {} };
    const status = r.status ?? 200;
    const headers: Record<string, string> = { "Content-Type": r.text !== undefined ? "text/calendar" : "application/json", ...(r.etag ? { ETag: r.etag } : {}) };
    return new Response(status === 204 || status === 201 ? null : r.text ?? JSON.stringify(r.body ?? {}), { status, headers });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  ledger.has = realHas;
});

const ID = "00000000-0000-4000-8000-0000000000c1";
function account(provider: "google-calendar" | "outlook-calendar" | "icloud-calendar", on = false): Connector {
  const p = presetFor(provider);
  return {
    id: ID,
    name: p.label,
    provider,
    account_label: "work",
    url: p.url,
    auth_type: provider === "icloud-calendar" ? "token" : "oauth",
    scope: [p.scope, on ? MOVE_MARKER : ""].filter(Boolean).join(" "),
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
  } as Connector;
}
const secrets = (): ConnectorSecrets => ({ ownClient: { client_id: "c", client_secret: "s" }, tokens: { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } });
const writes = () => calls.filter((c) => c.method !== "GET" && c.method !== "PROPFIND" && c.method !== "REPORT");

const ARGS = {
  summary: "Lunch with Priya",
  start: "2026-11-12T13:00:00Z",
  end: "2026-11-12T14:00:00Z",
  timeZone: "Europe/London",
  location: "Dishoom, King's Cross",
  description: "Pricing tiers",
  attendees: [{ email: "priya@example.com", name: "Priya Shah" }, { email: "marcus@example.com" }],
};

// ---------- the switch ----------

test("one switch, the old marker: an account that could move events can now add them, and nothing else changes", () => {
  assert.equal(EVENTS_SWITCH, "Let Athena add and update events");
  assert.equal(MOVE_MARKER, "athena:move-events", "kept, so current settings carry over");
  for (const p of ["google-calendar", "outlook-calendar", "icloud-calendar"] as const) {
    assert.equal(canMove(account(p, true)), true);
    const offered = (p === "google-calendar" ? directTools(account(p, true)) : p === "outlook-calendar" ? microsoftTools(account(p, true)) : icloudTools(account(p, true))).map((t) => t.name);
    assert.ok(offered.includes(CREATE_TOOL) && offered.includes(UNDO_CREATE_TOOL), p);
    const off = (p === "google-calendar" ? directTools(account(p)) : p === "outlook-calendar" ? microsoftTools(account(p)) : icloudTools(account(p))).map((t) => t.name);
    assert.ok(!off.includes(CREATE_TOOL) && !off.includes(UNDO_CREATE_TOOL), p);
  }
  const g = directTools(account("google-calendar", true));
  assert.equal(classifyTool("google-calendar", CREATE_TOOL, g.find((t) => t.name === CREATE_TOOL)!.annotations), "write");
  assert.equal(classifyTool("google-calendar", UNDO_CREATE_TOOL, g.find((t) => t.name === UNDO_CREATE_TOOL)!.annotations), "write");
});

test("callTool refuses create_event and its undo without the switch, and on an MCP server, before anything is sent", async () => {
  const open: OpenConnector = { connector: account("google-calendar"), direct: { tools: [], call: async () => assert.fail("never reached") }, close: async () => undefined };
  await assert.rejects(callTool(open, CREATE_TOOL, ARGS), /Let Athena add and update events.*isn't on/);
  await assert.rejects(callTool(open, UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "e1" }), /isn't on/);
  const mcp = { connector: account("google-calendar", true), client: {} as never, close: async () => undefined } as unknown as OpenConnector;
  await assert.rejects(callTool(mcp, CREATE_TOOL, ARGS), /can't change events through/);
  await assert.rejects(callTool(mcp, UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "e1" }), /can't change events through/);
  assert.equal(calls.length, 0);
});

test("create_event's arguments: only the allowed fields, guests as addresses, never the owner", () => {
  const a = readCreateArgs({ ...ARGS, attendees: [...ARGS.attendees, { email: "ME@example.com" }, { email: "priya@example.com" }] }, "Europe/London", ["me@example.com"]);
  assert.deepEqual(a.attendees, [{ email: "priya@example.com", name: "Priya Shah" }, { email: "marcus@example.com" }]);
  for (const extra of [{ conferenceData: {} }, { reminders: {} }, { recurrence: ["RRULE:FREQ=DAILY"] }, { colorId: "5" }, { visibility: "private" }, { sendUpdates: "none" }]) {
    assert.throws(() => readCreateArgs({ ...ARGS, ...extra }, "UTC"), /doesn't take/, JSON.stringify(extra));
  }
  assert.throws(() => readCreateArgs({ ...ARGS, attendees: [{ email: "priya@example.com", optional: true }] }, "UTC"), /each one is/);
  assert.throws(() => readCreateArgs({ ...ARGS, attendees: [{ email: "not an address" }] }, "UTC"), /isn't an email/);
  assert.throws(() => readCreateArgs({ ...ARGS, end: ARGS.start }, "UTC"), /after start/);
  assert.throws(() => readCreateArgs({ ...ARGS, end: "2026-11-14T13:00:00Z" }, "UTC"), /at most a day/);
  // A time without an offset is the owner's wall clock.
  assert.equal(readCreateArgs({ ...ARGS, start: "2026-07-01T13:00", end: "2026-07-01T14:00", timeZone: undefined }, "Europe/London").start.toISOString(), "2026-07-01T12:00:00.000Z");
});

// ---------- Google ----------

const INSERT = "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all";
const G_BODY = {
  summary: "Lunch with Priya",
  start: { dateTime: "2026-11-12T13:00:00Z", timeZone: "Europe/London" },
  end: { dateTime: "2026-11-12T14:00:00Z", timeZone: "Europe/London" },
  location: "Dishoom, King's Cross",
  description: "Pricing tiers",
  attendees: [{ email: "priya@example.com", displayName: "Priya Shah" }, { email: "marcus@example.com" }],
};

test("Google: only a new event with the allowed fields passes the insert gate", () => {
  assert.equal(isCreateInsert({ method: "POST", url: INSERT, body: G_BODY }), true);
  assert.equal(isCreateInsert({ method: "POST", url: INSERT, body: { summary: "Focus", start: G_BODY.start, end: G_BODY.end } }), true, "no guests, no place");
  const bad: Array<[string, string, unknown]> = [
    ["POST", INSERT, { ...G_BODY, conferenceData: { createRequest: { requestId: "x" } } }],
    ["POST", INSERT, { ...G_BODY, reminders: { useDefault: false } }],
    ["POST", INSERT, { ...G_BODY, recurrence: ["RRULE:FREQ=WEEKLY"] }],
    ["POST", INSERT, { ...G_BODY, colorId: "3" }],
    ["POST", INSERT, { ...G_BODY, visibility: "private" }],
    ["POST", INSERT, { ...G_BODY, guestsCanModify: true }],
    ["POST", INSERT, { ...G_BODY, eventType: "focusTime" }],
    ["POST", INSERT, { ...G_BODY, attachments: [{ fileUrl: "https://x" }] }],
    ["POST", INSERT, { ...G_BODY, attendees: [{ email: "priya@example.com", responseStatus: "accepted" }] }],
    ["POST", INSERT, { ...G_BODY, attendees: [{ email: "priya@example.com", optional: true }] }],
    ["POST", INSERT, { ...G_BODY, attendees: [{ email: "nope" }] }],
    ["POST", INSERT, { ...G_BODY, attendees: Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@example.com` })) }],
    ["POST", INSERT, { ...G_BODY, summary: "" }],
    ["POST", INSERT, { ...G_BODY, start: { date: "2026-11-12" }, end: { date: "2026-11-13" } }],
    ["POST", INSERT, { ...G_BODY, start: G_BODY.end, end: G_BODY.start }],
    ["POST", INSERT, { ...G_BODY, start: { dateTime: "2026-11-12T13:00:00" }, end: G_BODY.end }],
    ["POST", INSERT, { ...G_BODY, location: { displayName: "x" } }],
    ["POST", INSERT.replace("sendUpdates=all", "sendUpdates=none"), G_BODY],
    ["POST", INSERT.replace("?sendUpdates=all", ""), G_BODY],
    ["POST", `${INSERT}&conferenceDataVersion=1`, G_BODY],
    ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events/import?sendUpdates=all", G_BODY],
    ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events/quickAdd?sendUpdates=all", G_BODY],
    ["PUT", INSERT, G_BODY],
    ["PATCH", INSERT, G_BODY],
  ];
  for (const [method, url, body] of bad) assert.equal(isCreateInsert({ method, url, body }), false, `${method} ${url} ${JSON.stringify(body)}`);
  // The insert and the move don't stand in for each other.
  assert.equal(isMovePatch({ method: "PATCH", url: INSERT, body: G_BODY }), false);
});

test("Google: the session never sends a DELETE through request, and deleteCreated only for an event Athena added", async () => {
  const s = new GoogleSession(account("google-calendar", true), secrets());
  const del = "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_9?sendUpdates=all";
  assert.equal(isCreatedDelete({ method: "DELETE", url: del }), true);
  assert.equal(isCreatedDelete({ method: "DELETE", url: del.replace("?sendUpdates=all", "") }), false);
  assert.equal(isCreatedDelete({ method: "DELETE", url: "https://www.googleapis.com/calendar/v3/calendars/primary" }), false);
  await assert.rejects(s.request({ method: "DELETE", url: del }), /only reads/, "request refuses every DELETE");
  await assert.rejects(s.request({ method: "POST", url: INSERT, body: { ...G_BODY, colorId: "3" } as never }), /only reads/);
  await assert.rejects(s.deleteCreated("primary", "ev_9"), /only removes events it added/, "not in calendar_creates");
  assert.equal(calls.length, 0);
  created.add(`${ID}|primary|ev_9`);
  reply = () => ({ status: 204 });
  await s.deleteCreated("primary", "ev_9");
  assert.deepEqual(calls.map((c) => [c.method, c.url.toString(), c.body]), [["DELETE", del, undefined]]);
});

const googleOpen = (c: Call) => {
  if (c.url.pathname.endsWith("/calendars/primary") && c.method === "GET") return { body: { id: "me@example.com", timeZone: "Europe/London" } };
  if (c.method === "POST") return { body: { id: "ev_new", htmlLink: "https://www.google.com/calendar/event?eid=abc" } };
  if (c.method === "DELETE") return { status: 204 };
  return { body: {} };
};

test("Google: create_event sends one insert with exactly the allowed fields, and returns its link", async () => {
  reply = googleOpen;
  const g = await openGoogle(account("google-calendar", true), secrets());
  const r = await g.call(CREATE_TOOL, { ...ARGS, attendees: [...ARGS.attendees, { email: "me@example.com" }] });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text), { id: "ev_new", calendarId: "primary", link: "https://www.google.com/calendar/event?eid=abc", guests: 2, summary: "Lunch with Priya", start: "2026-11-12T13:00:00.000Z", end: "2026-11-12T14:00:00.000Z" });
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["POST", INSERT, G_BODY]], "the owner isn't invited to their own event");
});

test("Google: undo_create_event deletes only an event in calendar_creates; anything else sends nothing", async () => {
  reply = googleOpen;
  const g = await openGoogle(account("google-calendar", true), secrets());
  const no = await g.call(UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "someone_elses" });
  assert.equal(no.isError, true);
  assert.match(no.text, /only removes events it added/);
  assert.deepEqual(writes(), []);
  created.add(`${ID}|primary|ev_new`);
  const yes = await g.call(UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "ev_new" });
  assert.equal(yes.isError, false, yes.text);
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString()]), [["DELETE", "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_new?sendUpdates=all"]]);
  // A different calendar for the same id isn't the event Athena added.
  const other = await g.call(UNDO_CREATE_TOOL, { calendarId: "team@group.calendar.google.com", eventId: "ev_new" });
  assert.equal(other.isError, true);
  assert.equal(writes().length, 1);
});

test("Google: without the switch the session has no way to insert or delete", async () => {
  reply = googleOpen;
  const g = await openGoogle(account("google-calendar"), secrets());
  assert.equal((await g.call(CREATE_TOOL, ARGS)).isError, true);
  created.add(`${ID}|primary|ev_new`);
  assert.equal((await g.call(UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "ev_new" })).isError, true);
  assert.deepEqual(writes(), []);
});

// ---------- Microsoft ----------

const GRAPH = "https://graph.microsoft.com/v1.0";
const M_BODY = {
  subject: "Lunch with Priya",
  start: { dateTime: "2026-11-12T13:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-11-12T14:00:00", timeZone: "UTC" },
  location: { displayName: "Dishoom, King's Cross" },
  body: { contentType: "Text", content: "Pricing tiers" },
  attendees: [{ emailAddress: { address: "priya@example.com", name: "Priya Shah" } }, { emailAddress: { address: "marcus@example.com" } }],
};

test("Microsoft: only a new event with the allowed fields passes, and DELETE never goes through write", () => {
  assert.equal(isCreatePost(`${GRAPH}/me/events`, M_BODY), true);
  assert.equal(isCreatePost(`${GRAPH}/me/calendars/AAMkCal1=/events`, M_BODY), true);
  assert.equal(allowedWrite("POST", `${GRAPH}/me/events`, M_BODY), true);
  const bad: Array<[string, unknown]> = [
    [`${GRAPH}/me/events`, { ...M_BODY, isOnlineMeeting: true }],
    [`${GRAPH}/me/events`, { ...M_BODY, onlineMeetingProvider: "teamsForBusiness" }],
    [`${GRAPH}/me/events`, { ...M_BODY, reminderMinutesBeforeStart: 0 }],
    [`${GRAPH}/me/events`, { ...M_BODY, recurrence: {} }],
    [`${GRAPH}/me/events`, { ...M_BODY, sensitivity: "private" }],
    [`${GRAPH}/me/events`, { ...M_BODY, categories: ["Red"] }],
    [`${GRAPH}/me/events`, { ...M_BODY, isAllDay: true }],
    [`${GRAPH}/me/events`, { ...M_BODY, responseRequested: false }],
    [`${GRAPH}/me/events`, { ...M_BODY, body: { contentType: "HTML", content: "<img src=x>" } }],
    [`${GRAPH}/me/events`, { ...M_BODY, location: { displayName: "x", address: {} } }],
    [`${GRAPH}/me/events`, { ...M_BODY, attendees: [{ emailAddress: { address: "priya@example.com" }, type: "optional" }] }],
    [`${GRAPH}/me/events`, { ...M_BODY, attendees: [{ emailAddress: { address: "nope" } }] }],
    [`${GRAPH}/me/events`, { ...M_BODY, start: { dateTime: "2026-11-12T13:00:00", timeZone: "Pacific Standard Time" } }],
    [`${GRAPH}/me/events`, { ...M_BODY, start: M_BODY.end, end: M_BODY.start }],
    [`${GRAPH}/me/events`, { subject: "x", start: M_BODY.start }],
    [`${GRAPH}/me/events?$select=id`, M_BODY],
    [`${GRAPH}/me/events/AAMk1/forward`, M_BODY],
    [`${GRAPH}/users/boss@example.com/events`, M_BODY],
    [`${GRAPH}/me/calendars/../messages/events`, M_BODY],
    [`${GRAPH}/me/messages`, M_BODY],
  ];
  for (const [url, body] of bad) assert.equal(isCreatePost(url, body), false, `${url} ${JSON.stringify(body)}`);
  // A new event isn't a draft, and a draft isn't a new event.
  assert.equal(isDraftCreate(`${GRAPH}/me/events`, M_BODY), false);
  assert.equal(allowedWrite("DELETE", `${GRAPH}/me/events/AAMk9`, undefined), false);
  assert.equal(isGraphDelete(`${GRAPH}/me/events/AAMk9`, undefined), true);
  assert.equal(isGraphDelete(`${GRAPH}/me/messages/AAMk9`, undefined), false);
  assert.equal(isGraphDelete(`${GRAPH}/me/events/AAMk9`, {}), false);
});

test("Microsoft: deleteCreated only for an event Athena added; write refuses a DELETE outright", async () => {
  const s = new GraphSession(account("outlook-calendar", true), secrets());
  await assert.rejects(s.write("DELETE" as never, `${GRAPH}/me/events/AAMk9`, undefined), /only reads/);
  await assert.rejects(s.write("POST", `${GRAPH}/me/events`, { ...M_BODY, isOnlineMeeting: true }), /only reads/);
  await assert.rejects(s.deleteCreated("primary", "AAMk9"), /only removes events it added/);
  assert.equal(calls.length, 0);
  created.add(`${ID}|primary|AAMk9`);
  reply = () => ({ status: 204 });
  await s.deleteCreated("primary", "AAMk9");
  assert.deepEqual(calls.map((c) => [c.method, c.url.toString(), c.body]), [["DELETE", `${GRAPH}/me/events/AAMk9`, undefined]]);
});

const msOpen = (c: Call) => {
  if (c.url.pathname === "/v1.0/me") return { body: { mail: "me@example.com" } };
  if (c.url.pathname === "/v1.0/me/calendar") return { body: { id: "cal" } };
  if (c.method === "POST") return { status: 201, body: { id: "AAMkNew", webLink: "https://outlook.office365.com/owa/?itemid=AAMkNew" } };
  if (c.method === "DELETE") return { status: 204 };
  return { body: {} };
};

test("Microsoft: create_event posts exactly the allowed fields to /me/events; undo deletes only Athena's", async () => {
  reply = (c) => (c.method === "POST" ? { status: 200, body: { id: "AAMkNew", webLink: "https://outlook.office365.com/owa/?itemid=AAMkNew" } } : msOpen(c));
  const m = await openMicrosoft(account("outlook-calendar", true), secrets());
  const r = await m.call(CREATE_TOOL, ARGS);
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).link, "https://outlook.office365.com/owa/?itemid=AAMkNew");
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["POST", `${GRAPH}/me/events`, M_BODY]]);
  assert.equal((await m.call(UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "AAMkOther" })).isError, true);
  created.add(`${ID}|primary|AAMkNew`);
  assert.equal((await m.call(UNDO_CREATE_TOOL, { calendarId: "primary", eventId: "AAMkNew" })).isError, false);
  assert.deepEqual(writes().map((w) => w.method), ["POST", "DELETE"]);
});

// ---------- iCloud ----------

const NOW = new Date("2026-11-09T12:00:00Z");
const ics = (a = readCreateArgs(ARGS, "Europe/London")) => newEventIcs(a, { uid: "A1B2C3D4-0000-4000-8000-000000000001", organizer: "me@icloud.com", now: NOW });

test("iCloud: the new event's file is exactly the allowed properties, and anything more is refused", () => {
  const good = ics();
  assert.equal(isNewEventIcs(good), true);
  assert.match(good, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/Athena\/\/Calendar\/\/EN\r\nBEGIN:VEVENT\r\n/);
  assert.match(good, /\r\nDTSTART:20261112T130000Z\r\nDTEND:20261112T140000Z\r\nSUMMARY:Lunch with Priya\r\nLOCATION:Dishoom\\, King's Cross\r\n/);
  assert.ok(good.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "long lines are folded");
  assert.match(good.replace(/\r\n /g, ""), /\r\nORGANIZER:mailto:me@icloud\.com\r\nATTENDEE;CN="Priya Shah";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:priya@example\.com\r\n/);
  const alone = newEventIcs(readCreateArgs({ summary: "Dentist", start: ARGS.start, end: ARGS.end }, "UTC"), { uid: "U1", organizer: "me@icloud.com", now: NOW });
  assert.equal(isNewEventIcs(alone), true);
  assert.doesNotMatch(alone, /ORGANIZER|ATTENDEE/, "no guests, no organiser: nobody is sent anything");
  const swap = (from: RegExp | string, to: string) => good.replace(from, to);
  const bad = [
    swap("END:VEVENT", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT"),
    swap("END:VEVENT", "RRULE:FREQ=WEEKLY\r\nEND:VEVENT"),
    swap("END:VEVENT", "URL:https://evil.example\r\nEND:VEVENT"),
    swap("END:VEVENT", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\nEND:VEVENT"),
    swap("END:VEVENT", "ATTACH:https://evil.example/x\r\nEND:VEVENT"),
    swap("END:VEVENT", "SUMMARY:Second title\r\nEND:VEVENT"),
    swap("DTSTART:20261112T130000Z", "DTSTART;TZID=Europe/London:20261112T130000"),
    swap("DTSTART:20261112T130000Z", "DTSTART;VALUE=DATE:20261112"),
    swap("DTEND:20261112T140000Z", "DTEND:20261112T120000Z"),
    swap("ROLE=REQ-PARTICIPANT", "ROLE=CHAIR;SCHEDULE-AGENT=CLIENT"),
    swap(/ORGANIZER:[^\r]+\r\n/, ""),
    swap("BEGIN:VEVENT", "BEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT"),
    swap("PRODID:-//Athena//Calendar//EN", "PRODID:-//Other//EN"),
    swap("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:2\r\nEND:VEVENT\r\nEND:VCALENDAR"),
  ];
  for (const b of bad) assert.equal(isNewEventIcs(b), false, b);
});

const HOME = "https://p42-caldav.icloud.com/123/calendars/";
const davCtx = (on: boolean): IcloudCalendarContext => ({
  session: new DavSession("caldav", { username: "me@icloud.com", token: "abcd-efgh-ijkl-mnop" }),
  home: HOME,
  emails: ["me@icloud.com"],
  timeZone: "Europe/London",
  now: () => NOW,
  calendars: async () => [{ id: "home", href: `${HOME}home/`, name: "Home", primary: true, accessRole: "owner" } as never, { id: "shared", href: `${HOME}shared/`, name: "Family", primary: false, accessRole: "reader" } as never],
  moving: on,
  createdByAthena: on ? async (cal, ev) => created.has(`${ID}|${cal}|${ev}`) : undefined,
});
const tool = (name: string) => ICLOUD_CALENDAR_TOOLS.find((t) => t.name === name)!;

test("iCloud: create_event PUTs one new file with If-None-Match: *, and only to a calendar you can write to", async () => {
  reply = () => ({ status: 201 });
  const out = (await tool(CREATE_TOOL).run(davCtx(true), ARGS)) as { id: string; calendarId: string };
  assert.equal(out.calendarId, "home");
  assert.equal(writes().length, 1);
  const put = writes()[0];
  assert.equal(put.method, "PUT");
  assert.match(put.url.toString(), /^https:\/\/p42-caldav\.icloud\.com\/123\/calendars\/home\/[0-9A-F-]{36}\.ics$/);
  assert.equal(put.headers["If-None-Match"], "*");
  assert.equal(put.headers["If-Match"], undefined);
  assert.equal(isNewEventIcs(String(put.body)), true);
  // The id the tools give out names that file.
  assert.equal(Buffer.from(out.id, "base64url").toString("utf8"), `home/${put.url.pathname.split("/").pop()}`);
  await assert.rejects(tool(CREATE_TOOL).run(davCtx(true), { ...ARGS, calendarId: "shared" }), /can't add events to Family/);
  await assert.rejects(tool(CREATE_TOOL).run(davCtx(false), ARGS), /isn't allowed/);
  assert.equal(writes().length, 1);
});

test("iCloud: the session refuses to PUT anything but a new event, or to PUT over a file", async () => {
  const s = new DavSession("caldav", { username: "me@icloud.com", token: "abcd-efgh-ijkl-mnop" });
  await assert.rejects(s.putIfNoneMatch(`${HOME}home/x.ics`, ics().replace("END:VEVENT", "RRULE:FREQ=DAILY\r\nEND:VEVENT")), /only adds calendar events/);
  await assert.rejects(s.putIfNoneMatch(`${HOME}home/`, ics()), /only adds calendar events/);
  await assert.rejects(s.deleteIfMatch(`${HOME}home/x.ics`, ""), /only removes/);
  await assert.rejects(new DavSession("carddav", { username: "me@icloud.com", token: "x" }).putIfNoneMatch("https://contacts.icloud.com/1/card/x.ics", ics()), /only adds/);
  assert.equal(calls.length, 0);
});

test("iCloud: undo_create_event deletes only Athena's file, over the version it reads (If-Match)", async () => {
  const file = "A1B2C3D4-0000-4000-8000-000000000001.ics";
  const id = Buffer.from(`home/${file}`, "utf8").toString("base64url");
  const other = Buffer.from("home/SOMEONE-ELSES.ics", "utf8").toString("base64url");
  reply = (c) => (c.method === "GET" ? { text: ics(), etag: '"e1"' } : { status: 204 });
  await assert.rejects(tool(UNDO_CREATE_TOOL).run(davCtx(true), { calendarId: "home", eventId: other }), /only removes events it added/);
  created.add(`${ID}|home|${id}`);
  // Right event, wrong calendar: refused.
  await assert.rejects(tool(UNDO_CREATE_TOOL).run(davCtx(true), { calendarId: "shared", eventId: id }), /only removes events it added/);
  await assert.rejects(tool(UNDO_CREATE_TOOL).run(davCtx(false), { calendarId: "home", eventId: id }), /isn't allowed/);
  assert.equal(calls.length, 0);
  await tool(UNDO_CREATE_TOOL).run(davCtx(true), { calendarId: "home", eventId: id });
  assert.deepEqual(calls.map((c) => [c.method, c.url.toString()]), [["GET", `${HOME}home/${file}`], ["DELETE", `${HOME}home/${file}`]]);
  assert.equal(calls[1].headers["If-Match"], '"e1"');
});

// ---------- Blocks: busy, and Focus time on Google only ----------

const FOCUS = { eventType: "focusTime", focusTimeProperties: { autoDeclineMode: "declineOnlyNewConflictingInvitations", chatStatus: "doNotDisturb" } };
const BLOCK = { summary: "Draft the Q3 plan", start: G_BODY.start, end: G_BODY.end };

test("Google: Focus time passes only as exactly those two fields, on a block with no guests", () => {
  assert.equal(isCreateInsert({ method: "POST", url: INSERT, body: { ...BLOCK, ...FOCUS } }), true);
  const bad: unknown[] = [
    { ...BLOCK, eventType: "focusTime" },
    { ...BLOCK, focusTimeProperties: FOCUS.focusTimeProperties },
    { ...BLOCK, ...FOCUS, attendees: [{ email: "priya@example.com" }] },
    { ...BLOCK, ...FOCUS, eventType: "outOfOffice" },
    { ...BLOCK, ...FOCUS, focusTimeProperties: { ...FOCUS.focusTimeProperties, autoDeclineMode: "declineAllConflictingInvitations" } },
    { ...BLOCK, ...FOCUS, focusTimeProperties: { ...FOCUS.focusTimeProperties, chatStatus: "available" } },
    { ...BLOCK, ...FOCUS, focusTimeProperties: { ...FOCUS.focusTimeProperties, declineMessage: "Busy" } },
    { ...BLOCK, ...FOCUS, transparency: "opaque" },
  ];
  for (const body of bad) assert.equal(isCreateInsert({ method: "POST", url: INSERT, body }), false, JSON.stringify(body));
  assert.throws(() => readCreateArgs({ ...ARGS, focusTime: true }, "UTC"), /only for a block/);
  assert.throws(() => readCreateArgs({ ...ARGS, block: true }, "UTC"), /no guests/);
});

test("Google: a block with Focus time on is sent as Focus time on the main calendar, and a plain block otherwise", async () => {
  reply = googleOpen;
  const g = await openGoogle(account("google-calendar", true), secrets());
  const base = { summary: "Draft the Q3 plan", start: ARGS.start, end: ARGS.end, timeZone: "Europe/London" };
  assert.equal((await g.call(CREATE_TOOL, { ...base, block: true, focusTime: true })).isError, false);
  assert.equal((await g.call(CREATE_TOOL, { ...base, block: true })).isError, false);
  const [focus, plain] = writes().map((w) => w.body as Record<string, unknown>);
  assert.deepEqual(Object.keys(focus).sort(), ["end", "eventType", "focusTimeProperties", "start", "summary"]);
  assert.deepEqual(focus.focusTimeProperties, FOCUS.focusTimeProperties);
  assert.deepEqual(Object.keys(plain).sort(), ["end", "start", "summary"]);
});

test("Microsoft: a block is busy (showAs) with no guests, and only one of the owner's calendars takes an event", async () => {
  assert.equal(isCreatePost(`${GRAPH}/me/events`, { subject: "Block", start: M_BODY.start, end: M_BODY.end, showAs: "busy" }), true);
  assert.equal(isCreatePost(`${GRAPH}/me/events`, { ...M_BODY, showAs: "busy" }), false, "not with guests");
  assert.equal(isCreatePost(`${GRAPH}/me/events`, { subject: "Block", start: M_BODY.start, end: M_BODY.end, showAs: "oof" }), false);
  const acct = { ...account("outlook-calendar", true), calendars: ["AAMkMine=", "AAMkShared="] } as Connector;
  reply = (c) => {
    const p = c.url.pathname;
    if (p === "/v1.0/me/calendars") return { body: { value: [{ id: "AAMkMain=", name: "Calendar", isDefaultCalendar: true, canEdit: true }, { id: "AAMkMine=", name: "Side", canEdit: true, owner: { address: "me@example.com" } }, { id: "AAMkShared=", name: "Boss", canEdit: true, owner: { address: "boss@example.com" } }] } };
    if (p === "/v1.0/me/calendars/AAMkMine=") return { body: { id: "AAMkMine=", canEdit: true, owner: { address: "me@example.com" } } };
    if (p === "/v1.0/me/calendars/AAMkShared=") return { body: { id: "AAMkShared=", canEdit: true, owner: { address: "boss@example.com" } } };
    if (c.method === "POST") return { body: { id: "AAMkNew" } };
    return msOpen(c);
  };
  const m = await openMicrosoft(acct, secrets());
  const block = { summary: "Block", start: ARGS.start, end: ARGS.end, block: true, focusTime: true };
  const shared = await m.call(CREATE_TOOL, { ...block, calendarId: "AAMkShared=" });
  assert.equal(shared.isError, true);
  assert.match(shared.text, /your own Outlook calendars/);
  assert.equal((await m.call(CREATE_TOOL, { ...block, calendarId: "AAMkNotChosen=" })).isError, true);
  assert.deepEqual(writes(), [], "nothing sent to a calendar that isn't the owner's");
  assert.equal((await m.call(CREATE_TOOL, { ...block, calendarId: "AAMkMine=" })).isError, false);
  assert.deepEqual(writes().map((w) => [w.url.pathname, w.body]), [["/v1.0/me/calendars/AAMkMine=/events", { subject: "Block", start: M_BODY.start, end: M_BODY.end, showAs: "busy" }]], "no Focus time on Outlook");
});
