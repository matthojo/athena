/**
 * /api/team/chat — Team chat's channel (netlify/lib/team-chat-routes.ts).
 * The handling is the REST dispatcher in netlify/functions/api.ts. What's
 * typed (POST) calls a model, as Ask or as an assistant, so it shares Ask's
 * count: 20 requests a minute per credential across both (../shared.ts
 * countRequest). Reading the channel (GET) isn't counted; the app reads it
 * every few seconds while a stage works. A post's dismiss route stays with
 * the function.
 */
import type { Context } from "@netlify/server";
import api from "../../functions/api";
import { countRequest } from "../shared";

export async function handleTeamChat(req: Request, context: Context): Promise<Response> {
  if (req.method === "POST") {
    const { limited } = await countRequest(req, "assistant", 20, context.ip);
    if (limited) return limited;
  }
  return api(req, context as never);
}
