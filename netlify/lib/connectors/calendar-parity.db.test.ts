// Calendar parity end to end against Postgres: the real /api routes, the runner's sync, the app's answer route and
// the real calendar port. Only Google's and iCloud's network replies are stubbed; everything on Athena's side is real.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/calendar-parity.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/icloud-dav";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const DAY = 86_400_000;
const at = (days: number, hour: number) => new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + hour * 3_600_000);
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// ---------- Google, as far as Athena can tell ----------
const G_LIST = [
  { id: "me@example.com", summary: "me@example.com", primary: true, accessRole: "owner", backgroundColor: "#4986e7" },
  { id: "fam@group.calendar.google.com", summary: "Family", accessRole: "owner", backgroundColor: "#16a765" },
];
const G_EVENTS: Record<string, Array<Record<string, unknown>>> = {
  "me@example.com": [{ id: "g_review", summary: "Design review", start: { dateTime: at(-0.1, 0).toISOString() }, end: { dateTime: at(0, 1).toISOString() } }],
  "fam@group.calendar.google.com": [
    { id: "g_party", summary: "Leo's party", start: { dateTime: at(-0.1, 1).toISOString() }, end: { dateTime: at(0, 2).toISOString() }, attendees: [{ email: "me@example.com", self: true, responseStatus: "needsAction" }, { email: "rowan@example.com", organizer: true }] },
  ],
};
G_EVENTS.primary = G_EVENTS["me@example.com"];

// ---------- iCloud ----------
const APPLE_ID = "jordan@icloud.com";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const CAL_HOME = "https://p42-caldav.icloud.com/123456789/calendars/";
const INVITE_URL = `${CAL_HOME}8F3A2C10-WORK/DINNER-1.ics`;
const INVITE_ID = Buffer.from("8F3A2C10-WORK/DINNER-1.ics").toString("base64url");
const START = at(3, 19);
const INVITE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Apple Inc.//iPhone OS 18.1//EN",
  "BEGIN:VEVENT",
  "UID:DINNER-1",
  "DTSTAMP:20261101T080000Z",
  `DTSTART:${stamp(START)}`,
  `DTEND:${stamp(new Date(START.getTime() + 2 * 3_600_000))}`,
  "SUMMARY:Dinner at Priya's",
  "ORGANIZER;CN=Priya Shah:mailto:priya@acme.example",
  "ATTENDEE;CN=Priya Shah;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:priya@acme.example",
  "ATTENDEE;CN=Jordan;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jordan@icloud.com",
  "ATTENDEE;CN=Sam Lee;PARTSTAT=TENTATIVE:mailto:sam@acme.example",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const ms = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${body}</multistatus>`;

type Seen = { method: string; url: string; body: string; ifMatch?: string };

function stub(state: { seen: Seen[]; ics: string; etag: number }) {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    const h = (init.headers ?? {}) as Record<string, string>;
    state.seen.push({ method, url: u.toString(), body: String(init.body ?? ""), ifMatch: h["If-Match"] });
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    const xml = (b: string) => new Response(b, { status: 207, headers: { "Content-Type": "application/xml" } });
    if (u.hostname === "www.googleapis.com") {
      if (u.pathname === "/calendar/v3/calendars/primary") return json({ id: "me@example.com", timeZone: "Europe/London" });
      if (u.pathname === "/calendar/v3/users/me/calendarList") return json({ items: G_LIST });
      const list = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname);
      if (list) {
        const from = Date.parse(u.searchParams.get("timeMin") ?? "") || -Infinity;
        const to = Date.parse(u.searchParams.get("timeMax") ?? "") || Infinity;
        return json({ items: (G_EVENTS[decodeURIComponent(list[1])] ?? []).filter((e) => Date.parse((e.start as { dateTime: string }).dateTime) >= from && Date.parse((e.start as { dateTime: string }).dateTime) < to) });
      }
      const one = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(u.pathname);
      if (one && method === "GET") return json((G_EVENTS[decodeURIComponent(one[1])] ?? []).find((e) => e.id === one[2]) ?? {}, 200);
      if (one && method === "PATCH") return json({ id: one[2] });
    }
    if (u.hostname.endsWith("icloud.com")) {
      if (h.Authorization !== `Basic ${Buffer.from(`${APPLE_ID}:${PASSWORD}`).toString("base64")}`) return new Response("", { status: 401 });
      const s = u.toString();
      if (s === "https://caldav.icloud.com/") return xml(F.CALDAV_PRINCIPAL);
      if (s === "https://caldav.icloud.com/123456789/principal/") return xml(F.CALDAV_HOME);
      if (s === CAL_HOME) return xml(F.CALENDARS);
      if (method === "REPORT" && s === `${CAL_HOME}8F3A2C10-WORK/`)
        return xml(ms(`<response><href>/123456789/calendars/8F3A2C10-WORK/DINNER-1.ics</href><propstat><prop><getetag>"e${state.etag}"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${state.ics}]]></calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`));
      if (method === "REPORT" && s.startsWith(CAL_HOME)) return xml(F.EMPTY_REPORT);
      if (s === INVITE_URL && method === "GET") return new Response(state.ics, { status: 200, headers: { "Content-Type": "text/calendar", ETag: `"e${state.etag}"` } });
      if (s === INVITE_URL && method === "PUT") {
        if (h["If-Match"] !== `"e${state.etag}"`) return new Response("", { status: 412 });
        state.ics = String(init.body);
        state.etag++;
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`No fixture for ${method} ${u}`);
  }) as typeof fetch;
}

test("calendar parity: pick calendars on Google, read across them, and answer an iCloud invite", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const realFetch = globalThis.fetch;
  const { handleConnectorRoutes } = await import("./routes");
  const C = await import("../../../lib/connectors");
  const { qRaw, getEvent } = await import("../../../lib/db");
  const { openConnector, listAllowedTools, callTool } = await import("./mcp-client");
  const { glance } = await import("./precheck");
  const { AthenaWriter } = await import("./runner");
  const { onlyPartstatChanged } = await import("./icloud-rsvp");
  const { RSVP_SCOPE, presetFor } = await import("../../../lib/connector-presets");

  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM events WHERE source = 'calendar-meetings-parity'`);
  await qRaw(`DELETE FROM connectors`);

  const state = { seen: [] as Seen[], ics: INVITE, etag: 1 };
  stub(state);
  const g = globalThis as unknown as { Netlify?: unknown };
  g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      try {
        const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
        return { status: res.status, text: await res.text() };
      } catch (error) {
        return { status: (error as { status?: number }).status ?? 400, text: (error as Error).message };
      }
    };

    // ---- Google Calendar: signed in (tokens sealed as a sign-in leaves them) ----
    const preset = presetFor("google-calendar");
    const made = await api("POST", "/connectors", { provider: "google-calendar", name: "Google Calendar", account_label: "personal", auth_type: "oauth", scope: preset.scope, client_id: "c.apps.googleusercontent.com", client_secret: "s" });
    assert.equal(made.status, 201, made.text);
    const google = JSON.parse(made.text);
    await C.updateConnectorSecrets(google.id, (s) => {
      s.tokens = { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() };
    });
    const checked = await api("POST", `/connectors/${google.id}/check`);
    assert.equal(JSON.parse(checked.text).status, "connected", checked.text);
    assert.equal(google.calendars, null, "nothing chosen yet");

    // ---- the picker: main only until chosen ----
    const choices = await api("GET", `/connectors/${google.id}/calendars`);
    assert.equal(choices.status, 200, choices.text);
    assert.deepEqual(JSON.parse(choices.text).calendars.map((c: { id: string; chosen: boolean }) => `${c.id}:${c.chosen}`), ["me@example.com:true", "fam@group.calendar.google.com:false"]);
    const open1 = await openConnector(google.id);
    const tools = new Set((await listAllowedTools(open1)).map((t) => t.name));
    const since = at(-1, 0);
    assert.equal((await glance(open1, tools, since, "Europe/London")).count, 1, "precheck: the primary's one event");
    await open1.close();

    // ---- switch Family on: stored apart from the OAuth scopes, nothing else changes ----
    assert.equal((await api("PATCH", `/connectors/${google.id}`, { calendars: [] })).status, 400, "at least one");
    assert.equal((await api("PATCH", `/connectors/${google.id}`, { calendars: ["a b"] })).status, 400, "ids only");
    const chose = await api("PATCH", `/connectors/${google.id}`, { calendars: ["me@example.com", "fam@group.calendar.google.com"] });
    assert.equal(chose.status, 200, chose.text);
    const after = (await C.getConnector(google.id))!;
    assert.deepEqual(after.calendars, ["me@example.com", "fam@group.calendar.google.com"]);
    assert.equal(after.scope, preset.scope, "the OAuth scopes are untouched");
    assert.equal(after.status, "connected", "choosing calendars keeps the sign-in");
    const [row] = await qRaw<{ credentials: string }>(`SELECT credentials FROM connectors WHERE id = $1`, [google.id]);
    assert.ok(!row.credentials.includes("fam@group"), "the choice isn't in the sealed secrets");

    // ---- Meetings, precheck and Ask read both, each event labelled ----
    const open2 = await openConnector(google.id);
    assert.equal((await glance(open2, tools, since, "Europe/London")).count, 2, "precheck sees Family too");
    const listed = JSON.parse((await callTool(open2, "list_events", { startTime: since.toISOString(), endTime: at(2, 0).toISOString() })).text);
    assert.deepEqual(listed.events.map((e: { id: string; calendar: string }) => `${e.id}:${e.calendar}`), ["g_review:me@example.com", "g_party:Family"]);

    // ---- the runner keeps the event's own calendar, so an answer goes to the right one ----
    const collection = { id: "c1", name: "Meetings", recipe: "calendar-meetings", connector_ids: [google.id], label: "parity", source: "calendar-meetings-parity", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 14, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
    const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as never;
    const writer = new AthenaWriter(collection, "00000000-0000-4000-8000-000000000001", stats, new Date(), "Europe/London");
    writer.noteCalendarResult(open2.connector, {}, JSON.stringify(listed));
    await open2.close();
    const party = JSON.parse(await writer.run("athena_save_event", { external_id: "g_party", title: "Leo's party", start: G_EVENTS["fam@group.calendar.google.com"][0].start && (G_EVENTS["fam@group.calendar.google.com"][0].start as { dateTime: string }).dateTime, attendees: [] }));
    const partyEv = (await getEvent(party.id))!;
    assert.deepEqual([partyEv.calendar_id, partyEv.calendar_event_id], ["fam@group.calendar.google.com", "g_party"], "Family's event remembers Family");

    // ---- iCloud Calendar: every calendar on, as built; the invites switch next to the picker ----
    const ic = await api("POST", "/connectors", { provider: "icloud-calendar", name: "iCloud Calendar", account_label: "personal", auth_type: "token", token: PASSWORD, username: APPLE_ID });
    assert.equal(ic.status, 201, ic.text);
    const icloud = JSON.parse(ic.text);
    assert.equal(JSON.parse((await api("POST", `/connectors/${icloud.id}/check`)).text).status, "connected");
    const icChoices = JSON.parse((await api("GET", `/connectors/${icloud.id}/calendars`)).text).calendars as Array<{ chosen: boolean }>;
    assert.ok(icChoices.length === 3 && icChoices.every((c) => c.chosen), "iCloud: all on");
    assert.equal((await api("PATCH", `/connectors/${icloud.id}`, { calendars: ["home"] })).status, 200);
    assert.equal((await C.getConnector(icloud.id))!.calendars, null, "iCloud keeps its own storage");

    // ---- the meeting sync brings the invite in, with iCloud's own answer ----
    const icOpen = await openConnector(icloud.id);
    const icListed = await callTool(icOpen, "list_events", { startTime: at(0, 0).toISOString(), endTime: at(7, 0).toISOString() });
    await icOpen.close();
    const iwriter = new AthenaWriter(collection, "00000000-0000-4000-8000-000000000001", stats, new Date(), "Europe/London");
    iwriter.noteCalendarResult({ id: icloud.id, provider: "icloud-calendar" }, {}, icListed.text);
    const saved = JSON.parse(await iwriter.run("athena_save_event", { external_id: INVITE_ID, title: "Dinner at Priya's", start: START.toISOString(), attendees: [] }));
    let dinner = (await getEvent(saved.id))!;
    assert.deepEqual([dinner.calendar_event_id, dinner.rsvp, dinner.rsvp_account?.provider, dinner.rsvp_account?.can_send], [INVITE_ID, "none", "icloud-calendar", false]);

    // ---- the app's answer route, switch off: only in Athena, no PUT ----
    const route = (await import("../../functions/api")).default;
    const answer = async (a: string) => {
      const res = await route(new Request(`https://athena.test/api/events/${saved.id}/rsvp`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ answer: a }) }), {} as never);
      assert.equal(res.status, 200);
      return (await res.json()) as { outcome: string; message: string; event: { rsvp: string; rsvp_calendar: string } };
    };
    state.seen.length = 0;
    const off = await answer("maybe");
    assert.equal(off.outcome, "saved");
    assert.match(off.message, /Only in Athena\. Turn on “Let Athena answer invites” to send it to iCloud Calendar/);
    assert.ok(!state.seen.some((s) => s.method === "PUT"), "no switch, no PUT");

    // ---- switch on (with Family switched off: both kept); the earlier answer goes out straight away ----
    const on = await api("PATCH", `/connectors/${icloud.id}`, { scope: `C77-FAMILY ${RSVP_SCOPE["icloud-calendar"]}` });
    assert.equal(on.status, 200, on.text);
    const puts = () => state.seen.filter((s) => s.method === "PUT");
    assert.equal(puts().length, 1, "the pending Maybe went out on turning it on");
    assert.equal(puts()[0].ifMatch, '"e1"');
    assert.equal(onlyPartstatChanged(INVITE, puts()[0].body, [APPLE_ID]), true);
    assert.match(state.ics, /ATTENDEE;CN=Jordan;PARTSTAT=TENTATIVE;RSVP=TRUE:mailto:jordan@icloud.com/);
    assert.equal((await getEvent(saved.id))!.rsvp_calendar, "maybe");
    assert.deepEqual(
      JSON.parse((await api("GET", `/connectors/${icloud.id}/calendars`)).text).calendars.filter((c: { chosen: boolean }) => !c.chosen).map((c: { id: string }) => c.id),
      ["C77-FAMILY"],
      "the switch's marker doesn't disturb the picker",
    );

    // ---- Declined: one conditional PUT; someone else changed it first, so a 412, a fresh read and one retry ----
    state.etag = 7; // changed in iCloud since Athena last read it
    const before = state.ics;
    state.seen.length = 0;
    const realStub = globalThis.fetch;
    let first = true;
    globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
      if (String(init.method) === "PUT" && first) {
        first = false;
        state.seen.push({ method: "PUT", url: String(input), body: String(init.body), ifMatch: (init.headers as Record<string, string>)["If-Match"] });
        state.etag++; // and once more while Athena was answering
        return new Response("", { status: 412 });
      }
      return realStub(input, init);
    }) as typeof fetch;
    const declined = await answer("declined");
    globalThis.fetch = realStub;
    assert.equal(declined.outcome, "sent", declined.message);
    assert.deepEqual(puts().map((p) => p.ifMatch), ['"e7"', '"e8"'], "If-Match each time, the retry on the fresh ETag");
    assert.equal(state.seen.filter((s) => s.method === "GET" && s.url === INVITE_URL).length, 2, "re-read once");
    assert.equal(onlyPartstatChanged(before, state.ics, [APPLE_ID]), true, "only your line changed");
    assert.match(state.ics, /PARTSTAT=DECLINED;RSVP=TRUE:mailto:jordan@icloud.com/);
    assert.match(state.ics, /CN=Sam Lee;PARTSTAT=TENTATIVE/, "Sam's answer is untouched");
    dinner = (await getEvent(saved.id))!;
    assert.deepEqual([dinner.rsvp, dinner.rsvp_calendar, dinner.rsvp_error], ["declined", "declined", ""]);

    // ---- switched off again: refused, nothing sent ----
    await api("PATCH", `/connectors/${icloud.id}`, { scope: "C77-FAMILY" });
    state.seen.length = 0;
    const again = await answer("going");
    assert.equal(again.outcome, "saved");
    assert.equal(puts().length, 0);
    assert.ok(state.seen.every((s) => ["GET", "PROPFIND", "REPORT", "PATCH"].includes(s.method) || !s.url.includes("icloud")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
