// Run: npx tsx --test lib/ask-stream.test.ts
// Ask's reply text read from a growing stream, and the follow-up chips that come with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerTextSoFar, cleanFollowups, splitNext, textDelta, visibleDraft } from "./ask-stream";

test("the answer's text is read from partial JSON as it grows", () => {
  const whole = JSON.stringify({ text: 'Elena said "£40 a seat" [1].\nThen she left.', found: true, sources: [{ ref: "note:1", title: "text", date: "" }], next: [] });
  let last = "";
  for (let i = 1; i <= whole.length; i++) {
    const now = answerTextSoFar(whole.slice(0, i));
    assert.ok(now.startsWith(last), `shrank at ${i}: ${JSON.stringify(last)} → ${JSON.stringify(now)}`);
    last = now;
  }
  assert.equal(last, 'Elena said "£40 a seat" [1].\nThen she left.');
});

test("a cut-off escape waits for the next piece", () => {
  assert.equal(answerTextSoFar('{"text":"a\\'), "a");
  assert.equal(answerTextSoFar('{"text":"a\\u00'), "a");
  assert.equal(answerTextSoFar('{"text":"a\\u00e9'), "aé");
});

test("only the top-level text counts, whatever order the fields come in", () => {
  assert.equal(answerTextSoFar('{"found":true,"sources":[{"ref":"x","text":"nope"}],"text":"yes'), "yes");
  assert.equal(answerTextSoFar('{"found":true'), "");
  assert.equal(answerTextSoFar(""), "");
});

test("deltas send only what's new, and start again if the text changed underneath", () => {
  assert.deepEqual(textDelta("", "Hi"), [{ delta: "Hi" }]);
  assert.deepEqual(textDelta("Hi", "Hi there"), [{ delta: " there" }]);
  assert.deepEqual(textDelta("Hi", "Hi"), []);
  assert.deepEqual(textDelta("Hello", "Help"), [{ reset: true }, { delta: "Help" }]);
});

test("the <next> block is never shown while the reply is written", () => {
  assert.equal(visibleDraft("Added it."), "Added it.");
  assert.equal(visibleDraft("Added it.\n<"), "Added it.");
  assert.equal(visibleDraft("Added it.\n<ne"), "Added it.");
  assert.equal(visibleDraft("Added it.\n<next>Remind me"), "Added it.");
  // A "<" that can't start the block stays.
  assert.equal(visibleDraft("2 < 3"), "2 < 3");
});

test("splitNext takes the follow-ups off the reply", () => {
  assert.deepEqual(splitNext("Added the Lego Ferrari.\n<next>Remind me on Friday | What else is on the list?</next>"), {
    text: "Added the Lego Ferrari.",
    next: ["Remind me on Friday", "What else is on the list?"],
  });
  // Cut off before it closed, or on separate lines.
  assert.deepEqual(splitNext("Done.\n<next>Show the list\nAdd another"), { text: "Done.", next: ["Show the list", "Add another"] });
  assert.deepEqual(splitNext("No follow-ups here."), { text: "No follow-ups here.", next: [] });
});

test("follow-ups are short, distinct and plain, three at most", () => {
  assert.deepEqual(
    cleanFollowups(["- what did Priya say? [2]", "What did Priya say", "“Remind me on Friday”", "x", "A".repeat(80), 3, "Open the note", "Who else was there?"]),
    ["What did Priya say?", "Remind me on Friday", "Open the note"],
  );
  assert.deepEqual(cleanFollowups("not a list"), []);
  // The question just asked isn't offered again.
  assert.deepEqual(cleanFollowups(["What did Elena say about pricing?", "When is the renewal?"], { not: "what did Elena say about pricing" }), ["When is the renewal?"]);
});
