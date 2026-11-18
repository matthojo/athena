/**
 * Ask's assistant and invites: "I can't make Friday's design review"
 * declines it, "put me down as a maybe for the offsite" answers Maybe. Kept
 * beside lib/assistant.ts, which lists answer_invite with its own tools,
 * runs it through runRsvpTool() and undoes it through applyRsvpUndo().
 *
 * The assistant never answers on its own (security review M7): the tool
 * prepares a card, and the answer is saved and sent only when the owner
 * taps it (POST /api/events/:id/rsvp, lib/rsvp.ts), so it's sent to the
 * calendar only for an account with "Let Athena answer invites" on.
 * applyRsvpUndo stays for receipts made before this.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import { WAITING, type ConfirmCard } from "./assistant-confirm";
import { AthenaInputError, getEvent, RSVPS } from "./db";
import { calendarName, restoreRsvp, type AnswerResult, type CalendarPort } from "./rsvp";

export const RSVP_TOOLS: Anthropic.Tool[] = [
  {
    name: "answer_invite",
    description:
      "Offer to answer an event for the owner: going, maybe or declined. The app shows the answer for them to confirm, and it's saved and sent only when they tap it. For “I can't make Friday's design review”, “count me out of the offsite”, “I'll go to Sam's drinks”, “maybe for the all-hands”. " +
      "Find the event first with find_items (kind event), picking the one on the day they mean. After calling it, say in one short sentence that it's ready to confirm; never say it's answered, declined or sent.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        event_id: { type: "string", description: "The event's id from find_items." },
        answer: { type: "string", enum: ["going", "maybe", "declined"] },
        series: { type: "boolean", description: "Only after the owner says “all of them” to a repeating invite: answer every date, not just this one." },
      },
      required: ["event_id", "answer"],
    },
  },
];

export const RSVP_TOOL_NAMES = new Set(RSVP_TOOLS.map((t) => t.name));

export const RSVP_GUIDANCE = `- Invites: when the owner says they can't make, won't go to, will go to or might go to an event, find it with find_items (kind event) and call answer_invite. The owner confirms in the app, which then says where the answer went. Never say it's answered before they do. Pass series true only when the owner has said "all of them" about a repeating invite.`;

const input = z.object({ event_id: z.string().uuid(), answer: z.enum(["going", "maybe", "declined"]), series: z.boolean().optional() });

/** iCloud's question for one date of a repeating invite (icloud-rsvp.ts SERIES_QUESTION): its message starts with this. */
export const SERIES_PREFIX = "This invite repeats.";
export const asksSeries = (message: string | undefined | null) => !!message && message.startsWith(SERIES_PREFIX);

const SAYS = { going: "Going", maybe: "Maybe", declined: "Declined", none: "No answer" } as const;

/** "Declined · sent to Google Calendar", "Maybe · only in Athena". */
export function answerDetail(r: AnswerResult, answer: keyof typeof SAYS): string {
  const where = calendarName(r.event.rsvp_account?.provider);
  const invite = !!r.event.calendar_event_id && !!r.event.rsvp_account;
  const tail =
    r.outcome === "sent" ? `sent to ${where}` : r.outcome === "failed" && asksSeries(r.message) ? "all of them, or just this one?" : r.outcome === "failed" ? `couldn't send to ${where}` : r.outcome === "unchanged" && invite ? `already in ${where}` : invite ? "only in Athena" : "";
  return tail ? `${SAYS[answer]} · ${tail}` : SAYS[answer];
}

/** Prepares the answer for the owner to confirm. Nothing is saved or sent here. */
export async function runRsvpTool(name: string, raw: unknown, ctx: { confirm: (card: ConfirmCard) => void }): Promise<string> {
  if (name !== "answer_invite") throw new Error(`Unknown tool ${name}`);
  const { event_id, answer, series } = input.parse(raw);
  const ev = await getEvent(event_id);
  if (!ev) throw new AthenaInputError("That event isn't there any more");
  if (ev.recurrence === "yearly") throw new AthenaInputError("Only one-off events take an answer");
  const sends = !!ev.calendar_event_id && !!ev.rsvp_account?.can_send;
  ctx.confirm({ kind: "rsvp", event_id: ev.id, title: ev.title, starts_at: ev.starts_at, date: ev.date, answer, ...(series ? { series: true } : {}), sends_to: sends ? calendarName(ev.rsvp_account?.provider) : null });
  return JSON.stringify({ shown: WAITING });
}

// ---------- undo ----------

const RSVP_UNDO = z.object({ op: z.literal("restore_rsvp"), id: z.string().uuid(), rsvp: z.enum(RSVPS as unknown as ["going", "maybe", "declined", "none"]) });

export type RsvpUndo = z.infer<typeof RSVP_UNDO>;

export function isRsvpUndo(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { op?: unknown }).op === "restore_rsvp";
}

/** Put the earlier answer back, in Athena and (when allowed) on the calendar. */
export async function applyRsvpUndo(raw: unknown, deps: { calendar?: CalendarPort }): Promise<void> {
  const undo = RSVP_UNDO.parse(raw);
  if (!deps.calendar) throw new AthenaInputError("That can't be undone here");
  await restoreRsvp(undo.id, undo.rsvp, { calendar: deps.calendar });
}
