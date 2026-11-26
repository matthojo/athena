/**
 * Settings → Ask, and Ask's evening chip:
 *
 *   *      /api/routines[/<id>]       → 410 Gone, { error, use: "/api/team" }: routines are assistants now.
 *                                        Nothing reads the list any more.
 *   GET    /api/activity?before=&limit= → { entries }: What Ask did, newest first (lib/ask-activity.ts)
 *   POST   /api/activity/<id>/undo    → the entry, undone (or 4xx: couldn't undo, and it's marked so)
 *   GET    /api/watch-tonight         → { free, picks }: tonight's picks from the owner's own list (lib/watch-tonight.ts)
 *
 * Behind the same bearer token as the rest of the API. Plans' Go and Undo
 * all are under /api/assistant (rate-limited with the rest of Ask).
 */
import { AthenaInputError, getOwnerTimeZone } from "../../lib/db";
import { listActivity, undoActivity } from "../../lib/ask-activity";
import { tonightCard } from "../../lib/watch-tonight";

type Json = (data: unknown, status?: number) => Response;

/** What every /api/routines call gets now. */
export const ROUTINES_GONE = { error: "Routines are assistants now. Use /api/team.", use: "/api/team" } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAskRoutes(
  req: Request,
  url: URL,
  segments: string[],
  body: () => Promise<Record<string, unknown> | null>,
  json: Json,
  deps: { undo: (op: unknown) => Promise<void> },
): Promise<Response | null> {
  const [, first, second, third] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);

  // Closed: every method and path answers 410 and points at the Team API.
  if (first === "routines") return json(ROUTINES_GONE, 410);

  if (first === "activity") {
    if (!second && segments.length === 2) {
      if (method !== "GET") return nope();
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json({ entries: await listActivity({ limit: Number.isFinite(limit) ? limit : 50, before: url.searchParams.get("before") }) });
    }
    if (second && third === "undo" && segments.length === 4) {
      if (method !== "POST") return nope();
      if (!UUID.test(second)) return json({ error: "Not found" }, 404);
      try {
        return json(await undoActivity(second, deps.undo));
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError") throw new AthenaInputError("That can't be undone");
        throw error;
      }
    }
    return null;
  }

  if (first === "watch-tonight" && segments.length === 2) {
    if (method !== "GET") return nope();
    return json(await tonightCard(new Date(), await getOwnerTimeZone()));
  }
  return null;
}
