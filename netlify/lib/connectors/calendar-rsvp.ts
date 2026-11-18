/**
 * lib/rsvp.ts's CalendarPort, through the calendar account's own connection
 * (google-calendar.ts or microsoft-calendar.ts): respond_to_event, the one
 * calendar write, which callTool allows only for an account with "Let
 * Athena answer invites" on. Nothing here creates, edits, moves or deletes
 * an event.
 */

import type { CalendarPort } from "../../../lib/rsvp";
import { calendarName } from "../../../lib/rsvp";
import { AthenaInputError } from "../../../lib/db";
import { RSVP_TOOL } from "../../../lib/connector-presets";
import { callTool, ConnectorNeedsSignIn, openConnector } from "./mcp-client";

export const calendarPort: CalendarPort = {
  async respond(connectorId, invite) {
    let open;
    try {
      open = await openConnector(connectorId);
    } catch (error) {
      if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again, in Sources`);
      throw error;
    }
    try {
      const r = await callTool(open, RSVP_TOOL, { calendarId: invite.calendarId, eventId: invite.eventId, answer: invite.answer, ...(invite.series ? { series: true } : {}) });
      if (r.isError) throw new AthenaInputError(r.text.slice(0, 300));
    } catch (error) {
      if (error instanceof AthenaInputError) throw error;
      if (error instanceof ConnectorNeedsSignIn) throw new AthenaInputError(`Sign in to ${error.connectorName} again, in Sources`);
      // callTool has already marked the account if it was the account's problem; anything else was this one request.
      throw new AthenaInputError(`${calendarName(open.connector.provider)} didn't answer. Try again in a minute.`);
    } finally {
      await open.close();
    }
  },
};
