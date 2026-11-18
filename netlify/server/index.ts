/**
 * Athena's Netlify Server: one long-lived Node process beside the functions.
 * It claims only Ask, Talk, the live channel and Team chat's channel; everything else (REST CRUD,
 * /mcp, /api/voice/*, scheduled and background work) stays a function.
 * One module per area, so work on one never edits another's file.
 * See docs/netlify-server.md.
 */
import type { Config, Context } from "@netlify/server";
import { jsonResponse } from "./shared";
import { handleAssistant } from "./routes/assistant";
import { handleLive } from "./routes/live";
import { handleTalk } from "./routes/talk";
import { handleTeamChat } from "./routes/team-chat";

const routes: Record<string, (req: Request, context: Context) => Promise<Response>> = {
  assistant: handleAssistant,
  talk: handleTalk,
  live: handleLive,
  // Only /api/team/chat is claimed below: what's typed there calls a model.
  team: handleTeamChat,
};

export default async (req: Request, context: Context): Promise<Response> => {
  const area = new URL(req.url).pathname.split("/")[2] ?? "";
  const route = Object.hasOwn(routes, area) ? routes[area] : undefined;
  const res = route ? await route(req, context) : jsonResponse({ error: "Not found" }, 404);
  // Says which runtime answered (a function never sets it). Skipped where headers can't be changed (a WebSocket upgrade).
  try {
    res.headers.set("X-Athena-Runtime", "server");
  } catch {}
  return res;
};

// Read statically, so literals only. These paths are also in api.ts's excludedPath: functions win over the server.
export const config: Config = {
  path: ["/api/assistant", "/api/assistant/*", "/api/talk/*", "/api/live/*", "/api/team/chat"],
  region: "cmh",
  scale: { max: 1 },
};
