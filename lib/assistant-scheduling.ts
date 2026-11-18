/**
 * Ask's assistant and finding a time: "find a 30 min call with Priya next
 * week" (find_times) and "move the design review to Thursday afternoon"
 * (move_event). Kept beside lib/assistant.ts, which lists these with its own
 * tools and runs them through runSchedulingTool().
 *
 * create_event ("lunch with Priya Thursday at 1") finds the guests'
 * addresses and answers with the event for the owner to confirm; when a name
 * fits more than one person, or nobody with an address, it tells the model
 * to ask first, and shows nothing. The event is added only when the owner
 * taps Add in the confirm sheet (POST /api/scheduling/create).
 *
 * None of these changes anything on its own. find_times answers with a card of
 * three times (lib/scheduling.ts findTimes); move_event answers with the
 * move for the owner to confirm in a sheet. The move itself happens when
 * they tap Move (POST /api/scheduling/move), and its receipt has Undo.
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import { AthenaInputError, getEvent } from "./db";
import { findTimes, prepareCreate, unseenLines, type CreateProposal, type SchedulingPort, type SlotCard } from "./scheduling";
import { zonedToInstant } from "./dates";

/** What a reply can carry for the app to show: the slot card, or a move to confirm. */
export type SchedulingCard = { kind: "slots"; card: SlotCard } | { kind: "move"; move: MoveProposal } | { kind: "create"; create: CreateProposal };

export interface MoveProposal {
  event_id: string;
  title: string;
  /** Where it is now, as Athena last saw it. */
  from: string | null;
  start: string;
  end?: string;
}

export const SCHEDULING_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_times",
    description:
      "Find the three best times for a call or meeting: inside the owner's working hours, clear of their meetings (with a buffer), travel and days off, and clear of each guest's busy times where their calendar can be seen. " +
      "For “find 30 minutes with Priya next week”, “when can Sam and I do an hour on Thursday?”, “suggest times to move the design review”. The app shows the times as buttons (move an event there, or draft a reply offering them), so don't list them again in your reply: one short sentence, and say which guests' calendars couldn't be seen. " +
      "Find guests with find_people first and pass their email when Athena has one. To move an existing event, give its event_id from find_items.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        minutes: { type: "integer", description: "How long. Default 30, or the event's own length when moving one." },
        who: {
          type: "array",
          description: "The guests, not the owner.",
          items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, email: { type: "string" } } },
        },
        from: { type: "string", description: "First day to look, YYYY-MM-DD. Default today. “next week” starts on Monday." },
        to: { type: "string", description: "Last day to look, YYYY-MM-DD. Default 6 days after from." },
        event_id: { type: "string", description: "An existing event to find a new time for (find_items, kind event)." },
        title: { type: "string", description: "What it's for, in the owner's words, when that's clearer than “A 30 min call with Priya”." },
      },
    },
  },
  {
    name: "move_event",
    description:
      "Offer to move one of the owner's events to a new time: the app asks them to confirm (“Move ‘Design review’ to Thu 14:00? Guests get an update.”) and moves it only when they tap Move. Only events the owner organises, on a calendar with “Let Athena add and update events” on. " +
      "Find the event with find_items (kind event). Give start as the owner's local time. After calling it, say in one short sentence that it's ready to confirm; don't say it's moved.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        event_id: { type: "string" },
        start: { type: "string", description: "New start, the owner's local time: YYYY-MM-DDTHH:MM." },
        minutes: { type: "integer", description: "New length, only when the owner asks to change it." },
      },
      required: ["event_id", "start"],
    },
  },
  {
    name: "create_event",
    description:
      "Offer to add an event to the owner's calendar, with invites: “lunch with Priya Thursday at 1”, “book an hour with Sam and Marcus on Friday at 10”. The app shows the event (title, when, where, who gets an invite, which calendar) and adds it only when the owner taps Add. " +
      "Pass guests by name (Athena finds their email) or by email. If the result says a name matches more than one person, or that someone has no email, ask the owner with ask_owner before calling it again; don't guess. Give start as the owner's local time. After calling it, say in one short sentence that it's ready to check; never say it's added.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Short, in the owner's words: “Lunch with Priya”." },
        start: { type: "string", description: "The owner's local time: YYYY-MM-DDTHH:MM." },
        minutes: { type: "integer", description: "How long. Default 30, or 60 for a meal." },
        who: {
          type: "array",
          description: "Guests who get an invite, not the owner.",
          items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, email: { type: "string" } } },
        },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
];

export const SCHEDULING_TOOL_NAMES = new Set(SCHEDULING_TOOLS.map((t) => t.name));

export const SCHEDULING_GUIDANCE = `- Finding a time: for “find a time”, “when can I meet”, “suggest some times” or “move X to when we're both free”, call find_times; the app shows the three times as buttons. Reply in one short sentence; name any guest whose calendar couldn't be seen (“Couldn't see Sam's calendar, so these work for you”).
- Moving: for “move the design review to Thursday at 2”, find the event with find_items and call move_event; the owner confirms in the app. Never say it's moved before they do.
- Adding: for “lunch with Priya Thursday at 1” or “put a call with Sam in for Friday at 10”, call create_event; the owner checks it and taps Add. If a name fits more than one person, or someone has no email, ask which (ask_owner) first. Never say it's added before they tap Add. If it comes back with cant_add, say why in one sentence.`;

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** The owner's "2026-11-12T14:00" (or a time with an offset) as an instant. */
export function ownerInstant(raw: string, tz: string): Date {
  const s = raw.trim();
  const m = LOCAL.exec(s);
  if (m) return zonedToInstant(m[1], m[2], tz);
  if (WITH_OFFSET.test(s)) return new Date(Date.parse(s));
  throw new AthenaInputError("start: YYYY-MM-DDTHH:MM");
}

const findInput = z.object({
  minutes: z.number().int().min(5).max(480).optional(),
  who: z.array(z.object({ name: z.string().max(200).optional(), email: z.string().max(320).optional() })).max(10).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  event_id: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
});
const createInput = z.object({
  title: z.string().min(1).max(300),
  start: z.string().max(40),
  minutes: z.number().int().min(5).max(720).optional(),
  who: z.array(z.object({ name: z.string().max(200).optional(), email: z.string().max(320).optional() })).max(20).optional(),
  location: z.string().max(500).optional(),
  description: z.string().max(4000).optional(),
}).strict();
const moveInput = z.object({ event_id: z.string().uuid(), start: z.string().max(40), minutes: z.number().int().min(5).max(480).optional() });

export async function runSchedulingTool(
  name: string,
  raw: unknown,
  ctx: { scheduling?: SchedulingPort; tz: string; now: Date; show: (card: SchedulingCard) => void },
): Promise<string> {
  if (!ctx.scheduling) throw new AthenaInputError("Finding times isn't available here");
  if (name === "find_times") {
    const input = findInput.parse(raw);
    const card = await findTimes(input, { scheduling: ctx.scheduling, now: ctx.now, tz: ctx.tz });
    ctx.show({ kind: "slots", card });
    const unseen = unseenLines(card);
    return JSON.stringify({
      shown: card.slots.length ? `${card.slots.length} times, as buttons` : "No time fits",
      times: card.slots.map((s) => s.start),
      ...(unseen.length ? { note: unseen.join(". ") } : {}),
      ...(card.unread.length ? { unread: `Couldn't read ${card.unread.join(", ")}` } : {}),
      ...(card.event && !card.event.can_move ? { cant_move: card.event.why } : {}),
    });
  }
  if (name === "move_event") {
    const input = moveInput.parse(raw);
    const ev = await getEvent(input.event_id);
    if (!ev) throw new AthenaInputError("That event isn't there any more");
    const start = ownerInstant(input.start, ctx.tz);
    if (start.getTime() < ctx.now.getTime()) throw new AthenaInputError("That time has passed. Pick one later than now");
    const end = input.minutes ? new Date(start.getTime() + input.minutes * 60_000).toISOString() : undefined;
    ctx.show({ kind: "move", move: { event_id: ev.id, title: ev.title, from: ev.starts_at, start: start.toISOString(), ...(end ? { end } : {}) } });
    return JSON.stringify({ shown: "Ready for the owner to confirm in the app. Nothing has moved yet." });
  }
  if (name === "create_event") {
    const input = createInput.parse(raw);
    const start = ownerInstant(input.start, ctx.tz);
    if (start.getTime() < ctx.now.getTime()) throw new AthenaInputError("That time has passed. Pick one later than now");
    const minutes = input.minutes ?? (/\b(lunch|dinner|breakfast|brunch)\b/i.test(input.title) ? 60 : 30);
    const p = await prepareCreate(
      { kind: "meeting", title: input.title, start: start.toISOString(), minutes, location: input.location, description: input.description, who: input.who },
      { scheduling: ctx.scheduling, tz: ctx.tz },
    );
    // Ask first: nothing is shown until each guest is one person with an address.
    if (p.ambiguous.length) {
      return JSON.stringify({
        shown: "Nothing yet",
        ask_owner: p.ambiguous.map((a) => `“${a.name}” could be ${a.options.map((o) => `${o.name} <${o.email}>`).join(" or ")}. Ask which, then call create_event again with their email.`).join(" "),
      });
    }
    if (p.missing.length) {
      return JSON.stringify({ shown: "Nothing yet", ask_owner: `Athena has no email for ${p.missing.join(" or ")}. Ask for it, or whether to add the event without inviting them (call again without them).` });
    }
    if (!p.calendar) return JSON.stringify({ shown: "Nothing", cant_add: p.why ?? "No calendar Athena can add to" });
    const { ambiguous: _a, ...proposal } = p;
    ctx.show({ kind: "create", create: proposal });
    return JSON.stringify({ shown: "Ready for the owner to check and tap Add. Nothing has been added yet.", invites: proposal.attendees.map((g) => g.name) });
  }
  throw new Error(`Unknown tool ${name}`);
}
