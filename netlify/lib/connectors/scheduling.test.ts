// Run: npx tsx --test netlify/lib/connectors/scheduling.test.ts
// Finding times and moving events, at the adapters: guests' free/busy is read as busy or free only,
// and move_event sends exactly a new start and end, behind "Let Athena add and update events".
// fetch is stubbed; every request is recorded.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canMove, canRsvp, classifyTool, FREE_BUSY_TOOL, MOVE_MARKER, MOVE_TOOL, oauthScope, presetFor, RSVP_SCOPE } from "../../../lib/connector-presets";
import { directTools, openGoogle } from "./google-direct";
import { FREEBUSY_URL, GoogleSession, isFreeBusyPost, isMovePatch, isRsvpPatch, retryWaits } from "./google-api";
import { parseFreeBusy } from "./google-calendar";
import { microsoftTools, openMicrosoft } from "./microsoft-direct";
import { allowedWrite, GraphSession, graphRetryWaits, isMovePatch as isGraphMove, isRsvpPost, isSchedulePost, SCHEDULE_URL } from "./microsoft-graph";
import { parseSchedule } from "./microsoft-calendar";
import { onlyTimesChanged, rewriteTimes } from "./icloud-move";
import { icloudTools } from "./icloud-direct";
import { callTool, type OpenConnector } from "./mcp-client";

type Call = { method: string; url: URL; body: unknown };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined;

beforeEach(() => {
  calls = [];
  reply = () => undefined;
  retryWaits.ms = [1, 1];
  graphRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c) ?? { body: {} };
    return new Response(r.status === 202 || r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function account(provider: "google-calendar" | "outlook-calendar" | "icloud-calendar", opts: { move?: boolean; rsvp?: boolean } = {}): Connector {
  const p = presetFor(provider);
  const scope = [p.scope, opts.rsvp ? RSVP_SCOPE[provider] : "", opts.move ? MOVE_MARKER : ""].filter(Boolean).join(" ");
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    name: p.label,
    provider,
    account_label: "work",
    url: p.url,
    auth_type: provider === "icloud-calendar" ? "token" : "oauth",
    scope,
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
const writes = () => calls.filter((c) => c.method !== "GET");

// ---------- the switch ----------

test("the move switch is its own marker: it doesn't turn on answering, and never reaches OAuth as itself", () => {
  const g = account("google-calendar", { move: true });
  assert.equal(canMove(g), true);
  assert.equal(canRsvp(g), false, "moving doesn't answer invites");
  assert.equal(canMove(account("google-calendar")), false);
  assert.equal(canMove({ provider: "gmail", scope: MOVE_MARKER }), false);
  // Google and Outlook: the marker comes out, the write permission goes in.
  assert.equal(oauthScope(g), `${presetFor("google-calendar").scope} ${RSVP_SCOPE["google-calendar"]}`);
  assert.equal(oauthScope(account("outlook-calendar", { move: true })).split(" ").includes("Calendars.ReadWrite"), true);
  assert.ok(!oauthScope(account("outlook-calendar", { move: true })).includes("athena:"));
  // Both on: the permission once.
  assert.equal(oauthScope(account("google-calendar", { move: true, rsvp: true })).split(" ").filter((s) => s === RSVP_SCOPE["google-calendar"]).length, 1);
  // Off: what it was.
  assert.equal(oauthScope(account("google-calendar")), presetFor("google-calendar").scope);
});

test("move_event is only offered with the switch on, and is classed as a write", () => {
  assert.ok(!directTools(account("google-calendar")).some((t) => t.name === MOVE_TOOL));
  assert.ok(!microsoftTools(account("outlook-calendar")).some((t) => t.name === MOVE_TOOL));
  assert.ok(!icloudTools(account("icloud-calendar")).some((t) => t.name === MOVE_TOOL));
  const g = directTools(account("google-calendar", { move: true })).find((t) => t.name === MOVE_TOOL)!;
  assert.ok(g && microsoftTools(account("outlook-calendar", { move: true })).some((t) => t.name === MOVE_TOOL) && icloudTools(account("icloud-calendar", { move: true })).some((t) => t.name === MOVE_TOOL));
  assert.equal(classifyTool("google-calendar", MOVE_TOOL, g.annotations), "write");
  // free_busy is a read, offered on Google and Outlook without any switch.
  const fb = directTools(account("google-calendar")).find((t) => t.name === FREE_BUSY_TOOL)!;
  assert.equal(classifyTool("google-calendar", FREE_BUSY_TOOL, fb.annotations), "read");
});

test("callTool refuses move_event without the switch, and on an MCP server, before anything is sent", async () => {
  const open: OpenConnector = { connector: account("google-calendar"), direct: { tools: [], call: async () => assert.fail("never reached") }, close: async () => undefined };
  await assert.rejects(callTool(open, MOVE_TOOL, { eventId: "e1", start: "2026-11-12T14:00:00Z" }), /isn't on/);
  const mcp = { connector: account("google-calendar", { move: true }), client: {} as never, close: async () => undefined } as unknown as OpenConnector;
  await assert.rejects(callTool(mcp, MOVE_TOOL, { eventId: "e1", start: "2026-11-12T14:00:00Z" }), /can't change events through/);
  assert.equal(calls.length, 0);
});

// ---------- Google: freeBusy and the move patch ----------

const EVENT_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_1?sendUpdates=all";
const MOVE = { start: { dateTime: "2026-11-12T14:00:00Z", timeZone: "Europe/London" }, end: { dateTime: "2026-11-12T14:30:00Z", timeZone: "Europe/London" } };
const FB = { timeMin: "2026-11-09T00:00:00.000Z", timeMax: "2026-11-16T00:00:00.000Z", items: [{ id: "priya@example.com" }] };

test("Google: only a time change passes the move gate", () => {
  assert.equal(isMovePatch({ method: "PATCH", url: EVENT_URL, body: MOVE }), true);
  assert.equal(isMovePatch({ method: "PATCH", url: EVENT_URL, body: { start: { dateTime: "2026-11-12T14:00:00+00:00" }, end: { dateTime: "2026-11-12T15:00:00+00:00" } } }), true);
  const bad: Array<[string, string, unknown]> = [
    ["PATCH", EVENT_URL, { ...MOVE, summary: "Renamed" }],
    ["PATCH", EVENT_URL, { ...MOVE, attendees: [] }],
    ["PATCH", EVENT_URL, { ...MOVE, location: "Room 2" }],
    ["PATCH", EVENT_URL, { start: MOVE.start }],
    ["PATCH", EVENT_URL, { start: { date: "2026-11-12" }, end: { date: "2026-11-13" } }],
    ["PATCH", EVENT_URL, { start: { ...MOVE.start, extra: 1 }, end: MOVE.end }],
    ["PATCH", EVENT_URL, { start: { dateTime: "2026-11-12T14:00:00" }, end: { dateTime: "2026-11-12T15:00:00" } }],
    ["PATCH", EVENT_URL, { start: MOVE.end, end: MOVE.start }],
    ["PATCH", EVENT_URL, { start: { dateTime: "2026-11-12T14:00:00Z", timeZone: "Europe/London; DROP" }, end: MOVE.end }],
    ["PATCH", EVENT_URL.replace("?sendUpdates=all", "?sendUpdates=none"), MOVE],
    ["PATCH", EVENT_URL.replace("?sendUpdates=all", ""), MOVE],
    ["PUT", EVENT_URL, MOVE],
    ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev_1/move?destination=x", {}],
    ["DELETE", EVENT_URL, undefined],
  ];
  for (const [method, url, body] of bad) assert.equal(isMovePatch({ method, url, body }), false, `${method} ${url} ${JSON.stringify(body)}`);
  // The two calendar patches don't stand in for each other.
  assert.equal(isRsvpPatch({ method: "PATCH", url: EVENT_URL, body: MOVE }), false);
});

test("Google: freeBusy is the one other POST, and only a range and addresses", () => {
  assert.equal(isFreeBusyPost({ method: "POST", url: FREEBUSY_URL, body: FB }), true);
  const bad: unknown[] = [
    { ...FB, timeZone: "UTC" },
    { ...FB, items: [{ id: "priya@example.com", busy: true }] },
    { ...FB, items: [{ id: "not an email" }] },
    { ...FB, items: [] },
    { ...FB, items: Array.from({ length: 21 }, (_, i) => ({ id: `p${i}@example.com` })) },
    { ...FB, timeMin: "next week" },
    { ...FB, calendarExpansionMax: 50 },
  ];
  for (const body of bad) assert.equal(isFreeBusyPost({ method: "POST", url: FREEBUSY_URL, body }), false, JSON.stringify(body));
  assert.equal(isFreeBusyPost({ method: "POST", url: `${FREEBUSY_URL}?x=1`, body: FB }), false);
  assert.equal(isFreeBusyPost({ method: "PATCH", url: FREEBUSY_URL, body: FB }), false);
});

test("Google: the session refuses a move with anything else in it before it reaches the network", async () => {
  const s = new GoogleSession(account("google-calendar", { move: true }), secrets());
  await assert.rejects(s.request({ method: "PATCH", url: EVENT_URL, body: { ...MOVE, summary: "x" } as never }), /only reads/);
  await assert.rejects(s.request({ method: "POST", url: FREEBUSY_URL, body: { ...FB, extra: 1 } }), /only reads/);
  assert.equal(calls.length, 0);
});

test("parseFreeBusy: busy times only, and a calendar Google wouldn't show is unknown", () => {
  const r = parseFreeBusy(
    {
      calendars: {
        "Priya@Example.com": { busy: [{ start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z", summary: "should never be read" }, { start: "bad", end: "2026-11-10T12:00:00Z" }] },
        "sam@other.org": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
      },
    },
    ["priya@example.com", "sam@other.org", "noone@example.com"],
  );
  assert.deepEqual(r, [
    { email: "priya@example.com", status: "known", busy: [{ start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z" }] },
    { email: "sam@other.org", status: "unknown", busy: [] },
    { email: "noone@example.com", status: "unknown", busy: [] },
  ]);
  assert.deepEqual(parseFreeBusy(null, ["a@b.c"]), [{ email: "a@b.c", status: "unknown", busy: [] }]);
});

const googleOpen = (c: Call, event: Record<string, unknown>) => {
  if (c.url.pathname.endsWith("/calendars/primary") && c.method === "GET") return { body: { id: "me@example.com", timeZone: "Europe/London" } };
  if (c.url.pathname.endsWith("/freeBusy")) return { body: { calendars: { "priya@example.com": { busy: [{ start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z" }] } } } };
  if (c.method === "GET") return { body: event };
  return { body: { id: event.id } };
};
const MINE = { id: "ev_1", status: "confirmed", summary: "Design review", start: { dateTime: "2026-11-10T10:00:00Z", timeZone: "Europe/London" }, end: { dateTime: "2026-11-10T10:30:00Z", timeZone: "Europe/London" }, organizer: { self: true }, attendees: [{ self: true }, { email: "priya@example.com" }, { email: "room@resource", resource: true }] };

test("Google: free_busy sends one freeBusy read and returns busy or free", async () => {
  reply = (c) => googleOpen(c, MINE);
  const g = await openGoogle(account("google-calendar"), secrets());
  const r = await g.call(FREE_BUSY_TOOL, { emails: ["priya@example.com"], startTime: "2026-11-09T00:00:00Z", endTime: "2026-11-16T00:00:00Z" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text).people[0].busy, [{ start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z" }]);
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["POST", FREEBUSY_URL, { timeMin: "2026-11-09T00:00:00.000Z", timeMax: "2026-11-16T00:00:00.000Z", items: [{ id: "priya@example.com" }] }]]);
});

test("Google: move_event reads the event, then patches only start and end with sendUpdates=all", async () => {
  reply = (c) => googleOpen(c, MINE);
  const g = await openGoogle(account("google-calendar", { move: true }), secrets());
  const r = await g.call(MOVE_TOOL, { eventId: "ev_1", start: "2026-11-12T14:00:00Z", expect: "2026-11-10T10:00:00Z" });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.deepEqual(out.before, { start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T10:30:00.000Z" });
  assert.deepEqual(out.after, { start: "2026-11-12T14:00:00.000Z", end: "2026-11-12T14:30:00.000Z" });
  assert.equal(out.guests, 1, "the room isn't a guest");
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["PATCH", EVENT_URL, MOVE]]);
});

test("Google: someone else's event, an all-day one, a series, a cancelled one or one that moved since: nothing sent", async () => {
  const cases: Array<[Record<string, unknown>, RegExp, Record<string, unknown>?]> = [
    [{ ...MINE, organizer: { email: "boss@example.com" } }, /Someone else organises/],
    [{ ...MINE, start: { date: "2026-11-10" }, end: { date: "2026-11-11" } }, /all-day/],
    [{ ...MINE, recurrence: ["RRULE:FREQ=WEEKLY"] }, /repeating series/],
    [{ ...MINE, status: "cancelled" }, /cancelled/],
    [MINE, /moved since/, { expect: "2026-11-10T09:00:00Z" }],
  ];
  for (const [event, why, extra] of cases) {
    reply = (c) => googleOpen(c, event);
    const g = await openGoogle(account("google-calendar", { move: true }), secrets());
    const r = await g.call(MOVE_TOOL, { eventId: "ev_1", start: "2026-11-12T14:00:00Z", ...extra });
    assert.equal(r.isError, true);
    assert.match(r.text, why);
  }
  assert.deepEqual(writes(), []);
});

test("Google: without the switch the session has no way to patch a move at all", async () => {
  reply = (c) => googleOpen(c, MINE);
  const g = await openGoogle(account("google-calendar"), secrets());
  const r = await g.call(MOVE_TOOL, { eventId: "ev_1", start: "2026-11-12T14:00:00Z" });
  assert.equal(r.isError, true);
  assert.deepEqual(writes(), []);
});

// ---------- Microsoft: getSchedule and the move patch ----------

const GRAPH_EVENT = "https://graph.microsoft.com/v1.0/me/events/AAMk1";
const G_MOVE = { start: { dateTime: "2026-11-12T14:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-12T14:30:00", timeZone: "UTC" } };
const SCHEDULE = { schedules: ["priya@example.com"], startTime: { dateTime: "2026-11-09T00:00:00", timeZone: "UTC" }, endTime: { dateTime: "2026-11-16T00:00:00", timeZone: "UTC" }, availabilityViewInterval: 30 };

test("Microsoft: only a time change passes the move gate, and only getSchedule and replies are POSTed", () => {
  assert.equal(isGraphMove(GRAPH_EVENT, G_MOVE), true);
  const bad: Array<[string, unknown]> = [
    [GRAPH_EVENT, { ...G_MOVE, subject: "Renamed" }],
    [GRAPH_EVENT, { ...G_MOVE, attendees: [] }],
    [GRAPH_EVENT, { start: G_MOVE.start }],
    [GRAPH_EVENT, { start: { ...G_MOVE.start, timeZone: "Pacific Standard Time" }, end: G_MOVE.end }],
    [GRAPH_EVENT, { start: G_MOVE.end, end: G_MOVE.start }],
    [GRAPH_EVENT, { start: { dateTime: "2026-11-12T14:00:00Z", timeZone: "UTC" }, end: G_MOVE.end }],
    [`${GRAPH_EVENT}/forward`, G_MOVE],
    ["https://graph.microsoft.com/v1.0/me/calendars/x/events/AAMk1", G_MOVE],
    ["https://evil.example/v1.0/me/events/AAMk1", G_MOVE],
  ];
  for (const [url, body] of bad) assert.equal(isGraphMove(url, body), false, `${url} ${JSON.stringify(body)}`);
  assert.equal(isSchedulePost(SCHEDULE_URL, SCHEDULE), true);
  assert.equal(isSchedulePost(SCHEDULE_URL, { ...SCHEDULE, extra: true }), false);
  assert.equal(isSchedulePost(SCHEDULE_URL, { ...SCHEDULE, schedules: ["nope"] }), false);
  assert.equal(isSchedulePost("https://graph.microsoft.com/v1.0/me/sendMail", SCHEDULE), false);
  assert.equal(allowedWrite("PATCH", GRAPH_EVENT, G_MOVE), true);
  assert.equal(allowedWrite("POST", GRAPH_EVENT, G_MOVE), false);
  assert.equal(allowedWrite("DELETE", GRAPH_EVENT, undefined), false);
  assert.equal(allowedWrite("PATCH", SCHEDULE_URL, SCHEDULE), false);
  assert.equal(allowedWrite("POST", `${GRAPH_EVENT}/decline`, { sendResponse: true }), isRsvpPost(`${GRAPH_EVENT}/decline`, { sendResponse: true }));
});

test("Microsoft: the session refuses anything else before it reaches the network", async () => {
  const s = new GraphSession(account("outlook-calendar", { move: true }), secrets());
  await assert.rejects(s.write("PATCH", GRAPH_EVENT, { ...G_MOVE, body: { content: "x" } }), /only reads/);
  await assert.rejects(s.write("POST", "https://graph.microsoft.com/v1.0/me/sendMail", {}), /only reads/);
  await assert.rejects(s.write("POST", SCHEDULE_URL, { ...SCHEDULE, $select: "subject" }), /only reads/);
  assert.equal(calls.length, 0);
});

test("parseSchedule: status, start and end only (subjects dropped), working hours in their zone, unknowns", () => {
  const r = parseSchedule(
    {
      value: [
        {
          scheduleId: "Priya@example.com",
          availabilityView: "0020",
          scheduleItems: [
            { status: "busy", subject: "1:1 with CEO", location: "Room 4", start: { dateTime: "2026-11-10T10:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-10T11:00:00.0000000", timeZone: "UTC" } },
            { status: "free", start: { dateTime: "2026-11-10T12:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-10T13:00:00.0000000", timeZone: "UTC" } },
            { status: "oof", start: { dateTime: "2026-11-11T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-12T00:00:00.0000000", timeZone: "UTC" } },
          ],
          workingHours: { daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], startTime: "08:00:00.0000000", endTime: "16:30:00.0000000", timeZone: { name: "Eastern Standard Time" } },
        },
        { scheduleId: "sam@other.org", error: { message: "Not shared", responseCode: "ErrorFreeBusyGenerationFailed" } },
        { scheduleId: "ana@example.com", availabilityView: "4444" },
      ],
    },
    ["priya@example.com", "sam@other.org", "ana@example.com"],
  );
  assert.deepEqual(r[0], {
    email: "priya@example.com",
    status: "known",
    busy: [
      { start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z" },
      { start: "2026-11-11T00:00:00Z", end: "2026-11-12T00:00:00Z" },
    ],
    hours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "16:30", tz: "America/New_York" },
  });
  assert.ok(!JSON.stringify(r).includes("CEO") && !JSON.stringify(r).includes("Room 4"));
  assert.equal(r[1].status, "unknown");
  assert.equal(r[2].status, "unknown");
});

const msOpen = (c: Call, event: Record<string, unknown>) => {
  if (c.url.pathname === "/v1.0/me") return { body: { mail: "me@example.com" } };
  if (c.url.pathname === "/v1.0/me/calendar") return { body: { id: "cal" } };
  if (c.url.pathname.endsWith("/getSchedule")) return { body: { value: [{ scheduleId: "priya@example.com", availabilityView: "0", scheduleItems: [] }] } };
  if (c.method === "GET") return { body: event };
  return { status: 200, body: { id: "AAMk1" } };
};
const MS_MINE = { id: "AAMk1", subject: "Design review", isOrganizer: true, isCancelled: false, isAllDay: false, type: "singleInstance", start: { dateTime: "2026-11-10T10:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-10T10:30:00.0000000", timeZone: "UTC" }, attendees: [{ type: "required" }, { type: "resource" }] };

test("Microsoft: free_busy posts getSchedule and nothing else", async () => {
  reply = (c) => msOpen(c, MS_MINE);
  const m = await openMicrosoft(account("outlook-calendar"), secrets());
  const r = await m.call(FREE_BUSY_TOOL, { emails: ["priya@example.com"], startTime: "2026-11-09T00:00:00Z", endTime: "2026-11-16T00:00:00Z" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["POST", SCHEDULE_URL, SCHEDULE]]);
});

test("Microsoft: move_event checks it's yours, then PATCHes only start and end", async () => {
  reply = (c) => msOpen(c, MS_MINE);
  const m = await openMicrosoft(account("outlook-calendar", { move: true }), secrets());
  const r = await m.call(MOVE_TOOL, { eventId: "AAMk1", start: "2026-11-12T14:00:00Z" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text).before, { start: "2026-11-10T10:00:00Z", end: "2026-11-10T10:30:00Z" });
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString(), w.body]), [["PATCH", GRAPH_EVENT, G_MOVE]]);
});

test("Microsoft: someone else's event, an all-day one or a series isn't touched", async () => {
  for (const e of [{ ...MS_MINE, isOrganizer: false }, { ...MS_MINE, isAllDay: true }, { ...MS_MINE, type: "seriesMaster" }, { ...MS_MINE, isCancelled: true }]) {
    reply = (c) => msOpen(c, e);
    const m = await openMicrosoft(account("outlook-calendar", { move: true }), secrets());
    assert.equal((await m.call(MOVE_TOOL, { eventId: "AAMk1", start: "2026-11-12T14:00:00Z" })).isError, true);
  }
  assert.deepEqual(writes(), []);
});

// ---------- iCloud: only DTSTART and DTEND ----------

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "DTSTAMP:20261101T090000Z",
  "SUMMARY:Design review",
  "DTSTART;TZID=Europe/London:20261110T100000",
  "DTEND;TZID=Europe/London:20261110T103000",
  "ORGANIZER;CN=Me:mailto:me@icloud.example",
  "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@icloud.example",
  "ATTENDEE;CN=Priya;PARTSTAT=NEEDS-ACTION:mailto:priya@example.com",
  "SEQUENCE:2",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "ACTION:DISPLAY",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const at = (iso: string) => Date.parse(iso);

test("iCloud: a move rewrites DTSTART and DTEND in their own zone, bumps SEQUENCE for guests, and nothing else", () => {
  const r = rewriteTimes(ICS, { emails: ["me@icloud.example"], start: at("2026-11-12T14:00:00Z"), ownerZone: "Europe/London" });
  assert.equal(r.changed, true);
  assert.deepEqual(r.before, { start: at("2026-11-10T10:00:00Z"), end: at("2026-11-10T10:30:00Z") });
  assert.deepEqual(r.after, { start: at("2026-11-12T14:00:00Z"), end: at("2026-11-12T14:30:00Z") });
  assert.equal(r.guests, 1);
  const want = ICS.replace("20261110T100000", "20261112T140000").replace("20261110T103000", "20261112T143000").replace("SEQUENCE:2", "SEQUENCE:3");
  assert.equal(r.text, want);
  assert.equal(onlyTimesChanged(ICS, r.text), true);
  // A sneaky change elsewhere fails the guard.
  assert.equal(onlyTimesChanged(ICS, r.text.replace("Design review", "Cancelled")), false);
  assert.equal(onlyTimesChanged(ICS, r.text.replace("ATTENDEE;CN=Priya;PARTSTAT=NEEDS-ACTION:mailto:priya@example.com\r\n", "")), false);
});

test("iCloud: UTC times stay UTC; no guests, no SEQUENCE change; a missing SEQUENCE is added when there are", () => {
  const utc = ICS.replace("DTSTART;TZID=Europe/London:20261110T100000", "DTSTART:20261110T100000Z").replace("DTEND;TZID=Europe/London:20261110T103000", "DTEND:20261110T103000Z");
  const r = rewriteTimes(utc, { emails: ["me@icloud.example"], start: at("2026-11-12T14:00:00Z"), end: at("2026-11-12T15:00:00Z"), ownerZone: "Europe/London" });
  assert.match(r.text, /DTSTART:20261112T140000Z\r\nDTEND:20261112T150000Z/);
  const alone = ICS.replace("ATTENDEE;CN=Priya;PARTSTAT=NEEDS-ACTION:mailto:priya@example.com\r\n", "");
  assert.match(rewriteTimes(alone, { emails: ["me@icloud.example"], start: at("2026-11-12T14:00:00Z"), ownerZone: "Europe/London" }).text, /SEQUENCE:2/);
  const noSeq = ICS.replace("SEQUENCE:2\r\n", "");
  const added = rewriteTimes(noSeq, { emails: ["me@icloud.example"], start: at("2026-11-12T14:00:00Z"), ownerZone: "Europe/London" }).text;
  assert.match(added, /DTEND;TZID=Europe\/London:20261112T143000\r\nSEQUENCE:1\r\n/);
  assert.equal(onlyTimesChanged(noSeq, added), true);
});

test("iCloud: someone else's, repeating, all-day, cancelled or moved-since events are refused", () => {
  const opts = { emails: ["me@icloud.example"], start: at("2026-11-12T14:00:00Z"), ownerZone: "Europe/London" };
  assert.throws(() => rewriteTimes(ICS.replace("ORGANIZER;CN=Me:mailto:me@icloud.example", "ORGANIZER:mailto:boss@example.com"), opts), /Someone else organises/);
  assert.throws(() => rewriteTimes(ICS.replace("SEQUENCE:2", "SEQUENCE:2\r\nRRULE:FREQ=WEEKLY"), opts), /repeats/);
  assert.throws(() => rewriteTimes(ICS.replace("DTSTART;TZID=Europe/London:20261110T100000", "DTSTART;VALUE=DATE:20261110"), opts), /all-day/);
  assert.throws(() => rewriteTimes(ICS.replace("SEQUENCE:2", "SEQUENCE:2\r\nSTATUS:CANCELLED"), opts), /cancelled/);
  assert.throws(() => rewriteTimes(ICS, { ...opts, expect: at("2026-11-10T09:00:00Z") }), /moved since/);
  // A duration that would change: refused; the same length: fine.
  const dur = ICS.replace("DTEND;TZID=Europe/London:20261110T103000", "DURATION:PT30M");
  assert.throws(() => rewriteTimes(dur, { ...opts, end: at("2026-11-12T15:00:00Z") }), /duration/);
  assert.match(rewriteTimes(dur, opts).text, /DTSTART;TZID=Europe\/London:20261112T140000\r\nDURATION:PT30M/);
});
