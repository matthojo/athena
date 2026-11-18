/**
 * One pass of Athena speaking first, from the reminders function every 5
 * minutes: load what switched-on rules need, run the rules, gate them, keep
 * each nudge that passes (its key dedupes across overlapping runs) and push
 * it. A push opens Ask on the nudge (/#/ask/nudge/<id>); without push it is
 * still a card on Home.
 */
import type { AthenaEvent } from "../db";
import type { PushPayload } from "../push";
import type { QuietHours } from "../nudges";
import { zonedToday } from "../dates";
import { gate, prepWillSpeak } from "./gate";
import { nudgeUrl } from "./urls";
import { loadProactiveInput, type LoadOptions } from "./load";
import { closedKeys, loadMutes, loadProactivePrefs, madeOn, markPushed, recordNudge, seenKeys } from "./store";
import { allNudges, preppedEventIds } from "./rules";
import type { RuleId, SentThread } from "./types";

export interface ProactiveDeps {
  canPush: boolean;
  send: (p: PushPayload) => Promise<unknown>;
  /** Sent mail, read only when awaiting reply could use it. */
  sent?: () => Promise<SentThread[]>;
  /** A live journey planner for leave by (netlify/lib/proactive/directions.ts). */
  route?: LoadOptions["route"];
  quiet: QuietHours | null;
  events?: AthenaEvent[];
}

export { nudgeUrl };

export async function runProactive(now: Date, tz: string, deps: ProactiveDeps): Promise<{ made: Array<{ rule: RuleId; pushed: boolean }>; held: Record<string, number>; prepped: string[] }> {
  const [prefs, mutes, closed] = await Promise.all([loadProactivePrefs(), loadMutes(), closedKeys()]);
  const live = (r: RuleId) => prefs.rules[r] && !(mutes.get(r) && Date.parse(mutes.get(r)!) > now.getTime());
  const report = { made: [] as Array<{ rule: RuleId; pushed: boolean }>, held: {} as Record<string, number>, prepped: [] as string[] };
  if (!Object.keys(prefs.rules).some((r) => live(r as RuleId))) return report;

  const input = await loadProactiveInput({ now, tz, prefs, live, sent: deps.sent, route: deps.route, closed, events: deps.events });
  const today = zonedToday(now, tz);
  const madeToday = await madeOn(today);
  const candidates = allNudges(input, { replyDays: prefs.reply_days, live });
  const { pass, held } = gate(candidates, {
    now,
    tz,
    prefs,
    working: input.working,
    quiet: deps.quiet,
    mutes,
    madeToday,
    // Every candidate's key is checked in one read.
    seen: await seenKeys([...new Set(candidates.map((n) => n.key))]),
  });
  for (const h of held) report.held[h.reason] = (report.held[h.reason] ?? 0) + 1;
  // Meetings whose 30-minute push meeting prep takes over: only where prep will actually speak
  // (on, not muted, in working hours, room under the cap) or already has.
  const base = { now, tz, prefs, working: input.working, quiet: deps.quiet, mutes, madeToday: madeToday + pass.length };
  const prepped = await seenKeys(input.events.map((e) => `prep:${e.id}:${e.starts_at}`));
  report.prepped = input.events.filter((e) => preppedEventIds({ events: [e] }).size && (prepped.has(`prep:${e.id}:${e.starts_at}`) || prepWillSpeak(e.starts_at, base))).map((e) => e.id);
  for (const n of pass) {
    const kept = await recordNudge(n, today, now);
    if (!kept) continue;
    let pushed = false;
    // The day plan rides in the morning briefing (lib/proactive/briefing.ts): no push of its own.
    if (deps.canPush && n.rule !== "day_plan") {
      try {
        await deps.send({ title: n.title, body: n.body, url: nudgeUrl(kept.id), tag: `nudge:${n.key}` });
        await markPushed(kept.id);
        pushed = true;
      } catch (error) {
        // The card stays on Home either way.
        console.error("Athena proactive: push failed", (error as Error).message?.slice(0, 120));
      }
    }
    report.made.push({ rule: n.rule, pushed });
  }
  return report;
}
