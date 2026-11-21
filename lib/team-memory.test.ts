// Team memory (lib/team-memory.ts): the caps (a 2,000-character summary, 30 facts of one line each,
// no repeats), what the model is sent, and the per-thread debounce.
// Run: npx tsx --test lib/team-memory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitMemory, flushMemory, memoryRequest, noteTurn, pendingTurns, toYou } from "./team-memory";
import { MAX_MEMORY_FACTS, MAX_MEMORY_SUMMARY } from "./team-types";

test("memory keeps to its caps", () => {
  const facts = Array.from({ length: 45 }, (_, i) => `Fact ${i}`);
  const m = fitMemory({ summary: "A sentence. ".repeat(400), facts });
  assert.ok(m.summary.length <= MAX_MEMORY_SUMMARY, String(m.summary.length));
  assert.ok(m.summary.endsWith("."), "cut at a sentence");
  assert.equal(m.facts.length, MAX_MEMORY_FACTS);
  assert.equal(m.facts[0], "Fact 15", "the newest kept");
  assert.equal(m.facts.at(-1), "Fact 44");
});

test("facts are one line each, without repeats or bullets", () => {
  const m = fitMemory({ summary: "  ", facts: ["- Budget is £40", "budget is £40", "Prefers\nEtsy", "", 7 as unknown as string, "x".repeat(500)] });
  assert.equal(m.summary, "");
  assert.deepEqual(m.facts.slice(0, 2), ["Budget is £40", "Prefers Etsy"]);
  assert.equal(m.facts[2].length, 200);
  assert.equal(m.facts.length, 3);
  assert.deepEqual(fitMemory(null), { summary: "", facts: [] });
});

test("the request holds the job, the old memory and the turns, cut to size", () => {
  const r = memoryRequest({ name: "Penny", job: "Finds good prices" }, { summary: "Old summary", facts: ["Old fact"] }, [{ asked: "Find the scarf", said: "y".repeat(5000) }]);
  assert.match(r, /Its job: Finds good prices/);
  assert.match(r, /Old summary\n- Old fact/);
  assert.match(r, /They said: Find the scarf\nPenny: y+…/);
  assert.doesNotMatch(r, /Owner/, "the model is never shown \"Owner\" to copy");
  assert.ok(r.length < 4000);
});

test("turns wait per thread and flush together", async () => {
  const saved = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  try {
    noteTurn("a1", "t1", { asked: "one", said: "1" });
    noteTurn("a1", "t1", { asked: "two", said: "2" });
    noteTurn("a1", "t2", { asked: "three", said: "3" });
    assert.equal(pendingTurns(), 3);
    await flushMemory("a1:t1");
    assert.equal(pendingTurns(), 1);
    await flushMemory();
    assert.equal(pendingTurns(), 0);
  } finally {
    process.env = saved;
  }
});

test("memory is said to you, never about the owner: older lines are reworded at the next refresh", () => {
  assert.equal(toYou("Owner prefers independent shops"), "You prefer independent shops");
  assert.equal(toYou("The owner's budget is £40 a gift"), "Your budget is £40 a gift");
  assert.equal(toYou("Owner bought from Smyths last Christmas"), "You bought from Smyths last Christmas");
  assert.equal(toYou("Owner watches F1, and the owner is busy on Fridays"), "You watch F1, and you are busy on Fridays");
  assert.equal(toYou("The owner doesn't want Amazon"), "You don't want Amazon");
  assert.equal(toYou("I remind the owner on Mondays"), "I remind you on Mondays");
  // Someone else's "owner" stays theirs.
  assert.equal(toYou("Priya is the owner of the Q3 review"), "Priya is the owner of the Q3 review");
  assert.equal(toYou("Priya owns the Q3 review"), "Priya owns the Q3 review");
  const m = fitMemory({ summary: "I check gift prices for the owner. The owner's budget is £40.", facts: ["Owner prefers Etsy", "Owner saved a Lego set on 15 Nov", "You prefer Etsy"] });
  assert.equal(m.summary, "I check gift prices for you. Your budget is £40.");
  assert.deepEqual(m.facts, ["You prefer Etsy"], "reworded, a run's log dropped, and the repeat it made folded in");
});
