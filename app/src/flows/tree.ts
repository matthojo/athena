/**
 * A flow's steps as a tree (lib/flow-types.ts): a list of steps, where a
 * Check holds two lists (yes, no) and an Ask me holds one per choice. The
 * editor never mutates a flow in place: each change makes a new step list,
 * which it then saves. Pure, so it's tested without a page.
 *
 * A place in the tree is a ListPath: the branch lists to walk through from
 * the top, as (step id, branch) pairs. [] is the flow's own list.
 */
import { FLOW_LIMITS, type Flow, type FlowStep, type FlowValue, type ValueRef } from "../../../lib/flow-types";

export type Branch = "yes" | "no" | number;
export type ListPath = ReadonlyArray<{ step: string; branch: Branch }>;

/** The lists a step holds, with the branch each is. */
export function branchesOf(step: FlowStep): Array<{ branch: Branch; steps: FlowStep[] }> {
  if (step.kind === "check") return [{ branch: "yes", steps: step.yes }, { branch: "no", steps: step.no }];
  if (step.kind === "ask") return step.choices.map((c, i) => ({ branch: i, steps: c.steps }));
  return [];
}

export const isBranching = (step: Pick<FlowStep, "kind">): boolean => step.kind === "check" || step.kind === "ask";

/** Every step, depth first, in the order the editor shows them. */
export function walk(steps: readonly FlowStep[], fn: (step: FlowStep, path: ListPath, index: number) => void, path: ListPath = []): void {
  steps.forEach((s, i) => {
    fn(s, path, i);
    for (const b of branchesOf(s)) walk(b.steps, fn, [...path, { step: s.id, branch: b.branch }]);
  });
}

/** Steps in the flow, branches included: what FLOW_LIMITS.steps counts. */
export function countSteps(steps: readonly FlowStep[]): number {
  let n = 0;
  walk(steps, () => n++);
  return n;
}

/** How deeply branches nest: 0 with none, 1 with a Check at the top, 2 with a Check in its branch. */
export function depthOf(steps: readonly FlowStep[]): number {
  let max = 0;
  walk(steps, (s, path) => {
    if (isBranching(s)) max = Math.max(max, path.length + 1);
  });
  return max;
}

/** Whether a Check or Ask me may go into the list at `path`. */
export const canBranchAt = (path: ListPath): boolean => path.length < FLOW_LIMITS.depth;

/** Whether one more step fits in the flow. */
export const hasRoom = (steps: readonly FlowStep[]): boolean => countSteps(steps) < FLOW_LIMITS.steps;

export function findStep(steps: readonly FlowStep[], id: string): { step: FlowStep; path: ListPath; index: number } | null {
  let hit: { step: FlowStep; path: ListPath; index: number } | null = null;
  walk(steps, (step, path, index) => {
    if (!hit && step.id === id) hit = { step, path, index };
  });
  return hit;
}

/** The list at `path`, or null when the path no longer leads anywhere. */
export function listAt(steps: FlowStep[], path: ListPath): FlowStep[] | null {
  let list: FlowStep[] = steps;
  for (const seg of path) {
    const s = list.find((x) => x.id === seg.step);
    if (!s) return null;
    const b = branchesOf(s).find((x) => x.branch === seg.branch);
    if (!b) return null;
    list = b.steps;
  }
  return list;
}

/** A copy of the tree with the list at `path` changed by `fn`. The input is left alone. */
function editList(steps: readonly FlowStep[], path: ListPath, fn: (list: FlowStep[]) => FlowStep[]): FlowStep[] {
  const copy = structuredClone(steps) as FlowStep[];
  if (!path.length) return fn(copy);
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parentList = listAt(copy, parentPath);
  const owner = parentList?.find((x) => x.id === last.step);
  if (!owner) return copy;
  if (owner.kind === "check" && (last.branch === "yes" || last.branch === "no")) owner[last.branch] = fn(owner[last.branch]);
  else if (owner.kind === "ask" && typeof last.branch === "number" && owner.choices[last.branch]) owner.choices[last.branch].steps = fn(owner.choices[last.branch].steps);
  return copy;
}

export function insertStep(steps: readonly FlowStep[], path: ListPath, index: number, step: FlowStep): FlowStep[] {
  return editList(steps, path, (list) => [...list.slice(0, index), step, ...list.slice(index)]);
}

export function replaceStep(steps: readonly FlowStep[], step: FlowStep): FlowStep[] {
  const at = findStep(steps, step.id);
  if (!at) return structuredClone(steps) as FlowStep[];
  return editList(steps, at.path, (list) => list.map((s) => (s.id === step.id ? step : s)));
}

/** Take a step out, with anything in its branches. */
export function removeStep(steps: readonly FlowStep[], id: string): FlowStep[] {
  const at = findStep(steps, id);
  if (!at) return structuredClone(steps) as FlowStep[];
  return editList(steps, at.path, (list) => list.filter((s) => s.id !== id));
}

/** Move a step up or down within its own list. */
export function moveStep(steps: readonly FlowStep[], id: string, by: -1 | 1): FlowStep[] {
  const at = findStep(steps, id);
  if (!at) return structuredClone(steps) as FlowStep[];
  return editList(steps, at.path, (list) => {
    const i = list.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
}

/** A step id that isn't taken in this flow. */
export function newStepId(steps: readonly FlowStep[], rand: () => number = Math.random): string {
  const taken = new Set<string>();
  walk(steps, (s) => taken.add(s.id));
  for (;;) {
    const id = `s${Math.floor(rand() * 36 ** 5).toString(36).padStart(5, "0")}`;
    if (!taken.has(id)) return id;
  }
}

/** A value a later step may use, with where it comes from. */
export interface AvailableValue extends FlowValue {
  ref: ValueRef;
  /** The step's title or "When", for grouping. */
  fromStep: string | null;
}

const givesOf = (s: FlowStep): FlowValue[] => (s.kind === "tool" || s.kind === "think" ? s.gives : []);

/**
 * What a step at (`path`, `index`) can use: the trigger's values, then what
 * each step before it gives, on its own path through the branches. A value
 * made inside a branch is never offered after the branch ends, since the run
 * may have taken the other way.
 */
export function valuesBefore(flow: Pick<Flow, "trigger_gives" | "steps">, path: ListPath, index: number): AvailableValue[] {
  const out: AvailableValue[] = flow.trigger_gives.map((v) => ({ ...v, ref: { from: "trigger", key: v.key }, fromStep: null }));
  let list: FlowStep[] = flow.steps;
  const levels: Array<{ list: FlowStep[]; upTo: number }> = [];
  for (const seg of path) {
    const i = list.findIndex((s) => s.id === seg.step);
    if (i < 0) break;
    levels.push({ list, upTo: i });
    const b = branchesOf(list[i]).find((x) => x.branch === seg.branch);
    if (!b) break;
    list = b.steps;
  }
  levels.push({ list, upTo: index });
  for (const level of levels) {
    for (const s of level.list.slice(0, level.upTo)) for (const v of givesOf(s)) out.push({ ...v, ref: { from: s.id, key: v.key }, fromStep: s.id });
  }
  return out;
}

/** What a step itself may use: the values before it. */
export function valuesForStep(flow: Pick<Flow, "trigger_gives" | "steps">, id: string): AvailableValue[] {
  const at = findStep(flow.steps, id);
  return at ? valuesBefore(flow, at.path, at.index) : valuesBefore(flow, [], flow.steps.length);
}

/** Every value pointer a step uses in its own settings (not in its branches). */
export function refsIn(step: FlowStep): ValueRef[] {
  const out: ValueRef[] = [];
  const text = (t: ReadonlyArray<string | ValueRef>) => t.forEach((p) => typeof p !== "string" && out.push(p));
  if (step.kind === "tool") Object.values(step.input).forEach(text);
  else if (step.kind === "check") {
    out.push(step.condition.left);
    if (step.condition.right && typeof step.condition.right === "object") out.push(step.condition.right);
    if (step.condition.against) out.push(step.condition.against);
  } else if (step.kind === "ask") text(step.question);
  else if (step.kind === "wait") step.before && out.push(step.before);
  else if (step.kind === "notify") text(step.text);
  else if (step.kind === "think") text(step.task);
  else if (step.kind === "assignment") text(step.brief);
  return out;
}

/** Steps that use a value they can no longer reach (a step above was removed or moved): the editor marks them. */
export function brokenSteps(flow: Pick<Flow, "trigger_gives" | "steps">): Set<string> {
  const broken = new Set<string>();
  walk(flow.steps, (s, path, index) => {
    const ok = new Set(valuesBefore(flow, path, index).map((v) => `${v.ref.from}\u0000${v.ref.key}`));
    if (refsIn(s).some((r) => !ok.has(`${r.from}\u0000${r.key}`))) broken.add(s.id);
  });
  return broken;
}
