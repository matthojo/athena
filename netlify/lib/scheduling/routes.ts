/**
 * Finding a time and moving an event (lib/scheduling.ts):
 *   GET  /api/scheduling/hours           the owner's working hours (Settings → Days)
 *   PUT  /api/scheduling/hours           { days?, start?, end?, buffer? }
 *   POST /api/scheduling/find            { minutes?, who?, from?, to?, event_id?, title? } → the slot card
 *   POST /api/scheduling/move            { event_id, start, end? } → the move, with its undo
 *   POST /api/scheduling/undo            { undo } → moved back, or the added event taken back
 *   GET  /api/scheduling/focus           { on }: "Block time as Focus time" (Settings → Days)
 *   PUT  /api/scheduling/focus           { on }
 *   GET  /api/scheduling/calendars       the calendars Athena may add events to
 *   POST /api/scheduling/prepare         { kind?, title, start, end?, minutes?, location?, description?, who? } → the event to confirm
 *   POST /api/scheduling/block           { title, minutes?, due? } → a focus block to confirm, at the first free slot
 *   POST /api/scheduling/create          { kind?, account_id, calendar_id, title, start, end, location?, description?, attendees? } → added, with its undo
 * Behind the same bearer token as the rest of the API. A move or a new event
 * happens only here, after the owner taps Move or Add in the app's confirm
 * sheet.
 */
import { AthenaInputError } from "../../../lib/db";
import {
  applyCreateUndo,
  applyMoveUndo,
  blockTime,
  createEvent,
  findTimes,
  isCreateUndo,
  loadWorkingHours,
  moveEvent,
  prepareCreate,
  saveWorkingHours,
  loadFocusTime,
  saveFocusTime,
  writableCalendars,
  type CreateKind,
  type MoveResult,
} from "../../../lib/scheduling";
import { schedulingPort } from "../connectors/calendar-scheduling";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The move as the app shows it: the event, where it went, and the receipt's Undo. */
function out(r: MoveResult) {
  return { event: r.event, before: r.moved.before, after: r.moved.after, guests: r.moved.guests, where: r.where, undo: r.undo };
}

export async function handleSchedulingRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json): Promise<Response | null> {
  const [, first, second] = segments;
  if (first !== "scheduling" || segments.length !== 3) return null;
  const method = req.method;
  if (second === "hours") {
    if (method === "GET") return json(await loadWorkingHours());
    if (method === "PUT") return json(await saveWorkingHours(await body()));
    return json({ error: "Method not allowed" }, 405);
  }
  if (second === "focus") {
    if (method === "GET") return json({ on: await loadFocusTime() });
    if (method === "PUT") return json({ on: await saveFocusTime(((await body()) ?? {}).on) });
    return json({ error: "Method not allowed" }, 405);
  }
  if (second === "calendars") {
    if (method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(await writableCalendars({ scheduling: schedulingPort }));
  }
  if (method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = (await body()) ?? {};
  const text = (k: string, max: number) => (typeof b[k] === "string" ? (b[k] as string).slice(0, max) : undefined);
  const kindOf = (): CreateKind | undefined => {
    if (b.kind === undefined) return undefined;
    if (b.kind === "meeting" || b.kind === "booking" || b.kind === "focus") return b.kind;
    throw new AthenaInputError("kind: meeting, booking or focus");
  };
  const people = (v: unknown, max: number) =>
    Array.isArray(v)
      ? v.slice(0, max).map((w) => {
          const o = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
          return { name: typeof o.name === "string" ? o.name.slice(0, 200) : undefined, email: typeof o.email === "string" ? o.email.slice(0, 320) : "" };
        })
      : undefined;
  if (second === "prepare") {
    const title = text("title", 300);
    const start = text("start", 40);
    if (!title || !start) throw new AthenaInputError("title and start");
    return json(
      await prepareCreate(
        { kind: kindOf(), title, start, end: text("end", 40), minutes: typeof b.minutes === "number" ? b.minutes : undefined, location: text("location", 500), description: text("description", 4000), who: people(b.who, 20) },
        { scheduling: schedulingPort },
      ),
    );
  }
  if (second === "block") {
    const title = text("title", 300);
    if (!title) throw new AthenaInputError("title: what the time is for");
    const minutes = typeof b.minutes === "number" && b.minutes >= 15 && b.minutes <= 240 ? b.minutes : undefined;
    return json(await blockTime({ title, minutes, due: text("due", 10) ?? null }, { scheduling: schedulingPort }));
  }
  if (second === "create") {
    const [title, start, end, account, calendar] = [text("title", 300), text("start", 40), text("end", 40), text("account_id", 40), text("calendar_id", 1500)];
    if (!title || !start || !end || !account || !calendar) throw new AthenaInputError("title, start, end, account_id and calendar_id");
    const attendees = people(b.attendees, 50)?.map((a) => ({ name: a.name, email: a.email }));
    return json(
      await createEvent(
        { kind: kindOf(), account_id: account, calendar_id: calendar, title, start, end, location: text("location", 500), description: text("description", 4000), attendees },
        { scheduling: schedulingPort },
      ),
    );
  }
  if (second === "find") {
    const who = Array.isArray(b.who)
      ? b.who.slice(0, 10).map((w) => {
          const o = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
          return { name: typeof o.name === "string" ? o.name.slice(0, 200) : undefined, email: typeof o.email === "string" ? o.email.slice(0, 320) : undefined };
        })
      : undefined;
    const str = (k: string, max: number) => (typeof b[k] === "string" ? (b[k] as string).slice(0, max) : undefined);
    const eventId = str("event_id", 40);
    if (eventId && !UUID.test(eventId)) throw new AthenaInputError("event_id: an event's id");
    return json(
      await findTimes(
        { minutes: typeof b.minutes === "number" ? b.minutes : undefined, who, from: str("from", 10), to: str("to", 10), event_id: eventId, title: str("title", 200) },
        { scheduling: schedulingPort },
      ),
    );
  }
  if (second === "move") {
    const id = typeof b.event_id === "string" ? b.event_id : "";
    if (!UUID.test(id)) throw new AthenaInputError("event_id: an event's id");
    if (typeof b.start !== "string") throw new AthenaInputError("start: when it moves to");
    return json(out(await moveEvent(id, { start: b.start, end: typeof b.end === "string" ? b.end : undefined }, { scheduling: schedulingPort })));
  }
  if (second === "undo") {
    if (isCreateUndo(b.undo)) return json(await applyCreateUndo(b.undo, { scheduling: schedulingPort }));
    return json(out(await applyMoveUndo(b.undo, { scheduling: schedulingPort })));
  }
  return null;
}
