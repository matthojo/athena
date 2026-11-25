import { test } from "node:test";
import assert from "node:assert/strict";
import { dotGrid, stepOf, topPicks, answeredDays, cardOrder, checkedInLine, levelWord, mornings, mornLine, oneplace, pickChange, questionTitle, rankPicks, scaleChange, scaleValues } from "./wellness-words";
import { PRESET_QUESTIONS, type CheckinQuestion, type CheckinTrendDay } from "../../../lib/checkin-types";

const q = (id: string): CheckinQuestion => PRESET_QUESTIONS.find((x) => x.id === id)!;
const own: CheckinQuestion = { id: "own_walk", type: "scale", prompt: "How much time did you spend outside?", kinds: ["evening"], levels: ["none", "a little", "some", "a lot", "all day"], mirror: null, preset: false };
const day = (date: string, kind: "morning" | "evening", scales: Record<string, 1 | 2 | 3 | 4 | 5> = {}, picks: Record<string, string[]> = {}): CheckinTrendDay => ({ date, kind, status: "done", scales, picks });

test("titles: short for Athena's questions, the owner's own wording for theirs", () => {
  assert.equal(questionTitle(q("mood")), "Mood");
  assert.equal(questionTitle(q("emotions")), "Feelings");
  assert.equal(questionTitle(own), "How much time did you spend outside?");
});

test("cards follow the library's order, the owner's own last", () => {
  assert.deepEqual(cardOrder([own, q("stress"), q("mood"), q("focus")]).map((x) => x.id), ["mood", "stress", "focus", "own_walk"]);
});

test("an average reads in the question's words, rounded to the nearest step", () => {
  assert.equal(levelWord(q("mood"), 3.8), "Good");
  assert.equal(levelWord(q("mood"), 1.2), "Low");
  assert.equal(levelWord(q("energy"), 2.5), "Fairly energised");
  assert.equal(levelWord({ low: "None", high: "Hours" }, 4.4), "Hours");
  assert.equal(levelWord({}, 3), "3 of 5");
  assert.equal(oneplace(4), "4");
  assert.equal(oneplace(3.84), "3.8");
});

test("change against the range before, in three sizes", () => {
  assert.equal(scaleChange(3.5, 3.4, "the 4 weeks before"), "About the same as the 4 weeks before");
  assert.equal(scaleChange(3.8, 3.5, "the 4 weeks before"), "A little higher than the 4 weeks before");
  assert.equal(scaleChange(2.5, 3.5, "the year before"), "Lower than the year before");
  assert.equal(scaleChange(3, null, "the year before"), null);
});

test("mornings against evenings need three answers each", () => {
  const days = [day("2026-11-01", "morning", { energy: 4 }), day("2026-11-01", "evening", { energy: 2 }), day("2026-11-02", "morning", { energy: 4 }), day("2026-11-02", "evening", { energy: 3 }), day("2026-11-03", "morning", { energy: 5 })];
  assert.equal(mornings(days, "energy"), null);
  const more = [...days, day("2026-11-03", "evening", { energy: 2 })];
  const split = mornings(more, "energy")!;
  assert.deepEqual(scaleValues(more, "energy", "evening"), [2, 3, 2]);
  assert.equal(mornLine(split), "Lower in the evening than in the morning");
  assert.equal(mornLine({ morning: 3.4, evening: 3.5 }), "About the same in the morning and the evening");
});

test("picks rank by days, once a day however many check-ins named them", () => {
  const days = [
    day("2026-11-01", "morning", {}, { emotions: ["Calm", "Tired"] }),
    day("2026-11-01", "evening", {}, { emotions: ["Calm"] }),
    day("2026-11-02", "evening", {}, { emotions: ["Tired", "Happy"] }),
    day("2026-11-03", "evening", {}, { emotions: ["Tired"] }),
  ];
  assert.deepEqual(rankPicks(days, "emotions"), [
    { word: "Tired", days: 3 },
    { word: "Calm", days: 1 },
    { word: "Happy", days: 1 },
  ]);
  assert.equal(answeredDays(days, "emotions"), 3);
});

test("the word that moved most, only when it clearly moved", () => {
  const now = [{ word: "Tired", days: 8 }, { word: "Calm", days: 6 }];
  const then = [{ word: "Tired", days: 2 }, { word: "Calm", days: 6 }];
  assert.equal(pickChange(now, 20, then, 20, "the 4 weeks before"), "You picked Tired more often than in the 4 weeks before");
  assert.equal(pickChange(then, 20, now, 20, "the 4 weeks before"), "You picked Tired less often than in the 4 weeks before");
  assert.equal(pickChange(now, 20, now, 20, "the 4 weeks before"), null);
  assert.equal(pickChange(now, 4, then, 20, "the 4 weeks before"), null);
});

test("how often you checked in, as one sentence", () => {
  const days = [day("2026-11-01", "morning"), day("2026-11-01", "evening"), day("2026-11-02", "morning")];
  assert.equal(checkedInLine(days, "these 28 days"), "You checked in on 2 of these 28 days: 2 mornings and 1 evening.");
  assert.equal(checkedInLine([day("2026-11-02", "evening")], "these 28 days"), "You checked in on 1 of these 28 days: 1 evening.");
  assert.equal(checkedInLine([], "these 28 days"), null);
});

test("a tie at the top never reads as one winner", () => {
  const noun = { one: "word", many: "words" };
  assert.deepEqual(topPicks([{ word: "Calm", days: 4 }, { word: "Tired", days: 2 }], noun), { value: "Calm", tied: 1 });
  assert.deepEqual(topPicks([{ word: "Calm", days: 4 }, { word: "Tired", days: 4 }, { word: "Happy", days: 1 }], noun), { value: "Calm and Tired", tied: 2 });
  assert.deepEqual(topPicks([{ word: "A", days: 3 }, { word: "B", days: 3 }, { word: "C", days: 3 }], noun), { value: "3 words", tied: 3 });
  assert.equal(topPicks([], noun), null);
});

test("mood dots, four weeks: a dot a day, Monday first, gaps before the range and after the last day", () => {
  // Wednesday 25 Nov 2026; the range starts Thursday 29 Oct.
  const g = dotGrid("4w", "2026-11-25", (d) => (d === "2026-11-24" ? [4, 5] : d === "2026-10-29" ? [2] : []));
  assert.equal(g.kind, "days");
  assert.deepEqual(g.columns, ["M", "T", "W", "T", "F", "S", "S"]);
  assert.equal(g.rows.length, 5);
  assert.equal(g.rows[0].label, "26 Oct");
  assert.deepEqual(g.rows[0].cells.slice(0, 3), [null, null, null]);
  assert.deepEqual(g.rows[0].cells[3], { key: "2026-10-29", label: "Thu 29 Oct", value: 2 });
  const last = g.rows[4];
  assert.equal(last.label, "23 Nov");
  assert.deepEqual(last.cells[1], { key: "2026-11-24", label: "Tue 24 Nov", value: 4.5 });
  assert.equal(last.cells[2]!.value, null, "today with nothing answered yet");
  assert.deepEqual(last.cells.slice(3), [null, null, null, null]);
  assert.equal(g.rows.flatMap((r) => r.cells).filter(Boolean).length, 28);
});

test("mood dots, six months: a dot a week, a month to a row; a year: a dot a month, six to a row", () => {
  const six = dotGrid("6m", "2026-11-25", (d) => (d >= "2026-11-23" ? [3] : d >= "2026-11-16" && d < "2026-11-23" ? [5, 4] : []));
  assert.equal(six.kind, "weeks");
  assert.equal(six.rows.flatMap((r) => r.cells).length, 26);
  assert.equal(six.rows[six.rows.length - 1].label, "Nov");
  const nov = six.rows[six.rows.length - 1].cells;
  assert.deepEqual(nov[nov.length - 1], { key: "2026-11-23", label: "This week so far", value: 3 });
  assert.equal(nov[nov.length - 2]!.value, 4.5);
  assert.equal(nov[nov.length - 2]!.label, "Week of 16 Nov");

  const year = dotGrid("1y", "2026-11-25", (d) => (d.startsWith("2026-02") ? [1, 2] : []));
  assert.equal(year.kind, "months");
  assert.deepEqual(year.rows.map((r) => r.cells.length), [6, 6]);
  const cells = year.rows.flatMap((r) => r.cells);
  assert.deepEqual(cells.map((c) => c!.caption), ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov"]);
  assert.equal(cells[2]!.value, 1.5);
  assert.equal(cells[0]!.label, "December 2025");
  assert.equal(cells[11]!.label, "November so far");
  assert.equal(stepOf(1.5), 2);
  assert.equal(stepOf(4.4), 4);
  assert.equal(stepOf(0.2), 1);
});
