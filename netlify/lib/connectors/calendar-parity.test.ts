// Run: npx tsx --test netlify/lib/connectors/calendar-parity.test.ts
// The same calendar settings on Google Calendar, Outlook and iCloud: which calendars Athena reads (main only on
// Google and Outlook until the owner chooses, every one on iCloud), events read and labelled across the chosen
// calendars, the precheck glance with a picker, and iCloud answering invites by changing only your PARTSTAT.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canRsvp, presetFor, RSVP_SCOPE, RSVP_TOOL } from "../../../lib/connector-presets";
import { skippedCalendars } from "../../../lib/presets/apple";
import { pickChosen, readCalendarIds } from "./calendar-choice";
import { openGoogle } from "./google-direct";
import { retryWaits } from "./google-api";
import { openMicrosoft } from "./microsoft-direct";
import { graphRetryWaits } from "./microsoft-graph";
import { davRetryWaits } from "./icloud-dav";
import { icloudCalendarChoices, icloudTools, openIcloud, pickCalendars } from "./icloud-direct";
import { onlyPartstatChanged, rewritePartstat, SERIES_QUESTION } from "./icloud-rsvp";
import { glance } from "./precheck";
import { callTool, type OpenConnector } from "./mcp-client";
import * as F from "./fixtures/icloud-dav";

type Call = { method: string; url: URL; body: string; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; etag?: string };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let reply: (c: Call) => Reply | undefined = () => undefined;

beforeEach(() => {
  calls = [];
  retryWaits.ms = [1, 1];
  graphRetryWaits.ms = [1, 1];
  davRetryWaits.ms = [1, 1];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? "GET", url: new URL(String(input)), body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`No fixture for ${c.method} ${c.url}`);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    const type = typeof r.body === "string" ? (r.body.startsWith("BEGIN:VCALENDAR") ? "text/calendar" : "application/xml") : "application/json";
    return new Response(r.status === 204 ? null : text, { status: r.status ?? 200, headers: { "Content-Type": type, ...(r.etag ? { ETag: r.etag } : {}) } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const NOW = Date.now();
const iso = (days: number, hour = 9) => new Date(Math.floor(NOW / 86_400_000) * 86_400_000 + days * 86_400_000 + hour * 3_600_000).toISOString();

function oauthAccount(provider: "google-calendar" | "outlook-calendar", calendars?: string[] | null): Connector {
  const p = presetFor(provider);
  return {
    id: "00000000-0000-4000-8000-0000000000c2",
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
    calendars,
    has_token: true,
    has_own_client: true,
    has_client_secret: true,
    created_at: "",
    updated_at: "",
  };
}
const oauthSecrets = (): ConnectorSecrets => ({ ownClient: { client_id: "c", client_secret: "s" }, tokens: { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } });
const json = (text: string) => JSON.parse(text) as { events?: Array<Record<string, unknown>>; calendars?: Array<Record<string, unknown>> };

// ---------- the choice ----------

test("the choice: main only until chosen, chosen ones main first, the main one back when none is left", () => {
  const all = [
    { id: "fam", primary: false },
    { id: "me@example.com", primary: true },
    { id: "club", primary: false },
  ];
  assert.deepEqual(pickChosen(all, null).map((c) => c.id), ["me@example.com"]);
  assert.deepEqual(pickChosen(all, undefined).map((c) => c.id), ["me@example.com"]);
  assert.deepEqual(pickChosen(all, ["club", "me@example.com"]).map((c) => c.id), ["me@example.com", "club"]);
  assert.deepEqual(pickChosen(all, ["gone"]).map((c) => c.id), ["me@example.com"]);
  assert.deepEqual(readCalendarIds(["a", "a", " b "]), ["a", "b"]);
  assert.throws(() => readCalendarIds([]), /at least one/);
  assert.throws(() => readCalendarIds(["a b"]), /calendar ids/);
  assert.throws(() => readCalendarIds("a"), /calendar ids/);
});

// ---------- Google ----------

const G = "https://www.googleapis.com/calendar/v3";
const GOOGLE_LIST = [
  { id: "me@example.com", summary: "me@example.com", summaryOverride: "Jordan", primary: true, accessRole: "owner", backgroundColor: "#4986e7" },
  { id: "fam123@group.calendar.google.com", summary: "Family", accessRole: "owner", backgroundColor: "#16a765" },
  { id: "rowan@example.com", summary: "Rowan Thorne", accessRole: "reader", backgroundColor: "#f691b2" },
  { id: "en.uk#holiday@group.v.calendar.google.com", summary: "Holidays in the UK", accessRole: "reader", backgroundColor: "#92e1c0" },
];
const GOOGLE_EVENTS: Record<string, Array<Record<string, unknown>>> = {
  "me@example.com": [{ id: "g_review", summary: "Design review", start: { dateTime: iso(1, 14) }, end: { dateTime: iso(1, 15) }, attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }] }],
  primary: [{ id: "g_review", summary: "Design review", start: { dateTime: iso(1, 14) }, end: { dateTime: iso(1, 15) }, attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }] }],
  "fam123@group.calendar.google.com": [
    { id: "g_swim", summary: "Swimming", start: { dateTime: iso(1, 8) }, end: { dateTime: iso(1, 9) } },
    { id: "g_dinner", summary: "Dinner with Rowan", start: { dateTime: iso(2, 19) }, end: { dateTime: iso(2, 21) } },
  ],
  "rowan@example.com": [{ id: "g_flight", summary: "Rowan's flight", start: { dateTime: iso(3, 7) }, end: { dateTime: iso(3, 9) } }],
  "en.uk#holiday@group.v.calendar.google.com": [],
};

function googleServer() {
  reply = (c) => {
    if (c.url.pathname === "/calendar/v3/calendars/primary" && c.method === "GET") return { body: { id: "me@example.com", timeZone: "Europe/London" } };
    if (c.url.pathname === "/calendar/v3/users/me/calendarList") return { body: { items: GOOGLE_LIST } };
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(c.url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const q = c.url.searchParams.get("q")?.toLowerCase();
      const from = Date.parse(c.url.searchParams.get("timeMin") ?? "") || -Infinity;
      const to = Date.parse(c.url.searchParams.get("timeMax") ?? "") || Infinity;
      const at = (e: Record<string, unknown>) => Date.parse((e.start as { dateTime: string }).dateTime);
      const items = (GOOGLE_EVENTS[id] ?? []).filter((e) => (!q || String(e.summary).toLowerCase().includes(q)) && at(e) >= from && at(e) < to);
      return { body: { items, timeZone: "Europe/London" } };
    }
    const one = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(c.url.pathname);
    if (one) {
      const e = (GOOGLE_EVENTS[decodeURIComponent(one[1])] ?? []).find((x) => x.id === decodeURIComponent(one[2]));
      return e ? { body: e } : { status: 404, body: { error: { code: 404, message: "Not Found" } } };
    }
    return undefined;
  };
}
const googleReads = () => [...new Set(calls.filter((c) => /\/events$/.test(c.url.pathname)).map((c) => decodeURIComponent(c.url.pathname.split("/")[4])))];

test("Google: until the owner chooses, only the primary calendar is read, exactly as before", async () => {
  googleServer();
  const g = await openGoogle(oauthAccount("google-calendar", null), oauthSecrets());
  const listed = json((await g.call("list_events", {})).text);
  assert.deepEqual(googleReads(), ["primary"]);
  assert.deepEqual(listed.events!.map((e) => e.id), ["g_review"]);
  assert.equal(listed.events![0].calendar, undefined, "one calendar: no label");
  calls = [];
  json((await g.call("search_events", { query: "review" })).text);
  assert.deepEqual(googleReads(), ["primary"]);
  const cals = json((await g.call("list_calendars", {})).text).calendars!;
  assert.deepEqual(cals.map((c) => c.id), ["me@example.com"], "list_calendars shows only what Athena reads");
  const off = await g.call("list_events", { calendarId: "fam123@group.calendar.google.com" });
  assert.equal(off.isError, true);
  assert.match(off.text, /doesn't read/);
  assert.equal((await g.call("list_events", { calendarId: "me@example.com" })).isError, false, "the primary by its own id");
});

test("Google: choices default to the primary alone; shared, subscribed and colour come through; calendars found later are off", async () => {
  googleServer();
  const g = await openGoogle(oauthAccount("google-calendar", null), oauthSecrets());
  const choices = await g.calendars!();
  assert.deepEqual(choices.map((c) => [c.name, c.chosen]), [["Jordan", true], ["Family", false], ["Rowan Thorne", false], ["Holidays in the UK", false]]);
  assert.equal(choices[0].primary, true);
  assert.equal(choices[0].color, "#4986e7");
  assert.deepEqual([choices[2].shared, choices[2].owner], [true, "Rowan Thorne"]);
  assert.deepEqual([choices[3].shared, choices[3].subscribed], [false, true]);
  assert.deepEqual(choices.map((c) => c.upcoming), [1, 2, 1, 0]);
  // Chosen Family later: a new calendar on the account stays off.
  const later = await (await openGoogle(oauthAccount("google-calendar", ["me@example.com", "fam123@group.calendar.google.com"]), oauthSecrets())).calendars!();
  assert.deepEqual(later.filter((c) => c.chosen).map((c) => c.name), ["Jordan", "Family"]);
});

test("Google: with more switched on, list_events and search_events read each, merged in order and labelled", async () => {
  googleServer();
  const g = await openGoogle(oauthAccount("google-calendar", ["me@example.com", "fam123@group.calendar.google.com"]), oauthSecrets());
  const listed = json((await g.call("list_events", { startTime: iso(0, 0), endTime: iso(7, 0) })).text);
  assert.deepEqual(googleReads().sort(), ["fam123@group.calendar.google.com", "me@example.com"]);
  assert.deepEqual(listed.events!.map((e) => [e.id, e.calendar, e.calendarId]), [
    ["g_swim", "Family", "fam123@group.calendar.google.com"],
    ["g_review", "Jordan", "me@example.com"],
    ["g_dinner", "Family", "fam123@group.calendar.google.com"],
  ]);
  calls = [];
  const found = json((await g.call("search_events", { query: "dinner" })).text);
  assert.deepEqual(googleReads().sort(), ["fam123@group.calendar.google.com", "me@example.com"]);
  assert.deepEqual(found.events!.map((e) => [e.id, e.calendar]), [["g_dinner", "Family"]]);
  // get_event without a calendarId finds it on whichever chosen calendar has it.
  const one = JSON.parse((await g.call("get_event", { eventId: "g_dinner" })).text);
  assert.equal(one.calendar, "Family");
  // Rowan's calendar is off: not read, even by id.
  assert.equal((await g.call("get_event", { calendarId: "rowan@example.com", eventId: "g_flight" })).isError, true);
  assert.ok(!calls.some((c) => c.url.pathname.includes("rowan")), "a switched-off calendar is never read");
  // Paging across merged calendars hands back the rest.
  const first = json((await g.call("list_events", { startTime: iso(0, 0), endTime: iso(7, 0), pageSize: 2 })).text) as { events: unknown[]; nextPageToken?: string };
  assert.equal(first.events.length, 2);
  const rest = json((await g.call("list_events", { startTime: iso(0, 0), endTime: iso(7, 0), pageSize: 2, pageToken: first.nextPageToken })).text);
  assert.deepEqual(rest.events!.map((e) => e.id), ["g_dinner"]);
});

test("precheck: the glance counts events on every switched-on calendar, and none on the ones off", async () => {
  googleServer();
  GOOGLE_EVENTS["fam123@group.calendar.google.com"].push({ id: "g_park", summary: "Park", start: { dateTime: new Date(NOW - 3_600_000).toISOString() }, end: { dateTime: new Date(NOW - 1_800_000).toISOString() } });
  GOOGLE_EVENTS["rowan@example.com"].push({ id: "g_off", summary: "Off", start: { dateTime: new Date(NOW - 3_600_000).toISOString() }, end: { dateTime: new Date(NOW - 1_800_000).toISOString() } });
  try {
    const since = new Date(NOW - 6 * 3_600_000);
    const allowed = new Set(["list_events"]);
    const mainOnly = oauthAccount("google-calendar", null);
    const a: OpenConnector = { connector: mainOnly, direct: await openGoogle(mainOnly, oauthSecrets()), close: async () => undefined };
    assert.equal((await glance(a, allowed, since, "Europe/London")).count, 0, "main only: Family's event isn't seen");
    const picked = oauthAccount("google-calendar", ["me@example.com", "fam123@group.calendar.google.com"]);
    const b: OpenConnector = { connector: picked, direct: await openGoogle(picked, oauthSecrets()), close: async () => undefined };
    assert.equal((await glance(b, allowed, since, "Europe/London")).count, 1, "Family switched on: its event counts; Rowan's (off) doesn't");
  } finally {
    GOOGLE_EVENTS["fam123@group.calendar.google.com"].pop();
    GOOGLE_EVENTS["rowan@example.com"].pop();
  }
});

// ---------- Outlook ----------

const OUTLOOK_CALS = [
  { id: "AAMkMain", name: "Calendar", isDefaultCalendar: true, canEdit: true, owner: { name: "Jordan", address: "me@example.com" }, hexColor: "", color: "lightBlue" },
  { id: "AAMkClub", name: "Running club", isDefaultCalendar: false, canEdit: true, owner: { name: "Jordan", address: "me@example.com" }, hexColor: "#e3008c" },
  { id: "AAMkRowan", name: "Rowan's calendar", isDefaultCalendar: false, canEdit: false, owner: { name: "Rowan Thorne", address: "rowan@example.com" } },
];
const graphEvent = (id: string, subject: string, startIso: string) => ({ id, subject, start: { dateTime: startIso.replace("Z", ""), timeZone: "UTC" }, end: { dateTime: startIso.replace("Z", ""), timeZone: "UTC" }, isAllDay: false });
const OUTLOOK_EVENTS: Record<string, unknown[]> = {
  "me/calendar": [graphEvent("o_1on1", "1:1 with Priya", iso(1, 10))],
  "me/calendars/AAMkMain": [graphEvent("o_1on1", "1:1 with Priya", iso(1, 10))],
  "me/calendars/AAMkClub": [graphEvent("o_run", "Club run", iso(1, 7)), graphEvent("o_race", "Park run", iso(4, 9))],
  "me/calendars/AAMkRowan": [graphEvent("o_soph", "Rowan away", iso(2, 9))],
};
function outlookServer() {
  reply = (c) => {
    const p = c.url.pathname.replace("/v1.0/", "");
    if (p === "me") return { body: { mail: "me@example.com" } };
    if (p === "me/calendar") return { body: { id: "AAMkMain" } };
    if (p === "me/calendars") return { body: { value: OUTLOOK_CALS } };
    const m = /^(me\/calendars?(?:\/[^/]+)?)\/calendarView$/.exec(p);
    if (m) {
      const from = Date.parse(c.url.searchParams.get("startDateTime") ?? "");
      const to = Date.parse(c.url.searchParams.get("endDateTime") ?? "");
      const at = (e: unknown) => Date.parse(`${(e as { start: { dateTime: string } }).start.dateTime}Z`);
      return { body: { value: (OUTLOOK_EVENTS[decodeURIComponent(m[1])] ?? []).filter((e) => at(e) >= from && at(e) < to) } };
    }
    return undefined;
  };
}
const outlookReads = () => [...new Set(calls.filter((c) => c.url.pathname.endsWith("/calendarView")).map((c) => c.url.pathname.replace("/v1.0/", "").replace("/calendarView", "")))];

test("Outlook: until the owner chooses, only the main calendar is read", async () => {
  outlookServer();
  const o = await openMicrosoft(oauthAccount("outlook-calendar", null), oauthSecrets());
  const listed = json((await o.call("list_events", {})).text);
  assert.deepEqual(outlookReads(), ["me/calendar"]);
  assert.deepEqual(listed.events!.map((e) => e.id), ["o_1on1"]);
  calls = [];
  await o.call("search_events", { query: "run" });
  assert.deepEqual(outlookReads(), ["me/calendar"]);
  assert.deepEqual(json((await o.call("list_calendars", {})).text).calendars!.map((c) => c.id), ["AAMkMain"]);
  assert.equal((await o.call("list_events", { calendarId: "AAMkClub" })).isError, true);
  assert.equal((await o.call("list_events", { calendarId: "AAMkMain" })).isError, false, "the main calendar by its own id");
});

test("Outlook: choices default to the main calendar; who shared it, colours, and later ones off", async () => {
  outlookServer();
  const choices = await (await openMicrosoft(oauthAccount("outlook-calendar", null), oauthSecrets())).calendars!();
  assert.deepEqual(choices.map((c) => [c.name, c.chosen]), [["Calendar", true], ["Running club", false], ["Rowan's calendar", false]]);
  assert.deepEqual(choices.map((c) => c.color), ["#4f9be0", "#e3008c", undefined]);
  assert.deepEqual([choices[2].shared, choices[2].owner], [true, "Rowan Thorne"]);
  assert.deepEqual(choices.map((c) => c.upcoming), [1, 2, 1]);
});

test("Outlook: with more switched on, events from each, merged and labelled; search reads them too", async () => {
  outlookServer();
  const o = await openMicrosoft(oauthAccount("outlook-calendar", ["AAMkMain", "AAMkClub"]), oauthSecrets());
  const listed = json((await o.call("list_events", { startTime: iso(0, 0), endTime: iso(7, 0) })).text);
  assert.deepEqual(outlookReads().sort(), ["me/calendars/AAMkClub", "me/calendars/AAMkMain"]);
  assert.deepEqual(listed.events!.map((e) => [e.id, e.calendar, e.calendarId]), [
    ["o_run", "Running club", "AAMkClub"],
    ["o_1on1", "Calendar", "AAMkMain"],
    ["o_race", "Running club", "AAMkClub"],
  ]);
  calls = [];
  const found = json((await o.call("search_events", { query: "park" })).text);
  assert.deepEqual(found.events!.map((e) => [e.id, e.calendar]), [["o_race", "Running club"]]);
  assert.ok(!calls.some((c) => c.url.pathname.includes("AAMkRowan")), "Rowan's (off) is never read");
});

// ---------- iCloud: every calendar on, as built ----------

const SECRETS: ConnectorSecrets = { username: "jordan@icloud.com", token: "abcd-efgh-ijkl-mnop" };
const CAL_HOME = "https://p42-caldav.icloud.com/123456789/calendars/";
const icloudAccount = (scope = ""): Connector => ({ ...oauthAccount("google-calendar"), provider: "icloud-calendar", name: "iCloud Calendar", auth_type: "token", url: "", scope, calendars: undefined });
function icloudServer(extra: (c: Call) => Reply | undefined = () => undefined) {
  reply = (c) => {
    const u = c.url.toString();
    if (c.method === "PROPFIND" && u === "https://caldav.icloud.com/") return { status: 207, body: F.CALDAV_PRINCIPAL };
    if (c.method === "PROPFIND" && u === "https://caldav.icloud.com/123456789/principal/") return { status: 207, body: F.CALDAV_HOME };
    if (c.method === "PROPFIND" && u === CAL_HOME) return { status: 207, body: F.CALENDARS };
    if (c.method === "REPORT" && u.startsWith(CAL_HOME)) return { status: 207, body: F.EMPTY_REPORT };
    return extra(c);
  };
}

test("iCloud: every calendar starts on (as built), and the invites switch isn't mistaken for a calendar", async () => {
  icloudServer();
  const all = await icloudCalendarChoices(icloudAccount(), SECRETS);
  assert.ok(all.length > 1 && all.every((c) => c.chosen));
  const answering = await icloudCalendarChoices(icloudAccount(RSVP_SCOPE["icloud-calendar"]), SECRETS);
  assert.ok(answering.every((c) => c.chosen), "the switch's marker is no calendar id");
  assert.deepEqual(skippedCalendars(`C77-FAMILY ${RSVP_SCOPE["icloud-calendar"]}`), ["C77-FAMILY"]);
  const off = await icloudCalendarChoices(icloudAccount(`C77-FAMILY ${RSVP_SCOPE["icloud-calendar"]}`), SECRETS);
  assert.deepEqual(off.filter((c) => !c.chosen).map((c) => c.name), ["Family"]);
  assert.deepEqual(pickCalendars([{ id: "a", primary: true }, { id: "b", primary: false }] as never, []).length, 2);
});

// ---------- iCloud: answering invites ----------

/** An invite from Priya, as Apple's Calendar writes it: your own line folded, an email alarm with its own ATTENDEE, Sam on it too. */
const INVITE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//macOS 15.1//EN",
  "CALSCALE:GREGORIAN",
  "BEGIN:VEVENT",
  "UID:REVIEW-1",
  "DTSTAMP:20261101T080000Z",
  "DTSTART:20261113T140000Z",
  "DTEND:20261113T150000Z",
  "SUMMARY:Design review",
  "ORGANIZER;CN=Priya Shah:mailto:priya@acme.example",
  "ATTENDEE;CN=Priya Shah;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:p",
  " riya@acme.example",
  'ATTENDEE;CN="Jordan Reeve";CUTYPE=INDIVIDUAL;EMAIL=jordan@icloud.com;PARTSTAT=NEE',
  " DS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE;SCHEDULE-STATUS=2.0:mailto:jordan@icl",
  " oud.com",
  "ATTENDEE;CN=Sam Lee;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@acme.example",
  "BEGIN:VALARM",
  "ACTION:EMAIL",
  "TRIGGER:-PT15M",
  "SUMMARY:Reminder",
  "DESCRIPTION:Design review soon",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:jordan@icloud.com",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const EMAILS = ["jordan@icloud.com", "jordan@jr.example"];

test("iCloud PARTSTAT: only your own ATTENDEE line changes; every other byte stays", () => {
  for (const [answer, partstat] of [["going", "ACCEPTED"], ["maybe", "TENTATIVE"], ["declined", "DECLINED"]] as const) {
    const r = rewritePartstat(INVITE_ICS, { emails: EMAILS, partstat, ownerZone: "Europe/London" });
    assert.equal(r.changed, true, answer);
    const before = INVITE_ICS.split("\r\n");
    const after = r.text.split("\r\n");
    // Everything before your line and after it is the same, byte for byte.
    const at = before.findIndex((l) => l.startsWith('ATTENDEE;CN="Jordan Reeve"'));
    assert.deepEqual(after.slice(0, at), before.slice(0, at));
    const tailBefore = before.slice(at + 3);
    assert.deepEqual(after.slice(after.length - tailBefore.length), tailBefore, "Sam, the alarm's own ATTENDEE and the rest are untouched");
    // Your line: the same parameters in the same order, with the new PARTSTAT, still folded within 75 octets.
    const mine = after.slice(at, after.length - tailBefore.length);
    assert.ok(mine.every((l) => Buffer.byteLength(l) <= 75));
    assert.equal(mine.map((l, i) => (i ? l.slice(1) : l)).join(""), `ATTENDEE;CN="Jordan Reeve";CUTYPE=INDIVIDUAL;EMAIL=jordan@icloud.com;PARTSTAT=${partstat};ROLE=REQ-PARTICIPANT;RSVP=TRUE;SCHEDULE-STATUS=2.0:mailto:jordan@icloud.com`);
    assert.equal(onlyPartstatChanged(INVITE_ICS, r.text, EMAILS), true);
  }
  // Already what it says: nothing to write.
  const going = rewritePartstat(INVITE_ICS, { emails: EMAILS, partstat: "ACCEPTED", ownerZone: "UTC" }).text;
  assert.equal(rewritePartstat(going, { emails: EMAILS, partstat: "ACCEPTED", ownerZone: "UTC" }).changed, false);
  // The guard tells a real answer from anything else.
  assert.equal(onlyPartstatChanged(INVITE_ICS, INVITE_ICS.replace("SUMMARY:Design review", "SUMMARY:Renamed"), EMAILS), false);
  assert.equal(onlyPartstatChanged(INVITE_ICS, INVITE_ICS.replace("sam@acme.example\r\n", "sam@acme.example\r\n").replace("Sam Lee;PARTSTAT=NEEDS-ACTION", "Sam Lee;PARTSTAT=DECLINED"), EMAILS), false);
});

test("iCloud PARTSTAT: a changed occurrence answers on its own copy; a plain occurrence, your own event or a cancelled one is refused", () => {
  // The stand-up's 2 Nov occurrence has its own copy, with you on NEEDS-ACTION.
  const r = rewritePartstat(F.STANDUP_ICS, { emails: EMAILS, partstat: "DECLINED", recurrenceId: "20261102T093000Z", ownerZone: "Europe/London" });
  assert.equal(r.changed, true);
  assert.equal(onlyPartstatChanged(F.STANDUP_ICS, r.text, EMAILS), true);
  assert.match(r.text, /RECURRENCE-ID;TZID=Europe\/London:20261102T093000\r\n[\s\S]*ATTENDEE;CN=Jordan;PARTSTAT=DECLINED:mailto:jordan@icloud.com/);
  assert.match(r.text, /ATTENDEE;CN=Jordan;PARTSTAT=ACCEPTED:mailto:jordan@icloud.com/, "the series' own line is unchanged");
  assert.throws(() => rewritePartstat(F.STANDUP_ICS, { emails: EMAILS, partstat: "DECLINED", recurrenceId: "20261026T093000Z", ownerZone: "Europe/London" }), /repeats/);
  const own = INVITE_ICS.replace("ORGANIZER;CN=Priya Shah:mailto:priya@acme.example", "ORGANIZER;CN=Jordan:mailto:jordan@icloud.com");
  assert.throws(() => rewritePartstat(own, { emails: EMAILS, partstat: "ACCEPTED", ownerZone: "UTC" }), /your own event/);
  assert.throws(() => rewritePartstat(INVITE_ICS, { emails: ["someone@else.example"], partstat: "ACCEPTED", ownerZone: "UTC" }), /aren't a guest/);
  assert.throws(() => rewritePartstat(INVITE_ICS.replace("SUMMARY:Design review", "STATUS:CANCELLED\r\nSUMMARY:Design review"), { emails: EMAILS, partstat: "ACCEPTED", ownerZone: "UTC" }), /cancelled/);
});

const EVENT_URL = `${CAL_HOME}8F3A2C10-WORK/REVIEW-1.ics`;
const EVENT_ID = Buffer.from("8F3A2C10-WORK/REVIEW-1.ics").toString("base64url");
const writes = () => calls.filter((c) => !["GET", "PROPFIND", "REPORT"].includes(c.method));

test("iCloud PARTSTAT, a repeating invite: one date with no copy asks first; \"All of them\" answers the series on the master only", () => {
  // The owner is NEEDS-ACTION on the series, so "all of them" has something to change.
  const series = F.STANDUP_ICS.replace("ATTENDEE;CN=Jordan;PARTSTAT=ACCEPTED:mailto:jordan@icloud.com", "ATTENDEE;CN=Jordan;PARTSTAT=NEEDS-ACTION:mailto:jordan@icloud.com");
  const opts = { emails: EMAILS, partstat: "DECLINED" as const, recurrenceId: "20261026T093000Z", ownerZone: "Europe/London" };
  assert.throws(() => rewritePartstat(series, opts), (e: Error) => e.message === SERIES_QUESTION);
  const r = rewritePartstat(series, { ...opts, series: true });
  assert.equal(r.changed, true);
  assert.equal(onlyPartstatChanged(series, r.text, EMAILS), true, "only your own line, every other byte kept");
  const [master, copy] = r.text.split("END:VEVENT");
  assert.match(master, /RRULE:FREQ=WEEKLY/);
  assert.match(master, /ATTENDEE;CN=Jordan;PARTSTAT=DECLINED:mailto:jordan@icloud.com/, "the series says Declined");
  assert.match(copy, /ATTENDEE;CN=Jordan;PARTSTAT=NEEDS-ACTION:mailto:jordan@icloud.com/, "the 2 Nov copy keeps its own answer");
  assert.match(master, /ATTENDEE;CN=Sam Lee;PARTSTAT=TENTATIVE/, "other people untouched");
  // A date that has its own copy never asks: it answers that copy, series or not.
  const own = rewritePartstat(series, { ...opts, recurrenceId: "20261102T093000Z", series: true });
  assert.match(own.text.split("END:VEVENT")[1], /PARTSTAT=DECLINED:mailto:jordan@icloud.com/);
});

test("iCloud respond_to_event with series: the master answered by a conditional PUT; without it, the question and no write", async () => {
  const url = `${CAL_HOME}8F3A2C10-WORK/STANDUP-1.ics`;
  const id = `${Buffer.from("8F3A2C10-WORK/STANDUP-1.ics").toString("base64url")}.20261026T093000Z`;
  const body = F.STANDUP_ICS.replace("ATTENDEE;CN=Jordan;PARTSTAT=ACCEPTED:mailto:jordan@icloud.com", "ATTENDEE;CN=Jordan;PARTSTAT=NEEDS-ACTION:mailto:jordan@icloud.com");
  icloudServer((c) => {
    if (c.url.toString() !== url) return undefined;
    if (c.method === "GET") return { body, etag: '"etag-s"' };
    if (c.method === "PUT") {
      assert.equal(c.headers["If-Match"], '"etag-s"');
      return { status: 204 };
    }
    return undefined;
  });
  const account = await openIcloud(icloudAccount(RSVP_SCOPE["icloud-calendar"]), SECRETS, { timeZone: "Europe/London" });
  const asked = await account.call(RSVP_TOOL, { eventId: id, answer: "declined" });
  assert.equal(asked.isError, true);
  assert.match(asked.text, /^This invite repeats\./);
  assert.equal(writes().length, 0);
  const r = await account.call(RSVP_TOOL, { eventId: id, answer: "declined", series: true });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString()]), [["PUT", url]]);
  assert.equal(onlyPartstatChanged(body, writes()[0].body, EMAILS), true);
  assert.match(writes()[0].body.split("END:VEVENT")[0], /CN=Jordan;PARTSTAT=DECLINED/);
});


test("iCloud respond_to_event: one PUT with If-Match on the ETag it read, carrying only your answer", async () => {
  let stored = INVITE_ICS;
  icloudServer((c) => {
    if (c.url.toString() !== EVENT_URL) return undefined;
    if (c.method === "GET") return { body: stored, etag: '"etag-1"' };
    if (c.method === "PUT") {
      assert.equal(c.headers["If-Match"], '"etag-1"');
      assert.match(c.headers["Content-Type"], /^text\/calendar/);
      stored = c.body;
      return { status: 204 };
    }
    return undefined;
  });
  const account = await openIcloud(icloudAccount(RSVP_SCOPE["icloud-calendar"]), SECRETS, { timeZone: "Europe/London" });
  assert.ok(account.tools.some((t) => t.name === RSVP_TOOL));
  const r = await account.call(RSVP_TOOL, { eventId: EVENT_ID, answer: "declined" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text), { id: EVENT_ID, myResponse: "declined" });
  assert.deepEqual(writes().map((w) => [w.method, w.url.toString()]), [["PUT", EVENT_URL]]);
  assert.equal(onlyPartstatChanged(INVITE_ICS, writes()[0].body, EMAILS), true);
  assert.match(writes()[0].body.replace(/\r\n /g, ""), /PARTSTAT=DECLINED/);
});

test("iCloud respond_to_event: a 412 reads the event again and tries once more; a second 412 stops", async () => {
  let puts = 0;
  let version = 1;
  icloudServer((c) => {
    if (c.url.toString() !== EVENT_URL) return undefined;
    if (c.method === "GET") return { body: INVITE_ICS.replace("DTSTAMP:20261101T080000Z", `DTSTAMP:2026110${version}T080000Z`), etag: `"etag-${version}"` };
    if (c.method === "PUT") {
      puts++;
      if (c.headers["If-Match"] === '"etag-1"') {
        version = 2; // someone changed it meanwhile
        return { status: 412 };
      }
      assert.equal(c.headers["If-Match"], '"etag-2"');
      assert.match(c.body, /DTSTAMP:20261102T080000Z/, "the retry is built on the fresh copy");
      return { status: 204 };
    }
    return undefined;
  });
  const account = await openIcloud(icloudAccount(RSVP_SCOPE["icloud-calendar"]), SECRETS, { timeZone: "UTC" });
  const r = await account.call(RSVP_TOOL, { eventId: EVENT_ID, answer: "maybe" });
  assert.equal(r.isError, false, r.text);
  assert.equal(puts, 2);
  assert.equal(calls.filter((c) => c.method === "GET" && c.url.toString() === EVENT_URL).length, 2);

  // Changed again before the retry lands: Athena stops after one retry.
  calls = [];
  puts = 0;
  icloudServer((c) => {
    if (c.url.toString() !== EVENT_URL) return undefined;
    if (c.method === "GET") return { body: INVITE_ICS, etag: `"etag-${++version}"` };
    if (c.method === "PUT") {
      puts++;
      return { status: 412 };
    }
    return undefined;
  });
  const again = await (await openIcloud(icloudAccount(RSVP_SCOPE["icloud-calendar"]), SECRETS, { timeZone: "UTC" })).call(RSVP_TOOL, { eventId: EVENT_ID, answer: "maybe" });
  assert.equal(again.isError, true);
  assert.match(again.text, /changed in iCloud/);
  assert.equal(puts, 2);
});

test("iCloud without the switch: no reply tool, callTool refuses, and nothing but reads is sent", async () => {
  icloudServer((c) => (c.method === "GET" && c.url.toString() === EVENT_URL ? { body: INVITE_ICS, etag: '"e"' } : undefined));
  const c = icloudAccount("");
  assert.equal(canRsvp(c), false);
  assert.ok(!icloudTools(c).some((t) => t.name === RSVP_TOOL));
  const account = await openIcloud(c, SECRETS, { timeZone: "UTC" });
  const direct = await account.call(RSVP_TOOL, { eventId: EVENT_ID, answer: "going" });
  assert.equal(direct.isError, true);
  const open: OpenConnector = { connector: c, direct: account, close: async () => undefined };
  await assert.rejects(callTool(open, RSVP_TOOL, { eventId: EVENT_ID, answer: "going" }), /isn't on/);
  assert.equal(writes().length, 0);
  // With it on, the tool is offered as a write, behind the switch.
  assert.equal(canRsvp(icloudAccount(RSVP_SCOPE["icloud-calendar"])), true);
  assert.equal(icloudTools(icloudAccount(RSVP_SCOPE["icloud-calendar"])).find((t) => t.name === RSVP_TOOL)?.annotations.readOnlyHint, false);
});
