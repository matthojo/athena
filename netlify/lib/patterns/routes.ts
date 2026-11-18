/**
 * Patterns over REST (lib/patterns-data.ts). Full access only (the caller
 * checks); a capture key can't read them. Nothing here logs a figure.
 *
 *  - GET /api/patterns?window=30|90|365&outcome=sleep,deep,mood,steps,resting_hr   → PatternsReply
 *  - GET /api/patterns/digest                                                        → WeeklyDigest
 */
import { DataBoxError } from "../../../lib/data-box";
import { getPatterns, getWeeklyDigest, isOutcome, isWindow, type PatternWindow } from "../../../lib/patterns-data";

type Json = (data: unknown, status?: number) => Response;

/** Handles /api/patterns…; null for anything else. */
export async function handlePatternsRoutes(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  const [, first, second] = segments;
  if (first !== "patterns" || segments.length > 3) return null;
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    if (segments.length === 3) {
      if (second !== "digest") return null;
      return json(await getWeeklyDigest());
    }
    const w = url.searchParams.get("window");
    if (w && !isWindow(w)) return json({ error: "window: 30, 90 or 365" }, 400);
    const raw = url.searchParams.get("outcome");
    const outcomes = raw ? raw.split(",").map((s) => s.trim()) : undefined;
    if (outcomes && !outcomes.every(isOutcome)) return json({ error: "outcome: sleep, deep, mood, steps or resting_hr" }, 400);
    return json(await getPatterns({ window: w ? (Number(w) as PatternWindow) : 90, ...(outcomes ? { outcomes: outcomes.filter(isOutcome) } : {}) }));
  } catch (error) {
    if (error instanceof DataBoxError) return json({ error: error.message }, error.status);
    throw error;
  }
}
