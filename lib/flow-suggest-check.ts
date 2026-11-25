/**
 * Checks for flow suggestions (lib/flow-suggest.ts). Pure.
 *
 * suggestionProblems() holds a suggestion to lib/flow-types.ts: the limits,
 * a trigger that makes sense, unique step ids, values that point at the
 * trigger or an earlier step. The engine checks a flow again when it's saved;
 * this is so Athena never offers one that would be turned away.
 *
 * alreadyAFlow() says whether the owner has a flow that does the same: the
 * same kind of trigger on the same thing (or a schedule on the same day near
 * the same time) with a step of the same kind and tool.
 */
import { FLOW_LIMITS, type Flow, type FlowStep, type FlowSuggestion, type FlowText, type FlowTrigger, type ValueRef } from "./flow-types";
import { suggestedTriggerKeys } from "./flow-suggest-keys";
import { AUTO_BY_DEFAULT } from "./flow-catalog";

/** What suggestions need to know of a flow the owner has (read through a port; lib/flow-suggest-store.ts). */
export type ExistingFlow = Pick<Flow, "trigger" | "steps">;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9_-]{3,80}$/;
/** Ask's tools a suggestion may use: changes the owner already makes by hand, nothing that sends or deletes. */
export const SUGGESTED_TOOLS = new Set(["add_reminder", "add_todo", "add_to_list", "file_saved_item"]);

const isRef = (p: unknown): p is ValueRef => !!p && typeof p === "object" && typeof (p as ValueRef).from === "string" && typeof (p as ValueRef).key === "string";

function textProblems(t: FlowText, where: string, known: (r: ValueRef) => boolean): string[] {
  const out: string[] = [];
  if (!Array.isArray(t) || !t.length) return [`${where}: empty`];
  for (const p of t) {
    if (typeof p === "string") {
      if (p.length > FLOW_LIMITS.text) out.push(`${where}: text over ${FLOW_LIMITS.text}`);
    } else if (!isRef(p)) out.push(`${where}: not text or a value`);
    else if (!known(p)) out.push(`${where}: ${p.from}.${p.key} isn't given before it`);
  }
  if (t.every((p) => typeof p === "string" && !p.trim())) out.push(`${where}: blank`);
  return out;
}

function triggerProblems(t: FlowTrigger): string[] {
  switch (t.kind) {
    case "schedule":
      return [
        ...(!t.days.length || t.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(t.days).size !== t.days.length ? ["trigger: days"] : []),
        ...(HHMM.test(t.time) ? [] : ["trigger: time"]),
      ];
    case "event":
      return ["collected", "saved", "note"].includes(t.event.source) ? [] : ["trigger: event source"];
    case "before":
      if (t.what === "event") return Number.isInteger(t.minutes) && t.minutes > 0 ? [] : ["trigger: minutes"];
      return Number.isInteger(t.days) && t.days >= 0 && HHMM.test(t.at) ? [] : ["trigger: days or at"];
    case "manual":
      return [];
    default:
      return ["trigger: kind"];
  }
}

/** Every step, branches included, with how deep it sits (1 at the top). */
export function walkSteps(steps: FlowStep[], depth = 1): Array<{ step: FlowStep; depth: number }> {
  const out: Array<{ step: FlowStep; depth: number }> = [];
  for (const step of steps) {
    out.push({ step, depth });
    if (step.kind === "check") out.push(...walkSteps(step.yes, depth + 1), ...walkSteps(step.no, depth + 1));
    if (step.kind === "ask") for (const c of step.choices) out.push(...walkSteps(c.steps, depth + 1));
  }
  return out;
}

/** What's wrong with a suggestion, in short; empty when it's fine to offer. */
export function suggestionProblems(s: FlowSuggestion): string[] {
  const out: string[] = [];
  if (!ID.test(s.id)) out.push("id");
  if (!s.title.trim() || s.title.length > 120) out.push("title");
  if (!s.why.trim() || !/\d|one|two|three|four|five|six|seven|eight|nine|all/i.test(s.why)) out.push("why: needs its counts");
  const f = s.flow;
  if (!f.name.trim() || f.name.length > FLOW_LIMITS.name) out.push("name");
  out.push(...triggerProblems(f.trigger));
  if (!f.steps.length) out.push("steps: none");
  const all = walkSteps(f.steps);
  if (all.length > FLOW_LIMITS.steps) out.push("steps: too many");
  if (all.some((x) => x.depth > FLOW_LIMITS.depth)) out.push("steps: too deep");
  const ids = all.map((x) => x.step.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) out.push("steps: ids");

  const triggerKeys = new Set(suggestedTriggerKeys(f.trigger));
  // Values flow forward: a step sees the trigger's and those of steps before it (in its own branch or above).
  const walk = (steps: FlowStep[], given: Map<string, Set<string>>) => {
    const seen = new Map(given);
    for (const step of steps) {
      const known = (r: ValueRef) => (r.from === "trigger" ? triggerKeys.has(r.key) : !!seen.get(r.from)?.has(r.key));
      const at = `step ${step.id}`;
      switch (step.kind) {
        case "tool":
          if (!SUGGESTED_TOOLS.has(step.tool)) out.push(`${at}: tool ${step.tool}`);
          if (step.go !== "auto" && step.go !== "ask") out.push(`${at}: go`);
          else if (step.go === "auto" && !AUTO_BY_DEFAULT.has(step.tool)) out.push(`${at}: ${step.tool} must wait for approval`);
          for (const [k, v] of Object.entries(step.input)) out.push(...textProblems(v, `${at}.${k}`, known));
          if (step.tool === "add_reminder" && (!step.input.text || !step.input.date)) out.push(`${at}: a reminder needs text and a date`);
          if (step.tool === "add_reminder" && step.input.time && !step.input.time.every((p) => typeof p !== "string" || HHMM.test(p))) out.push(`${at}: time`);
          if (step.tool === "add_todo" && (!step.input.title || !step.input.kind)) out.push(`${at}: a to-do needs a title and kind`);
          if (step.tool === "add_to_list" && !step.input.item) out.push(`${at}: a list needs an item`);
          if (step.tool === "file_saved_item" && (!step.input.saved_id || !step.input.action)) out.push(`${at}: needs the saved item and the action`);
          seen.set(step.id, new Set(step.gives.map((g) => g.key)));
          break;
        case "notify":
          out.push(...textProblems(step.text, `${at}.text`, known));
          break;
        case "think":
          // A plain flow has no assistant to think: suggestions are plain flows.
          out.push(`${at}: think needs an assistant`);
          break;
        case "assignment":
          out.push(...textProblems(step.brief, `${at}.brief`, known));
          break;
        case "wait":
          if (!Number.isInteger(step.days) || step.days < 0 || step.days > FLOW_LIMITS.waitDays) out.push(`${at}: days`);
          if (step.at !== null && !HHMM.test(step.at)) out.push(`${at}: at`);
          if (step.before && !known(step.before)) out.push(`${at}: before`);
          break;
        case "check":
          if (!known(step.condition.left)) out.push(`${at}: condition`);
          walk(step.yes, seen);
          walk(step.no, seen);
          break;
        case "ask":
          out.push(...textProblems(step.question, `${at}.question`, known));
          if (!step.choices.length || step.choices.length > FLOW_LIMITS.choices) out.push(`${at}: choices`);
          for (const c of step.choices) walk(c.steps, seen);
          break;
      }
    }
  };
  walk(f.steps, new Map());
  return out;
}

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Same trigger, as far as a habit goes: the same thing arriving, or a schedule on a shared day within an hour. */
export function sameTrigger(a: FlowTrigger, b: FlowTrigger): boolean {
  if (a.kind === "event" && b.kind === "event") {
    if (a.event.source !== b.event.source) return false;
    if (lower(a.event.kind) !== lower(b.event.kind)) return false;
    if (a.event.savedAction && b.event.savedAction && lower(a.event.savedAction) !== lower(b.event.savedAction)) return false;
    return true;
  }
  if (a.kind === "schedule" && b.kind === "schedule") {
    return a.days.some((d) => b.days.includes(d)) && HHMM.test(a.time) && HHMM.test(b.time) && Math.abs(minutes(a.time) - minutes(b.time)) <= 60;
  }
  return false;
}

/** What a step does, for comparing: "tool:add_reminder", "notify". */
const doing = (s: FlowStep): string => (s.kind === "tool" ? `tool:${s.tool}` : s.kind);

/** Whether the owner already has a flow that does what this suggestion would. */
export function alreadyAFlow(s: FlowSuggestion, flows: ExistingFlow[]): boolean {
  const wants = new Set(walkSteps(s.flow.steps).map((x) => doing(x.step)));
  return flows.some((f) => sameTrigger(s.flow.trigger, f.trigger) && walkSteps(f.steps ?? []).some((x) => wants.has(doing(x.step))));
}
