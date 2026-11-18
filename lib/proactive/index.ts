/** Athena speaks first: rules (rules.ts) through the shared gate (gate.ts). Pure. */
import { gate, type GateState } from "./gate";
import { allNudges } from "./rules";
import type { ProactiveInput } from "./types";

export * from "./types";
export * from "./gate";
export * from "./rules";

/** What goes out on this run, and what was held and why. */
export function proactiveNudges(input: ProactiveInput, state: GateState) {
  return gate(allNudges(input, { replyDays: state.prefs.reply_days }), state);
}
