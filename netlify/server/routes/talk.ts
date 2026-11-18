/**
 * /api/talk/* — Talk's listening tokens and spoken replies. 30 requests a
 * minute per IP: every call spends the owner's ElevenLabs credits.
 *
 *   POST /api/talk/ticket    (bearer) → { ticket, expires_in } for the socket below
 *   GET  /api/talk/session   ?ticket=… upgraded to a WebSocket: one Talk session (../talk/session.ts)
 *   POST /api/talk/listen, /api/talk/speak: netlify/lib/voice/routes.ts through the
 *        REST dispatcher in netlify/functions/api.ts (same bearer auth). The app
 *        falls back to /speak when the socket isn't open.
 */
import { onShutdown, upgradeWebSocket, type Context } from "@netlify/server";
import api from "../../functions/api";
import { NOT_CONNECTED } from "../../lib/voice/routes";
import { setVoiceKeyStatus, voiceCredentials } from "../../../lib/voice-settings";
import { jsonResponse, rateLimit, requireAuth } from "../shared";
import { attachTalkSession, closeTalkSessions, type TalkSocket } from "../talk/session";
import { issueTicket, redeemTicket, TICKET_TTL_MS } from "../talk/ticket";

const LIMIT = 30;

// An instance that's stopping (a deploy, 8 hours up) would otherwise hold these for up to 90 s.
onShutdown(() => closeTalkSessions());

export async function handleTalk(req: Request, context: Context): Promise<Response> {
  const limitKey = `talk:${context.ip}`;
  const limited = rateLimit(limitKey, LIMIT);
  if (limited) return limited;
  const url = new URL(req.url);

  if (url.pathname === "/api/talk/ticket") {
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const denied = await requireAuth(req);
    if (denied) return denied;
    return jsonResponse({ ticket: issueTicket(context.ip), expires_in: TICKET_TTL_MS / 1000 }, 200, { "Cache-Control": "no-store" });
  }

  if (url.pathname === "/api/talk/session") {
    if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonResponse({ error: "Connect with a WebSocket" }, 426, { Upgrade: "websocket" });
    // The ticket is the proof of sign-in: only an authenticated POST can have been given one.
    if (!redeemTicket(url.searchParams.get("ticket"), context.ip)) return jsonResponse({ error: "Unauthorized" }, 401);
    const creds = await voiceCredentials();
    if (!creds) return jsonResponse(NOT_CONNECTED, 503);
    // A ping every 30 s; a client that doesn't answer one is closed.
    const { socket, response } = upgradeWebSocket(req, { idleTimeout: 30 });
    attachTalkSession(socket as unknown as TalkSocket, {
      key: creds.key,
      voiceId: creds.voice?.id ?? null,
      // Each spoken reply counts against the same limit a POST /api/talk/speak would.
      allow: () => rateLimit(limitKey, LIMIT) === null,
      refused: () => setVoiceKeyStatus("key_rejected"),
    });
    return response;
  }

  return api(req, context as never);
}
