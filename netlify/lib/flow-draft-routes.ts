/**
 * Flows drafting (lib/flow-draft.ts):
 *
 *   POST /api/flows/draft   { sentence } → { draft: FlowDraft }   (`draft.fallback` when the model couldn't help)
 *
 * Nothing is saved: the editor shows the draft, and saving is POST /api/flows
 * (netlify/lib/flow-routes.ts). Behind the same bearer token as the rest of
 * the API. The other /api/flows routes are the engine's.
 */
import type { FlowDraft } from "../../lib/flow-types";
import { draftFlow, MAX_SENTENCE, type DraftDeps } from "../../lib/flow-draft";

type Json = (data: unknown, status?: number) => Response;

/** What the route needs beyond the request: swapped in tests. */
export interface FlowDraftRouteDeps {
  draft?: (sentence: string, deps: DraftDeps) => Promise<FlowDraft>;
  /** "Let Ask read transactions" (lib/money.ts loadAskMoney). */
  money?: () => Promise<boolean>;
}

/** POST /api/flows/draft, or null when the path is another /api/flows route. `segments` start at "flows". */
export async function handleFlowDraftRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json, deps: FlowDraftRouteDeps = {}): Promise<Response | null> {
  if (segments[0] !== "flows" || segments[1] !== "draft" || segments.length !== 2) return null;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = ((await body()) ?? {}).sentence;
  const sentence = typeof raw === "string" ? raw.trim() : "";
  if (!sentence) return json({ error: "sentence: what should happen, and when?" }, 400);
  if (sentence.length > MAX_SENTENCE) return json({ error: `sentence: keep it under ${MAX_SENTENCE.toLocaleString("en-GB")} characters` }, 400);
  const money = await (deps.money ?? (async () => (await import("../../lib/money")).loadAskMoney()))();
  const draft = await (deps.draft ?? draftFlow)(sentence, { money, origin: "draft" });
  return json({ draft } satisfies { draft: FlowDraft });
}
