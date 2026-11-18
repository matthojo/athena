/**
 * lib/scheduling.ts's SchedulingPort, through each calendar account's own
 * connection: list_events for the owner's busy times (only the calendars
 * they switched on), free_busy for guests (busy or free, nothing else) and
 * move_event, which callTool allows only with "Let Athena move events you
 * organise" on for that account (canMove). Like calendar-rsvp.ts.
 */
import type { SchedulingPort, PersonBusy, Moved, Created } from "../../../lib/scheduling";
import type { CalendarEventLite } from "../../../lib/availability";
import { calendarName } from "../../../lib/rsvp";
import { AthenaInputError } from "../../../lib/db";
import { CREATE_TOOL, FREE_BUSY_TOOL, MOVE_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { callTool, ConnectorNeedsSignIn, openConnector, type OpenConnector } from "./mcp-client";

/** At most this many pages of events per account and search. */
const MAX_PAGES = 6;

async function withAccount<T>(connectorId: string, run: (open: OpenConnector) => Promise<T>): Promise<T> {
  let open: OpenConnector;
  try {
    open = await openConnector(connectorId);
  } catch (error) {
    if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again, in Sources`);
    throw error;
  }
  try {
    return await run(open);
  } catch (error) {
    if (error instanceof AthenaInputError) throw error;
    if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again, in Sources`);
    throw new AthenaInputError(`${calendarName(open.connector.provider)} didn't answer. Try again in a minute.`);
  } finally {
    await open.close();
  }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const schedulingPort: SchedulingPort = {
  async events(connectorId, from, to) {
    return withAccount(connectorId, async (open) => {
      const out: CalendarEventLite[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await callTool(open, "list_events", { startTime: from.toISOString(), endTime: to.toISOString(), pageSize: 250, ...(pageToken ? { pageToken } : {}) });
        if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
        const body = parse(r.text) as { events?: CalendarEventLite[]; nextPageToken?: string } | null;
        out.push(...(body?.events ?? []));
        pageToken = body?.nextPageToken;
        if (!pageToken) break;
      }
      return out;
    });
  },
  async freeBusy(connectorId, emails, from, to) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, FREE_BUSY_TOOL, { emails, startTime: from.toISOString(), endTime: to.toISOString() });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
      return ((parse(r.text) as { people?: PersonBusy[] } | null)?.people ?? []).filter((p) => p && typeof p.email === "string");
    });
  },
  async move(connectorId, req) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, MOVE_TOOL, { calendarId: req.calendarId, eventId: req.eventId, start: req.start, ...(req.end ? { end: req.end } : {}), ...(req.expect ? { expect: req.expect } : {}) });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
      const m = parse(r.text) as Moved | null;
      if (!m?.before?.start || !m?.after?.start) throw new AthenaInputError(`${calendarName(open.connector.provider)} didn't say where the event went. Check it there.`);
      return { before: m.before, after: m.after, guests: Number(m.guests) || 0, summary: m.summary ?? "" };
    });
  },
  async calendars(connectorId) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, "list_calendars", { pageSize: 100 });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
      const list = ((parse(r.text) as { calendars?: Array<{ id?: string; summary?: string; primary?: boolean; accessRole?: string }> } | null)?.calendars ?? []).filter(
        (c) => typeof c?.id === "string" && (c.accessRole === undefined || c.accessRole === "owner" || c.accessRole === "writer"),
      );
      const out = list.map((c) => ({ id: c.primary && open.connector.provider !== "icloud-calendar" ? "primary" : c.id!, name: c.summary ?? "", primary: !!c.primary }));
      return [...out.filter((c) => c.primary), ...out.filter((c) => !c.primary)];
    });
  },
  async create(connectorId, req) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, CREATE_TOOL, {
        calendarId: req.calendarId,
        summary: req.summary,
        start: req.start,
        end: req.end,
        timeZone: req.timeZone,
        ...(req.location ? { location: req.location } : {}),
        ...(req.description ? { description: req.description } : {}),
        attendees: req.attendees,
        ...(req.block ? { block: true } : {}),
        ...(req.focusTime ? { focusTime: true } : {}),
      });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
      const c = parse(r.text) as Partial<Created> | null;
      if (!c?.id || typeof c.calendarId !== "string") throw new AthenaInputError(`${calendarName(open.connector.provider)} didn't say it added the event. Check it there before trying again.`);
      return { id: c.id, calendarId: c.calendarId, link: typeof c.link === "string" ? c.link : "", guests: Number(c.guests) || 0 };
    });
  },
  async removeCreated(connectorId, req) {
    return withAccount(connectorId, async (open) => {
      const r = await callTool(open, UNDO_CREATE_TOOL, { calendarId: req.calendarId, eventId: req.eventId });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
    });
  },
};
