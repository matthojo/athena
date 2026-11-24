/**
 * The tools Assignments add to Ask's loop (docs/team.md, "How it runs" and
 * "Checkpoints and questions"). lib/assistant.ts offers and runs them; they
 * are never queued as plan steps.
 *
 * - A stage's own tools, offered only inside a stage's turn (`asStage`, set
 *   by the runner in lib/assignment-run.ts): `hand_off({ did, open, next })`
 *   ends the stage, and `ask_owner({ questions })` stops it with 1–3
 *   questions, each with a suggested answer. A question without one is
 *   refused, so there's always a way on. Inside a stage this `ask_owner`
 *   takes the place of Ask's one-question tool of the same name.
 *   What they're given is kept on the stage's desk for the runner; neither
 *   changes anything itself, and the runner alone moves the work on.
 * - Main Ask's `start_assignment({ brief })`, which proposes a lineup and
 *   keeps it as a draft for the owner's Go, and
 *   `continue_assignment({ id?, use_suggestions? })`. An assistant's own
 *   turn never gets these, so a stage can't start or move an assignment.
 *
 * Types only from the runner: it's loaded when a tool is called, so this
 * module stays light for lib/assistant.ts to import.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Anthropic } from "./ai";
import { ASSIGNMENT_LIMITS as L, type AskLineup, type Handoff, type StageQuestion } from "./assignment-types";
import { MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, MIN_CHOICES } from "./team-skill";
import { currentChecker } from "./trackers-store";
import { relinked } from "./run-links";

/** The most a stage may hand in as the work product. */
export const MAX_WORK = 60_000;

/** What a stage's tools were given in one turn, for the runner to read when the turn ends. */
export interface StageDesk {
  /** Its place in the lineup, from 1, and each earlier stage it may send the work back to. */
  position: number;
  earlier: Array<{ position: number; label: string }>;
  /** Whether a send-back is still to be had (one per assignment). */
  canSendBack: boolean;
  /** Whether it may still stop with questions. */
  canAsk: boolean;
  handoff: Handoff | null;
  /** The work product as this stage leaves it: the whole document, in Markdown. Null: unchanged. */
  work: string | null;
  sendBack: { to: number; note: string } | null;
  questions: StageQuestion[];
}

export function newDesk(at: Pick<StageDesk, "position" | "earlier" | "canSendBack" | "canAsk">): StageDesk {
  return { ...at, handoff: null, work: null, sendBack: null, questions: [] };
}

const stages = new AsyncLocalStorage<StageDesk>();

/** Run `fn` as a stage's turn: its tools are offered, and what they're given lands on `desk`. */
export const asStage = <T>(desk: StageDesk, fn: () => T): T => stages.run(desk, fn);
/** The stage this turn belongs to, or null. */
export const currentStage = (): StageDesk | null => stages.getStore() ?? null;

// ---------- a stage's tools ----------

export const HAND_OFF_TOOL: Anthropic.Tool = {
  name: "hand_off",
  description:
    "End your stage of the assignment and pass the work on. Call it once, when your part is done. Put the whole document as you leave it in `work` (Markdown); leave `work` out if you changed nothing. `did`, `open` and `next` are your handoff to the next role. You don't choose who goes next: Athena moves the work on.",
  input_schema: {
    type: "object",
    properties: {
      did: { type: "string", description: "What you did, in a few plain sentences." },
      open: { type: "string", description: "What's unresolved or unsure. Empty if nothing." },
      next: { type: "string", description: "What the next role should look at first." },
      work: { type: "string", description: "The whole work product as you leave it, in Markdown: every section, not only what you changed." },
      send_back_to: { type: "integer", description: "Only when an earlier stage must redo part of it: that stage's number. Allowed once per assignment; say exactly what to change in `open`." },
    },
    required: ["did", "open", "next"],
  },
};

export const STAGE_ASK_TOOL: Anthropic.Tool = {
  name: "ask_owner",
  description: `Stop your stage and ask the owner, only when you can't go on without them. One to ${L.questions} questions, asked together. Every question needs choices, the index of the one you suggest, and one line saying why: the owner may tell Athena to carry on with your suggestions. Their answers come back in your next turn.`,
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "One short question." },
            choices: { type: "array", items: { type: "string" }, description: `${MIN_CHOICES} to ${MAX_CHOICES} short answers.` },
            allow_other: { type: "boolean", description: "May the owner write their own answer? Default true." },
            suggested: { type: "integer", description: "The index (from 0) of the choice you'd take." },
            why: { type: "string", description: `One line: why that one. At most ${L.why} characters.` },
          },
          required: ["question", "choices", "suggested", "why"],
        },
      },
    },
    required: ["questions"],
  },
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const HandOffInput = z.object({
  did: z.string().trim().min(1, "say what you did"),
  open: z.string().trim().default(""),
  next: z.string().trim().default(""),
  work: z.string().max(MAX_WORK * 2).optional(),
  send_back_to: z.number().int().min(1).max(L.maxStages).optional(),
});

/** A handoff cut to its limit (2,000 characters across its three parts), `did` first. Pure. */
export function fitHandoff(h: Handoff): Handoff {
  const did = clip(h.did.trim(), Math.floor(L.handoff / 2));
  const open = clip(h.open.trim(), Math.floor((L.handoff - did.length) / 2));
  const next = clip(h.next.trim(), L.handoff - did.length - open.length);
  return { did, open, next };
}

const AskInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        choices: z.array(z.string()),
        allow_other: z.boolean().optional(),
        suggested: z.number().int().optional(),
        why: z.string().optional(),
      }),
    )
    .min(1, "ask at least one question"),
});

/**
 * A stage's questions, checked: 1–3, each with 2–5 choices, a suggested one and why. Throws a line the model can
 * read: a question without a suggestion is refused. Pure.
 */
export function fitStageQuestions(raw: unknown): StageQuestion[] {
  const input = AskInput.parse(raw ?? {});
  if (input.questions.length > L.questions) throw new Error(`Ask ${L.questions} questions at most in one stop. Ask the ones you can't go on without.`);
  return input.questions.map((q, i) => {
    const n = i + 1;
    const question = clip(oneLine(q.question), MAX_QUESTION);
    if (question.length < 5) throw new Error(`Question ${n}: write the question.`);
    const choices = [...new Set(q.choices.map(oneLine).filter(Boolean).map((c) => clip(c, MAX_CHOICE)))].slice(0, MAX_CHOICES);
    if (choices.length < MIN_CHOICES) throw new Error(`Question ${n}: give ${MIN_CHOICES} to ${MAX_CHOICES} choices.`);
    const why = clip(oneLine(q.why ?? ""), L.why);
    if (q.suggested === undefined || q.suggested < 0 || q.suggested >= choices.length || !why) throw new Error(`Question ${n}: not asked. Every question needs "suggested" (the index of the choice you'd take) and "why" (one line), so the owner can carry on with your suggestions.`);
    return { id: `q${n}`, question, choices, allowOther: q.allow_other !== false, suggested: q.suggested, why };
  });
}

/** What Ask's loop stops on (lib/assistant.ts Session): the question and its buttons. */
interface Asking {
  question: string;
  choices: string[];
}

function runStageTool(desk: StageDesk, name: string, raw: unknown, session: Asking): string {
  if (name === "hand_off") {
    const input = HandOffInput.parse(raw ?? {});
    if (desk.questions.length) throw new Error("You've asked the owner. Stop here: their answers come back in your next turn.");
    if (input.work !== undefined && relinked(input.work).length > MAX_WORK) throw new Error(`work: keep the document under ${MAX_WORK.toLocaleString("en-GB")} characters.`);
    let sendBack: StageDesk["sendBack"] = null;
    if (input.send_back_to !== undefined) {
      if (!desk.canSendBack) throw new Error("Not sent back: this assignment has had its one send-back. Hand off without send_back_to and say what's wrong in open: it goes to the owner.");
      if (!desk.earlier.some((e) => e.position === input.send_back_to)) throw new Error(`Not sent back: send_back_to must be an earlier stage (${desk.earlier.map((e) => `${e.position}: ${e.label}`).join(", ") || "there is none"}).`);
      if (!input.open) throw new Error("Not sent back: say exactly what that stage should change, in open.");
      sendBack = { to: input.send_back_to, note: clip(input.open, L.handoff) };
    }
    // Its message wrote links so they couldn't be opened (lib/run-links.ts); what it hands back has them as they were.
    desk.handoff = fitHandoff({ did: relinked(input.did), open: relinked(input.open ?? ""), next: relinked(input.next ?? "") });
    desk.work = input.work?.trim() ? relinked(input.work) : desk.work;
    desk.sendBack = sendBack;
    return JSON.stringify({ done: sendBack ? `Handed off, and sent back to stage ${sendBack.to}` : "Handed off", note: "Athena moves the work on. Finish now with one or two sentences saying what you did." });
  }
  // ask_owner, a stage's: the turn stops here, as Ask's own does.
  if (desk.handoff) throw new Error("You've handed off. Finish with your answer.");
  if (!desk.canAsk) throw new Error("Not asked: you've asked the owner already. Go on with your best judgement, and say what you assumed under open in your hand_off.");
  const questions = fitStageQuestions(raw);
  desk.questions = questions;
  session.question = questions[0].question;
  session.choices = questions[0].choices;
  return "Asked. Stop here: the owner's answers come back in your next turn.";
}

// ---------- main Ask's tools ----------

export const START_TOOL_NAME = "start_assignment";
export const CONTINUE_TOOL_NAME = "continue_assignment";

const ASK_TOOLS: Anthropic.Tool[] = [
  {
    name: START_TOOL_NAME,
    description:
      "Set up an assignment: one piece of work passed along a line of the owner's assistants with different roles (Engineer → SEO → Reviewer), ending in one document. Use it when the owner asks for work that needs more than one role, or asks for an assignment. It proposes the lineup and keeps it as a draft: nothing runs until the owner taps Approve on the lineup. After calling it, say in one short sentence who's in the lineup and that it's waiting for their approval; never say it has started.",
    input_schema: {
      type: "object",
      properties: { brief: { type: "string", description: "What the owner wants done, in their words, with everything they said about it." } },
      required: ["brief"],
    },
  },
  {
    name: CONTINUE_TOOL_NAME,
    description:
      "Carry on with an assignment that's waiting for the owner, when they say so. With use_suggestions: true (\"continue and use all suggested routes\"), its open questions are answered as its stage suggested, and so are later ones, without stopping. Without it, a stage waiting for approval is approved. It never approves a change that waits as a plan, and never starts a lineup: those take the owner's own tap.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The assignment's id. Leave out when only one is waiting." },
        use_suggestions: { type: "boolean", description: "Answer its questions as suggested, from here on." },
      },
    },
  },
];

const ASK_TOOL_NAMES = new Set(ASK_TOOLS.map((t) => t.name));

/** Every name here that a Session runs (lib/assistant.ts SESSION_TOOL_NAMES). `ask_owner` is already Ask's. */
export const ASSIGNMENT_TOOL_NAMES: readonly string[] = [HAND_OFF_TOOL.name, ...ASK_TOOL_NAMES];

/** An assistant is speaking, not main Ask: every turn of one runs as its tracker checker (lib/team-chat.ts runAssistantTurn). */
const assistantTurn = (): boolean => currentChecker().by === "assistant";

/**
 * The Session's tools as this turn gets them. In a stage: `hand_off`, and the stage's `ask_owner` in place of
 * Ask's. In main Ask's own turn: start_assignment and continue_assignment. An assistant's chat or run outside a
 * stage gets neither.
 */
export function withAssignmentTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (currentStage()) return [...tools.map((t) => (t.name === STAGE_ASK_TOOL.name ? STAGE_ASK_TOOL : t)), HAND_OFF_TOOL];
  return assistantTurn() ? tools : [...tools, ...ASK_TOOLS];
}

const StartInput = z.object({ brief: z.string().trim().min(1, "say what the assignment is").max(L.brief) });
const ContinueInput = z.object({ id: z.string().uuid().optional(), use_suggestions: z.boolean().optional() });

/** What a tool here needs from the Session that runs it. */
export interface AssignmentToolContext extends Asking {
  /** The conversation the request came from, when the Session knows it. */
  threadId?: string | null;
  /** start_assignment's lineup, for the reply to carry as a card. */
  lineup?: AskLineup;
}

/**
 * Run one of the tools above. Null when `name` isn't one of them here (Ask's own `ask_owner` outside a stage, or
 * any other tool): the Session carries on as usual.
 */
export async function runAssignmentTool(name: string, raw: unknown, ctx: AssignmentToolContext): Promise<string | null> {
  const desk = currentStage();
  if (desk && (name === HAND_OFF_TOOL.name || name === STAGE_ASK_TOOL.name)) return runStageTool(desk, name, raw, ctx);
  if (name === HAND_OFF_TOOL.name) throw new Error("hand_off is only for a stage of an assignment.");
  if (!ASK_TOOL_NAMES.has(name)) return null;
  if (desk || assistantTurn()) throw new Error("Only Athena starts or moves an assignment. Say what you'd suggest instead.");
  const run = await import("./assignment-run");
  if (name === START_TOOL_NAME) {
    const { brief } = StartInput.parse(raw ?? {});
    const { card, ...told } = await run.draftAssignment(brief, { threadId: ctx.threadId ?? null });
    ctx.lineup = card;
    return JSON.stringify(told);
  }
  const input = ContinueInput.parse(raw ?? {});
  return JSON.stringify(await run.continueAssignment(input.id ?? null, { useSuggestions: input.use_suggestions === true }));
}
