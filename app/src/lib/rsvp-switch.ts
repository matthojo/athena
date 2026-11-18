/**
 * "Let Athena answer invites" for one calendar account: adds or removes the
 * narrow write permission (RSVP_SCOPE) and, when turning it on, signs in
 * again so the calendar grants it (not iCloud: it has no sign-in). Used by the account page's switch and by
 * an event's one-tap "Turn on".
 */
import { RSVP_SCOPE } from "../../../lib/connector-presets";
import { fetchConnectors, signInConnector, updateConnector } from "../db/api";
import type { Connector } from "../types";

/** Save the permission change. Turning it on needs a sign-in afterwards for Google and Outlook, for the calendar to grant it; iCloud has none. */
export async function setAnswering(c: Pick<Connector, "id" | "provider" | "scope">, on: boolean): Promise<void> {
  const scope = RSVP_SCOPE[c.provider];
  if (!scope) throw new Error("This account can't answer invites");
  const scopes = new Set(c.scope.split(/\s+/).filter(Boolean));
  if (on) scopes.add(scope);
  else scopes.delete(scope);
  await updateConnector(c.id, { scope: [...scopes].join(" ") });
}

/** From an event: turn it on for that event's account and go to the calendar's sign-in. */
export async function turnOnAnswering(accountId: string): Promise<"redirect" | "done"> {
  const c = (await fetchConnectors()).connectors.find((x) => x.id === accountId);
  if (!c) throw new Error("That calendar account isn't connected any more");
  await setAnswering(c, true);
  // iCloud: the Apple ID and app password already allow it, and the server sends your earlier answers straight away.
  if (c.provider === "icloud-calendar") return "done";
  const r = await signInConnector(c.id);
  if (r.authorization_url) {
    location.assign(r.authorization_url);
    return "redirect";
  }
  return "done";
}
