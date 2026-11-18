/**
 * Your answers to invites: Going, Maybe or Declined on an event, in Athena
 * and, for a calendar account you've let answer invites (canRsvp), sent back
 * to the calendar.
 *
 *  - A collection fills the answer when it syncs (syncRsvp): the calendar's
 *    own reply, with the account, calendar and event id needed to answer.
 *  - Yours wins until the calendar changes: once you choose (answerEvent),
 *    a sync that brings the same calendar answer as before leaves yours
 *    alone; a different one (you answered in Google Calendar itself, or the
 *    organiser reset replies) replaces it.
 *  - Sending goes through CalendarPort, so lib/ stays free of the connector
 *    client; netlify/lib/connectors/calendar-rsvp.ts is the real one, and
 *    tests pass their own. It only ever sends your own reply: never creates,
 *    edits, moves or deletes an event.
 *  - Without the switch, or when the send fails, Athena keeps your answer
 *    and the event says so (`rsvp_error`, `rsvp_account.can_send`).
 *
 * Declined events stay under Events and drop out of Home, This week and
 * reminders (notDeclined in lib/db.ts).
 *
 * iCloud Calendar answers the same way: its respond_to_event changes only
 * your own PARTSTAT, with a conditional PUT (icloud-rsvp.ts).
 */

import { AthenaInputError, getEvent, q, RSVPS, type AthenaEvent, type Rsvp } from "./db";
import { canRsvp } from "./connector-presets";
import { listConnectors } from "./connectors";

export type Answer = Exclude<Rsvp, "none">;
export const ANSWERS: readonly Answer[] = ["going", "maybe", "declined"];

/** What a calendar tool says the owner replied (google-calendar.ts and microsoft-calendar.ts `myResponse`). */
export function fromCalendar(myResponse: unknown): Rsvp {
  switch (typeof myResponse === "string" ? myResponse.toLowerCase() : "") {
    case "accepted":
    case "going":
      return "going";
    case "maybe":
    case "tentative":
    case "tentativelyaccepted":
      return "maybe";
    case "declined":
      return "declined";
    default:
      return "none";
  }
}

export const isRsvp = (v: unknown): v is Rsvp => typeof v === "string" && (RSVPS as readonly string[]).includes(v);

/** Sends one answer to a calendar. Throws with a plain-English message when it can't. */
export interface CalendarPort {
  /** `series`: iCloud, one date of a repeating invite, and you chose "All of them". */
  respond(connectorId: string, invite: { calendarId: string; eventId: string; answer: Rsvp; series?: boolean }): Promise<void>;
}

export interface CalendarInvite {
  connectorId: string;
  calendarId: string;
  eventId: string;
  /** The calendar's answer right now. */
  answer: Rsvp;
}

/**
 * A collection saw this event on a calendar: remember where it lives and take
 * the calendar's answer, unless you chose one and the calendar still says
 * what it said then.
 */
export async function syncRsvp(id: string, invite: CalendarInvite): Promise<void> {
  // Right-hand sides read the row as it was, so "the calendar changed" compares with the last answer seen.
  await q(
    `UPDATE events SET
       calendar_connector_id = $2::uuid, calendar_id = $3, calendar_event_id = $4,
       rsvp = CASE WHEN rsvp_mine AND rsvp_calendar IS NOT DISTINCT FROM $5 THEN rsvp ELSE $5 END,
       rsvp_error = CASE WHEN rsvp_mine AND rsvp_calendar IS NOT DISTINCT FROM $5 THEN rsvp_error ELSE '' END,
       rsvp_mine = rsvp_mine AND rsvp_calendar IS NOT DISTINCT FROM $5,
       rsvp_calendar = $5
     WHERE id = $1`,
    [id, invite.connectorId, invite.calendarId, invite.eventId, invite.answer],
  );
}

/**
 * The calendar's answer without where it lives (an account Athena can't
 * answer through, like one on Google's MCP server): shown and filtered on,
 * never sent. Yours wins, as above.
 */
export async function syncAnswerOnly(id: string, answer: Rsvp): Promise<void> {
  await q(
    `UPDATE events SET
       rsvp = CASE WHEN rsvp_mine AND rsvp_calendar IS NOT DISTINCT FROM $2 THEN rsvp ELSE $2 END,
       rsvp_mine = rsvp_mine AND rsvp_calendar IS NOT DISTINCT FROM $2,
       rsvp_calendar = $2
     WHERE id = $1`,
    [id, answer],
  );
}

/** "Google Calendar", "Outlook" or "iCloud Calendar", for messages. */
export function calendarName(provider: string | undefined): string {
  return provider === "outlook-calendar" ? "Outlook" : provider === "google-calendar" ? "Google Calendar" : provider === "icloud-calendar" ? "iCloud Calendar" : "your calendar";
}

/** Can this answer go back to the event's calendar? Outlook and iCloud have no way to take an answer back to "no reply". */
function sendable(ev: AthenaEvent, answer: Rsvp): boolean {
  if (!ev.calendar_event_id || !ev.rsvp_account?.can_send) return false;
  return answer !== "none" || ev.rsvp_account.provider === "google-calendar";
}

export interface AnswerResult {
  event: AthenaEvent;
  /** Sent to the calendar; already what the calendar says; kept in Athena only (no switch, or not an invite); or kept in Athena because sending failed. */
  outcome: "sent" | "unchanged" | "saved" | "failed";
  /** Plain words for the owner when it wasn't sent. */
  message: string;
  /** What Undo puts back. */
  before: Rsvp;
}

async function send(ev: AthenaEvent, answer: Rsvp, port: CalendarPort, series = false): Promise<string> {
  try {
    await port.respond(ev.calendar_connector_id!, { calendarId: ev.calendar_id || "primary", eventId: ev.calendar_event_id!, answer, ...(series ? { series } : {}) });
    // The calendar now says this too, so the next sync agrees with it.
    await q(`UPDATE events SET rsvp_calendar = $2, rsvp_error = '' WHERE id = $1`, [ev.id, answer]);
    return "";
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : `${calendarName(ev.rsvp_account?.provider)} didn't take it`;
    const message = why.slice(0, 300);
    await q(`UPDATE events SET rsvp_error = $2 WHERE id = $1`, [ev.id, message]);
    return message;
  }
}

/**
 * Your answer to an event. Saved in Athena first, so it holds whatever
 * happens next; then sent to the calendar when its account allows it.
 */
export async function answerEvent(id: string, answer: Rsvp, deps: { calendar: CalendarPort }, opts: { series?: boolean } = {}): Promise<AnswerResult> {
  if (!isRsvp(answer)) throw new AthenaInputError("Answer going, maybe or declined");
  const ev = await getEvent(id);
  if (!ev) throw new AthenaInputError("That event isn't there any more", 404);
  if (ev.recurrence === "yearly") throw new AthenaInputError("Only one-off events take an answer");
  const before = ev.rsvp;
  await q(`UPDATE events SET rsvp = $2, rsvp_mine = true, rsvp_error = '', updated_at = now() WHERE id = $1`, [id, answer]);
  let outcome: AnswerResult["outcome"] = "saved";
  let message = "";
  const calendarAgrees = ev.rsvp_calendar === answer && !ev.rsvp_error;
  if (sendable(ev, answer) && !calendarAgrees) {
    message = await send(ev, answer, deps.calendar, opts.series === true);
    outcome = message ? "failed" : "sent";
  } else if (calendarAgrees) {
    outcome = "unchanged";
  } else if (ev.calendar_event_id && !ev.rsvp_account?.can_send) {
    message = `Only in Athena. Turn on “Let Athena answer invites” to send it to ${calendarName(ev.rsvp_account?.provider)}.`;
  }
  return { event: (await getEvent(id))!, outcome, message, before };
}

/**
 * Undo: put back the answer that was there, in Athena and on the calendar.
 * It's held as yours, so a calendar that can't take it back (Outlook has no
 * "no reply") doesn't overwrite it at the next sync.
 */
export async function restoreRsvp(id: string, before: Rsvp, deps: { calendar: CalendarPort }): Promise<AnswerResult> {
  return answerEvent(id, before, deps);
}

/**
 * After you turn on "Let Athena answer invites" for an account: send the
 * answers you gave in Athena that the calendar doesn't have yet. Upcoming
 * events only. Returns how many went.
 */
export async function sendPendingAnswers(connectorId: string, deps: { calendar: CalendarPort }, now: Date = new Date()): Promise<number> {
  const account = (await listConnectors()).find((c) => c.id === connectorId);
  if (!account || !canRsvp(account) || account.status !== "connected") return 0;
  const rows = await q<{ id: string }>(
    `SELECT id FROM events
      WHERE calendar_connector_id = $1 AND archived_at IS NULL AND rsvp_mine AND rsvp <> 'none'
        AND rsvp IS DISTINCT FROM rsvp_calendar AND COALESCE(starts_at, date::timestamptz + interval '1 day') > $2
      LIMIT 50`,
    [connectorId, now.toISOString()],
  );
  let sent = 0;
  for (const { id } of rows) {
    const ev = await getEvent(id);
    if (ev && sendable(ev, ev.rsvp) && !(await send(ev, ev.rsvp, deps.calendar))) sent++;
  }
  return sent;
}
