/**
 * Ask and Saved (lib/saved-actions.ts): find a saved item, and file it
 * somewhere with one of its actions ("move the green dress to Rowan's gift
 * ideas"). The Ask chat's @ mentions send a saved item's id, so the
 * assistant can call file_saved_item straight away.
 *
 * lib/assistant.ts lists SAVED_TOOLS, runs them through runSavedTool() and
 * undoes them through applySavedToolUndo(). The actions themselves load on
 * first use (they run through Ask's own tools, so a static import would loop).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { listSaved } from "./saved";
import { notesMentioning } from "./db";
import { thingLine } from "./saved-kinds";
import { factsWithPriceNow } from "./trackers";
import { unlinked } from "./run-links";
import type { Change } from "./assistant";

export const SAVED_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_saved",
    description:
      "Find things the owner saved (links, images, quotes, notes kept from their phone or browser) by words in the title, their note or the page's text. " +
      "Returns each one's id, title, what it is (a book, a product, a place…), whether it's already filed, and the actions that fit it, for file_saved_item. An @ mention of a saved item already gives its id.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "file_saved_item",
    description:
      "Do something with one saved item (saved_id from an @ mention or find_saved). For a mentioned saved item, prefer this over add_to_list, add_to_watch_read, save_item or add_todo: it also files the item out of the owner's Saved list, with Undo. " +
      "action is one of: watch_read (a book, film or show onto watch & read; params {}), gift_idea (params { person_id } from find_people: onto their Gift ideas list), " +
      "add_to_list (params { note_id } for a list from find_notes, or { list_title } to find or start one by name), save_place (a place onto Places; params {}), " +
      "make_todo (params { title } optional, e.g. \"Buy: Green wrap dress\"), link (params { target: { kind: person, note or project, id } }; links it without filing). " +
      '"Move @green dress as a gift idea for Rowan" is find_people for Rowan, then action gift_idea with params { person_id }.',
    input_schema: {
      type: "object",
      properties: {
        saved_id: { type: "string" },
        action: { type: "string", enum: ["watch_read", "gift_idea", "add_to_list", "save_place", "make_todo", "link"] },
        params: { type: "object", description: "What the action needs; {} when nothing." },
      },
      required: ["saved_id", "action"],
    },
  },
];

export const SAVED_TOOL_NAMES: ReadonlySet<string> = new Set(SAVED_TOOLS.map((t) => t.name));

export const SAVED_GUIDANCE = `- Saved items (links, pictures and notes the owner kept): for "move this book to watch & read", "add the dress to Rowan's gift ideas" or "save that restaurant to places" about a saved item (an @ mention, or find_saved), use file_saved_item, which also files it out of Saved.`;

const inputs = {
  find_saved: z.object({ query: z.string().max(200) }),
  file_saved_item: z.object({ saved_id: z.string().uuid(), action: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()).default({}) }),
};

export interface SavedToolUndo {
  op: "unfile_saved";
  id: string;
  /** For an action that didn't file (link): its own undo. */
  undo?: unknown;
}

const OPEN_KIND = { note: "note", person: "person", reading: "reading", commitment: "commitment", place: "place" } as const;

export async function runSavedTool(name: string, raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  const { actionsFor, runSavedAction, SavedActionError } = await import("./saved-actions");
  if (name === "find_saved") {
    const { query } = inputs.find_saved.parse(raw);
    const page = await listSaved({ q: query.trim() || undefined, limit: 8 });
    const notes = await notesMentioning("saved", page.items.map((i) => i.id));
    return JSON.stringify(
      page.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title ?? i.quote?.slice(0, 120) ?? i.note?.slice(0, 120) ?? null,
        // Its own link: a Team assistant that looks things up online may open it (lib/answer.ts webFetchTool).
        ...(i.url && /^https:\/\//.test(i.url) ? { link: i.url.slice(0, 500) } : {}),
        // The best price now when it has checks since it was saved. Its shop can be a site a
        // model named, and web_fetch trusts this tool's result, so its web addresses can't be opened (lib/run-links.ts).
        ...(thingLine(i.thing, factsWithPriceNow(i.facts, i.price_now)) ? { what: unlinked(thingLine(i.thing, factsWithPriceNow(i.facts, i.price_now))!) } : {}),
        ...(i.filed ? { filed_in: i.filed.label } : {}),
        actions: actionsFor(i).map((a) => a.id),
        ...(notes.get(i.id) ? { mentioned_in: notes.get(i.id) } : {}),
      })),
    );
  }
  const input = inputs.file_saved_item.parse(raw);
  try {
    const { item, result } = await runSavedAction(input.saved_id, input.action, input.params);
    if (!result.undo && !result.filed) return JSON.stringify({ done: result.done, id: item.id });
    const t = result.target;
    const open = t && t.kind in OPEN_KIND ? { kind: OPEN_KIND[t.kind as keyof typeof OPEN_KIND], id: t.id } : null;
    return record({
      kind: t?.kind === "reading" ? "reading" : t?.kind === "place" ? "place" : t?.kind === "commitment" ? "commitment" : input.action === "link" ? "link" : "note",
      id: t?.id ?? item.id,
      action: result.filed ? "updated" : "created",
      title: item.title ?? item.facts?.name ?? "Saved item",
      detail: result.done,
      open,
      undo: { op: "unfile_saved", id: item.id, ...(result.filed ? {} : { undo: result.undo }) },
    });
  } catch (error) {
    if (error instanceof SavedActionError) return JSON.stringify({ error: error.message });
    throw error;
  }
}

const UNDO = z.object({ op: z.literal("unfile_saved"), id: z.string().uuid(), undo: z.unknown().optional() });

export const isSavedToolUndo = (raw: unknown): boolean => UNDO.safeParse(raw).success;

export async function applySavedToolUndo(raw: unknown): Promise<void> {
  const u = UNDO.parse(raw);
  const { undoSavedAction } = await import("./saved-actions");
  await undoSavedAction(u.id, u.undo);
}
