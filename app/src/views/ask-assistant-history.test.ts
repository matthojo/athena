/**
 * What a follow-up is sent of the conversation so far, on the production
 * case of 12 November 2026: a brownie answer, then "Turn this into a recipe".
 * The one history (app/src/lib/ask-history.ts answerHistory) replaced
 * assistantHistory in views/ask.ts; these are that function's tests, kept on
 * the same cases.
 * Run: `npx tsx --test app/src/views/ask-assistant-history.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerHistory } from "../lib/ask-history";

const me = (text: string) => ({ role: "me", text });
const answer = (text: string, more: Record<string, unknown> = {}) => ({ role: "answer", reply: { text, sources: [], ...more }, fallback: null });
const assistant = (text: string | null) => ({ role: "assistant", reply: text === null ? null : { text, changes: [] } });
const fallback = () => ({ role: "answer", reply: null, fallback: { notes: [] } });
const keyword = () => ({ role: "athena", answer: { notes: [] } });

const brownies = "Melt 200 g butter with 200 g dark chocolate [1].\n\n- Whisk in 3 eggs and 250 g sugar [2]\n- Fold in 100 g flour\n\nBake at 180°C for 25 minutes [1][2].";
const plain = "Melt 200 g butter with 200 g dark chocolate.\n\n- Whisk in 3 eggs and 250 g sugar\n- Fold in 100 g flour\n\nBake at 180°C for 25 minutes.";

test("a request after a written answer carries that answer's whole text, without its citations", () => {
  const history = answerHistory([me("How do I make brownies?"), answer(brownies)]);
  assert.deepEqual(history, [
    { role: "user", text: "How do I make brownies?" },
    { role: "assistant", text: plain, refs: [] },
  ]);
});

test("a general answer is carried like any other", () => {
  const history = answerHistory([me("How do I make brownies?"), answer(plain, { general: true })]);
  assert.equal(history[1].text, plain);
});

test("written answers and older assistant replies go together, oldest first", () => {
  const history = answerHistory([me("How do I make brownies?"), answer(brownies), me("Save it as a recipe"), assistant("Saved **Brownies** to your recipes.")]);
  assert.deepEqual(history.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(history[1].text.includes("["), false);
  assert.equal(history[3].text, "Saved **Brownies** to your recipes.");
});

test("a follow-up that got nothing back doesn't cut off the answer before it", () => {
  // The production case: the follow-up fell back to a keyword search, then was asked again.
  for (const empty of [fallback(), keyword(), assistant(null)]) {
    const history = answerHistory([me("How do I make brownies?"), answer(brownies), me("Turn this into a recipe"), empty]);
    assert.deepEqual(history.map((t) => t.text.slice(0, 8)), ["How do I", "Melt 200"]);
  }
  assert.deepEqual(answerHistory([]), []);
  assert.deepEqual(answerHistory([me("Hello?"), keyword()]), []);
});

test("twelve turns at most, the latest ones, always your words then Athena's", () => {
  const messages = Array.from({ length: 10 }, (_, i) => [me(`Question ${i + 1}`), i % 2 ? assistant(`Reply ${i + 1}`) : answer(`Answer ${i + 1} [1].`)]).flat();
  const history = answerHistory(messages);
  assert.equal(history.length, 12);
  assert.equal(history[0].text, "Question 5");
  assert.equal(history[11].text, "Reply 10");
  assert.equal(history[10].role, "user");
  assert.equal(history[1].text, "Answer 5.");
});
