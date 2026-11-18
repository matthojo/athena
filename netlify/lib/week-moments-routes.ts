/**
 * Each week's kept moment over REST (lib/week-moments.ts), mounted by
 * netlify/functions/api.ts behind the same bearer token:
 *
 *   GET    /api/week-moments           { moments: { [monday]: { kind, ref, date, art? } } }
 *   PUT    /api/week-moments/:monday   { kind, ref, date, art? } → { monday, moment }
 *   DELETE /api/week-moments/:monday   → { monday, moment: null }
 */
import { AthenaInputError } from "../../lib/db";
import { clearWeekMoment, keepWeekMoment, loadWeekMoments } from "../../lib/week-moments";

type Reply = (data: unknown, status?: number) => Response;

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AthenaInputError("Send a JSON object");
  }
}

/** /api/week-moments*; null for anything else. */
export async function handleWeekMomentRoutes(req: Request, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, monday] = segments;
  if (first !== "week-moments" || segments.length > 3) return null;
  if (segments.length === 2) {
    if (req.method !== "GET") return reply({ error: "Method not allowed" }, 405);
    return reply({ moments: await loadWeekMoments() });
  }
  if (req.method === "PUT") return reply({ monday, moment: await keepWeekMoment(monday, await body(req)) });
  if (req.method === "DELETE") {
    await clearWeekMoment(monday);
    return reply({ monday, moment: null });
  }
  return reply({ error: "Method not allowed" }, 405);
}
