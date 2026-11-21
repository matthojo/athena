/** Each proactive rule's name, icon and what it does: Home's cards and Settings → Notifications. */
import type { IconName } from "../components/icons";
import type { RuleId } from "../../../lib/proactive/types";

/**
 * Flows' rule. The engine (lib/flows*.ts) adds "flow" to RuleId and RULE_IDS;
 * until it does, the app names it by this string, so the typing holds both
 * before and after that lands.
 */
export const FLOW_RULE = "flow" as const;
export type AppRuleId = RuleId | typeof FLOW_RULE;

/** The rules in Settings → Notifications' order: Flows sits beside Team, whether or not RULE_IDS lists it yet. */
export function settingsRuleIds(ids: readonly RuleId[]): AppRuleId[] {
  const out: AppRuleId[] = ids.filter((id) => (id as string) !== FLOW_RULE);
  const team = out.indexOf("team");
  out.splice(team < 0 ? out.length : team + 1, 0, FLOW_RULE);
  return out;
}

/** Each rule's name and icon, here and in Settings → Notifications. */
export const RULES: Record<Exclude<RuleId, typeof FLOW_RULE> | typeof FLOW_RULE, { name: string; icon: IconName; meta: string }> = {
  meeting_prep: { name: "Meeting prep", icon: "people", meta: "15 minutes before a meeting with people: what you agreed last time, recent email and open to-dos. It takes the place of the 30-minute alert." },
  after_meeting: { name: "After a meeting", icon: "chat", meta: "Asks how it went. Your answer becomes to-dos, a note or a draft you check before anything is sent." },
  awaiting_reply: { name: "Awaiting reply", icon: "mail", meta: "When an email you sent with a question has had no answer for a few working days." },
  leave_by: { name: "Leave by", icon: "pin", meta: "When to set off for your next event at a place: TfL or Google Maps journey times once you add one in Sources, otherwise an estimate from the distance. A drive is only timed with Google Maps." },
  day_plan: { name: "Lighter day after a short night", icon: "bed", meta: "In the morning, a plan that moves heavy work later, with a one-tap move and Undo." },
  weekly_plan: { name: "Plan for the week", icon: "week", meta: "Sunday evening: next week's to-dos placed on your lighter days. Apply the parts you want." },
  drift: { name: "Drift", icon: "loop", meta: "When a habit slips on the same day three weeks running." },
  routine: { name: "Your routines", icon: "refresh", meta: "Each time one of your Ask routines runs. Set them up in Settings → Ask." },
  team: { name: "Your team", icon: "people", meta: "When one of your Team assistants runs: what it did, and anything waiting for you to tap Go." },
  flow: { name: "Flows", icon: "loop", meta: "When one of your flows tells you something, waits for your Go or an answer, or doesn't finish. A flow you've handed to an assistant follows Your team." },
  car: { name: "MOT and car tax", icon: "car", meta: "About 30 days and again 7 days before your car's MOT or tax runs out. Quiet once it's renewed." },
  watch_tonight: { name: "Something to watch tonight", icon: "tv", meta: "On an evening your calendar leaves clear after 19:00: up to three picks from your own watchlist, and why each fits your taste." },
};
