// Plan, then Go (lib/ask-plans.ts): what's queued instead of made, one change running straight away,
// Go with partial ticks and stand-in ids, and Undo all newest first.
// Run: npx tsx --test lib/ask-plans.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAN_MIN_STEPS, PlanDraft, isPlannable, runSteps, stepLabel, substitute, undoAllChanges, withStepField, withoutStep, type PlanStep } from "./ask-plans";
import type { Change } from "./assistant";
import { TOOLS } from "./assistant";

const change = (id: string, over: Partial<Change> = {}): Change => ({ kind: "commitment", id, action: "created", title: id, detail: "To do", label: `${id}: To do`, open: null, undo: { op: "archive", kind: "commitment", id } as never, activity_id: `a-${id}`, ...over });

test("only tools that may change something are queued; looking and confirm-sheet tools run as they are", () => {
  for (const t of ["add_todo", "draft_message", "move_event", "save_note", "add_reminder", "save_routine", "archive_or_restore"]) assert.equal(isPlannable(t), true, t);
  for (const t of ["find_people", "find_notes", "read_note", "find_todos", "ask_owner", "find_times", "create_event", "find_recipes", "find_saved", "goals", "taste"]) assert.equal(isPlannable(t), false, t);
});

test("nothing is written before Go: a draft keeps every change and never runs one", async () => {
  const draft = new PlanDraft("auto");
  let ran = 0;
  const run = async () => (ran++, []);
  // The session asks the draft first; a queued call never reaches the tool.
  for (const [name, input] of [
    ["find_people", { query: "Sam" }],
    ["move_event", { event_id: "e1", start: "2026-11-12T14:00", step: "Move the 3pm to Thursday" }],
    ["draft_message", { person_id: "p1", about: "the venue", step: "Draft a reply to Sam" }],
    ["add_todo", { title: "Book the venue", step: "Add a to-do: book the venue" }],
  ] as const) {
    const queued = draft.offer(name, input);
    if (!queued) await run();
    else assert.match(JSON.parse(queued).queued, /\w/);
  }
  assert.equal(ran, 1, "only find_people ran");
  const out = draft.outcome();
  assert.equal(out.kind, "plan");
  assert.deepEqual(out.kind === "plan" && out.steps.map((s) => s.label), ["Move the 3pm to Thursday", "Draft a reply to Sam", "Add a to-do: book the venue"]);
  // The plan's line isn't passed to the tool.
  assert.equal(out.kind === "plan" && (out.steps[2].input as Record<string, unknown>).step, undefined);
});

test("a single change runs straight away, as before; none does nothing", () => {
  const one = new PlanDraft("auto");
  one.offer("add_todo", { title: "Call Mum" });
  const out = one.outcome();
  assert.equal(out.kind, "run");
  assert.equal(PLAN_MIN_STEPS, 2);
  assert.equal(new PlanDraft("auto").outcome().kind, "none");
});

test("a routine's draft (propose) never runs anything, even one change", () => {
  const draft = new PlanDraft("propose");
  draft.offer("add_todo", { title: "Chase the invoice" });
  assert.equal(draft.outcome().kind, "plan");
});

test("each queued change gets a stand-in id the model can use in a later step", () => {
  const draft = new PlanDraft("auto");
  const person = JSON.parse(draft.offer("add_person", { name: "Sam Lee" })!);
  assert.match(person.id, /^[0-9a-f-]{36}$/);
  draft.offer("add_todo", { title: "Ask Sam about the venue", person_id: person.id });
  assert.equal(draft.steps[1].stands_for !== person.id, true);
  assert.deepEqual(substitute({ person_id: person.id, list: [person.id], n: 3 }, new Map([[person.id, "real"]])), { person_id: "real", list: ["real"], n: 3 });
});

test("step lines: the model's own, else the running line for the tool", () => {
  assert.equal(stepLabel("add_todo", { step: "  Add a to-do:   book the venue " }), "Add a to-do: book the venue");
  assert.equal(stepLabel("add_todo", { title: "x" }), "Adding a to-do");
  assert.deepEqual(withoutStep({ a: 1, step: "x" }), { a: 1 });
  const tools = withStepField(TOOLS);
  const add = tools.find((t) => t.name === "add_todo")!.input_schema as { properties: Record<string, unknown> };
  const find = tools.find((t) => t.name === "find_people")!.input_schema as { properties: Record<string, unknown> };
  assert.ok(add.properties.step);
  assert.equal(find.properties.step, undefined);
});

const steps = (): PlanStep[] => [
  { label: "Add Sam", tool: "add_person", input: { name: "Sam" }, stands_for: "SAM" },
  { label: "To-do for Sam", tool: "add_todo", input: { title: "Venue", person_id: "SAM" }, stands_for: "T1" },
  { label: "Remind me", tool: "add_reminder", input: { text: "Venue" }, stands_for: "R1" },
];

test("Go runs the ticked steps in order, swapping stand-ins for what earlier steps made", async () => {
  const calls: Array<[string, unknown]> = [];
  const results = await runSteps(steps(), new Set([0, 1, 2]), async (tool, input) => {
    calls.push([tool, input]);
    return [change(tool === "add_person" ? "person-1" : `${tool}-1`)];
  });
  assert.deepEqual(calls.map((c) => c[0]), ["add_person", "add_todo", "add_reminder"]);
  assert.deepEqual(calls[1][1], { title: "Venue", person_id: "person-1" });
  assert.deepEqual(results.map((r) => r.status), ["done", "done", "done"]);
});

test("Go with partial ticks: unticked steps are skipped, and so is a step that needs one", async () => {
  const calls: string[] = [];
  const results = await runSteps(steps(), new Set([1, 2]), async (tool) => (calls.push(tool), [change(`${tool}-1`)]));
  assert.deepEqual(calls, ["add_reminder"]);
  assert.deepEqual(results.map((r) => r.status), ["skipped", "skipped", "done"]);
  assert.match(results[1].error!, /needed a step/);
});

test("a step that fails doesn't stop the rest, and says why", async () => {
  const results = await runSteps(steps(), new Set([0, 2]), async (tool) => {
    if (tool === "add_person") throw new Error("That person is already in Athena");
    return [change("r")];
  });
  assert.deepEqual(results.map((r) => r.status), ["failed", "skipped", "done"]);
  assert.equal(results[0].error, "That person is already in Athena");
});

test("Undo all goes newest first, and one refusal doesn't stop the rest", async () => {
  const order: string[] = [];
  const out = await undoAllChanges(
    [
      { status: "done", changes: [change("a")] },
      { status: "skipped", changes: [] },
      { status: "done", changes: [change("b"), change("c", { undo: null })] },
      { status: "done", changes: [change("d")] },
    ],
    async (c) => {
      order.push(c.id);
      if (c.id === "b") throw new Error("It has changed since");
    },
  );
  assert.deepEqual(order, ["d", "b", "a"]);
  assert.deepEqual(out.map((o) => o.ok), [true, false, true]);
});
