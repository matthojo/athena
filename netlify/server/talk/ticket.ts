/**
 * Tickets for the Talk session socket. A browser can't put the bearer token
 * on a WebSocket, so the app asks for a ticket with an ordinary authenticated
 * POST and opens the socket with it. A ticket is random, works once, for 30
 * seconds, from the IP that asked, and carries the credential that asked for
 * it (../shared.ts: "master" or "key:<id>"), which the session is counted
 * against. It lives in this instance's memory (config.scale.max is 1), so a
 * restart forgets it and the app asks again.
 */
import { randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, { ip: string; who: string; expires: number }>();

export function issueTicket(ip: string, now = Date.now(), who = "master"): string {
  for (const [t, v] of tickets) if (v.expires <= now) tickets.delete(t);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { ip, who, expires: now + TICKET_TTL_MS });
  return ticket;
}

/** The credential a ticket was issued to: once per ticket, for the IP it was issued to, before it expires. A ticket is spent by any attempt to use it. */
export function ticketHolder(ticket: string | null, ip: string, now = Date.now()): string | null {
  const held = ticket ? tickets.get(ticket) : undefined;
  if (!ticket || !held) return null;
  tickets.delete(ticket);
  return held.ip === ip && held.expires > now ? held.who : null;
}

/** ticketHolder, as a yes or no. */
export function redeemTicket(ticket: string | null, ip: string, now = Date.now()): boolean {
  return ticketHolder(ticket, ip, now) !== null;
}
