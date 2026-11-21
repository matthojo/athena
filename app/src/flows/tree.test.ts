// Run: npx tsx --test app/src/flows/tree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Flow, FlowStep } from "../../../lib/flow-types";
import { FLOW_LIMITS } from "../../../lib/flow-types";
import { brokenSteps, canBranchAt, canMove, countSteps, moveProblem, depthOf, findStep, hasRoom, insertStep, listAt, moveStep, newStepId, removeStep, replaceStep, valuesBefore, valuesForStep } from "./tree";

const T = (key: string) => ({ from: "trigger", key });

function sample(): Pick<Flow, "trigger_gives" | "steps"> {
  return {
    trigger_gives: [
      { key: "company", label: "the company", kind: "organisation" },
      { key: "price", label: "the price", kind: "money" },
    ],
    steps: [
      { id: "paid", kind: "tool", title: null, tool: "money", input: { payee: [T("company")] }, go: "auto", gives: [{ key: "last", label: "last year's price", kind: "money" }] },
      {
        id: "up",
        kind: "check",
        title: null,
        condition: { left: T("price"), op: "more_than", right: { from: "paid", key: "last" } },
        yes: [
          { id: "think", kind: "think", title: null, task: ["Find a better deal"], web: true, gives: [{ key: "deal", label: "the better deal", kind: "text" }] },
          { id: "todo", kind: "tool", title: null, tool: "add_todo", input: { title: ["Decide: ", { from: "think", key: "deal" }] }, go: "ask", gives: [] },
        ],
        no: [{ id: "remind", kind: "notify", title: null, text: [T("company"), " renews soon"] }],
      },
      { id: "end", kind: "notify", title: null, text: ["Done with ", T("company")] },
    ],
  };
}

test("counts steps in branches and measures depth", () => {
  const f = sample();
  assert.equal(countSteps(f.steps), 6);
  assert.equal(depthOf(f.steps), 1);
  const nested = insertStep(f.steps, [{ step: "up", branch: "no" }], 0, { id: "inner", kind: "check", title: null, condition: { left: T("price"), op: "exists" }, yes: [], no: [] });
  assert.equal(depthOf(nested), 2);
  assert.equal(canBranchAt([]), true);
  assert.equal(canBranchAt(new Array(FLOW_LIMITS.depth).fill({ step: "x", branch: "yes" })), false);
});

test("finds a step and the list it sits in", () => {
  const f = sample();
  const at = findStep(f.steps, "todo");
  assert.deepEqual(at?.path, [{ step: "up", branch: "yes" }]);
  assert.equal(at?.index, 1);
  assert.equal(listAt(f.steps as FlowStep[], [{ step: "up", branch: "no" }])?.[0].id, "remind");
  assert.equal(listAt(f.steps as FlowStep[], [{ step: "nope", branch: "no" }]), null);
});

test("insert, replace, move and remove leave the input alone", () => {
  const f = sample();
  const before = JSON.stringify(f.steps);
  const added = insertStep(f.steps, [{ step: "up", branch: "no" }], 1, { id: "x", kind: "wait", title: null, days: 2, at: null });
  assert.deepEqual(
    (added[1] as Extract<FlowStep, { kind: "check" }>).no.map((s) => s.id),
    ["remind", "x"]
  );
  const renamed = replaceStep(added, { id: "x", kind: "wait", title: "Wait a bit", days: 3, at: "08:00" });
  assert.equal((findStep(renamed, "x")?.step as Extract<FlowStep, { kind: "wait" }>).days, 3);
  const moved = moveStep(renamed, "x", -1);
  assert.deepEqual(
    (moved[1] as Extract<FlowStep, { kind: "check" }>).no.map((s) => s.id),
    ["x", "remind"]
  );
  const gone = removeStep(moved, "up");
  assert.deepEqual(
    gone.map((s) => s.id),
    ["paid", "end"]
  );
  assert.equal(JSON.stringify(f.steps), before);
});

test("values come from the trigger and earlier steps on the same path only", () => {
  const f = sample();
  const keys = (vs: ReturnType<typeof valuesBefore>) => vs.map((v) => `${v.ref.from}.${v.ref.key}`);
  assert.deepEqual(keys(valuesBefore(f, [], 0)), ["trigger.company", "trigger.price"]);
  assert.deepEqual(keys(valuesForStep(f, "todo")), ["trigger.company", "trigger.price", "paid.last", "think.deal"]);
  // The other branch can't see what "If so" made, and nor can what comes after the Check.
  assert.deepEqual(keys(valuesForStep(f, "remind")), ["trigger.company", "trigger.price", "paid.last"]);
  assert.deepEqual(keys(valuesForStep(f, "end")), ["trigger.company", "trigger.price", "paid.last"]);
});

test("a step using a value it can't reach is broken", () => {
  const f = sample();
  assert.deepEqual([...brokenSteps(f)], []);
  const moved = { ...f, steps: removeStep(f.steps, "think") };
  assert.deepEqual([...brokenSteps(moved)], ["todo"]);
  const noTrigger = { ...f, trigger_gives: [] };
  assert.ok(brokenSteps(noTrigger).has("paid"));
});

test("new ids don't clash and the step limit holds", () => {
  const f = sample();
  let n = 0;
  const id = newStepId(f.steps, () => [0, 0, 0.5][n++] ?? 0.5);
  assert.match(id, /^s[0-9a-z]{5}$/);
  assert.ok(!findStep(f.steps, id));
  const many: FlowStep[] = Array.from({ length: FLOW_LIMITS.steps }, (_, i) => ({ id: `n${i}`, kind: "notify", title: null, text: ["hi"] }));
  assert.equal(hasRoom(many), false);
  assert.equal(hasRoom(f.steps), true);
});

test("moving a step: only within its list, and never past what it needs", () => {
  const f = sample();
  assert.equal(canMove(f.steps, "paid", -1), false);
  assert.equal(canMove(f.steps, "paid", 1), true);
  assert.equal(canMove(f.steps, "end", 1), false);
  assert.equal(canMove(f.steps, "think", 1), true);
  assert.equal(canMove(f.steps, "todo", 1), false);
  assert.equal(canMove(f.steps, "gone", 1), false);
  // The Check uses last year's price: it can't go above the step that finds it…
  assert.deepEqual(moveProblem(f, "up", -1), { step: "up", ref: { from: "paid", key: "last" }, giver: "paid" });
  // …and that step can't go below it.
  assert.deepEqual(moveProblem(f, "paid", 1), { step: "up", ref: { from: "paid", key: "last" }, giver: "paid" });
  // Inside a branch too.
  assert.deepEqual(moveProblem(f, "todo", -1), { step: "todo", ref: { from: "think", key: "deal" }, giver: "think" });
  // Using only the trigger's values, a step moves freely.
  assert.equal(moveProblem(f, "end", -1), null);
  // At the end of its list there's nothing to refuse.
  assert.equal(moveProblem(f, "end", 1), null);
});

test("a step that was already broken doesn't block a move", () => {
  const f = sample();
  f.steps.push({ id: "lost", kind: "notify", title: null, text: [{ from: "nowhere", key: "x" }] });
  assert.ok(brokenSteps(f).has("lost"));
  assert.equal(moveProblem(f, "lost", -1), null);
});
