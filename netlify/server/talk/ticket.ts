/**
 * Tickets for the Talk session socket. A browser can't put the bearer token
 * on a WebSocket, so the app asks for a ticket with an ordinary authenticated
 * POST and opens the socket with it. A ticket is random, works once, for 30
 * seconds, from the IP that asked. It lives in this instance's memory
 * (config.scale.max is 1), so a restart forgets it and the app asks again.
 */
import { randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, { ip: string; expires: number }>();

export function issueTicket(ip: string, now = Date.now()): string {
  for (const [t, v] of tickets) if (v.expires <= now) tickets.delete(t);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { ip, expires: now + TICKET_TTL_MS });
  return ticket;
}

/** True once per ticket, for the IP it was issued to, before it expires. A ticket is spent by any attempt to use it. */
export function redeemTicket(ticket: string | null, ip: string, now = Date.now()): boolean {
  const held = ticket ? tickets.get(ticket) : undefined;
  if (!ticket || !held) return false;
  tickets.delete(ticket);
  return held.ip === ip && held.expires > now;
}
