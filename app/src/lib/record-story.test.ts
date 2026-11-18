// Run: npx tsx --test app/src/lib/record-story.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastHereLine, lastSawLine, longDate, minutesWords, namesList, personStory, placeStory, storyWhen } from "./record-story";

const TODAY = "2026-11-09"; // a Monday
const PRIYA = "p-priya";
const TOM = "p-tom";
const day = (iso: string) => iso.slice(0, 10);

test("storyWhen: today, yesterday, a weekday this past week, then a date", () => {
  assert.equal(storyWhen("2026-11-09", TODAY), "Today");
  assert.equal(storyWhen("2026-11-08", TODAY), "Yesterday");
  assert.equal(storyWhen("2026-11-04", TODAY), "Wednesday");
  assert.equal(storyWhen("2026-11-02", TODAY), "2 November");
  assert.equal(storyWhen("2025-10-12", TODAY), "12 October 2025");
});

test("longDate reads like the app: weekday, day, month; the year only when it isn't this one", () => {
  assert.equal(longDate("2026-11-10", TODAY), "Tuesday 10 November");
  assert.equal(longDate("2027-01-05", TODAY), "Tuesday 5 January 2027");
  assert.equal(longDate("", TODAY), "");
});

test("minutesWords rounds the way you'd say it", () => {
  assert.equal(minutesWords(42), "40 minutes");
  assert.equal(minutesWords(3), "5 minutes");
  assert.equal(minutesWords(62), "an hour");
  assert.equal(minutesWords(95), "1½ hours");
  assert.equal(minutesWords(121), "2 hours");
});

test("namesList joins with commas and 'and'", () => {
  assert.equal(namesList([]), "");
  assert.equal(namesList(["Tom"]), "Tom");
  assert.equal(namesList(["Tom", "Priya"]), "Tom and Priya");
  assert.equal(namesList(["Tom", "Priya", "Sam"]), "Tom, Priya and Sam");
});

test("personStory: catch-ups and calendar events, newest first, others named", () => {
  const rows = personStory({
    personId: PRIYA,
    today: TODAY,
    localDay: day,
    interactions: [
      { id: "i1", at: "2026-11-04T13:00:00Z", channel: "in_person", how: "Lunch", where: "Dishoom", summary: "The Northwind offer.", people: [{ id: PRIYA, name: "Priya Shah" }] },
      { id: "i2", at: "2026-11-06T10:00:00Z", channel: "call", summary: "", people: [{ id: PRIYA, name: "Priya Shah" }, { id: TOM, name: "Tom Hale" }] },
      { id: "i3", at: "2026-11-01T10:00:00Z", channel: "call", summary: "", people: [{ id: TOM, name: "Tom Hale" }] },
      { id: "i4", at: "2026-11-02T10:00:00Z", channel: "email", summary: "", people: [{ id: PRIYA, name: "Priya Shah" }], archived_at: "2026-11-03T00:00:00Z" },
    ],
    seen: [{ id: "e1", title: "Quiz night", date: "2026-10-20", people: [{ id: PRIYA, name: "Priya Shah" }, { id: TOM, name: "Tom Hale" }], place: "The Lyric" }],
    events: [
      { id: "e1", title: "Quiz night", date: "2026-10-20" },
      { id: "e2", title: "Design review", date: "2026-10-28" },
      { id: "e3", title: "Priya's birthday", date: "2026-10-30", kind: "birthday" },
      { id: "e4", title: "Offsite", date: "2026-11-20" },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.date, r.title]),
    [
      ["2026-11-06", "Call with Tom"],
      ["2026-11-04", "Lunch"],
      ["2026-10-28", "Design review"],
      ["2026-10-20", "Quiz night with Tom"],
    ]
  );
  assert.equal(rows[1].where, "Dishoom");
  assert.equal(rows[1].summary, "The Northwind offer.");
  assert.equal(rows[3].event, "e1");
});

test("personStory: a logged lunch and the calendar's lunch on the same day are one row", () => {
  const rows = personStory({
    personId: PRIYA,
    today: TODAY,
    localDay: day,
    interactions: [{ id: "i1", at: "2026-11-04T13:00:00Z", channel: "in_person", how: "Lunch", summary: "", people: [{ id: PRIYA, name: "Priya Shah" }] }],
    seen: [{ id: "e1", title: "Lunch", date: "2026-11-04", people: [{ id: PRIYA, name: "Priya Shah" }], place: "Dishoom" }],
    events: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].where, "Dishoom");
  assert.equal(rows[0].event, "e1");
});

test("lastSawLine: in person reads 'Last saw Wednesday, lunch at Dishoom'", () => {
  const rows = [{ date: "2026-11-04", title: "Lunch", where: "Dishoom", inPerson: true, kind: "in_person" as const }];
  assert.equal(lastSawLine(rows, TODAY), "Last saw Wednesday, lunch at Dishoom");
  assert.equal(lastSawLine([{ ...rows[0], title: "In person" }], TODAY), "Last saw Wednesday at Dishoom");
  assert.equal(lastSawLine([{ ...rows[0], date: TODAY }], TODAY), "Saw them today, lunch at Dishoom");
  assert.equal(lastSawLine([{ ...rows[0], date: "2026-11-08" }], TODAY), "Last saw yesterday, lunch at Dishoom");
  assert.equal(lastSawLine([{ date: "2026-11-03", title: "Video call", inPerson: false, kind: "call" }], TODAY), "Last spoke Tuesday, video call");
  assert.equal(lastSawLine([{ date: "2026-10-03", title: "Call", inPerson: false, kind: "call" }], TODAY), "Last spoke 3 October");
  assert.equal(lastSawLine([], TODAY), null);
});

test("placeStory: Days, the server's visits and events there merge into one row a day", () => {
  const rows = placeStory({
    place: { id: "pl-1", name: "Barbican Centre" },
    today: TODAY,
    days: [
      { date: "2026-11-07", places: [{ id: "x", name: "Home" }, { name: "Barbican Centre", minutes: 118 }] },
      { date: "2026-10-18", places: [{ id: "pl-1", name: "Barbican", minutes: 40 }] },
      { date: "2026-10-10", places: [{ name: "Dishoom", minutes: 60 }] },
    ],
    visits: [
      { date: "2026-11-07", minutes: 120 },
      { date: "2026-09-02", minutes: 0 },
    ],
    seen: [
      { id: "e1", title: "Gallery", date: "2026-11-07", people: [{ id: TOM, name: "Tom Hale" }], place: "Barbican Centre" },
      { id: "e2", title: "Quiz night", date: "2026-11-01", people: [{ id: TOM, name: "Tom Hale" }], place: "The Lyric" },
    ],
    events: [
      { id: "e1", title: "Gallery", date: "2026-11-07" },
      { id: "e5", title: "Hamlet", date: "2026-11-21" },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.date, r.title, r.length ?? null]),
    [
      ["2026-11-07", "Gallery with Tom", "2 hours"],
      ["2026-10-18", "40 minutes here", null],
      ["2026-09-02", "Visited", null],
    ]
  );
  assert.equal(lastHereLine(rows, TODAY), "Last here Saturday, gallery with Tom");
  assert.equal(lastHereLine(rows.slice(1), TODAY), "Last here 18 October, for 40 minutes");
  assert.equal(lastHereLine([], TODAY), null);
});
