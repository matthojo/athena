/**
 * MCP tools for the grocery list (lib/recipes.ts, lib/grocery-memory.ts):
 * read what's on it and the usuals that are due, and add lines to it. The
 * lines come back in the stored-content envelope, since they're the owner's
 * own words. Adding never ticks, files a shop or touches past shops.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers } from "./results";
import { addGroceryLines, groceryListJson } from "../../../lib/assistant-recipes";

export function registerGroceryTools(server: McpServer, { ok, stored, safe }: Helpers): void {
  server.tool(
    "athena_get_grocery_list",
    "The owner's grocery list: the lines still to buy (with the recipes each is for), the lines ticked as in the basket, and the usuals that are due again (things they buy every so often, worked out from their past shops, with how many days apart and when last bought).",
    {},
    safe(async () => stored("grocery list", { ...(JSON.parse(await groceryListJson()) as Record<string, unknown>), source: "athena_grocery" })),
  );

  server.tool(
    "athena_add_to_grocery_list",
    "Add lines to the owner's grocery list, one per thing, amount first when there is one (\"2 lemons\", \"500 g Greek yoghurt\", \"milk\"). Lines sort into aisles by themselves. Anything already on the list and not yet ticked is skipped and named in the reply.",
    {
      items: z.array(z.string().min(1).max(200)).min(1).max(30).describe("One line per thing to buy"),
    },
    safe(async ({ items }: { items: string[] }) => {
      const { added, already } = await addGroceryLines(items);
      return ok({ added: added.map((a) => a.text), already_on_the_list: already });
    }),
  );
}
