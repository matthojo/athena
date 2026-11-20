// Flows' step catalogue (lib/flow-catalog.ts) and what the store refuses (lib/flows.ts checkSteps): never a tool
// that sends, edits an account or deletes; FLOW_LIMITS held; chips only point at values given before them.
// Run: npx tsx --test lib/flow-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./assistant";
import { FLOW_TOOLS, NEVER_TOOLS, flowCatalog, flowTool } from "./flow-catalog";
import { checkSteps, plainSchedule, triggerGives } from "./flows";
import { FLOW_LIMITS, type FlowStep, type FlowText, type FlowTrigger } from "./flow-types";

test("every tool the catalogue names is one of Ask's, and none is never-offered", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const name of Object.keys(FLOW_TOOLS)) {
    assert.ok(names.has(name), `${name} is one of Ask's tools`);
    assert.ok(!NEVER_TOOLS.has(name), `${name} isn't never-offered`);
  }
});

test("nothing that sends, edits an account or deletes is offered", () => {
  const offered = new Set(flowCatalog().filter((e) => e.kind === "tool").map((e) => e.tool));
  for (const name of ["send_note", "answer_invite", "draft_message", "draft_email", "create_event", "move_event", "archive_or_restore", "update_people", "log_spending", "make_kind"]) {
    assert.ok(!offered.has(name), `${name} isn't offered`);
    assert.equal(flowTool(name), null);
  }
});

test("the catalogue: a Go setting on changes, money marked, fields without the plan's line, every step kind there", () => {
  const entries = flowCatalog();
  const todo = entries.find((e) => e.tool === "add_todo")!;
  assert.equal(todo.changes, true);
  assert.equal(todo.group, "add");
  assert.ok(todo.fields.some((f) => f.key === "title" && f.required));
  assert.ok(todo.fields.some((f) => f.key === "person_id" && f.kind === "person"));
  assert.ok(!todo.fields.some((f) => f.key === "step"));
  assert.equal(entries.find((e) => e.tool === "money")?.money, true);
  assert.equal(entries.find((e) => e.tool === "find_people")?.changes, false);
  for (const kind of ["check", "ask", "wait", "notify", "think", "assignment"]) assert.ok(entries.some((e) => e.kind === kind), kind);
  assert.equal(entries.find((e) => e.kind === "think")?.needsAssistant, true);
});

const manual: FlowTrigger = { kind: "manual" };
const note = (id: string, text: FlowText = ["Hi"]): FlowStep => ({ id, title: null, kind: "notify", text });

test("FLOW_LIMITS: steps counted with their branches, and how deep branches go", () => {
  const many = Array.from({ length: FLOW_LIMITS.steps + 1 }, (_, i) => note(`s${i}`));
  assert.throws(() => checkSteps(many, manual), /24 steps at most/);
  const nest = (d: number): FlowStep[] => (d === 0 ? [note(`n${d}`)] : [{ id: `c${d}`, title: null, kind: "check", condition: { left: { from: "trigger", key: "date" }, op: "exists" }, yes: nest(d - 1), no: [] }]);
  assert.doesNotThrow(() => checkSteps(nest(2), { kind: "schedule", days: [1], time: "09:00" }));
  assert.throws(() => checkSteps(nest(3), { kind: "schedule", days: [1], time: "09:00" }), /3 deep at most/);
});

test("chips point at the trigger or an earlier step's value; ids are unique; tools are the catalogue's", () => {
  const find: FlowStep = { id: "find", title: null, kind: "tool", tool: "find_people", input: { query: ["Sam"] }, go: "auto", gives: [{ key: "person", label: "the person", kind: "person" }] };
  const add: FlowStep = { id: "add", title: null, kind: "tool", tool: "add_todo", input: { title: ["Ring ", { from: "find", key: "person" }], kind: ["todo"], person_id: [{ from: "find", key: "person" }] }, go: "ask", gives: [] };
  assert.doesNotThrow(() => checkSteps([find, add], manual));
  assert.throws(() => checkSteps([add, find], manual), /before any step gives it/);
  assert.throws(() => checkSteps([find, { ...find }], manual), /share the id/);
  assert.throws(() => checkSteps([{ ...find, tool: "send_note" }], manual), /can't use/);
  assert.throws(() => checkSteps([{ ...find, input: { nope: ["x"] } }], manual), /no field/);
  assert.throws(() => checkSteps([note("a", [{ from: "trigger", key: "title" }])], manual), /doesn't give/);
  assert.doesNotThrow(() => checkSteps([note("a", [{ from: "trigger", key: "title" }])], { kind: "event", event: { source: "collected", kind: "renewal" } }));
});

test("what a trigger gives, and the plain half the jobs read never holds its words", () => {
  assert.deepEqual(triggerGives({ kind: "manual" }), []);
  assert.deepEqual(
    triggerGives({ kind: "event", event: { source: "collected", kind: "renewal" } }).map((g) => g.key),
    ["item", "title"],
  );
  assert.ok(triggerGives({ kind: "before", what: "event", minutes: 30, withPeople: true }).some((g) => g.kind === "person"));
  const plain = plainSchedule({ kind: "event", event: { source: "collected", kind: "renewal", match: "Northwind" } });
  assert.deepEqual(plain, { event: { source: "collected", kind: "renewal" } });
  assert.ok(!JSON.stringify(plainSchedule({ kind: "before", what: "date", days: 3, at: "09:00", match: "Sam's birthday" })).includes("Sam"));
});
