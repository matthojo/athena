/**
 * Nudges Athena starts (lib/proactive/), for the app:
 *
 *   GET  /api/nudges                 → { nudges }: Home's cards (live, not dismissed)
 *   GET  /api/nudges/prefs           → { prefs, mutes, planners }: Settings → Notifications (planners: is a TfL or Google Maps key set, yes or no)
 *   PUT  /api/nudges/prefs           { rules?, cap?, reply_days? } → prefs
 *   POST /api/nudges/mute            { rule } → { rule, muted_until }   ("Fewer like this")
 *   POST /api/nudges/unmute          { rule } → { ok }
 *   GET  /api/nudges/<id>            → the nudge, for Ask (marks it opened)
 *   POST /api/nudges/<id>/dismiss    → { ok }
 *   POST /api/nudges/<id>/applied    { index, on?, undo? } → { applied }: a Weekly plan part or a move, done or put back;
 *                                    kept in What Ask did (lib/ask-activity.ts), with a move's Undo op
 *
 * Behind the same bearer token as the rest of the API. Applying a part goes
 * through the existing routes (to-dos, /api/scheduling/move); these only
 * remember which parts were applied.
 */
import { dismissNudge, listLiveNudges, loadMutes, loadProactivePrefs, markApplied, muteRule, nudgeById, openNudge, saveProactivePrefs, unmuteRule } from "../../../lib/proactive/store";
import { logChanges, markNudgePartUndone, nudgeActionChange } from "../../../lib/ask-activity";
import { travelKey } from "../travel-key";

type Json = (data: unknown, status?: number) => Response;

export async function handleNudgeRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json): Promise<Response | null> {
  const [, first, second, third] = segments;
  if (first !== "nudges" || segments.length > 4) return null;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);
  if (!second) return method === "GET" ? json({ nudges: await listLiveNudges() }) : nope();
  if (second === "prefs" && !third) {
    if (method === "GET") {
      const [prefs, mutes, tfl, google] = await Promise.all([loadProactivePrefs(), loadMutes(), travelKey("tfl"), travelKey("google-routes")]);
      // Whether Leave by has a journey planner: yes or no only, never a key.
      return json({ prefs, mutes: Object.fromEntries(mutes), planners: { tfl: !!tfl, google: !!google } });
    }
    if (method === "PUT") return json(await saveProactivePrefs(await body()));
    return nope();
  }
  if ((second === "mute" || second === "unmute") && !third) {
    if (method !== "POST") return nope();
    const rule = (await body())?.rule;
    if (second === "mute") return json(await muteRule(rule));
    await unmuteRule(rule);
    return json({ ok: true });
  }
  if (!third) {
    if (method !== "GET") return nope();
    const n = await openNudge(second);
    return n ? json(n) : json({ error: "Not found" }, 404);
  }
  if (third === "dismiss") {
    if (method !== "POST") return nope();
    return (await dismissNudge(second)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
  }
  if (third === "applied") {
    if (method !== "POST") return nope();
    const b = (await body()) ?? {};
    const on = b.on !== false;
    const applied = await markApplied(second, b.index, on);
    // What Ask did keeps the part too, with its Undo (lib/ask-activity.ts).
    const n = await nudgeById(second);
    const action = n?.actions[b.index as number];
    if (n && action) {
      try {
        if (on) await logChanges([nudgeActionChange(action, b.undo)], { source: "nudge", nudge_id: n.id });
        else await markNudgePartUndone(n.id, action.kind === "move" ? action.event_id : action.commitment_id);
      } catch (error) {
        console.error("Athena nudges: couldn't keep the part in What Ask did", (error as Error).message?.slice(0, 120));
      }
    }
    return json({ applied });
  }
  return null;
}
