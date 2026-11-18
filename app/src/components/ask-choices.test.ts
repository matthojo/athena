import assert from "node:assert/strict";
import { test } from "node:test";
import { askAnswers } from "./ask-choices";

test("several answers go back with their questions, a line each", () => {
  const asks = [
    { question: "Which experiments do you mean?", options: ["The pricing page tests", "Onboarding"] },
    { question: "Over what period?", options: ["This quarter", "Last month"] },
  ];
  assert.equal(askAnswers(asks, ["The pricing page tests", "Last month"]), "Which experiments do you mean? The pricing page tests\nOver what period? Last month");
});
