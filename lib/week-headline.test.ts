// Run: npx tsx --test lib/week-headline.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekHeadline, type WeekSignals } from "./week-headline";

const empty = (over: Partial<WeekSignals> = {}): WeekSignals => ({
  period: "week",
  seen: [],
  caughtUp: [],
  trips: [],
  newPlaces: [],
  todosDone: 0,
  meetings: 0,
  decisions: 0,
  goalsMoved: [],
  workouts: 0,
  moods: [null, null, null, null, null, null, null],
  media: {},
  ...over,
});

test("a busy social week leads with the trip and the people, not the music", () => {
  const h = weekHeadline(
    empty({
      seen: ["Priya", "Tom", "Ama", "Marcus", "Jo"],
      caughtUp: ["Mum"],
      trips: [{ place: "Paris", days: 3 }],
      newPlaces: ["Barbican Centre"],
      todosDone: 4,
      workouts: 3,
      runKm: 21,
      moods: [4, 5, 4, null, 5, 4, 4],
      media: { artist: "Kaito Rhee", show: "Northern Lines" },
    })
  );
  assert.equal(h.text, "A good week: time with Priya, Tom and three others, three days in Paris and three workouts");
  assert.deepEqual(h.from, ["mood", "people", "places", "health"]);
  assert.doesNotMatch(h.text, /Kaito|Northern/);
});

test("a work-heavy week names what got done", () => {
  const h = weekHeadline(empty({ todosDone: 11, meetings: 16, decisions: 2, goalsMoved: ["The memory layer"], media: { artist: "Halden" } }));
  assert.equal(h.text, "The memory layer moved on and 11 to-dos done");
  assert.deepEqual(h.from, ["done"]);
});

test("work clauses make room for health when both happened", () => {
  const h = weekHeadline(empty({ todosDone: 9, meetings: 14, workouts: 3, moods: [3, 3, 2, 3, null, null, null] }));
  assert.equal(h.text, "A steady week: nine to-dos done, 14 meetings and three workouts");
});

test("a week with only music gets the music", () => {
  const h = weekHeadline(empty({ media: { artist: "Kaito Rhee" } }));
  assert.equal(h.text, "A lot of Kaito Rhee");
  assert.deepEqual(h.from, ["media"]);
});

test("media drops out as soon as anything else happened", () => {
  const h = weekHeadline(empty({ caughtUp: ["Mum"], media: { artist: "Kaito Rhee", show: "Northern Lines" } }));
  assert.equal(h.text, "A catch-up with Mum");
});

test("an empty week is a quiet week, and a quiet month for a month", () => {
  assert.deepEqual(weekHeadline(empty()), { text: "A quiet week", from: ["none"] });
  assert.equal(weekHeadline(empty({ period: "month", moods: Array(30).fill(null) })).text, "A quiet month");
});

test("mood alone, on enough days, still says something", () => {
  assert.equal(weekHeadline(empty({ moods: [4, 4, null, null, null, null, null] })).text, "A good week");
  assert.equal(weekHeadline(empty({ moods: [4, null, null, null, null, null, null] })).text, "A quiet week");
});

test("a month needs more before work makes the line", () => {
  const month = empty({ period: "month", todosDone: 9, meetings: 20, moods: Array(30).fill(null) });
  assert.equal(weekHeadline(month).text, "A quiet month");
  assert.equal(weekHeadline({ ...month, todosDone: 30 }).text, "30 to-dos done");
});

test("long lines lose their last clause", () => {
  const h = weekHeadline(
    empty({ seen: ["Priya", "Tom"], trips: [{ place: "Lisbon and the whole Alentejo coast road", days: 9 }], goalsMoved: ["Run three times a week, all through the winter"], todosDone: 12, moods: [5, 5, 5, 5, 5, 5, 5] })
  );
  assert.ok(h.text.length <= 96, h.text);
  assert.match(h.text, /^A great week: time with Priya and Tom/);
});
