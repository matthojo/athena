/**
 * Background function: loads connected accounts' history (netlify/lib/connectors/backfill.ts).
 *
 * Started when an account is connected, by "Load history again", and by the
 * scheduled tick (backfill-history.ts) for a load that stopped or was
 * waiting. Background functions answer 202 at once and may run for up to 15
 * minutes; each account gets 12 and saves its place after every page, so
 * the tick carries on with whatever is left. No model is called.
 *
 * Same bearer token as /api/* (api.ts excludes this path from its own route).
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { runBackfill } from "../lib/connectors/backfill";
import { withSpendScope } from "../../lib/spend";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUDGET_MS = 12 * 60_000;

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena backfill-run: rejected an unauthenticated or non-POST call");
    return;
  }
  let ids: string[] = [];
  try {
    const body = (await req.json()) as { connector_ids?: unknown };
    ids = Array.isArray(body.connector_ids) ? body.connector_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).slice(0, 10) : [];
  } catch {
    return;
  }
  console.log(`Athena backfill-run: ${ids.length} account(s)`);
  const started = Date.now();
  for (const id of ids) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 30_000) break;
    try {
      const p = await runBackfill(id, { budgetMs: left });
      if (p) console.log(`Athena backfill (${p.state === "running" || p.state === "waiting" ? "paused" : "stopped"}): ${p.state}, ${p.items} items read, ${p.added} added${p.error ? `, ${p.error}` : ""}`);
    } catch (error) {
      console.error("Athena backfill failed:", error instanceof Error ? error.message : "unknown error");
    }
  }
};

// A literal: Netlify reads this config without running the file, so an imported constant registers no route (the function was only at /.netlify/functions/backfill-run, and /api/backfill-run answered 404).
// AI spend: every model call in this function counts as background work for "backfill" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "backfill" }, () => unscoped(...args));

export const config: Config = { background: true, path: "/api/backfill-run" };
