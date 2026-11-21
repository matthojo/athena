/**
 * Flow suggestions (lib/flow-suggest.ts, lib/flow-types.ts):
 *
 *   GET  /api/flows/suggestions              → { suggestions: FlowSuggestion[] }   at most three, best first
 *   POST /api/flows/suggestions/:id/dismiss  → { ok: true }                         for good; saying it twice is fine
 *
 * Worked out on each GET from what's already in Athena: nothing leaves the
 * site and no model is asked. A suggestion that's dismissed, already a flow,
 * or that wouldn't pass the engine's checks isn't offered. Behind the same
 * bearer token as the rest of the API.
 */
import { FLOW_LIMITS, type FlowSuggestion } from "../../lib/flow-types";
import { detectAll, pickSuggestions, type SuggestSignals } from "../../lib/flow-suggest";
import { SUGGESTION_ID, type FlowReader } from "../../lib/flow-suggest-store";

type Json = (data: unknown, status?: number) => Response;

export interface FlowSuggestDeps {
  signals(now: Date): Promise<SuggestSignals>;
  timeZone(): Promise<string>;
  dismissed(): Promise<Set<string>>;
  dismiss(id: string): Promise<void>;
  flows: FlowReader;
  now?: () => Date;
}

/** The suggestions to offer now. */
export async function currentSuggestions(deps: FlowSuggestDeps): Promise<FlowSuggestion[]> {
  const now = deps.now?.() ?? new Date();
  const [signals, tz, dismissed, flows] = await Promise.all([
    deps.signals(now),
    deps.timeZone(),
    deps.dismissed(),
    // A port that can't answer yet offers nothing rather than something that may already be a flow.
    deps.flows.list().catch((error) => {
      console.error("Athena flow suggestions: couldn't read flows", (error as Error)?.message?.slice(0, 120));
      return null;
    }),
  ]);
  if (!flows) return [];
  return pickSuggestions(detectAll(signals, { now, tz }), { dismissed, flows, maxFlows: FLOW_LIMITS.flows });
}

/** `segments` from "flows" on: ["flows", "suggestions", …]. Null when the path isn't one of these. */
export async function handleFlowSuggestRoutes(req: Request, segments: string[], json: Json, deps: FlowSuggestDeps): Promise<Response | null> {
  const [first, second, id, action] = segments;
  if (first !== "flows" || second !== "suggestions") return null;
  if (segments.length === 2) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json({ suggestions: await currentSuggestions(deps) });
  }
  if (segments.length === 4 && action === "dismiss") {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!SUGGESTION_ID.test(id)) return json({ error: "That isn't a suggestion" }, 400);
    await deps.dismiss(id);
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
