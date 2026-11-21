// Run: npx tsx --test netlify/lib/team-chat-routes.test.ts
// Team chat's plain-code routing of what's typed: the "use suggestions" phrasings and "@Name". No model, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DESK, DESK_NOT_YET, mentioned, saysUseSuggestions } from "./team-chat-routes";

test("“continue and use all suggested routes” and close phrasings take the suggestions from here on", () => {
  for (const said of [
    "continue and use all suggested routes",
    "Continue, and use all the suggested routes.",
    "carry on with the suggestions",
    "Use your suggestions",
    "go with the recommended options",
    "Proceed with what’s suggested",
    "keep going and take the suggested answers from here on",
  ])
    assert.deepEqual(saysUseSuggestions(said), { fromHere: true }, said);
  assert.deepEqual(saysUseSuggestions("use the suggestions this time"), { fromHere: false });
  assert.deepEqual(saysUseSuggestions("Just this once, go with the suggested one"), { fromHere: false });
});

test("anything else isn't that: a question, a refusal, an answer that happens to say suggest, a long message", () => {
  for (const said of [
    "",
    "continue",
    "What did you suggest?",
    "don't use the suggestions",
    "Do not continue with the suggested routes",
    "stop using suggestions",
    "I suggest we rewrite the intro",
    "The second one, but keep the price table",
    `use the suggested routes ${"and also ".repeat(20)}`,
  ])
    assert.equal(saysUseSuggestions(said), null, said);
});

test("“@Name” reaches that assistant, with the name taken out of what it's asked", () => {
  const team = [{ id: "1", name: "Moss" }, { id: "2", name: "Dot" }, { id: "3", name: "Dot Matrix" }];
  assert.deepEqual(mentioned("@Moss what's the best price?", team), { assistant: team[0], text: "what's the best price?" });
  assert.deepEqual(mentioned("Can you check this, @moss?", team), { assistant: team[0], text: "Can you check this, ?" });
  assert.equal(mentioned("@Dot Matrix print it", team)?.assistant.id, "3", "the longest name wins");
  assert.equal(mentioned("@Dot, then @Moss", team)?.assistant.id, "2", "the first one named");
  assert.deepEqual(mentioned("@Moss", team), { assistant: team[0], text: "@Moss" }, "a bare name is still a message");
  assert.equal(mentioned("mail me@moss.example", team), null, "an email address isn't a mention");
  assert.equal(mentioned("@Dotty hello", team), null);
  assert.equal(mentioned("Moss, what's new?", team), null);
  assert.equal(mentioned("@Moss hi", []), null);
});

test("without the assignments side, nothing waits and nothing can be answered", async () => {
  assert.equal(await NO_DESK.waitingStage("a"), null);
  await assert.rejects(NO_DESK.answerStage("a", "x"), { message: DESK_NOT_YET });
  await assert.rejects(NO_DESK.useSuggestions("a", true), { message: DESK_NOT_YET });
});
