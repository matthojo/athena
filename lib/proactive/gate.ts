/**
 * What every nudge shares, whichever rule made it: the rule's switch, a
 * "Fewer like this" mute, quiet hours, a daily cap and dedupe. Pure: the
 * reminders function hands in what's stored (lib/proactive/store.ts).
 *
 * Quiet hours are the owner's working hours from Settings → Days (lib/availability.ts):
 * work nudges (meeting prep, after a meeting, awaiting reply, drift) only
 * come on a working day between its start and end. The rest (leave by, the
 * morning day plan, the Sunday plan) come at a set moment that can fall
 * outside work, so they only keep out of Settings → Notifications quiet
 * hours, or 22:00 to 07:00 when none are set.
 */
import { zonedParts } from "../dates";
import { inQuietHours, type QuietHours } from "../nudges";
import { RULE_IDS, TRAVEL_MODES, type Nudge, type RuleId, type TravelMode } from "./types";

export interface ProactivePrefs {
  rules: Record<RuleId, boolean>;
  /** Most nudges in a day, across every rule. */
  cap: number;
  /** Working days before a sent email counts as unanswered. */
  reply_days: number;
  /** Leave by: how the owner usually travels, and each event's own choice (by event id, the latest 50). */
  travel_mode: TravelMode;
  travel_by_event: Record<string, TravelMode>;
}

/** Most journeys Athena remembers a way of travelling for: the newest are kept. */
export const MAX_TRAVEL_CHOICES = 50;
const isMode = (v: unknown): v is TravelMode => typeof v === "string" && (TRAVEL_MODES as readonly string[]).includes(v);
const EVENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Meeting prep, awaiting reply, the owner's own routines, Team assistants and flows, and the car (the owner added it) are on; the rest wait for the owner to try them. */
export const DEFAULT_PROACTIVE: ProactivePrefs = {
  rules: { meeting_prep: true, after_meeting: false, awaiting_reply: true, leave_by: false, day_plan: false, weekly_plan: false, drift: false, routine: true, watch_tonight: false, car: true, team: true, flow: true },
  cap: 4,
  reply_days: 3,
  travel_mode: "transit",
  travel_by_event: {},
};
export const PROACTIVE_KEY = "proactive";

export function readProactive(raw: unknown): ProactivePrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rules = { ...DEFAULT_PROACTIVE.rules };
  const given = r.rules && typeof r.rules === "object" ? (r.rules as Record<string, unknown>) : {};
  for (const id of RULE_IDS) if (typeof given[id] === "boolean") rules[id] = given[id] as boolean;
  const int = (v: unknown, lo: number, hi: number, fb: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : fb);
  const byEvent: Record<string, TravelMode> = {};
  if (r.travel_by_event && typeof r.travel_by_event === "object") for (const [k, v] of Object.entries(r.travel_by_event as Record<string, unknown>)) if (EVENT_ID.test(k) && isMode(v)) byEvent[k] = v;
  return {
    rules,
    cap: int(r.cap, 1, 12, DEFAULT_PROACTIVE.cap),
    reply_days: int(r.reply_days, 1, 10, DEFAULT_PROACTIVE.reply_days),
    travel_mode: isMode(r.travel_mode) ? r.travel_mode : DEFAULT_PROACTIVE.travel_mode,
    travel_by_event: byEvent,
  };
}

/** A PUT's changes. Throws a readable message on anything it can't use. */
export function mergeProactive(current: ProactivePrefs, patch: unknown): ProactivePrefs {
  if (!patch || typeof patch !== "object") throw new Error("Send an object of settings");
  const p = patch as Record<string, unknown>;
  const next: ProactivePrefs = { ...current, rules: { ...current.rules }, travel_by_event: { ...current.travel_by_event } };
  if (p.rules !== undefined) {
    if (!p.rules || typeof p.rules !== "object") throw new Error("rules: an object of switches");
    for (const [k, v] of Object.entries(p.rules as Record<string, unknown>)) {
      if (!(RULE_IDS as readonly string[]).includes(k)) throw new Error(`rules: no rule called ${k}`);
      if (typeof v !== "boolean") throw new Error(`rules.${k}: true or false`);
      next.rules[k as RuleId] = v;
    }
  }
  if (p.cap !== undefined) {
    if (!Number.isInteger(p.cap) || (p.cap as number) < 1 || (p.cap as number) > 12) throw new Error("cap: a whole number from 1 to 12");
    next.cap = p.cap as number;
  }
  if (p.reply_days !== undefined) {
    if (!Number.isInteger(p.reply_days) || (p.reply_days as number) < 1 || (p.reply_days as number) > 10) throw new Error("reply_days: a whole number from 1 to 10");
    next.reply_days = p.reply_days as number;
  }
  if (p.travel_mode !== undefined) {
    if (!isMode(p.travel_mode)) throw new Error(`travel_mode: one of ${TRAVEL_MODES.join(", ")}`);
    next.travel_mode = p.travel_mode;
  }
  if (p.travel_by_event !== undefined) {
    if (!p.travel_by_event || typeof p.travel_by_event !== "object") throw new Error("travel_by_event: an object of event ids");
    for (const [k, v] of Object.entries(p.travel_by_event as Record<string, unknown>)) {
      if (!EVENT_ID.test(k)) throw new Error("travel_by_event: event ids only");
      if (v === null) delete next.travel_by_event[k];
      else if (!isMode(v)) throw new Error(`travel_by_event.${k}: one of ${TRAVEL_MODES.join(", ")}, or null for your usual`);
      else {
        delete next.travel_by_event[k];
        next.travel_by_event[k] = v;
      }
    }
    // The newest choices are kept (insertion order).
    const keys = Object.keys(next.travel_by_event);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRAVEL_CHOICES))) delete next.travel_by_event[k];
  }
  return next;
}

/** Rules that only speak in working hours. */
export const WORK_RULES: ReadonlySet<RuleId> = new Set(["meeting_prep", "after_meeting", "awaiting_reply", "drift"]);
const NIGHT: QuietHours = { from: "22:00", to: "07:00" };

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Inside the owner's working hours: a working day (0 = Sunday), from start until end. */
export function inWorkingHours(now: Date, tz: string, working: { days: number[]; start: string; end: string }): boolean {
  const p = zonedParts(now, tz);
  const dow = new Date(`${p.date}T12:00:00Z`).getUTCDay();
  const m = p.hour * 60 + p.minute;
  return working.days.includes(dow) && m >= minutes(working.start) && m < minutes(working.end);
}

/** Whether this rule may speak now. */
export function quietFor(rule: RuleId, now: Date, tz: string, working: { days: number[]; start: string; end: string }, quiet: QuietHours | null): boolean {
  if (inQuietHours(now, tz, quiet)) return true;
  if (WORK_RULES.has(rule)) return !inWorkingHours(now, tz, working);
  return inQuietHours(now, tz, quiet ?? NIGHT);
}

export interface GateState {
  now: Date;
  tz: string;
  prefs: ProactivePrefs;
  working: { days: number[]; start: string; end: string };
  /** Settings → Notifications quiet hours, if set. */
  quiet: QuietHours | null;
  /** Rule → muted until (ISO), from "Fewer like this". */
  mutes: Map<RuleId, string>;
  /** Nudges already made today, any rule. */
  madeToday: number;
  /** Keys already nudged (ever). */
  seen: Set<string>;
}

export type HeldReason = "off" | "muted" | "quiet" | "seen" | "cap" | "expired";

/**
 * The nudges that go out now, in the order given, and why the rest don't.
 * A held nudge isn't kept: if it still applies on a later run it comes back
 * from its rule and is checked again.
 */
export function gate(candidates: Nudge[], s: GateState): { pass: Nudge[]; held: Array<{ nudge: Nudge; reason: HeldReason }> } {
  const pass: Nudge[] = [];
  const held: Array<{ nudge: Nudge; reason: HeldReason }> = [];
  const keys = new Set(s.seen);
  let made = s.madeToday;
  for (const n of candidates) {
    const until = s.mutes.get(n.rule);
    const reason: HeldReason | null = !s.prefs.rules[n.rule]
      ? "off"
      : until && Date.parse(until) > s.now.getTime()
        ? "muted"
        : keys.has(n.key)
          ? "seen"
          : Date.parse(n.expires_at) <= s.now.getTime()
            ? "expired"
            : quietFor(n.rule, s.now, s.tz, s.working, s.quiet)
              ? "quiet"
              : made >= s.prefs.cap
                ? "cap"
                : null;
    if (reason) {
      held.push({ nudge: n, reason });
      continue;
    }
    keys.add(n.key);
    made++;
    pass.push(n);
  }
  return { pass, held };
}

/**
 * Whether meeting prep will speak for a meeting starting at `startsAt`: the rule is on and not
 * muted, prep time falls in working hours, and today's cap still has room. Only then does the
 * bare 30-minute push stand aside; otherwise the meeting keeps it (netlify/functions/reminders.ts).
 */
export function prepWillSpeak(startsAt: string, s: Omit<GateState, "seen">): boolean {
  const until = s.mutes.get("meeting_prep");
  if (!s.prefs.rules.meeting_prep || (until && Date.parse(until) > s.now.getTime())) return false;
  if (s.madeToday >= s.prefs.cap) return false;
  return !quietFor("meeting_prep", new Date(Date.parse(startsAt) - 15 * 60_000), s.tz, s.working, s.quiet);
}
