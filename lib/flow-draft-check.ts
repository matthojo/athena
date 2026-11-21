/**
 * Flows drafting's strict half (lib/flow-draft.ts): what the model proposed,
 * made to fit lib/flow-types.ts and FLOW_LIMITS exactly, or left out with a
 * note the editor shows.
 *
 * The model writes steps as a flat list in the order they run. A step inside a
 * branch names its `parent` (an earlier Check or Ask me step) and `branch`
 * ("yes" or "no" for a Check, a choice's number from 0 for Ask me). Values in
 * text are written {{trigger.key}} or {{<step id>.key}}. This turns that into
 * the nested FlowStep tree with FlowText and ValueRefs, and checks every value
 * points at something that has surely run by then: the trigger, or a step
 * earlier on the same path (not one inside a branch that may not have run).
 *
 * Pure: no model, no database.
 */
import { EVENT_SOURCES, type EventFilter, type TeamWeekday } from "./team-types";
import { FLOW_LIMITS, type CheckOp, type FlowCondition, type FlowStep, type FlowText, type FlowTrigger, type FlowValue, type ValueKind, type ValueRef } from "./flow-types";
import { goFor, type DraftTool } from "./flow-draft-tools";

export const CHECK_OPS: readonly CheckOp[] = ["is", "is_not", "contains", "more_than", "less_than", "up_by_pct", "exists", "missing"];
/** The longest "before an event" a trigger may be set, in minutes: a week. */
export const MAX_BEFORE_MINUTES = 7 * 24 * 60;
/** Notes the editor shows at most. */
export const MAX_NOTES = 8;

export interface CheckContext {
  tools: DraftTool[];
  /** What a trigger gives later steps (lib/flow-triggers.ts triggerGives). */
  triggerGives: (t: FlowTrigger) => FlowValue[];
  /** "Let Ask read transactions" is on: steps may read spending. */
  money: boolean;
}

export interface Checked {
  name: string;
  trigger: FlowTrigger;
  steps: FlowStep[];
  /** A kept step reads spending. */
  money: boolean;
  notes: string[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : "");
const int = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** At most `n` characters, cut at a word. Pure. */
export function clip(s: string, n: number): string {
  const one = oneLine(s);
  if (one.length <= n) return one;
  const cut = one.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return (space > n * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "");
}

/** A name a flow can carry: one line, no markup, at most FLOW_LIMITS.name. Empty when nothing's left. Pure. */
export function cleanName(raw: unknown): string {
  const s = str(raw).replace(/[<>{}`*_#]/g, "").replace(/^["'“‘]+|["'”’.!]+$/g, "");
  const n = clip(s, FLOW_LIMITS.name);
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : "";
}

/** HH:MM in 24 hours, or null. "8:00" becomes "08:00". Pure. */
export function cleanTime(raw: unknown): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(str(raw));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

// ---------- the trigger ----------

const lower = (x: unknown) => clip(str(x), 80).toLowerCase();

/** The model's trigger as lib/flow-types.ts has it, or null when it doesn't hold up. Pure. */
export function fitTrigger(raw: unknown): FlowTrigger | null {
  if (!isObj(raw)) return null;
  switch (raw.kind) {
    case "manual":
      return { kind: "manual" };
    case "schedule": {
      const time = cleanTime(raw.time);
      if (!time) return null;
      const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(int).filter((d): d is number => d !== null && d >= 0 && d <= 6))].sort() : [];
      return { kind: "schedule", days: (days.length ? days : [0, 1, 2, 3, 4, 5, 6]) as TeamWeekday[], time };
    }
    case "event": {
      const e = raw.event;
      if (!isObj(e) || !EVENT_SOURCES.includes(e.source as EventFilter["source"])) return null;
      const event: EventFilter = { source: e.source as EventFilter["source"] };
      for (const k of ["connector", "kind", "savedAction"] as const) if (lower(e[k])) event[k] = lower(e[k]);
      for (const k of ["tag", "match"] as const) {
        const val = clip(str(e[k]).replace(/^#/, ""), 120);
        if (val) event[k] = val;
      }
      return { kind: "event", event };
    }
    case "before_event": {
      const minutes = int(raw.minutes);
      if (minutes === null || minutes < 1 || minutes > MAX_BEFORE_MINUTES) return null;
      const match = clip(str(raw.match), 120);
      return { kind: "before", what: "event", minutes, ...(raw.with_people === true ? { withPeople: true } : {}), ...(match ? { match } : {}) };
    }
    case "before_date": {
      const days = int(raw.days_before);
      if (days === null || days < 0 || days > FLOW_LIMITS.waitDays) return null;
      const match = clip(str(raw.match), 120);
      const eventKind = lower(raw.event_kind);
      return { kind: "before", what: "date", days, at: cleanTime(raw.at) ?? "09:00", ...(eventKind ? { eventKind } : {}), ...(match ? { match } : {}) };
    }
    default:
      return null;
  }
}

// ---------- values in text ----------

const REF_RE = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}/g;
const ONE_REF = /^\s*\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\s*\}\}\s*$/;

/** What a step has in reach: by step id ("trigger" for the trigger), each value's kind by key. */
type Scope = Map<string, Map<string, ValueKind>>;

class Walk {
  readonly notes: string[] = [];
  /** The model's step id → the id it's kept under. */
  readonly ids = new Map<string, string>();
  count = 0;
  money = false;
  constructor(readonly ctx: CheckContext) {}

  note(s: string) {
    if (!this.notes.includes(s)) this.notes.push(s);
  }

  /** A ref the model wrote, if it points at a value in reach. */
  ref(from: string, key: string, scope: Scope): (ValueRef & { kind: ValueKind }) | null {
    const id = from === "trigger" ? "trigger" : this.ids.get(from);
    const kind = id ? scope.get(id)?.get(key) : undefined;
    return id && kind ? { from: id, key, kind } : null;
  }

  /** Text with {{from.key}} in it, as FlowText; values out of reach are dropped and noted. */
  text(raw: unknown, scope: Scope, where: string): FlowText {
    const s = Array.isArray(raw) ? raw.map(str).join(" ") : str(raw);
    const out: FlowText = [];
    let last = 0;
    const push = (lit: string) => {
      if (!lit) return;
      const prev = out[out.length - 1];
      if (typeof prev === "string") out[out.length - 1] = (prev + lit).slice(0, FLOW_LIMITS.text);
      else out.push(lit.slice(0, FLOW_LIMITS.text));
    };
    for (const m of s.matchAll(REF_RE)) {
      push(s.slice(last, m.index));
      last = m.index! + m[0].length;
      const r = this.ref(m[1], m[2], scope);
      if (r) out.push({ from: r.from, key: r.key });
      else this.note(`${where} used a value that isn't there yet at that point, so I took it out.`);
    }
    push(s.slice(last));
    // Trim the ends, and drop a text that's only spaces.
    if (typeof out[0] === "string") out[0] = (out[0] as string).replace(/^\s+/, "");
    const end = out.length - 1;
    if (end >= 0 && typeof out[end] === "string") out[end] = (out[end] as string).replace(/\s+$/, "");
    return out.filter((p) => p !== "");
  }
}

const empty = (t: FlowText) => t.length === 0;

// ---------- the steps ----------

interface RawStep {
  /** Its place in the model's list. */
  at: number;
  id: string;
  parent: string;
  branch: unknown;
  raw: Record<string, unknown>;
}

const KINDS = new Set(["tool", "check", "ask", "wait", "notify", "think", "assignment"]);

function branchOf(raw: unknown): "yes" | "no" | number | null {
  if (raw === "yes" || raw === true) return "yes";
  if (raw === "no" || raw === false) return "no";
  const n = int(raw);
  return n !== null && n >= 0 ? n : null;
}

/**
 * The model's draft made to fit, or null when there's nothing to use (not an object, or no name, no trigger and no
 * steps). `fallbackName` names a draft whose own name doesn't hold up. Pure.
 */
export function checkDraft(raw: unknown, ctx: CheckContext, fallbackName: string): Checked | null {
  if (!isObj(raw)) return null;
  const w = new Walk(ctx);
  const name = cleanName(raw.name);
  let trigger = fitTrigger(raw.trigger);
  if (!trigger) {
    if (raw.trigger !== undefined && raw.trigger !== null) w.note("I couldn't tell when it should start, so for now it runs only when you tap Run now.");
    trigger = { kind: "manual" };
  }

  const list: RawStep[] = [];
  const seen = new Set<string>();
  (Array.isArray(raw.steps) ? raw.steps : []).forEach((s, at) => {
    if (!isObj(s)) return;
    const id = str(s.id).trim() || `step${at + 1}`;
    if (seen.has(id) || id === "trigger") return;
    seen.add(id);
    list.push({ at, id, parent: str(s.parent).trim(), branch: s.branch, raw: s });
  });
  if (!name && !list.length && trigger.kind === "manual") return null;

  const byId = new Map(list.map((s) => [s.id, s]));
  const visited = new Set<RawStep>();
  const tools = new Map(ctx.tools.map((t) => [t.name, t]));
  const top: Scope = new Map([["trigger", new Map(ctx.triggerGives(trigger).map((g) => [g.key, g.kind]))]]);

  const childrenOf = (parent: RawStep | null, branch: "yes" | "no" | number | null): RawStep[] =>
    list.filter((s) => {
      if (!parent) return !s.parent || !byId.has(s.parent);
      return s.parent === parent.id && s.at > parent.at && branchOf(s.branch) === branch;
    });

  /** Steps in order from `raws`, each able to use what came before it on its path. */
  const build = (raws: RawStep[], scope: Scope, depth: number): FlowStep[] => {
    const here: Scope = new Map(scope);
    const out: FlowStep[] = [];
    for (const r of raws) {
      if (visited.has(r)) continue;
      visited.add(r);
      if (r.parent && !byId.has(r.parent)) {
        w.note("A step pointed at a branch that isn't there, so I left it out.");
        continue;
      }
      if (w.count >= FLOW_LIMITS.steps) {
        w.note(`A flow holds ${FLOW_LIMITS.steps} steps at most, so I kept the first ${FLOW_LIMITS.steps}.`);
        continue;
      }
      const step = one(r, here, depth);
      if (!step) continue;
      out.push(step);
      if (step.kind === "tool" && step.gives.length) here.set(step.id, new Map(step.gives.map((g) => [g.key, g.kind])));
    }
    return out;
  };

  const one = (r: RawStep, scope: Scope, depth: number): FlowStep | null => {
    const s = r.raw;
    const kind = str(s.kind);
    if (!KINDS.has(kind)) {
      w.note("I left out a step I couldn't read.");
      return null;
    }
    const id = `s${w.count + 1}`;
    const base = { id, title: null };
    const where = "A step";
    switch (kind) {
      case "tool": {
        const tool = tools.get(str(s.tool));
        if (!tool) {
          w.note(`Athena has no step called “${clip(str(s.tool), 40) || "?"}”, so I left it out.`);
          return null;
        }
        if (tool.money && !ctx.money) {
          w.note(`Reading your spending is off for Ask (Settings, Ask), so I left out the step that needed it (${tool.name}).`);
          return null;
        }
        const input: Record<string, FlowText> = {};
        const rawInput = isObj(s.input) ? s.input : {};
        for (const field of tool.fields) {
          if (!(field in rawInput)) continue;
          const t = w.text(rawInput[field], scope, where);
          if (!empty(t)) input[field] = t;
        }
        const missing = tool.required.filter((f) => !input[f]);
        if (missing.length) w.note(`The ${tool.name} step still needs ${missing.join(" and ")}.`);
        if (tool.money) w.money = true;
        w.ids.set(r.id, id);
        w.count++;
        return { ...base, kind: "tool", tool: tool.name, input, go: goFor(tool, s.go), gives: tool.gives };
      }
      case "check": {
        if (depth > FLOW_LIMITS.depth) {
          w.note(`Branches go ${FLOW_LIMITS.depth} deep at most, so I left out a check inside them.`);
          return null;
        }
        const condition = fitCondition(s.condition, scope, w);
        if (!condition) {
          w.note("I couldn't work out what one check should look at, so I left it and its branches out.");
          return null;
        }
        w.ids.set(r.id, id);
        w.count++;
        const yes = build(childrenOf(r, "yes"), scope, depth + 1);
        const no = build(childrenOf(r, "no"), scope, depth + 1);
        return { ...base, kind: "check", condition, yes, no };
      }
      case "ask": {
        if (depth > FLOW_LIMITS.depth) {
          w.note(`Branches go ${FLOW_LIMITS.depth} deep at most, so I left out a question inside them.`);
          return null;
        }
        const question = w.text(s.question, scope, where);
        const labels = (Array.isArray(s.choices) ? s.choices : []).map((c) => clip(str(isObj(c) ? c.label : c), FLOW_LIMITS.name)).filter(Boolean);
        if (empty(question) || labels.length < FLOW_LIMITS.minChoices) {
          w.note("A question needs words and at least two choices, so I left one out.");
          return null;
        }
        if (labels.length > FLOW_LIMITS.choices) w.note(`A question offers ${FLOW_LIMITS.choices} choices at most, so I kept the first ${FLOW_LIMITS.choices}.`);
        w.ids.set(r.id, id);
        w.count++;
        const choices = labels.slice(0, FLOW_LIMITS.choices).map((label, i) => ({ label, steps: build(childrenOf(r, i), scope, depth + 1) }));
        return { ...base, kind: "ask", question, choices };
      }
      case "wait": {
        let days = int(s.days) ?? 0;
        if (days < 0) days = 0;
        if (days > FLOW_LIMITS.waitDays) {
          w.note(`A wait is ${FLOW_LIMITS.waitDays} days at most, so I set it to ${FLOW_LIMITS.waitDays}.`);
          days = FLOW_LIMITS.waitDays;
        }
        let before: ValueRef | undefined;
        if (s.before !== undefined && s.before !== null && s.before !== "") {
          const m = ONE_REF.exec(str(s.before));
          const r2 = m ? w.ref(m[1], m[2], scope) : null;
          if (r2 && (r2.kind === "date" || r2.kind === "datetime")) before = { from: r2.from, key: r2.key };
          else w.note("A wait was set before a date that isn't there at that point, so it counts from now instead.");
        }
        w.ids.set(r.id, id);
        w.count++;
        return { ...base, kind: "wait", days, ...(before ? { before } : {}), at: cleanTime(s.at) };
      }
      case "notify": {
        const text = w.text(s.text, scope, where);
        if (empty(text)) {
          w.note("A notification had nothing to say, so I left it out.");
          return null;
        }
        w.ids.set(r.id, id);
        w.count++;
        return { ...base, kind: "notify", text };
      }
      case "think":
        // Only a flow with an assistant thinks (lib/flow-types.ts), and a drawn flow has none yet.
        w.note("Thinking steps need an assistant. Hand the flow to one, then add it.");
        return null;
      case "assignment": {
        const brief = w.text(s.brief, scope, where);
        if (empty(brief)) {
          w.note("An assignment step needs a brief, so I left it out.");
          return null;
        }
        w.ids.set(r.id, id);
        w.count++;
        return { ...base, kind: "assignment", brief };
      }
    }
    return null;
  };

  const steps = build(childrenOf(null, null), top, 1);
  if (list.some((r) => !visited.has(r))) w.note("Some steps didn't fit anywhere in the flow, so I left them out.");
  for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
    const said = clip(str(n), 200);
    if (said) w.note(said);
  }
  return { name: name || cleanName(fallbackName) || "New flow", trigger, steps, money: w.money, notes: w.notes.slice(0, MAX_NOTES) };
}

/** A Check's condition, its values in reach, or null. */
function fitCondition(raw: unknown, scope: Scope, w: Walk): FlowCondition | null {
  if (!isObj(raw)) return null;
  const op = raw.op as CheckOp;
  if (!CHECK_OPS.includes(op)) return null;
  const lm = ONE_REF.exec(str(raw.left));
  const left = lm ? w.ref(lm[1], lm[2], scope) : null;
  if (!left) return null;
  const l: ValueRef = { from: left.from, key: left.key };
  if (op === "exists" || op === "missing") return { left: l, op };
  if (op === "up_by_pct") {
    const pct = typeof raw.right === "number" ? raw.right : Number(str(raw.right).replace(/%$/, ""));
    const am = ONE_REF.exec(str(raw.against));
    const against = am ? w.ref(am[1], am[2], scope) : null;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 10_000 || !against) return null;
    return { left: l, op, right: pct, against: { from: against.from, key: against.key } };
  }
  if (typeof raw.right === "number" && Number.isFinite(raw.right)) return { left: l, op, right: raw.right };
  const rs = str(raw.right);
  const rm = ONE_REF.exec(rs);
  if (rm) {
    const right = w.ref(rm[1], rm[2], scope);
    return right ? { left: l, op, right: { from: right.from, key: right.key } } : null;
  }
  const lit = rs.trim().slice(0, FLOW_LIMITS.text);
  return lit ? { left: l, op, right: lit } : null;
}
