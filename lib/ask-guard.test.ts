// What one Ask turn may change, given what it has read (lib/ask-guard.ts). Pure: no model, no database.
// Run: npx tsx --test lib/ask-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnGuard, askedFor, isCollected, isWriteTool, plainlyAsked } from "./ask-guard";
import { TOOLS } from "./assistant";
import { READ_TOOL_NAMES } from "./ask-tools";
import { stepActs } from "./steps";

/** What the words ask for, leaving out "send": it only ever prepares a card the owner taps. */
const asked = (text: string) => [...askedFor(text)].filter((k) => k !== "send").sort().join(",");

test("an instruction is read from where it starts: the message's first words, or a new clause", () => {
  assert.equal(asked("Add a to-do to follow up with Gayle"), "add");
  assert.equal(asked("What did Gayle say about pricing, and add a to-do to follow up"), "add");
  assert.equal(asked("What did Gayle say about pricing? Then remind me to reply on Friday."), "add");
  assert.equal(asked("Can you archive the Lisbon trip?"), "remove");
  assert.equal(asked("please rename it to Q3 plan"), "change");
  assert.equal(asked("Yes, add Rowan as a new person"), "add");
  assert.equal(asked("Set a reminder for 6pm"), "add,change");
  assert.equal(asked("I finished The Bear"), "add,change");
  assert.equal(asked("Priya's moving to Lisbon"), "add,change");
  assert.equal(asked("Every Friday at 4pm, tell me what slipped"), "add");
  assert.equal(asked("Lunch with Priya Thursday at 1"), "add");
});

test("a question is not an instruction, whatever verbs it holds", () => {
  for (const q of [
    "What did Gayle say about pricing?",
    "What should I add to my packing list?",
    "Which notes did I archive last week?",
    "How do I change a tyre?",
    "Did Sam send the deck?",
    "Who do I need to remind about the venue?",
    "When did I book the flights to Lisbon?",
    "Yes",
    "The second one",
  ])
    assert.equal(asked(q), "", q);
});

test("a change is plainly asked for only when the owner's words name its kind", () => {
  const add = askedFor("What did Gayle say, and add a to-do to follow up");
  assert.equal(plainlyAsked(add, "add_todo"), true);
  assert.equal(plainlyAsked(add, "add_reminder"), true);
  assert.equal(plainlyAsked(add, "archive_or_restore"), false);
  assert.equal(plainlyAsked(add, "update_people"), false);
  assert.equal(plainlyAsked(add, "move_event"), false);
  assert.equal(plainlyAsked(askedFor("Archive the old plan"), "archive_or_restore"), true);
  // A tool nobody listed is never plainly asked for: it waits for Go.
  assert.equal(plainlyAsked(new Set(["add", "change", "remove", "link", "send"] as const), "a_new_tool"), false);
});

test("every tool that can change something is one the guard knows", () => {
  // The Session's tools that aren't a plain lookup: each must be listed as a write tool, or a flag wouldn't take it away.
  const looksOnly = new Set(["find_times", "find_recipes", "find_saved", "ask_owner"]);
  const acts = TOOLS.filter((t) => stepActs(t.name) && !READ_TOOL_NAMES.has(t.name) && !looksOnly.has(t.name)).map((t) => t.name);
  assert.deepEqual(acts.filter((name) => !isWriteTool(name)), [], "list each new write tool in TOOL_ASKS (lib/ask-guard.ts)");
  assert.equal(isWriteTool("attach_file"), true);
  for (const looks of ["find_people", "find_notes", "find_todos", "find_times", "find_recipes", "find_saved", "ask_owner", "goals", "weather", "work", "search_athena", "read_note", "answer", "web_search", "gmail__search_threads"]) assert.equal(isWriteTool(looks), false, looks);
});

test("before anything of other people's is read, a change needs no Go", () => {
  const g = new TurnGuard("What's on my list?");
  assert.equal(g.mustWait("add_todo"), null);
  assert.equal(g.why(["a"]), null);
});

test("after an account, a page or a file is read, a change the owner didn't ask for waits for Go", () => {
  for (const from of ["account", "web", "file"] as const) {
    const g = new TurnGuard("What did Gayle say about pricing?");
    g.sawOthers(from);
    assert.equal(g.mustWait("add_todo"), "read", from);
    g.hold("a", "read");
    assert.equal(g.why(["a"]), "read");
    assert.equal(g.allows("add_todo"), true, "still offered: it can be planned");
  }
  const g = new TurnGuard("What did Gayle say about pricing, and add a to-do to follow up");
  g.sawOthers("account");
  assert.equal(g.mustWait("add_todo"), null, "the owner's own words asked for it");
  assert.equal(g.mustWait("archive_or_restore"), "read", "but not for this");
});

test("a flag takes the write tools away for the rest of the turn, and holds what was queued", () => {
  let flagged = false;
  const g = new TurnGuard("Add a to-do to call Sam", () => flagged);
  assert.equal(g.allows("add_todo"), true);
  flagged = true;
  assert.equal(g.allows("add_todo"), false);
  assert.equal(g.allows("draft_email"), false);
  assert.equal(g.allows("create_event"), false);
  assert.equal(g.allows("find_people"), true);
  assert.equal(g.allows("search_athena"), true);
  assert.equal(g.mustWait("add_todo"), "flagged");
  assert.equal(g.why(["queued-before-the-flag"]), "flagged");
  // Once raised it stays raised.
  flagged = false;
  assert.equal(g.allows("add_todo"), false);
});

test("a collected note is other people's words; the owner's own notes aren't", () => {
  for (const source of ["manual", "app"]) assert.equal(isCollected(source), false, source);
  // Anything else was collected or written by something other than the owner's own hand, and so is a note that doesn't say.
  for (const source of ["email-digest", "email-digest-personal", "calendar-meetings", "work-activity", "finance", "assistant", "shortcut", "extension", "", null, undefined]) assert.equal(isCollected(source), true, String(source));
  const g = new TurnGuard("What did Kirsty say about the venue deposit?");
  assert.equal(g.mustWait("add_todo"), null, "nothing read yet");
  g.sawOthers("collected");
  assert.equal(g.mustWait("add_todo"), "read", "like a live account result");
  const asked = new TurnGuard("Add a to-do to pay the venue deposit");
  asked.sawOthers("collected");
  assert.equal(asked.mustWait("add_todo"), null, "the owner's own words asked for it");
});

// A Team assistant's unattended run: no message from the owner, and its allowlist is their standing request.
test("a run: an allowlisted change runs alone after a collected note was read", () => {
  const g = new TurnGuard("", () => false, ["add_todo"]);
  g.sawOthers("collected");
  assert.equal(g.allows("add_todo"), true);
  assert.equal(g.mustWait("add_todo"), null, "on the allowlist: the owner asked ahead of time");
  // Started by, or reading, anything else of other people's changes nothing either.
  for (const from of ["account", "web", "file"] as const) g.sawOthers(from);
  assert.equal(g.mustWait("add_todo"), null);
});

test("a run: a change that isn't on the allowlist waits for Go", () => {
  const g = new TurnGuard("", () => false, ["add_todo"]);
  g.sawOthers("collected");
  assert.equal(g.mustWait("save_note"), "read");
  assert.equal(g.mustWait("archive_or_restore"), "read");
  g.hold("a", "read");
  assert.equal(g.why(["a"]), "read");
  // A chat has no standing request: the allowlist isn't given to the guard, and the owner's message decides.
  const chat = new TurnGuard("What did Kirsty say about the venue deposit?");
  chat.sawOthers("collected");
  assert.equal(chat.mustWait("add_todo"), "read");
});

test("a run: a flagged read stops both, and what was queued waits for Go", () => {
  let flagged = false;
  const g = new TurnGuard("", () => flagged, ["add_todo"]);
  g.sawOthers("collected");
  assert.equal(g.mustWait("add_todo"), null);
  flagged = true;
  assert.equal(g.allows("add_todo"), false, "allowlisted: taken away");
  assert.equal(g.allows("save_note"), false, "not allowlisted: taken away");
  assert.equal(g.mustWait("add_todo"), "flagged");
  assert.equal(g.mustWait("save_note"), "flagged");
  assert.equal(g.why(["queued-before-the-flag"]), "flagged");
  assert.equal(g.allows("search_athena"), true, "reading carries on");
});

test("a run: text Jev couldn't check holds an allowlisted change for Go, and leaves the tools", () => {
  let unchecked = false;
  const g = new TurnGuard("", () => false, ["add_todo"], () => unchecked);
  g.sawOthers("collected");
  assert.equal(g.mustWait("add_todo"), null, "checked and clean: runs alone");
  unchecked = true;
  assert.equal(g.unchecked, true);
  assert.equal(g.mustWait("add_todo"), "unchecked");
  assert.equal(g.mustWait("save_note"), "read", "not allowlisted: held for the read, as before");
  assert.equal(g.allows("add_todo"), true, "nothing is known to be wrong: the tools stay");
  // Once raised it stays raised.
  unchecked = false;
  assert.equal(g.mustWait("add_todo"), "unchecked");
  g.hold("a", "unchecked");
  g.hold("b", "read");
  assert.equal(g.why(["a", "b"]), "unchecked", "the owner expected the allowlisted one to run alone: that's the reason given");
  assert.equal(g.why(["b"]), "read");
  // A flag still outranks it.
  g.flag();
  assert.equal(g.mustWait("add_todo"), "flagged");
  assert.equal(g.why(["a"]), "flagged");
  // Raised by hand, as for a run's start.
  const started = new TurnGuard("", () => false, ["add_todo"]);
  started.uncheck();
  assert.equal(started.mustWait("add_todo"), "unchecked");
});

test("a run: keeping a reading isn't held for unchecked text (a search comes before nearly every one), but a flag stops it", () => {
  const g = new TurnGuard("", () => false, ["record_value", "add_todo"], () => true);
  g.sawOthers("web");
  assert.equal(g.mustWait("record_value"), null);
  assert.equal(g.mustWait("add_todo"), "unchecked");
  g.flag();
  assert.equal(g.mustWait("record_value"), "flagged");
  assert.equal(g.allows("record_value"), false);
});

test("a chat: text Jev couldn't check changes nothing the owner's message decides", () => {
  const g = new TurnGuard("Add a to-do to pay the venue deposit", () => false, [], () => true);
  g.sawOthers("collected");
  assert.equal(g.mustWait("add_todo"), null, "the owner asked for it, and is there");
  assert.equal(g.mustWait("archive_or_restore"), "read", "held for the read, as before");
  assert.equal(g.allows("add_todo"), true);
});

test("a follow-up on the reply before it is plainly asked", () => {
  assert.equal(asked("Turn this into a recipe"), "add");
  assert.equal(asked("turn that into a to-do"), "add");
  assert.equal(asked("Can you turn it into a note?"), "add");
  assert.equal(asked("add that to my list"), "add");
  assert.equal(asked("remind me about this"), "add");
  assert.equal(asked("save that as a recipe"), "add");
  // Not asking: "turn" in a question, or about something else.
  assert.equal(asked("How do I turn this into a habit?"), "");
  assert.equal(asked("Whose turn is it?"), "");
  assert.equal(plainlyAsked(askedFor("Turn this into a recipe"), "save_recipe"), true);
  assert.equal(plainlyAsked(askedFor("What's a good brownie recipe?"), "save_recipe"), false);
  assert.equal(isWriteTool("save_recipe"), true);
  assert.equal(isWriteTool("watch_tonight"), false);
});
