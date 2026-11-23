import { test } from "node:test";
import assert from "node:assert/strict";
import { dueLine, waitingParts, waitingSentence } from "./waiting-words";

test("dueLine says what's due in words, and nothing when nothing is", () => {
  assert.equal(dueLine(1, 1), "One overdue, one due today.");
  assert.equal(dueLine(0, 2), "Two due today.");
  assert.equal(dueLine(3, 0), "Three overdue.");
  assert.equal(dueLine(0, 0), "");
});

test("waitingParts has one phrase per place, and none when nothing waits", () => {
  assert.deepEqual(waitingParts({ team: 0, inbox: 0, overdue: 0, dueToday: 0 }), []);
  const parts = waitingParts({ team: 4, inbox: 7, overdue: 1, dueToday: 1 }, "#/team/chat/p1");
  assert.deepEqual(
    parts.map((p) => [p.key, p.text, p.href]),
    [
      ["team", "4 from your team", "#/team/chat/p1"],
      ["inbox", "7 in your inbox", "#/review"],
      ["todo", "1 overdue, 1 due today", "#/loops"],
    ]
  );
  assert.equal(parts[2].tone, "late");
  assert.equal(waitingSentence(parts), "Waiting for you: 4 from your team, 7 in your inbox, 1 overdue, 1 due today.");
});

test("to-dos due today alone aren't late", () => {
  const [todo] = waitingParts({ team: 0, inbox: 0, overdue: 0, dueToday: 2 });
  assert.equal(todo.text, "2 due today");
  assert.equal(todo.tone, undefined);
});
