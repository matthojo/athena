// Shared flows (lib/flow-share.ts): reading flow.json as someone else's words. Its limits come from FLOW_LIMITS,
// unknown keys go, a tool a flow can't use is refused, record ids never get in, and a step that pointed at the
// owner's record is a blank a question fills. Everything here is made up. Nothing needs a database.
// Run: npx tsx --test lib/flow-share.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allSharedSteps, checkSharedFlowSteps, FLOW_DRAFT_TOOLS, FLOW_LOOK_TOOLS, FLOW_MONEY_TOOLS, FLOW_SHARE_FORMAT, FLOW_SHARE_TOOLS, FLOW_TOOL_SHAPES, importSharedFlow, MAX_FLOW_ASKS, readSharedFlow } from "./flow-share";
import { reachOf } from "./reach";
import { DRAFT_TOOLS, FLOW_TOOLS, flowTool, toolChanges } from "./flow-catalog";
import { MONEY_TOOL_NAMES } from "./ask-tools";
import { FLOW_LIMITS } from "./flow-types";
import { ShareFormatError } from "./team-share";

/** A renewal flow, as someone might share it. */
const renewal = (): Record<string, unknown> => ({
  format: 1,
  name: "Broadband renewal check",
  summary: "When a renewal email arrives, compare the new price with last year's and remind someone to haggle.",
  version: "1.0.0",
  author: "sam-example",
  trigger: { kind: "event", event: { source: "collected", connector: "Gmail", kind: "renewal" } },
  steps: [
    { id: "s1", title: null, kind: "tool", tool: "money", input: { query: ["Northwind Broadband"] }, go: "auto", gives: [{ key: "total", label: "the total", kind: "money" }] },
    {
      id: "s2",
      title: "Did it go up?",
      kind: "check",
      condition: { left: { from: "s1", key: "total" }, op: "more_than", right: 30 },
      yes: [{ id: "s3", title: null, kind: "tool", tool: "add_todo", input: { title: ["Call about the renewal"], person_id: [{ blank: "who" }] }, go: "auto", gives: [] }],
      no: [{ id: "s4", title: null, kind: "notify", text: ["Renewal looks fine at ", { from: "s1", key: "total" }] }],
    },
  ],
  asks: [
    { key: "who", question: "Who should make the call?", fills: "person" },
    { key: "unused", question: "Is this question ever used?" },
  ],
  needs: ["gmail", "Not A Provider!"],
  extra_key: "dropped",
});

const reads = (patch: Record<string, unknown>) => readSharedFlow({ ...renewal(), ...patch });
const refuses = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => reads(patch), (e: unknown) => e instanceof ShareFormatError && re.test(e.message));

test("the tool names match the flows catalogue, the money tools and the drafts", () => {
  assert.deepEqual([...FLOW_SHARE_TOOLS].sort(), Object.keys(FLOW_TOOLS).sort());
  assert.deepEqual([...FLOW_MONEY_TOOLS].sort(), [...MONEY_TOOL_NAMES].sort());
  assert.deepEqual([...FLOW_DRAFT_TOOLS].sort(), [...DRAFT_TOOLS].sort());
});

test("a shared flow reads whole, with the header, its needs and only the questions its blanks use", () => {
  const f = readSharedFlow(renewal());
  assert.equal(f.format, FLOW_SHARE_FORMAT);
  assert.equal(f.name, "Broadband renewal check");
  assert.equal(f.version, "1.0.0");
  assert.equal(f.author, "sam-example");
  assert.deepEqual(f.trigger, { kind: "event", event: { source: "collected", connector: "gmail", kind: "renewal" } });
  assert.deepEqual(f.needs, ["gmail"]);
  assert.deepEqual(f.asks, [{ key: "who", question: "Who should make the call?", choices: [], fills: "person" }]);
  assert.equal(allSharedSteps(f.steps).length, 4);
  assert.ok(!("extra_key" in f));
  // Using a money tool asks for money, whatever the file said.
  assert.equal(f.money, true);
  assert.equal(f.web, false);
});

test("unknown keys in steps are dropped", () => {
  const f = reads({ steps: [{ id: "s1", title: "Ping", kind: "notify", text: "Time to stretch", colour: "red", run_id: "r1" }] });
  assert.deepEqual(f.steps, [{ id: "s1", title: "Ping", kind: "notify", text: ["Time to stretch"] }]);
});

test("the format is checked, with words for a newer one", () => {
  assert.throws(() => readSharedFlow({ ...renewal(), format: 2 }), /newer Athena/);
  assert.throws(() => readSharedFlow({ ...renewal(), format: "1" }), /needs "format": 1/);
  assert.throws(() => readSharedFlow([]), /should hold an object/);
});

test("a tool a flow can't use is refused, by name", () => {
  for (const tool of ["send_note", "create_event", "archive_or_restore", "run_shell"]) refuses({ steps: [{ id: "s1", kind: "tool", tool, input: {}, gives: [] }] }, new RegExp(`can't use “${tool}”`));
});

test("a draft always waits for Go; another change keeps its request", () => {
  const f = reads({
    steps: [
      { id: "s1", kind: "tool", tool: "draft_email", input: { about: ["The renewal"] }, go: "auto", gives: [] },
      { id: "s2", kind: "tool", tool: "add_reminder", input: { text: ["Haggle"] }, go: "auto", gives: [] },
      { id: "s3", kind: "tool", tool: "save_note", input: { title: ["Renewal"] }, gives: [] },
    ],
  });
  assert.deepEqual(
    f.steps.map((s) => (s.kind === "tool" ? s.go : null)),
    ["ask", "auto", "ask"],
  );
});

test("record ids never get in: not as text, not in a record field, not as a step id", () => {
  const id = "3f0c6a52-1b7e-4c55-9a51-2d1f0e8b7c6a";
  refuses({ steps: [{ id: "s1", kind: "notify", text: [`See ${id}`] }] }, /record id/);
  refuses({ steps: [{ id: "s1", kind: "tool", tool: "add_todo", input: { person_id: ["Sam Example"] }, gives: [] }] }, /points at a record/);
  refuses({ steps: [{ id, kind: "notify", text: ["Hi"] }] }, /not a record id/);
  refuses({ name: `Flow ${id}` }, /record id/);
});

test("a blank must name a question, and a value must name a step", () => {
  refuses({ asks: [] }, /no question in asks with the key “who”/);
  refuses({ steps: [{ id: "s1", kind: "notify", text: [{ from: "s9", key: "total" }] }] }, /no step “s9”/);
  const f = reads({ steps: [{ id: "s1", kind: "notify", text: ["It's ", { from: "trigger", key: "company" }] }], asks: [] });
  assert.deepEqual(f.asks, []);
});

test("FLOW_LIMITS hold: steps, depth, choices, wait days, text", () => {
  const many = Array.from({ length: FLOW_LIMITS.steps + 1 }, (_, i) => ({ id: `s${i}`, kind: "notify", text: ["Hi"] }));
  refuses({ steps: many }, /steps at most/);
  const nest = (d: number): Record<string, unknown> => ({ id: `c${d}`, kind: "check", condition: { left: { from: "trigger", key: "x" }, op: "exists" }, yes: d > 1 ? [nest(d - 1)] : [{ id: `n${d}`, kind: "notify", text: ["Hi"] }], no: [] });
  // As lib/flow-steps.ts depthOf counts: the top list is 1, so two nested checks put their notify at 3.
  assert.doesNotThrow(() => reads({ steps: [nest(FLOW_LIMITS.depth - 1)] }));
  refuses({ steps: [nest(FLOW_LIMITS.depth)] }, /deep at most/);
  refuses({ steps: [{ id: "s1", kind: "ask", question: ["Which?"], choices: [{ label: "Only one", steps: [] }] }] }, /choices at least/);
  refuses({ steps: [{ id: "s1", kind: "wait", days: FLOW_LIMITS.waitDays + 1, at: null }] }, /days: 0 to/);
  refuses({ steps: [{ id: "s1", kind: "notify", text: ["x".repeat(FLOW_LIMITS.text + 1)] }] }, /over 500 characters/);
  refuses({ name: "n".repeat(FLOW_LIMITS.name + 1) }, /name: over/);
  refuses({ steps: [{ id: "s1", kind: "notify", text: ["Hi"] }, { id: "s1", kind: "notify", text: ["Again"] }] }, /share the id/);
  refuses({ steps: [] }, /at least one step/);
});

test("questions: at most MAX_FLOW_ASKS, keys unique, choices only for words", () => {
  const asks = Array.from({ length: MAX_FLOW_ASKS + 1 }, (_, i) => ({ key: `q${i}`, question: `Question number ${i}?` }));
  refuses({ asks }, /questions at most/);
  refuses({ asks: [{ key: "who", question: "Who?" }, { key: "who", question: "Who again?" }] }, /two questions share/);
  const f = reads({
    steps: [{ id: "s1", kind: "notify", text: ["Shop at ", { blank: "shop" }] }],
    asks: [{ key: "shop", question: "Which shop?", choices: ["Corner shop", "Market", "Corner shop"] }],
  });
  assert.deepEqual(f.asks[0].choices, ["Corner shop", "Market"]);
});

test("triggers: each kind reads, and a bad one is refused", () => {
  assert.deepEqual(reads({ trigger: { kind: "schedule", days: [5, 1, 1, 9], time: "08:30" } }).trigger, { kind: "schedule", days: [1, 5], time: "08:30" });
  assert.deepEqual(reads({ trigger: { kind: "before", what: "event", minutes: 30, withPeople: true } }).trigger, { kind: "before", what: "event", minutes: 30, withPeople: true });
  assert.deepEqual(reads({ trigger: { kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" } }).trigger, { kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" });
  assert.deepEqual(reads({ trigger: { kind: "manual", id: "t1" } }).trigger, { kind: "manual" });
  refuses({ trigger: { kind: "schedule", days: [], time: "08:30" } }, /needs days/);
  refuses({ trigger: { kind: "hourly" } }, /schedule, event, before or manual/);
  refuses({ trigger: undefined }, /trigger: missing/);
});

test("web: a request, from the file or a thinking step that searches", () => {
  assert.equal(reads({ web: true }).web, true);
  const f = reads({ steps: [{ id: "s1", kind: "think", task: ["Find a better deal"], web: true, gives: [{ key: "answer", label: "the answer", kind: "text" }] }], asks: [] });
  assert.equal(f.web, true);
  assert.equal(f.money, false);
});


// ---------- checkSharedFlowSteps: the checks a saved flow gets, without the database ----------

test("FLOW_TOOL_SHAPES and FLOW_LOOK_TOOLS match the flows catalogue: each tool's fields, what it gives, and whether it changes anything", () => {
  for (const name of Object.keys(FLOW_TOOLS)) {
    const tool = flowTool(name)!;
    const fields = Object.keys((tool.input_schema as { properties?: object }).properties ?? {}).filter((k) => k !== "step");
    assert.deepEqual([...FLOW_TOOL_SHAPES[name].fields], fields, name);
    assert.deepEqual({ ...FLOW_TOOL_SHAPES[name].gives }, Object.fromEntries(FLOW_TOOLS[name].gives.map((g) => [g.key, g.kind])), name);
  }
  assert.deepEqual(Object.keys(FLOW_TOOL_SHAPES).sort(), Object.keys(FLOW_TOOLS).sort());
  assert.deepEqual([...FLOW_LOOK_TOOLS].sort(), Object.keys(FLOW_TOOLS).filter((t) => !toolChanges(t)).sort());
});

const stepsFlow = (steps: unknown[], trigger: unknown = { kind: "manual" }) => readSharedFlow({ format: 1, name: "Check", trigger, steps, asks: [] });

test("checkSharedFlowSteps: a field the tool doesn't have, a value it doesn't give, or one of the wrong kind is refused", () => {
  assert.throws(() => checkSharedFlowSteps(stepsFlow([{ id: "s1", kind: "tool", tool: "add_todo", input: { title: ["Call"], context: ["Home"] } }])), /“add_todo” has no field “context”/);
  assert.throws(() => checkSharedFlowSteps(stepsFlow([{ id: "s1", kind: "tool", tool: "add_todo", input: { title: ["Call"] }, gives: [{ key: "person", label: "the person", kind: "person" }] }])), /doesn't give “person”/);
  assert.throws(() => checkSharedFlowSteps(stepsFlow([{ id: "s1", kind: "tool", tool: "find_people", input: { query: ["Sam"] }, gives: [{ key: "person", label: "the person", kind: "note" }] }])), /is a person, not a note/);
  assert.doesNotThrow(() => checkSharedFlowSteps(stepsFlow([{ id: "s1", kind: "tool", tool: "add_todo", input: { title: ["Call"], area: ["Home"] }, gives: [{ key: "todo", label: "the to-do", kind: "todo" }] }])));
});

test("checkSharedFlowSteps: a value must come from the trigger or a step before it on the way there", () => {
  const find = { id: "s1", kind: "tool", tool: "find_people", input: { query: ["Sam"] }, gives: [{ key: "person", label: "the person", kind: "person" }] };
  const use = (from: string, key: string) => ({ id: "s9", kind: "notify", text: ["Found ", { from, key }] });
  assert.doesNotThrow(() => checkSharedFlowSteps(stepsFlow([find, use("s1", "person")])));
  assert.doesNotThrow(() => checkSharedFlowSteps(stepsFlow([use("trigger", "date")])));
  assert.throws(() => checkSharedFlowSteps(stepsFlow([use("trigger", "event")])), /trigger doesn't give “event”/);
  assert.throws(() => checkSharedFlowSteps(stepsFlow([use("s1", "person"), find])), /uses “person” before any step gives it/);
  assert.throws(() => checkSharedFlowSteps(stepsFlow([find, use("s1", "count")])), /uses “count” before any step gives it/);
  // A value given inside one branch isn't there in the other, or after a check that only one path gives it on.
  const branch = { id: "s2", kind: "check", condition: { left: { from: "trigger", key: "date" }, op: "exists" }, yes: [find], no: [use("s1", "person")] };
  assert.throws(() => checkSharedFlowSteps(stepsFlow([branch])), /before any step gives it/);
});

test("checkSharedFlowSteps runs on every way a flow comes in: reach, the preview and import", () => {
  const bad = { format: 1, name: "Bad", trigger: { kind: "manual" }, steps: [{ id: "s1", kind: "tool", tool: "add_todo", input: { title: ["Call"], context: ["Home"] } }], asks: [] };
  assert.throws(() => reachOf({ files: [{ path: "flow.json", text: JSON.stringify(bad) }] }), /has no field “context”/);
  assert.throws(() => importSharedFlow(readSharedFlow(bad), {}), /has no field “context”/);
});
