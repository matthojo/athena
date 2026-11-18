/**
 * MCP tools for Saved actions (lib/saved-actions.ts; docs/notes/saved-actions.md):
 * an outside agent can see what fits a saved item and run it, like the app's
 * "More actions". There's no undo here: the owner undoes from the app.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Helpers } from "./results";
import { getSaved, listSaved } from "../../../lib/saved";
import { actionsFor, runSavedAction, savedLinks } from "../../../lib/saved-actions";
import { thingLine } from "../../../lib/saved-kinds";

const ABOUT =
  "Saved items are links, images, quotes and notes the owner kept from their phone or browser. Each has actions that fit it: " +
  "watch_read (a book, film or show onto watch & read), gift_idea (params { person_id }), add_to_list (params { note_id } or { list_title }), " +
  "save_place (a place onto Places), make_todo (params { title } optional), link (params { target: { kind: person, note or project, id } }). " +
  "All but link file the item: it leaves the owner's main Saved list, and they can undo it from the app.";

export function registerSavedActionTools(server: McpServer, { ok, stored, safe }: Helpers): void {
  server.tool(
    "list_saved_actions",
    `The actions that fit one saved item, best first (the first is the one the app suggests), with what each needs. Give saved_id, or query to find items first (each comes with its actions). ${ABOUT}`,
    {
      saved_id: z.string().uuid().optional().describe("A saved item's id"),
      query: z.string().max(200).optional().describe("Words in a saved item's title, note or page text, when you don't have its id"),
    },
    safe(async ({ saved_id, query }: { saved_id?: string; query?: string }) => {
      if (saved_id) {
        const item = await getSaved(saved_id);
        if (!item) return ok({ error: "No saved item has that id." });
        return stored("saved items", { id: item.id, title: item.title, what: thingLine(item.thing, item.facts), filed_in: item.filed?.label ?? null, links: await savedLinks(item.id), actions: actionsFor(item) });
      }
      const page = await listSaved({ q: query?.trim() || undefined, limit: 10 });
      return stored("saved items", page.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title ?? i.quote?.slice(0, 120) ?? i.note?.slice(0, 120) ?? null, what: thingLine(i.thing, i.facts), filed_in: i.filed?.label ?? null, actions: actionsFor(i).map((a) => a.id) })));
    }),
  );

  server.tool(
    "run_saved_action",
    `Run one action on a saved item (ids from list_saved_actions). Returns where it went and the item as it is now. ${ABOUT}`,
    {
      saved_id: z.string().uuid(),
      action: z.string().min(1).max(40).describe("An action id from list_saved_actions"),
      params: z.record(z.unknown()).optional().describe("What the action needs, e.g. { person_id } for gift_idea; {} or left out when nothing"),
    },
    safe(async ({ saved_id, action, params }: { saved_id: string; action: string; params?: Record<string, unknown> }) => {
      const { item, result } = await runSavedAction(saved_id, action, params ?? {});
      const { undo: _undo, ...shown } = result;
      return stored("saved items", { done: result.done, result: shown, item: { id: item.id, title: item.title, filed_in: item.filed?.label ?? null } });
    }),
  );
}
