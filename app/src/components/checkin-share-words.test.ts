// The words for sharing and adding check-in questions (components/checkin-share-words.ts, add/words.ts).
// Run: npx tsx --test app/src/components/checkin-share-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromSetWords, questionWhereWords, setMetaWords, setSwitchWords, shareFindingsLede, shareReachWords } from "./checkin-share-words";
import { checkinAddedWords, offWords, reachWords, roomWords, routinesWords } from "../add/words";

test("share reach: always stays in Athena; Go deeper is named when one of them offers it", () => {
  assert.equal(shareReachWords(false).title, "Stays in Athena");
  assert.equal(shareReachWords(false).icon, "shield");
  assert.doesNotMatch(shareReachWords(false).detail, /Go deeper/);
  assert.equal(shareReachWords(true).title, "Stays in Athena");
  assert.match(shareReachWords(true).detail, /only when they tap it/);
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
  assert.match(tier1.lines[0], /stay in your Athena/);
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
  assert.doesNotMatch(off.body, /evening reflection is switched off/);
});
