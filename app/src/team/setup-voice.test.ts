// Setup's lines in the new assistant's voice. Run: npx tsx --test app/src/team/setup-voice.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyThere, firstGo, firstPerson, inVoice, nextRun, promiseLine, startsLine, voice } from "./setup-voice";
import type { TeamTriggerInput } from "../../../lib/team-types";

const gift: TeamTriggerInput = { kind: "event", event: { source: "saved", savedAction: "gift-idea" } };
const friday: TeamTriggerInput = { kind: "schedule", days: [5], time: "17:00" };

test("a job turns round into the first person", () => {
  assert.equal(firstPerson("Finds good prices for gift ideas"), "find good prices for gift ideas");
  assert.equal(firstPerson("Sums up your week"), "sum up your week");
  assert.equal(firstPerson("Carries over late to-dos"), "carry over late to-dos");
  assert.equal(firstPerson("Watches Linear for new issues"), "watch Linear for new issues");
  assert.equal(firstPerson("Does the weekly review"), "do the weekly review");
  assert.equal(firstPerson("Gift price watcher"), null);
  assert.equal(firstPerson("Address book tidy"), null);
});

test("the promise says when, then what, in one sentence", () => {
  assert.equal(promiseLine("Finds a good price", [gift]), "When you save a gift idea, I'll find a good price.");
  assert.equal(promiseLine("Sums up your week", [friday], false), "Every Friday at 17:00, I'll sum up your week.");
  assert.equal(promiseLine("Sums up your week", []), "I'll sum up your week whenever you ask.");
  assert.equal(promiseLine("Sums up your week", [friday, gift]), "I'll sum up your week.");
  assert.equal(promiseLine("Gift price watcher", [gift]), "My job: gift price watcher.");
});

test("next run reads as a day and a time", () => {
  const wed = new Date(2026, 10, 18, 10, 0); // Wednesday 18 Nov 2026, 10:00
  assert.equal(nextRun([friday], wed, false), "Friday at 17:00");
  assert.equal(nextRun([{ kind: "schedule", days: [3], time: "17:00" }], wed, false), "today at 17:00");
  assert.equal(nextRun([{ kind: "schedule", days: [4], time: "09:00" }], wed, false), "tomorrow at 9:00");
  assert.equal(nextRun([{ kind: "schedule", days: [3], time: "09:00" }], wed, false), "Wednesday at 9:00", "a week on when today's slot has passed");
  assert.equal(nextRun([{ kind: "schedule", days: [1, 2, 3, 4, 5], time: "08:00" }, friday], wed, false), "tomorrow at 8:00", "the soonest of several");
  assert.equal(nextRun([gift], wed), null);
  assert.equal(startsLine([gift], wed), "Starts when you save a gift idea");
  assert.equal(startsLine([friday], wed, false), "First run Friday at 17:00");
  assert.equal(startsLine([], wed), "Starts when you ask");
});

test("every tone has a line for every moment, with no stray AI phrasing", () => {
  for (const tone of ["warm", "crisp", "playful", "calm", "wry"] as const) {
    const p = { tone, traits: [], pronoun: "they" as const, greeting: "" };
    const lines = [voice.intro(p, "Penny"), voice.ask(p, 3), voice.thanks(p), voice.skipped(p), voice.firstDay(p)];
    for (const l of lines) {
      assert.ok(l.length > 0 && l.length <= 60, `${tone}: "${l}"`);
      assert.doesNotMatch(l, /—|delve|seamless|journey|excited to|agent|teammate/i);
    }
    assert.match(voice.intro(p, "Penny"), /Penny/);
  }
  assert.equal(voice.ask({ tone: "crisp", traits: [], pronoun: "she", greeting: "" }, 1), "One quick question.");
  assert.equal(voice.intro(null, "Dot"), "Hi, I'm Dot. Happy to help with this.");
});

test("its questions are asked in the first person where they're about it", () => {
  assert.equal(inVoice("Should it copy due dates?"), "Should I copy due dates?");
  assert.equal(inVoice("How should it tell you what it did?"), "How should I tell you what I did?");
  assert.equal(inVoice("How much should it do alone?"), "How much should I do alone?");
  assert.equal(inVoice("When should it tell you about a price?"), "When should I tell you about a price?");
  assert.equal(inVoice("Does it need to ask first?"), "Do I need to ask first?");
  assert.equal(inVoice("Which issues count?"), "Which issues count?");
  assert.equal(inVoice("Where should the summary go?"), "Where should the summary go?");
  assert.equal(inVoice("Is it worth a note?"), "Is it worth a note?");
});

test("a question already in the first person isn't turned round again", () => {
  assert.equal(inVoice("Should I copy due dates?"), "Should I copy due dates?");
  assert.equal(inVoice("When I find a deal, should it go on your list?"), "When I find a deal, should it go on your list?");
  assert.equal(inVoice("What should I call it when it's done?"), "What should I call it when it's done?");
  assert.equal(inVoice("Should it tell me first?"), "Should it tell me first?");
  for (const q of ["Should it copy due dates?", "How should it tell you what it did?", "Does it need to ask first?"]) {
    assert.equal(inVoice(inVoice(q)), inVoice(q), q);
  }
});

test("the first day runs a scheduled assistant and checks for a waiting one", () => {
  assert.equal(firstGo([friday]), "run");
  assert.equal(firstGo([gift]), "check");
  assert.equal(firstGo([friday, gift]), "run", "both kinds: it runs");
  assert.equal(firstGo([]), "run");
  assert.equal(firstGo([{ ...friday, paused: true }, gift]), "check", "a paused schedule doesn't count");
  assert.equal(alreadyThere([gift]), "the gift ideas you've already saved");
  assert.equal(alreadyThere([{ kind: "event", event: { source: "collected", connector: "linear" } }]), "the issues already assigned to you");
  assert.equal(alreadyThere([{ kind: "event", event: { source: "note", tag: "#read" } }]), "the notes you've already tagged #read");
  assert.equal(alreadyThere([]), "what's already there");
});
