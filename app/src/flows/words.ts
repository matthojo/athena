/**
 * Flows in words (lib/writing-style.ts: plain, British, sentence case):
 * what starts a flow, each step's default title, a condition as a sentence,
 * a flow's state for its card, and a run's headline. Pure, so it's tested.
 */
import type { CatalogEntry, CheckOp, Flow, FlowCondition, FlowRun, FlowStep, FlowText, FlowTrigger, FlowValue, ValueKind, ValueRef } from "../../../lib/flow-types";
import { clockWords, daysWords, EMAIL_KINDS, eventWords as teamEventWords, prefers12h } from "../team/trigger-editor-words";
import type { EventFilter } from "../../../lib/team-types";
import { countSteps } from "./tree";
import { isDraftTool } from "./steps";

// ---------- what starts it ----------

/** Team's words for an event, with a kind of email standing on its own (any mail account). */
export function eventWords(e: EventFilter): string {
  const mailKind = e.source === "collected" && !e.connector && e.kind && EMAIL_KINDS.some((k) => k.kind === e.kind);
  return teamEventWords(mailKind ? { ...e, connector: "gmail" } : e);
}

function minutesWords(m: number): string {
  if (m >= 60 && m % 60 === 0) return m === 60 ? "An hour" : `${m / 60} hours`;
  return `${m} minutes`;
}

function daysBefore(n: number): string {
  if (n === 0) return "On the day of";
  if (n === 1) return "The day before";
  if (n === 7) return "A week before";
  return `${n} days before`;
}

/** Date kinds a "before a date" trigger can follow, as the owner reads them. */
export const DATE_KINDS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "birthday", label: "a birthday" },
  { kind: "anniversary", label: "an anniversary" },
  { kind: "renewal", label: "a renewal" },
  { kind: "deadline", label: "a deadline" },
  { kind: "trip", label: "a trip" },
];

/** "Every Friday at 5:00 pm", "When an email is a renewal", "30 minutes before an event with people you know". */
export function triggerWords(t: FlowTrigger, hour12 = prefers12h()): string {
  switch (t.kind) {
    case "schedule":
      return `${daysWords(t.days)} at ${clockWords(t.time, hour12)}`;
    case "event":
      return `When ${eventWords(t.event)}`;
    case "before":
      if (t.what === "event") {
        const base = `${minutesWords(t.minutes)} before ${t.withPeople ? "an event with people you know" : "an event"}`;
        return t.match ? `${base}, if it says “${t.match}”` : base;
      } else {
        const what = DATE_KINDS.find((k) => k.kind === t.eventKind)?.label ?? "a date";
        const base = `${daysBefore(t.days)} ${what}, at ${clockWords(t.at, hour12)}`;
        return t.match ? `${base}, if it says “${t.match}”` : base;
      }
    case "manual":
      return "Only when you run it";
  }
}

/** The trigger card's title: shorter, as a clause. "An email is a renewal". */
export function triggerTitle(t: FlowTrigger, hour12 = prefers12h()): string {
  if (t.kind === "event") {
    const w = eventWords(t.event);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return triggerWords(t, hour12);
}

/** "Try it on the last renewal": what a dry run is tried on. */
export function tryWords(t: FlowTrigger): string {
  if (t.kind === "event") {
    const k = t.event.kind ?? t.event.savedAction;
    const noun: Record<string, string> = {
      renewal: "renewal",
      delivery: "delivery",
      booking: "booking",
      appointment: "appointment",
      deadline: "deadline",
      email: "email",
      issue: "issue",
      "gift-idea": "gift idea",
      gift_idea: "gift idea",
      saved: "thing you saved",
    };
    return `Try it on the last ${noun[k ?? ""] ?? (t.event.source === "note" ? "note" : "one")}`;
  }
  if (t.kind === "before") return t.what === "event" ? "Try it on your last event" : "Try it on the last date";
  if (t.kind === "schedule") return "Try it on the last time";
  return "Try it now";
}

// ---------- steps ----------

/** A tool's step, when the owner hasn't named it and the catalogue has no label. */
const TOOL_WORDS: Record<string, string> = {
  find_notes: "Find notes",
  find_people: "Look up a person",
  find_todos: "Find to-dos",
  money: "Look up spending",
  weather: "Check the weather",
  flight_status: "Check a flight",
  train_status: "Check a train",
  add_todo: "Add a to-do",
  add_reminder: "Remind me",
  save_note: "Save a note",
  add_to_list: "Add to a list",
  draft_email: "Draft an email",
  draft_message: "Draft a message",
};

/** A step's title: the owner's own, else words for what it does. */
export function stepTitle(step: FlowStep, catalog: readonly CatalogEntry[] = [], assistantName?: string | null): string {
  if (step.title?.trim()) return step.title.trim();
  switch (step.kind) {
    case "tool":
      return TOOL_WORDS[step.tool] ?? catalog.find((c) => c.kind === "tool" && c.tool === step.tool)?.label ?? step.tool.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    case "check":
      return "Check something";
    case "ask":
      return "Ask me";
    case "wait":
      return step.before ? `Wait until ${dayCount(step.days)} before` : `Wait ${dayCount(step.days)}`;
    case "notify":
      return "Tell me";
    case "think":
      return assistantName ? `${assistantName} thinks` : "Think";
    case "assignment":
      return "Start an assignment";
  }
}

const dayCount = (n: number) => (n === 0 ? "the day" : n === 1 ? "a day" : n === 7 ? "a week" : `${n} days`);

/** The colour a step takes: blue for a plain step, violet for thinking, amber when it waits for you. */
export type Tone = "trigger" | "step" | "think" | "you";

export function stepTone(step: FlowStep): Tone {
  if (step.kind === "think") return "think";
  if (step.kind === "ask") return "you";
  return "step";
}

/** Does this step change something, and wait for the owner's Go first? */
export const waitsForGo = (step: FlowStep): boolean => step.kind === "tool" && (step.go === "ask" || isDraftTool(step.tool));

/** The graph's colour for a kind of value (--graph-* in tokens.css). */
export function valueColour(kind: ValueKind): string {
  switch (kind) {
    case "person":
      return "var(--graph-person)";
    case "organisation":
      return "var(--graph-organisation)";
    case "place":
    case "trip":
      return "var(--graph-place)";
    case "event":
    case "date":
    case "datetime":
      return "var(--graph-event)";
    case "saved":
      return "var(--graph-saved)";
    case "note":
    case "email":
    case "todo":
      return "var(--graph-note)";
    case "money":
    case "number":
      return "var(--good)";
    default:
      return "var(--graph-detail)";
  }
}

// ---------- conditions ----------

export const OPS: ReadonlyArray<{ op: CheckOp; words: string; needsRight: boolean }> = [
  { op: "is", words: "is", needsRight: true },
  { op: "is_not", words: "isn't", needsRight: true },
  { op: "contains", words: "contains", needsRight: true },
  { op: "more_than", words: "is more than", needsRight: true },
  { op: "less_than", words: "is less than", needsRight: true },
  { op: "up_by_pct", words: "is up by at least", needsRight: true },
  { op: "exists", words: "is there", needsRight: false },
  { op: "missing", words: "is missing", needsRight: false },
];

type Label = (r: ValueRef) => string;

/** A condition as plain text, with each value as its label: "the price is up by at least 10% on last year's price". */
export function conditionWords(c: FlowCondition, label: Label): string {
  const left = label(c.left);
  const right = c.right === undefined ? "" : typeof c.right === "object" ? label(c.right) : String(c.right);
  if (c.op === "up_by_pct") return `${left} is up by at least ${right}% on ${c.against ? label(c.against) : "before"}`;
  const words = OPS.find((o) => o.op === c.op)?.words ?? c.op;
  return OPS.find((o) => o.op === c.op)?.needsRight ? `${left} ${words} ${right}`.trim() : `${left} ${words}`;
}

/** The branch names under a Check. */
export const BRANCH_WORDS = { yes: "If so", no: "Otherwise" } as const;

// ---------- text with values ----------

/** A label for every value pointer: from the trigger, else from the step that gives it. */
export function labeller(flow: Pick<Flow, "trigger_gives" | "steps">, findGives: (stepId: string) => FlowValue[] | undefined): Label {
  return (r) => {
    const v = r.from === "trigger" ? flow.trigger_gives.find((x) => x.key === r.key) : findGives(r.from)?.find((x) => x.key === r.key);
    return v?.label ?? r.key.replace(/_/g, " ");
  };
}

/** FlowText as plain text, each value by its label, or by its value when one is known. */
export function plainText(t: FlowText, label: Label, values?: Record<string, string>): string {
  return t.map((p) => (typeof p === "string" ? p : (values?.[`${p.from}.${p.key}`] ?? label(p)))).join("");
}

export const isEmptyText = (t: FlowText | undefined): boolean => !t || t.every((p) => typeof p === "string" && !p.trim());

// ---------- a flow's state ----------

export type FlowBadge = { tone: "you" | "on" | "off" | "bad" | "quiet"; words: string };

/** The badge on a flow's card: what waits for you first, then on or off. */
export function flowBadge(flow: Pick<Flow, "paused">, latest?: Pick<FlowRun, "status" | "waits_for" | "dry"> | null): FlowBadge {
  if (latest && latest.status === "waiting" && !latest.dry) {
    if (latest.waits_for === "go") return { tone: "you", words: "Needs your Go" };
    if (latest.waits_for === "answer") return { tone: "you", words: "Asks you something" };
    if (latest.waits_for === "time") return { tone: "quiet", words: "Waiting" };
    if (latest.waits_for === "assignment") return { tone: "quiet", words: "On an assignment" };
  }
  if (latest && (latest.status === "running" || latest.status === "queued")) return { tone: "quiet", words: "Running" };
  if (flow.paused) return { tone: "off", words: "Off" };
  if (latest?.status === "failed" && !latest.dry) return { tone: "bad", words: "Didn't finish" };
  return { tone: "on", words: "On" };
}

/** The line under the Flows title: how today went and what waits for you. */
export function listLede(flows: ReadonlyArray<Pick<Flow, "id" | "name" | "paused">>, latest: Record<string, Pick<FlowRun, "status" | "waits_for" | "started_at" | "dry">>, now = new Date()): string {
  if (!flows.length) return "A flow does the same few things for you each time something happens.";
  const today = (iso: string) => new Date(iso).toDateString() === now.toDateString();
  const ran = flows.filter((f) => latest[f.id] && !latest[f.id].dry && today(latest[f.id].started_at)).length;
  const waiting = flows.filter((f) => latest[f.id]?.status === "waiting" && !latest[f.id].dry && (latest[f.id].waits_for === "go" || latest[f.id].waits_for === "answer"));
  const ranWords = ran === 0 ? "None ran today." : ran === 1 ? "One ran today." : `${numberWord(ran)} ran today.`;
  if (!waiting.length) {
    const on = flows.filter((f) => !f.paused).length;
    return ran ? ranWords : on ? `${numberWord(on)} ${on === 1 ? "is" : "are"} on. ${ranWords}` : "They're all off.";
  }
  const names = waiting.map((f) => f.name);
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} more`;
  return `${ranWords} ${who} ${names.length === 1 ? "needs" : "need"} you.`;
}

const NUMBER_WORDS = ["None", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

/** "Plain flow · free to run", or the assistant's line. */
export function flowKindWords(flow: Pick<Flow, "assistant_id" | "steps">, assistantName?: string | null): string {
  const n = countSteps(flow.steps);
  const steps = `${n} ${n === 1 ? "step" : "steps"}`;
  if (flow.assistant_id) return `${assistantName ?? "An assistant"} runs this · ${steps}`;
  return `Plain flow · free to run · ${steps}`;
}

// ---------- runs ----------

/** What a run waits on, for its page: "1 change waits for your Go". */
export function runStateWords(run: Pick<FlowRun, "status" | "waits_for" | "dry" | "steps">, hour12 = prefers12h(), now = new Date()): string {
  const prefix = run.dry ? "A try: nothing was changed. " : "";
  switch (run.status) {
    case "queued":
      return `${prefix}About to start`;
    case "running":
      return `${prefix}Running now`;
    case "done":
      return run.dry ? "A try: nothing was changed" : "Finished";
    case "failed":
      return `${prefix}Didn't finish`;
    case "stopped":
      return `${prefix}Stopped`;
    case "waiting": {
      if (run.waits_for === "go") {
        const n = run.steps.filter((s) => s.status === "waiting" && s.pending).length || 1;
        return `${prefix}${n === 1 ? "1 change waits" : `${n} changes wait`} for your Go`;
      }
      if (run.waits_for === "answer") return `${prefix}Waits for your answer`;
      if (run.waits_for === "assignment") return `${prefix}Waits for its assignment to finish`;
      const at = run.steps.find((s) => s.status === "waiting" && s.resumes_at)?.resumes_at;
      return at ? `${prefix}Carries on ${resumeWords(at, hour12, now)}` : `${prefix}Waiting`;
    }
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today at 8:00", "tomorrow at 9:00", "Thu 27 Nov at 8:00". */
export function resumeWords(iso: string, hour12 = prefers12h(), now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "later";
  const time = clockWords(`${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`, hour12);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(t) - day(now)) / 86_400_000);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  return `${DAY_NAMES[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]} at ${time}`;
}

/** A run's heading: "Today at 8:12 am", "Yesterday at 4:59 pm", "2 Nov at 9:00". */
export function runHeading(iso: string, hour12 = prefers12h(), now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "A run";
  const time = clockWords(`${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`, hour12);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(t)) / 86_400_000);
  if (diff === 0) return `Today at ${time}`;
  if (diff === 1) return `Yesterday at ${time}`;
  return `${t.getDate()} ${MONTHS[t.getMonth()]} at ${time}`;
}

/** The short line on a flow's card: when it last ran, and what came of it. */
export function lastRunLine(run: (Pick<FlowRun, "started_at" | "summary" | "status" | "steps" | "error" | "dry"> & { waits_for?: FlowRun["waits_for"] }) | null | undefined, hour12 = prefers12h(), now = new Date()): string {
  if (!run) return "Hasn't run yet";
  const when = runHeading(run.started_at, hour12, now);
  if (run.status === "waiting" && !run.dry) return `${when} · ${runStateWords({ ...run, waits_for: run.waits_for ?? null }, hour12, now)}`;
  const what = run.summary ?? (run.status === "failed" ? run.error : null) ?? [...run.steps].reverse().find((s) => s.status !== "skipped")?.line ?? null;
  return what ? `${when} · ${what}` : when;
}

/**
 * Why a step can't move, in words. `moved` is the step being moved; titles
 * and the value's label come from the editor.
 */
export function moveRefusal(p: { step: string; giver: string | null }, moved: string, by: -1 | 1, words: { title: (id: string) => string; value: string }): string {
  const where = by < 0 ? "above" : "below";
  if (p.step === moved && p.giver) return `This step uses ${words.value} from “${words.title(p.giver)}”, so it can't go ${where} it.`;
  if (p.giver === moved) return `“${words.title(p.step)}” uses ${words.value} from this step, so this step can't go ${where} it.`;
  if (p.giver) return `“${words.title(p.step)}” uses ${words.value} from “${words.title(p.giver)}”, which it wouldn't reach after this move.`;
  return `“${words.title(p.step)}” uses ${words.value}, which it wouldn't reach after this move.`;
}
