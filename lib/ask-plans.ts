/**
 * Plan, then Go: when a request needs two or more changes, Ask writes none of
 * them. It shows a plan card instead ("Move the 3pm to Thursday · Draft a
 * reply to Sam · Add a to-do: book the venue"), each step ticked; Go runs the
 * ticked steps in order and shows one receipt per step, each with Undo, plus
 * Undo all. A single change still runs straight away.
 *
 * How nothing is written before Go: while the assistant works, every tool
 * that changes something is offered to a PlanDraft first, and the draft
 * keeps the call instead of running it (the model is told it's queued, and
 * gets a stand-in id it can use in later steps). Only tools that look, and
 * the ones that already wait for a tap of their own (find_times'
 * buttons, create_event's confirm sheet), run as they are. When the model
 * is done: no queued call, nothing to do; one, and it runs then (as before);
 * two or more, and they're kept as a plan (`ask_plans`, migration 0055,
 * sealed) for the owner to Go.
 *
 * A routine's run (lib/routines.ts) drafts in "propose" mode: even one change
 * becomes a plan, and nothing runs until the owner taps Go.
 *
 * Go claims the plan once (ran_at), runs each ticked step through the same
 * tool code a reply uses, with stand-in ids swapped for what earlier steps
 * made, and logs every change in What Ask did (lib/ask-activity.ts). Undo all
 * undoes them newest first through that log.
 */
import { randomUUID } from "node:crypto";
import { AthenaInputError, q, qRaw } from "./db";
import { sealText } from "./data-box";
import type { Anthropic } from "./ai";
import type { Change } from "./assistant";
import { assistantStepStart, stepActs } from "./steps";
import type { ActivityContext, ActivityEntry } from "./ask-activity";

/** Tools that change nothing until the owner taps something of their own, or only look: they run as they are while planning. */
const RUNS_WHILE_PLANNING = new Set(["find_times", "create_event", "find_recipes", "find_saved", "ask_owner"]);

/** Whether a call to this tool is queued while planning (it may change something). */
export const isPlannable = (name: string): boolean => stepActs(name) && !RUNS_WHILE_PLANNING.has(name);

/** At least this many changes make a plan; fewer run straight away (Ask, not a routine). */
export const PLAN_MIN_STEPS = 2;
/** A plan this long is plenty to read and tick on a phone. */
export const PLAN_MAX_STEPS = 12;

export type PlanMode = "auto" | "propose";

/** One queued change: the tool, its input and the plan's line for it. `stands_for` is the id the model was given for what it will make. */
export interface PlanStep {
  label: string;
  tool: string;
  input: unknown;
  stands_for: string;
}

export type StepStatus = "done" | "skipped" | "failed";

export interface StepResult {
  status: StepStatus;
  /** Why a step failed, in words the owner can read. */
  error?: string;
  changes: Change[];
}

/** A plan as a reply carries it, and as the app shows it. Tool inputs stay on the server. */
export interface PlanCard {
  id: string;
  source: "ask" | "routine";
  steps: Array<{ label: string; tool: string }>;
  /** Nothing can run it from here: a routine's run proposes, the owner Goes. */
  proposed?: boolean;
  /**
   * Why even one change is waiting here rather than made (lib/ask-guard.ts): the turn had read other people's
   * words (an account's item, a web page, a file) and the owner's message didn't plainly ask for it, or
   * something it read was flagged as an instruction.
   */
  why?: "read" | "flagged";
  /** After Go: when, and each step's outcome in order. */
  ran?: { at: string; results: StepResult[] };
}

// ---------- the plan's line for each step ----------

/** The model's own line for a change, asked for on every tool that may change something. */
export const STEP_FIELD = {
  type: "string",
  description: "This change as one line of a plan, in a few plain words, starting with a verb: “Move the 3pm to Thursday”, “Draft a reply to Sam”, “Add a to-do: book the venue”.",
} as const;

/** The tools as the model sees them while planning: every plannable tool also takes `step`. */
export function withStepField(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.map((t) => {
    if (!isPlannable(t.name)) return t;
    const schema = t.input_schema as { properties?: Record<string, unknown> };
    return { ...t, input_schema: { ...t.input_schema, properties: { ...(schema.properties ?? {}), step: STEP_FIELD } } };
  });
}

const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** A step's line: the model's own, else the running line the app shows for that tool ("Adding a to-do"). */
export function stepLabel(name: string, input: unknown): string {
  const own = input && typeof input === "object" ? (input as { step?: unknown }).step : undefined;
  if (typeof own === "string" && own.trim()) return clip(own);
  return clip(assistantStepStart(name, input) ?? "Make a change");
}

/** The input as the tool takes it: without the plan's line. */
export function withoutStep(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { step: _step, ...rest } = input as Record<string, unknown>;
  return rest;
}

// ---------- drafting a plan while the assistant works ----------

/**
 * Collects the changes a request would make, instead of making them.
 * `offer` returns what the model is told for a queued call, or null when the
 * tool should just run (it only looks, or waits for its own tap).
 */
export class PlanDraft {
  readonly steps: PlanStep[] = [];

  constructor(readonly mode: PlanMode) {}

  offer(name: string, input: unknown): string | null {
    if (!isPlannable(name)) return null;
    if (this.steps.length >= PLAN_MAX_STEPS) throw new AthenaInputError(`A plan holds up to ${PLAN_MAX_STEPS} changes. Reply with what's queued, and say the rest can follow.`);
    const stands_for = randomUUID();
    const label = stepLabel(name, input);
    this.steps.push({ label, tool: name, input: withoutStep(input), stands_for });
    return JSON.stringify({ queued: label, id: stands_for, step: this.steps.length });
  }

  /**
   * What to do once the model has finished: nothing, run the one change now, or keep a plan for Go.
   * `hold`: nothing may run now, even one change (lib/ask-guard.ts): it's kept as a plan.
   */
  outcome(opts: { hold?: boolean } = {}): { kind: "none" } | { kind: "run"; step: PlanStep } | { kind: "plan"; steps: PlanStep[] } {
    if (!this.steps.length) return { kind: "none" };
    if (this.mode === "auto" && !opts.hold && this.steps.length < PLAN_MIN_STEPS) return { kind: "run", step: this.steps[0] };
    return { kind: "plan", steps: [...this.steps] };
  }
}

/** What a queued change's result says when it must wait for Go whatever else happens (lib/ask-guard.ts). */
export const WAITS_NOTE = "This one waits for the owner: it is not made until they tap Approve. In your reply say it's ready for them to confirm, never that it's done.";

/** Added to Ask's instructions: how changes are queued, made and planned. */
export const PLAN_RULE = `Changes wait for the owner: every tool that would change something answers "queued" and makes nothing yet. When you finish, a single change is made straight away; two or more go to the owner as a plan to tick and approve, and nothing changes until they tap Approve. So find what you need, queue every change the request needs, and give each its step line. A queued change's id stands for what it will make: use it in later changes (add_person's id as a to-do's person_id). With one change, reply as usual. With two or more, say in one short sentence what the plan does and that nothing changes until they tap Approve. Don't list the steps: the app shows them. A queued change whose result says waits_for_go is never made until the owner taps Approve, even when it's the only one: say it's ready for them to confirm, not that it's done.`;

/** Instead, for a routine's run: nobody is watching, so nothing is made. */
export const PROPOSE_RULE = `This runs on a schedule the owner set, with nobody watching, so nothing you queue is made: every change goes to the owner as a plan to tick and approve later. Find what you need, queue the changes the request asks for, give each its step line, and say in one short sentence what the plan would do. Don't list the steps: the app shows them.`;

// ---------- running a plan (Go) ----------

/** Swap stand-in ids for the real ones, anywhere in an input. */
export function substitute(input: unknown, ids: Map<string, string>): unknown {
  if (!ids.size) return input;
  if (typeof input === "string") {
    let s = input;
    for (const [from, to] of ids) s = s.split(from).join(to);
    return s;
  }
  if (Array.isArray(input)) return input.map((v) => substitute(v, ids));
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, substitute(v, ids)]));
  return input;
}

const usesAny = (input: unknown, ids: Set<string>): boolean => {
  if (!ids.size) return false;
  const text = JSON.stringify(input) ?? "";
  for (const id of ids) if (text.includes(id)) return true;
  return false;
};

/** What a step made, for later steps that named its stand-in: the thing it created, else the first thing it changed. */
const madeId = (changes: Change[]): string | null => (changes.find((c) => c.action === "created") ?? changes[0])?.id ?? null;

const readable = (error: unknown): string => {
  const m = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "ZodError") return "Athena couldn't read that step.";
  return clip(m || "That step didn't work.", 200);
};

/**
 * Run the ticked steps in order, through `run` (the same tool code a reply
 * uses). Unticked steps are skipped, and so is anything that needs what an
 * unticked or failed step would have made. A step that fails doesn't stop
 * the rest. Pure apart from `run`.
 */
export async function runSteps(steps: PlanStep[], ticked: ReadonlySet<number>, run: (tool: string, input: unknown) => Promise<Change[]>): Promise<StepResult[]> {
  const ids = new Map<string, string>();
  const missing = new Set<string>();
  const out: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    if (!ticked.has(i)) {
      missing.add(step.stands_for);
      out.push({ status: "skipped", changes: [] });
      continue;
    }
    if (usesAny(step.input, missing)) {
      missing.add(step.stands_for);
      out.push({ status: "skipped", error: "It needed a step that didn't run.", changes: [] });
      continue;
    }
    try {
      const changes = await run(step.tool, substitute(step.input, ids));
      const made = madeId(changes);
      if (made) ids.set(step.stands_for, made);
      else missing.add(step.stands_for);
      out.push({ status: "done", changes });
    } catch (error) {
      missing.add(step.stands_for);
      out.push({ status: "failed", error: readable(error), changes: [] });
    }
  }
  return out;
}

/** Undo all: newest change first. Each `undo` call records its own outcome; one that's refused doesn't stop the rest. */
export async function undoAllChanges(results: StepResult[], undo: (change: Change) => Promise<void>): Promise<Array<{ activity_id: string | undefined; ok: boolean; error?: string }>> {
  const changes = results.flatMap((r) => r.changes).filter((c) => c.undo);
  const out: Array<{ activity_id: string | undefined; ok: boolean; error?: string }> = [];
  for (const c of [...changes].reverse()) {
    try {
      await undo(c);
      out.push({ activity_id: c.activity_id, ok: true });
    } catch (error) {
      out.push({ activity_id: c.activity_id, ok: false, error: readable(error) });
    }
  }
  return out;
}

// ---------- kept plans (ask_plans) ----------

interface Payload {
  steps: PlanStep[];
  results?: StepResult[];
}

interface Row {
  id: string;
  source: "ask" | "routine";
  thread_id: string | null;
  routine_id: string | null;
  payload: string;
  created_at: string | Date;
  ran_at: string | Date | null;
}

export interface StoredPlan {
  id: string;
  source: "ask" | "routine";
  thread_id: string | null;
  routine_id: string | null;
  steps: PlanStep[];
  results: StepResult[] | null;
  created_at: string;
  ran_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());

function present(r: Row): StoredPlan | null {
  let p: Payload;
  try {
    p = JSON.parse(r.payload) as Payload;
  } catch {
    return null;
  }
  return { id: r.id, source: r.source, thread_id: r.thread_id, routine_id: r.routine_id, steps: p.steps ?? [], results: p.results ?? null, created_at: iso(r.created_at)!, ran_at: iso(r.ran_at) };
}

/** The card for a kept plan. */
export function planCard(p: Pick<StoredPlan, "id" | "source" | "steps" | "results" | "ran_at">, opts: { proposed?: boolean } = {}): PlanCard {
  return {
    id: p.id,
    source: p.source,
    steps: p.steps.map((s) => ({ label: s.label, tool: s.tool })),
    ...(opts.proposed ? { proposed: true } : {}),
    ...(p.ran_at && p.results ? { ran: { at: p.ran_at, results: p.results } } : {}),
  };
}

export async function savePlan(steps: PlanStep[], ctx: { source: "ask" | "routine"; thread_id?: string | null; routine_id?: string | null }): Promise<StoredPlan> {
  if (!steps.length) throw new AthenaInputError("A plan needs a step");
  const thread = ctx.thread_id && UUID.test(ctx.thread_id) ? ctx.thread_id : null;
  const routine = ctx.routine_id && UUID.test(ctx.routine_id) ? ctx.routine_id : null;
  const [row] = await q<Row>(
    `INSERT INTO ask_plans (source, thread_id, routine_id, payload) VALUES ($1, $2, $3, $4) RETURNING id, source, thread_id, routine_id, payload, created_at, ran_at`,
    [ctx.source, thread, routine, sealText(JSON.stringify({ steps } satisfies Payload))],
  );
  return present(row)!;
}

export async function getPlan(id: unknown): Promise<StoredPlan | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<Row>(`SELECT id, source, thread_id, routine_id, payload, created_at, ran_at FROM ask_plans WHERE id = $1::uuid`, [id]);
  return row ? present(row) : null;
}

/** Which steps the owner ticked: indexes into the plan, each once. */
export function parseTicked(raw: unknown, count: number): Set<number> {
  if (raw === undefined) return new Set(Array.from({ length: count }, (_, i) => i));
  if (!Array.isArray(raw) || raw.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new AthenaInputError(`ticked: step numbers from 0 to ${count - 1}`);
  return new Set(raw as number[]);
}

export interface GoDeps {
  /** One step, through the assistant's own tool code (lib/assistant.ts runPlanTool). */
  run: (tool: string, input: unknown) => Promise<Change[]>;
  /** What Ask did (lib/ask-activity.ts logChanges). */
  log: (changes: Change[], ctx: ActivityContext) => Promise<Change[]>;
}

/**
 * Go: run a kept plan's ticked steps once. A second Go (another device, a
 * double tap) gets the first one's results back and runs nothing.
 */
export async function goPlan(id: unknown, tickedRaw: unknown, deps: GoDeps): Promise<{ plan: PlanCard; changes: Change[] }> {
  const plan = await getPlan(id);
  if (!plan) throw new AthenaInputError("That plan isn't there any more", 404);
  const ticked = parseTicked(tickedRaw, plan.steps.length);
  const claimed = await qRaw<{ id: string }>(`UPDATE ask_plans SET ran_at = now() WHERE id = $1::uuid AND ran_at IS NULL RETURNING id`, [plan.id]);
  if (!claimed.length) {
    const done = (await getPlan(plan.id))!;
    return { plan: planCard(done), changes: (done.results ?? []).flatMap((r) => r.changes) };
  }
  if (!ticked.size) {
    await qRaw(`UPDATE ask_plans SET ran_at = NULL WHERE id = $1::uuid`, [plan.id]);
    throw new AthenaInputError("Tick at least one step");
  }
  // A routine plan with no routine is a Team run's (lib/team-chat.ts): What Ask did shows it as the team's, like the run's own changes.
  const ctx: ActivityContext = { source: plan.source === "routine" ? (plan.routine_id ? "routine" : "team") : "plan", thread_id: plan.thread_id, plan_id: plan.id, routine_id: plan.routine_id };
  const results = await runSteps(plan.steps, ticked, async (tool, input) => deps.log(await deps.run(tool, input), ctx));
  const [row] = await q<Row>(
    `UPDATE ask_plans SET payload = $2 WHERE id = $1::uuid RETURNING id, source, thread_id, routine_id, payload, created_at, ran_at`,
    [plan.id, sealText(JSON.stringify({ steps: plan.steps, results } satisfies Payload))],
  );
  const ran = present(row)!;
  return { plan: planCard(ran), changes: results.flatMap((r) => r.changes) };
}

/** Undo all of a plan that ran: through What Ask did, newest first. */
export async function undoPlan(id: unknown, undoActivity: (activityId: string) => Promise<ActivityEntry>): Promise<{ results: Array<{ activity_id: string | undefined; ok: boolean; error?: string }> }> {
  const plan = await getPlan(id);
  if (!plan) throw new AthenaInputError("That plan isn't there any more", 404);
  if (!plan.ran_at || !plan.results) throw new AthenaInputError("That plan hasn't run, so there's nothing to undo");
  const results = await undoAllChanges(plan.results, async (c) => {
    if (!c.activity_id) throw new AthenaInputError("That change wasn't kept in What Ask did");
    await undoActivity(c.activity_id);
  });
  return { results };
}
