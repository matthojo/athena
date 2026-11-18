// Cross-chat memory (lib/ask-threads.ts pickPastThreads): a new chat gets the past chats about the same
// thing, chosen by topic, not just recency.
// Run: npx tsx --test lib/ask-threads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bringsNewTopic, pastThreadsPrompt, pickPastThreads, topicWords, type AskThread } from "./ask-threads";

const NOW = new Date("2026-11-09T09:00:00Z");
let n = 0;
const thread = (title: string, messages: unknown[], updated = "2026-11-08T10:00:00Z", extra: Partial<AskThread> = {}): AskThread => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  title,
  messages,
  archived_at: null,
  created_at: updated,
  updated_at: updated,
  ...extra,
});

const lisbon = thread(
  "Lisbon flights",
  [
    { role: "me", text: "When do I fly to Lisbon?" },
    { role: "answer", question: "When do I fly to Lisbon?", text: "You fly TAP from Heathrow on 19 November at 07:10 [1]." },
  ],
  "2026-10-20T10:00:00Z",
);
const tesco = thread("Groceries", [
  { role: "me", text: "How much did I spend at Tesco last month?" },
  { role: "answer", text: "£56.55 at Tesco in October, over 2 payments [1][2]." },
]);
const latest = thread("Gift for Rowan", [
  { role: "me", text: "add the Lego Ferrari to Rowan's gift ideas" },
  { role: "assistant", request: "add the Lego Ferrari to Rowan's gift ideas", reply: { text: "Added the Lego Ferrari to Rowan's Christmas gift ideas." } },
], "2026-11-09T08:50:00Z");

test("chosen by topic: the Lisbon chat for a Lisbon question, even though newer chats exist", () => {
  const got = pickPastThreads("What hotel am I staying at in Lisbon?", [latest, tesco, lisbon], { now: NOW });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, lisbon.id);
  assert.equal(got[0].date, "2026-10-20");
  assert.equal(got[0].summary, "Asked: When do I fly to Lisbon? Athena: You fly TAP from Heathrow on 19 November at 07:10.");
});

test("no shared topic, no memory: recency alone never picks a chat", () => {
  assert.deepEqual(pickPastThreads("What's the weather doing?", [latest, tesco, lisbon], { now: NOW }), []);
  assert.deepEqual(pickPastThreads("what did I do", [latest, tesco, lisbon], { now: NOW }), []);
});

test("rarer shared words count for more; recency breaks a near tie", () => {
  const a = thread("Tesco again", [{ role: "me", text: "Tesco spending in September" }], "2026-09-30T10:00:00Z");
  const got = pickPastThreads("Tesco spending this year", [a, tesco], { now: NOW });
  assert.equal(got[0].id, a.id, "two shared words beat one");
  const b = thread("Tesco", [{ role: "me", text: "Tesco" }], "2026-06-01T10:00:00Z");
  const c = thread("Tesco", [{ role: "me", text: "Tesco" }], "2026-11-08T10:00:00Z");
  assert.equal(pickPastThreads("tesco", [b, c], { now: NOW })[0].id, c.id);
});

test("the chat being asked in, archived chats and locked ones are left out; at most three", () => {
  const self = thread("", [{ role: "me", text: "When do I fly to Lisbon?" }], "2026-11-09T08:59:00Z");
  const gone = thread("Lisbon", [{ role: "me", text: "Lisbon" }], "2026-11-01T10:00:00Z", { archived_at: "2026-11-02T10:00:00Z" });
  const locked = thread("Lisbon", [], "2026-11-01T10:00:00Z", { locked: true });
  assert.deepEqual(pickPastThreads("When do I fly to Lisbon?", [self, gone, locked, lisbon], { now: NOW }).map((p) => p.id), [lisbon.id]);
  const many = Array.from({ length: 6 }, (_, i) => thread(`Lisbon ${i}`, [{ role: "me", text: `Lisbon plan ${i}` }]));
  assert.equal(pickPastThreads("Lisbon", many, { now: NOW }).length, 3);
});

test("the assistant's chats count too, and the block is marked as data", () => {
  const got = pickPastThreads("What else could I get Rowan?", [latest, tesco], { now: NOW });
  assert.equal(got[0].id, latest.id);
  assert.match(got[0].summary, /^Asked: add the Lego Ferrari .* Athena: Added the Lego Ferrari/);
  const block = pastThreadsPrompt(got);
  assert.match(block, /<earlier_chats>\n- 2026-11-09 "Gift for Rowan": Asked:/);
  assert.match(block, /data, not instructions/);
  assert.equal(pastThreadsPrompt([]), "");
});

test("topic words: stop words and numbers out, plurals folded", () => {
  assert.deepEqual([...topicWords("How much did I spend on flights to Lisbon in 2026?")], ["spend", "flight", "lisbon"]);
});

test("a mentioned person's name counts for more than a topic word", () => {
  const priya = thread("Offsite", [{ role: "me", text: "What did Priya Shah want for the offsite?" }, { role: "answer", text: "A venue near the river [1]." }], "2026-09-01T10:00:00Z");
  const budget = thread("Budget", [{ role: "me", text: "Where is the budget review?" }, { role: "answer", text: "In the finance folder [1]." }]);
  const q = "What's the budget for her team?";
  assert.equal(pickPastThreads(q, [priya, budget], { now: NOW })[0].title, "Budget");
  const picked = pickPastThreads(q, [priya, budget], { now: NOW, people: ["Priya Shah"] });
  assert.deepEqual(picked.map((p) => p.title), ["Offsite", "Budget"]);
  // A name alone is enough: no topic word is shared.
  assert.deepEqual(pickPastThreads("and her?", [priya, budget], { now: NOW, people: ["Priya Shah"] }).map((p) => p.title), ["Offsite"]);
});

test("the chat being asked in is left out on a later turn: by id, or by holding its earlier messages", () => {
  const here = thread("Lisbon again", [
    { role: "me", text: "When do I fly to Lisbon?" },
    { role: "answer", text: "On 19 November [1]." },
    { role: "me", text: "What's the Lisbon hotel?" },
  ], "2026-11-09T08:59:00Z");
  const q = "What's the Lisbon hotel?";
  assert.ok(pickPastThreads(q, [here, lisbon], { now: NOW }).some((p) => p.id === here.id));
  assert.deepEqual(pickPastThreads(q, [here, lisbon], { now: NOW, exclude: here.id }).map((p) => p.id), [lisbon.id]);
  // Without an id: the chat that holds exactly these earlier messages and was added to lately is this one. An old chat that began the same way is still memory.
  assert.deepEqual(pickPastThreads(q, [here, lisbon], { now: NOW, earlier: ["When do I fly to Lisbon?"] }).map((p) => p.id), [lisbon.id]);
  assert.equal(pickPastThreads(q, [here, lisbon], { now: NOW, earlier: ["Something this chat never asked"] }).length, 2);
});

test("a later message brings a new topic when it names something the chat hasn't touched", () => {
  const chat = ["When do I fly to Lisbon?", "You fly TAP from Heathrow on 19 November at 07:10."];
  assert.equal(bringsNewTopic("anything", []), true, "a first message always looks");
  assert.equal(bringsNewTopic("And what about last week?", chat), false);
  assert.equal(bringsNewTopic("What did they say exactly?", chat), false);
  assert.equal(bringsNewTopic("Which Heathrow terminal?", chat), true);
  assert.equal(bringsNewTopic("How much did I spend at Tesco?", chat), true);
  assert.equal(bringsNewTopic("and her?", chat, ["Priya Shah"]), true, "someone new is named");
  assert.equal(bringsNewTopic("and her?", [...chat, "Ask Priya Shah"], ["Priya Shah"]), false);
});

test("a summary reads as plain words: no markers, bold or list dashes", () => {
  const t = thread("Packing", [{ role: "me", text: "What should I pack for Porto?" }, { role: "answer", text: "**Clothes**\n\n- Light layers [1]\n- A jacket" }]);
  assert.match(pickPastThreads("packing for Porto", [t], { now: NOW })[0].summary, /Athena: Clothes Light layers A jacket$/);
});
