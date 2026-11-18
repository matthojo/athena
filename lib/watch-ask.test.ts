import assert from "node:assert/strict";
import { test } from "node:test";
import { asksWhatToWatch } from "./watch-ask";

test("the ways people ask for something to watch all count", () => {
  for (const q of [
    "Something to watch tonight",
    "What's something we can watch tonight?",
    "What’s something we can watch tonight?",
    "anything good to watch tonight?",
    "what to watch tonight",
    "What should we watch?",
    "what can I watch this evening",
    "Suggest something to watch with the kids",
    "recommend something to watch later",
    "pick a film for tonight",
    "What film should we watch tonight?",
    "any ideas for film night?",
    "Give us something to watch for date night",
  ])
    assert.equal(asksWhatToWatch(q), true, q);
});

test("the past, a named title, and other questions don't", () => {
  for (const q of [
    "What did we watch last night?",
    "what have I watched this month",
    "Where can I watch Dune?",
    "What can I watch Severance on?",
    "Should I watch Slow Horses or The Bear first, given what Priya said about both of them last week at dinner?",
    "Remind me to watch the match tonight",
    "watch",
    "What's on my calendar tonight?",
    "Is the washing done?",
    "",
  ])
    assert.equal(asksWhatToWatch(q), false, q);
});
