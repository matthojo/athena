/**
 * Flows: the store (migration 0080; the contract is lib/flow-types.ts). A flow is a trigger and steps with
 * branches. The owner's words (its name, the whole trigger with any words it matches, its steps) are sealed in
 * `flows.payload`, as team_assistants does; what the jobs need is plain: `trigger_kind`, and `schedule` with
 * only days, times, counts and the facets an event filter names. A run's label, summary, error and state are
 * sealed; its status, what it waits for, and ids are plain, so the reminders job can find what's due.
 *
 * Also here: checking what the owner sends (FlowInput) against FLOW_LIMITS, and the two ports triggers uses:
 * createFlowSource() (which flows are on, with their triggers) and createFlowStarter() (queue a run). What a trigger
 * gives later steps is triggers' own (lib/flow-triggers.ts triggerGives); lib/flow-engine.ts plugs these in.
 */
import { z } from "zod";
import { AthenaInputError, q, qRaw, tx } from "./db";
import { sealText } from "./data-box";
import { parseTime } from "./routines";
import { eventFilterSchema } from "./team";
import { defaultGo, flowTool, isDraftTool } from "./flow-catalog";
import { allSteps, depthOf, eachStep, triggerValues, valueWords, type FlowValues, type Frame } from "./flow-steps";
import { triggerGives } from "./flow-triggers";
import type { ModelRef } from "./model-types";
import {
  FLOW_LIMITS,
  type Flow,
  type FlowInput,
  type FlowRun,
  type FlowRunStatus,
  type FlowRunStep,
  type FlowSource,
  type FlowStarter,
  type FlowStep,
  type FlowTrigger,
  type FlowWaitsFor,
} from "./flow-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: string | Date | null) => (v == null ? null : new Date(v).toISOString());
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------- checking what the owner sends ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = z.string().max(20).transform((s, ctx) => {
  try {
    return parseTime(s);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a time of day, like 09:00" });
    return z.NEVER;
  }
});
const words = (max: number) => z.string().max(max * 2).transform((s) => oneLine(s).slice(0, max));

const triggerSchema = z.union([
  z.object({ kind: z.literal("schedule"), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time }).strict(),
  z.object({ kind: z.literal("event"), event: eventFilterSchema }).strict(),
  z.object({ kind: z.literal("before"), what: z.literal("event"), minutes: z.number().int().min(1).max(7 * 24 * 60), withPeople: z.boolean().optional(), match: words(120).optional() }).strict(),
  z.object({ kind: z.literal("before"), what: z.literal("date"), days: z.number().int().min(0).max(FLOW_LIMITS.waitDays), at: time, eventKind: z.string().trim().min(1).max(40).optional(), match: words(120).optional() }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);

const ref = z.object({ from: z.string().min(1).max(40), key: z.string().min(1).max(40) }).strict();
const text = z.array(z.union([z.string().max(FLOW_LIMITS.text, `a piece of text is ${FLOW_LIMITS.text} characters at most`), ref])).max(40);
const value = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(60), kind: z.string().max(20) }).strict();
const stepId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "a step id: letters, digits, - and _");
const title = z.string().max(FLOW_LIMITS.name * 2).nullable().transform((s) => (s == null ? null : oneLine(s).slice(0, FLOW_LIMITS.name) || null));

const condition = z
  .object({
    left: ref,
    op: z.enum(["is", "is_not", "contains", "more_than", "less_than", "up_by_pct", "exists", "missing"]),
    right: z.union([ref, z.string().max(FLOW_LIMITS.text), z.number()]).optional(),
    against: ref.optional(),
  })
  .strict();

const stepSchema: z.ZodType<FlowStep> = z.lazy(() =>
  z.union([
    // `go` left out: defaultGo's (only a reminder, a to-do and a list item run alone).
    z.object({ id: stepId, title, kind: z.literal("tool"), tool: z.string().max(64), input: z.record(text), go: z.enum(["auto", "ask"]).optional(), gives: z.array(value).max(12) }).strict(),
    z.object({ id: stepId, title, kind: z.literal("check"), condition, yes: z.array(stepSchema), no: z.array(stepSchema) }).strict(),
    z
      .object({
        id: stepId,
        title,
        kind: z.literal("ask"),
        question: text,
        choices: z
          .array(z.object({ label: words(FLOW_LIMITS.name), steps: z.array(stepSchema) }).strict())
          .min(FLOW_LIMITS.minChoices, `Ask me needs ${FLOW_LIMITS.minChoices} choices at least`)
          .max(FLOW_LIMITS.choices, `Ask me offers ${FLOW_LIMITS.choices} choices at most`),
      })
      .strict(),
    z.object({ id: stepId, title, kind: z.literal("wait"), days: z.number().int().min(0).max(FLOW_LIMITS.waitDays, `a Wait is ${FLOW_LIMITS.waitDays} days at most`), before: ref.optional(), at: z.string().regex(HHMM).nullable() }).strict(),
    z.object({ id: stepId, title, kind: z.literal("notify"), text }).strict(),
    z.object({ id: stepId, title, kind: z.literal("think"), task: text, web: z.boolean(), gives: z.array(value).max(12) }).strict(),
    z.object({ id: stepId, title, kind: z.literal("assignment"), brief: text }).strict(),
  ]) as unknown as z.ZodType<FlowStep>,
);

const inputSchema = z
  .object({
    name: z.string().max(FLOW_LIMITS.name * 4).optional(),
    trigger: triggerSchema.optional(),
    steps: z.array(stepSchema).max(FLOW_LIMITS.steps).optional(),
    money: z.boolean().optional(),
    paused: z.boolean().optional(),
    origin: z.enum(["owner", "ask", "draft", "suggestion", "trigger", "shared"]).optional(),
  })
  .strict();

function parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new AthenaInputError(`${issue.path.join(".") || "input"}: ${issue.message}`);
}

/** Give every change step with no Go setting its default (defaultGo), in place. Pure apart from that. */
export function fillGo(steps: FlowStep[]): FlowStep[] {
  eachStep(steps, (s) => {
    if (s.kind === "tool" && s.go !== "auto" && s.go !== "ask") (s as { go: string }).go = defaultGo(s.tool);
  });
  return steps;
}

const refsIn = (t: unknown): Array<{ from: string; key: string }> => (Array.isArray(t) ? t.filter((p): p is { from: string; key: string } => !!p && typeof p === "object") : []);

/**
 * The rules zod can't say: FLOW_LIMITS' count, depth and choices, ids unique, each tool one a flow may use with only
 * its own fields, a draft always waiting for Go, and every chip pointing at the trigger or a step that comes before it
 * on the way there. Throws a line the editor can show. Pure.
 */
export function checkSteps(steps: FlowStep[], trigger: FlowTrigger): void {
  const all = allSteps(steps);
  if (all.length > FLOW_LIMITS.steps) throw new AthenaInputError(`A flow has ${FLOW_LIMITS.steps} steps at most, branches included`);
  if (depthOf(steps) > FLOW_LIMITS.depth) throw new AthenaInputError(`Branches go ${FLOW_LIMITS.depth} deep at most`);
  const ids = new Set<string>();
  for (const s of all) {
    if (ids.has(s.id)) throw new AthenaInputError(`Two steps share the id “${s.id}”`);
    ids.add(s.id);
  }
  const triggerKeys = new Set(triggerGives(trigger).map((g) => g.key));
  const check = (list: FlowStep[], before: Map<string, Set<string>>) => {
    const seen = new Map(before);
    for (const s of list) {
      const refs: Array<{ from: string; key: string }> = [];
      if (s.kind === "tool") {
        const tool = flowTool(s.tool);
        if (!tool) throw new AthenaInputError(`A flow can't use “${s.tool}”`);
        if (isDraftTool(s.tool) && s.go !== "ask") throw new AthenaInputError("A draft always waits for your approval: it's never sent, and approving only writes it");
        const fields = new Set(Object.keys((tool.input_schema as { properties?: object }).properties ?? {}));
        for (const [k, t] of Object.entries(s.input)) {
          if (!fields.has(k) || k === "step") throw new AthenaInputError(`“${s.tool}” has no field “${k}”`);
          refs.push(...refsIn(t));
        }
      } else if (s.kind === "check") refs.push(s.condition.left, ...(s.condition.against ? [s.condition.against] : []), ...(s.condition.right && typeof s.condition.right === "object" ? [s.condition.right] : []));
      else if (s.kind === "ask") {
        if (s.choices.length < FLOW_LIMITS.minChoices) throw new AthenaInputError(`Ask me needs ${FLOW_LIMITS.minChoices} choices at least`);
        if (s.choices.length > FLOW_LIMITS.choices) throw new AthenaInputError(`Ask me offers ${FLOW_LIMITS.choices} choices at most`);
        refs.push(...refsIn(s.question));
      }
      else if (s.kind === "wait" && s.before) refs.push(s.before);
      else if (s.kind === "notify") refs.push(...refsIn(s.text));
      else if (s.kind === "think") refs.push(...refsIn(s.task));
      else if (s.kind === "assignment") refs.push(...refsIn(s.brief));
      for (const r of refs) {
        if (r.from === "trigger") {
          if (!triggerKeys.has(r.key)) throw new AthenaInputError(`The trigger doesn't give “${r.key}”`);
        } else if (!seen.get(r.from)?.has(r.key)) throw new AthenaInputError(`A step uses “${r.key}” before any step gives it`);
      }
      if (s.kind === "check") {
        check(s.yes, seen);
        check(s.no, seen);
      } else if (s.kind === "ask") for (const c of s.choices) check(c.steps, seen);
      if (s.kind === "tool" || s.kind === "think") seen.set(s.id, new Set(s.gives.map((g) => g.key)));
      if (s.kind === "assignment") seen.set(s.id, new Set(["note"]));
    }
  };
  check(steps, new Map());
}

/** The plain half of a trigger, for the jobs: no words the owner typed. Pure. */
export function plainSchedule(t: FlowTrigger): Record<string, unknown> {
  switch (t.kind) {
    case "schedule":
      return { days: t.days, time: t.time };
    case "event": {
      const { match: _match, ...facets } = t.event;
      return { event: facets };
    }
    case "before":
      return t.what === "event" ? { what: "event", minutes: t.minutes, withPeople: t.withPeople === true } : { what: "date", days: t.days, at: t.at, ...(t.eventKind ? { eventKind: t.eventKind } : {}) };
    case "manual":
      return {};
  }
}

// ---------- flows ----------

interface FlowRow {
  id: string;
  payload: string;
  trigger_kind: FlowTrigger["kind"];
  assistant_id: string | null;
  handed_at: string | Date | null;
  money: boolean;
  paused: boolean;
  origin: Flow["origin"];
  last_run_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const F_COLUMNS = `id, payload, trigger_kind, assistant_id, handed_at, money, paused, origin, last_run_at, created_at, updated_at`;

interface Words {
  name: string;
  trigger: FlowTrigger;
  steps: FlowStep[];
}

function readJson<T>(raw: string | null): Partial<T> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    // Sealed under a key this deploy doesn't have: shown without its words, never run.
    return {};
  }
}

function presentFlow(r: FlowRow): Flow {
  const w = readJson<Words>(r.payload);
  const trigger: FlowTrigger = w.trigger ?? { kind: "manual" };
  return {
    id: r.id,
    name: w.name ?? "",
    trigger,
    trigger_gives: triggerGives(trigger),
    steps: Array.isArray(w.steps) ? w.steps : [],
    assistant_id: r.assistant_id,
    handed_at: iso(r.handed_at),
    money: r.money,
    paused: r.paused,
    origin: r.origin,
    last_run_at: iso(r.last_run_at),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

export async function listFlows(): Promise<Flow[]> {
  return (await q<FlowRow>(`SELECT ${F_COLUMNS} FROM flows ORDER BY created_at, id`)).map(presentFlow);
}

export async function getFlow(id: unknown): Promise<Flow | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<FlowRow>(`SELECT ${F_COLUMNS} FROM flows WHERE id = $1::uuid`, [id]);
  return row ? presentFlow(row) : null;
}

/**
 * Flows that count toward FLOW_LIMITS.flows: not an assistant's job flows (lib/team-flows.ts), which stand for its
 * triggers and count toward its MAX_TRIGGERS instead, as the triggers did.
 */
const NOT_JOB = `NOT (assistant_id IS NOT NULL AND origin IN ('trigger', 'shared'))`;

const FULL = `You have ${FLOW_LIMITS.flows} flows, which is the most Athena keeps. Remove one first.`;

/** A new flow. Left out: the name "New flow", a manual trigger, no steps, money off, on. Refused past FLOW_LIMITS.flows. */
export async function createFlow(raw: unknown): Promise<Flow> {
  const input = parse(inputSchema, raw ?? {}) as FlowInput;
  const trigger: FlowTrigger = input.trigger ?? { kind: "manual" };
  const steps = fillGo(input.steps ?? []);
  checkSteps(steps, trigger);
  const w: Words = { name: oneLine(input.name ?? "").slice(0, FLOW_LIMITS.name) || "New flow", trigger, steps };
  const [row] = await q<FlowRow>(
    `INSERT INTO flows (payload, trigger_kind, schedule, money, paused, origin)
     SELECT $1, $2, $3::jsonb, $4, $5, $6 WHERE (SELECT count(*) FROM flows WHERE ${NOT_JOB}) < $7
     RETURNING ${F_COLUMNS}`,
    [sealText(JSON.stringify(w)), trigger.kind, JSON.stringify(plainSchedule(trigger)), input.money === true, input.paused === true, input.origin ?? "owner", FLOW_LIMITS.flows],
  );
  if (!row) throw new AthenaInputError(FULL);
  return presentFlow(row);
}

/** Change what the owner may set. Steps and the trigger are checked together. */
export async function updateFlow(id: unknown, raw: unknown): Promise<Flow> {
  const was = await getFlow(id);
  if (!was) throw new AthenaInputError("That flow isn't there any more", 404);
  const input = parse(inputSchema, raw ?? {}) as FlowInput;
  const trigger = input.trigger ?? was.trigger;
  const steps = input.steps ? fillGo(input.steps) : was.steps;
  checkSteps(steps, trigger);
  const w: Words = { name: input.name !== undefined ? oneLine(input.name).slice(0, FLOW_LIMITS.name) || was.name : was.name, trigger, steps };
  const [row] = await q<FlowRow>(
    `UPDATE flows SET payload = $2, trigger_kind = $3, schedule = $4::jsonb, money = $5, paused = $6, origin = $7, updated_at = now() WHERE id = $1::uuid RETURNING ${F_COLUMNS}`,
    [was.id, sealText(JSON.stringify(w)), trigger.kind, JSON.stringify(plainSchedule(trigger)), input.money ?? was.money, input.paused ?? was.paused, input.origin ?? was.origin],
  );
  if (!row) throw new AthenaInputError("That flow isn't there any more", 404);
  return presentFlow(row);
}

/** Gone with its runs. Their cards leave Home, and anything they waited on in Ask stays there as a plan. */
export async function deleteFlow(id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !UUID.test(id)) return false;
  await qRaw(`UPDATE nudges SET dismissed_at = now() WHERE dismissed_at IS NULL AND key LIKE 'flow:%' AND split_part(key, ':', 2) IN (SELECT id::text FROM flow_runs WHERE flow_id = $1::uuid)`, [id]);
  const rows = await qRaw<{ id: string }>(`DELETE FROM flows WHERE id = $1::uuid RETURNING id`, [id]);
  // Its claimed fires (migration 0081) have no foreign key: they go with it.
  await qRaw(`DELETE FROM flow_trigger_fires WHERE flow_id = $1`, [id]);
  return rows.length > 0;
}

/** Hand it to an assistant (an id), or take it back (null). */
export async function setFlowAssistant(id: string, assistantId: string | null, now = new Date()): Promise<Flow> {
  const [row] = await q<FlowRow>(`UPDATE flows SET assistant_id = $2::uuid, handed_at = $3, updated_at = now() WHERE id = $1::uuid RETURNING ${F_COLUMNS}`, [id, assistantId, assistantId ? now.toISOString() : null]);
  if (!row) throw new AthenaInputError("That flow isn't there any more", 404);
  return presentFlow(row);
}

// ---------- runs ----------

/** A card a run has to send: a Notify step's, one saying it waits for the owner, or an assistant's "From <Name>". */
export interface Notice {
  key: string;
  title: string;
  body: string;
  /** When it stops being worth sending. */
  until: string;
  /** Sent, or not to be sent (switched off, muted, past the cap). Held for quiet hours: neither yet. */
  done?: boolean;
}

/** What a run is waiting on, as the runner needs it. */
export interface Waiting {
  step_id: string;
  kind: FlowWaitsFor;
  plan_id?: string;
  assignment_id?: string;
  /** go: the change's words and input, kept so Go and Skip don't need the flow to be unchanged. */
  tool?: string;
  input?: Record<string, unknown>;
  /** think: the assistant's plan; its changes, once Go runs them, count as this step's. */
  think?: boolean;
}

/** Everything a run carries between steps, sealed in flow_runs.state. */
export interface RunState {
  values: FlowValues;
  lines: FlowRunStep[];
  stack: Frame[];
  waiting: Waiting | null;
  notices: Notice[];
  /** What it changed, for its summary: kinds and actions only. */
  changes: Array<{ kind: string; action: "created" | "updated" | "completed" }>;
  /** Started by hand (Run now, a try): the owner is looking, so no card says it waits or failed. */
  by_hand?: boolean;
  /** The owner's zone when it last ran, so its values read as words (FlowRun.values) on any read. */
  tz?: string;
  /** Its think step's turn, when one kept a conversation: what Recent runs and the "From <Name>" card say (lib/flow-run.ts). */
  turn?: { thread_id: string; summary: string; quiet: boolean; model?: ModelRef; fell_back?: boolean; tried?: ModelRef };
  /** Its run on Team, while an assistant runs it, and whether that run has posted in Team chat yet. */
  team?: { run_id: string; told?: boolean };
  /** Tried once more after it failed before anything ran (lib/flow-run.ts triesAgain); a second failure is final. */
  retried?: boolean;
  /** A step ran that may have changed something (a change, a draft assignment, a turn that made something): never tried again. */
  touched?: boolean;
  /** Tried again and not yet picked up: its run on Team starts working again when it is. */
  again?: boolean;
}

export const emptyState = (values: FlowValues = {}, byHand = false): RunState => ({ values, lines: [], stack: [{ path: [], i: 0 }], waiting: null, notices: [], changes: [], ...(byHand ? { by_hand: true } : {}) });

interface RunRow {
  id: string;
  flow_id: string;
  status: FlowRunStatus;
  waits_for: FlowWaitsFor | null;
  label: string | null;
  assistant_id: string | null;
  summary: string | null;
  error: string | null;
  state: string;
  dry: boolean;
  resumes_at: string | Date | null;
  waiting_since: string | Date | null;
  plan_id: string | null;
  assignment_id: string | null;
  notices_pending: boolean;
  made: string[] | null;
  event_ids: Array<string | number> | null;
  slot: string | null;
  started_by: string | null;
  chain: string[] | null;
  version: number;
  started_at: string | Date;
  finished_at: string | Date | null;
}

const R_COLUMNS = `id, flow_id, status, waits_for, label, assistant_id, summary, error, state, dry, resumes_at, waiting_since, plan_id, assignment_id, notices_pending, made, event_ids, slot, started_by, chain, version, started_at, finished_at`;

/** A run as the store keeps it: the contract's FlowRun, plus what only the server reads. */
export interface StoredRun {
  run: FlowRun;
  state: RunState;
  version: number;
  made: string[];
  event_ids: string[];
  resumes_at: string | null;
  waiting_since: string | null;
  /** The run whose change set this one off, if one did. */
  started_by: string | null;
  /** The flows of every run before it on the way, oldest first. */
  chain: string[];
}

function readState(raw: string): RunState {
  const s = readJson<RunState>(raw);
  return {
    values: s.values ?? {},
    lines: Array.isArray(s.lines) ? s.lines : [],
    stack: Array.isArray(s.stack) ? s.stack : [],
    waiting: s.waiting ?? null,
    notices: Array.isArray(s.notices) ? s.notices : [],
    changes: Array.isArray(s.changes) ? s.changes : [],
    ...(s.by_hand ? { by_hand: true } : {}),
    ...(typeof s.tz === "string" ? { tz: s.tz } : {}),
    ...(s.turn && typeof s.turn.thread_id === "string" ? { turn: s.turn as RunState["turn"] } : {}),
    ...(s.team && typeof s.team.run_id === "string" ? { team: s.team as RunState["team"] } : {}),
    ...(s.retried ? { retried: true } : {}),
    ...(s.touched ? { touched: true } : {}),
    ...(s.again ? { again: true } : {}),
  };
}

/**
 * What the trigger and each step gave, as plain words (FlowRun.values): a record as its title, money as "£38.00", a
 * day as "Tue 3 Dec". Empty values are left out. Pure.
 */
export function shownValues(values: FlowValues, tz?: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [from, vals] of Object.entries(values ?? {})) {
    if (!vals || typeof vals !== "object") continue;
    const words: Record<string, string> = {};
    for (const [key, v] of Object.entries(vals)) {
      const w = valueWords(v, tz).trim();
      if (w) words[key] = w.length > 500 ? `${w.slice(0, 499)}…` : w;
    }
    if (Object.keys(words).length) out[from] = words;
  }
  return out;
}

function presentRun(r: RunRow): StoredRun {
  const state = readState(r.state);
  return {
    run: {
      id: r.id,
      flow_id: r.flow_id,
      status: r.status,
      waits_for: r.status === "waiting" ? r.waits_for : null,
      label: r.label ?? "",
      assistant_id: r.assistant_id,
      summary: r.summary,
      steps: state.lines,
      values: shownValues(state.values, state.tz),
      dry: r.dry,
      error: r.error,
      started_at: iso(r.started_at)!,
      finished_at: iso(r.finished_at),
    },
    state,
    version: r.version,
    made: r.made ?? [],
    event_ids: (r.event_ids ?? []).map(String),
    resumes_at: iso(r.resumes_at),
    waiting_since: iso(r.waiting_since),
    started_by: r.started_by ?? null,
    chain: r.chain ?? [],
  };
}

export async function getRun(id: unknown): Promise<StoredRun | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await q<RunRow>(`SELECT ${R_COLUMNS} FROM flow_runs WHERE id = $1::uuid`, [id]);
  return row ? presentRun(row) : null;
}

/** One flow's runs, newest first. */
export async function listRuns(flowId: string, limit: number = FLOW_LIMITS.runsKept): Promise<FlowRun[]> {
  if (!UUID.test(flowId)) return [];
  return (await q<RunRow>(`SELECT ${R_COLUMNS} FROM flow_runs WHERE flow_id = $1::uuid ORDER BY started_at DESC, id LIMIT $2`, [flowId, limit])).map((r) => presentRun(r).run);
}

/** The newest run of each flow, by flow id. */
export async function latestRuns(): Promise<Record<string, FlowRun>> {
  const rows = await q<RunRow>(`SELECT DISTINCT ON (flow_id) ${R_COLUMNS} FROM flow_runs ORDER BY flow_id, started_at DESC, id`);
  return Object.fromEntries(rows.map((r) => [r.flow_id, presentRun(r).run]));
}

/** Runs in these states, oldest first, for the jobs. */
export async function runsWhere(sql: string, params: unknown[] = [], limit = 50): Promise<StoredRun[]> {
  return (await q<RunRow>(`SELECT ${R_COLUMNS} FROM flow_runs WHERE ${sql} ORDER BY started_at LIMIT ${Math.max(1, Math.min(200, limit))}`, params)).map(presentRun);
}

/** Queue a run. Null when its slot already started one. */
export async function insertRun(
  flow: Pick<Flow, "id" | "assistant_id">,
  from: { label: string; values: FlowValues; event_ids?: string[]; slot?: string | null; dry?: boolean; byHand?: boolean; started_by?: string | null; chain?: string[] },
): Promise<StoredRun | null> {
  const ids = (from.event_ids ?? []).map(Number).filter(Number.isSafeInteger);
  const chain = (from.chain ?? []).filter((id) => UUID.test(id));
  const [row] = await q<RunRow>(
    `INSERT INTO flow_runs (flow_id, status, label, assistant_id, state, dry, event_ids, slot, started_by, chain) VALUES ($1::uuid, 'queued', $2, $3::uuid, $4, $5, $6::jsonb, $7, $8::uuid, $9::uuid[])
     ON CONFLICT (flow_id, slot) WHERE slot IS NOT NULL DO NOTHING RETURNING ${R_COLUMNS}`,
    [
      flow.id,
      sealText(oneLine(from.label).slice(0, 200) || "Run now"),
      flow.assistant_id,
      // What the trigger gave, in the shapes a run reads, however it was started (a pass, the owner, Run now, a try).
      sealText(JSON.stringify(emptyState({ ...from.values, trigger: triggerValues(from.values.trigger) }, from.byHand === true || from.dry === true))),
      from.dry === true,
      JSON.stringify(ids),
      from.slot ?? null,
      from.started_by && UUID.test(from.started_by) ? from.started_by : null,
      chain,
    ],
  );
  return row ? presentRun(row) : null;
}

/** What a write to a run sets. Left out: kept. */
export interface RunPatch {
  status?: FlowRunStatus;
  waits_for?: FlowWaitsFor | null;
  summary?: string | null;
  error?: string | null;
  state?: RunState;
  resumes_at?: string | null;
  waiting_since?: string | null;
  plan_id?: string | null;
  assignment_id?: string | null;
  made?: string[];
  finished?: boolean;
}

/**
 * Write a run, only if nobody wrote it since `version` (another device's answer, the reminders job). False when
 * someone did: nothing is written, and the caller reads it again.
 */
export async function saveRun(id: string, version: number, p: RunPatch): Promise<boolean> {
  const sets: string[] = ["version = version + 1", "updated_at = now()"];
  const params: unknown[] = [id, version];
  const put = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (p.status !== undefined) put("status", p.status);
  if (p.waits_for !== undefined) put("waits_for", p.waits_for);
  if (p.summary !== undefined) put("summary", p.summary ? sealText(p.summary) : null);
  if (p.error !== undefined) put("error", p.error ? sealText(p.error) : null);
  if (p.state !== undefined) {
    put("state", sealText(JSON.stringify(p.state)));
    put("notices_pending", p.state.notices.some((n) => !n.done));
  }
  if (p.resumes_at !== undefined) put("resumes_at", p.resumes_at, "::timestamptz");
  if (p.waiting_since !== undefined) put("waiting_since", p.waiting_since, "::timestamptz");
  if (p.plan_id !== undefined) put("plan_id", p.plan_id, "::uuid");
  if (p.assignment_id !== undefined) put("assignment_id", p.assignment_id, "::uuid");
  if (p.made !== undefined) put("made", [...new Set(p.made)].slice(-500), "::text[]");
  if (p.finished === true) sets.push("finished_at = now()");
  if (p.finished === false) sets.push("finished_at = NULL");
  const rows = await qRaw<{ id: string }>(`UPDATE flow_runs SET ${sets.join(", ")} WHERE id = $1::uuid AND version = $2 RETURNING id`, params);
  return rows.length > 0;
}

/** Ids of records a run just changed, kept at once (not at the run's next save) so the trigger pass can't start this flow from them. */
export async function noteMade(id: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await qRaw(`UPDATE flow_runs SET made = (made || $2::text[])[greatest(1, cardinality(made || $2::text[]) - 499):] WHERE id = $1::uuid`, [id, ids]);
}

/** queued → running, once: false when another function has it. */
export async function claimRun(id: string): Promise<boolean> {
  const rows = await qRaw<{ id: string }>(`UPDATE flow_runs SET status = 'running', version = version + 1, updated_at = now() WHERE id = $1::uuid AND status = 'queued' RETURNING id`, [id]);
  return rows.length > 0;
}

/** Keep FLOW_LIMITS.runsKept runs per flow: the oldest finished ones go. */
export async function pruneRuns(flowId: string): Promise<void> {
  await qRaw(
    `DELETE FROM flow_runs WHERE flow_id = $1::uuid AND status IN ('done', 'failed', 'stopped')
       AND id NOT IN (SELECT id FROM flow_runs WHERE flow_id = $1::uuid ORDER BY started_at DESC, id LIMIT $2)`,
    [flowId, FLOW_LIMITS.runsKept],
  );
}

export async function touchFlowRun(flowId: string, now = new Date()): Promise<void> {
  await qRaw(`UPDATE flows SET last_run_at = $2 WHERE id = $1::uuid`, [flowId, now.toISOString()]);
}

// ---------- the ports triggers uses ----------

/** FlowSource: every flow that's on, with its trigger. A paused assistant's flows don't start, as its triggers didn't. */
export function createFlowSource(): FlowSource {
  return {
    async listActive() {
      const rows = await q<FlowRow>(`SELECT ${F_COLUMNS} FROM flows WHERE NOT paused AND (assistant_id IS NULL OR assistant_id NOT IN (SELECT id FROM team_assistants WHERE paused)) ORDER BY created_at, id`);
      return rows.map(presentFlow).map((f) => ({ id: f.id, name: f.name, trigger: f.trigger, assistant_id: f.assistant_id, origin: f.origin, handed_at: f.handed_at, created_at: f.created_at }));
    },
  };
}

/** The most runs one chain of flows may have: a run whose change starts a flow, whose change starts another, and no more. */
export const CHAIN_MAX = 3;

/** A run whose change set events off, as the chain guard needs it. */
export interface ChainParent {
  id: string;
  flow_id: string;
  chain: string[];
}

/**
 * The run whose change set these events off: the newest run, of any flow, that made one of their records in the last 7
 * days. Null when no run did (the owner, a sync, a Team assistant).
 */
export async function startedByRun(eventIds: string[]): Promise<ChainParent | null> {
  const ids = eventIds.map(Number).filter(Number.isSafeInteger);
  if (!ids.length) return null;
  const refs = (await qRaw<{ ref_id: string | null }>(`SELECT ref_id FROM team_events WHERE id = ANY($1::bigint[])`, [ids])).map((r) => r.ref_id).filter((r): r is string => !!r);
  if (!refs.length) return null;
  const [row] = await qRaw<{ id: string; flow_id: string; chain: string[] | null }>(
    `SELECT id, flow_id, chain FROM flow_runs WHERE made && $1::text[] AND started_at > now() - interval '7 days' ORDER BY started_at DESC LIMIT 1`,
    [refs],
  );
  return row ? { id: row.id, flow_id: row.flow_id, chain: row.chain ?? [] } : null;
}

/**
 * Where a new run of `flowId` sits in its chain. Started by no run: a chain of its own. Refused when its flow is already
 * in the chain (A → B → A, or A → A) or the chain would pass CHAIN_MAX runs. Pure.
 */
export function chainFor(flowId: string, parent: ChainParent | null): { started_by: string | null; chain: string[] } | { refused: string } {
  if (!parent) return { started_by: null, chain: [] };
  const chain = [...parent.chain, parent.flow_id];
  if (chain.includes(flowId)) return { refused: "its flow already ran in this chain" };
  if (chain.length + 1 > CHAIN_MAX) return { refused: `a chain of flows stops at ${CHAIN_MAX} runs` };
  return { started_by: parent.id, chain };
}

/** The default hand-off: to this site's own background function (Netlify's URL). Without one, the next reminders pass hands it off. */
async function handOffToSite(runId: string): Promise<void> {
  const { flowOrigin, handOffFlowRun } = await import("./flow-effects");
  const origin = flowOrigin();
  if (origin) await handOffFlowRun(origin, runId);
}

export interface StarterDeps {
  /** Hand a queued run to the background function (lib/flow-effects.ts handOffFlowRun; the site's own by default). A failure leaves it queued for the next pass. */
  handOff?: (runId: string) => Promise<void>;
}

/**
 * FlowStarter: queue a run of a flow that's on, with what its trigger gives, and hand it to the background
 * function. Null when the flow is paused or gone, its slot already ran, or the chain guard refuses it: the events
 * that set it off came from a run (its own, or another flow's) whose chain already has this flow, or is CHAIN_MAX
 * runs long. A run started by another run's change records that run (`started_by`) and its chain.
 */
export function createFlowStarter(deps: StarterDeps = {}): FlowStarter {
  return {
    async start(flowId, start) {
      const flow = await getFlow(flowId);
      if (!flow || flow.paused) return null;
      const place = chainFor(flow.id, start.event_ids?.length ? await startedByRun(start.event_ids) : null);
      if ("refused" in place) return null;
      const values = { trigger: (start.values ?? {}) as FlowValues[string] };
      const made = await insertRun(flow, { label: start.label, values, event_ids: start.event_ids, slot: start.slot ?? null, started_by: place.started_by, chain: place.chain });
      if (!made) return null;
      const handOff = deps.handOff ?? handOffToSite;
      await handOff(made.run.id).catch((e) => console.error("Athena flows: couldn't hand off a run", e instanceof Error ? e.message.slice(0, 120) : e));
      return made.run.id;
    },
  };
}
