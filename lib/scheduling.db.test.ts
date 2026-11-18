// Real path: finding times and moving an event, from the app's routes down to Google's API, against
// Postgres with every migration applied. Only fetch is stubbed (Google), and it keeps the event's
// times, so Undo really moves it back. Working hours are saved first; a guest whose calendar Google
// won't show is named; the move PATCH carries only start and end.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/scheduling.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

test("find times with a guest, move an event there, and undo it", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { q, getEvent, upsertEvent } = await import("./db");
  const { createConnector, setConnectorStatus } = await import("./connectors");
  const { MOVE_MARKER, presetFor } = await import("./connector-presets");
  const { zonedParts } = await import("./dates");
  const { retryWaits } = await import("../netlify/lib/connectors/google-api");
  retryWaits.ms = [1, 1];

  await q(`DELETE FROM connectors WHERE provider = 'google-calendar'`);
  await q(`DELETE FROM settings WHERE key IN ('days_working_hours', 'timezone')`);
  await q(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"'::jsonb)`);
  const preset = presetFor("google-calendar");
  const secrets = { ownClient: { client_id: "c", client_secret: "s" }, tokens: { access_token: "t", refresh_token: "r", expires_in: 3600, obtained_at: Date.now() } };
  const account = await createConnector({ name: "Google Calendar", provider: "google-calendar", account_label: "work", url: preset.url, auth_type: "oauth", scope: `${preset.scope} ${MOVE_MARKER}`, secrets } as never);
  await setConnectorStatus(account.id, "connected");

  // The event to move: tomorrow at 10:00 London, half an hour, organised by the owner.
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  let evStart = new Date(`${day(1)}T10:00:00Z`);
  let evEnd = new Date(evStart.getTime() + 30 * 60_000);
  const ev = await upsertEvent({ title: "Design review", kind: "appointment", recurrence: "none", starts_at: evStart.toISOString(), tz: "Europe/London" } as never);
  await q(`UPDATE events SET calendar_connector_id = $2, calendar_id = 'primary', calendar_event_id = 'ev_1' WHERE id = $1`, [ev.id, account.id]);

  // Priya is busy for the next two days, all day; Sam's calendar isn't shown.
  const priyaBusy = { start: new Date(`${day(0)}T00:00:00Z`).toISOString(), end: new Date(`${day(3)}T00:00:00Z`).toISOString() };
  type Call = { method: string; url: URL; body: unknown };
  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: new URL(String(input)), body: init.body ? JSON.parse(String(init.body)) : undefined };
    if (c.url.hostname !== "www.googleapis.com") return realFetch(input, init);
    calls.push(c);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const p = c.url.pathname;
    const mine = { id: "ev_1", status: "confirmed", summary: "Design review", organizer: { self: true }, start: { dateTime: evStart.toISOString(), timeZone: "Europe/London" }, end: { dateTime: evEnd.toISOString(), timeZone: "Europe/London" }, attendees: [{ self: true }, { email: "priya@example.com" }] };
    if (p.endsWith("/calendars/primary")) return ok({ id: "me@example.com", timeZone: "Europe/London" });
    if (p.endsWith("/freeBusy")) return ok({ calendars: { "priya@example.com": { busy: [priyaBusy] }, "sam@other.org": { errors: [{ reason: "notFound" }] } } });
    if (p.endsWith("/events/ev_1") && c.method === "PATCH") {
      const b = c.body as { start: { dateTime: string }; end: { dateTime: string } };
      evStart = new Date(b.start.dateTime);
      evEnd = new Date(b.end.dateTime);
      return ok({ id: "ev_1" });
    }
    if (p.endsWith("/events/ev_1")) return ok(mine);
    if (p.endsWith("/events")) return ok({ items: [mine] });
    return ok({});
  }) as typeof fetch;

  try {
    const g = globalThis as unknown as { Netlify?: unknown };
    g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
    const api = (await import("../netlify/functions/api")).default;
    const call = async (path: string, method: string, body?: unknown) => {
      const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { authorization: "Bearer test", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), {} as never);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // ---- working hours: the default, then the owner's own ----
    assert.deepEqual((await call("/scheduling/hours", "GET")).body, { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", buffer: 10 });
    assert.equal((await call("/scheduling/hours", "PUT", { start: "10:00", end: "17:00" })).body.start, "10:00");
    assert.equal((await call("/scheduling/hours", "PUT", { start: "19:00" })).status, 400, "a start after the end is refused");

    // ---- find: a 30 min call with Priya and Sam, the next week ----
    const found = await call("/scheduling/find", "POST", { minutes: 30, who: [{ name: "Priya Shah", email: "priya@example.com" }, { name: "Sam Okafor", email: "sam@other.org" }], event_id: ev.id });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const card = found.body as { slots: Array<{ start: string; end: string }>; people: Array<{ name: string; seen: boolean }>; event: { can_move: boolean } };
    assert.equal(card.slots.length, 3);
    assert.deepEqual(card.people.map((p) => [p.name, p.seen]), [["Priya Shah", true], ["Sam Okafor", false]]);
    assert.equal(card.event.can_move, true);
    for (const s of card.slots) {
      assert.ok(Date.parse(s.start) >= Date.parse(priyaBusy.end), `clear of Priya: ${s.start}`);
      const p = zonedParts(new Date(s.start), "Europe/London");
      assert.ok(p.hour >= 10 && p.hour < 17, `inside the owner's hours: ${s.start}`);
    }
    // Guests were asked about once, with busy-or-free only.
    const fb = calls.filter((c) => c.url.pathname.endsWith("/freeBusy"));
    assert.equal(fb.length, 1);
    assert.deepEqual(Object.keys(fb[0].body as object).sort(), ["items", "timeMax", "timeMin"]);

    // ---- move: to the first slot ----
    const to = card.slots[0];
    const before = { start: evStart.toISOString(), end: evEnd.toISOString() };
    const moved = await call("/scheduling/move", "POST", { event_id: ev.id, start: to.start });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const patches = calls.filter((c) => c.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].url.search, "?sendUpdates=all");
    assert.deepEqual(Object.keys(patches[0].body as object).sort(), ["end", "start"]);
    assert.equal(new Date((await getEvent(ev.id))!.starts_at!).toISOString(), new Date(to.start).toISOString(), "Athena's copy moved too");
    const undo = moved.body.undo as Record<string, unknown>;
    assert.deepEqual(undo, { op: "move_event", id: ev.id, start: before.start, end: before.end, expect: new Date(to.start).toISOString() });

    // ---- undo, through Ask's undo route: back where it was ----
    assert.equal((await call("/assistant/undo", "POST", { undo })).status, 200);
    assert.equal(evStart.toISOString(), before.start);
    assert.equal(evEnd.toISOString(), before.end);
    assert.equal(new Date((await getEvent(ev.id))!.starts_at!).toISOString(), before.start);
    // Undo again: it isn't where the undo left it, so nothing is sent.
    const again = await call("/scheduling/undo", "POST", { undo });
    assert.equal(again.status, 400);
    assert.match(String(again.body.error), /moved since/);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 2);

    // ---- the switch off: refused, nothing sent ----
    await q(`UPDATE connectors SET scope = $2 WHERE id = $1`, [account.id, preset.scope]);
    const off = await call("/scheduling/move", "POST", { event_id: ev.id, start: to.start });
    assert.equal(off.status, 400);
    assert.match(String(off.body.error), /Let Athena add and update events/);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
