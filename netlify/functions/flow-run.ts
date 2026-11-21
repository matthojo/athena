/**
 * Background function: one run of a flow, until it ends or waits (lib/flow-run.ts).
 *
 * Started by a trigger (lib/flow-triggers.ts, through createFlowStarter), Run now (POST /api/flows/:id/run), the
 * owner's answer, Go or Skip, or the reminders job carrying a Wait on; each queued the run first, and it's
 * claimed here (queued → running), so it happens once. Background functions answer 202 at once and may run for
 * up to 15 minutes. The cards the run keeps go out now, or when quiet hours end.
 *
 * Reached at /api/flow-run with the same bearer token as /api/*: under /api/ because the login gate
 * (netlify/edge-functions/site-auth.ts) redirects every other path to /login, as for /api/team-run.
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { reminderTimeZone } from "../../lib/db";
import { runFlowRun } from "../../lib/flow-run";
import { deliverFlowNotices, flowEffects } from "../../lib/flow-effects";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../lib/push";
import { withSpendScope } from "../../lib/spend";
import "../lib/assignment-wiring";

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena flow-run: rejected an unauthenticated or non-POST call");
    return;
  }
  let body: { run_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return;
  }
  if (typeof body.run_id !== "string") return;
  try {
    const run = await runFlowRun(body.run_id, { fx: await flowEffects() });
    if (!run) return;
    const [tz, canPush, prefs] = await Promise.all([reminderTimeZone(), pushConfigured(), loadNotificationPrefs()]);
    const delivered = await deliverFlowNotices(new Date(), tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet });
    console.log("Athena flow-run:", JSON.stringify({ run: run.id, flow: run.flow_id, status: run.status, ...delivered }));
  } catch (error) {
    console.error("Athena flow-run failed:", error instanceof Error ? error.message : error);
  }
};

// AI spend: a Think step counts toward its assistant's own cap (lib/flow-effects.ts); anything else here, such as an
// assignment's lineup, counts as background work for "flows" (lib/spend.ts).
export default (req: Request) => withSpendScope({ area: "background", job: "flows" }, () => unscoped(req));

export const config: Config = { background: true, path: "/api/flow-run" };
