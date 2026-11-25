import { test } from "node:test";
import assert from "node:assert/strict";
import { topPicks, answeredDays, cardOrder, checkedInLine, levelWord, mornings, mornLine, oneplace, pickChange, questionTitle, rankPicks, scaleChange, scaleValues } from "./wellness-words";
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
