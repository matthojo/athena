/**
 * Background function: one weekly run of the profile learner
 * (lib/profile-learner.ts). Started by the scheduler (profile-learner.ts),
 * never by a person. Background functions answer 202 at once and may run for
 * up to 15 minutes, room for the genre call to wait out a rate limit.
 *
 * Same bearer token as /api/*. Served at its default path,
 * /.netlify/functions/profile-learner-run, outside api.ts's /api/* route.
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { learnerLogLine, runProfileLearner } from "../../lib/profile-learner";
import { withSpendScope } from "../../lib/spend";

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena profile-learner-run: rejected an unauthenticated or non-POST call");
    return;
  }
  const started = Date.now();
  try {
    const report = await runProfileLearner();
    console.log("Athena profile learner:", JSON.stringify({ ...learnerLogLine(report), ms: Date.now() - started }));
  } catch (error) {
    console.error("Athena profile learner failed:", error);
  }
};

// AI spend: every model call in this function counts as background work for "profile_learner" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "profile_learner" }, () => unscoped(...args));

export const config: Config = { background: true };
