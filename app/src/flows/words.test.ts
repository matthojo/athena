// Run: npx tsx --test app/src/flows/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionWords, flowBadge, lastRunLine, listLede, resumeWords, runHeading, runStateWords, stepTitle, triggerTitle, triggerWords, tryWords } from "./words";
import { normaliseText, swapRef } from "./text";
import { searchCatalog, stepFromEntry, unavailable } from "./steps";
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
  const todo = stepFromEntry(cat.find((e) => e.tool === "add_todo")!, "s1", []);
  assert.equal(todo.kind === "tool" && todo.go, "ask");
  const c = stepFromEntry(check, "s2", [{ key: "price", label: "the price", kind: "money", ref: { from: "trigger", key: "price" }, fromStep: null }]);
  assert.deepEqual(c.kind === "check" && c.condition, { left: { from: "trigger", key: "price" }, op: "exists" });
});

test("words people read have no em dashes", () => {
  const strings = [...sampleCatalog().flatMap((e) => [e.label, e.hint])];
  for (const s of strings) assert.ok(!/—|--/.test(s), s);
  assert.ok(NOTE_STYLE.includes("No em dashes"));
});
