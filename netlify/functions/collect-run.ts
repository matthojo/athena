/**
 * Background function: executes queued collection runs (netlify/lib/connectors/runner.ts).
 *
 * Invoked by the scheduler (collect.ts) and by "Run now" in the app, never by
 * a person directly. Background functions answer 202 at once and may run for
 * up to 15 minutes; runs go one after another so two collections sharing an
 * account never refresh its OAuth token at the same moment.
 *
 * Same bearer token as /api/* (api.ts excludes this path from its own route).
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { executeRun } from "../lib/connectors/runner";
import { withSpendScope } from "../../lib/spend";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena collect-run: rejected an unauthenticated or non-POST call");
    return;
  }
  let ids: string[] = [];
  try {
    const body = (await req.json()) as { run_ids?: unknown };
    ids = Array.isArray(body.run_ids) ? body.run_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).slice(0, 20) : [];
  } catch {
    return;
  }
  for (const id of ids) await executeRun(id);
};

// AI spend: every model call in this function counts as background work for "collect" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "collect" }, () => unscoped(...args));

export const config: Config = { background: true, path: "/api/collect-run" };
