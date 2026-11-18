// The Sunday push's signals, built on the server (lib/week-push.ts) the way the Week in review builds them.
// app/src/lib/week-review.test.ts also holds them to the page's own model, word for word.
// Run: npx tsx --test lib/week-push.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mondayOf, weekSignals, type WeekFacts } from "./week-push";
import { weekHeadline } from "./week-headline";
import type { Day } from "./day-types";

const TZ = "Europe/London";
const day = (date: string, over: Partial<Day> = {}): WeekFacts["days"][number] => ({ date, places: [], entries: [], events: [], ...over });
const facts = (over: Partial<WeekFacts> = {}): WeekFacts => ({
  period: "week",
  from: "2026-11-09",
  to: "2026-11-15",
  today: "2026-11-15",
  tz: TZ,
  days: [],
  interactions: [],
  seenEvents: [],
  commitments: [],
  goalMoves: [],
  trips: [],
  knownPlaces: null,
  ...over,
});

test("mondayOf: Sunday's week starts the Monday before", () => {
  assert.equal(mondayOf("2026-11-15"), "2026-11-09");
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-01"), "2026-10-26");
});

test("people: seen in person and catch-ups by first name; meetings and messages aren't catch-ups", () => {
  const s = weekSignals(
    facts({
      interactions: [
        { at: "2026-11-10T12:00:00Z", channel: "in_person", people: [{ id: "tom", name: "Tom Hale" }] },
        { at: "2026-11-11T19:00:00Z", channel: "call", people: [{ id: "mum", name: "Mum" }] },
        { at: "2026-11-11T09:00:00Z", channel: "meeting", people: [{ id: "el", name: "Elena Osei" }] },
        { at: "2026-11-12T09:00:00Z", channel: "message", people: [{ id: "sam", name: "Sam Reid" }] },
        { at: "2026-11-02T09:00:00Z", channel: "in_person", people: [{ id: "jo", name: "Jo Carter" }] },
      ],
      seenEvents: [{ id: "e1", date: "2026-11-13", place: "Barbican Centre", people: [{ id: "priya", name: "Priya Shah" }] }],
    })
  );
  assert.deepEqual(s.seen, ["Priya", "Tom"]);
  assert.deepEqual(s.caughtUp, ["Mum"]);
});

test("the Sunday line: people and the trip lead, nothing late is in it", () => {
  const s = weekSignals(
    facts({
      days: [day("2026-11-10", { mood: 4 }), day("2026-11-11", { mood: 4 }), day("2026-11-14", { mood: 5 })],
      interactions: [{ at: "2026-11-10T12:00:00Z", channel: "in_person", people: [{ id: "tom", name: "Tom Hale" }] }],
      seenEvents: [{ id: "e1", date: "2026-11-12", place: "Dishoom", people: [{ id: "priya", name: "Priya Shah" }] }],
      trips: [{ title: "Bristol", starts_on: "2026-11-13", ends_on: "2026-11-14" }],
      commitments: [
        { title: "Overdue tax return", kind: "todo", status: "open", done_at: null, created_at: "2026-10-01T09:00:00Z" },
        { title: "Book flights", kind: "todo", status: "done", done_at: "2026-11-10T09:00:00Z", created_at: "2026-11-01T09:00:00Z" },
      ],
    })
  );
  assert.equal(s.todosDone, 1);
  assert.deepEqual(s.trips, [{ place: "Bristol", days: 2 }]);
  const line = weekHeadline(s).text;
  assert.equal(line, "A good week: time with Priya and Tom and two days in Bristol");
  assert.doesNotMatch(line, /overdue|late|open|tax/i);
});

test("done: to-dos and decisions on the owner's day; a dropped decision and last week's to-do don't count", () => {
  const s = weekSignals(
    facts({
      commitments: [
        // 23:30 UTC on Sunday 8 Nov is still last week in London.
        { title: "Last week", kind: "todo", status: "done", done_at: "2026-11-08T23:30:00Z", created_at: "2026-11-01T09:00:00Z" },
        { title: "Pay Tom back", kind: "i_owe", status: "done", done_at: "2026-11-09T08:00:00Z", created_at: "2026-11-01T09:00:00Z" },
        { title: "Pick the venue", kind: "decision", status: "open", done_at: null, created_at: "2026-11-10T10:00:00Z" },
        { title: "Pick the venue", kind: "decision", status: "done", done_at: "2026-11-11T10:00:00Z", created_at: "2026-11-10T10:00:00Z" },
        { title: "Skip it", kind: "decision", status: "dropped", done_at: null, created_at: "2026-11-10T10:00:00Z" },
        { title: "Archived", kind: "todo", status: "done", done_at: "2026-11-10T10:00:00Z", created_at: "2026-11-10T10:00:00Z", archived_at: "2026-11-11T00:00:00Z" },
      ],
    })
  );
  assert.equal(s.todosDone, 1);
  assert.equal(s.decisions, 1);
});

test("health, habits, places and media come from the week's Days; days to come are left out", () => {
  const art = { id: "a", w: 1, h: 1 };
  const s = weekSignals(
    facts({
      today: "2026-11-11",
      knownPlaces: new Set(["Dishoom"]),
      days: [
        day("2026-11-09", { mood: 3, places: [{ name: "Work" }, { name: "Dishoom" }, { name: "Barbican Centre" }] as Day["places"], health: { sleep_minutes: 360, workouts: [{ type: "Run", minutes: 30, distance_m: 6000 }] } as Day["health"], entries: [{ id: "h", kind: "habit", source: "habits", title: "Walk" }, { id: "l", kind: "listened", source: "spotify", title: "Blackstar", subtitle: "David Bowie", art, count: 3 }] as Day["entries"], events: [{ id: "m", title: "Standup", kind: "meeting" }, { id: "b", title: "Mum's birthday", kind: "birthday", date: "2026-11-09" }] }),
        day("2026-11-10", { health: { sleep_minutes: 340 } as Day["health"], entries: [{ id: "h2", kind: "habit", source: "habits", title: "Walk", count: 0 }] as Day["entries"] }),
        day("2026-11-13", { mood: 5, entries: [{ id: "h3", kind: "habit", source: "habits", title: "Walk" }] as Day["entries"] }),
      ],
    })
  );
  assert.deepEqual(s.newPlaces, ["Barbican Centre"]);
  assert.equal(s.workouts, 1);
  assert.equal(s.runKm, 6);
  assert.equal(s.sleepAvg, 350);
  assert.equal(s.meetings, 1);
  assert.deepEqual([s.habitsKept, s.habitsDue], [1, 2]);
  assert.deepEqual(s.moods, [3, null, null]);
  assert.equal(s.media.artist, "David Bowie");
  assert.match(weekHeadline(s).text, /short nights/);
});
