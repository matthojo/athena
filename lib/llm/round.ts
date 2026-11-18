/** One call to a provider, in the shape every adapter hands back (lib/llm/client.ts turns rounds into Anthropic messages). */
import type { Anthropic } from "../ai";
import type { Params, Usage } from "./shared";

export type RoundBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface Round {
  content: RoundBlock[];
  /** "malformed": the model tried to call a tool and the call couldn't be read (Gemini says so); asked once more. */
  stop: Anthropic.StopReason | "malformed";
  usage: Usage;
}

/** As a round streams: words, a tool call starting (key: its place in this round), and its arguments in pieces. */
export type RoundEvent = { type: "text"; text: string } | { type: "tool"; key: number; id: string; name: string } | { type: "args"; key: number; json: string };

export interface Adapter {
  send(params: Params, signal: AbortSignal): Promise<Round>;
  stream(params: Params, signal: AbortSignal, on: (event: RoundEvent) => void): Promise<Round>;
}
