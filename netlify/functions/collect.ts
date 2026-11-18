/**
 * Collections scheduler: a Netlify Scheduled Function every 15 minutes (UTC
 * cron; each collection's own "daily at 07:15" is in the owner's time zone, worked
 * out in lib/connectors.ts, so BST/GMT need no cron changes).
 *
 * Each tick it fails runs a crashed invocation left behind, claims the
 * collections that are due (moving their next run on first, so overlapping
 * ticks can't double-claim), and hands the queued runs to the background
 * function. Scheduled functions only get 30 seconds, so no collecting
 * happens here.
 *
 * After that, the appliances in a Home collection are looked at (netlify/
 * lib/home/appliance-sync.ts: a few quick reads, no model; every 15 minutes
 * so a programme's end is known to the quarter hour, though Home itself runs
 * hourly), and a few Days entries without art get it (lib/day-art-backfill.ts).
 *
 * Note: Netlify runs scheduled functions on published (production) deploys
 * only. On a deploy preview, use "Run now" in the app instead.
 */
import type { Config, Context } from "@netlify/functions";
import { claimDueCollections, failStaleRuns } from "../../lib/connectors";
import { NO_MODEL_RECIPES } from "../../lib/connector-presets";
import { aiConfigured } from "../lib/connectors/runner";
import { triggerRuns } from "../lib/connectors/trigger";
import { backfillDayArt } from "../../lib/day-art-backfill";
import { syncAppliances } from "../lib/home/appliance-sync";
import { withSpendScope } from "../../lib/spend";

const unscoped = async (_req: Request, context: Context) => {
  try {
    const stale = await failStaleRuns();
    // Without AI Gateway (or a key), only the collections that need no Claude run (Your activity, Your work, counted, Home); the rest stay due.
    const ai = aiConfigured();
    if (!ai && stale) console.log(`Athena collect: marked ${stale} stale run(s) failed`);
    const runs = await claimDueCollections(new Date(), ai ? {} : { recipes: NO_MODEL_RECIPES });
    if (runs.length === 0) return;
    const origin = context.site?.url || Netlify.env.get("URL");
    if (!origin) throw new Error("No site URL to reach the background function");
    await triggerRuns(origin, runs.map((r) => r.id));
    console.log(`Athena collect: started ${runs.length} run(s)`);
  } catch (error) {
    console.error("Athena collect failed:", error instanceof Error ? error.message : error);
  } finally {
    // The appliances Home reads are looked at each tick, without a model (netlify/lib/home/appliance-sync.ts); it never throws.
    await syncAppliances({ budgetMs: 10_000 });
    // A few Days entries get their art each tick (lib/day-art-backfill.ts); it never throws.
    await backfillDayArt();
  }
};

// AI spend: every model call in this function counts as background work for "collect" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "collect" }, () => unscoped(...args));

export const config: Config = { schedule: "*/15 * * * *" };
