/**
 * Background function: writes today's morning briefing with the model
 * (lib/briefing-writer.ts) and delivers it (lib/briefing-run.ts).
 *
 * Started by the 07:30 run in reminders.ts, which has claimed the day; never
 * by a person. Background functions answer 202 at once and may run for up
 * to 15 minutes, so the model call and any gateway rate-limit wait fit here
 * but not in the scheduled function. If anything fails, the data briefing
 * goes out instead; if this function dies, reminders.ts sends the data
 * briefing after WATCHDOG_MINUTES. Either way `briefing-sent:<day>` makes
 * sure only one goes out.
 *
 * Reached at /.netlify/functions/briefing-write (outside /api/*), with the
 * same bearer token as /api/*.
 */
import type { Config } from "@netlify/functions";
import { checkBearer } from "../lib/mcp/bearer";
import { listEvents, notDeclined, reminderTimeZone } from "../../lib/db";
import { zonedToday } from "../../lib/dates";
import { buildBriefing } from "../../lib/briefing";
import { writeBriefing } from "../../lib/briefing-writer";
import { dbDeliverDeps, deliverBriefing, loadBriefingInput, loadWriterInput, briefingState } from "../../lib/briefing-run";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../lib/push";
import { withSpendScope } from "../../lib/spend";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const unscoped = async (req: Request) => {
  if (req.method !== "POST" || !checkBearer(req)) {
    console.error("Athena briefing-write: rejected an unauthenticated or non-POST call");
    return;
  }
  let day = "";
  try {
    const body = (await req.json()) as { date?: unknown };
    day = typeof body.date === "string" && DAY_RE.test(body.date) ? body.date : "";
  } catch {
    return;
  }
  const now = new Date();
  const tz = await reminderTimeZone();
  // A late or repeated call for a day that's over, or already sent: nothing to do.
  if (!day || day !== zonedToday(now, tz) || (await briefingState(day)).sent) return;

  const [canPush, prefs] = await Promise.all([pushConfigured(), loadNotificationPrefs()]);
  const deps = dbDeliverDeps((m) => sendToAll(m));
  const events = (await listEvents()).filter(notDeclined);
  const data = await loadBriefingInput(now, tz, events);
  let written;
  try {
    written = await writeBriefing(await loadWriterInput(data, events));
  } catch (error) {
    written = { briefing: buildBriefing(data), by: "data" as const, reason: error instanceof Error ? error.message : String(error) };
  }
  const id = await deliverBriefing(written.briefing, { push: canPush && prefs.briefing }, deps);
  console.log("Athena briefing-write:", JSON.stringify({ day, note: id, by: written.by, ...(written.reason ? { reason: written.reason } : {}) }));
};

// AI spend: every model call in this function counts as background work for "briefing" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "briefing" }, () => unscoped(...args));

export const config: Config = { background: true };
