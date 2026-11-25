// The Calendar collection's pure parts (calendar-sync.ts): reading the adapters' attendee lines, building
// athena_save_event's input from a listed event, what's skipped, what counts as unchanged, and when a Meetings
// collection leaves its events to Calendar. The real path on Postgres is calendar-sync.db.test.ts.
// Run: npx tsx --test netlify/lib/connectors/calendar-sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { attendeeOf, calendarSyncLine, coveredByCalendar, eventNote, moved, saveInput, skipReason, unchanged } from "./calendar-sync";
import { calendarSyncLine as appLine } from "../../../app/src/lib/collection-words";
import { eventsLeftToCalendar } from "../../../app/src/lib/connectors-ui";

test("attendee lines: name and email, tags, replies, and what isn't a person", () => {
  assert.deepEqual(attendeeOf("Priya Shah <priya@example.com> (organiser): accepted"), { name: "Priya Shah", email: "priya@example.com", you: false, declined: false });
  assert.deepEqual(attendeeOf("me@example.com (you): no reply yet"), { email: "me@example.com", you: true, declined: false });
  assert.deepEqual(attendeeOf("Sam Lee (optional): declined"), { name: "Sam Lee", you: false, declined: true });
  assert.deepEqual(attendeeOf("Ana Ruiz <ana@example.com> (you, organiser, optional): maybe"), { name: "Ana Ruiz", email: "ana@example.com", you: true, declined: false });
  // A name with a colon in it still splits on the last one.
  assert.deepEqual(attendeeOf("Team: Design <design@example.com>: accepted"), { name: "Team: Design", email: "design@example.com", you: false, declined: false });
  assert.equal(attendeeOf("someone: no reply yet"), null);
  assert.equal(attendeeOf(""), null);
});

test("the one-line note: the place, then up to four names", () => {
  assert.equal(eventNote("Room 4", ["Priya Shah"]), "Room 4 · with Priya Shah");
  assert.equal(eventNote(undefined, ["Priya Shah", "Sam Lee", "Ana Ruiz"]), "with Priya Shah, Sam Lee and Ana Ruiz");
  assert.equal(eventNote("", ["A", "B", "C", "D", "E", "F"]), "with A, B, C, D and 2 others");
  assert.equal(eventNote("Café", ["A"], 1), "Café · with A and 1 other");
  assert.equal(eventNote("  Main   hall ", []), "Main hall");
  assert.equal(eventNote(undefined, []), "");
});

test("what isn't saved: cancelled, markers, holds; a meeting with 'focus' later in its title is", () => {
  const base = { id: "e1", start: "2026-11-26T09:00:00+00:00" };
  assert.equal(skipReason({ ...base, summary: "Design review" }), null);
  assert.equal(skipReason({ ...base, status: "cancelled" }), "cancelled");
  assert.equal(skipReason({ ...base, eventType: "workingLocation" }), "marker");
  assert.equal(skipReason({ ...base, eventType: "outOfOffice" }), "marker");
  assert.equal(skipReason({ ...base, eventType: "focusTime" }), "marker");
  assert.equal(skipReason({ ...base, summary: "Hold" }), "hold");
  assert.equal(skipReason({ ...base, summary: "HOLD: offsite" }), "hold");
  assert.equal(skipReason({ ...base, summary: "Focus time" }), "hold");
  assert.equal(skipReason({ ...base, summary: "Blocked - writing" }), "hold");
  assert.equal(skipReason({ ...base, summary: "Holdings review" }), null);
  assert.equal(skipReason({ ...base, summary: "Customer focus group" }), null);
  assert.equal(skipReason({ ...base, status: "tentative", summary: "Maybe lunch" }), null);
  assert.equal(skipReason({ start: base.start }), "no id");
  assert.equal(skipReason({ id: "e1" }), "no start");
});

test("athena_save_event's input, as the recipe described it", () => {
  const timed = saveInput({
    id: "g1",
    summary: " Design review ",
    start: "2026-11-26T09:00:00+00:00",
    end: "2026-11-26T10:00:00+00:00",
    location: "Room 4",
    myResponse: "accepted",
    attendees: ["me@example.com (you): accepted", "Priya Shah <priya@example.com> (organiser): accepted", "Sam Lee <sam@example.com>: declined", "ana@example.com: no reply yet"],
  });
  assert.deepEqual(timed, {
    external_id: "g1",
    title: "Design review",
    start: "2026-11-26T09:00:00+00:00",
    end: "2026-11-26T10:00:00+00:00",
    notes: "Room 4 · with Priya Shah and ana@example.com",
    my_response: "accepted",
    attendees: [{ name: "Priya Shah", email: "priya@example.com" }, { email: "ana@example.com" }],
  });

  const allDay = saveInput({ id: "g2", summary: "Bank holiday", start: "2026-12-25", end: "2026-12-26", allDay: true });
  assert.deepEqual(allDay, { external_id: "g2", title: "Bank holiday", date: "2026-12-25", notes: "", attendees: [] });

  // No title: still an event. Always attendees, [] when it's just the owner.
  assert.equal(saveInput({ id: "g3", start: "2026-11-26T09:00:00Z" }).title, "(no title)");
  assert.deepEqual(saveInput({ id: "g3", start: "2026-11-26T09:00:00Z", attendees: ["me@example.com (you): accepted"] }).attendees, []);

  // A guest list cut short: links left as they are, and the note counts the rest.
  const big = saveInput({ id: "g4", summary: "All hands", start: "2026-11-26T16:00:00Z", attendees: ["A <a@example.com>: accepted"], moreAttendees: 40 });
  assert.equal(big.attendees, undefined);
  assert.equal(big.notes, "with A and 40 others");
  // Read whole (get_event), they're given.
  assert.deepEqual(saveInput({ id: "g4", summary: "All hands", start: "2026-11-26T16:00:00Z", attendees: ["A <a@example.com>: accepted"] }, true).attendees, [{ name: "A", email: "a@example.com" }]);
});

test("unchanged: only when everything the save writes is the same", () => {
  const input = saveInput({ id: "g1", summary: "Design review", start: "2026-11-26T09:00:00+00:00", end: "2026-11-26T10:00:00+00:00", location: "Room 4", myResponse: "accepted" });
  const where = { source: "calendar-sync", connectorId: "c1", calendarId: "primary" };
  const held = {
    title: "Design review",
    date: "2026-11-26",
    starts_at: "2026-11-26T09:00:00.000Z",
    ends_at: "2026-11-26T10:00:00.000Z",
    notes: "Room 4",
    source: "calendar-sync",
    rsvp_calendar: "going",
    calendar_connector_id: "c1",
    calendar_id: "primary",
  };
  assert.equal(unchanged(held, input, where), true, "the same instant in another form is the same");
  assert.equal(unchanged({ ...held, starts_at: "2026-11-26T09:30:00.000Z" }, input, where), false, "moved");
  assert.equal(unchanged({ ...held, ends_at: "2026-11-26T11:00:00.000Z" }, input, where), false, "longer");
  assert.equal(unchanged({ ...held, title: "Design review (moved)" }, input, where), false, "renamed");
  assert.equal(unchanged({ ...held, notes: "Room 5" }, input, where), false, "another room or guest list");
  assert.equal(unchanged({ ...held, rsvp_calendar: "none" }, input, where), false, "your answer changed on the calendar");
  assert.equal(unchanged({ ...held, source: "calendar-meetings" }, input, where), false, "still Meetings': taken over by saving it");
  assert.equal(unchanged({ ...held, calendar_id: "family" }, input, where), false, "moved to another calendar");

  const day = saveInput({ id: "g2", summary: "Bank holiday", start: "2026-12-25", allDay: true });
  const heldDay = { ...held, title: "Bank holiday", date: "2026-12-25", starts_at: null, ends_at: null, notes: "", rsvp_calendar: null };
  assert.equal(unchanged(heldDay, day, where), true);
  assert.equal(unchanged({ ...heldDay, date: "2026-12-24" }, day, where), false);
  assert.equal(unchanged({ ...heldDay, starts_at: "2026-12-25T09:00:00Z" }, day, where), false, "was timed");
});

test("moved: a new title or time, not a new guest", () => {
  const input = saveInput({ id: "g1", summary: "Design review", start: "2026-11-26T09:00:00Z" });
  assert.equal(moved({ title: "Design review", date: null, starts_at: "2026-11-26T09:00:00.000Z" }, input), false);
  assert.equal(moved({ title: "Design review", date: null, starts_at: "2026-11-26T08:00:00.000Z" }, input), true);
  assert.equal(moved({ title: "Review", date: null, starts_at: "2026-11-26T09:00:00.000Z" }, input), true);
});

test("Meetings leaves its events to Calendar only when Calendar reads every one of its calendars", () => {
  assert.equal(coveredByCalendar(["a"], new Set(["a", "b"])), true);
  assert.equal(coveredByCalendar(["a", "b"], new Set(["a"])), false);
  assert.equal(coveredByCalendar([], new Set(["a"])), false, "no calendar account: nothing to leave");

  // The app says it the same way.
  const connectors = [
    { id: "a", provider: "google-calendar" },
    { id: "b", provider: "icloud-calendar" },
    { id: "g", provider: "granola" },
  ];
  const meetings = { recipe: "calendar-meetings" as const, connector_ids: ["a", "g"], lookahead_days: 14 };
  const calendar = { recipe: "calendar-sync" as const, enabled: true, connector_ids: ["a"] };
  assert.equal(eventsLeftToCalendar(meetings, [calendar], connectors), true, "Granola isn't a calendar");
  assert.equal(eventsLeftToCalendar(meetings, [{ ...calendar, enabled: false }], connectors), false, "Calendar off");
  assert.equal(eventsLeftToCalendar({ ...meetings, connector_ids: ["a", "b"] }, [calendar], connectors), false, "iCloud isn't covered");
  assert.equal(eventsLeftToCalendar({ ...meetings, lookahead_days: 0 }, [calendar], connectors), false, "Meetings wasn't syncing events");
});

test("the run line, the same on the server and in the app", () => {
  assert.equal(calendarSyncLine({ created: 0, changed: 0, archived: 0 }), "Up to date");
  assert.equal(calendarSyncLine({ created: 2, changed: 1, archived: 1 }), "2 new, 1 changed, 1 cancelled");
  assert.equal(appLine({ events_created: 2, events_changed: 1, archived: 1 }), "2 new, 1 changed, 1 cancelled");
  assert.equal(appLine({ events_created: 0 }), "Up to date");
});
