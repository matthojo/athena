// Real path: adding events, from the app's routes down to Google's and Microsoft's APIs, against
// Postgres with every migration applied. Only fetch is stubbed (Google, Graph). Covers the four
// entry points (Book it from a slot, Ask's create_event, Check in's "Add to calendar", a to-do's
// "Block time"), the confirm step's calendar choice, Undo (guests get a cancellation), a second
// Undo refused, and the switch off refused with nothing sent.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/create-events.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

test("add events from each entry point, open them, and take one back", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { q, upsertPerson } = await import("./db");
  const { createConnector, setConnectorStatus } = await import("./connectors");
  const { MOVE_MARKER, presetFor } = await import("./connector-presets");
  const { runSchedulingTool } = await import("./assistant-scheduling");
  const { schedulingPort } = await import("../netlify/lib/connectors/calendar-scheduling");
  const { retryWaits } = await import("../netlify/lib/connectors/google-api");
  const { graphRetryWaits } = await import("../netlify/lib/connectors/microsoft-graph");
  retryWaits.ms = [1, 1];
  graphRetryWaits.ms = [1, 1];

  await q(`DELETE FROM connectors WHERE provider IN ('google-calendar', 'outlook-calendar', 'icloud-calendar')`);
  await q(`DELETE FROM settings WHERE key IN ('days_working_hours', 'timezone', 'days_focus_time')`);
  await q(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"'::jsonb)`);
  // Names are sealed at rest, so a plain `name IN (...)` never matches: find them as the app does, then delete by id.
  const { findPeople } = await import("./memory");
  for (const name of ["Priya Shah", "Priya Patel", "Marcus Webb"]) for (const f of await findPeople(name)) if (f.person.name === name) await q(`DELETE FROM people WHERE id = $1`, [f.person.id]);
  await upsertPerson({ name: "Priya Shah", email: "priya@example.com" } as never);
  await upsertPerson({ name: "Marcus Webb", email: "marcus@example.com" } as never);

  const secrets = { ownClient: { client_id: "c", client_secret: "s" }, tokens: { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } };
  const g = presetFor("google-calendar");
  const google = await createConnector({ name: "Google Calendar", provider: "google-calendar", account_label: "work", url: g.url, auth_type: "oauth", scope: `${g.scope} ${MOVE_MARKER}`, secrets } as never);
  await setConnectorStatus(google.id, "connected");
  const m = presetFor("outlook-calendar");
  const outlook = await createConnector({ name: "Outlook Calendar", provider: "outlook-calendar", account_label: "home", url: m.url, auth_type: "oauth", scope: `${m.scope} ${MOVE_MARKER}`, secrets } as never);
  await setConnectorStatus(outlook.id, "connected");

  type Call = { method: string; url: URL; body: unknown };
  const calls: Call[] = [];
  const events = new Map<string, Record<string, unknown>>();
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined };
    const ok = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const p = c.url.pathname;
    if (c.url.hostname === "www.googleapis.com") {
      calls.push(c);
      if (p.endsWith("/calendars/primary") && c.method === "GET") return ok({ id: "me@example.com", timeZone: "Europe/London" });
      if (p.endsWith("/users/me/calendarList")) return ok({ items: [{ id: "me@example.com", summary: "me@example.com", primary: true, accessRole: "owner" }, { id: "holidays", summary: "UK holidays", accessRole: "reader" }] });
      if (p.endsWith("/events") && c.method === "POST") {
        const id = `ev_${++n}`;
        events.set(id, c.body as Record<string, unknown>);
        return ok({ id, htmlLink: `https://www.google.com/calendar/event?eid=${id}` });
      }
      if (/\/events\/ev_\d+$/.test(p) && c.method === "DELETE") {
        const id = p.split("/").pop()!;
        if (!events.delete(id)) return ok({ error: { code: 410, message: "Deleted" } }, 410);
        return ok({}, 204);
      }
      if (p.endsWith("/events")) return ok({ items: [] });
      if (p.endsWith("/freeBusy")) return ok({ calendars: {} });
      return ok({});
    }
    if (c.url.hostname === "graph.microsoft.com") {
      calls.push(c);
      if (p === "/v1.0/me") return ok({ mail: "me@outlook.example" });
      if (p === "/v1.0/me/calendar") return ok({ id: "cal" });
      if (p === "/v1.0/me/calendars") return ok({ value: [{ id: "AAMkMain=", name: "Calendar", isDefaultCalendar: true, canEdit: true }] });
      if (p === "/v1.0/me/events" && c.method === "POST") return ok({ id: "AAMkNew", webLink: "https://outlook.office365.com/owa/?itemid=AAMkNew" }, 201);
      if (p.endsWith("/calendarView") || p.endsWith("/events")) return ok({ value: [] });
      if (p.endsWith("/getSchedule")) return ok({ value: [] });
      return ok({});
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const gl = globalThis as unknown as { Netlify?: unknown };
    gl.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
    const api = (await import("../netlify/functions/api")).default;
    const call = async (path: string, method: string, body?: unknown) => {
      const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), {} as never);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const writes = () => calls.filter((c) => c.method !== "GET" && !c.url.pathname.endsWith("/freeBusy") && !c.url.pathname.endsWith("/getSchedule"));

    // ---- which calendars: each account's main one, writable only ----
    const cals = await call("/scheduling/calendars", "GET");
    assert.equal(cals.status, 200, JSON.stringify(cals.body));
    const list = cals.body.calendars as Array<{ account_id: string; calendar_id: string; primary: boolean }>;
    assert.deepEqual(list.map((c) => [c.account_id === google.id ? "google" : "outlook", c.calendar_id, c.primary]).sort(), [["google", "primary", true], ["outlook", "primary", true]], "the read-only holiday calendar isn't offered");

    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const at = (d: number, hhmm: string) => `${day(d)}T${hhmm}:00Z`;

    // ---- 1. Book it: a slot, the people on the slot card, invited ----
    const prep = await call("/scheduling/prepare", "POST", { title: "A 30 min call with Priya and Marcus", start: at(2, "11:00"), end: at(2, "11:30"), who: [{ name: "Priya Shah", email: "priya@example.com" }, { name: "Marcus Webb" }] });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    const proposal = prep.body as { attendees: Array<{ email: string }>; calendar: { account_id: string; calendar_id: string }; missing: string[] };
    assert.deepEqual(proposal.attendees.map((a) => a.email), ["priya@example.com", "marcus@example.com"], "Marcus's address came from Athena");
    assert.deepEqual(proposal.missing, []);
    assert.equal(writes().length, 0, "preparing sends nothing");
    const booked = await call("/scheduling/create", "POST", { account_id: google.id, calendar_id: "primary", title: "A 30 min call with Priya and Marcus", start: at(2, "11:00"), end: at(2, "11:30"), attendees: proposal.attendees });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.equal(booked.body.link, "https://www.google.com/calendar/event?eid=ev_1");
    assert.equal(booked.body.guests, 2);
    const insert = writes()[0];
    assert.equal(insert.url.search, "?sendUpdates=all");
    assert.deepEqual(Object.keys(insert.body as object).sort(), ["attendees", "end", "start", "summary"]);

    // ---- 2. Ask: "lunch with Priya Thursday at 1" proposes; two Priyas means ask first ----
    const shown: unknown[] = [];
    const ctx = { scheduling: schedulingPort, tz: "Europe/London", now: new Date(), show: (c: unknown) => shown.push(c) };
    const asked = JSON.parse(await runSchedulingTool("create_event", { title: "Lunch with Priya", start: `${day(3)}T13:00`, who: [{ name: "Priya" }] }, ctx as never));
    assert.match(String(asked.shown), /Ready for the owner/);
    const ask = (shown[0] as { kind: string; create: { attendees: Array<{ email: string }>; end: string; start: string } }).create;
    assert.deepEqual(ask.attendees.map((a) => a.email), ["priya@example.com"]);
    assert.equal(Date.parse(ask.end) - Date.parse(ask.start), 60 * 60_000, "lunch is an hour");
    await upsertPerson({ name: "Priya Patel", email: "ppatel@example.com" } as never);
    const two = JSON.parse(await runSchedulingTool("create_event", { title: "Lunch with Priya", start: `${day(3)}T13:00`, who: [{ name: "Priya" }] }, ctx as never));
    assert.match(String(two.ask_owner), /Priya Shah <priya@example.com> or Priya Patel <ppatel@example.com>|Priya Patel <ppatel@example.com> or Priya Shah <priya@example.com>/);
    assert.equal(shown.length, 1, "nothing shown until the owner says which");
    const nobody = JSON.parse(await runSchedulingTool("create_event", { title: "Coffee with Jo", start: `${day(3)}T09:00`, who: [{ name: "Jo Nobody" }] }, ctx as never));
    assert.match(String(nobody.ask_owner), /no email for Jo Nobody/);
    assert.equal(writes().length, 1, "Ask never adds anything itself");

    // ---- 3. Check in: a booking, no invitees even if some are sent, on Outlook (the owner changed the calendar) ----
    const refused = await call("/scheduling/create", "POST", { kind: "booking", account_id: outlook.id, calendar_id: "primary", title: "Dishoom, table for 4", start: at(4, "19:30"), end: at(4, "21:30"), attendees: [{ email: "x@example.com" }] });
    assert.equal(refused.status, 400);
    const dinner = await call("/scheduling/create", "POST", { kind: "booking", account_id: outlook.id, calendar_id: "primary", title: "Dishoom, table for 4", start: at(4, "19:30"), end: at(4, "21:30"), location: "Dishoom King's Cross" });
    assert.equal(dinner.status, 200, JSON.stringify(dinner.body));
    const post = writes().find((w) => w.url.hostname === "graph.microsoft.com")!;
    assert.equal(post.url.pathname, "/v1.0/me/events");
    assert.deepEqual(Object.keys(post.body as object).sort(), ["end", "location", "start", "subject"], "no attendees on a booking");

    // ---- 4. To-do: block time finds a free slot and proposes it with no guests ----
    const block = await call("/scheduling/block", "POST", { title: "Write the Q4 plan", minutes: 90 });
    assert.equal(block.status, 200, JSON.stringify(block.body));
    const b = block.body as { kind: string; start: string; end: string; attendees: unknown[] };
    assert.equal(b.kind, "focus");
    assert.deepEqual(b.attendees, []);
    assert.equal(Date.parse(b.end) - Date.parse(b.start), 90 * 60_000);
    // "Block time as Focus time": off by default, then on, so Google gets Focus time.
    assert.deepEqual((await call("/scheduling/focus", "GET")).body, { on: false });
    assert.deepEqual((await call("/scheduling/focus", "PUT", { on: true })).body, { on: true });
    assert.equal((await call("/scheduling/focus", "PUT", { on: "yes" })).status, 400);
    const focus = await call("/scheduling/create", "POST", { kind: "focus", account_id: google.id, calendar_id: "primary", title: "Write the Q4 plan", start: b.start, end: b.end });
    assert.equal(focus.status, 200, JSON.stringify(focus.body));
    const focusInsert = writes().filter((w) => w.method === "POST" && w.url.hostname === "www.googleapis.com").pop()!;
    assert.deepEqual(Object.keys(focusInsert.body as object).sort(), ["end", "eventType", "focusTimeProperties", "start", "summary"]);
    assert.equal((focusInsert.body as { eventType: string }).eventType, "focusTime");
    assert.equal((await call("/scheduling/create", "POST", { kind: "focus", account_id: google.id, calendar_id: "primary", title: "x", start: b.start, end: b.end, attendees: [{ email: "p@example.com" }] })).status, 400);

    // ---- Undo, through Ask's undo route: the event Athena added is deleted, with a cancellation ----
    const undo = booked.body.undo as { op: string; id: string };
    assert.equal(undo.op, "create_event");
    assert.equal((await call("/assistant/undo", "POST", { undo })).status, 200);
    const del = writes().filter((w) => w.method === "DELETE");
    assert.deepEqual(del.map((d) => [d.url.pathname, d.url.search]), [["/calendar/v3/calendars/primary/events/ev_1", "?sendUpdates=all"]]);
    assert.ok(!events.has("ev_1"));
    // Again: refused, nothing sent.
    const again = await call("/scheduling/undo", "POST", { undo });
    assert.equal(again.status, 400);
    assert.match(String(again.body.error), /already removed/);
    // Undo for an event Athena didn't add: there's no row, so nothing is sent.
    assert.equal((await call("/scheduling/undo", "POST", { undo: { op: "create_event", id: "00000000-0000-4000-8000-000000000999" } })).status, 404);
    assert.equal(writes().filter((w) => w.method === "DELETE").length, 1);

    // ---- the switch off: adding and undoing are refused, nothing sent ----
    const before = writes().length;
    await q(`UPDATE connectors SET scope = $2 WHERE id = $1`, [google.id, g.scope]);
    const off = await call("/scheduling/create", "POST", { account_id: google.id, calendar_id: "primary", title: "x", start: at(5, "10:00"), end: at(5, "10:30") });
    assert.equal(off.status, 400);
    assert.match(String(off.body.error), /Let Athena add and update events/);
    const offUndo = await call("/scheduling/undo", "POST", { undo: focus.body.undo });
    assert.equal(offUndo.status, 400);
    assert.equal(writes().length, before);
    const [{ count }] = await q<{ count: string }>(`SELECT count(*) FROM calendar_creates WHERE undone_at IS NULL`);
    assert.equal(Number(count), 2, "the dinner and the focus block are still Athena's to take back");
  } finally {
    globalThis.fetch = realFetch;
  }
});
