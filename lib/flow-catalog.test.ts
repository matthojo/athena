// Flows' step catalogue (lib/flow-catalog.ts) and what the store refuses (lib/flows.ts checkSteps): never a tool
// that sends, edits an account or deletes; FLOW_LIMITS held; chips only point at values given before them.
// Run: npx tsx --test lib/flow-catalog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./assistant";
import { AUTO_BY_DEFAULT, FLOW_TOOLS, NEVER_TOOLS, defaultGo, flowCatalog, flowTool, toolChanges } from "./flow-catalog";
import { CHAIN_MAX, chainFor, checkSteps, fillGo, plainSchedule, shownValues, triggerGives } from "./flows";
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
  for (const name of ["send_note", "answer_invite", "create_event", "move_event", "archive_or_restore", "update_people", "log_spending", "make_kind"]) {
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

test("drafts are offered under Tell, as changes that wait for Go", () => {
  const entries = flowCatalog();
  for (const tool of ["draft_email", "draft_message"]) {
    const e = entries.find((x) => x.tool === tool)!;
    assert.ok(e, `${tool} is offered`);
    assert.equal(e.group, "tell");
    assert.equal(e.changes, true);
    assert.equal(toolChanges(tool), true);
    assert.ok(e.fields.some((f) => f.key === "person_id" && f.kind === "person" && f.required));
    assert.equal(defaultGo(tool), "ask");
  }
});

test("only a reminder, a to-do and a list item run alone by default; every other change waits for Go", () => {
  assert.deepEqual([...AUTO_BY_DEFAULT].sort(), ["add_reminder", "add_to_list", "add_todo"]);
  for (const [name, pick] of Object.entries(FLOW_TOOLS)) if (pick.group !== "find") assert.equal(defaultGo(name), AUTO_BY_DEFAULT.has(name) ? "auto" : "ask", name);
  assert.equal(defaultGo("save_note"), "ask");
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

test("Ask me offers FLOW_LIMITS.minChoices to FLOW_LIMITS.choices choices", () => {
  const ask = (n: number): FlowStep => ({ id: "q", title: null, kind: "ask", question: ["Renew?"], choices: Array.from({ length: n }, (_, i) => ({ label: `Choice ${i + 1}`, steps: [] })) });
  assert.equal(FLOW_LIMITS.minChoices, 2);
  assert.throws(() => checkSteps([ask(FLOW_LIMITS.minChoices - 1)], manual), /2 choices at least/);
  assert.doesNotThrow(() => checkSteps([ask(FLOW_LIMITS.minChoices)], manual));
  assert.doesNotThrow(() => checkSteps([ask(FLOW_LIMITS.choices)], manual));
  assert.throws(() => checkSteps([ask(FLOW_LIMITS.choices + 1)], manual), /4 choices at most/);
});

test("a change with no Go setting gets its default; a draft set to run alone is refused", () => {
  const step = (tool: string, input: Record<string, FlowText>, go?: "auto" | "ask") => ({ id: tool, title: null, kind: "tool", tool, input, ...(go ? { go } : {}), gives: [] }) as unknown as FlowStep;
  const steps = fillGo([step("add_reminder", { text: ["Bins"] }), { id: "c", title: null, kind: "check", condition: { left: { from: "trigger", key: "date" }, op: "exists" }, yes: [step("save_note", { title: ["Log"] })], no: [step("add_todo", { title: ["Ring"] }, "ask")] }]);
  assert.equal((steps[0] as { go: string }).go, "auto");
  const check = steps[1] as Extract<FlowStep, { kind: "check" }>;
  assert.equal((check.yes[0] as { go: string }).go, "ask");
  assert.equal((check.no[0] as { go: string }).go, "ask", "the owner's own setting stands");
  const draft = step("draft_email", { person_id: ["p-1"], about: ["Thanks"] }, "auto");
  assert.throws(() => checkSteps([draft], manual), /always waits for your Go/);
  assert.doesNotThrow(() => checkSteps(fillGo([step("draft_email", { person_id: ["p-1"], about: ["Thanks"] })]), manual));
});

test("the chain guard: a run started by another's change joins its chain; a flow already in it, or a fourth run, is refused", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert.equal(CHAIN_MAX, 3);
  assert.deepEqual(chainFor(A, null), { started_by: null, chain: [] });
  assert.deepEqual(chainFor(B, { id: "run-a", flow_id: A, chain: [] }), { started_by: "run-a", chain: [A] });
  assert.deepEqual(chainFor(C, { id: "run-b", flow_id: B, chain: [A] }), { started_by: "run-b", chain: [A, B] });
  assert.ok("refused" in chainFor(A, { id: "run-a", flow_id: A, chain: [] }), "a run never starts its own flow");
  assert.ok("refused" in chainFor(A, { id: "run-b", flow_id: B, chain: [A] }), "A → B → A");
  assert.ok("refused" in chainFor(D, { id: "run-c", flow_id: C, chain: [A, B] }), "no fourth run");
});

test("a run's values read as plain words: a record as its title, money and days as they're shown", () => {
  const shown = shownValues(
    {
      trigger: { item: { id: "e-1", title: "Your plan renews on 4 December", kind: "email" }, title: "Your plan renews" },
      paid: { latest: { amount: 32, currency: "GBP" }, count: 12, none: null, blank: "  " },
      when: { date: "2026-12-04" },
      empty: {},
    },
    "Europe/London",
  );
  assert.deepEqual(shown.trigger, { item: "Your plan renews on 4 December", title: "Your plan renews" });
  assert.deepEqual(shown.paid, { latest: "£32.00", count: "12" });
  assert.match(shown.when.date, /4 Dec/);
  assert.equal(shown.empty, undefined);
});
