/**
 * Flows drafting (lib/flow-draft.ts): which of Ask's tools a drawn flow may
 * use, which of its changes may run alone, and what each trigger gives later
 * steps.
 *
 * The engine's step catalogue (GET /api/flows/catalog) is the last word on
 * tools and on what a trigger gives. Drafting is built beside it, not on it,
 * so it reads Ask's own tool list here and its guesses can be swapped for the
 * engine's through draftFlow's deps once both are merged.
 */
import type { FlowTrigger, FlowValue, GoMode, ValueKind } from "./flow-types";
import type { EventFilter } from "./team-types";

/** One of Ask's tools as a draft may use it. */
export interface DraftTool {
  name: string;
  /** The first sentence of its description, for the model. */
  line: string;
  /** Its input fields, and the ones it can't do without. */
  fields: string[];
  required: string[];
  /** Changes something, so it has a Go setting. */
  changes: boolean;
  /** Reads or writes spending: only while Ask may (Settings). */
  money: boolean;
}

/**
 * Never in a flow. The names are copied from the engine's list (lib/flow-catalog.ts NEVER_TOOLS on the flows-engine
 * branch; copied, not imported, until it merges): tools that send something or answer for the owner (send_note,
 * answer_invite), edit a connected account (create_event, move_event), archive or delete, change the shape of the
 * owner's data (fields, types, update_people), only offer a card for a tap nobody is there to give (the log_ tools,
 * make_document), belong to Ask's own turn (ask_owner, attach_file, find_times), or would set up a second automation
 * inside this one (save_routine).
 *
 * Where this list differs from the engine's, on purpose:
 * - draft_message and draft_email are allowed: the owner wants draft steps (21 Nov). They always wait for Go
 *   (ALWAYS_ASK), and a draft is only ever written for the owner to check, never sent.
 * - record_value, start_assignment, continue_assignment and check_with_assistant are also here. FLOW_TOOLS leaves
 *   them out already; naming them keeps them out even if the allowlist grows. record_value keeps only what a page
 *   read in Ask's own turn showed, and a flow has its own Start an assignment step.
 */
export const NEVER_TOOLS: ReadonlySet<string> = new Set([
  "send_note",
  "answer_invite",
  "create_event",
  "move_event",
  "find_times",
  "archive_or_restore",
  "update_people",
  "add_field",
  "change_field",
  "make_kind",
  "duplicate_kind",
  "update_kind",
  "log_spending",
  "log_health",
  "log_day_entry",
  "log_meter_reading",
  "make_document",
  "save_routine",
  "ask_owner",
  "attach_file",
  "record_value",
  "start_assignment",
  "continue_assignment",
  "check_with_assistant",
]);

/**
 * The only tools a drawn flow may use, in the engine's order: its allowlist's names (lib/flow-catalog.ts FLOW_TOOLS
 * on the flows-engine branch, copied), looks first, then changes inside Athena, then the two draft tools the owner
 * allowed (21 Nov), which the engine's list doesn't have yet. A tool missing from Ask's lists is never offered.
 */
export const FLOW_TOOLS: ReadonlySet<string> = new Set([
  "find_people",
  "find_notes",
  "find_todos",
  "find_items",
  "find_records",
  "find_saved",
  "find_watch_read",
  "money",
  "regular_payments",
  "goals",
  "trips",
  "purchases",
  "habits",
  "days",
  "health",
  "places",
  "weather",
  "work",
  "energy",
  "tracker_history",
  "train_status",
  "flight_status",
  "car_details",
  "add_todo",
  "add_reminder",
  "save_note",
  "add_to_list",
  "add_person",
  "remember",
  "log_catch_up",
  "add_to_watch_read",
  "update_watch_read",
  "complete_todo",
  "change_todo",
  "save_item",
  "set_field",
  "save_record",
  "link_records",
  "save_trip",
  "save_purchase",
  "draft_message",
  "draft_email",
]);

/** Tools that read spending (lib/ask-tools.ts MONEY_TOOL_NAMES). */
export const MONEY_TOOLS: ReadonlySet<string> = new Set(["money", "regular_payments"]);

/**
 * The only changes a drawn flow lets run alone (go "auto"). Each only adds to the owner's own Athena, nothing
 * leaves it, and each has Undo: a reminder (mockup 2 runs one alone), a to-do, a line on a checklist. Every other
 * change waits for the owner's Go until they say otherwise in the editor.
 */
export const RUNS_ALONE: ReadonlySet<string> = new Set(["add_reminder", "add_todo", "add_to_list"]);

/** Draft steps: they always wait for the owner's Go, whatever the model or the sentence says, and are never sent. */
export const ALWAYS_ASK: ReadonlySet<string> = new Set(["draft_message", "draft_email"]);

/** A drawn step's Go: a draft always asks; a change runs alone only when it's one of RUNS_ALONE and the model didn't ask for a Go. Looks always run. */
export function goFor(tool: DraftTool, asked: unknown): GoMode {
  if (ALWAYS_ASK.has(tool.name)) return "ask";
  if (!tool.changes) return "auto";
  return RUNS_ALONE.has(tool.name) && asked !== "ask" ? "auto" : "ask";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The first sentence of a description, at most `n` characters. Pure. */
export function firstSentence(s: string | undefined, n = 160): string {
  const one = oneLine(s ?? "");
  const first = one.split(/(?<=[.!?])\s/)[0] ?? one;
  return first.length <= n ? first : `${first.slice(0, n - 1).trimEnd()}…`;
}

interface ToolLike {
  name: string;
  description?: string;
  input_schema?: { properties?: unknown; required?: unknown } | Record<string, unknown>;
}

/**
 * The tools a draft may use, from Ask's own lists (read tools first, then the rest), each once: only those on
 * FLOW_TOOLS, never one on NEVER_TOOLS. `acts` says whether a tool changes something (lib/steps.ts stepActs). Pure.
 */
export function draftTools(tools: ReadonlyArray<ToolLike>, acts: (name: string) => boolean): DraftTool[] {
  const out: DraftTool[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t?.name || seen.has(t.name) || !FLOW_TOOLS.has(t.name) || NEVER_TOOLS.has(t.name)) continue;
    seen.add(t.name);
    const schema = (t.input_schema ?? {}) as { properties?: unknown; required?: unknown };
    const props = schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [];
    // `step` is Ask's plan line (lib/assistant.ts withStepField), not the tool's own.
    const fields = props.filter((f) => f !== "step");
    const required = Array.isArray(schema.required) ? schema.required.filter((f): f is string => typeof f === "string" && fields.includes(f)) : [];
    out.push({ name: t.name, line: firstSentence(t.description), fields, required, changes: acts(t.name), money: MONEY_TOOLS.has(t.name) });
  }
  return out;
}

/** Ask's tools as a draft may use them, loaded when first needed (lib/assistant.ts is heavy). */
export async function askDraftTools(): Promise<DraftTool[]> {
  const [{ TOOLS }, { READ_TOOLS }, { stepActs }] = await Promise.all([import("./assistant"), import("./ask-tools"), import("./steps")]);
  return draftTools([...READ_TOOLS, ...TOOLS], stepActs);
}

// ---------- what a trigger gives ----------

const v = (key: string, label: string, kind: ValueKind): FlowValue => ({ key, label, kind });
const lower = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** The record an event trigger's item is, and what else it carries. Pure. */
function eventItem(f: EventFilter): FlowValue[] {
  if (f.source === "saved") return [v("item", "the saved item", "saved"), v("website", "the website", "text")];
  if (f.source === "note") return [v("item", "the note", "note"), v("tags", "the tags", "text")];
  const kind = lower(f.kind);
  switch (kind) {
    case "renewal":
      return [v("item", "what renews", "text"), v("company", "the company", "organisation"), v("renewal_date", "the renewal date", "date")];
    case "delivery":
      return [v("item", "the order", "text"), v("company", "the shop", "organisation"), v("expected", "the delivery date", "date")];
    case "booking":
      return [v("item", "the trip", "trip"), v("booking", "the booking", "text"), v("company", "who it's with", "organisation"), v("starts_at", "when it starts", "datetime")];
    case "event":
    case "appointment":
    case "deadline":
      return [v("item", kind === "event" ? "the event" : `the ${kind}`, "event"), v("date", "the date", "date")];
    case "todo":
    case "alert":
      return [v("item", "the to-do", "todo")];
    case "email":
      return [v("item", "the email", "email")];
    default:
      return [v("item", kind ? `the ${kind.replace(/[_-]+/g, " ")}` : "the item", "note")];
  }
}

/**
 * What a trigger gives later steps, so drafting can check a step's values point somewhere. The keys and labels are
 * copied from the triggers' own list (lib/flow-triggers.ts triggerGives on the flows-triggers branch; copied, not
 * imported, until it merges), so a drawn {{trigger.key}} is one the engine fills. The server still fills a saved
 * flow's `trigger_gives` itself, and draftFlow's deps can pass the real list in. Pure.
 */
export function guessTriggerGives(trigger: FlowTrigger): FlowValue[] {
  switch (trigger.kind) {
    case "schedule":
      return [v("date", "the date", "date"), v("time", "the time", "datetime")];
    case "manual":
      return [v("date", "the date", "date")];
    case "event":
      return [...eventItem(trigger.event), v("title", "the title", "text"), v("count", "how many came in", "number")];
    case "before":
      if (trigger.what === "event") return [v("event", "the event", "event"), v("people", "the people", "person"), v("starts_at", "when it starts", "datetime"), v("title", "the title", "text")];
      switch (lower(trigger.eventKind)) {
        case "birthday":
        case "anniversary": {
          const k = lower(trigger.eventKind);
          return [v("event", `the ${k}`, "event"), v("person", "the person", "person"), v("date", "the date", "date"), v("years", k === "birthday" ? "the age" : "how many years", "number"), v("title", "the title", "text")];
        }
        case "renewal":
          return [v("item", "what renews", "text"), v("company", "the company", "organisation"), v("renewal_date", "the renewal date", "date"), v("title", "the title", "text")];
        case "deadline":
        case "appointment":
          return [v("event", `the ${lower(trigger.eventKind)}`, "event"), v("date", "the date", "date"), v("title", "the title", "text")];
        default:
          return [v("event", "the event", "event"), v("date", "the date", "date"), v("title", "the title", "text")];
      }
  }
}
