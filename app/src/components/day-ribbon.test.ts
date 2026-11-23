// Run: npx tsx --test app/src/components/day-ribbon.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarTones, dayMarks, markText, ribbonKey, ribbonLabel } from "./day-ribbon";
import type { Day, DayEvent } from "../db/days-app";

const counts = { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 as const };
const local = (hh: number, mm = 0) => new Date(2026, 10, 6, hh, mm).toISOString();
const day = (over: Partial<Day>): Day => ({ date: "2026-11-06", photos: [], places: [], notes: [], counts, events: [], entries: [], ...over });
const meeting = (id: string, hh: number, label?: string, ends?: string): DayEvent => ({ id, title: `Meeting ${id}`, kind: "meeting", starts_at: local(hh), ...(ends ? { ends_at: ends } : {}), ...(label ? { label } : {}) });

test("the shape of a day: workouts, the calendar and media, in time order, each as long as it lasted", () => {
  const m = dayMarks(
    day({
      health: { line: null, workouts: [{ type: "Running", minutes: 41, start: "07:10" }, { type: "Yoga", minutes: 30 }] },
      events: [{ id: "e", title: "Design review", kind: "meeting", starts_at: local(10) }, { id: "b", title: "Birthday", kind: "birthday", date: "2026-11-06" }],
      entries: [
        { id: "1", kind: "watched", source: "netflix", title: "Episode 6", at: local(21), minutes: 52 },
        { id: "2", kind: "listened", source: "spotify", title: "Opening", at: local(8, 30) },
        { id: "3", kind: "posted", source: "mastodon", title: "A post", at: local(13) },
        { id: "4", kind: "watched", source: "netflix", title: "No time" },
      ],
    }),
  );
  assert.deepEqual(
    m.map((x) => [x.lane, x.start, x.minutes]),
    [
      ["move", 430, 41],
      ["media", 510, 4],
      ["cal", 600, 45],
      ["media", 1260, 52],
    ],
  );
});

test("media marks carry their kind, all four of them", () => {
  const m = dayMarks(
    day({
      entries: [
        { id: "1", kind: "watched", source: "netflix", title: "Film", at: local(21) },
        { id: "2", kind: "listened", source: "spotify", title: "Song", at: local(8) },
        { id: "3", kind: "played", source: "steam", title: "Game", at: local(18), minutes: 70 },
        { id: "4", kind: "read", source: "goodreads", title: "Book", at: local(7, 50), minutes: 25 },
      ],
    }),
  );
  assert.deepEqual(m.map((x) => x.key), ["read", "listened", "played", "watched"]);
  assert.deepEqual(ribbonKey(m).map((k) => [k.word, k.tone]), [
    ["Watched", "--chart-1"],
    ["Listened", "--chart-3"],
    ["Played", "--chart-4"],
    ["Read", "--chart-5"],
  ]);
});

test("calendar marks carry their label; an event with none is neutral", () => {
  const m = dayMarks(day({ events: [meeting("a", 10, "Work"), meeting("b", 12, "personal"), meeting("c", 14)] }));
  assert.deepEqual(m.map((x) => x.key), ["work", "personal", ""]);
  assert.deepEqual(ribbonKey(m).map((k) => [k.word, k.tone]), [
    ["Work", "--chart-1"],
    ["Personal", "--chart-3"],
    ["Other", "--ink-3"],
  ]);
});

test("a label keeps its colour from day to day: work, personal, then others alphabetically", () => {
  const monday = calendarTones(["family", "work", "personal", "band"]);
  const sunday = calendarTones(["personal"]);
  const friday = calendarTones(["work"]);
  assert.equal(monday.get("work"), "--chart-1");
  assert.equal(friday.get("work"), "--chart-1");
  assert.equal(monday.get("personal"), "--chart-3");
  assert.equal(sunday.get("personal"), "--chart-3");
  assert.equal(monday.get("band"), "--chart-4");
  assert.equal(monday.get("family"), "--chart-5");
  // Past four labels, the rest go neutral rather than inventing a colour.
  assert.equal(calendarTones(["work", "personal", "a", "b", "c"]).get("c"), "--ink-3");
});

test("an event lasts until its real end, capped at the end of the day; without one it's 45 minutes", () => {
  const m = dayMarks(
    day({
      events: [
        meeting("short", 9, "work", local(9, 20)),
        meeting("none", 11, "work"),
        meeting("late", 23, "personal", new Date(2026, 10, 7, 1, 0).toISOString()),
        meeting("backwards", 15, "work", local(14)),
      ],
    }),
  );
  assert.deepEqual(m.map((x) => [x.start, x.minutes]), [
    [540, 20],
    [660, 45],
    [900, 45],
    [1380, 60],
  ]);
});

test("all-day events stay off the ribbon", () => {
  assert.equal(dayMarks(day({ events: [{ id: "b", title: "Birthday", kind: "birthday", date: "2026-11-06", label: "family" }] })).length, 0);
});

test("the key lists only what's there", () => {
  const m = dayMarks(
    day({
      events: [meeting("a", 10, "personal"), meeting("b", 13, "personal")],
      entries: [{ id: "1", kind: "watched", source: "netflix", title: "Film", at: local(21) }],
    }),
  );
  assert.deepEqual(ribbonKey(m).map((k) => `${k.lane}:${k.word}`), ["cal:Personal", "media:Watched"]);
  // Only unlabelled events: nothing to tell apart, so no calendar key.
  assert.deepEqual(ribbonKey(dayMarks(day({ events: [meeting("a", 10), meeting("b", 12)] }))), []);
});

test("tooltips and the label name the kind or the calendar", () => {
  const m = dayMarks(
    day({
      health: { line: null, workouts: [{ type: "Running", minutes: 30, start: "07:00" }] },
      events: [{ id: "a", title: "Design review", kind: "meeting", starts_at: local(13), ends_at: local(14), label: "work" }, meeting("b", 16)],
      entries: [{ id: "1", kind: "watched", source: "netflix", title: "Episode 6", at: local(21), minutes: 52 }],
    }),
  );
  assert.deepEqual(m.map((x) => markText(x, false)), ["07:00 Running", "13:00 Design review · Work calendar", "16:00 Meeting b", "21:00 Episode 6 · Watched"]);
  assert.equal(
    ribbonLabel(m, false),
    "Your day from 07:00 to 21:52. Moving: 07:00 Running. Calendar: 13:00 Design review · Work calendar; 16:00 Meeting b. Media: 21:00 Episode 6 · Watched.",
  );
});

test("with the owner's full label list, a label keeps its slot whatever else is on the day", () => {
  const owner = ["work", "personal", "band", "family"];
  // Family is fourth in the owner's list: green, alone or beside band, and never plum.
  assert.equal(calendarTones(["family"], owner).get("family"), "--chart-5");
  assert.equal(calendarTones(["band", "family"], owner).get("family"), "--chart-5");
  assert.equal(calendarTones(["band"], owner).get("band"), "--chart-4");
  // Without the list, family alone would take the first free slot.
  assert.equal(calendarTones(["family"]).get("family"), "--chart-4");
  // A label the list doesn't know follows it, alphabetically: past four slots, neutral.
  assert.equal(calendarTones(["choir"], owner).get("choir"), "--ink-3");
  assert.equal(calendarTones(["choir"], ["work", "personal", "band"]).get("choir"), "--chart-5");
  // Work and personal never move, listed or not.
  assert.equal(calendarTones(["personal"], ["work", "personal"]).get("personal"), "--chart-3");
  assert.equal(calendarTones(["work"], []).get("work"), "--chart-1");
});

test("the key follows the owner's list too", () => {
  const m = dayMarks(day({ events: [meeting("a", 10, "family")], calendar_labels: ["work", "personal", "band", "family"] }));
  assert.deepEqual(ribbonKey(m, ["work", "personal", "band", "family"]).map((k) => [k.word, k.tone]), [["Family", "--chart-5"]]);
});
