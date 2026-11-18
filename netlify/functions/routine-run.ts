/**
 * Background function: one run of one of Ask's routines (lib/routine-run.ts).
 *
 * Started by reminders.ts, which has already claimed the routine's slot, so a
 * slot runs once; never by a person. Background functions answer 202 at once
 * and may run for up to 15 minutes, which fits the answer, a proposal and any
 * wait for AI Gateway's per-minute limit. The run is kept as an Ask
 * conversation, and its nudge goes out now or when quiet hours end.
 *
 * Reached at /.netlify/functions/routine-run (outside /api/*), with the same
 * bearer token as /api/*.
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { reminderTimeZone } from "../../lib/db";
import { getRoutine } from "../../lib/routines";
import { deliverRoutines, runRoutine } from "../../lib/routine-run";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../lib/push";
import { routineDeps } from "../lib/routine-deps";
import { withSpendScope } from "../../lib/spend";

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena routine-run: rejected an unauthenticated or non-POST call");
    return;
  }
  let body: { routine_id?: unknown; slot?: unknown };
  try {
    body = await req.json();
  } catch {
    return;
  }
  const routine = await getRoutine(body.routine_id);
  const slot = typeof body.slot === "string" ? new Date(body.slot) : null;
  // Paused, deleted or edited since the claim: the claim stands, the run doesn't happen.
  if (!routine || routine.paused || !slot || Number.isNaN(slot.getTime()) || routine.last_slot !== slot.toISOString()) return;
  const now = new Date();
  const tz = await reminderTimeZone();
  try {
    const ran = await runRoutine(routine, slot, routineDeps, { now, tz });
    const [canPush, prefs] = await Promise.all([pushConfigured(), loadNotificationPrefs()]);
    const delivered = await deliverRoutines(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet });
    console.log("Athena routine-run:", JSON.stringify({ routine: routine.id, thread: ran.thread_id, plan: ran.plan, ...delivered }));
  } catch (error) {
    console.error("Athena routine-run failed:", error instanceof Error ? error.message : error);
  }
};

// AI spend: every model call in this function counts as background work for "routine" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "routine" }, () => unscoped(...args));

export const config: Config = { background: true };
