// Real path: answering invites against Postgres with every migration applied. The collection's own save
// tool fills the answer, the app's /api/events/:id/rsvp route and Ask's tool answer, Undo puts it back,
// and Home, This week and reminders leave declined events out. The calendar is a recorded fake port.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/rsvp.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

test("invites: synced, answered, sent only with the switch, undone, and declined ones off Home", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { AthenaWriter } = await import("../netlify/lib/connectors/runner");
  const { getEvent, listEvents, listUpcoming, q } = await import("./db");
  const { weeklyReview } = await import("./memory");
  const { answerEvent, sendPendingAnswers } = await import("./rsvp");
  const { applyUndo } = await import("./assistant");
  const { runRsvpTool } = await import("./assistant-rsvp");
  const { createConnector, setConnectorStatus, updateConnector } = await import("./connectors");
  const { RSVP_SCOPE, presetFor } = await import("./connector-presets");

  await q(`DELETE FROM events WHERE source = 'calendar-meetings-work'`);
  const preset = presetFor("google-calendar");
  const account = await createConnector({ name: "Google Calendar", provider: "google-calendar", account_label: "work", url: preset.url, auth_type: "oauth", scope: preset.scope, secrets: {} } as never);
  await setConnectorStatus(account.id, "connected");

  // The calendar: every reply Athena sends, and a switch to make the next one fail.
  const sent: Array<{ connectorId: string; calendarId: string; eventId: string; answer: string; series?: boolean }> = [];
  let failNext = "";
  const calendar = {
    async respond(connectorId: string, invite: { calendarId: string; eventId: string; answer: string; series?: boolean }) {
      if (failNext) {
        const why = failNext;
        failNext = "";
        throw new Error(why);
      }
      sent.push({ connectorId, ...invite });
    },
  };

  // ---- the collection syncs two invites from this account's list_events ----
  const now = new Date("2026-11-07T09:00:00Z");
  const collection = { id: "c1", name: "Meetings", recipe: "calendar-meetings", connector_ids: [account.id], label: "work", source: "calendar-meetings-work", instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 14, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
  const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as never;
  const writer = new AthenaWriter(collection, "00000000-0000-4000-8000-000000000001", stats, now, "Europe/London");
  const listing = (review: string, standup: string) =>
    JSON.stringify({
      events: [
        { id: "ev_review", summary: "Design review", start: "2026-11-13T14:00:00Z", myResponse: review },
        { id: "ev_standup", summary: "Standup", start: "2026-11-09T09:30:00Z", myResponse: standup },
      ],
    });
  const sync = async (review: string, standup: string) => {
    writer.noteCalendarResult(account, {}, listing(review, standup));
    const a = JSON.parse(await writer.run("athena_save_event", { external_id: "ev_review", title: "Design review", start: "2026-11-13T14:00:00Z", attendees: [] }));
    const b = JSON.parse(await writer.run("athena_save_event", { external_id: "ev_standup", title: "Standup", start: "2026-11-09T09:30:00Z", attendees: [] }));
    return { review: a.id as string, standup: b.id as string };
  };
  const ids = await sync("no reply yet", "accepted");
  let review = (await getEvent(ids.review))!;
  assert.deepEqual([review.rsvp, review.rsvp_calendar, review.calendar_event_id, review.calendar_id, review.calendar_connector_id], ["none", "none", "ev_review", "primary", account.id]);
  assert.equal((await getEvent(ids.standup))!.rsvp, "going", "the calendar's own answer comes through");
  assert.equal(review.rsvp_account?.can_send, false, "switch off");

  // ---- the app's route, switch off: kept in Athena, nothing sent ----
  const g = globalThis as unknown as { Netlify?: unknown };
  g.Netlify = { env: { get: (k: string) => (k === "MCP_BEARER_TOKEN" ? "test" : process.env[k]) } };
  const api = (await import("../netlify/functions/api")).default;
  const res = await api(new Request(`https://athena.test/api/events/${ids.review}/rsvp`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ answer: "declined" }) }), {} as never);
  assert.equal(res.status, 200);
  const off = (await res.json()) as { outcome: string; message: string; event: { rsvp: string } };
  assert.equal(off.outcome, "saved");
  assert.equal(off.event.rsvp, "declined");
  assert.match(off.message, /Only in Athena/);
  assert.equal(sent.length, 0, "no switch, nothing sent");
  const bad = await api(new Request(`https://athena.test/api/events/${ids.review}/rsvp`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ answer: "sure" }) }), {} as never);
  assert.equal(bad.status, 400);

  // ---- declined: off Home, This week and reminders' list; still under Events ----
  const home = await listUpcoming(14, now, "Europe/London");
  assert.ok(!home.events.some((o) => o.event.id === ids.review), "off Home");
  assert.ok(home.events.some((o) => o.event.id === ids.standup));
  const week = await weeklyReview("2026-11-02", now, "Europe/London");
  assert.ok(!week.next_week.events.some((o) => o.event.id === ids.review), "off This week's next week");
  assert.ok((await listEvents()).some((e) => e.id === ids.review && e.rsvp === "declined"), "still under Events");

  // ---- yours wins until the calendar changes ----
  await sync("no reply yet", "accepted");
  assert.equal((await getEvent(ids.review))!.rsvp, "declined", "same calendar answer: yours holds");
  await sync("accepted", "accepted");
  review = (await getEvent(ids.review))!;
  assert.deepEqual([review.rsvp, review.rsvp_mine], ["going", false], "you answered in the calendar itself: it wins");

  // ---- the switch on: the reply goes to the calendar ----
  await updateConnector(account.id, { scope: `${preset.scope} ${RSVP_SCOPE["google-calendar"]}` });
  assert.equal((await getEvent(ids.review))!.rsvp_account?.can_send, true);
  const on = await answerEvent(ids.review, "maybe", { calendar });
  assert.equal(on.outcome, "sent");
  assert.deepEqual(sent, [{ connectorId: account.id, calendarId: "primary", eventId: "ev_review", answer: "maybe" }]);
  assert.equal(on.event.rsvp_calendar, "maybe", "the calendar now agrees");

  // ---- a failed send keeps your answer and says why ----
  failNext = "Google Calendar doesn't have this event any more";
  const failed = await answerEvent(ids.review, "declined", { calendar });
  assert.equal(failed.outcome, "failed");
  review = (await getEvent(ids.review))!;
  assert.deepEqual([review.rsvp, review.rsvp_error], ["declined", "Google Calendar doesn't have this event any more"]);
  await sync("maybe", "accepted");
  assert.equal((await getEvent(ids.review))!.rsvp, "declined", "a failed send still holds at the next sync");

  // ---- Ask: "I can't make Friday's design review" only prepares a card; the owner's tap answers ----
  const cards: Array<{ kind: string; event_id?: string; answer?: string; series?: boolean; sends_to?: string | null }> = [];
  const confirm = (c: (typeof cards)[number]) => void cards.push(c);
  await answerEvent(ids.review, "going", { calendar });
  sent.length = 0;
  const told = await runRsvpTool("answer_invite", { event_id: ids.review, answer: "declined" }, { confirm });
  assert.match(told, /Nothing has been sent or saved yet/);
  assert.deepEqual(cards[0], { kind: "rsvp", event_id: ids.review, title: review.title, starts_at: review.starts_at, date: review.date, answer: "declined", sends_to: "Google Calendar" });
  assert.equal(sent.length, 0, "nothing reaches the calendar from the model's turn");
  assert.equal((await getEvent(ids.review))!.rsvp, "going", "and nothing changes in Athena");
  // The tap: the same route the event's page uses (POST /api/events/:id/rsvp → answerEvent).
  const tapped = await answerEvent(ids.review, "declined", { calendar });
  assert.equal(tapped.outcome, "sent");
  assert.deepEqual(sent.map((s) => s.answer), ["declined"]);
  // A receipt made before this change can still be undone.
  await applyUndo({ op: "restore_rsvp", id: ids.review, rsvp: "going" }, { calendar });
  assert.equal((await getEvent(ids.review))!.rsvp, "going", "Undo puts your answer back");
  assert.deepEqual(sent.map((s) => s.answer), ["declined", "going"], "and on the calendar");

  // ---- "all of them" for a repeating invite rides on the card; still nothing sent ----
  sent.length = 0;
  await runRsvpTool("answer_invite", { event_id: ids.review, answer: "maybe", series: true }, { confirm });
  assert.equal(cards[1].series, true);
  assert.equal(sent.length, 0);
  await answerEvent(ids.review, "maybe", { calendar }, { series: true });
  assert.deepEqual(sent.map((s) => [s.answer, (s as { series?: boolean }).series]), [["maybe", true]], "the series flag reaches the calendar on the tap");
  sent.length = 0;

  // ---- answers given while the switch was off go out once it's on ----
  await updateConnector(account.id, { scope: preset.scope });
  await answerEvent(ids.standup, "declined", { calendar });
  sent.length = 0;
  await updateConnector(account.id, { scope: `${preset.scope} ${RSVP_SCOPE["google-calendar"]}` });
  assert.equal(await sendPendingAnswers(account.id, { calendar }, now), 1);
  assert.deepEqual(sent.map((s) => [s.eventId, s.answer]), [["ev_standup", "declined"]]);
  assert.equal(await sendPendingAnswers(account.id, { calendar }, now), 0, "only once");

  // ---- an event you added yourself: kept in Athena, never sent ----
  const { upsertEvent } = await import("./db");
  const own = await upsertEvent({ title: "Dentist", date: "2026-11-12", time: "10:00", tz: "Europe/London" });
  sent.length = 0;
  const mine = await answerEvent(own.id, "declined", { calendar });
  assert.deepEqual([mine.outcome, mine.message, sent.length], ["saved", "", 0]);

  await q(`DELETE FROM events WHERE id = $1 OR source = 'calendar-meetings-work'`, [own.id]);
  await q(`DELETE FROM connectors WHERE id = $1`, [account.id]);
});
