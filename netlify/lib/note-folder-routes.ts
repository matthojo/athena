/**
 * Folders for notes over REST (lib/note-folders.ts), mounted by
 * netlify/functions/api.ts behind the same bearer token:
 *
 *   GET    /api/folders          { folders, counts }: every folder, and live notes in each
 *   POST   /api/folders          { name, parent_id? } → folder
 *   PATCH  /api/folders/:id      { name?, parent_id? } → folder (parent_id: move it; null for the top)
 *   DELETE /api/folders/:id      → { moved_to, notes, folders }: what it held moves up a level
 *
 * A note's own folder is set on the note: PATCH /api/notes/:id { folder_id }.
 */
import { AthenaInputError } from "../../lib/db";
import { createFolder, deleteFolder, folderCounts, listFolders, updateFolder } from "../../lib/note-folders";

type Reply = (data: unknown, status?: number) => Response;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Send a JSON object");
}

/** /api/folders*; null for anything else. */
export async function handleNoteFolderRoutes(req: Request, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, id] = segments;
  if (first !== "folders" || segments.length > 3) return null;
  if (!id) {
    if (req.method === "GET") {
      const [folders, counts] = await Promise.all([listFolders(), folderCounts()]);
      return reply({ folders, counts });
    }
    if (req.method === "POST") {
      const b = await body(req);
      return reply(await createFolder({ name: b.name, parent_id: b.parent_id }), 201);
    }
    return reply({ error: "Method not allowed" }, 405);
  }
  if (req.method === "PATCH") {
    const b = await body(req);
    return reply(await updateFolder(id, { name: b.name, ...("parent_id" in b ? { parent_id: b.parent_id } : {}) }));
  }
  if (req.method === "DELETE") return reply(await deleteFolder(id));
  return reply({ error: "Method not allowed" }, 405);
}
