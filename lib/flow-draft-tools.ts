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
 * Never in a flow: tools that send something or answer for the owner (send_note, answer_invite), edit a connected
 * account (create_event and move_event change the calendar and send invites), archive or delete, change the shape of
 * the owner's own types, belong to Ask's own turn (ask_owner, attach_file, find_times, record_value, which keeps
 * only what a page read in that turn showed), or would set up a second automation inside this one (save_routine).
 * A flow has its own Ask me and Start an assignment steps for the rest.
 */
export const NEVER_IN_FLOWS: ReadonlySet<string> = new Set([
  "send_note",
  "answer_invite",
  "create_event",
  "move_event",
  "archive_or_restore",
  "add_field",
  "change_field",
  "make_kind",
  "duplicate_kind",
  "update_kind",
  "ask_owner",
  "attach_file",
  "find_times",
  "record_value",
  "save_routine",
  "draft_email",
  "start_assignment",
  "continue_assignment",
  "check_with_assistant",
]);

/** Tools that read or log spending. */
export const MONEY_TOOLS: ReadonlySet<string> = new Set(["money", "regular_payments", "log_spending"]);

/**
 * The only changes a drawn flow lets run alone (go "auto"). Each only adds to the owner's own Athena, nothing
 * leaves it, and each has Undo: a reminder (mockup 2 runs one alone), a to-do, a line on a checklist. Every other
 * change waits for the owner's Go until they say otherwise in the editor.
 */
export const RUNS_ALONE: ReadonlySet<string> = new Set(["add_reminder", "add_todo", "add_to_list"]);

/** A drawn step's Go: alone only when the tool is one of RUNS_ALONE and the model didn't ask for a Go. Looks always run. */
export function goFor(tool: DraftTool, asked: unknown): GoMode {
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
 * The tools a draft may use, from Ask's own lists (read tools first, then the rest), each once, without
 * NEVER_IN_FLOWS. `acts` says whether a tool changes something (lib/steps.ts stepActs). Pure.
 */
export function draftTools(tools: ReadonlyArray<ToolLike>, acts: (name: string) => boolean): DraftTool[] {
  const out: DraftTool[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!t?.name || seen.has(t.name) || NEVER_IN_FLOWS.has(t.name)) continue;
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

/** What an email of each kind gives, beyond the email itself (team-types EventFilter `kind`). */
const EMAIL_GIVES: Record<string, FlowValue[]> = {
  delivery: [v("shop", "the shop", "organisation"), v("delivery_date", "the delivery date", "date")],
  booking: [v("booking", "the booking", "trip"), v("booking_date", "the booking date", "date")],
  appointment: [v("appointment", "the appointment", "event"), v("appointment_date", "the appointment date", "datetime")],
  deadline: [v("deadline", "the deadline", "date")],
  renewal: [v("company", "the company", "organisation"), v("price", "the price", "money"), v("renewal_date", "the renewal date", "date")],
  alert: [],
  todo: [v("todo", "the to-do", "todo")],
};

/**
 * What a trigger gives later steps: drafting's guess, so it can check a step's values point somewhere. The server
 * fills a saved flow's `trigger_gives` itself (lib/flow-types.ts), and the engine's list replaces this one through
 * draftFlow's deps. Pure.
 */
export function guessTriggerGives(t: FlowTrigger): FlowValue[] {
  switch (t.kind) {
    case "schedule":
      return [v("date", "the day", "date")];
    case "manual":
      return [];
    case "before":
      return t.what === "event"
        ? [v("event", "the event", "event"), v("start", "the start time", "datetime"), v("people", "who's coming", "person")]
        : [v("date", "the date", "date"), v("what", "what it's for", "text")];
    case "event": {
      const e = t.event;
      if (e.source === "saved") return [v("saved", "the saved item", "saved"), v("title", "its title", "text")];
      if (e.source === "note") return [v("note", "the note", "note"), v("title", "its title", "text")];
      const email = e.connector === "gmail" || e.kind === "email" || (e.kind !== undefined && e.kind in EMAIL_GIVES);
      const base = email ? [v("email", "the email", "email"), v("subject", "its subject", "text"), v("sender", "who sent it", "person")] : [v("item", "the item", "text"), v("title", "its title", "text")];
      return [...base, ...(e.kind && EMAIL_GIVES[e.kind] ? EMAIL_GIVES[e.kind] : [])];
    }
  }
}
