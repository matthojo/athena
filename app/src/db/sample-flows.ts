/**
 * Flows in sample mode: made-up flows, runs, suggestions and the step
 * catalogue, so every Flows screen shows something without a server. Every
 * name here is invented (lib/writing-style.ts; CLAUDE.md: no real people or
 * data). The sample engine (sampleRun) walks a flow the way the real one
 * would, closely enough for the run page: it stops at a change that waits
 * for Go, an Ask me, a Wait or an assignment, and carries on when told.
 */
import type { CatalogEntry, Flow, FlowRun, FlowRunStep, FlowStep, FlowSuggestion, FlowTrigger, FlowValue, ValueRef } from "../../../lib/flow-types";
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { nestValues } from "../flows/preview";

const DAY = 86_400_000;

/** Today at hh:mm, or yesterday's if that's still to come. */
function todayAt(h: number, m: number, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime() > now ? d.getTime() - DAY : d.getTime();
}
const iso = (t: number) => new Date(t).toISOString();

/** The next weekday (0 = Sunday) at hh:mm, after now. */
function nextDay(day: number, h: number, m: number, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  let add = (day - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= now) add = 7;
  return d.getTime() + add * DAY;
}

const ref = (from: string, key: string): ValueRef => ({ from, key });
const T = (key: string): ValueRef => ref("trigger", key);
const v = (key: string, label: string, kind: FlowValue["kind"]): FlowValue => ({ key, label, kind });

export const SAMPLE_FLOW_IDS = {
  renewal: "f10e0000-0000-4000-8000-000000000001",
  meet: "f10e0000-0000-4000-8000-000000000002",
  delivery: "f10e0000-0000-4000-8000-000000000003",
  gift: "f10e0000-0000-4000-8000-000000000004",
  friday: "f10e0000-0000-4000-8000-000000000005",
} as const;

// ---------- what a trigger gives ----------

/** What a trigger gives later steps, as the server fills `trigger_gives` (sample mode only; lenient). */
export function sampleGives(t: FlowTrigger): FlowValue[] {
  if (t.kind === "schedule") return [v("today", "today", "date")];
  if (t.kind === "manual") return [];
  if (t.kind === "before") {
    if (t.what === "event") return [v("event", "the event", "event"), v("people", "who's coming", "person"), v("start", "when it starts", "datetime")];
    const out = [v("date", "the date", "date"), v("what", "what it's for", "text")];
    return t.eventKind === "birthday" || t.eventKind === "anniversary" ? [...out, v("person", "whose it is", "person")] : out;
  }
  const e = t.event;
  if (e.source === "saved") return e.savedAction === "gift-idea" || e.savedAction === "gift_idea" ? [v("gift", "the gift idea", "saved"), v("price", "the price you saw", "money")] : [v("saved", "what you saved", "saved"), v("link", "the link", "text")];
  if (e.source === "note") return [v("note", "the note", "note"), v("title", "its title", "text")];
  if (e.connector === "linear") return [v("issue", "the issue", "text"), v("link", "the link", "text")];
  if (e.connector === "google-calendar") return [v("event", "the event", "event"), v("start", "when it starts", "datetime")];
  switch (e.kind) {
    case "renewal":
      return [v("company", "the company", "organisation"), v("price", "the price", "money"), v("renewal_date", "the renewal date", "date"), v("email", "the email", "email")];
    case "delivery":
      return [v("shop", "the shop", "organisation"), v("item", "what's coming", "text"), v("day", "the delivery day", "date"), v("email", "the email", "email")];
    case "booking":
    case "appointment":
      return [v("what", "what's booked", "text"), v("when", "when it is", "datetime"), v("place", "where", "place"), v("email", "the email", "email")];
    case "deadline":
      return [v("what", "what's due", "text"), v("due", "the deadline", "date"), v("email", "the email", "email")];
    default:
      return [v("email", "the email", "email"), v("sender", "who sent it", "person"), v("subject", "the subject", "text")];
  }
}

// ---------- the flows ----------

interface Seed {
  flow: Flow;
  /** What each value was on the last thing that matched: the step sheet's preview, and the sample engine's lines. */
  values: Record<string, string>;
  /** What each step said on that run. */
  lines: Record<string, { line?: string; pending?: string; no?: string }>;
  /** Which way each Check went. */
  check: Record<string, "yes" | "no">;
  /** What set off the last run. */
  label: string;
  summary: string | null;
}

function flow(id: string, f: Omit<Flow, "id" | "trigger_gives" | "handed_at" | "money" | "paused" | "origin" | "created_at" | "updated_at" | "last_run_at"> & Partial<Flow>): Flow {
  const now = Date.now();
  return {
    id,
    trigger_gives: sampleGives(f.trigger),
    handed_at: f.assistant_id ? iso(now - 40 * DAY) : null,
    money: false,
    paused: false,
    origin: "owner",
    created_at: iso(now - 50 * DAY),
    updated_at: iso(now - 3 * DAY),
    last_run_at: null,
    ...f,
  };
}

function seeds(): Seed[] {
  const { renewal, meet, delivery, gift, friday } = SAMPLE_FLOW_IDS;
  return [
    {
      flow: flow(renewal, {
        name: "Renewal guard",
        trigger: { kind: "event", event: { source: "collected", kind: "renewal" } },
        money: true,
        assistant_id: null,
        steps: [
          { id: "paid", kind: "tool", title: "Find what I paid last year", tool: "money", input: { payee: [T("company")], around: [T("renewal_date"), ", a year ago"] }, go: "auto", gives: [v("last_price", "last year's price", "money")] },
          {
            id: "upcheck",
            kind: "check",
            title: "Did it go up?",
            condition: { left: T("price"), op: "up_by_pct", right: 10, against: ref("paid", "last_price") },
            yes: [{ id: "decide", kind: "tool", title: null, tool: "add_todo", input: { title: ["Decide on ", T("company"), " renewal: ", T("price"), ", was ", ref("paid", "last_price")], due: ["A week before ", T("renewal_date")], link: [T("company")] }, go: "ask", gives: [v("todo", "the to-do", "todo")] }],
            no: [{ id: "remind", kind: "tool", title: null, tool: "add_reminder", input: { text: [T("company"), " renews on ", T("renewal_date")], when: ["9:00, three days before ", T("renewal_date")] }, go: "auto", gives: [] }],
          },
        ],
      }),
      values: { "trigger.company": "Northwind Broadband", "trigger.price": "£38.00 a month", "trigger.renewal_date": "4 Dec", "trigger.email": "“Your plan renews on 4 December”", "paid.last_price": "£32.00 a month", "decide.todo": "the to-do" },
      lines: {
        paid: { line: "Found 12 payments to Northwind Broadband. Last December: £32.00 a month." },
        upcheck: { line: "Yes: £38.00 is 19% more than £32.00", no: "No: about the same as last year" },
        decide: { pending: "Decide on Northwind Broadband renewal: £38.00 a month, was £32.00 · due Fri 27 Nov, on Northwind Broadband's page" },
      },
      check: { upcheck: "yes" },
      label: "An email from Northwind Broadband",
      summary: null,
    },
    {
      flow: flow(meet, {
        name: "Before you meet",
        trigger: { kind: "before", what: "event", minutes: 30, withPeople: true },
        assistant_id: null,
        steps: [
          { id: "who", kind: "tool", title: "Look them up", tool: "find_people", input: { who: [T("people")] }, go: "auto", gives: [v("owed", "what you owe them", "text"), v("last_met", "when you last met", "date")] },
          { id: "tell", kind: "notify", title: null, text: ["Before ", T("event"), ": ", ref("who", "owed"), ". Last met ", ref("who", "last_met"), "."] },
        ],
      }),
      values: { "trigger.event": "Coffee with Priya", "trigger.people": "Priya Shah", "trigger.start": "2:00 pm", "who.owed": "you said you'd send her the Lisbon photos", "who.last_met": "12 Oct" },
      lines: { who: { line: "Priya Shah: you said you'd send her the Lisbon photos. Last met 12 Oct." }, tell: { line: "Sent at 1:30 pm." } },
      check: {},
      label: "Coffee with Priya at 2:00 pm",
      summary: "Before coffee with Priya: you said you'd send her the Lisbon photos.",
    },
    {
      flow: flow(delivery, {
        name: "Delivery day",
        trigger: { kind: "event", event: { source: "collected", kind: "delivery" } },
        assistant_id: null,
        steps: [
          {
            id: "in",
            kind: "ask",
            title: "Will I be in?",
            question: ["Will you be in for ", T("item"), " on ", T("day"), "?"],
            choices: [
              {
                label: "I'll be in",
                steps: [
                  { id: "morning", kind: "wait", title: "Wait for the morning", days: 0, before: T("day"), at: "08:00" },
                  { id: "today", kind: "notify", title: null, text: [T("item"), " from ", T("shop"), " arrives today"] },
                ],
              },
              { label: "I'm out", steps: [{ id: "neighbour", kind: "tool", title: null, tool: "add_todo", input: { title: ["Ask a neighbour to take in ", T("item")], due: ["The day before ", T("day")] }, go: "auto", gives: [] }] },
            ],
          },
        ],
      }),
      values: { "trigger.shop": "Larkspur Home", "trigger.item": "the bedside lamp", "trigger.day": "Thursday", "trigger.email": "“Your order is on its way”" },
      lines: { in: { line: "You said you'll be in." } },
      check: {},
      label: "An email from Larkspur Home",
      summary: null,
    },
    {
      flow: flow(gift, {
        name: "Gift price watch",
        trigger: { kind: "event", event: { source: "saved", savedAction: "gift-idea" } },
        assistant_id: SAMPLE_TEAM_IDS.muse,
        steps: [
          { id: "look", kind: "think", title: "Muse looks for a better price", task: ["Look for ", T("gift"), " for less than ", T("price"), " at shops I've bought from"], web: true, gives: [v("best", "the best price", "money"), v("shop", "the shop", "organisation"), v("why", "why", "text")] },
          {
            id: "cheaper",
            kind: "check",
            title: "Is it cheaper?",
            condition: { left: ref("look", "best"), op: "less_than", right: T("price") },
            yes: [{ id: "tellme", kind: "notify", title: "Muse tells you", text: [T("gift"), " is ", ref("look", "best"), " at ", ref("look", "shop"), ". ", ref("look", "why")] }],
            no: [],
          },
        ],
      }),
      values: { "trigger.gift": "the wooden train set", "trigger.price": "£42.00", "look.best": "£34.00", "look.shop": "Toybox & Co", "look.why": "It's in their winter sale until Sunday." },
      lines: { look: { line: "Found it for £34.00 at Toybox & Co, in their winter sale until Sunday." }, cheaper: { line: "Yes: £34.00 is less than £42.00" }, tellme: { line: "Sent at 4:59 pm." } },
      check: { cheaper: "yes" },
      label: "New gift idea: “the wooden train set”",
      summary: "The wooden train set is £34 at Toybox & Co, £8 under the price when you saved it.",
    },
    {
      flow: flow(friday, {
        name: "Friday review",
        trigger: { kind: "schedule", days: [5], time: "17:00" },
        assistant_id: SAMPLE_TEAM_IDS.wren,
        steps: [
          { id: "todos", kind: "tool", title: "Find this week's to-dos", tool: "find_todos", input: { query: ["Done or due this week"] }, go: "auto", gives: [v("done", "to-dos done", "number"), v("slipped", "to-dos that slipped", "number")] },
          { id: "sum", kind: "think", title: "Wren sums up the week", task: ["Sum up my week in under ten lines: ", ref("todos", "done"), " done, ", ref("todos", "slipped"), " slipped, and who I met"], web: false, gives: [v("summary", "the summary", "text")] },
          { id: "post", kind: "notify", title: null, text: [ref("sum", "summary")] },
          {
            id: "plan",
            kind: "ask",
            title: "Plan next week?",
            question: ["Shall I plan next week around what slipped?"],
            choices: [
              { label: "Yes, plan it", steps: [{ id: "lineup", kind: "assignment", title: null, brief: ["Plan next week around ", ref("todos", "slipped"), " to-dos that slipped"] }] },
              { label: "Not this week", steps: [] },
            ],
          },
        ],
      }),
      values: { "todos.done": "11", "todos.slipped": "2", "sum.summary": "11 to-dos done, two slipped. You met Priya and Sam." },
      lines: { todos: { line: "11 done, 2 slipped." }, sum: { line: "Wrote the week up in eight lines." }, post: { line: "Sent at 5:02 pm." }, plan: { line: "You said not this week." } },
      check: {},
      label: "Every Friday at 5:00 pm",
      summary: "11 to-dos done, two slipped. You met Priya and Sam.",
    },
  ];
}

// ---------- the catalogue ----------

const f = (key: string, label: string, kind: FlowValue["kind"], required = true) => ({ key, label, kind, required });

export function sampleCatalog(): CatalogEntry[] {
  return [
    { kind: "tool", tool: "find_notes", group: "find", label: "Find notes", hint: "Search your notes and what was collected", changes: false, fields: [f("query", "Look for", "text")], gives: [v("notes", "the notes", "note"), v("count", "how many", "number")] },
    { kind: "tool", tool: "find_people", group: "find", label: "Look up a person", hint: "What you owe them, when you last met", changes: false, fields: [f("who", "Who", "person")], gives: [v("owed", "what you owe them", "text"), v("last_met", "when you last met", "date")] },
    { kind: "tool", tool: "find_todos", group: "find", label: "Find to-dos", hint: "Done, due or slipping", changes: false, fields: [f("query", "Which", "text", false)], gives: [v("todos", "the to-dos", "todo"), v("count", "how many", "number")] },
    { kind: "tool", tool: "money", group: "find", label: "Look up spending", hint: "Payments, subscriptions, last year's price", changes: false, money: true, fields: [f("payee", "Paid to", "organisation"), f("around", "Around", "date", false)], gives: [v("last_price", "last year's price", "money"), v("total", "the total", "money")] },
    { kind: "tool", tool: "weather", group: "find", label: "Weather", hint: "For a place and a day", changes: false, fields: [f("where", "Where", "place"), f("when", "When", "date", false)], gives: [v("forecast", "the forecast", "text")] },
    { kind: "tool", tool: "flight_status", group: "find", label: "Flights and trains", hint: "Is it on time, and which gate", changes: false, fields: [f("flight", "Flight or train", "text")], gives: [v("status", "the status", "text"), v("leaves", "when it leaves", "datetime")] },
    { kind: "tool", tool: "add_todo", group: "add", label: "To-do", hint: "With a due date and what it's about", changes: true, fields: [f("title", "To-do", "text"), f("due", "Due", "date", false), f("link", "Link it to", "text", false)], gives: [v("todo", "the to-do", "todo")] },
    { kind: "tool", tool: "add_reminder", group: "add", label: "Reminder", hint: "At a time, or before a date", changes: true, fields: [f("text", "Remind me to", "text"), f("when", "When", "datetime")], gives: [] },
    { kind: "tool", tool: "save_note", group: "add", label: "Note", hint: "Linked to the people and places in it", changes: true, fields: [f("title", "Title", "text"), f("body", "Note", "text")], gives: [v("note", "the note", "note")] },
    { kind: "tool", tool: "add_to_list", group: "add", label: "A line on a list", hint: "Shopping, packing, anything", changes: true, fields: [f("list", "List", "text"), f("item", "Line", "text")], gives: [] },
    { kind: "check", group: "decide", label: "Check something", hint: "Two branches: if so, and otherwise", changes: false, fields: [], gives: [] },
    { kind: "wait", group: "decide", label: "Wait", hint: "For some days, or until a day before a date", changes: false, fields: [], gives: [] },
    { kind: "ask", group: "decide", label: "Ask me", hint: "A question with choices, each one a branch", changes: false, fields: [], gives: [] },
    { kind: "notify", group: "tell", label: "Notification", hint: "On your phone and Home, within your quiet hours", changes: false, fields: [], gives: [] },
    { kind: "tool", tool: "draft_email", group: "tell", label: "Draft an email", hint: "Never sent. It waits for your Go, then sits in your drafts.", changes: true, fields: [f("to", "To", "person"), f("subject", "Subject", "text"), f("body", "Email", "text")], gives: [v("draft", "the draft", "email")] },
    { kind: "tool", tool: "draft_message", group: "tell", label: "Draft a message", hint: "Never sent. It waits for your Go, then sits in your drafts.", changes: true, fields: [f("to", "To", "person"), f("subject", "Subject", "text", false), f("body", "Message", "text")], gives: [v("draft", "the draft", "text")] },
    { kind: "think", group: "team", label: "Let an assistant think", hint: "It thinks it through and gives you what it found", changes: false, needsAssistant: true, fields: [], gives: [v("answer", "the answer", "text")] },
    { kind: "assignment", group: "team", label: "Start an assignment", hint: "A lineup of assistants takes it from here", changes: false, fields: [], gives: [] },
  ];
}

// ---------- suggestions ----------

export function sampleSuggestions(): FlowSuggestion[] {
  const delivery: FlowTrigger = { kind: "event", event: { source: "collected", kind: "delivery" } };
  const birthday: FlowTrigger = { kind: "before", what: "date", days: 7, at: "09:00", eventKind: "birthday" };
  return [
    {
      id: "sug-delivery",
      title: "You add a reminder after every delivery email",
      why: "Six times this month.",
      flow: { name: "Delivery reminders", trigger: delivery, steps: [{ id: "rem", kind: "tool", title: null, tool: "add_reminder", input: { text: [T("item"), " arrives from ", T("shop")], when: ["8:00 on ", T("day")] }, go: "auto", gives: [] }] },
    },
    {
      id: "sug-birthday",
      title: "You look for a present a week before birthdays",
      why: "Four times since September.",
      flow: {
        name: "Birthday heads-up",
        trigger: birthday,
        steps: [
          { id: "ideas", kind: "tool", title: "Find gift ideas", tool: "find_notes", input: { query: ["Gift ideas for ", T("person")] }, go: "auto", gives: [v("notes", "the notes", "note"), v("count", "how many", "number")] },
          { id: "nudge", kind: "notify", title: null, text: [T("person"), "'s birthday is in a week. You have ", ref("ideas", "count"), " gift ideas saved."] },
        ],
      },
    },
  ];
}

// ---------- the sample engine ----------

const CHANGE_TOOLS = new Set(["add_todo", "add_reminder", "save_note", "add_to_list", "draft_email", "draft_message"]);

/** The owner's decisions on a run so far, by step id: Go, Skip, a choice, or past a wait. */
export type Decisions = Record<string, "go" | "skip" | "passed" | number>;

interface Look {
  values: Record<string, string>;
  lines: Seed["lines"];
  check: Seed["check"];
  label: (r: ValueRef) => string;
}

const textOf = (t: ReadonlyArray<string | ValueRef>, look: Look) => t.map((p) => (typeof p === "string" ? p : (look.values[`${p.from}.${p.key}`] ?? look.label(p)))).join("");

/**
 * Walk a flow as the engine would, given the owner's decisions so far. Returns
 * the steps as they ran and what the run waits for, if anything.
 */
export function walkSample(f: Pick<Flow, "steps">, decisions: Decisions, dry: boolean, look: Look, at: number): { steps: FlowRunStep[]; waits: FlowRun["waits_for"] } {
  const out: FlowRunStep[] = [];
  const stamp = (i: number) => iso(at + i * 1000);
  const push = (s: Omit<FlowRunStep, "at">) => out.push({ ...s, at: stamp(out.length) });
  const skipAll = (steps: FlowStep[], why: string) => steps.forEach((s) => push({ step_id: s.id, status: "skipped", line: why }));

  function run(list: FlowStep[]): FlowRun["waits_for"] {
    for (const s of list) {
      const said = look.lines[s.id];
      const d = decisions[s.id];
      switch (s.kind) {
        case "tool": {
          const first = Object.values(s.input)[0] ?? [];
          const changes = CHANGE_TOOLS.has(s.tool);
          if (!changes) {
            push({ step_id: s.id, status: "done", line: said?.line ?? `Looked it up: ${textOf(first, look) || "done"}.` });
            break;
          }
          const what = said?.pending ?? textOf(first, look);
          if (dry) push({ step_id: s.id, status: "done", line: `Would add: ${what}` });
          else if (d === "skip") push({ step_id: s.id, status: "skipped", line: "You skipped this." });
          else if (s.go === "auto" || d === "go") push({ step_id: s.id, status: "done", line: `Added: ${what}` });
          else {
            push({ step_id: s.id, status: "waiting", line: "Waits for your Go", pending: { text: what, plan_id: `sample-plan-${s.id}` } });
            return "go";
          }
          break;
        }
        case "check": {
          const way = look.check[s.id] ?? "yes";
          push({ step_id: s.id, status: "done", line: way === "yes" ? (said?.line ?? "Yes") : (said?.no ?? "No") });
          skipAll(way === "yes" ? s.no : s.yes, way === "yes" ? "Not this time: that's the “Otherwise” branch" : "Not this time: that's the “If so” branch");
          const waits = run(way === "yes" ? s.yes : s.no);
          if (waits) return waits;
          break;
        }
        case "ask": {
          if (typeof d !== "number") {
            push({ step_id: s.id, status: "waiting", line: "Waits for your answer", question: { text: textOf(s.question, look), choices: s.choices.map((c) => c.label) } });
            return "answer";
          }
          push({ step_id: s.id, status: "done", line: `You chose “${s.choices[d]?.label ?? "an answer"}”` });
          s.choices.forEach((c, i) => i !== d && skipAll(c.steps, `Not this time: you chose “${s.choices[d]?.label}”`));
          const waits = run(s.choices[d]?.steps ?? []);
          if (waits) return waits;
          break;
        }
        case "wait": {
          if (dry || d === "passed") {
            push({ step_id: s.id, status: "done", line: dry ? "Would wait here. A try doesn't." : "Waited." });
            break;
          }
          const until = s.before ? nextDay(4, ...hm(s.at)) : at + s.days * DAY;
          push({ step_id: s.id, status: "waiting", line: "Waiting", resumes_at: iso(until) });
          return "time";
        }
        case "notify":
          push({ step_id: s.id, status: "done", line: dry ? `Would tell you: ${textOf(s.text, look)}` : (said?.line ?? `Told you: ${textOf(s.text, look)}`) });
          break;
        case "think":
          push({ step_id: s.id, status: "done", line: said?.line ?? "Thought it through." });
          break;
        case "assignment":
          if (dry) push({ step_id: s.id, status: "done", line: `Would start an assignment: ${textOf(s.brief, look)}` });
          else {
            push({ step_id: s.id, status: "waiting", line: "Started an assignment. Its lineup waits for your Go on Team." });
            return "assignment";
          }
          break;
      }
    }
    return null;
  }
  const waits = run(f.steps);
  return { steps: out, waits };
}

const hm = (at: string | null): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})/.exec(at ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
};

// ---------- the sample store ----------

export interface SampleRunState {
  run: FlowRun;
  decisions: Decisions;
  /** Which way its Checks went, when not the flow's usual way. */
  check?: Record<string, "yes" | "no">;
}

export interface SampleFlows {
  flows: Flow[];
  runs: SampleRunState[];
  values: Record<string, Record<string, string>>;
  lines: Record<string, Seed["lines"]>;
  check: Record<string, Seed["check"]>;
  suggestions: FlowSuggestion[];
}

/** A fresh sample store: the five flows with their recent runs. */
export function sampleFlows(now = Date.now()): SampleFlows {
  const all = seeds();
  const store: SampleFlows = { flows: [], runs: [], values: {}, lines: {}, check: {}, suggestions: sampleSuggestions() };
  for (const s of all) {
    store.flows.push(s.flow);
    store.values[s.flow.id] = s.values;
    store.lines[s.flow.id] = s.lines;
    store.check[s.flow.id] = s.check;
  }
  const { renewal, meet, delivery, gift, friday } = SAMPLE_FLOW_IDS;
  const at = (id: string, t: number, decisions: Decisions, extra: { label?: string; summary?: string; check?: Seed["check"] } = {}) => {
    const seed = all.find((s) => s.flow.id === id)!;
    store.runs.push(sampleRunFrom(store, seed.flow, { label: extra.label ?? seed.label, at: t, decisions, dry: false, summary: extra.summary ?? seed.summary, check: extra.check }));
  };
  // Older runs first: the list keeps the newest per flow.
  at(renewal, now - 37 * DAY, { decide: "go" }, { label: "An email from Pageturn Books", summary: "Pageturn Books: up 25%. You gave the to-do your Go." });
  at(renewal, now - 18 * DAY, {}, { label: "An email from Hillside Home Insurance", summary: "Hillside Home Insurance: the same as last year. Reminder for 18 Nov.", check: { upcheck: "no" } });
  at(renewal, todayAt(8, 12, now), {});
  at(meet, todayAt(13, 30, now), {});
  at(delivery, todayAt(9, 40, now), { in: 0 });
  at(gift, todayAt(16, 59, now) - DAY, {});
  at(friday, nextDay(5, 17, 2, now) - 7 * DAY, { plan: 1 });
  for (const fl of store.flows) {
    const latest = store.runs.filter((r) => r.run.flow_id === fl.id).sort((a, b) => b.run.started_at.localeCompare(a.run.started_at))[0];
    fl.last_run_at = latest?.run.started_at ?? null;
  }
  return store;
}

let seq = 0;
const runId = () => `f10e7000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A run of `flow` in the sample store, walked to where it waits. */
export function sampleRunFrom(store: Pick<SampleFlows, "values" | "lines" | "check">, fl: Flow, o: { label: string; at: number; decisions: Decisions; dry: boolean; summary?: string | null; id?: string; check?: Record<string, "yes" | "no"> }): SampleRunState {
  const gives = new Map<string, FlowValue[]>();
  const collect = (steps: FlowStep[]) =>
    steps.forEach((s) => {
      if (s.kind === "tool" || s.kind === "think") gives.set(s.id, s.gives);
      if (s.kind === "check") (collect(s.yes), collect(s.no));
      if (s.kind === "ask") s.choices.forEach((c) => collect(c.steps));
    });
  collect(fl.steps);
  const label = (r: ValueRef) => (r.from === "trigger" ? fl.trigger_gives : (gives.get(r.from) ?? [])).find((x) => x.key === r.key)?.label ?? r.key;
  const look: Look = { values: store.values[fl.id] ?? {}, lines: store.lines[fl.id] ?? {}, check: o.check ?? store.check[fl.id] ?? {}, label };
  const walked = walkSample(fl, o.decisions, o.dry, look, o.at);
  const finished = !walked.waits;
  const run: FlowRun = {
    id: o.id ?? runId(),
    flow_id: fl.id,
    status: finished ? "done" : "waiting",
    waits_for: walked.waits,
    label: o.label,
    assistant_id: fl.assistant_id,
    summary: finished ? (o.summary ?? null) : null,
    steps: walked.steps,
    // What each value was, as the engine keeps it (FlowRun.values): the step settings preview reads the newest run's.
    values: nestValues(store.values[fl.id] ?? {}),
    dry: o.dry,
    error: null,
    started_at: iso(o.at),
    finished_at: finished ? iso(o.at + (walked.steps.length + 1) * 1000) : null,
  };
  return { run, decisions: o.decisions, check: o.check };
}

