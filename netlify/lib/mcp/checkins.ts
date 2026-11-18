/**
 * MCP tools for check-ins (lib/checkins.ts; lib/checkin-types.ts): read only. The owner's
 * answers come back in the stored-content envelope, since they're the owner's own words.
 * Reading a day here never plans it: a day nobody has opened has nothing to show.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers } from "./results";
import { CHECKIN_KINDS } from "../../../lib/checkin-types";
import { listCheckins, loadCheckinSettings, readCheckin, readKind } from "../../../lib/checkins";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerCheckinTools(server: McpServer, { ok, stored, safe }: Helpers): void {
  server.tool(
    "athena_get_checkin",
    "One day's check-in: the morning preparation or the evening reflection. Returns its questions (as they were asked that day), the owner's answers by question id, and whether it's done. Null when nothing was planned that day.",
    {
      date: DATE.describe("The day, YYYY-MM-DD"),
      kind: z.enum(CHECKIN_KINDS).describe("morning or evening"),
    },
    safe(async ({ date, kind }: { date: string; kind: string }) => {
      const checkin = await readCheckin(date, readKind(kind));
      return checkin ? stored("check-ins", { ...checkin, source: "athena_checkin" }) : ok({ checkin: null, routine_on: (await loadCheckinSettings())[readKind(kind)].enabled });
    }),
  );

  server.tool(
    "athena_list_checkins",
    "Which days in a range have a morning or evening check-in, and whether each is open or done. At most 400 days. Use athena_get_checkin for a day's answers.",
    {
      from: DATE.describe("First day, YYYY-MM-DD"),
      to: DATE.describe("Last day, YYYY-MM-DD"),
    },
    safe(async ({ from, to }: { from: string; to: string }) => ok(await listCheckins(from, to))),
  );
}
