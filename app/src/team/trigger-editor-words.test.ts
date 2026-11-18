import { test } from "node:test";
import assert from "node:assert/strict";
import { clockWords, daysWords, pageStatusLine, pageStatusParts, statusLine, triggerSentence as sentence, triggersSummary, whenWords } from "./trigger-editor-words";
const triggerSentence = (t: Parameters<typeof sentence>[0]) => sentence(t, false);
import { allowFor, allowSummary } from "./setup-allow";
import type { TeamTrigger } from "../../../lib/team-types";

test("schedule triggers read as sentences", () => {
  assert.equal(triggerSentence({ kind: "schedule", days: [1, 2, 3, 4, 5], time: "08:00" }), "Every weekday at 8:00");
  assert.equal(triggerSentence({ kind: "schedule", days: [5], time: "17:00" }), "Every Friday at 17:00");
  assert.equal(triggerSentence({ kind: "schedule", days: [0, 6], time: "10:30" }), "Every weekend at 10:30");
  assert.equal(triggerSentence({ kind: "schedule", days: [1, 3, 5], time: "09:00" }), "Every Mon, Wed and Fri at 9:00");
  assert.equal(daysWords([]), "Every day");
  assert.equal(daysWords("1,2"), "Every Mon and Tue");
  assert.equal(clockWords("07:05", false), "7:05");
});

test("event triggers read as sentences", () => {
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } }), "When a Linear issue is assigned to you");
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "gmail", match: "invoice" } }), "When an email arrives with “invoice” in the title");
  assert.equal(triggerSentence({ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }), "When you save a gift idea");
  assert.equal(triggerSentence({ kind: "event", event: { source: "saved" } }), "When you save a link");
  assert.equal(triggerSentence({ kind: "event", event: { source: "note", tag: "#idea" } }), "When you tag a note #idea");
  assert.equal(triggersSummary([]), "Only when you ask");
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "gmail", kind: "email" } }), "When an email arrives");
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "gmail", kind: "delivery" } }), "When a delivery update arrives");
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "gmail", kind: "alert" } }), "When an account alert arrives");
  assert.equal(triggerSentence({ kind: "event", event: { source: "collected", connector: "gmail", kind: "renewal", match: "insurance" } }), "When something's due to renew with “insurance” in the title");
});

const trig = (t: Partial<TeamTrigger>): TeamTrigger => ({ id: "t", assistant_id: "a", kind: "schedule", days: [5], time: "17:00", event: null, paused: false, last_slot: null, last_fired_at: null, created_at: "", ...t });

test("the status line under a name", () => {
  const now = new Date(2026, 10, 12, 15, 0);
  assert.equal(statusLine({ paused: true, last_run_at: null, triggers: [] }, now), "Paused");
  assert.equal(statusLine({ paused: false, last_run_at: new Date(2026, 10, 12, 9, 12).toISOString(), triggers: [] }, now, false), "Last ran 9:12");
  // On a 12-hour device, as the assistant's page and the Team page write it.
  assert.equal(statusLine({ paused: false, last_run_at: new Date(2026, 10, 12, 9, 12).toISOString(), triggers: [] }, now, true), "Last ran 9:12 am");
  assert.equal(statusLine({ paused: false, last_run_at: null, triggers: [trig({ kind: "event", days: [], time: null, event: { source: "collected", connector: "linear" } })] }, now), "Watching Linear");
  assert.equal(statusLine({ paused: false, last_run_at: null, triggers: [trig({})] }, now, false), "Runs every Friday at 17:00");
  assert.equal(statusLine({ paused: false, last_run_at: null, triggers: [] }, now), "Ready when you ask");
  assert.equal(whenWords(new Date(2026, 10, 11, 8).toISOString(), now), "yesterday");
  assert.equal(whenWords(new Date(2026, 9, 3).toISOString(), now), "3 Oct");
});

test("the fuller status line on an assistant's own page", () => {
  const now = new Date(2026, 10, 12, 20, 0);
  const gifts = trig({ kind: "event", days: [], time: null, event: { source: "saved", savedAction: "gift-idea" } });
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  assert.equal(pageStatusLine({ paused: false, last_run_at: at(12, 19, 14), triggers: [gifts] }, now, false), "Watching for gift ideas · last ran 19:14");
  assert.equal(pageStatusLine({ paused: false, last_run_at: at(12, 19, 14), triggers: [gifts] }, now, true), "Watching for gift ideas · last ran 7:14 pm");
  assert.deepEqual(pageStatusParts({ paused: false, last_run_at: at(6, 17, 2), triggers: [trig({})] }, now, false), ["Runs every Friday at 17:00", "last ran Fri"]);
  // Six days back reads as its weekday, as the run list does; a week or more, as a date.
  assert.deepEqual(pageStatusParts({ paused: false, last_run_at: at(5, 17, 2), triggers: [trig({})] }, now, false), ["Runs every Friday at 17:00", "last ran 5 Nov"]);
  assert.equal(pageStatusLine({ paused: false, last_run_at: at(11, 9), triggers: [] }, now, false), "Ready when you ask · last ran yesterday");
  assert.equal(pageStatusLine({ paused: false, last_run_at: null, triggers: [trig({})] }, now, false), "Runs every Friday at 17:00");
  assert.equal(pageStatusLine({ paused: true, last_run_at: at(10, 9), triggers: [gifts] }, now, false), "Paused · last ran Tue");
  // The short shared line (Ask's head, Home's chips) keeps the same clock.
  assert.equal(statusLine({ paused: false, last_run_at: at(12, 19, 14), triggers: [gifts] }, now, false), "Last ran 19:14");
  assert.equal(statusLine({ paused: false, last_run_at: at(12, 19, 14), triggers: [gifts] }, now, true), "Last ran 7:14 pm");
});

test("setup offers only the switches the job needs", () => {
  assert.deepEqual(allowFor("When a Linear issue is assigned to me, add a to-do"), ["add_todo"]);
  assert.deepEqual(allowFor("When I save a gift idea, find a good price"), ["add_to_list"]);
  assert.ok(allowFor("Every Friday at 5, sum up my week").includes("save_note"));
  assert.deepEqual(allowFor("do the thing"), ["add_todo", "save_note", "add_reminder"]);
  assert.deepEqual(allowFor("track gifts", ["add_todo"]).slice(0, 1), ["add_todo"]);
  assert.equal(allowSummary([]), "Asks you first");
  assert.equal(allowSummary(["add_todo", "add_reminder"]), "Can add to-dos and set reminders without asking");
});

import { jobFromText, triggersFromText } from "./setup-guess";

test("a thin draft: the job and triggers read from the sentence", () => {
  assert.equal(jobFromText("When I save a gift idea, find a good price"), "Finds a good price");
  assert.equal(jobFromText("When a Linear issue is assigned to me, add a to-do"), "Adds a to-do");
  assert.equal(jobFromText("Every Friday at 5, sum up my week"), "Sums up your week");
  assert.deepEqual(triggersFromText("Every Friday at 5, sum up my week"), [{ kind: "schedule", days: [5], time: "17:00" }]);
  assert.deepEqual(triggersFromText("Every weekday at 8:30am, check my inbox"), [{ kind: "schedule", days: [1, 2, 3, 4, 5], time: "08:30" }]);
  assert.deepEqual(triggersFromText("When I save a gift idea, find a good price"), [{ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }]);
  assert.equal(triggersFromText("When a Linear issue is assigned to me, add a to-do")[0].event?.connector, "linear");
  assert.deepEqual(triggersFromText("Tell me when a parcel is out for delivery"), [{ kind: "event", event: { source: "collected", connector: "gmail", kind: "delivery" } }]);
  assert.equal(triggersFromText("Ping me about any security alert or new sign-in")[0].event?.kind, "alert");
  assert.equal(triggersFromText("Remind me when insurance renewals come in")[0].event?.kind, "renewal");
  assert.equal(triggersFromText("When an email arrives, sum it up")[0].event?.kind, "email");
  assert.equal(clockWords("17:00", true), "5:00 pm");
  assert.equal(clockWords("17:00", false), "17:00");
});
