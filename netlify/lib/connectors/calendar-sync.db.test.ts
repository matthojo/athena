// The Calendar collection end to end against Postgres (calendar-sync.ts): a real run through executeRun, with
// Google Calendar's network replies stubbed and everything on Athena's side real. It takes over an event a
// Meetings collection synced, saves new ones, skips holds, archives cancelled and deleted ones after fetching them,
// links a meeting's note to its event, leaves unchanged events alone, and turns Meetings' own sync off.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/calendar-sync.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

const DAY = 86_400_000;
const at = (days: number, hour: number) => new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + hour * 3_600_000);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

type GEvent = Record<string, unknown> & { id: string; start: { dateTime?: string; date?: string } };
const ME = { email: "me@example.com", self: true, responseStatus: "accepted" };
const listed: GEvent[] = [
  {
    id: "g_review",
    summary: "Design review",
    location: "Room 4",
    start: { dateTime: at(1, 10).toISOString() },
    end: { dateTime: at(1, 11).toISOString() },
    attendees: [ME, { email: "priya@example.com", displayName: "Priya Shah", organizer: true, responseStatus: "accepted" }, { email: "sam@example.com", displayName: "Sam Lee", responseStatus: "declined" }],
  },
  // Meetings saved it an hour earlier: it has moved since.
  { id: "g_standup", summary: "Stand-up", start: { dateTime: at(2, 9).toISOString() }, end: { dateTime: at(2, 9.25).toISOString() } },
  { id: "g_hold", summary: "Hold", start: { dateTime: at(3, 9).toISOString() }, end: { dateTime: at(3, 10).toISOString() } },
  { id: "g_conf", summary: "Conference", start: { date: dayOf(at(5, 0)) }, end: { date: dayOf(at(6, 0)) } },
];
/** Not listed any more: one cancelled, one deleted. */
const cancelled: GEvent = { id: "g_cancelled", status: "cancelled", summary: "Supplier call", start: { dateTime: at(4, 14).toISOString() }, end: { dateTime: at(4, 15).toISOString() } };
const fetched: string[] = [];

function stub() {
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const method = String(init.method ?? "GET");
    const json = (b: unknown, status = 200) => Response.json(b, { status });
    if (u.hostname === "www.googleapis.com") {
      if (u.pathname === "/calendar/v3/calendars/primary") return json({ id: "me@example.com", timeZone: "Europe/London" });
      if (u.pathname === "/calendar/v3/users/me/calendarList") return json({ items: [{ id: "me@example.com", summary: "me@example.com", primary: true, accessRole: "owner" }] });
      const list = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(u.pathname);
      if (list && method === "GET") {
        const from = Date.parse(u.searchParams.get("timeMin") ?? "") || -Infinity;
        const to = Date.parse(u.searchParams.get("timeMax") ?? "") || Infinity;
        const startOf = (e: GEvent) => Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00Z`);
        return json({ items: listed.filter((e) => startOf(e) >= from && startOf(e) < to) });
      }
      const one = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(u.pathname);
      if (one && method === "GET") {
        fetched.push(one[2]);
        const e = [...listed, cancelled].find((x) => x.id === one[2]);
        return e ? json(e) : json({ error: { code: 404, message: "Not Found" } }, 404);
      }
    }
    throw new Error(`No fixture for ${method} ${u}`);
  }) as typeof fetch;
}

test("Calendar: a run with no model keeps the next days in step", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const realFetch = globalThis.fetch;
  const C = await import("../../../lib/connectors");
  const { qRaw, getEvent } = await import("../../../lib/db");
  const { executeRun, AthenaWriter } = await import("./runner");
  const { withoutCoveredSync } = await import("./calendar-sync");
  const { presetFor } = await import("../../../lib/connector-presets");
  const { handleConnectorRoutes } = await import("./routes");

  await qRaw(`DELETE FROM collection_runs`);
  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM events WHERE source LIKE 'calendar-%'`);
  await qRaw(`DELETE FROM connectors`);
  stub();
  const g = globalThis as unknown as { Netlify?: unknown };
  g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
  try {
    // ---- a signed-in Google Calendar, through the real routes (tokens sealed as a sign-in leaves them) ----
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, st = 200) => Response.json(d, { status: st }), u.origin))!;
      return { status: res.status, text: await res.text() };
    };
    const preset = presetFor("google-calendar");
    const made = await api("POST", "/connectors", { provider: "google-calendar", name: "Google Calendar", account_label: "work", auth_type: "oauth", scope: preset.scope, client_id: "c.apps.googleusercontent.com", client_secret: "s" });
    assert.equal(made.status, 201, made.text);
    const google = JSON.parse(made.text) as { id: string };
    await C.updateConnectorSecrets(google.id, (s) => {
      s.tokens = { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() };
    });
    const checked = await api("POST", `/connectors/${google.id}/check`);
    assert.equal(JSON.parse(checked.text).status, "connected", checked.text);

    const base = { connector_ids: [google.id], label: "work", instructions: "", schedule: "hourly" as const, run_at: null, every_hours: 1, lookback_hours: 24, lookahead_days: 14, event_push: false, enabled: true };
    const meetings = await C.upsertCollection(undefined, { ...base, name: "Meetings · work", recipe: "calendar-meetings", source: "calendar-meetings-work", schedule: "daily", run_at: "07:00", every_hours: null });
    const calendar = await C.upsertCollection(undefined, { ...base, name: "Calendar · work", recipe: "calendar-sync", source: "calendar-sync-work" });
    await assert.rejects(C.upsertCollection(calendar.id, { lookahead_days: 0 }), /1–60 days/, "Calendar is never off");

    // ---- before Calendar: what Meetings synced, and its note for the review ----
    const stats = () => ({ turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 }) as never;
    const mw = new AthenaWriter(meetings, "00000000-0000-4000-8000-000000000001", stats(), new Date(), "Europe/London");
    const old = JSON.parse(await mw.run("athena_save_event", { external_id: "g_standup", title: "Stand-up", start: at(2, 8).toISOString(), attendees: [] }));
    const note = JSON.parse(await mw.run("athena_save_note", { external_id: "g_review", title: "Design review · prep", body: "What to bring to the review." }));
    // ---- and two events an earlier Calendar run saved, which have gone since ----
    const cw = new AthenaWriter(calendar, "00000000-0000-4000-8000-000000000002", stats(), new Date(), "Europe/London");
    cw.noteCalendarResult({ id: google.id, provider: "google-calendar" }, {}, JSON.stringify({ events: [{ id: "g_cancelled", end: at(4, 15).toISOString() }, { id: "g_gone", end: at(6, 11).toISOString() }] }));
    const supplier = JSON.parse(await cw.run("athena_save_event", { external_id: "g_cancelled", title: "Supplier call", start: at(4, 14).toISOString(), attendees: [] }));
    const gone = JSON.parse(await cw.run("athena_save_event", { external_id: "g_gone", title: "Old sync", start: at(6, 10).toISOString(), attendees: [] }));

    // ---- the first run ----
    const run1 = await C.queueRun(calendar.id, "manual");
    await executeRun(run1.id);
    const [r1] = await C.listRuns(calendar.id, 1);
    assert.equal(r1.status, "succeeded", r1.error);
    assert.equal(r1.summary, "2 new, 1 changed, 2 cancelled");
    assert.equal(r1.stats.tool_calls ?? 0, 0, "no model");
    assert.equal(r1.stats.calendar_events, 3, "the hold isn't one");

    const live = await qRaw<{ id: string; calendar_event_id: string | null; source: string }>(`SELECT id, calendar_event_id, source FROM events WHERE archived_at IS NULL AND source LIKE 'calendar-%' ORDER BY starts_at NULLS LAST`);
    assert.deepEqual(live.map((e) => e.calendar_event_id).sort(), ["g_conf", "g_review", "g_standup"].sort(), "no hold, no copies");
    assert.ok(live.every((e) => e.source === "calendar-sync-work"), "Calendar owns them now");

    // Taken over, not copied: the same record, at its new time.
    const standup = (await getEvent(old.id))!;
    assert.equal(Date.parse(standup.starts_at!), at(2, 9).getTime(), "moved");
    assert.equal((await C.getCollected("calendar-sync-work", "event", "g_standup"))?.record_id, old.id);

    const review = (await C.getCollected("calendar-sync-work", "event", "g_review"))!;
    const reviewEv = (await getEvent(review.record_id))!;
    assert.equal(reviewEv.notes, "Room 4 · with Priya Shah");
    assert.equal(reviewEv.rsvp_calendar, "going");
    assert.equal(reviewEv.calendar_connector_id, google.id);
    const guests = await qRaw<{ name: string }>(
      `SELECT p.name FROM edges e JOIN people p ON p.id = e.target_id WHERE e.source_id = $1 AND e.relation = 'attendee'`,
      [review.record_id],
    );
    assert.equal(guests.length, 1, "Priya, not Sam who declined");
    const [linked] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM edges WHERE source_id = $1 AND target_id = $2 AND relation = 'notes_for'`, [note.id, review.record_id]);
    assert.equal(linked.n, 1, "Meetings' note links to Calendar's event");

    const conf = (await getEvent((await C.getCollected("calendar-sync-work", "event", "g_conf"))!.record_id))!;
    assert.deepEqual([conf.date, conf.starts_at], [dayOf(at(5, 0)), null], "all day");

    assert.equal((await getEvent(supplier.id))?.id, undefined, "cancelled: archived");
    assert.equal((await getEvent(gone.id))?.id, undefined, "deleted: archived");
    assert.equal((await getEvent(gone.id, { includeArchived: true }))?.id, gone.id, "archived, not deleted");
    assert.ok(fetched.includes("g_cancelled") && fetched.includes("g_gone"), "each fetched before it was taken off");

    // ---- a second run: nothing changed, so nothing is saved ----
    const updatedAt = new Date((await getEvent(old.id))!.updated_at).getTime();
    fetched.length = 0;
    const run2 = await C.queueRun(calendar.id, "manual");
    await executeRun(run2.id);
    const [r2] = await C.listRuns(calendar.id, 1);
    assert.equal(r2.status, "succeeded", r2.error);
    assert.equal(r2.summary, "Up to date");
    assert.equal(r2.stats.events_unchanged, 3);
    assert.equal(new Date((await getEvent(old.id))!.updated_at).getTime(), updatedAt, "left alone");
    assert.deepEqual(fetched, [], "nothing missing, so nothing fetched");

    // ---- the event comes back: restored ----
    listed.push(cancelled.status === "cancelled" ? { ...cancelled, status: "confirmed" } : cancelled);
    const run3 = await C.queueRun(calendar.id, "manual");
    await executeRun(run3.id);
    const [r3] = await C.listRuns(calendar.id, 1);
    assert.equal(r3.summary, "1 changed");
    assert.equal((await getEvent(supplier.id))?.id, supplier.id, "back from cancelled");

    // ---- Meetings leaves the events to Calendar while it's on ----
    assert.equal((await withoutCoveredSync(meetings)).lookahead_days, 0);
    await C.upsertCollection(calendar.id, { enabled: false });
    assert.equal((await withoutCoveredSync(meetings)).lookahead_days, 14, "Calendar off: Meetings syncs again");
  } finally {
    globalThis.fetch = realFetch;
  }
});
