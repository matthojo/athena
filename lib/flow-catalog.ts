/**
 * Flows: the steps the Add a step sheet offers (GET /api/flows/catalog), and what each tool step gives later
 * steps. The tools are Ask's own (lib/assistant.ts TOOLS), run with the same code and checks Ask uses; a flow is
 * offered only those that look, that change something inside Athena and keep an Undo, or that write a draft for the
 * owner to read (draft_email, draft_message: always waiting for Go, and never sent). Never one that sends (a
 * message, an invite answer, a note to another service), edits a connected account (the calendar, the bank),
 * deletes or archives, changes the shape of the owner's data (fields, types), or only offers a card for a tap
 * nobody is there to give (log_spending, create_event). Pure apart from reading the tool list.
 */
import type { Anthropic } from "./ai";
import { TOOLS } from "./assistant";
import { MONEY_TOOL_NAMES, READ_TOOL_NAMES } from "./ask-tools";
import type { CatalogEntry, FlowStepKind, FlowValue, GoMode, ValueKind } from "./flow-types";

type Group = CatalogEntry["group"];

interface ToolPick {
  group: Group;
  label: string;
  hint: string;
  gives: FlowValue[];
}

const v = (key: string, label: string, kind: ValueKind): FlowValue => ({ key, label, kind });
const COUNT = v("count", "how many", "number");
const FOUND = v("result", "what it found", "text");

/**
 * The tools a flow may use, in the order the sheet shows them. Looks first (group "find"), then changes inside
 * Athena (group "add"), then drafts (group "tell"). A tool missing from lib/assistant.ts is left out of the
 * catalogue, never offered.
 */
export const FLOW_TOOLS: Record<string, ToolPick> = {
  find_people: { group: "find", label: "Find a person", hint: "By name, email or company", gives: [v("person", "the person", "person"), COUNT] },
  find_notes: { group: "find", label: "Find notes", hint: "By words, or the notes about a person", gives: [v("note", "the note", "note"), COUNT] },
  find_todos: { group: "find", label: "Find to-dos", hint: "Open to-dos, with a person or matching words", gives: [v("todo", "the to-do", "todo"), COUNT] },
  find_items: { group: "find", label: "Find a place, event or project", hint: "Places, organisations, events, goals, life admin", gives: [v("item", "what it found", "text"), COUNT] },
  find_records: { group: "find", label: "Find in your own types", hint: "Records in a type you keep", gives: [v("record", "the record", "text"), COUNT] },
  find_saved: { group: "find", label: "Find something saved", hint: "Links, images and quotes you kept", gives: [v("saved", "the saved item", "saved"), COUNT] },
  find_watch_read: { group: "find", label: "Find on Watch & read", hint: "Books, films, shows and more", gives: [v("item", "the item", "text"), COUNT] },
  money: { group: "find", label: "Find payments", hint: "Card payments and direct debits", gives: [v("total", "the total", "money"), v("latest", "the latest payment", "money"), COUNT] },
  regular_payments: { group: "find", label: "Find regular payments", hint: "Subscriptions and bills", gives: [FOUND, COUNT] },
  goals: { group: "find", label: "Check your goals", hint: "Each goal and how far along it is", gives: [FOUND, COUNT] },
  trips: { group: "find", label: "Find trips", hint: "Trips and their bookings", gives: [v("trip", "the trip", "trip"), COUNT] },
  purchases: { group: "find", label: "Find orders", hint: "Orders from shops and where they are", gives: [FOUND, COUNT] },
  habits: { group: "find", label: "Check habits", hint: "Your habits and how they went", gives: [FOUND] },
  days: { group: "find", label: "Look at your days", hint: "What you watched, read and noted", gives: [FOUND] },
  health: { group: "find", label: "Look at health", hint: "Sleep, steps and workouts", gives: [FOUND] },
  places: { group: "find", label: "Look at places", hint: "Where you went", gives: [FOUND] },
  weather: { group: "find", label: "Check the weather", hint: "The forecast for a day or a place", gives: [FOUND] },
  work: { group: "find", label: "Look at your work", hint: "Issues and pull requests, counted", gives: [FOUND] },
  energy: { group: "find", label: "Check energy use", hint: "Electricity and gas from the meters", gives: [FOUND] },
  tracker_history: { group: "find", label: "Check something tracked", hint: "A price or anything you track", gives: [FOUND] },
  train_status: { group: "find", label: "Check a train", hint: "Live from National Rail", gives: [FOUND] },
  flight_status: { group: "find", label: "Check a flight", hint: "Live from OpenSky", gives: [FOUND] },
  car_details: { group: "find", label: "Check the car", hint: "MOT, tax and the record", gives: [FOUND] },

  add_todo: { group: "add", label: "Add a to-do", hint: "With a person and a due day if you like", gives: [v("todo", "the to-do", "todo")] },
  add_reminder: { group: "add", label: "Remind me", hint: "A push at a day and time", gives: [v("reminder", "the reminder", "text")] },
  save_note: { group: "add", label: "Write a note", hint: "A new note, or add to one", gives: [v("note", "the note", "note")] },
  add_to_list: { group: "add", label: "Add to a list", hint: "Gift ideas, shopping, packing", gives: [v("note", "the list", "note")] },
  add_person: { group: "add", label: "Add a person", hint: "Someone new in People", gives: [v("person", "the person", "person")] },
  remember: { group: "add", label: "Remember a detail", hint: "Something lasting about a person", gives: [v("done", "what it kept", "text")] },
  log_catch_up: { group: "add", label: "Log a catch-up", hint: "Fills in Last spoke", gives: [v("done", "what it kept", "text")] },
  add_to_watch_read: { group: "add", label: "Add to Watch & read", hint: "A book, film, show or podcast", gives: [v("item", "the item", "text")] },
  update_watch_read: { group: "add", label: "Update Watch & read", hint: "Started, finished, or how far", gives: [v("item", "the item", "text")] },
  complete_todo: { group: "add", label: "Tick off a to-do", hint: "Mark it done", gives: [v("todo", "the to-do", "todo")] },
  change_todo: { group: "add", label: "Change a to-do", hint: "Its words, due day or person", gives: [v("todo", "the to-do", "todo")] },
  save_item: { group: "add", label: "Add or change an item", hint: "A place, event, goal or life admin", gives: [v("item", "the item", "text")] },
  set_field: { group: "add", label: "Set one of your fields", hint: "Shoe size, rating and the like", gives: [v("done", "what it set", "text")] },
  save_record: { group: "add", label: "Add to one of your types", hint: "A record in a type you keep", gives: [v("record", "the record", "text")] },
  link_records: { group: "add", label: "Link two things", hint: "A note to a person, a place to an event", gives: [v("done", "what it linked", "text")] },
  save_trip: { group: "add", label: "Add a trip", hint: "A place and its dates", gives: [v("trip", "the trip", "trip")] },
  save_purchase: { group: "add", label: "Add an order", hint: "Something you ordered", gives: [v("done", "the order", "text")] },
  file_saved_item: { group: "add", label: "File something saved", hint: "Onto Watch & read, Places, a list or a to-do", gives: [v("saved", "the saved item", "saved")] },

  draft_email: { group: "tell", label: "Draft an email", hint: "Written for you to read; never sent", gives: [v("draft", "the draft", "text")] },
  draft_message: { group: "tell", label: "Draft a message", hint: "Email, text, WhatsApp or Slack; never sent", gives: [v("draft", "the draft", "text")] },
};

/** Drafts: Go only writes one for the owner to read and save, through Ask's own code and accounts. Never `auto`, never sent. */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set(["draft_email", "draft_message"]);
export const isDraftTool = (name: string): boolean => DRAFT_TOOLS.has(name);

/** The changes that run alone unless the owner says otherwise (the owner's call, 21 Nov): the only three, everywhere (the
 * editor, drafting and suggestions read this). Every other change, file_saved_item included, waits for Go. */
export const AUTO_BY_DEFAULT: ReadonlySet<string> = new Set(["add_reminder", "add_todo", "add_to_list"]);

/** A change step's Go setting when nobody set one: `auto` for AUTO_BY_DEFAULT, `ask` for the rest. Pure. */
export const defaultGo = (tool: string): GoMode => (AUTO_BY_DEFAULT.has(tool) ? "auto" : "ask");

/** Never offered, whatever else changes: each sends, edits an account, deletes or reshapes data, or waits for a tap of its own. */
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
]);

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Ask's tool by name, when a flow may use it. */
export function flowTool(name: string): Anthropic.Tool | null {
  if (NEVER_TOOLS.has(name) || !FLOW_TOOLS[name]) return null;
  return byName.get(name) ?? null;
}

/** Does this tool change something (a Go setting), or only look? A draft counts: it waits for Go. */
export const toolChanges = (name: string): boolean => FLOW_TOOLS[name]?.group === "add" || DRAFT_TOOLS.has(name);
/** Does it read spending (the flow's money switch, and Ask's)? */
export const toolReadsMoney = (name: string): boolean => MONEY_TOOL_NAMES.has(name);
/** One of the shared read tools (lib/ask-tools.ts), run by ReadTools rather than a Session. */
export const isReadTool = (name: string): boolean => READ_TOOL_NAMES.has(name);

// ---------- fields ----------

const LABELS: Record<string, string> = {
  query: "Look for",
  title: "Title",
  text: "What it says",
  item: "Item",
  list_title: "List",
  body: "Text",
  tags: "Tags",
  name: "Name",
  kind: "Kind",
  due_on: "Due",
  date: "Day",
  time: "Time",
  repeat: "Repeat",
  person_id: "Person",
  person_ids: "People",
  note_id: "Note",
  todo_id: "To-do",
  trip_id: "Trip",
  saved_id: "Saved item",
  merchant: "Shop or company",
  category: "Category",
  from: "From",
  to: "To",
  min: "At least",
  max: "At most",
  summary: "What happened",
  channel: "How",
  key: "Detail",
  value: "Value",
  status: "Status",
  place: "Place",
  area: "Area",
  where: "Where or how",
  about: "What it should say",
};

const human = (key: string) => {
  const s = key.replace(/_id$/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** What kind of value fits a field, so the editor offers the right chips. Pure. */
export function fieldKind(tool: string, key: string, schema: { type?: unknown }): ValueKind {
  if (key === "person_id" || key === "person_ids") return "person";
  if (key === "note_id") return "note";
  if (key === "todo_id" || (key === "id" && /todo/.test(tool))) return "todo";
  if (key === "trip_id") return "trip";
  if (key === "saved_id") return "saved";
  if (/(^|_)(date|on|from|to)$/.test(key) && schema.type === "string") return "date";
  if (key === "amount" || key === "min" || key === "max") return "money";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "text";
}

/** A tool's fields for the step's settings sheet, without the plan's `step` line. Pure. */
export function toolFields(tool: Anthropic.Tool): CatalogEntry["fields"] {
  const s = tool.input_schema as { properties?: Record<string, { type?: unknown }>; required?: string[] };
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {})
    .filter(([key]) => key !== "step")
    .map(([key, p]) => ({ key, label: LABELS[key] ?? human(key), kind: fieldKind(tool.name, key, p), required: required.has(key) }));
}

// ---------- the catalogue ----------

const STEPS: Array<Omit<CatalogEntry, "fields" | "gives"> & { gives?: FlowValue[] }> = [
  { kind: "check", group: "decide", label: "Check", hint: "Two ways on: if it holds, and otherwise", changes: false },
  { kind: "ask", group: "decide", label: "Ask me", hint: "A question with choices; it waits for your answer", changes: false },
  { kind: "wait", group: "decide", label: "Wait", hint: "Carry on later: after some days, or before a date", changes: false },
  { kind: "notify", group: "tell", label: "Tell me", hint: "A push and a card on Home, outside quiet hours", changes: false },
  { kind: "think", group: "team", label: "Think about it", hint: "The assistant that runs this flow works it out", changes: false, needsAssistant: true, gives: [v("answer", "the answer", "text")] },
  { kind: "assignment", group: "team", label: "Start an assignment", hint: "A lineup of assistants; it waits for your Go", changes: false, gives: [v("note", "the work", "note")] },
];

/** Everything the Add a step sheet offers: Ask's tools a flow may use, then the steps that aren't tools. */
export function flowCatalog(): CatalogEntry[] {
  const tools: CatalogEntry[] = [];
  for (const [name, pick] of Object.entries(FLOW_TOOLS)) {
    const tool = flowTool(name);
    if (!tool) continue;
    tools.push({
      kind: "tool" satisfies FlowStepKind,
      tool: name,
      group: pick.group,
      label: pick.label,
      hint: pick.hint,
      changes: toolChanges(name),
      ...(toolReadsMoney(name) ? { money: true } : {}),
      fields: toolFields(tool),
      gives: pick.gives,
    });
  }
  return [...tools, ...STEPS.map((s) => ({ ...s, fields: [], gives: s.gives ?? [] }))];
}
