/**
 * Shared flows: a flow as a file someone else can add to their own Athena. Pure and shared by the server and the
 * app. This file is the contract: the format, its limits and the reader. Making one from a flow (`exportFlow`) and
 * turning one into a flow (`importSharedFlow`) are stubs with their final signatures.
 *
 * A shared flow is a folder, usually on its own:
 *
 *   <slug>/flow.json   the flow: its name, a summary, its trigger and steps, the questions it asks whoever adds it,
 *                      the accounts it needs, and whether it would like to read spending or search the web
 *                      (requests, never grants)
 *
 * What never goes in: the flow's id, its runs, the assistant it was handed to, record ids, links to the owner's own
 * site. A step field that pointed at one of the owner's records (a person, a note, a to-do) becomes a named blank,
 * `{ "blank": "who" }`, and the question in `asks` with that key fills it when someone adds the flow.
 *
 * Reading one (`readSharedFlow`) treats every field as someone else's words, as lib/team-share.ts readShared does:
 * checked against FLOW_LIMITS, unknown keys dropped, a tool a flow can't use refused. Whether each tool's fields
 * are its own and each value is given before it's used is checked again on import, by the same code that checks a
 * flow made here (lib/flows.ts checkSteps). Nothing in the file is a permission: a step's `go: "auto"` is a request,
 * and the flow is added paused.
 */
import { MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, MAX_SUMMARY } from "./team-skill";
import { MAX_ITEM_NEEDS } from "./shared-limits";
import { ShareFormatError, type Finding, type KnownTerm, type Removed } from "./team-share";
import { readHeader, type ShareHeader } from "./share-kinds";
import { EVENT_SOURCES, type EventFilter, type TeamWeekday } from "./team-types";
import { FLOW_LIMITS, VALUE_KINDS, type CheckOp, type Flow, type FlowInput, type FlowStep, type FlowTrigger, type FlowValue, type GoMode, type ValueKind, type ValueRef } from "./flow-types";

export const FLOW_SHARE_FORMAT = 1;
export const FLOW_FILE = "flow.json";
/** Questions a shared flow can ask whoever adds it: one per blank. */
export const MAX_FLOW_ASKS = 8;
/** Accounts it can say it needs. */
export const MAX_FLOW_NEEDS = MAX_ITEM_NEEDS;
/** Pieces in one text (words and chips). */
export const MAX_TEXT_PARTS = 40;
/** Values one step gives. */
export const MAX_GIVES = 12;

/**
 * The tools a shared flow may use: the names in lib/flow-catalog.ts FLOW_TOOLS, which this file can't import (it
 * reads Ask's tools). lib/flow-share.test.ts checks they match.
 */
export const FLOW_SHARE_TOOLS: readonly string[] = [
  "find_people", "find_notes", "find_todos", "find_items", "find_records", "find_saved", "find_watch_read", "money", "regular_payments", "goals", "trips", "purchases", "habits", "days", "health", "places", "weather", "work", "energy", "tracker_history", "train_status", "flight_status", "car_details",
  "add_todo", "add_reminder", "save_note", "add_to_list", "add_person", "remember", "log_catch_up", "add_to_watch_read", "update_watch_read", "complete_todo", "change_todo", "save_item", "set_field", "save_record", "link_records", "save_trip", "save_purchase", "file_saved_item",
  "draft_email", "draft_message",
];
/** Tools that read spending: a flow using one asks for `money` (lib/ask-tools.ts MONEY_TOOL_NAMES; the test checks). */
export const FLOW_MONEY_TOOLS: readonly string[] = ["money", "regular_payments"];
/** Drafts always wait for Go (lib/flow-catalog.ts DRAFT_TOOLS; the test checks). */
export const FLOW_DRAFT_TOOLS: readonly string[] = ["draft_email", "draft_message"];

// ---------- the format ----------

/** A gap where the owner's own record was: the question in `asks` with this key fills it. */
export interface FlowBlank {
  blank: string;
}

/** FlowText, with blanks: words, chips for values, and gaps for the answers. */
export type SharedText = Array<string | ValueRef | FlowBlank>;

export interface SharedCondition {
  left: ValueRef;
  op: CheckOp;
  right?: ValueRef | FlowBlank | string | number;
  against?: ValueRef;
}

interface SharedStepBase {
  /** Local to the file ("s1"), so values can point at the step. Never a record id. */
  id: string;
  title: string | null;
}

/** FlowStep as a file carries it: the same kinds and fields, with blanks allowed in its text. */
export type SharedFlowStep =
  /** `go` is a request: the import decides (a draft always waits for Go). */
  | (SharedStepBase & { kind: "tool"; tool: string; input: Record<string, SharedText>; go: GoMode; gives: FlowValue[] })
  | (SharedStepBase & { kind: "check"; condition: SharedCondition; yes: SharedFlowStep[]; no: SharedFlowStep[] })
  | (SharedStepBase & { kind: "ask"; question: SharedText; choices: Array<{ label: string; steps: SharedFlowStep[] }> })
  | (SharedStepBase & { kind: "wait"; days: number; before?: ValueRef; at: string | null })
  | (SharedStepBase & { kind: "notify"; text: SharedText })
  /** Needs an assistant to run it, picked on import. `web`: it would like to search; a request. */
  | (SharedStepBase & { kind: "think"; task: SharedText; web: boolean; gives: FlowValue[] })
  | (SharedStepBase & { kind: "assignment"; brief: SharedText });

/** A question the flow asks whoever adds it. Its answer fills every blank with its key. */
export interface SharedFlowAsk {
  /** Matches the blanks: "who", "the_list". */
  key: string;
  question: string;
  /** Answers to tap, for a `text` blank. Empty: they write their own, or pick a record. */
  choices: string[];
  /** What fills it: `text`, or a record of theirs to pick (`person`, `note`, `todo`…). */
  fills: ValueKind;
}

export interface SharedFlow extends ShareHeader {
  format: typeof FLOW_SHARE_FORMAT;
  name: string;
  /** One or two sentences on what it does, for the preview. */
  summary: string;
  trigger: FlowTrigger;
  steps: SharedFlowStep[];
  /** Accounts it needs, by provider ("gmail", "linear"): its event trigger's first. */
  needs: string[];
  asks: SharedFlowAsk[];
  /** It would like to read spending. A request: on import it stays off until the owner ticks it. */
  money: boolean;
  /** It would like its thinking steps to search the web. A request, like `money`. */
  web: boolean;
}

// ---------- reading one ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const OPS: readonly CheckOp[] = ["is", "is_not", "contains", "more_than", "less_than", "up_by_pct", "exists", "missing"];
/** Tool fields that hold a record's id: a file may fill them only with a value or a blank. */
const RECORD_FIELD = /_ids?$/;

const fail = (msg: string): never => {
  throw new ShareFormatError(msg);
};

function words(raw: unknown, at: string, max: number, opts: { required?: boolean; multiline?: boolean } = {}): string {
  if (raw === undefined || raw === null) return opts.required ? fail(`${at}: missing`) : "";
  if (typeof raw !== "string") return fail(`${at}: should be text`);
  const v = opts.multiline ? raw.replace(/\r\n?/g, "\n").trim() : oneLine(raw);
  if (opts.required && !v) fail(`${at}: missing`);
  if (v.length > max) fail(`${at}: over ${max.toLocaleString("en-GB")} characters`);
  if (UUID.test(v)) fail(`${at}: holds a record id. Make it a question in asks instead`);
  return v;
}

function list(raw: unknown, at: string): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${at}: should be a list`);
  return raw as unknown[];
}

/** What a file says about values and blanks, checked once every step id and ask key is known. */
interface Seen {
  refs: Array<{ ref: ValueRef; at: string }>;
  blanks: Array<{ blank: string; at: string }>;
  ids: string[];
}

function readRef(raw: unknown, at: string, seen: Seen): ValueRef {
  if (!isObj(raw) || typeof raw.from !== "string" || typeof raw.key !== "string") return fail(`${at}: should be a value, { from, key }`);
  if (raw.from !== "trigger" && !STEP_ID.test(raw.from)) fail(`${at}.from: a step id or "trigger"`);
  if (!KEY.test(raw.key)) fail(`${at}.key: lowercase letters, digits and _`);
  const ref = { from: raw.from, key: raw.key };
  seen.refs.push({ ref, at });
  return ref;
}

function readBlank(raw: Record<string, unknown>, at: string, seen: Seen): FlowBlank {
  if (typeof raw.blank !== "string" || !KEY.test(raw.blank)) return fail(`${at}.blank: the key of a question in asks`);
  seen.blanks.push({ blank: raw.blank, at });
  return { blank: raw.blank };
}

function readText(raw: unknown, at: string, seen: Seen, opts: { recordField?: boolean } = {}): SharedText {
  const parts = typeof raw === "string" ? [raw] : list(raw, at);
  if (parts.length > MAX_TEXT_PARTS) fail(`${at}: ${MAX_TEXT_PARTS} pieces at most`);
  return parts.map((p, i) => {
    const pAt = `${at}[${i}]`;
    if (typeof p === "string") {
      if (opts.recordField) fail(`${pAt}: points at a record. Make it a question in asks, and put { "blank": key } here`);
      if (p.length > FLOW_LIMITS.text) fail(`${pAt}: over ${FLOW_LIMITS.text} characters`);
      if (UUID.test(p)) fail(`${pAt}: holds a record id. Make it a question in asks instead`);
      return p;
    }
    if (isObj(p) && "blank" in p) return readBlank(p, pAt, seen);
    return readRef(p, pAt, seen);
  });
}

function readGives(raw: unknown, at: string): FlowValue[] {
  const out = list(raw, at).map((g, i) => {
    const gAt = `${at}[${i}]`;
    if (!isObj(g) || typeof g.key !== "string" || !KEY.test(g.key)) return fail(`${gAt}.key: lowercase letters, digits and _`);
    if (!(VALUE_KINDS as readonly string[]).includes(g.kind as string)) return fail(`${gAt}.kind: not a kind of value Athena knows`);
    return { key: g.key, label: words(g.label, `${gAt}.label`, 60, { required: true }), kind: g.kind as ValueKind };
  });
  if (out.length > MAX_GIVES) fail(`${at}: ${MAX_GIVES} values at most`);
  return out;
}

function readCondition(raw: unknown, at: string, seen: Seen): SharedCondition {
  if (!isObj(raw)) return fail(`${at}: should be an object`);
  if (!OPS.includes(raw.op as CheckOp)) fail(`${at}.op: one of ${OPS.join(", ")}`);
  const out: SharedCondition = { left: readRef(raw.left, `${at}.left`, seen), op: raw.op as CheckOp };
  const r = raw.right;
  if (typeof r === "number") {
    if (!Number.isFinite(r)) fail(`${at}.right: a number`);
    out.right = r;
  } else if (typeof r === "string") {
    if (r.length > FLOW_LIMITS.text) fail(`${at}.right: over ${FLOW_LIMITS.text} characters`);
    if (UUID.test(r)) fail(`${at}.right: holds a record id. Make it a question in asks instead`);
    out.right = r;
  } else if (isObj(r)) out.right = "blank" in r ? readBlank(r, `${at}.right`, seen) : readRef(r, `${at}.right`, seen);
  else if (r !== undefined && r !== null) fail(`${at}.right: a value, a blank, text or a number`);
  if (raw.against !== undefined && raw.against !== null) out.against = readRef(raw.against, `${at}.against`, seen);
  return out;
}

function readSteps(raw: unknown, at: string, seen: Seen, depth: number): SharedFlowStep[] {
  const steps = list(raw, at);
  if (steps.length && depth > FLOW_LIMITS.depth) fail(`${at}: branches go ${FLOW_LIMITS.depth} deep at most`);
  return steps.map((s, i) => readStep(s, `${at}[${i}]`, seen, depth));
}

function readStep(raw: unknown, at: string, seen: Seen, depth: number): SharedFlowStep {
  if (!isObj(raw)) return fail(`${at}: should be an object`);
  if (typeof raw.id !== "string" || !STEP_ID.test(raw.id)) return fail(`${at}.id: letters, digits, - and _, like s1`);
  if (UUID.test(raw.id)) fail(`${at}.id: a local name like s1, not a record id`);
  if (seen.ids.includes(raw.id)) fail(`${at}.id: two steps share the id “${raw.id}”`);
  seen.ids.push(raw.id);
  if (seen.ids.length > FLOW_LIMITS.steps) fail(`A flow has ${FLOW_LIMITS.steps} steps at most, branches included`);
  const base = { id: raw.id, title: words(raw.title, `${at}.title`, FLOW_LIMITS.name) || null };
  switch (raw.kind) {
    case "tool": {
      if (typeof raw.tool !== "string" || !FLOW_SHARE_TOOLS.includes(raw.tool)) return fail(`${at}.tool: a flow can't use “${String(raw.tool)}”`);
      if (raw.input !== undefined && !isObj(raw.input)) fail(`${at}.input: should be an object`);
      const input: Record<string, SharedText> = {};
      for (const [k, v] of Object.entries((raw.input as Record<string, unknown> | undefined) ?? {})) {
        if (!KEY.test(k) || k === "step") fail(`${at}.input: “${k}” isn't a field`);
        input[k] = readText(v, `${at}.input.${k}`, seen, { recordField: RECORD_FIELD.test(k) });
      }
      const go: GoMode = FLOW_DRAFT_TOOLS.includes(raw.tool) ? "ask" : raw.go === "auto" ? "auto" : "ask";
      return { ...base, kind: "tool", tool: raw.tool, input, go, gives: readGives(raw.gives, `${at}.gives`) };
    }
    case "check":
      return { ...base, kind: "check", condition: readCondition(raw.condition, `${at}.condition`, seen), yes: readSteps(raw.yes, `${at}.yes`, seen, depth + 1), no: readSteps(raw.no, `${at}.no`, seen, depth + 1) };
    case "ask": {
      const choices = list(raw.choices, `${at}.choices`);
      if (choices.length < FLOW_LIMITS.minChoices) fail(`${at}: Ask me needs ${FLOW_LIMITS.minChoices} choices at least`);
      if (choices.length > FLOW_LIMITS.choices) fail(`${at}: Ask me offers ${FLOW_LIMITS.choices} choices at most`);
      return {
        ...base,
        kind: "ask",
        question: readText(raw.question, `${at}.question`, seen),
        choices: choices.map((c, i) => {
          if (!isObj(c)) return fail(`${at}.choices[${i}]: should be an object`);
          return { label: words(c.label, `${at}.choices[${i}].label`, FLOW_LIMITS.name, { required: true }), steps: readSteps(c.steps, `${at}.choices[${i}].steps`, seen, depth + 1) };
        }),
      };
    }
    case "wait": {
      const days = raw.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > FLOW_LIMITS.waitDays) fail(`${at}.days: 0 to ${FLOW_LIMITS.waitDays}`);
      if (raw.at !== undefined && raw.at !== null && (typeof raw.at !== "string" || !HHMM.test(raw.at))) fail(`${at}.at: a time, like 09:00`);
      const step: SharedFlowStep = { ...base, kind: "wait", days: days as number, at: typeof raw.at === "string" ? raw.at : null };
      if (raw.before !== undefined && raw.before !== null) step.before = readRef(raw.before, `${at}.before`, seen);
      return step;
    }
    case "notify":
      return { ...base, kind: "notify", text: readText(raw.text, `${at}.text`, seen) };
    case "think":
      return { ...base, kind: "think", task: readText(raw.task, `${at}.task`, seen), web: raw.web === true, gives: readGives(raw.gives, `${at}.gives`) };
    case "assignment":
      return { ...base, kind: "assignment", brief: readText(raw.brief, `${at}.brief`, seen) };
    default:
      return fail(`${at}.kind: tool, check, ask, wait, notify, think or assignment`);
  }
}

function readTrigger(raw: unknown): FlowTrigger {
  const at = "trigger";
  if (!isObj(raw)) return fail(`${at}: missing`);
  switch (raw.kind) {
    case "schedule": {
      const days = [...new Set(list(raw.days, `${at}.days`).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b) as TeamWeekday[];
      if (!days.length) fail(`${at}: a schedule needs days, 0 (Sunday) to 6`);
      if (typeof raw.time !== "string" || !HHMM.test(raw.time)) fail(`${at}: a schedule needs a time, like 08:30`);
      return { kind: "schedule", days, time: raw.time as string };
    }
    case "event": {
      const e = raw.event;
      if (!isObj(e) || !EVENT_SOURCES.includes(e.source as EventFilter["source"])) return fail(`${at}: an event trigger needs event.source (collected, saved or note)`);
      const event: EventFilter = { source: e.source as EventFilter["source"] };
      const facet = (k: string, max: number) => (e[k] === undefined || e[k] === null || e[k] === "" ? "" : words(e[k], `${at}.event.${k}`, max));
      const connector = facet("connector", 80).toLowerCase();
      if (connector) event.connector = connector;
      const kind = facet("kind", 80);
      if (kind) event.kind = kind;
      const savedAction = facet("savedAction", 80);
      if (savedAction) event.savedAction = savedAction;
      const tag = facet("tag", 80).replace(/^#/, "");
      if (tag) event.tag = tag;
      const match = facet("match", 120);
      if (match) event.match = match;
      return { kind: "event", event };
    }
    case "before": {
      const match = words(raw.match, `${at}.match`, 120);
      if (raw.what === "event") {
        const m = raw.minutes;
        if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > 7 * 24 * 60) fail(`${at}.minutes: 1 to ${7 * 24 * 60}`);
        return { kind: "before", what: "event", minutes: m as number, ...(raw.withPeople === true ? { withPeople: true } : {}), ...(match ? { match } : {}) };
      }
      if (raw.what === "date") {
        const d = raw.days;
        if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > FLOW_LIMITS.waitDays) fail(`${at}.days: 0 to ${FLOW_LIMITS.waitDays}`);
        if (typeof raw.at !== "string" || !HHMM.test(raw.at)) fail(`${at}.at: a time, like 09:00`);
        const eventKind = words(raw.eventKind, `${at}.eventKind`, 40);
        return { kind: "before", what: "date", days: d as number, at: raw.at as string, ...(eventKind ? { eventKind } : {}), ...(match ? { match } : {}) };
      }
      return fail(`${at}.what: event or date`);
    }
    case "manual":
      return { kind: "manual" };
    default:
      return fail(`${at}.kind: schedule, event, before or manual`);
  }
}

function readAsks(raw: unknown): SharedFlowAsk[] {
  const out: SharedFlowAsk[] = [];
  for (const [i, a] of list(raw, "asks").entries()) {
    const at = `asks[${i}]`;
    if (!isObj(a)) fail(`${at}: should be an object`);
    const ask = a as Record<string, unknown>;
    if (typeof ask.key !== "string" || !KEY.test(ask.key)) fail(`${at}.key: lowercase letters, digits and _`);
    if (out.some((x) => x.key === ask.key)) fail(`${at}.key: two questions share “${String(ask.key)}”`);
    const fills = ask.fills === undefined ? "text" : ask.fills;
    if (!(VALUE_KINDS as readonly string[]).includes(fills as string)) fail(`${at}.fills: not a kind of value Athena knows`);
    const choices = [...new Set(list(ask.choices, `${at}.choices`).filter((c): c is string => typeof c === "string").map(oneLine).filter((c) => c && c.length <= MAX_CHOICE))].slice(0, MAX_CHOICES);
    out.push({ key: ask.key as string, question: words(ask.question, `${at}.question`, MAX_QUESTION, { required: true }), choices: fills === "text" && choices.length >= 2 ? choices : [], fills: fills as ValueKind });
  }
  if (out.length > MAX_FLOW_ASKS) fail(`asks: ${MAX_FLOW_ASKS} questions at most`);
  return out;
}

function eachShared(steps: SharedFlowStep[], fn: (s: SharedFlowStep) => void): void {
  for (const s of steps) {
    fn(s);
    if (s.kind === "check") {
      eachShared(s.yes, fn);
      eachShared(s.no, fn);
    } else if (s.kind === "ask") for (const c of s.choices) eachShared(c.steps, fn);
  }
}

/** Every step in a shared flow, branches included, in order. Pure. */
export function allSharedSteps(steps: SharedFlowStep[]): SharedFlowStep[] {
  const out: SharedFlowStep[] = [];
  eachShared(steps, (s) => out.push(s));
  return out;
}

/** flow.json, read and checked. Throws ShareFormatError with words for the owner. Pure. */
export function readSharedFlow(raw: unknown): SharedFlow {
  if (!isObj(raw)) throw new ShareFormatError("That isn't a shared flow: flow.json should hold an object.");
  if (raw.format !== FLOW_SHARE_FORMAT) {
    if (typeof raw.format === "number" && raw.format > FLOW_SHARE_FORMAT) throw new ShareFormatError("That flow was shared from a newer Athena. Update yours, then try again.");
    throw new ShareFormatError(`That isn't a flow Athena can read: flow.json needs "format": ${FLOW_SHARE_FORMAT}.`);
  }
  const seen: Seen = { refs: [], blanks: [], ids: [] };
  const name = words(raw.name, "name", FLOW_LIMITS.name, { required: true });
  const summary = words(raw.summary, "summary", MAX_SUMMARY);
  const trigger = readTrigger(raw.trigger);
  const steps = readSteps(raw.steps, "steps", seen, 1);
  if (!steps.length) fail("steps: a flow needs at least one step");
  const askList = readAsks(raw.asks);
  for (const { ref, at } of seen.refs) if (ref.from !== "trigger" && !seen.ids.includes(ref.from)) fail(`${at}: no step “${ref.from}”`);
  for (const { blank, at } of seen.blanks) if (!askList.some((a) => a.key === blank)) fail(`${at}: no question in asks with the key “${blank}”`);
  const used = new Set(seen.blanks.map((b) => b.blank));
  const declared = list(raw.needs, "needs")
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => PROVIDER.test(v));
  const connector = trigger.kind === "event" && trigger.event.connector && PROVIDER.test(trigger.event.connector) ? [trigger.event.connector] : [];
  const needs = [...new Set([...connector, ...declared])];
  if (needs.length > MAX_FLOW_NEEDS) fail(`needs: ${MAX_FLOW_NEEDS} at most`);
  const all = allSharedSteps(steps);
  const money = raw.money === true || all.some((s) => s.kind === "tool" && FLOW_MONEY_TOOLS.includes(s.tool));
  const web = raw.web === true || all.some((s) => s.kind === "think" && s.web);
  return {
    format: FLOW_SHARE_FORMAT,
    ...readHeader(raw),
    name,
    summary,
    trigger,
    steps,
    needs,
    asks: askList.filter((a) => used.has(a.key)),
    money,
    web,
  };
}

// ---------- making one, and adding one (not built yet) ----------

/** What exportFlow needs from the server: the site's own hosts to take out, and the owner's terms to flag. */
export interface FlowExportContext {
  /** The site's own hosts (from Netlify's `URL`), for scrubText. */
  ownHosts: string[];
  /** The owner's people, places and the like, for findPersonal. */
  known: KnownTerm[];
  /** Words for a record a step points at, so its blank's question reads well: "Which person?" */
  recordWords?: (kind: ValueKind, id: string) => string | null;
  /** The owner's changes in the export sheet. They change the file, not the flow. */
  edits?: { name?: string; summary?: string; version?: string; author?: string; asks?: SharedFlowAsk[] };
}

export interface FlowExport {
  shared: SharedFlow;
  /** What scrubText took out, counted. */
  removed: Removed[];
  /** What looks like the owner's own, for the sheet to show. */
  findings: Finding[];
}

/**
 * A flow as a file: record ids become blanks with questions, links to the site go, and nothing that isn't in the
 * format is kept (its id, runs, assistant). Pure. Not built yet.
 */
export function exportFlow(flow: Pick<Flow, "name" | "trigger" | "steps" | "money">, ctx: FlowExportContext): FlowExport {
  void flow;
  void ctx;
  throw new Error("not built yet");
}

/** An answer to one of a shared flow's questions: words, or the id of a record the owner picked. */
export type FlowAnswers = Record<string, string>;

/** What adding a shared flow saves: paused, from someone else, with each blank filled from `answers`. */
export type ImportedFlowInput = FlowInput & { name: string; trigger: FlowTrigger; steps: FlowStep[]; money: boolean; paused: true; origin: "shared" };

/**
 * A shared flow as POST /api/flows takes it: blanks filled from `answers`, paused, and `money` off (the caller turns
 * it on only when the owner ticks it). Throws ShareFormatError when a question has no answer. Pure. Not built yet.
 */
export function importSharedFlow(shared: SharedFlow, answers: FlowAnswers): ImportedFlowInput {
  void shared;
  void answers;
  throw new Error("not built yet");
}
