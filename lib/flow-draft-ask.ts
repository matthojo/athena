/**
 * Ask's propose_flow (lib/assistant.ts offers and runs it): when the owner
 * says "every time…", "whenever…" or "each time…", Ask draws the flow from
 * their words (lib/flow-draft.ts), keeps it paused, and the reply carries an
 * AskFlowCard with Turn on and Edit steps. Ask may still do the one-off part
 * straight away with its usual tools ("…and add one for the parcel already on
 * its way").
 *
 * Saving goes through a tiny port, FlowCreator, so Ask's code doesn't import
 * the engine: lib/flow-engine.ts registers the engine's createFlow with
 * useFlowCreator. In a function that hasn't loaded it, propose_flow says flows
 * aren't ready, and Ask offers something else.
 *
 * Only main Ask proposes flows: never an assistant's turn or a stage of an
 * assignment. It's never queued as a plan step: the flow it saves is off.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import type { AskFlowCard, Flow, FlowInput } from "./flow-types";
import { currentStage } from "./assignment-tools";
import { currentChecker } from "./trackers-store";
import { draftFlow, MAX_SENTENCE, type DraftDeps } from "./flow-draft";
import { flowLines } from "./flow-draft-words";

export const FLOW_TOOL_NAME = "propose_flow";

/** Where a proposed flow is kept. The engine implements it (POST /api/flows does the same). */
export interface FlowCreator {
  create(input: FlowInput): Promise<Flow>;
}

let creator: FlowCreator | null = null;

/** Register how flows are saved (the engine, or a test's fake). Null takes it away. */
export function useFlowCreator(c: FlowCreator | null): void {
  creator = c;
}

export const PROPOSE_FLOW_TOOL: Anthropic.Tool = {
  name: FLOW_TOOL_NAME,
  description:
    "Set up a flow: something Athena does on its own every time something happens (an email arrives, the owner saves something or writes a note, before an event or a date, or on a schedule). Use it when the owner says \"every time…\", \"whenever…\" or \"each time…\", or asks for something to happen again on its own when something comes in. " +
    "It draws the flow from their words and keeps it switched off: nothing runs until the owner taps Turn on on the card. " +
    "If the request also covers something already here (a parcel already on its way, tomorrow's meeting), do that part now with your usual tools as well. " +
    "For a plain schedule with nothing arriving (\"every Friday at 4pm, tell me what slipped\"), use save_routine instead. " +
    "After calling it, say in one or two short sentences what the flow will do, whether it can run on its own or waits for their approval, and that it's off until they turn it on. Never say it's on.",
  input_schema: {
    type: "object",
    properties: {
      sentence: { type: "string", description: "What should happen and when, in the owner's words, with everything they said about it." },
    },
    required: ["sentence"],
  },
};

const Input = z.object({ sentence: z.string().trim().min(1, "say what should happen").max(MAX_SENTENCE) });

/** The tools as this turn gets them: propose_flow in main Ask's own turn only. */
export function withFlowTool(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (currentStage() || currentChecker().by === "assistant") return tools;
  return [...tools, PROPOSE_FLOW_TOOL];
}

/** What the tool needs from the Session that runs it. */
export interface FlowToolContext {
  client?: Anthropic;
  /** "Let Ask read transactions" is on. */
  money: boolean;
  /** The card this turn's reply carries, once there is one. */
  flow?: AskFlowCard;
  /** Swapped for a test's or the engine's: the drafting deps beyond these. */
  draft?: Pick<DraftDeps, "tools" | "triggerGives" | "now" | "tz">;
}

/** The card a saved flow shows on Ask's reply. Pure. */
export function flowCard(flow: Flow): AskFlowCard {
  return { flow_id: flow.id, flow: { name: flow.name, trigger: flow.trigger, trigger_gives: flow.trigger_gives, steps: flow.steps, assistant_id: flow.assistant_id } };
}

/** Run propose_flow. Null when `name` is another tool: the Session carries on as usual. */
export async function runFlowTool(name: string, raw: unknown, ctx: FlowToolContext): Promise<string | null> {
  if (name !== FLOW_TOOL_NAME) return null;
  if (currentStage() || currentChecker().by === "assistant") throw new Error("Only Athena sets up flows. Say what you'd suggest instead.");
  if (ctx.flow) throw new Error("One flow per reply: it's on the card already. Say what it does.");
  if (!creator) throw new Error("Flows aren't ready in this copy of Athena yet. Tell the owner, and offer a reminder or a routine instead.");
  const { sentence } = Input.parse(raw ?? {});
  const draft = await draftFlow(sentence, { ...ctx.draft, client: ctx.client, money: ctx.money, origin: "ask" });
  const saved = await creator.create({ ...draft.flow, paused: true, origin: "ask" });
  ctx.flow = flowCard(saved);
  return JSON.stringify({
    saved: true,
    on: false,
    name: saved.name,
    flow: flowLines(saved.trigger, saved.trigger_gives, saved.steps).join("\n"),
    ...(draft.notes.length ? { left_out: draft.notes } : {}),
    ...(draft.fallback ? { drawn: false, say: "Athena couldn't draw the steps. Say the flow is there to fill in with Edit steps." } : {}),
  });
}
