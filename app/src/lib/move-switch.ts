/**
 * "Let Athena add and update events" (it was "Let Athena move events you
 * organise", and keeps that marker) for one calendar account: adds or
 * removes Athena's marker (MOVE_MARKER) in the account's scope. On Google
 * and Outlook adding and moving need the calendar's write permission, which the
 * server asks for at sign-in (oauthScope), so turning it on signs in again
 * unless answering invites already has it. iCloud needs no sign-in.
 */
import { canRsvp, MOVE_MARKER } from "../../../lib/connector-presets";
import { updateConnector } from "../db/api";
import type { Connector } from "../types";

/** Save the switch. True when the calendar has to be signed in to again for its permission. */
export async function setMoving(c: Pick<Connector, "id" | "provider" | "scope">, on: boolean): Promise<boolean> {
  const scopes = new Set(c.scope.split(/\s+/).filter(Boolean));
  if (on) scopes.add(MOVE_MARKER);
  else scopes.delete(MOVE_MARKER);
  await updateConnector(c.id, { scope: [...scopes].join(" ") });
  return on && c.provider !== "icloud-calendar" && !canRsvp(c);
}
