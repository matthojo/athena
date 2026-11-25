/**
 * Flows: the shared types and limits. A flow is a trigger and a list of steps
 * that run in order, with branches. It stands beside Team: a plain flow runs
 * with no character and costs nothing but its thinking steps, and a flow can be
 * handed to a Team assistant, which then runs it in its own voice, with its
 * memory and allowlist, and can add thinking steps.
 *
 * This file is the contract between the engine (lib/flows*.ts,
 * netlify/lib/flow-routes.ts), triggers (lib/flow-triggers.ts), drafting
 * (lib/flow-draft.ts), suggestions (lib/flow-suggest.ts) and the app
 * (app/src/flows/). Types and constants only, so both sides can import it.
 * Change a shape here, in its own pull request, before code relies on it.
 */
import type { EventFilter, TeamWeekday } from "./team-types";

export const FLOW_LIMITS = {
  /** Flows one Athena keeps, on or off. */
  flows: 40,
  /** Steps in one flow, branches included. */
  steps: 24,
  /** How deep branches may nest (a Check inside a Check's branch is 2). */
  depth: 3,
  /** Choices an Ask me step offers: at least this many… */
  minChoices: 2,
  /** …and at most this many. */
  choices: 4,
  name: 60,
  /** One piece of literal text in a step. */
  text: 500,
  /** The longest a Wait step may wait, in days. */
  waitDays: 60,
  /** Runs kept per flow. */
  runsKept: 50,
  /** A run that waits for Go or an answer this long is stopped. */
  waitForOwnerDays: 14,
} as const;

// ---------- values that pass between steps ----------

/**
 * What kind of thing a value is, so the app colours its chip like the graph
 * does and a later step knows what it can do with it. `text`, `number`,
 * `money` and `date` are plain values; the rest are records in Athena.
 */
export const VALUE_KINDS = ["text", "number", "money", "date", "datetime", "person", "organisation", "place", "event", "note", "todo", "saved", "email", "trip"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** A value a trigger or step gives later steps: "the company", "the price". */
export interface FlowValue {
  /** Stable within its step: "company", "price", "renewal_date". */
  key: string;
  /** As the chip reads: "the company". */
  label: string;
  kind: ValueKind;
}

/** A pointer to a value: the trigger's (`from: "trigger"`) or an earlier step's (its id). */
export interface ValueRef {
  from: "trigger" | string;
  key: string;
}

/**
 * Text with values in it, as the step editor shows it: literal strings and
 * chips, in order. ["Decide on ", {from:"trigger",key:"company"}, " renewal"].
 */
export type FlowText = Array<string | ValueRef>;

// ---------- what starts a flow ----------

export type FlowTrigger =
  /** On chosen weekdays at a time in the owner's zone (Team's schedule trigger). */
  | { kind: "schedule"; days: TeamWeekday[]; time: string }
  /** Something arrived in Athena (Team's event trigger: team_events). */
  | { kind: "event"; event: EventFilter }
  /**
   * Relative to a time Athena knows. `event`: `minutes` before a timed event
   * on the calendar, only those with at least one person from the owner's
   * People when `withPeople` is set. `date`: `days` before a date (a
   * birthday, a deadline, a renewal), `at` HH:MM in the owner's zone.
   */
  | { kind: "before"; what: "event"; minutes: number; withPeople?: boolean; match?: string }
  | { kind: "before"; what: "date"; days: number; at: string; eventKind?: string; match?: string }
  /** Only by hand: Run now, a Shortcut, or a test. */
  | { kind: "manual" };

// ---------- steps ----------

/** Whether a step that changes something runs alone, or waits for the owner's Go. */
export type GoMode = "auto" | "ask";

export type CheckOp = "is" | "is_not" | "contains" | "more_than" | "less_than" | "up_by_pct" | "exists" | "missing";

export interface FlowCondition {
  left: ValueRef;
  op: CheckOp;
  /** Missing for `exists` and `missing`. A number for `up_by_pct` (10 = 10%), compared with `against`. */
  right?: ValueRef | string | number;
  /** `up_by_pct`: the value `left` is compared against. */
  against?: ValueRef;
}

interface StepBase {
  /** Unique within the flow; values refer to it. */
  id: string;
  /** Owner's own title, or null for the step's default words. */
  title: string | null;
}

export type FlowStep =
  /**
   * One of Ask's tools (lib/assistant.ts), the same code and checks Ask uses:
   * a look (find_notes, find_people, money, weather, flight_status…) or a change
   * (add_todo, add_reminder, save_note, add_to_list, draft_email…). `input`
   * maps the tool's fields to text with values in it. Tools that send, edit an
   * account or delete are never offered. A change obeys `go`.
   */
  | (StepBase & { kind: "tool"; tool: string; input: Record<string, FlowText>; go: GoMode; gives: FlowValue[] })
  /** Two branches: `yes` when the condition holds, `no` otherwise. */
  | (StepBase & { kind: "check"; condition: FlowCondition; yes: FlowStep[]; no: FlowStep[] })
  /** A question with choices, each its own branch. The run waits for the answer. */
  | (StepBase & { kind: "ask"; question: FlowText; choices: Array<{ label: string; steps: FlowStep[] }> })
  /** Pauses the run until a time: `days` after now or before a date value, at `at`. */
  | (StepBase & { kind: "wait"; days: number; before?: ValueRef; at: string | null })
  /** A push and a card on Home, within quiet hours and the daily cap. */
  | (StepBase & { kind: "notify"; text: FlowText })
  /** The assistant that runs the flow thinks about `task` and gives values. Only in a flow with an assistant. */
  | (StepBase & { kind: "think"; task: FlowText; web: boolean; gives: FlowValue[] })
  /** Starts a Team assignment from `brief`. Its lineup waits for the owner's Go, as Ask's does. */
  | (StepBase & { kind: "assignment"; brief: FlowText });

export type FlowStepKind = FlowStep["kind"];

// ---------- a flow ----------

export interface Flow {
  id: string;
  name: string;
  trigger: FlowTrigger;
  /** What the trigger gives later steps. Filled by the server from the trigger. */
  trigger_gives: FlowValue[];
  steps: FlowStep[];
  /** The Team assistant that runs it, or null for a plain flow. */
  assistant_id: string | null;
  /** When it was handed to that assistant. */
  handed_at: string | null;
  /** May its steps read spending? Only while Ask may, too (Settings). */
  money: boolean;
  /** Off: its trigger doesn't start it. Run now still does. */
  paused: boolean;
  /** Where it came from. `trigger`: an assistant's trigger turned into a flow. */
  origin: "owner" | "ask" | "draft" | "suggestion" | "trigger" | "shared";
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Blanks a shared flow came with that nobody filled when it was added (lib/flow-share.ts importSharedFlow): the
   * step stays, but the flow can't be switched on until the owner sets each field. Missing when there are none.
   */
  unfilled?: FlowUnfilled[];
}

/** A field a shared flow left for the owner to fill: the step, the field ("input.person_id", "text"), and the question it asked. */
export interface FlowUnfilled {
  step_id: string;
  field: string;
  question: string;
}

/** POST /api/flows and PATCH /api/flows/:id. Everything the owner can set. */
export interface FlowInput {
  name?: string;
  trigger?: FlowTrigger;
  steps?: FlowStep[];
  money?: boolean;
  paused?: boolean;
  origin?: Flow["origin"];
}

// ---------- runs ----------

export type FlowRunStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
/** `go`: a change waits. `answer`: an Ask me step. `time`: a Wait step. `assignment`: an assignment is running. */
export type FlowWaitsFor = "go" | "answer" | "time" | "assignment";
export type FlowRunStepStatus = "done" | "waiting" | "skipped" | "failed";

/** One step as it ran: the line the run page shows. */
export interface FlowRunStep {
  step_id: string;
  status: FlowRunStepStatus;
  /** "Found 12 payments to Northwind Broadband. Last December: £32.00 a month." */
  line: string;
  /** For a waiting change: what it will do, in words, and the Ask plan it waits in. */
  pending?: { text: string; plan_id: string } | null;
  /** For a waiting Ask me step. */
  question?: { text: string; choices: string[] } | null;
  /** For a Wait step: when it carries on. */
  resumes_at?: string | null;
  at: string;
}

export interface FlowRun {
  id: string;
  flow_id: string;
  status: FlowRunStatus;
  waits_for: FlowWaitsFor | null;
  /** What set it off, in words: "An email from Northwind Broadband", "Run now". */
  label: string;
  /** The assistant that ran it, if any (it may have been handed over since). */
  assistant_id: string | null;
  /** In the assistant's voice when it has one, else plain. */
  summary: string | null;
  steps: FlowRunStep[];
  /**
   * What the trigger and each step gave, by step id ("trigger" for the
   * trigger), then by FlowValue key: { trigger: { company: "Northwind
   * Broadband" }, s2: { last_price: "£32.00" } }. Shown as plain words, so a
   * record value is its title. Sealed at rest. The step settings preview
   * reads the newest run's. Missing on runs from before it was kept.
   */
  values?: Record<string, Record<string, string>>;
  /** A try on past data: nothing was changed. */
  dry: boolean;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

// ---------- the step catalogue (GET /api/flows/catalog) ----------

/** One thing the Add a step sheet offers. */
export interface CatalogEntry {
  kind: FlowStepKind;
  /** For `tool`: the tool's name. */
  tool?: string;
  group: "find" | "add" | "decide" | "tell" | "team";
  label: string;
  hint: string;
  /** Changes something, so it has a Go setting. */
  changes: boolean;
  /** Reads spending: needs the flow's `money`. */
  money?: boolean;
  /** Needs the flow to have an assistant (think). */
  needsAssistant?: boolean;
  /** The tool's fields, for the step's settings sheet. */
  fields: Array<{ key: string; label: string; kind: ValueKind; required: boolean }>;
  gives: FlowValue[];
}

// ---------- suggestions and drafts ----------

/** "You add a reminder after every delivery email": a flow Athena offers. */
export interface FlowSuggestion {
  id: string;
  /** One line: "You add a reminder after every delivery email". */
  title: string;
  /** Why: "Six times this month." */
  why: string;
  flow: FlowInput & { name: string; trigger: FlowTrigger; steps: FlowStep[] };
}

/** POST /api/flows/draft { sentence }: what Athena draws from one sentence. Nothing is saved. */
export interface FlowDraft {
  flow: FlowInput & { name: string; trigger: FlowTrigger; steps: FlowStep[] };
  /** Things it couldn't place, in words, for the editor to show. */
  notes: string[];
  /** The model couldn't help: an empty flow with the sentence as its name. */
  fallback?: true;
}

/** Ask's propose_flow card on a reply: the flow, kept as a paused draft until the owner turns it on. */
export interface AskFlowCard {
  flow_id: string;
  flow: Pick<Flow, "name" | "trigger" | "trigger_gives" | "steps" | "assistant_id">;
}

// ---------- routes (netlify/lib/flow-routes.ts unless noted) ----------
//
// GET    /api/flows                       → FlowListResponse
// POST   /api/flows            FlowInput  → { flow: Flow }
// GET    /api/flows/catalog               → { entries: CatalogEntry[] }
// GET    /api/flows/:id                   → { flow: Flow; runs: FlowRun[] }
// PATCH  /api/flows/:id        FlowInput  → { flow: Flow }
// DELETE /api/flows/:id                   → { ok: true }
// POST   /api/flows/:id/run    { dry?: boolean }  → { run: FlowRun }   (dry: on the last thing that matched)
// POST   /api/flows/:id/hand   { assistant_id: string | "new" }  → { flow: Flow }
// POST   /api/flows/:id/take-back         → { flow: Flow }
// GET    /api/flows/runs/:runId           → { run: FlowRun }
// POST   /api/flows/runs/:runId/answer  { step_id, choice: number }  → { run: FlowRun }
// POST   /api/flows/runs/:runId/go      { step_id }  → { run: FlowRun }   (runs the waiting change through Ask's plan code, then carries on)
// POST   /api/flows/runs/:runId/skip    { step_id }  → { run: FlowRun }   (drops it and carries on)
// POST   /api/flows/runs/:runId/stop      → { run: FlowRun }
//   A waiting change is kept as an Ask plan (lib/ask-plans.ts, `pending.plan_id`), so its receipt and Undo are Ask's.
// POST   /api/flows/draft      { sentence: string }  → { draft: FlowDraft }       (netlify/lib/flow-draft-routes.ts)
// GET    /api/flows/suggestions           → { suggestions: FlowSuggestion[] }  (netlify/lib/flow-suggest-routes.ts)
// POST   /api/flows/suggestions/:id/dismiss → { ok: true }                     (netlify/lib/flow-suggest-routes.ts)

export interface FlowListResponse {
  flows: Flow[];
  /** The newest run of each flow, keyed by flow id. */
  latest: Record<string, FlowRun>;
  max: number;
}

// ---------- between the engine and triggers ----------

/** What triggers (lib/flow-triggers.ts) asks the engine to do. The engine implements it. */
export interface FlowStarter {
  /** Queue a run. `values`: what the trigger gives, by FlowValue key. Returns the run id, or null when the flow is paused or gone. */
  start(flowId: string, start: { label: string; values: Record<string, unknown>; event_ids?: string[]; slot?: string }): Promise<string | null>;
}

/** What triggers reads. The engine implements it. */
export interface FlowSource {
  /** Every flow that isn't paused (nor its assistant), with its trigger. `origin` tells an assistant's job flows (lib/team-flows.ts). */
  listActive(): Promise<Array<Pick<Flow, "id" | "name" | "trigger" | "assistant_id" | "created_at"> & Partial<Pick<Flow, "origin" | "handed_at">>>>;
}
