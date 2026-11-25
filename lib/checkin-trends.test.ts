import { test } from "node:test";
import assert from "node:assert/strict";
import { trendsOf, type TrendRow } from "./checkin-trends";
import { PRESET_QUESTIONS, type CheckinQuestion } from "./checkin-types";

const q = (id: string): CheckinQuestion => PRESET_QUESTIONS.find((x) => x.id === id)!;
const at = "2026-11-20T08:10:00Z";

test("keeps scale answers and picks; leaves out written answers, skips and empty picks", () => {
  const rows: TrendRow[] = [
    {
      date: "2026-11-20",
      kind: "morning",
      status: "done",
      plan: [q("mood"), q("focus"), q("intention"), q("rested"), q("emotions")],
      answers: {
        mood: { question_id: "mood", value: { scale: 4 }, answered_at: at },
        focus: { question_id: "focus", value: { picks: ["Work", "Family"] }, answered_at: at },
        intention: { question_id: "intention", value: { text: "A walk at lunch" }, answered_at: at },
        rested: { question_id: "rested", value: { skipped: true }, answered_at: at },
        emotions: { question_id: "emotions", value: { picks: [] }, answered_at: at },
      },
    },
  ];
  const t = trendsOf(rows);
  assert.deepEqual(t.days, [{ date: "2026-11-20", kind: "morning", status: "done", scales: { mood: 4 }, picks: { focus: ["Work", "Family"] } }]);
  assert.deepEqual(t.questions.map((x) => x.id).sort(), ["focus", "mood"]);
});

test("oldest first, morning before evening; a check-in with nothing to draw is dropped", () => {
  const mood = (date: string, kind: "morning" | "evening", scale: 1 | 2 | 3 | 4 | 5): TrendRow => ({ date, kind, status: "done", plan: [q("mood")], answers: { mood: { question_id: "mood", value: { scale }, answered_at: at } } });
  const empty: TrendRow = { date: "2026-11-19", kind: "evening", status: "open", plan: [q("mood")], answers: {} };
  const t = trendsOf([mood("2026-11-21", "evening", 5), mood("2026-11-21", "morning", 3), empty, mood("2026-11-18", "evening", 2)]);
  assert.deepEqual(
    t.days.map((d) => `${d.date} ${d.kind} ${d.scales.mood}`),
    ["2026-11-18 evening 2", "2026-11-21 morning 3", "2026-11-21 evening 5"]
  );
});

test("an own question edited since reads under its latest wording", () => {
  const own = (prompt: string): CheckinQuestion => ({ id: "own_walk", type: "scale", prompt, kinds: ["evening"], levels: ["a", "b", "c", "d", "e"], mirror: null, preset: false });
  const row = (date: string, prompt: string): TrendRow => ({ date, kind: "evening", status: "done", plan: [own(prompt)], answers: { own_walk: { question_id: "own_walk", value: { scale: 3 }, answered_at: at } } });
  const t = trendsOf([row("2026-11-22", "Time outside?"), row("2026-11-01", "Did you get outside?")]);
  assert.equal(t.questions[0].prompt, "Time outside?");
});
