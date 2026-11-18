import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ANTHROPIC_API_KEY ??= "test";

test("a question back needs a question and two different choices, and never beats an answer", async () => {
  const { askBack } = await import("./answer");
  const asked = "What's something we can watch tonight?";
  const none = { found: false };
  assert.deepEqual(askBack({ ask: { question: "Do you mean a film or show to put on, or what's on TV tonight", options: ["a film from my list", "A show I'm part-way through", "a film from my list", "What's on TV tonight?"] } }, none, asked), {
    question: "Do you mean a film or show to put on, or what's on TV tonight?",
    options: ["A film from my list", "A show I'm part-way through", "What's on TV tonight?"],
    more: [],
  });
  // Four at most.
  assert.equal(askBack({ ask: { question: "Which trip do you mean?", options: ["Lisbon in May", "Rome in June", "Oslo in July", "Paris in August", "Berlin in September", "Vienna in October"] } }, none, asked)?.options.length, 5);
  // Not a real question, one choice, the owner's own words back, or nothing asked.
  assert.equal(askBack({ ask: { question: "", options: ["One", "Two"] } }, none, asked), null);
  assert.equal(askBack({ ask: { question: "Which trip do you mean?", options: ["Lisbon in May"] } }, none, asked), null);
  assert.equal(askBack({ ask: { question: "Which do you mean?", options: [asked, "A film from my list"] } }, none, asked), null);
  assert.equal(askBack({}, none, asked), null);
  assert.equal(askBack(null, none, asked), null);
  // An answer was found: no question.
  const ok = { ask: { question: "Which trip do you mean?", options: ["Lisbon in May", "Rome in June"] } };
  assert.equal(askBack(ok, { found: true }, asked), null);
  // Markup and citation markers don't reach the owner.
  assert.equal(askBack({ ask: { question: "Which <b>trip</b> do you mean? [1]", options: ["Lisbon in May", "Rome in June"] } }, none, asked)?.question, "Which trip do you mean?");
});

test("several questions can be asked together: three at most, each checked like the first, and never the app's own 'Something else'", async () => {
  const { askBack } = await import("./answer");
  const none = { found: false };
  const got = askBack(
    {
      ask: {
        question: "Which experiments do you mean?",
        options: ["The pricing page tests", "Onboarding experiments", "Something else"],
        more: [
          { question: "Over what period", options: ["This quarter", "Last month", "this quarter"] },
          { question: "Which experiments do you mean?", options: ["One thing", "Another thing"] },
          { question: "Only one choice here?", options: ["Just this"] },
          { question: "How much detail do you want?", options: ["A one-line summary", "The full results"] },
          { question: "And a fourth question?", options: ["Yes please", "No thanks"] },
        ],
      },
    },
    none,
    "What's the status of growth experiments?"
  );
  assert.deepEqual(got, {
    question: "Which experiments do you mean?",
    options: ["The pricing page tests", "Onboarding experiments"],
    more: [
      { question: "Over what period?", options: ["This quarter", "Last month"] },
      { question: "How much detail do you want?", options: ["A one-line summary", "The full results"] },
    ],
  });
});
