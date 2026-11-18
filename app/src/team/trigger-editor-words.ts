/**
 * Team: triggers and status as plain sentences (docs/team.md, "Vocabulary").
 * Pure, so the Team page, the detail page and setup say the same thing, and
 * the tests can check the words without a DOM.
 *
 *   triggerSentence({ kind: "schedule", days: [1,2,3,4,5], time: "08:00" }) → "Every weekday at 8:00"
 *   triggerSentence({ kind: "event", event: { source: "collected", connector: "linear" } }) → "When a Linear issue is assigned to you"
 */
import type { EventFilter, TeamAssistant, TeamTriggerInput } from "../../../lib/team-types";

/** Monday first, as the pills read; values are 0 = Sunday, as the server keeps them. */
export const WEEK: ReadonlyArray<{ day: number; short: string; long: string; letter: string }> = [
  { day: 1, short: "Mon", long: "Monday", letter: "M" },
  { day: 2, short: "Tue", long: "Tuesday", letter: "T" },
  { day: 3, short: "Wed", long: "Wednesday", letter: "W" },
  { day: 4, short: "Thu", long: "Thursday", letter: "T" },
  { day: 5, short: "Fri", long: "Friday", letter: "F" },
  { day: 6, short: "Sat", long: "Saturday", letter: "S" },
  { day: 0, short: "Sun", long: "Sunday", letter: "S" },
];

/** What a collected item can come from, in the order setup offers them. */
export const CONNECTORS: ReadonlyArray<{ id: string; label: string; kind: string; when: string }> = [
  { id: "linear", label: "Linear", kind: "issue", when: "a Linear issue is assigned to you" },
  { id: "gmail", label: "Gmail", kind: "email", when: "an email arrives" },
  { id: "google-calendar", label: "Calendar", kind: "event", when: "a calendar event is added" },
  { id: "github", label: "GitHub", kind: "pull-request", when: "a GitHub pull request comes in" },
  { id: "slack", label: "Slack", kind: "message", when: "a Slack message arrives" },
];

/** What an email can set off, for a Gmail trigger's "What kind" row. "email" is any of them (lib/team-triggers.ts). */
export const EMAIL_KINDS: ReadonlyArray<{ kind: string; label: string; when: string }> = [
  { kind: "email", label: "Anything", when: "an email arrives" },
  { kind: "delivery", label: "Deliveries", when: "a delivery update arrives" },
  { kind: "booking", label: "Bookings", when: "a booking is made, changed or cancelled" },
  { kind: "appointment", label: "Appointments", when: "an email books an appointment" },
  { kind: "deadline", label: "Deadlines", when: "an email sets a deadline" },
  { kind: "renewal", label: "Renewals", when: "something's due to renew" },
  { kind: "alert", label: "Account alerts", when: "an account alert arrives" },
  { kind: "todo", label: "To-dos", when: "an email asks you to do something" },
];

/** Accounts whose trigger can wait for one kind of email. */
export const MAIL_CONNECTORS = new Set(["gmail", "outlook-mail", "fastmail"]);

export function connectorById(id: string | undefined) {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

/** The days as a list of numbers 0–6, whatever shape they came in. */
export function dayList(days: TeamTriggerInput["days"]): number[] {
  const raw = Array.isArray(days) ? days : typeof days === "string" ? days.split(/[\s,]+/) : [];
  return [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

/** Whether this device writes times on a 12-hour clock, as its time fields do. */
export function prefers12h(): boolean {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}

/** "08:00" → "8:00", or "8:00 am" on a 12-hour device, matching the time field beside it. */
export function clockWords(time: string | null | undefined, hour12 = prefers12h()): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return time ?? "";
  const h = Number(m[1]);
  if (!hour12) return `${h}:${m[2]}`;
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "am" : "pm"}`;
}

const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Every day", "Every weekday", "Every Friday", "Every Mon, Wed and Fri". */
export function daysWords(days: TeamTriggerInput["days"]): string {
  const d = dayList(days);
  if (d.length === 0 || d.length === 7) return "Every day";
  const key = d.join("");
  if (key === "12345") return "Every weekday";
  if (key === "06") return "Every weekend";
  const named = WEEK.filter((w) => d.includes(w.day));
  if (named.length === 1) return `Every ${named[0].long}`;
  return `Every ${listWords(named.map((w) => w.short))}`;
}

/** What an event trigger waits for, as the end of "When …". */
export function eventWords(e: EventFilter | null | undefined): string {
  if (!e) return "something arrives";
  let base: string;
  if (e.source === "collected") {
    const c = connectorById(e.connector);
    const mail = e.connector && MAIL_CONNECTORS.has(e.connector) ? EMAIL_KINDS.find((k) => k.kind === e.kind) : undefined;
    base = mail ? mail.when : c ? c.when : e.connector ? `something arrives from ${e.connector}` : "something new is collected";
  } else if (e.source === "saved") {
    base = e.savedAction === "gift-idea" || e.savedAction === "gift_idea" ? "you save a gift idea" : "you save a link";
  } else {
    base = e.tag ? `you tag a note #${e.tag.replace(/^#/, "")}` : "you write a note";
  }
  return e.match ? `${base} with “${e.match}” in the title` : base;
}

/** A trigger as saved or as being edited. */
export type TriggerLike = Pick<TeamTriggerInput, "kind" | "days"> & { time?: string | null; event?: EventFilter | null };

/** One trigger as a sentence: "Every weekday at 8:00", "When you save a gift idea". */
export function triggerSentence(t: TriggerLike, hour12 = prefers12h()): string {
  if (t.kind === "schedule") return `${daysWords(t.days)} at ${clockWords(t.time ?? "09:00", hour12)}`;
  return `When ${eventWords(t.event)}`;
}

/** Several triggers as one line for a card or a summary. */
export function triggersSummary(ts: TriggerLike[]): string {
  if (!ts.length) return "Only when you ask";
  const first = triggerSentence(ts[0]);
  return ts.length === 1 ? first : `${first}, and ${ts.length - 1} more`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "9:12", "yesterday", "Tue", "3 Nov": when something happened, as briefly as reads clearly. */
export function whenWords(iso: string, now = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (sameDay(t, now)) return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(t, y)) return "yesterday";
  const days = (now.getTime() - t.getTime()) / 86_400_000;
  if (days < 6) return WEEK.find((w) => w.day === t.getDay())!.short;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getMonth()];
  return `${t.getDate()} ${month}`;
}

/** What it's watching, for an event trigger: "Watching Linear", "Watching for gift ideas". */
function watchingWords(e: EventFilter): string {
  if (e.source === "collected") return `Watching ${connectorById(e.connector)?.label ?? e.connector ?? "what's collected"}`;
  if (e.source === "saved") return e.savedAction === "gift-idea" || e.savedAction === "gift_idea" ? "Watching for gift ideas" : "Watching what you save";
  return e.tag ? `Watching #${e.tag.replace(/^#/, "")}` : "Watching your notes";
}

/**
 * The short present-tense line under a name. Paused says so; a run today
 * says when; otherwise what it's watching or when it next runs.
 */
export function statusLine(a: Pick<TeamAssistant, "paused" | "last_run_at" | "triggers">, now = new Date(), hour12 = prefers12h()): string {
  if (a.paused) return "Paused";
  const ranToday = a.last_run_at && sameDay(new Date(a.last_run_at), now);
  // On the device's clock, as the assistant's page and the Team page write it ("Last ran 7:14 pm").
  if (ranToday) return `Last ran ${lastRanWords(a.last_run_at!, now, hour12)}`;
  const live = a.triggers.filter((t) => !t.paused);
  const ev = live.find((t) => t.kind === "event" && t.event);
  if (ev?.event) return watchingWords(ev.event);
  if (a.last_run_at) return `Last ran ${lastRanWords(a.last_run_at, now, hour12)}`;
  const sched = live.find((t) => t.kind === "schedule");
  if (sched) return `Runs ${triggerSentence(sched, hour12).replace(/^Every /, "every ")}`;
  return "Ready when you ask";
}

/**
 * "19:14" today on this device's clock, "yesterday", a weekday within the
 * week ("Mon"), else "3 Nov": the same days as the run list beneath it.
 */
function lastRanWords(iso: string, now: Date, hour12: boolean): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (sameDay(t, now)) return clockWords(`${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`, hour12);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return WEEK.find((w) => w.day === t.getDay())!.short;
  return whenWords(iso, now);
}

/**
 * The fuller line under the name on an assistant's own page, in parts so
 * the page can wrap between them: what it's watching or when it runs, then
 * when it last ran. ["Watching for gift ideas", "last ran 19:14"]. Cards and
 * Ask keep the short `statusLine`.
 */
export function pageStatusParts(a: Pick<TeamAssistant, "paused" | "last_run_at" | "triggers">, now = new Date(), hour12 = prefers12h()): string[] {
  const last = a.last_run_at ? lastRanWords(a.last_run_at, now, hour12) : "";
  if (a.paused) return last ? ["Paused", `last ran ${last}`] : ["Paused"];
  const live = a.triggers.filter((t) => !t.paused);
  const ev = live.find((t) => t.kind === "event" && t.event);
  const sched = live.find((t) => t.kind === "schedule");
  const what = ev?.event ? watchingWords(ev.event) : sched ? `Runs ${triggerSentence(sched, hour12).replace(/^Every /, "every ")}` : "Ready when you ask";
  return last ? [what, `last ran ${last}`] : [what];
}

/** The same as one line: "Watching for gift ideas · last ran 19:14". */
export function pageStatusLine(a: Pick<TeamAssistant, "paused" | "last_run_at" | "triggers">, now = new Date(), hour12 = prefers12h()): string {
  return pageStatusParts(a, now, hour12).join(" · ");
}
