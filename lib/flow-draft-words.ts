/**
 * A flow in words, for Ask's flow card (app/src/components/ask-flow-card.ts)
 * and for what propose_flow tells the model: when it starts, and a line for
 * each step with its values as chips. Plain, British, sentence case
 * (lib/writing-style.ts). The flows editor has its own, fuller words.
 *
 * Pure, no DOM and no server code: the app imports it.
 */
import type { CheckOp, FlowStep, FlowText, FlowTrigger, FlowValue } from "./flow-types";

/** A piece of a line: words, or a value shown as a chip. */
export type WordPart = string | { chip: string };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Monday, Wednesday and Friday". */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "every day", "every weekday", "every Monday and Friday". */
export function daysWords(days: number[]): string {
  const set = [...new Set(days)].sort();
  if (set.length === 7 || set.length === 0) return "every day";
  if (set.length === 5 && [1, 2, 3, 4, 5].every((d) => set.includes(d))) return "every weekday";
  if (set.length === 2 && set[0] === 0 && set[1] === 6) return "every weekend";
  return `every ${listWords(set.map((d) => DAY_NAMES[d] ?? ""))}`;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes", "2 days". */
export function minutesWords(m: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m % 1440 === 0) return plural(m / 1440, "day");
  if (m < 60) return plural(m, "minute");
  const h = Math.floor(m / 60);
  return m % 60 ? `${plural(h, "hour")} ${plural(m % 60, "minute")}` : plural(h, "hour");
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What arrives, for "When …". */
const EMAIL_KIND: Record<string, string> = {
  delivery: "an email says a parcel is coming",
  renewal: "a renewal email comes in",
  booking: "a booking email comes in",
  appointment: "an appointment email comes in",
  deadline: "an email gives a deadline",
  alert: "an alert email comes in",
  todo: "an email asks you to do something",
  email: "an email comes in",
};

/** When a flow starts, in one line: "When an email says a parcel is coming". */
export function triggerWords(t: FlowTrigger): string {
  switch (t.kind) {
    case "manual":
      return "When you tap Run now";
    case "schedule":
      return `${capital(daysWords(t.days))} at ${t.time}`;
    case "before":
      if (t.what === "event") {
        const which = t.withPeople ? "an event with someone from your People" : "an event";
        return `${capital(minutesWords(t.minutes))} before ${which}${t.match ? ` called “${t.match}”` : ""}`;
      } else {
        const what = t.eventKind ? `a ${t.eventKind}` : "a date";
        const when = t.days === 0 ? `On the day of ${what}` : `${t.days} day${t.days === 1 ? "" : "s"} before ${what}`;
        return `${when}${t.match ? ` (“${t.match}”)` : ""}, at ${t.at}`;
      }
    case "event": {
      const e = t.event;
      const about = e.match ? ` about “${e.match}”` : "";
      if (e.source === "saved") return `${e.savedAction === "gift-idea" ? "When you save a gift idea" : "When you save something"}${about}`;
      if (e.source === "note") return `${e.tag ? `When you tag a note #${e.tag}` : "When you write a note"}${about}`;
      if (e.kind && EMAIL_KIND[e.kind]) return `When ${EMAIL_KIND[e.kind]}${about}`;
      if (e.connector) return `When something new comes from ${capital(e.connector)}${about}`;
      return `When something new comes in${about}`;
    }
  }
}

/** Every value's label, by "from.key": the trigger's and each step's that gives any. */
export function valueLabels(triggerGives: FlowValue[], steps: FlowStep[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of triggerGives) out.set(`trigger.${g.key}`, g.label);
  const walk = (list: FlowStep[]) => {
    for (const s of list) {
      if ((s.kind === "tool" || s.kind === "think") && s.gives) for (const g of s.gives) out.set(`${s.id}.${g.key}`, g.label);
      if (s.kind === "check") walk([...s.yes, ...s.no]);
      if (s.kind === "ask") for (const c of s.choices) walk(c.steps);
    }
  };
  walk(steps);
  return out;
}

/** FlowText as parts: its words, and each value as a chip with its label. */
export function textParts(t: FlowText | undefined, labels: Map<string, string>): WordPart[] {
  return (t ?? []).map((p) => (typeof p === "string" ? p : { chip: labels.get(`${p.from}.${p.key}`) ?? p.key.replace(/_/g, " ") }));
}

/** What each of Ask's common tools does, as a step's opening words. Others read from their name. */
const TOOL_WORDS: Record<string, string> = {
  add_reminder: "Remind me",
  add_todo: "Add a to-do",
  add_to_list: "Add to a list",
  save_note: "Save a note",
  remember: "Remember about someone",
  complete_todo: "Tick off a to-do",
  change_todo: "Change a to-do",
  draft_message: "Draft a message",
  draft_email: "Draft an email",
  find_notes: "Find notes",
  find_people: "Find people",
  find_todos: "Find to-dos",
  find_items: "Find in Athena",
  find_saved: "Find saved things",
  money: "Look at payments",
  regular_payments: "Look at regular payments",
  weather: "Check the weather",
  flight_status: "Check the flight",
  train_status: "Check the train",
  trips: "Look at trips",
  purchases: "Look at orders",
  log_spending: "Log a payment",
  track: "Start tracking",
  save_item: "Save to Athena",
  link_records: "Link records",
  fill_template: "Start a note from a template",
  make_document: "Make a document",
  log_catch_up: "Log a catch-up",
};

/** The field whose words best say what a tool step is about. */
const MAIN_FIELDS = ["text", "title", "item", "about", "query", "body", "name", "label"];

/** A tool's opening words: "Remind me", or "Find watch read" from find_watch_read. */
export function toolWords(tool: string): string {
  return TOOL_WORDS[tool] ?? capital(tool.replace(/_/g, " "));
}

const OP_WORDS: Record<Exclude<CheckOp, "up_by_pct" | "exists" | "missing">, string> = {
  is: "is",
  is_not: "isn't",
  contains: "has",
  more_than: "is more than",
  less_than: "is less than",
};

/** One step's line, without its branches. Its owner's own title wins. */
export function stepParts(s: FlowStep, labels: Map<string, string>): WordPart[] {
  if (s.title) return [s.title];
  const chip = (from: string, key: string): WordPart => ({ chip: labels.get(`${from}.${key}`) ?? key.replace(/_/g, " ") });
  switch (s.kind) {
    case "tool": {
      if (s.tool === "add_reminder") {
        const parts: WordPart[] = ["Remind me"];
        const time = s.input.time;
        const date = s.input.date;
        if (time?.length) parts.push(" at ", ...textParts(time, labels));
        if (date?.length) parts.push(" on ", ...textParts(date, labels));
        if (s.input.text?.length) parts.push(": ", ...textParts(s.input.text, labels));
        return parts;
      }
      if (s.tool === "money" && s.input.merchant?.length) return ["Look at payments to ", ...textParts(s.input.merchant, labels)];
      const main = MAIN_FIELDS.find((f) => s.input[f]?.length);
      return main ? [`${toolWords(s.tool)}: `, ...textParts(s.input[main], labels)] : [toolWords(s.tool)];
    }
    case "check": {
      const c = s.condition;
      const left = chip(c.left.from, c.left.key);
      if (c.op === "exists") return ["If ", left, " is there"];
      if (c.op === "missing") return ["If ", left, " is missing"];
      const right = (r: typeof c.right): WordPart => (r && typeof r === "object" ? chip(r.from, r.key) : String(r ?? ""));
      if (c.op === "up_by_pct") return ["If ", left, ` is up more than ${c.right}% on `, c.against ? chip(c.against.from, c.against.key) : "before"];
      return ["If ", left, ` ${OP_WORDS[c.op]} `, right(c.right)];
    }
    case "ask":
      return ["Ask me: ", ...textParts(s.question, labels)];
    case "wait": {
      if (s.before) return [s.days ? `Wait until ${s.days} day${s.days === 1 ? "" : "s"} before ` : "Wait until ", chip(s.before.from, s.before.key), s.at ? ` at ${s.at}` : ""];
      if (s.days) return [`Wait ${s.days} day${s.days === 1 ? "" : "s"}${s.at ? `, until ${s.at}` : ""}`];
      return [s.at ? `Wait until ${s.at}` : "Wait"];
    }
    case "notify":
      return ["Tell me: ", ...textParts(s.text, labels)];
    case "think":
      return ["Think: ", ...textParts(s.task, labels)];
    case "assignment":
      return ["Start an assignment: ", ...textParts(s.brief, labels)];
  }
}

/** Parts as plain text, a chip as its label in square brackets. */
export function plainWords(parts: WordPart[]): string {
  return parts.map((p) => (typeof p === "string" ? p : `[${p.chip}]`)).join("");
}

/** The whole flow in plain lines, each branch indented: for the model to describe it back. */
export function flowLines(trigger: FlowTrigger, triggerGives: FlowValue[], steps: FlowStep[]): string[] {
  const labels = valueLabels(triggerGives, steps);
  const out = [triggerWords(trigger)];
  const walk = (list: FlowStep[], indent: string) => {
    for (const s of list) {
      const waits = s.kind === "tool" && s.go === "ask" ? " (waits for Go)" : "";
      out.push(`${indent}${plainWords(stepParts(s, labels))}${waits}`);
      if (s.kind === "check") {
        if (s.yes.length) (out.push(`${indent}  Yes:`), walk(s.yes, `${indent}    `));
        if (s.no.length) (out.push(`${indent}  No:`), walk(s.no, `${indent}    `));
      }
      if (s.kind === "ask") for (const c of s.choices) (out.push(`${indent}  ${c.label}:`), walk(c.steps, `${indent}    `));
    }
  };
  walk(steps, "  ");
  return out;
}


/** "Whenever…", "every time…", "each time…": what Ask turns into a flow (propose_flow, and sample mode's stand-in). */
export const FLOW_WORDS = /\b(every\s*time|whenever|each\s*time)\b/i;
