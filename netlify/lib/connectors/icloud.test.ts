// Run: npx tsx --test netlify/lib/connectors/icloud.test.ts
// iCloud Calendar and Contacts over CalDAV and CardDAV, with fetch stubbed and iCloud-shaped replies (fixtures/icloud-dav.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { directAccountProblem, directFailure, directFor } from "./direct";
import { davRetryWaits, icloudHost, IcloudError } from "./icloud-dav";
import { icloudCalendarChoices, openIcloud } from "./icloud-direct";
import { expandRule, occurrences, type IcalTime } from "./icloud-ical";
import { eventCount, sameUpcoming } from "./precheck";
import { oneOccurrence } from "./icloud-calendar";
import * as F from "./fixtures/icloud-dav";
import { contactFill, contactsDirectory, matchContact } from "./icloud-people";
import type { OpenConnector } from "./mcp-client";

type Req = { method: string; url: string; body: string; depth?: string; auth?: string };
type Reply = { status?: number; body?: string; location?: string };
const realFetch = globalThis.fetch;
let routes: Array<(r: Req) => Reply | undefined> = [];
let calls: Req[] = [];

beforeEach(() => {
  calls = [];
  routes = [];
  davRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const req: Req = { method: String(init.method), url: String(input), body: String(init.body ?? ""), depth: h.Depth, auth: h.Authorization };
    calls.push(req);
    assert.ok(["GET", "PROPFIND", "REPORT"].includes(req.method), `never ${req.method}`);
    assert.equal(init.redirect, "manual");
    for (const r of routes) {
      const reply = r(req);
      if (reply) return new Response(reply.body ?? "", { status: reply.status ?? 207, headers: { "Content-Type": "application/xml", ...(reply.location ? { Location: reply.location } : {}) } });
    }
    throw new Error(`No fixture for ${req.method} ${req.url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECRETS: ConnectorSecrets = { username: "jordan@ic.example", token: "abcd-efgh-ijkl-mnop" };
const NOW = new Date("2026-11-04T12:00:00Z");
const connector = (provider: string): Connector =>
  ({ id: "00000000-0000-4000-8000-000000000001", name: "iCloud", provider, auth_type: "token", url: "", oauth: {}, scope: "", status: "connected", status_detail: "", tools: [], allowed_tools: [] }) as unknown as Connector;

const CAL_HOME = "https://p42-caldav.icloud.com/123456789/calendars/";
const BOOK = "https://p42-contacts.icloud.com/123456789/carddavhome/card/";

function calendarServer(opts: { expanded?: boolean } = {}) {
  routes.push((r) => (r.method === "PROPFIND" && r.url === "https://caldav.icloud.com/" ? { body: F.CALDAV_PRINCIPAL } : undefined));
  routes.push((r) => (r.method === "PROPFIND" && r.url === "https://caldav.icloud.com/123456789/principal/" ? { body: F.CALDAV_HOME } : undefined));
  routes.push((r) => (r.method === "PROPFIND" && r.url === CAL_HOME ? { body: F.CALENDARS } : undefined));
  routes.push((r) => (r.method === "REPORT" && r.url === `${CAL_HOME}home/` ? { body: opts.expanded ? F.HOME_REPORT_EXPANDED : F.HOME_REPORT } : undefined));
  routes.push((r) => (r.method === "REPORT" && r.url === `${CAL_HOME}8F3A2C10-WORK/` ? { body: F.WORK_REPORT } : undefined));
  routes.push((r) => (r.method === "REPORT" && r.url === `${CAL_HOME}C77-FAMILY/` ? { body: F.EMPTY_REPORT } : undefined));
  routes.push((r) => (r.method === "GET" && r.url === `${CAL_HOME}home/STANDUP-1.ics` ? { status: 200, body: F.STANDUP_ICS } : undefined));
}

function contactsServer() {
  routes.push((r) => (r.method === "PROPFIND" && r.url === "https://contacts.icloud.com/" ? { body: F.CARDDAV_PRINCIPAL } : undefined));
  routes.push((r) => (r.method === "PROPFIND" && r.url === "https://contacts.icloud.com/123456789/principal/" ? { body: F.CARDDAV_HOME } : undefined));
  routes.push((r) => (r.method === "PROPFIND" && r.url === "https://p42-contacts.icloud.com/123456789/carddavhome/" ? { body: F.BOOKS } : undefined));
  routes.push((r) => (r.method === "PROPFIND" && r.url === BOOK ? { body: F.CARD_LIST } : undefined));
  routes.push((r) => {
    if (r.method !== "REPORT" || r.url !== BOOK) return undefined;
    const hrefs = [...r.body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]);
    return { body: F.multigetReply(hrefs) };
  });
  routes.push((r) => {
    const id = r.method === "GET" && r.url.startsWith(BOOK) ? r.url.slice(BOOK.length).replace(/\.vcf$/, "") : "";
    return id ? (F.CARDS[id] ? { status: 200, body: F.CARDS[id] } : { status: 404 }) : undefined;
  });
}

const openCal = () => openIcloud(connector("icloud-calendar"), SECRETS, { now: () => NOW, timeZone: "Europe/London" });
const openContacts = () => openIcloud(connector("icloud-contacts"), SECRETS, { timeZone: "Europe/London" });
async function call(account: Awaited<ReturnType<typeof openCal>>, name: string, args: Record<string, unknown> = {}) {
  const r = await account.call(name, args);
  assert.equal(r.isError, false, r.text);
  return JSON.parse(r.text);
}

// ---------- Presets and registry ----------

test("the presets: Email and calendar group, read tools, Apple ID field, reached directly", () => {
  for (const id of ["icloud-calendar", "icloud-contacts"]) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id)!;
    assert.equal(p.category, "email-calendar");
    assert.equal(p.auth, "token");
    assert.equal(p.username?.label, "Apple ID");
    for (const t of p.readTools) assert.equal(classifyTool(id, t), "read");
    assert.equal(directFor({ provider: id, auth_type: "token", oauth: {} })?.id, "icloud");
    assert.equal(directApi({ provider: id, auth_type: "token" }), true);
  }
  assert.deepEqual(CONNECTOR_PRESETS.find((p) => p.id === "icloud-calendar")!.recipes, ["calendar-meetings", "calendar-sync", "custom"]);
  assert.deepEqual(CONNECTOR_PRESETS.find((p) => p.id === "icloud-contacts")!.recipes, ["calendar-meetings", "custom"]);
});

test("Calendar keeps Google Calendar's tool names and arguments", () => {
  const ours = directFor({ provider: "icloud-calendar", auth_type: "token", oauth: {} })!.tools({ provider: "icloud-calendar", scope: "" });
  const google = directFor({ provider: "google-calendar", auth_type: "oauth", oauth: {} })!.tools({ provider: "google-calendar", scope: "" });
  // Guests' free/busy is Google's and Outlook's only: iCloud has no way to see other people's calendars.
  assert.deepEqual(ours.map((t) => t.name).sort(), google.map((t) => t.name).filter((n) => n !== "free_busy").sort());
  for (const t of ours) {
    const g = google.find((x) => x.name === t.name)!;
    assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), Object.keys(g.inputSchema.properties).sort(), t.name);
    assert.equal(t.annotations.readOnlyHint, true);
  }
});

// ---------- Discovery and sign-in ----------

test("discovery: principal, then the calendar home on the account's own server, with Basic auth", async () => {
  calendarServer();
  await openCal();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url} ${c.depth}`),
    ["PROPFIND https://caldav.icloud.com/ 0", "PROPFIND https://caldav.icloud.com/123456789/principal/ 0"],
  );
  assert.equal(calls[0].auth, `Basic ${Buffer.from("jordan@ic.example:abcd-efgh-ijkl-mnop").toString("base64")}`);
  assert.match(calls[0].body, /current-user-principal/);
  assert.match(calls[1].body, /calendar-home-set/);
});

test("a 401 is needs_auth: make a new app-specific password", async () => {
  routes.push(() => ({ status: 401 }));
  await assert.rejects(openCal(), (e: unknown) => {
    assert.ok(e instanceof IcloudError);
    assert.equal(directAccountProblem(e), true);
    assert.deepEqual(directFailure(e), { status: "needs_auth", detail: "Make a new app-specific password" });
    return true;
  });
  assert.equal(calls.length, 1, "a 401 isn't retried");
});

test("no Apple ID or password: needs_auth before anything is sent", async () => {
  await assert.rejects(openIcloud(connector("icloud-calendar"), { token: "abcd-efgh-ijkl-mnop" }, { timeZone: "UTC" }), (e: unknown) => directFailure(e)?.status === "needs_auth");
  assert.equal(calls.length, 0);
});

test("iCloud busy: retried, then an error (not a sign-in problem)", async () => {
  routes.push(() => ({ status: 503 }));
  await assert.rejects(openCal(), (e: unknown) => directFailure(e)?.status === "error" && !directAccountProblem(e));
  assert.equal(calls.length, 3);
});

test("the password only goes to iCloud: other hosts and redirects elsewhere are refused", async () => {
  assert.equal(icloudHost("caldav", "https://p42-caldav.icloud.com/1/calendars/"), true);
  assert.equal(icloudHost("caldav", "https://caldav.icloud.com.evil.example/"), false);
  assert.equal(icloudHost("caldav", "http://caldav.icloud.com/"), false);
  assert.equal(icloudHost("caldav", "https://p42-contacts.icloud.com/"), false);
  routes.push((r) => (r.url === "https://caldav.icloud.com/" ? { status: 301, location: "https://login.evil.example/" } : undefined));
  await assert.rejects(openCal(), /won't send your password/);
  assert.equal(calls.length, 1);
});

test("a home set on another host is refused before anything is sent there", async () => {
  routes.push((r) => (r.url === "https://caldav.icloud.com/" ? { body: F.CALDAV_PRINCIPAL } : undefined));
  routes.push(() => ({ body: F.CALDAV_HOME.replace("p42-caldav.icloud.com:443", "dav.evil.example") }));
  await assert.rejects(openCal(), /won't send your password/);
  assert.ok(calls.every((c) => new URL(c.url).hostname.endsWith("icloud.com")));
});

// ---------- Calendars ----------

test("list_calendars: event calendars only, primary first, shared ones read-only", async () => {
  calendarServer();
  const a = await openCal();
  const r = await call(a, "list_calendars");
  assert.deepEqual(r.calendars, [
    { id: "home", summary: "Home", primary: true, accessRole: "owner", timeZone: "Europe/London" },
    { id: "8F3A2C10-WORK", summary: "Work", accessRole: "owner", timeZone: "Europe/London" },
    { id: "C77-FAMILY", summary: "Family", accessRole: "reader" },
  ]);
});

test("switched-off calendars are never read, anywhere, and the first left on becomes primary", async () => {
  calendarServer();
  // Stored as the ones switched off: Home.
  const a = await openIcloud({ ...connector("icloud-calendar"), scope: "home" } as Connector, SECRETS, { now: () => NOW, timeZone: "Europe/London" });
  const cals = await call(a, "list_calendars");
  assert.deepEqual(cals.calendars.map((c: { id: string; primary?: boolean }) => `${c.id}${c.primary ? "*" : ""}`), ["8F3A2C10-WORK*", "C77-FAMILY"]);
  calls = [];
  await call(a, "list_events", { startTime: "2026-10-19T00:00:00", endTime: "2026-11-17T00:00:00" });
  await call(a, "search_events", { query: "anything" });
  const read = new Set(calls.filter((c) => c.method === "REPORT").map((c) => c.url));
  assert.deepEqual([...read].sort(), [`${CAL_HOME}8F3A2C10-WORK/`, `${CAL_HOME}C77-FAMILY/`], "Home is never read");
  assert.equal((await a.call("list_events", { calendarId: "home" })).isError, true);
  const none = await openIcloud({ ...connector("icloud-calendar"), scope: "home 8F3A2C10-WORK C77-FAMILY" } as Connector, SECRETS, { timeZone: "UTC" });
  const r = await none.call("list_events", {});
  assert.equal(r.isError, true);
  assert.match(r.text, /Switch one on in Sources/);
  // A calendar found later (not in the off list) is read without being switched on.
  const later = await openIcloud({ ...connector("icloud-calendar"), scope: "OLD-GONE" } as Connector, SECRETS, { timeZone: "UTC" });
  assert.equal((await call(later, "list_calendars")).calendars.length, 3);
});

test("calendar choices: every calendar, shared or not, how busy, and which are read", async () => {
  calendarServer();
  const all = await icloudCalendarChoices({ ...connector("icloud-calendar"), scope: "home" } as Connector, SECRETS, new Date("2026-10-19T00:00:00Z"));
  assert.deepEqual(
    all.map((c) => `${c.name}:${c.shared ? `shared by ${c.owner}` : "own"}:${c.upcoming}:${c.chosen ? "on" : "off"}`),
    ["Home:own:6:off", "Work:own:1:on", "Family:shared by Rowan Thorne:0:on"],
  );
});

const RANGE = { calendarId: "home", startTime: "2026-10-19T00:00:00", endTime: "2026-11-17T00:00:00" };

test("list_events: by default every calendar, each event saying which (iCloud has no single main one)", async () => {
  calendarServer();
  const a = await openCal();
  const r = await call(a, "list_events", { startTime: RANGE.startTime, endTime: RANGE.endTime });
  assert.equal(calls.filter((c) => c.method === "REPORT").length, 3, "Home, Work and Family");
  const qbr = r.events.find((e: { summary: string }) => e.summary === "QBR with Acme");
  assert.equal(qbr.calendar, "Work");
  assert.equal(r.events.find((e: { summary: string }) => e.summary === "Dentist").calendar, "Home");
  assert.deepEqual((await call(a, "list_events", { ...RANGE, calendarId: "primary" })).events.length, r.events.length, "primary means all, as the default");
});

test("list_events: a series iCloud left unexpanded becomes its occurrences, across the clock change", async () => {
  calendarServer();
  const a = await openCal();
  const r = await call(a, "list_events", RANGE);
  const report = calls.find((c) => c.method === "REPORT")!;
  assert.equal(report.depth, "1");
  assert.match(report.body, /<c:expand start="20261018T230000Z" end="20261117T000000Z"\/>/);
  assert.match(report.body, /<c:time-range start="20261018T230000Z" end="20261117T000000Z"\/>/);
  assert.equal(r.timeZone, "Europe/London");
  const brief = r.events.map((e: Record<string, unknown>) => `${e.start} ${e.summary}`);
  assert.deepEqual(brief, [
    "2026-10-19T09:30:00+01:00 Team stand-up",
    "2026-10-26T09:30:00+00:00 Team stand-up",
    "2026-11-02T10:00:00+00:00 Team stand-up (moved)",
    "2026-11-04T16:15:00+00:00 Dentist",
    "2026-11-06 Lisbon",
    "2026-11-16T09:30:00+00:00 Team stand-up",
  ]);
  const [first, , moved, dentist, trip] = r.events;
  assert.equal(first.end, "2026-10-19T09:45:00+01:00");
  assert.equal(first.organizer, "Priya Shah <priya@acme.example>");
  assert.equal(first.myResponse, "accepted");
  assert.deepEqual(first.attendees, ["Priya Shah <priya@acme.example> (organiser): accepted", "Jordan <jordan@ic.example> (you): accepted", "Sam Lee <sam@acme.example> (optional): maybe"]);
  assert.equal(first.meetLink, "https://acme.zoom.us/j/123456789");
  assert.equal(first.description, undefined, "descriptions only in get_event");
  assert.equal(moved.myResponse, "no reply yet");
  assert.equal(dentist.status, "tentative");
  assert.equal(dentist.end, "2026-11-04T17:00:00+00:00");
  assert.equal(dentist.location, "12 High Street, Bath");
  assert.deepEqual([trip.start, trip.end, trip.allDay], ["2026-11-06", "2026-11-08", true]);
  assert.equal(new Set(r.events.map((e: { id: string }) => e.id)).size, r.events.length, "each occurrence has its own id");
  assert.ok(!brief.some((b: string) => b.includes("Lunch")), "cancelled events are left out");
});

test("list_events: occurrences iCloud expanded itself read the same", async () => {
  calendarServer({ expanded: true });
  const a = await openCal();
  const r = await call(a, "list_events", RANGE);
  assert.deepEqual(
    r.events.map((e: Record<string, unknown>) => `${e.start} ${e.summary}`),
    ["2026-10-19T09:30:00+01:00 Team stand-up", "2026-10-26T09:30:00+00:00 Team stand-up", "2026-11-02T10:00:00+00:00 Team stand-up (moved)"],
  );
});

test("list_events: pages without repeating or dropping an event", async () => {
  calendarServer();
  const a = await openCal();
  const all = (await call(a, "list_events", RANGE)).events.map((e: { id: string }) => e.id);
  const seen: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const r = await call(a, "list_events", { ...RANGE, pageSize: 4, pageToken: token });
    seen.push(...r.events.map((e: { id: string }) => e.id));
    token = r.nextPageToken;
    pages++;
  } while (token);
  assert.equal(pages, 2);
  assert.deepEqual(seen, all);
  assert.equal((await a.call("list_events", { pageToken: "nope" })).isError, true);
});

test("list_events: defaults to the next 7 days in the owner's zone, and checks its arguments", async () => {
  calendarServer();
  const a = await openCal();
  const r = await call(a, "list_events");
  assert.deepEqual(r.events.map((e: { summary: string }) => e.summary), ["Dentist", "Lisbon"]);
  assert.match(calls.find((c) => c.method === "REPORT")!.body, /start="20261104T120000Z" end="20261111T120000Z"/);
  assert.equal((await a.call("list_events", { startTime: "2026-11-10", endTime: "2026-11-01" })).isError, true);
  assert.equal((await a.call("list_events", { calendarId: "nope" })).isError, true);
  assert.equal((await a.call("list_events", { startTime: "2025-01-01", endTime: "2026-12-01" })).isError, true);
});

test("get_event: an occurrence by its id, in full, read back with one GET", async () => {
  calendarServer();
  const a = await openCal();
  const listed = (await call(a, "list_events", RANGE)).events;
  const second = listed[1];
  calls = [];
  const e = await call(a, "get_event", { eventId: second.id });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${CAL_HOME}home/STANDUP-1.ics`]);
  assert.equal(e.start, "2026-10-26T09:30:00+00:00");
  assert.equal(e.description, "Join: https://acme.zoom.us/j/123456789\nAgenda in the doc.");
  assert.deepEqual(e.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130T235959Z", "EXDATE:20261109T093000"]);
  assert.ok(e.recurringEventId && e.recurringEventId !== e.id);
  assert.equal(e.updated, "2026-10-12T08:00:00.000Z");
  const moved = await call(a, "get_event", { eventId: listed[2].id });
  assert.equal(moved.summary, "Team stand-up (moved)");
  assert.equal(moved.start, "2026-11-02T10:00:00+00:00");
  const series = await call(a, "get_event", { eventId: e.recurringEventId });
  assert.equal(series.start, "2026-10-19T09:30:00+01:00");
  const bad = await a.call("get_event", { eventId: Buffer.from("../../../etc/passwd").toString("base64url") });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^Not found/);
});

test("search_events: every calendar, a year either way, closest to today first", async () => {
  calendarServer();
  const a = await openCal();
  const r = await call(a, "search_events", { query: "priya numbers" });
  assert.deepEqual(r.events.map((e: Record<string, unknown>) => `${e.summary} · ${e.calendar}`), ["QBR with Acme · Work"]);
  const standups = await call(a, "search_events", { query: "stand-up" });
  assert.equal(standups.events[0].start, "2026-11-02T10:00:00+00:00");
  assert.equal(calls.filter((c) => c.method === "REPORT").length, 6);
  assert.match(calls.find((c) => c.method === "REPORT")!.body, /start="20251104T120000Z" end="20271104T120000Z"/);
});

test("precheck: list_events replies count as events", () => {
  assert.equal(eventCount(JSON.stringify({ events: [{}, {}], timeZone: "UTC" })), 2);
  assert.equal(eventCount(JSON.stringify({ timeZone: "UTC" })), 0);
  assert.equal(eventCount("not json"), null);
  const since = new Date("2026-11-07T06:00:00Z");
  const reply = JSON.stringify({ events: [{ start: "2026-11-06", allDay: true }, { start: "2026-11-07T05:00:00+00:00" }, { start: "2026-11-07T09:00:00+00:00" }, { start: "2026-11-07", allDay: true }] });
  assert.equal(eventCount(reply, since, "Europe/London"), 2, "only what started since the last run: a trip already on isn't new");
});

test("Meetings tells the agent to fill in attendees from a contacts source", async () => {
  const { RECIPE_PROMPTS } = await import("./recipes");
  assert.match(RECIPE_PROMPTS["calendar-meetings"], /search_contacts/);
  assert.match(RECIPE_PROMPTS["calendar-meetings"], /phone, birthday and company/);
});

test("an all-day series has the same occurrence ids whoever expands it, and get_event finds them (seen on a real account)", () => {
  const series = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nRRULE:FREQ=MONTHLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYSETPOS=-1\r\nDTEND;VALUE=DATE:20130701\r\nDTSTART;VALUE=DATE:20130630\r\nSUMMARY:Month end\r\nEND:VEVENT\r\nEND:VCALENDAR";
  // iCloud's own expansion writes the RECURRENCE-ID as midnight UTC.
  const expanded = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nRECURRENCE-ID:20260930T000000Z\r\nDTSTART;VALUE=DATE:20260930\r\nDTEND;VALUE=DATE:20261001\r\nSUMMARY:Month end\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const from = Date.parse("2026-09-01T00:00:00Z");
  const to = Date.parse("2026-11-01T00:00:00Z");
  const ours = occurrences(series, from, to, "Europe/London").map((o) => o.recurrenceId);
  assert.deepEqual(ours, ["20260930", "20261031"]);
  assert.deepEqual(occurrences(expanded, from, to, "Europe/London").map((o) => o.recurrenceId), ["20260930"]);
  for (const rid of ["20260930", "20260930T000000Z"]) {
    const o = oneOccurrence(series, "Europe/London", rid);
    assert.equal(o?.start.date, "2026-09-30", rid);
    assert.equal(o?.start.allDay, true);
  }
});

test("quiet days: upcoming events match what was saved only when nothing moved, changed, appeared or went", () => {
  const saved = [
    { external_id: "a", title: "Stand-up", date: "2026-11-09", starts_at: "2026-11-09T09:30:00.000Z" },
    { external_id: "b", title: "Lisbon", date: "2026-11-12", starts_at: null },
  ];
  const listed = [
    { id: "a", summary: "Stand-up", start: "2026-11-09T09:30:00+00:00" },
    { id: "b", summary: "Lisbon", start: "2026-11-12", allDay: true },
    { id: "c", summary: "Party", start: "2026-11-10T19:00:00+00:00", myResponse: "declined" },
    { id: "d", summary: "Office", start: "2026-11-10", allDay: true, eventType: "workingLocation" },
  ];
  assert.equal(sameUpcoming(listed, saved), true, "declined and location markers aren't saved, so don't count");
  assert.equal(sameUpcoming([{ ...listed[0], start: "2026-11-09T10:00:00+00:00" }, listed[1]], saved), false, "moved");
  assert.equal(sameUpcoming([{ ...listed[0], summary: "Stand-up (moved)" }, listed[1]], saved), false, "renamed");
  assert.equal(sameUpcoming([...listed, { id: "e", summary: "New", start: "2026-11-11T12:00:00+00:00" }], saved), false, "new");
  assert.equal(sameUpcoming([listed[0]], saved), false, "gone");
});

// ---------- Recurrence rules ----------

const at = (date: string, time = "09:00:00", zone = "Europe/London"): IcalTime => ({ allDay: false, date, time, zone });
const dates = (start: IcalTime, rule: string, to = "2027-12-31") => expandRule(start, rule, Date.parse(`${to}T00:00:00Z`)).map((t) => t.date);

test("RRULE: the shapes Calendar writes", () => {
  assert.deepEqual(dates(at("2026-11-02"), "FREQ=DAILY;COUNT=3"), ["2026-11-02", "2026-11-03", "2026-11-04"]);
  assert.deepEqual(dates(at("2026-11-02"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=4"), ["2026-11-02", "2026-11-05", "2026-11-16", "2026-11-19"]);
  assert.deepEqual(dates(at("2026-01-31"), "FREQ=MONTHLY;COUNT=3"), ["2026-01-31", "2026-03-31", "2026-05-31"]);
  assert.deepEqual(dates(at("2026-11-26"), "FREQ=MONTHLY;BYDAY=-1TH;COUNT=3"), ["2026-11-26", "2026-12-31", "2027-01-28"]);
  assert.deepEqual(dates(at("2026-11-02"), "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2"), ["2026-11-30", "2026-12-31"]);
  assert.deepEqual(dates({ allDay: true, date: "2024-02-29", time: "00:00:00", zone: "UTC" }, "FREQ=YEARLY", "2033-01-01"), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(dates(at("2026-11-02"), "FREQ=DAILY;UNTIL=20261104"), ["2026-11-02", "2026-11-03", "2026-11-04"]);
  assert.deepEqual(dates(at("2026-11-02"), "FREQ=WEEKLY;BYDAY=SA,SU", "2026-11-10"), ["2026-11-07", "2026-11-08"]);
});

test("occurrences: a floating time is in the owner's zone; an endless series stops at the range", () => {
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260101T080000\r\nDTEND:20260101T083000\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Run\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const list = occurrences(ics, Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-07-03T00:00:00Z"), "Europe/London");
  assert.deepEqual(
    list.map((o) => new Date(o.startMs).toISOString()),
    ["2026-07-01T07:00:00.000Z", "2026-07-02T07:00:00.000Z"],
  );
});

// ---------- Contacts ----------

test("list_contacts: A to Z, paged, groups left out, photos never kept", async () => {
  contactsServer();
  const a = await openContacts();
  const p1 = await call(a, "list_contacts", { pageSize: 2 });
  assert.equal(p1.total, 3);
  assert.deepEqual(p1.contacts.map((c: { name: string }) => c.name), ["Dr Zoë Adams", "Priya Shah"]);
  const p2 = await call(a, "list_contacts", { pageSize: 2, pageToken: p1.nextPageToken });
  assert.deepEqual(p2.contacts.map((c: { name: string }) => c.name), ["Sam Lee"]);
  assert.equal(p2.nextPageToken, undefined);
  const priya = p1.contacts[1];
  assert.deepEqual(priya, {
    id: "A1B2-PRIYA",
    name: "Priya Shah",
    organisation: "Acme Ltd",
    title: "Head of Finance",
    emails: ["priya@acme.example (work)", "priya.shah@mail.example (home)"],
    phones: ["+44 7700 900123 (mobile)", "020 7946 0018 (work)"],
    birthday: "--04-12",
    addresses: ["1 Market St, Floor 4, London, EC1A 1BB, United Kingdom (work)"],
  });
  assert.ok(!JSON.stringify(p1).includes("9j/4AAQ"), "no photo data");
  // One PROPFIND for the cards, then multiget REPORTs: read once per open.
  assert.equal(calls.filter((c) => c.method === "REPORT").length, 1);
  assert.match(calls.find((c) => c.method === "REPORT")!.body, /addressbook-multiget/);
});

test("search_contacts: names, organisations, nicknames and phone digits however written", async () => {
  contactsServer();
  const a = await openContacts();
  const names = async (query: string) => (await call(a, "search_contacts", { query })).contacts?.map((c: { name: string }) => c.name) ?? [];
  assert.deepEqual(await names("acme"), ["Priya Shah", "Sam Lee"]);
  assert.deepEqual(await names("sam"), ["Sam Lee"]);
  assert.deepEqual(await names("07700-900-456"), ["Sam Lee"]);
  assert.deepEqual(await names("zo"), ["Dr Zoë Adams"]);
  assert.deepEqual(await names("book club"), []);
  const sam = (await call(a, "search_contacts", { query: "sam" })).contacts[0];
  assert.deepEqual([sam.phones, sam.birthday], [["07700 900456 (studio)"], "1990-02-28"]);
});

test("get_contact: in full by id, with notes, related people and links", async () => {
  contactsServer();
  const a = await openContacts();
  const priya = await call(a, "get_contact", { contactId: "A1B2-PRIYA" });
  assert.equal(priya.note, "Met at the Lisbon offsite.");
  assert.deepEqual(priya.related, ["Arjun (spouse)"]);
  assert.equal(priya.department, "Finance");
  assert.equal(priya.updated, "2026-10-30T09:12:44.000Z");
  assert.deepEqual((await call(a, "get_contact", { contactId: "C3D4-SAM" })).urls, ["https://samlee.example"]);
  const missing = await a.call("get_contact", { contactId: "NOPE" });
  assert.equal(missing.isError, true);
  assert.equal((await a.call("get_contact", { contactId: "../x" })).isError, true);
});

// ---------- Contacts into People ----------

test("matchContact: same email first, else the only contact with exactly that name", () => {
  const list = [
    { id: "a", name: "Priya Shah", emails: ["priya@acme.example (work)"] },
    { id: "b", name: "Sam Lee" },
    { id: "c", name: "Sam Lee" },
    { id: "d", name: "Zoë Adams" },
  ];
  assert.equal(matchContact(list, { name: "P. Shah", email: "PRIYA@acme.example" })?.id, "a");
  assert.equal(matchContact(list, { name: "Zoe Adams" })?.id, "d");
  assert.equal(matchContact(list, { name: "Sam Lee" }), null, "two Sam Lees: no guess");
  assert.equal(matchContact(list, { name: "Priya" }), null, "a first name alone never matches");
  assert.deepEqual(contactFill({ phone: "07000 000000", birthday: null, organisation: null }, { phones: ["+44 7700 900123 (mobile)"], birthday: "--04-12", organisation: "Acme Ltd" }), {
    phone: undefined,
    birthday: "--04-12",
    organisation: "Acme Ltd",
  });
});

test("end to end: a Meetings run links Priya, and People gets her phone, birthday and company from iCloud Contacts", async () => {
  contactsServer();
  const account = await openContacts();
  const open = { connector: connector("icloud-contacts"), direct: account, close: async () => undefined } as unknown as OpenConnector;
  const people = new Map<string, Record<string, unknown>>([["p1", { id: "p1", name: "Priya Shah", email: "priya@acme.example", phone: "", birthday: null, organisation: null }]]);
  const saved: Array<Record<string, unknown>> = [];
  const dir = contactsDirectory([open], new Map([[open, new Set(["list_contacts", "search_contacts"])]]), {
    getPerson: (async (id: string) => people.get(id) ?? null) as never,
    upsertPerson: (async (input: Record<string, unknown>) => (saved.push(input), input)) as never,
    organisation: async (name) => `org:${name}`,
  })!;
  assert.deepEqual(await dir.fill("p1", "Priya Shah", "priya@acme.example"), ["phone", "birthday", "organisation"]);
  assert.deepEqual(saved, [{ id: "p1", phone: "+44 7700 900123", birthday: "--04-12", organisation_id: "org:Acme Ltd" }]);
  assert.deepEqual(await dir.fill("p1", "Priya Shah"), [], "once a run");
  people.set("p2", { id: "p2", name: "Someone Else", email: "", phone: "", birthday: null, organisation: null });
  assert.deepEqual(await dir.fill("p2", "Someone Else"), [], "no match, nothing saved");
  assert.equal(saved.length, 1);
  assert.equal(contactsDirectory([open], new Map([[open, new Set(["search_contacts"])]])), undefined, "list_contacts turned off: no lookups");
});
