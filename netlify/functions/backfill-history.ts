/**
 * Picks up history loads that stopped part-way (a run timed out, or the
 * service asked Athena to wait): a Netlify Scheduled Function every 15
 * minutes, which hands them to the background function (backfill-run.ts).
 * Scheduled functions only get 30 seconds, so nothing is read here.
 *
 * Netlify only runs scheduled functions on production deploys.
 */
import type { Config, Context } from "@netlify/functions";
import { backfillTrigger, dueBackfills } from "../lib/connectors/backfill";
import { withSpendScope } from "../../lib/spend";

const unscoped = async (_req: Request, context: Context) => {
  try {
    const ids = await dueBackfills();
    if (!ids.length) return;
    const origin = context.site?.url || Netlify.env.get("URL");
    if (!origin) throw new Error("No site URL to reach the background function");
    await backfillTrigger.send(origin, ids);
    console.log(`Athena backfill: carried on with ${ids.length} account(s)`);
  } catch (error) {
    console.error("Athena backfill tick failed:", error instanceof Error ? error.message : "unknown error");
  }
};

// AI spend: every model call in this function counts as background work for "history" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "history" }, () => unscoped(...args));

export const config: Config = { schedule: "7,22,37,52 * * * *" };
