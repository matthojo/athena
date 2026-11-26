/**
 * The profile learner, weekly (lib/profile-learner.ts): reads the owner's
 * calendar, workouts, sleep, habits, places, Days entries and Watch & read,
 * and files at most five suggestions about them to the Review inbox.
 *
 * This scheduled function only starts the background one
 * (profile-learner-run.ts), as collect.ts does for collect-run.ts. The
 * weekly genre call can wait out AI Gateway's per-minute limit (65 s a
 * time), longer than the 30 seconds a scheduled function gets.
 *
 * Safe to rerun: the weekly cap counts what was already filed, and a key with
 * a suggestion waiting is skipped. Netlify runs scheduled functions on
 * published deploys only.
 */
import type { Config, Context } from "@netlify/functions";
import { withSpendScope } from "../../lib/spend";

const RUN_PATH = "/.netlify/functions/profile-learner-run";

const unscoped = async (_req: Request, context: Context) => {
  try {
    const origin = context.site?.url || Netlify.env.get("URL");
    const token = Netlify.env.get("MCP_BEARER_TOKEN");
    if (!origin) throw new Error("No site URL to reach the background function");
    if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
    // Not followed: a redirect is never the background function. It answers 202 once deployed; `netlify dev` answers 204.
    const res = await fetch(new URL(RUN_PATH, origin), { method: "POST", headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
    if (res.status !== 202 && res.status !== 204) throw new Error(`background function answered ${res.status}`);
  } catch (error) {
    console.error("Athena profile learner couldn't start:", error instanceof Error ? error.message : error);
  }
};

// Mondays at 05:00 UTC, so the week's suggestions are in the Review inbox before the morning briefing counts them.
// AI spend: every model call in this function counts as background work for "profile_learner" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "profile_learner" }, () => unscoped(...args));

export const config: Config = { schedule: "0 5 * * 1" };
