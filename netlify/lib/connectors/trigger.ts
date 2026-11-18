/**
 * Hand queued runs to the background function (netlify/functions/collect-run.ts),
 * which has up to 15 minutes; the scheduler and the API only have seconds.
 * The call carries the same bearer token as the rest of /api/*.
 */
import { finishRun } from "../../../lib/connectors";

export const RUN_PATH = "/api/collect-run";

export async function triggerRuns(origin: string, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  const token = Netlify.env.get("MCP_BEARER_TOKEN");
  try {
    if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
    const res = await fetch(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_ids: runIds }),
    });
    if (!res.ok) throw new Error(`background function answered ${res.status}`);
  } catch (error) {
    const message = `Couldn't start the run: ${error instanceof Error ? error.message : String(error)}`;
    await Promise.all(runIds.map((id) => finishRun(id, { status: "failed", error: message })));
    throw new Error(message);
  }
}
