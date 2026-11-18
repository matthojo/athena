import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "./dates";
import { askedHistory, planFor } from "./checkin-plan";
import { DEFAULT_CHECKIN_SETTINGS, PRESET_QUESTIONS, type CheckinQuestion, type RoutineSettings } from "./checkin-types";

const ids = (qs: CheckinQuestion[]) => qs.map((q) => q.id);

test("a routine that's off asks nothing", () => {
  assert.deepEqual(planFor(DEFAULT_CHECKIN_SETTINGS.morning, PRESET_QUESTIONS, {}), []);
});

test("pinned questions come first in list order, the rest fill up to per_day in list order", () => {
  const morning: RoutineSettings = { ...DEFAULT_CHECKIN_SETTINGS.morning, enabled: true };
  // mood and focus are pinned; rested and intention are next in the list.
  assert.deepEqual(ids(planFor(morning, PRESET_QUESTIONS, {}, "morning")), ["mood", "focus", "rested", "intention"]);
});

test("the least recently asked go first; list order breaks ties", () => {
  const morning: RoutineSettings = { ...DEFAULT_CHECKIN_SETTINGS.morning, enabled: true };
  const plan = planFor(morning, PRESET_QUESTIONS, { rested: ["2026-11-16"], intention: ["2026-11-16"], energy: ["2026-11-10"] }, "morning");
  // grateful was never asked, energy longest ago.
  assert.deepEqual(ids(plan), ["mood", "focus", "energy", "grateful"]);
});

test("every pinned question is asked even past per_day; unknown, repeated or wrong-kind questions are passed over", () => {
  const r: RoutineSettings = {
    enabled: true,
    per_day: 2,
    questions: [
      { id: "mood", pinned: true },
      { id: "gone", pinned: true },
      { id: "productive", pinned: false }, // evening only
      { id: "focus", pinned: true },
      { id: "mood", pinned: false },
      { id: "intention", pinned: true },
      { id: "energy", pinned: false },
    ],
  };
  assert.deepEqual(ids(planFor(r, PRESET_QUESTIONS, {}, "morning")), ["mood", "focus", "intention"]);
});

test("the plan is a copy: changing it doesn't change the library", () => {
  const r: RoutineSettings = { enabled: true, per_day: 1, questions: [{ id: "mood", pinned: false }] };
  const [q] = planFor(r, PRESET_QUESTIONS, {});
  q.prompt = "changed";
  assert.equal(PRESET_QUESTIONS.find((p) => p.id === "mood")!.prompt, "How are you feeling?");
});

test("over a fortnight every question takes its turn, evenly", () => {
  const evening: RoutineSettings = { ...DEFAULT_CHECKIN_SETTINGS.evening, enabled: true };
  // mood and went_well pinned; stress, emotions, productive, why, tomorrow share 2 places a day.
  const plans: Array<{ date: string; plan: CheckinQuestion[] }> = [];
  const counts: Record<string, number> = {};
  let date = "2026-11-03";
  for (let day = 0; day < 14; day++, date = addDays(date, 1)) {
    const plan = planFor(evening, PRESET_QUESTIONS, askedHistory(plans), "evening");
    assert.equal(plan.length, 4);
    assert.deepEqual(ids(plan).slice(0, 2), ["mood", "went_well"]);
    plans.push({ date, plan });
    for (const id of ids(plan)) counts[id] = (counts[id] ?? 0) + 1;
  }
  assert.deepEqual(ids(plans[0].plan), ["mood", "went_well", "stress", "emotions"]);
  assert.deepEqual(ids(plans[1].plan), ["mood", "went_well", "productive", "why"]);
  // tomorrow was never asked; stress and emotions tie on day 1, and list order picks stress.
  assert.deepEqual(ids(plans[2].plan), ["mood", "went_well", "stress", "tomorrow"]);
  // emotions (day 1) next, then productive over why: both day 2, list order.
  assert.deepEqual(ids(plans[3].plan), ["mood", "went_well", "emotions", "productive"]);
  // why (day 2), then tomorrow over stress: both day 3, but stress was also asked on day 1.
  assert.deepEqual(ids(plans[4].plan), ["mood", "went_well", "why", "tomorrow"]);
  assert.equal(counts.mood, 14);
  assert.equal(counts.went_well, 14);
  // 28 places over 5 questions: each asked 5 or 6 times, never two days running.
  for (const id of ["stress", "emotions", "productive", "why", "tomorrow"]) assert.ok(counts[id] === 5 || counts[id] === 6, `${id}: ${counts[id]}`);
  for (let i = 1; i < plans.length; i++) {
    const shared = ids(plans[i].plan).slice(2).filter((id) => ids(plans[i - 1].plan).includes(id));
    assert.deepEqual(shared, [], `day ${i + 1} repeats ${shared.join(", ")}`);
  }
});

test("askedHistory lists each question's days, newest first", () => {
  const q = (id: string) => ({ id });
  assert.deepEqual(
    askedHistory([
      { date: "2026-11-08", plan: [q("a"), q("c")] },
      { date: "2026-11-10", plan: [q("a"), q("b")] },
    ]),
    { a: ["2026-11-10", "2026-11-08"], b: ["2026-11-10"], c: ["2026-11-08"] },
  );
});
