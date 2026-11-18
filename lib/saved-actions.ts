/**
 * Saved actions (migration 0039; docs/notes/saved-actions.md): what can be
 * done with a saved item, as a registry any feature can add to. A book can
 * go to Watch & read, a dress can be a gift idea for Rowan, a Maps link can
 * be saved as a place.
 *
 * Each action says when it fits (appliesTo, fit), what it needs (params: a
 * person, a list), and does its work with run(), which returns where the
 * item went and how to undo that. An action that files the item ("Move to
 * Watch & read") takes it out of the main Saved list: filed_at is set and
 * filed_to (sealed) remembers the label, the app link and the undo. Undo
 * reverses both sides where it can: the list line comes off, a new watch &
 * read item or place is archived, and the item comes back to Saved.
 *
 * The built-ins run through Ask's own tools (runAssistantTool), so a gift
 * idea lands on the same "<Name> · Gift ideas" list Ask would use.
 *
 * Used by the API (GET/POST /api/saved/:id/actions, netlify/lib/saved/routes.ts),
 * MCP (list_saved_actions, run_saved_action) and Ask (file_saved_item).
 */
import { z } from "zod";
import { archiveEntity, getNote, getPerson, getRecord, q, qRaw, sealer, updateNote, type ArchivableKind } from "./db";
import { runAssistantTool, type Change } from "./assistant";
import { filedToOf, getSaved, isSavedId, type FiledTo } from "./saved";
import { BUILTIN, describeActions, itemName, linkOf, listLine, thingOf, todoTitle, type ActionInfo, type ActionParam, type ActionSpec } from "./saved-action-rules";
import type { SavedThing } from "./saved-kinds";
import type { SavedItem } from "./saved-rules";
import { urlHost } from "./team-events";
import { startTeamEvent } from "./team-triggers";

// ---------- the shape of an action ----------

/** How to reverse an action's change on the other side. Stored (sealed) with a filed item, or handed back to the caller for one that doesn't file. */
export type SavedUndo =
  /** Ask's own undo: archive what was made. */
  | { op: "assistant"; undo: unknown }
  /** Take the line back off a list that was already there. */
  | { op: "remove_line"; note_id: string; item: string }
  /** Remove a graph link from the saved item. */
  | { op: "unlink"; saved_id: string; target_type: string; target_id: string };

export interface ActionResult {
  /** Where it went, for the toast and the Filed list: "Rowan · Gift ideas". */
  label: string;
  /** An app route to open it there ("#/notes/<id>"), or null. */
  href: string | null;
  /** True: the item leaves the main Saved list (filed). */
  filed: boolean;
  /** Null when nothing changed on the other side (it was already on the list). */
  undo: SavedUndo | null;
  /** One line on what happened: "Added to Rowan · Gift ideas", "Already on Watch & read". */
  done: string;
  /** What it made or changed there, for Ask's Open: the list note, the watch & read item, the place, the to-do, the linked person. */
  target: { kind: "note" | "person" | "project" | "reading" | "place" | "commitment"; id: string } | null;
}

export interface SavedAction extends ActionSpec {
  run(item: SavedItem, params: Record<string, unknown>): Promise<ActionResult>;
}

export type { ActionInfo, ActionParam, ActionSpec };
export { itemName, listLine, thingOf, todoTitle };

export class SavedActionError extends Error {}

// ---------- the registry ----------

const registry = new Map<string, SavedAction>();

/** Add an action (or replace one with the same id). Call it at module load, from the feature that owns the action. */
export function registerSavedAction(action: SavedAction): void {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(action.id) || action.id === "undo") throw new Error(`Bad saved action id ${action.id}`);
  registry.set(action.id, action);
}

export const savedActionIds = (): string[] => [...registry.keys()];

const labelOf = (a: SavedAction, item: SavedItem) => (typeof a.label === "function" ? a.label(item) : a.label);
const paramsOf = (a: SavedAction, item: SavedItem) => (typeof a.params === "function" ? a.params(item) : (a.params ?? []));

/** The actions that fit, best first. Nothing for an archived item. */
export const actionsFor = (item: SavedItem): ActionInfo[] => describeActions(registry.values(), item);

// ---------- running, filing and undoing ----------

export interface RunOutcome {
  item: SavedItem;
  result: ActionResult;
}

/** Run one action on one item. Throws SavedActionError for an unknown item or action, one that doesn't fit, or missing params. */
export async function runSavedAction(savedId: string, actionId: string, params: Record<string, unknown> = {}): Promise<RunOutcome> {
  if (!isSavedId(savedId)) throw new SavedActionError("No saved item has that id.");
  const item = await getSaved(savedId);
  if (!item) throw new SavedActionError("No saved item has that id.");
  const action = registry.get(actionId);
  if (!action) throw new SavedActionError(`There's no action called ${actionId}. These fit: ${actionsFor(item).map((a) => a.id).join(", ") || "none"}.`);
  if (item.archived) throw new SavedActionError("That item is archived. Restore it first.");
  if (item.filed && action.id !== "link") throw new SavedActionError(`That item is already filed in ${item.filed.label}. Undo that first.`);
  if (!action.appliesTo(item)) throw new SavedActionError(`${labelOf(action, item)} doesn't fit this item. These do: ${actionsFor(item).map((a) => a.id).join(", ") || "none"}.`);
  for (const p of paramsOf(action, item)) {
    const v = params[p.name];
    if (p.required && (v === undefined || v === null || v === "")) throw new SavedActionError(`${action.id} needs ${p.name} (${p.label}).`);
  }
  const result = await action.run(item, params);
  if (result.filed) await fileItem(item.id, { action: action.id, label: result.label, href: result.href, undo: result.undo });
  // "When I save a gift idea": the action is what Team's event triggers match, and a matching assistant starts now (lib/team-triggers.ts). Never throws.
  await startTeamEvent("saved", item.id, "saved", { savedAction: action.id, kind: item.thing ?? item.kind, title: item.title, host: urlHost(item.url ?? item.source_url), tags: item.tags });
  return { item: (await getSaved(item.id))!, result };
}

async function fileItem(id: string, to: FiledTo): Promise<void> {
  const s = await sealer();
  await qRaw(`UPDATE saved_items SET filed_at = now(), filed_to = $2, updated_at = now() WHERE id = $1`, [id, s.text(JSON.stringify(to))]);
}

const UUID = z.string().uuid();
const UNDO = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assistant"), undo: z.unknown() }),
  z.object({ op: z.literal("remove_line"), note_id: UUID, item: z.string().min(1).max(2000) }),
  z.object({ op: z.literal("unlink"), saved_id: UUID, target_type: z.enum(["person", "note", "project"]), target_id: UUID }),
]);

/** Reverse one action's change on the other side. Never deletes anything but a link line or a graph link it made. */
export async function applySavedUndo(raw: unknown): Promise<void> {
  const undo = UNDO.parse(raw);
  if (undo.op === "assistant") {
    // Only Ask's archive undo comes this way: what an action made is archived, never deleted.
    const a = z.object({ op: z.literal("archive"), kind: z.enum(["note", "reading", "place", "commitment"]), id: UUID }).parse(undo.undo);
    await archiveEntity(a.kind as ArchivableKind, a.id);
    return;
  }
  if (undo.op === "remove_line") {
    const note = await getNote(undo.note_id);
    if (!note) return;
    const lines = note.body.split("\n");
    const at = lines.findIndex((l) => l.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "").trim() === undo.item.trim());
    if (at >= 0) {
      lines.splice(at, 1);
      await updateNote(note.id, { body: lines.join("\n") });
    }
    return;
  }
  await qRaw(`DELETE FROM edges WHERE source_type = 'saved' AND source_id = $1 AND target_type = $2 AND target_id = $3 AND origin = 'manual'`, [undo.saved_id, undo.target_type, undo.target_id]);
}

/**
 * Undo an item's filing, or an action that didn't file (pass its undo):
 * the other side is reversed, and a filed item comes back to Saved.
 */
export async function undoSavedAction(savedId: string, undo?: unknown): Promise<SavedItem | null> {
  if (!isSavedId(savedId)) return null;
  const [row] = await q<{ filed_to: string | null; filed_at: string | null }>(`SELECT filed_to, filed_at FROM saved_items WHERE id = $1`, [savedId]);
  if (!row) return null;
  if (undo !== undefined && undo !== null) await applySavedUndo(undo);
  else if (row.filed_at) {
    const to = filedToOf(row.filed_to);
    if (to?.undo) await applySavedUndo(to.undo);
  }
  if (row.filed_at && (undo === undefined || undo === null)) await qRaw(`UPDATE saved_items SET filed_at = NULL, filed_to = NULL, updated_at = now() WHERE id = $1`, [savedId]);
  return getSaved(savedId);
}

/** People, notes and projects an item is linked to ("Link to…"), newest first. */
export async function savedLinks(savedId: string): Promise<Array<{ kind: string; id: string; title: string }>> {
  if (!isSavedId(savedId)) return [];
  const rows = await qRaw<{ target_type: string; target_id: string }>(`SELECT target_type, target_id FROM edges WHERE source_type = 'saved' AND source_id = $1 ORDER BY created_at DESC`, [savedId]);
  const out: Array<{ kind: string; id: string; title: string }> = [];
  for (const r of rows) {
    const title = await targetTitle(r.target_type as Target, r.target_id);
    if (title) out.push({ kind: r.target_type, id: r.target_id, title });
  }
  return out;
}

// ---------- the built-ins ----------

/** The one change an Ask tool made, and its result's id when it changed nothing ("already on the list"). */
async function viaAsk(tool: string, input: Record<string, unknown>): Promise<{ change: Change | null; id: string | null; done: string }> {
  const { result, changes } = await runAssistantTool(tool, input);
  let parsed: { done?: string; id?: string; error?: string } = {};
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = {};
  }
  if (parsed.error) throw new SavedActionError(parsed.error);
  const change = changes[changes.length - 1] ?? null;
  return { change, id: change?.id ?? parsed.id ?? null, done: change?.label ?? parsed.done ?? "Done" };
}

/** Ask's own undo for a thing an action made; the list line for one it added to. */
function undoFor(change: Change | null, line?: string): SavedUndo | null {
  if (!change) return null;
  if (change.action === "created" && change.undo) return { op: "assistant", undo: change.undo };
  if (change.kind === "note" && line) return { op: "remove_line", note_id: change.id, item: line };
  return null;
}

const WATCH_KIND: Partial<Record<SavedThing, string>> = { book: "book", film: "film", show: "tv", video: "video" };

registerSavedAction({
  ...BUILTIN.watch_read,
  async run(item) {
    const kind = WATCH_KIND[thingOf(item)!]!;
    const url = linkOf(item);
    const { change, id, done } = await viaAsk("add_to_watch_read", {
      title: itemName(item),
      kind,
      ...(item.facts?.by ? { author: item.facts.by } : {}),
      ...(url && /^https?:\/\//.test(url) ? { url } : {}),
    });
    return { label: "Watch & read", href: id ? "#/reading" : null, filed: true, undo: undoFor(change), done: change ? "Moved to Watch & read" : done, target: id ? { kind: "reading", id } : null };
  },
});

/** Add the item's line to a list: a person's (gift ideas), a note picked by id, or one found or made by its title. */
async function addLine(item: SavedItem, input: { person_id?: string; note_id?: string; list_title?: string; tags?: string[] }): Promise<ActionResult> {
  const line = listLine(item);
  const { change, id, done } = await viaAsk("add_to_list", { item: line, ...input });
  const note = id ? await getNote(id) : null;
  const where = note?.title || input.list_title || "the list";
  return {
    label: where,
    href: id ? `#/notes/${id}` : null,
    filed: true,
    undo: undoFor(change, line),
    done: change ? `Added to ${where}` : done,
    target: id ? { kind: "note", id } : null,
  };
}

registerSavedAction({
  ...BUILTIN.gift_idea,
  async run(item, params) {
    const personId = String(params.person_id ?? "");
    if (!UUID.safeParse(personId).success || !(await getPerson(personId))) throw new SavedActionError("Pick someone in People (person_id).");
    return addLine(item, { person_id: personId, list_title: "Gift ideas", tags: ["gift ideas"] });
  },
});

registerSavedAction({
  ...BUILTIN.add_to_list,
  async run(item, params) {
    const noteId = typeof params.note_id === "string" && params.note_id ? params.note_id : undefined;
    const title = typeof params.list_title === "string" ? params.list_title.trim().slice(0, 200) : "";
    if (noteId && !UUID.safeParse(noteId).success) throw new SavedActionError("note_id isn't a note's id.");
    if (!noteId && !title) throw new SavedActionError("add_to_list needs note_id (a list) or list_title (a new one).");
    return addLine(item, noteId ? { note_id: noteId } : { list_title: title });
  },
});

registerSavedAction({
  ...BUILTIN.save_place,
  async run(item) {
    const url = linkOf(item);
    const { change, id, done } = await viaAsk("save_item", {
      kind: "place",
      id: "",
      name: itemName(item),
      ...(item.facts?.address ? { address: item.facts.address } : {}),
      ...(url && /^https?:\/\//.test(url) ? { website: url } : {}),
      ...(item.note ? { notes: item.note } : {}),
    });
    return { label: "Places", href: id ? `#/places/${id}` : null, filed: true, undo: undoFor(change), done: change ? `Saved ${itemName(item)} to Places` : done, target: id ? { kind: "place", id } : null };
  },
});

registerSavedAction({
  ...BUILTIN.make_todo,
  async run(item, params) {
    const title = (typeof params.title === "string" && params.title.trim()) || todoTitle(item);
    const { change, id, done } = await viaAsk("add_todo", { title: title.slice(0, 200), kind: "todo" });
    return { label: "To-dos", href: "#/loops", filed: true, undo: undoFor(change), done: change ? `Added “${title}” to your to-dos` : done, target: id ? { kind: "commitment", id } : null };
  },
});

type Target = "person" | "note" | "project";

async function targetTitle(kind: Target, id: string): Promise<string | null> {
  if (kind === "note") return (await getNote(id))?.title || null;
  if (kind === "person") return (await getPerson(id))?.name ?? null;
  const r = (await getRecord("project", id)) as { name?: string; archived_at?: unknown } | null;
  return r && !r.archived_at ? (r.name ?? null) : null;
}

const HREF: Record<Target, (id: string) => string | null> = { person: (id) => `#/people/${id}`, note: (id) => `#/notes/${id}`, project: () => null };

registerSavedAction({
  ...BUILTIN.link,
  async run(item, params) {
    // { target: { kind, id } }, or kind and id given flat.
    const t = (params.target && typeof params.target === "object" ? params.target : params) as { kind?: unknown; id?: unknown };
    const kind = z.enum(["person", "note", "project"]).safeParse(t.kind);
    const id = UUID.safeParse(t.id);
    if (!kind.success || !id.success) throw new SavedActionError("link needs target: { kind: person, note or project, id }.");
    const title = await targetTitle(kind.data, id.data);
    if (!title) throw new SavedActionError(`No ${kind.data} with that id (it may be archived).`);
    const [made] = await qRaw<{ id: string }>(
      `INSERT INTO edges (source_type, source_id, target_type, target_id, relation, origin) VALUES ('saved', $1, $2, $3, 'relates_to', 'manual')
       ON CONFLICT (source_type, source_id, target_type, target_id, relation) DO NOTHING RETURNING id`,
      [item.id, kind.data, id.data],
    );
    return {
      label: title,
      href: HREF[kind.data](id.data),
      filed: false,
      undo: made ? { op: "unlink", saved_id: item.id, target_type: kind.data, target_id: id.data } : null,
      done: made ? `Linked to ${title}` : `Already linked to ${title}`,
      target: { kind: kind.data, id: id.data },
    };
  },
});

// Recipes' own action (lib/recipe-actions.ts), registered here so wherever actions are used it's there.
import { MOVE_TO_RECIPES } from "./recipe-actions";
registerSavedAction(MOVE_TO_RECIPES);
