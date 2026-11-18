/**
 * Check-ins in the nudges and the briefing: the pure rules behind the
 * morning push, the evening reflection push and the briefing's lines from
 * the morning check-in (lib/checkin-types.ts is the contract).
 *
 * Reading a check-in is the server's job (lib/checkins.ts loadCheckin). It's
 * passed in as a LoadCheckin, so these rules and their callers can be tested
 * with fakes. Whether a routine is on comes from the `settings` row
 * "checkins" (readCheckinSettings, DEFAULT_CHECKIN_SETTINGS when missing).
 */
import { DEFAULT_CHECKIN_SETTINGS, type Checkin, type CheckinKind, type CheckinSettings, type RoutineSettings } from "./checkin-types";
import { eveningLine, inQuietHours, type DayForPrompt, type NotificationPrefs, type SeenToday } from "./nudges";
import { zonedParts } from "./dates";

/** The server's read (lib/checkins.ts): null when the routine is off or nothing is planned that day. */
export type LoadCheckin = (date: string, kind: CheckinKind) => Promise<Checkin | null>;

/** Until lib/checkins.ts is wired in: no check-in, so every rule behaves as it did before check-ins. */
export const noCheckin: LoadCheckin = async () => null;

export const CHECKINS_KEY = "checkins";

/** The morning push is sent from morning_at for this long; after that the day has started without it. */

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function readRoutine(raw: unknown, fallback: RoutineSettings): RoutineSettings {
  const r = raw && typeof raw === "object" ? (raw as Partial<RoutineSettings>) : null;
  return r && typeof r.enabled === "boolean" ? { ...fallback, ...r, enabled: r.enabled } : fallback;
}

/** The stored "checkins" row, with anything missing or malformed taken from the defaults (both routines off). */
export function readCheckinSettings(raw: unknown): CheckinSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    morning: readRoutine(r.morning, DEFAULT_CHECKIN_SETTINGS.morning),
    evening: readRoutine(r.evening, DEFAULT_CHECKIN_SETTINGS.evening),
    own: Array.isArray(r.own) ? (r.own as CheckinSettings["own"]) : DEFAULT_CHECKIN_SETTINGS.own,
  };
}

/** The "checkins" settings row. Fails soft: on any error both routines read as off. */
export async function loadCheckinSettings(read?: () => Promise<unknown>): Promise<CheckinSettings> {
  try {
    const raw = read
      ? await read()
      : await import("./db").then(async ({ qRaw }) => (await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [CHECKINS_KEY]))[0]?.value);
    return readCheckinSettings(raw);
  } catch {
    return readCheckinSettings(null);
  }
}

export const checkinDone = (c: Checkin | null): boolean => c?.status === "done";

// ---------- the morning push ----------

/**
 * Send the morning check-in push now? The switch is on, the morning routine is
 * on, today's morning check-in isn't done, it's not quiet hours, and it's
 * morning_at or later that day (so quiet hours that end after morning_at only
 * delay it; owner, 17 Nov 2026). Once a day is the caller's claim key.
 */
export function morningPushDue(o: {
  now: Date;
  tz: string;
  prefs: Pick<NotificationPrefs, "morning" | "morning_at" | "quiet">;
  settings: CheckinSettings;
  checkin: Checkin | null;
}): boolean {
  if (!o.prefs.morning || !o.settings.morning.enabled || checkinDone(o.checkin)) return false;
  if (inQuietHours(o.now, o.tz, o.prefs.quiet)) return false;
  const { hour, minute } = zonedParts(o.now, o.tz);
  const since = hour * 60 + minute - minutesOf(o.prefs.morning_at);
  return since >= 0;
}

export const morningKey = (today: string) => `morning:${today}`;

export function morningPush(today: string): { title: string; body: string; url: string; tag: string } {
  return { title: "Morning check-in", body: "How are you starting the day?", url: "/#/checkin/morning", tag: `morning-${today}` };
}

// ---------- the evening push ----------

/**
 * Which evening push, if any:
 *  - routine off: today's prompt, unless the day is kept ("kept"), exactly as before check-ins
 *  - routine on: the reflection, unless today's evening check-in is done ("done").
 *    A mood or line added earlier doesn't skip it: the reflection asks more than that.
 */
export function eveningPlan(routineOn: boolean, checkin: Checkin | null, kept: boolean): "prompt" | "reflection" | "kept" | "done" {
  if (!routineOn) return kept ? "kept" : "prompt";
  return checkinDone(checkin) ? "done" : "reflection";
}

/** The evening push when the routine is on: led by the day's best thing, as the prompt is, and opens the reflection. */
export function reflectionPrompt(today: string, day: DayForPrompt | null, seen: SeenToday[] = []): { title: string; body: string; url: string; tag: string } {
  // As eveningPrompt: no places line in a push, only the people's own public places.
  const line = eveningLine(day ? { ...day, places_line: null } : null, seen);
  return {
    title: "Evening reflection",
    body: line ? `${line}. How was it?` : "A few questions to close the day.",
    url: "/#/checkin/evening",
    tag: `evening-${today}`,
  };
}

// ---------- the briefing ----------

const MAX_LINE = 300;

/**
 * What the morning check-in adds to the briefing: its answers to questions
 * that go to the briefing (mirror "briefing"), one line each.
 * "Focus: Work, Family"; "You said a good day would be: a long walk".
 * Skipped and empty answers add nothing.
 */
export function morningBriefingLines(c: Checkin | null): string[] {
  if (!c || c.kind !== "morning") return [];
  const out: string[] = [];
  for (const q of c.plan) {
    if (q.mirror !== "briefing") continue;
    const v = c.answers[q.id]?.value;
    if (!v) continue;
    let said: string | null = null;
    if ("picks" in v) said = v.picks.map((p) => p.trim()).filter(Boolean).join(", ") || null;
    else if ("text" in v) said = v.text.replace(/\s+/g, " ").trim() || null;
    if (!said) continue;
    if (said.length > MAX_LINE) said = `${said.slice(0, MAX_LINE - 1)}…`;
    if (q.id === "focus") out.push(`Focus: ${said}`);
    else if (q.id === "intention") out.push(`You said a good day would be: ${said}`);
    else out.push(`${q.prompt.replace(/\?$/, "")}: ${said}`);
  }
  return out;
}
