import assert from "node:assert/strict";
import { test } from "node:test";
import { answerLine, cardDetail, firstOpen, isEmptyValue, listWords, moved, ownQuestionProblem, pickPlan, scaleSentence, todayCheckin, withAnswer } from "./checkin-rules";
import { DEFAULT_CHECKIN_SETTINGS, PRESET_QUESTIONS, type Checkin, type CheckinQuestion, type RoutineSettings } from "../../../lib/checkin-types";
import { parseCheckin, parseRoute } from "../lib/routes";

const q = (id: string) => PRESET_QUESTIONS.find((x) => x.id === id)!;
const at = "2026-11-17T08:00:00Z";

test("a scale reads as its sentence", () => {
  assert.equal(scaleSentence(q("energy"), 4), "Right now I feel energised");
  assert.equal(scaleSentence(q("mood"), 1), "I'm feeling low");
});

test("the flow opens at the first question with no answer, and past the end when all have one", () => {
  const c: Checkin = { date: "2026-11-17", kind: "morning", plan: [q("mood"), q("focus"), q("intention")], answers: {}, status: "open" };
  assert.equal(firstOpen(c), 0);
  const one = withAnswer(c, "mood", { scale: 3 }, at);
  assert.equal(firstOpen(one), 1);
  // A skip counts as an answer: the flow doesn't come back to it.
  const two = withAnswer(withAnswer(one, "intention", { skipped: true }, at), "focus", { picks: ["Work"] }, at);
  assert.equal(firstOpen(two), 3);
  assert.equal(firstOpen(withAnswer(two, "focus", null, at)), 1);
});

test("pinned questions come every day; the rest take turns, least recently asked first, in the routine's order", () => {
  const routine: RoutineSettings = { enabled: true, per_day: 3, questions: [{ id: "mood", pinned: true }, { id: "rested", pinned: false }, { id: "energy", pinned: false }, { id: "grateful", pinned: false }] };
  assert.deepEqual(pickPlan(routine, PRESET_QUESTIONS).map((x) => x.id), ["mood", "rested", "energy"]);
  const last = { rested: "2026-11-16", energy: "2026-11-15", grateful: "2026-11-10" };
  assert.deepEqual(pickPlan(routine, PRESET_QUESTIONS, last).map((x) => x.id), ["mood", "energy", "grateful"]);
  assert.deepEqual(pickPlan({ ...routine, enabled: false }, PRESET_QUESTIONS), []);
  // A question gone from the library drops out.
  assert.deepEqual(pickPlan({ ...routine, questions: [{ id: "own_gone", pinned: true }, ...routine.questions] }, PRESET_QUESTIONS).map((x) => x.id), ["mood", "rested", "energy"]);
});

test("Today shows a card for each routine that's on, at any hour; the offer when both are off", () => {
  const on = { morning: { ...DEFAULT_CHECKIN_SETTINGS.morning, enabled: true }, evening: { ...DEFAULT_CHECKIN_SETTINGS.evening, enabled: true } };
  // Both on: both cards, at any hour, done or not (the card says which).
  assert.deepEqual(todayCheckin(on, false), { show: "routines", kinds: ["morning", "evening"] });
  assert.deepEqual(todayCheckin(on, true), { show: "routines", kinds: ["morning", "evening"] }, "the offer being dismissed doesn't matter");
  assert.deepEqual(todayCheckin({ ...on, evening: { ...on.evening, enabled: false } }, false), { show: "routines", kinds: ["morning"] });
  assert.deepEqual(todayCheckin({ ...on, morning: { ...on.morning, enabled: false } }, false), { show: "routines", kinds: ["evening"] });
  assert.deepEqual(todayCheckin(DEFAULT_CHECKIN_SETTINGS, false), { show: "offer" });
  assert.deepEqual(todayCheckin(DEFAULT_CHECKIN_SETTINGS, true), { show: "none" });
});

test("the card counts what's left once started", () => {
  assert.equal(cardDetail(4, 4), "4 questions");
  assert.equal(cardDetail(1, 1), "1 question");
  assert.equal(cardDetail(4, 2), "2 of 4 left");
});

test("answers read back in a line; skips and empty picks don't", () => {
  assert.equal(answerLine(q("stress"), { question_id: "stress", value: { scale: 2 }, answered_at: at }), "My stress is low");
  assert.equal(answerLine(q("emotions"), { question_id: "emotions", value: { picks: ["Calm", "Grateful", "Tired"] }, answered_at: at }), "Calm, Grateful and Tired");
  assert.equal(answerLine(q("why"), { question_id: "why", value: { skipped: true }, answered_at: at }), null);
  assert.equal(answerLine(q("why"), undefined), null);
  assert.equal(listWords(["Work"]), "Work");
  assert.ok(isEmptyValue({ picks: [] }));
  assert.ok(isEmptyValue({ text: "  " }));
  assert.ok(!isEmptyValue({ text: "", deeper: { question: "Why?", text: "Because" } }));
});

test("an own question needs its words before it saves", () => {
  const base: CheckinQuestion = { id: "own_x", type: "scale", prompt: "How did you sleep?", kinds: ["morning"], lead: "I slept", levels: ["badly", "poorly", "okay", "well", "very well"], mirror: null, preset: false };
  assert.equal(ownQuestionProblem(base), null);
  assert.match(ownQuestionProblem({ ...base, prompt: " " })!, /question/);
  assert.match(ownQuestionProblem({ ...base, kinds: [] })!, /morning/);
  assert.match(ownQuestionProblem({ ...base, levels: ["a", "", "c", "d", "e"] })!, /five/);
  assert.match(ownQuestionProblem({ ...base, type: "choices", options: [] })!, /choice/);
  assert.equal(ownQuestionProblem({ ...base, type: "text", lead: undefined, levels: undefined }), null);
});

test("moving a question keeps the rest in order", () => {
  assert.deepEqual(moved(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moved(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
});

test("check-in links open over Home", () => {
  assert.deepEqual(parseCheckin("#/checkin/morning"), { kind: "morning", date: null });
  assert.deepEqual(parseCheckin("#/checkin/evening/2026-11-16"), { kind: "evening", date: "2026-11-16" });
  assert.equal(parseCheckin("#/checkin/lunch"), null);
  assert.equal(parseCheckin("#/days"), null);
  assert.equal(parseRoute("#/checkin/morning", "2026-11-17").view, "home");
  assert.deepEqual(parseRoute("#/settings/checkins", "2026-11-17"), { view: "settings", source: null, noteId: "checkins" });
});
