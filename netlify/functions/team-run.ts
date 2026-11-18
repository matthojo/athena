/**
 * Background function: one run of a Team assistant (lib/team-run.ts).
 *
 * Started by reminders.ts (a trigger fired) or POST /api/team/:id/run (Run
 * now), each of which queued the run first; the run is claimed here
 * (queued → running), so it happens once. Background functions answer 202 at
 * once and may run for up to 15 minutes. The run is kept as an Ask
 * conversation that belongs to the assistant, and its "From <Name>" nudge
 * goes out now or when quiet hours end.
 *
 * Reached at /api/team-run, with the same bearer token as /api/*. It has to be
 * under /api/: the login gate (netlify/edge-functions/site-auth.ts) redirects
 * every other path to /login, so the default /.netlify/functions/team-run
 * never reached this function.
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { reminderTimeZone } from "../../lib/db";
import { deliverTeamNudges, runTeamRun } from "../../lib/team-run";
import { deliverStopPushes } from "../../lib/assignment-push";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../lib/push";
import { teamRunDeps } from "../lib/team-deps";
import "../lib/assignment-wiring";

export default async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena team-run: rejected an unauthenticated or non-POST call");
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
    const run = await runTeamRun(body.run_id, teamRunDeps);
    if (!run) return;
    const now = new Date();
    const [tz, canPush, prefs] = await Promise.all([reminderTimeZone(), pushConfigured(), loadNotificationPrefs()]);
    const delivered = await deliverTeamNudges(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet });
    // A stage's run may have stopped its assignment for the owner, or finished it.
    const stops = await deliverStopPushes(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet }).catch(() => ({ sent: 0, held: 0 }));
    console.log("Athena team-run:", JSON.stringify({ run: run.id, assistant: run.assistant_id, status: run.status, ...delivered, ...(stops.sent || stops.held ? { stops } : {}) }));
  } catch (error) {
    console.error("Athena team-run failed:", error instanceof Error ? error.message : error);
  }
};

export const config: Config = { background: true, path: "/api/team-run" };
