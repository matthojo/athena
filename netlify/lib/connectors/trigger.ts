/**
 * Hand queued runs to the background function (netlify/functions/collect-run.ts),
 * which has up to 15 minutes; the scheduler and the API only have seconds.
 * The call carries the same bearer token as the rest of /api/*.
 */
import { finishRun } from "../../../lib/connectors";
import { HAND_OFF_MS, handedOff } from "./hand-off";

export const RUN_PATH = "/api/collect-run";

export async function triggerRuns(origin: string, runIds: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (runIds.length === 0) return;
  const token = Netlify.env.get("MCP_BEARER_TOKEN");
  try {
    if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
    const res = await fetchImpl(new URL(RUN_PATH, origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_ids: runIds }),
      signal: AbortSignal.timeout(HAND_OFF_MS),
      // Followed, a redirect to the login page would answer 200 and read as handed off.
      redirect: "manual",
    });
    if (!handedOff(res.status)) throw new Error(`background function answered ${res.status}`);
  } catch (error) {
    const message = `Couldn't start the run: ${error instanceof Error ? error.message : String(error)}`;
    await Promise.all(runIds.map((id) => finishRun(id, { status: "failed", error: message })));
    throw new Error(message);
  }
}
