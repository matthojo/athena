/**
 * AI spend's routes (lib/spend.ts, docs/ai-models.md). Full access only, like everything behind the API's gate.
 *
 *  - GET /api/spend: today's spend and its split, the last 7 days, the budget and each assistant's cap, in the
 *    owner's own currency (lib/spend-types.ts SpendView).
 *  - PATCH /api/spend/budget { daily?, assistants? }: set or clear the daily budget and assistants' caps, in the
 *    owner's currency. Answers the new SpendView.
 *  - POST /api/spend/allow-more { assistant_id? }: today only, one step more ("Allow £1 more today"), for all of
 *    Athena or for one assistant's cap. Answers the new SpendView.
 */
import { allowMore, setBudget, spendView, SpendInputError } from "../../lib/spend";

type Json = (data: unknown, status?: number) => Response;

export async function handleSpendRoutes(req: Request, segments: string[], body: () => Promise<unknown>, json: Json): Promise<Response | null> {
  if (segments[0] !== "spend" || segments.length > 2) return null;
  const action = segments[1];
  try {
    if (!action) {
      if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json(await spendView());
    }
    if (action === "budget") {
      if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405);
      return json(await setBudget(await body()));
    }
    if (action === "allow-more") {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return json(await allowMore((await body()) ?? {}));
    }
    return null;
  } catch (error) {
    if (error instanceof SpendInputError) return json({ error: error.message }, 400);
    throw error;
  }
}
