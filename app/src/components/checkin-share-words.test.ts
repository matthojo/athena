// The words for sharing and adding check-in questions (components/checkin-share-words.ts, add/words.ts).
// Run: npx tsx --test app/src/components/checkin-share-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromSetWords, questionWhereWords, removeSetBody, SETS_ANSWERS_WORDS, setMetaWords, setSwitchWords, shareFindingsLede, shareReachWords } from "./checkin-share-words";
import { DELETE_OWN_BODY, ownAnswersWords, OWN_ANSWERS_WORDS } from "./checkin-rules";
import { answersGoWords, checkinAddedWords, DEEPER_WORDS, offWords, reachWords, roomWords, routinesWords, startWords } from "../add/words";

test("share reach: always stays in Athena; Go deeper is named, in one line, when one of them offers it", () => {
  assert.equal(shareReachWords(false).title, "Stays in Athena");
  assert.equal(shareReachWords(false).icon, "shield");
  assert.doesNotMatch(shareReachWords(false).detail, /Go deeper/);
  assert.equal(shareReachWords(true).title, "Stays in Athena");
  assert.equal(shareReachWords(true).icon, "shield");
  assert.equal(shareReachWords(true).detail.replace(shareReachWords(false).detail, "").trim(), "Go deeper reaches their AI model only when they tap it.");
});

test("where a finding is", () => {
  assert.equal(questionWhereWords(["question:2"]), "In question 2");
  assert.equal(questionWhereWords(["question:3", "question:1", "summary"]), "In questions 1 and 3, and the summary");
  assert.equal(questionWhereWords(["name"]), "In the name");
  assert.match(shareFindingsLede(0), /Nothing is flagged/);
  assert.match(shareFindingsLede(2), /These look like some/);
});

test("a set in Settings", () => {
  assert.equal(setMetaWords({ catalogue_id: "j6k1m5n9p3q8r2s7", author: "quiet-desk" }, 4), "4 questions · From Community · By @quiet-desk");
  assert.equal(setMetaWords({ catalogue_id: null, author: null }, 0), "No questions left · From a file");
  assert.match(setSwitchWords(true), /wait/);
  assert.equal(fromSetWords("Small joys", true), "From Small joys, switched off");
});

test("the Add screen: reach in the same plain words, grouped routines, a routine left off", () => {
  const tier1 = reachWords({ tier: 1, model: false, web: false, lookups: [], needs: [] }, "checkin");
  assert.equal(tier1.title, "Stays in Athena");
  assert.deepEqual(tier1.lines, ["Its questions stay in your Athena, and so do your answers"]);
  // The Go deeper line the preview shows for a set with such a question (f9a7fda's words).
  assert.equal(DEEPER_WORDS, "Like your own questions, any that offer Go deeper send the question and what you wrote to the AI model you chose, but only when you tap it.");
  assert.equal(routinesWords(["morning", "evening"]), "Morning and evening");
  assert.equal(offWords([]), null);
  assert.equal(offWords(["evening"]), "Your evening reflection is switched off. Adding these won't switch it on: it stays off until you do, in Settings.");
  assert.match(offWords(["morning", "evening"])!, /are switched off.*switch them on: they stay off/);
});

test("the Add screen: what joined, what was skipped, and a routine that stays off", () => {
  const w = checkinAddedWords("Small joys", { added: 3, skipped: ["What went well today?"], off: ["evening"] }, ["evening"]);
  assert.equal(w.title, "Small joys joined your check-ins");
  assert.equal(w.body, "3 questions joined your evening reflection, after the ones you have. You already had “What went well today?”, so it was left out. Your evening reflection is switched off. Adding these won't switch it on: it stays off until you do, in Settings.");
  assert.match(checkinAddedWords("Small joys", { added: 0, skipped: ["a", "b"], off: [] }, []).title, /already have every question/);
});

test("the Add screen: no room past 40, and a set added switched off", () => {
  assert.equal(roomWords(3, 5), null);
  assert.equal(roomWords(3, 1), "There's room for one more question of your own, so the first one is added and the other 2 are left out.");
  assert.match(roomWords(3, 0)!, /none of these can be added/);
  const some = checkinAddedWords("Small joys", { added: 1, skipped: [], off: [], full: ["Who did you feel close to today?", "How kind were you to yourself?"] }, ["evening"]);
  assert.match(some.body, /There wasn't room for the other 2: you have 40 questions of your own/);
  assert.match(checkinAddedWords("Small joys", { added: 0, skipped: [], off: [], full: ["x"] }, []).title, /There wasn't room/);
  const off = checkinAddedWords("Small joys", { added: 2, skipped: [], off: ["evening"], full: [] }, ["evening"], false);
  assert.match(off.body, /The set is switched off/);
  // The routine being off is still said: the choice never switches a routine on.
  assert.match(off.body, /evening reflection is switched off. Adding these won't switch it on/);
});

test("the Add screen: where answers go, from the kinds of answer in the set", () => {
  const mixed = answersGoWords(["text", "scale", "choices"]);
  assert.match(mixed[0], /^Written answers go into that day's journal, like your other written answers/);
  assert.match(mixed[0], /Change or undo one and the journal follows/);
  assert.equal(mixed[1], "Your other answers stay in your check-ins.");
  assert.ok(mixed.some((l) => /Athena decides where answers go, whatever the file says/.test(l)));
  assert.ok(mixed.some((l) => /never set your mood or go to Health/.test(l)));
  // Only written: no line about other answers. None written: nothing about the journal.
  assert.ok(!answersGoWords(["text"]).includes("Your other answers stay in your check-ins."));
  const none = answersGoWords(["scale", "areas"]);
  assert.equal(none[0], "Your answers stay in your check-ins.");
  assert.ok(!none.some((l) => /journal/.test(l)));
});

test("the Add screen: two ways to start, each with its consequence; a routine that's off is still named", () => {
  const w = startWords([], ["evening"]);
  assert.equal(w.on.label, "Start asking them");
  assert.equal(w.on.line, "They take turns with your other questions from your next check-in.");
  assert.equal(w.off.label, "Add them switched off");
  assert.equal(w.off.line, "They wait in Settings until you switch the set on.");
  // The routine they join is off: starting them still waits for it, and says so.
  assert.equal(startWords(["evening"], ["evening"]).on.line, "They take turns with your other questions once you switch your evening reflection on.");
  assert.match(startWords(["morning", "evening"], ["morning", "evening"]).on.line, /morning preparation and evening reflection on/);
  // Done, either way: the routine's off note is there.
  for (const started of [true, false]) assert.match(checkinAddedWords("Small joys", { added: 2, skipped: [], off: ["evening"], full: [] }, ["evening"], started).body, /stays off until you do/);
});

test("Settings: what sets' answers do in the journal, and that removing one leaves it", () => {
  assert.match(SETS_ANSWERS_WORDS, /Written answers to these questions go into that day's journal, like all your written answers/);
  assert.match(SETS_ANSWERS_WORDS, /Removing a set doesn't change anything already in your journal/);
  assert.match(removeSetBody, /anything already copied into your journal/);
});

test("Settings and writing a question: written answers to your own go to the journal; the rest stay", () => {
  assert.match(OWN_ANSWERS_WORDS, /^Written answers to your questions go into that day's journal/);
  assert.match(OWN_ANSWERS_WORDS, /The rest stay in your check-ins/);
  assert.match(ownAnswersWords("text"), /goes into that day's journal/);
  assert.match(ownAnswersWords("text"), /Change or undo it and the journal follows/);
  for (const t of ["scale", "choices", "areas"] as const) assert.equal(ownAnswersWords(t), "Answers stay in your check-ins. Only written answers go into your journal.");
  assert.match(DELETE_OWN_BODY, /anything already copied into your journal/);
});
