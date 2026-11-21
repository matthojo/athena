// Run: npx tsx --test app/src/flows/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionWords, flowBadge, moveRefusal, waitsForGo, lastRunLine, listLede, resumeWords, runHeading, runStateWords, stepTitle, triggerTitle, triggerWords, tryWords } from "./words";
import { normaliseText, swapRef } from "./text";
import { changes, defaultGo, goLocked, searchCatalog, stepFromEntry, unavailable } from "./steps";
import { sampleCatalog } from "../db/sample-flows";
import { NOTE_STYLE } from "../../../lib/writing-style";

const NOW = new Date(2026, 10, 20, 15, 0);

test("triggers read as sentences", () => {
  assert.equal(triggerWords({ kind: "schedule", days: [5], time: "17:00" }, true), "Every Friday at 5:00 pm");
  assert.equal(triggerWords({ kind: "event", event: { source: "collected", kind: "renewal" } }), "When something's due to renew");
  assert.equal(triggerTitle({ kind: "event", event: { source: "saved", savedAction: "gift-idea" } }), "You save a gift idea");
  assert.equal(triggerWords({ kind: "before", what: "event", minutes: 30, withPeople: true }), "30 minutes before an event with people you know");
  assert.equal(triggerWords({ kind: "before", what: "date", days: 7, at: "09:00", eventKind: "birthday" }, false), "A week before a birthday, at 9:00");
  assert.equal(triggerWords({ kind: "manual" }), "Only when you run it");
  assert.equal(tryWords({ kind: "event", event: { source: "collected", kind: "renewal" } }), "Try it on the last renewal");
  assert.equal(tryWords({ kind: "manual" }), "Try it now");
});

test("step titles: the owner's, else what it does", () => {
  assert.equal(stepTitle({ id: "a", kind: "tool", title: "  My own  ", tool: "add_todo", input: {}, go: "ask", gives: [] }), "My own");
  assert.equal(stepTitle({ id: "a", kind: "tool", title: null, tool: "add_todo", input: {}, go: "ask", gives: [] }), "Add a to-do");
  assert.equal(stepTitle({ id: "a", kind: "think", title: null, task: [], web: false, gives: [] }, [], "Muse"), "Muse thinks");
  assert.equal(stepTitle({ id: "a", kind: "wait", title: null, days: 7, at: null }), "Wait a week");
});

test("conditions read plainly", () => {
  const label = (r: { key: string }) => `the ${r.key}`;
  assert.equal(conditionWords({ left: { from: "trigger", key: "price" }, op: "up_by_pct", right: 10, against: { from: "s", key: "last" } }, label), "the price is up by at least 10% on the last");
  assert.equal(conditionWords({ left: { from: "trigger", key: "price" }, op: "exists" }, label), "the price is there");
  assert.equal(conditionWords({ left: { from: "trigger", key: "name" }, op: "contains", right: "Ltd" }, label), "the name contains Ltd");
});

test("badges put what waits for you first", () => {
  assert.deepEqual(flowBadge({ paused: false }, { status: "waiting", waits_for: "go", dry: false }), { tone: "you", words: "Needs your Go" });
  assert.deepEqual(flowBadge({ paused: true }, { status: "waiting", waits_for: "answer", dry: false }), { tone: "you", words: "Asks you something" });
  assert.deepEqual(flowBadge({ paused: true }, null), { tone: "off", words: "Off" });
  assert.deepEqual(flowBadge({ paused: false }, { status: "waiting", waits_for: "go", dry: true }), { tone: "on", words: "On" });
});

test("the list's lede says how today went", () => {
  const flows = [
    { id: "a", name: "Renewal guard", paused: false },
    { id: "b", name: "Delivery day", paused: false },
  ];
  const at = new Date(2026, 10, 20, 8, 12).toISOString();
  assert.equal(listLede(flows, { a: { status: "waiting", waits_for: "go", started_at: at, dry: false }, b: { status: "done", waits_for: null, started_at: at, dry: false } }, NOW), "Two ran today. Renewal guard needs you.");
  assert.equal(listLede(flows, {}, NOW), "Two are on. None ran today.");
  assert.match(listLede([], {}, NOW), /^A flow does/);
});

test("runs: headings, waits and the card's line", () => {
  assert.equal(runHeading(new Date(2026, 10, 20, 8, 12).toISOString(), true, NOW), "Today at 8:12 am");
  assert.equal(runHeading(new Date(2026, 10, 2, 9, 0).toISOString(), false, NOW), "2 Nov at 9:00");
  assert.equal(resumeWords(new Date(2026, 10, 27, 8, 0).toISOString(), false, NOW), "Fri 27 Nov at 8:00");
  assert.equal(resumeWords(new Date(2026, 10, 21, 8, 0).toISOString(), false, NOW), "tomorrow at 8:00");
  const waiting = { status: "waiting" as const, waits_for: "go" as const, dry: false, steps: [{ step_id: "a", status: "waiting" as const, line: "", pending: { text: "x", plan_id: "p" }, at: "" }] };
  assert.equal(runStateWords(waiting), "1 change waits for your Go");
  assert.equal(lastRunLine(null), "Hasn't run yet");
  assert.equal(lastRunLine({ started_at: new Date(2026, 10, 20, 9, 40).toISOString(), summary: "A reminder for Thursday", status: "done", steps: [], error: null, dry: false }, false, NOW), "Today at 9:40 · A reminder for Thursday");
});

test("text: words join, edges trim, chips swap", () => {
  const c = { from: "trigger", key: "company" };
  assert.deepEqual(normaliseText(["  Decide ", "on ", c, "", " renewal  "]), ["Decide on ", c, " renewal"]);
  assert.deepEqual(swapRef(["Hi ", c, "!"], c, null), ["Hi !"]);
  assert.deepEqual(swapRef(["Hi ", c], c, { from: "s1", key: "name" }), ["Hi ", { from: "s1", key: "name" }]);
});

test("the catalogue: search, what's locked, and new steps", () => {
  const cat = sampleCatalog();
  assert.deepEqual(
    searchCatalog(cat, "remind").map((e) => e.label),
    ["Reminder"]
  );
  const think = cat.find((e) => e.kind === "think")!;
  assert.equal(unavailable(think, { hasAssistant: false, canBranch: true }), "Hand this flow to an assistant first");
  assert.equal(unavailable(think, { hasAssistant: true, canBranch: true }), null);
  const check = cat.find((e) => e.kind === "check")!;
  assert.match(unavailable(check, { hasAssistant: true, canBranch: false }) ?? "", /deeper/);
  // A to-do may run alone (owner, 21 Nov 2026); a note waits for your Go.
  const todo = stepFromEntry(cat.find((e) => e.tool === "add_todo")!, "s1", []);
  assert.equal(todo.kind === "tool" && todo.go, "auto");
  const note = stepFromEntry(cat.find((e) => e.tool === "save_note")!, "s3", []);
  assert.equal(note.kind === "tool" && note.go, "ask");
  const c = stepFromEntry(check, "s2", [{ key: "price", label: "the price", kind: "money", ref: { from: "trigger", key: "price" }, fromStep: null }]);
  assert.deepEqual(c.kind === "check" && c.condition, { left: { from: "trigger", key: "price" }, op: "exists" });
});

test("words people read have no em dashes", () => {
  const strings = [...sampleCatalog().flatMap((e) => [e.label, e.hint])];
  for (const s of strings) assert.ok(!/—|--/.test(s), s);
  assert.ok(NOTE_STYLE.includes("No em dashes"));
});

test("a refused move says why", () => {
  const title = (id: string) => ({ paid: "Look up spending", up: "Check the price" })[id] ?? id;
  const value = "last year's price";
  assert.equal(moveRefusal({ step: "up", giver: "paid" }, "up", -1, { title, value }), "This step uses last year's price from “Look up spending”, so it can't go above it.");
  assert.equal(moveRefusal({ step: "up", giver: "paid" }, "paid", 1, { title, value }), "“Check the price” uses last year's price from this step, so this step can't go below it.");
  assert.match(moveRefusal({ step: "up", giver: "paid" }, "other", -1, { title, value }), /wouldn't reach it after this move|wouldn't reach after this move/);
});

test("new tool steps: only reminders, to-dos and list lines run alone; drafts always wait", () => {
  const cat = sampleCatalog();
  const go = (tool: string) => defaultGo(cat.find((e) => e.tool === tool)!);
  assert.equal(go("add_reminder"), "auto");
  assert.equal(go("add_todo"), "auto");
  assert.equal(go("add_to_list"), "auto");
  assert.equal(go("save_note"), "ask");
  assert.equal(go("draft_email"), "ask");
  assert.equal(go("draft_message"), "ask");
  // A look has nothing to wait for.
  assert.equal(go("weather"), "auto");
  assert.equal(defaultGo({ tool: "something_new", changes: true }), "ask");

  for (const tool of ["draft_email", "draft_message"]) {
    const e = cat.find((x) => x.tool === tool)!;
    assert.equal(e.group, "tell");
    const step = stepFromEntry(e, "s1", []);
    assert.equal(step.kind === "tool" && step.go, "ask");
    assert.deepEqual(Object.keys(step.kind === "tool" ? step.input : {}), ["to", "subject", "body"]);
    assert.equal(goLocked(step), true);
    assert.equal(changes(step, []), true);
    // Even saved as "auto" somewhere else, a draft still waits.
    assert.equal(waitsForGo({ ...step, go: "auto" } as typeof step), true);
  }
  assert.equal(goLocked(stepFromEntry(cat.find((x) => x.tool === "add_todo")!, "s2", [])), false);
});
