/**
 * Folders for notes: the rules, shared by the server (lib/note-folders.ts)
 * and the app (app/src/db/folders.ts), so both say the same thing.
 *
 *  - A note is in one folder or none. Tags are for anything that cuts across.
 *  - A folder can hold folders, three deep at most: Work › Clients › Acme.
 *  - Names are 1 to 60 characters, and two folders in the same place can't
 *    share one (ignoring case).
 *  - Folders sort by name, numbers in order ("Week 2" before "Week 10").
 *  - Deleting a folder moves what it held, notes and folders, up a level.
 *
 * Pure, no imports.
 */

export interface NoteFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A folder and two levels inside it. */
export const MAX_FOLDER_DEPTH = 3;
export const MAX_FOLDERS = 300;
export const MAX_FOLDER_NAME = 60;

export function cleanFolderName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Give the folder a name" };
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Give the folder a name" };
  if (name.length > MAX_FOLDER_NAME) return { error: `A folder's name can be ${MAX_FOLDER_NAME} characters at most` };
  // A path is written with " › " or "/", so a name can't hold either.
  if (/[/›]/.test(name)) return { error: "A folder's name can't have / or › in it" };
  return { name };
}

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
export const byFolderName = (a: Pick<NoteFolder, "name">, b: Pick<NoteFolder, "name">): number => collator.compare(a.name, b.name);

/** The folders directly inside `parent` (null: at the top), by name. */
export function childFolders(folders: NoteFolder[], parent: string | null): NoteFolder[] {
  return folders.filter((f) => f.parent_id === parent).sort(byFolderName);
}

/** The folder and the ones it's inside, outermost first. Stops at a loop or a missing parent. */
export function folderTrail(folders: NoteFolder[], id: string | null | undefined): NoteFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: NoteFolder[] = [];
  let at = id ? byId.get(id) : undefined;
  while (at && !trail.includes(at) && trail.length <= MAX_FOLDER_DEPTH + 1) {
    trail.unshift(at);
    at = at.parent_id ? byId.get(at.parent_id) : undefined;
  }
  return trail;
}

/** "Work › Clients › Acme". */
export const folderPath = (folders: NoteFolder[], id: string | null | undefined): string =>
  folderTrail(folders, id)
    .map((f) => f.name)
    .join(" › ");

/** How deep a folder sits: 1 at the top. */
export const folderDepth = (folders: NoteFolder[], id: string): number => folderTrail(folders, id).length;

/** Every folder inside this one, at any depth. */
export function descendants(folders: NoteFolder[], id: string): NoteFolder[] {
  const out: NoteFolder[] = [];
  const walk = (parent: string) => {
    for (const f of folders) {
      if (f.parent_id === parent && !out.includes(f)) {
        out.push(f);
        walk(f.id);
      }
    }
  };
  walk(id);
  return out;
}

/** How many levels a folder and what's inside it take up: 1 for a folder holding no folders. */
export function folderHeight(folders: NoteFolder[], id: string): number {
  const kids = folders.filter((f) => f.parent_id === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => folderHeight(folders, k.id))) : 0);
}

/** Why a folder can't go inside `parent` (null: to the top), or null when it can. */
export function moveFolderProblem(folders: NoteFolder[], id: string, parent: string | null): string | null {
  if (parent === id) return "A folder can't go inside itself";
  if (parent && !folders.some((f) => f.id === parent)) return "That folder isn't there any more";
  if (parent && descendants(folders, id).some((f) => f.id === parent)) return "A folder can't go inside one of its own folders";
  const depth = (parent ? folderDepth(folders, parent) : 0) + folderHeight(folders, id);
  if (depth > MAX_FOLDER_DEPTH) return `Folders go ${MAX_FOLDER_DEPTH} deep at most`;
  return null;
}

/** Why a new folder can't be made inside `parent`, or null. */
export function newFolderProblem(folders: NoteFolder[], parent: string | null): string | null {
  if (folders.length >= MAX_FOLDERS) return `That's ${MAX_FOLDERS} folders already`;
  if (parent && !folders.some((f) => f.id === parent)) return "That folder isn't there any more";
  if (parent && folderDepth(folders, parent) >= MAX_FOLDER_DEPTH) return `Folders go ${MAX_FOLDER_DEPTH} deep at most`;
  return null;
}

/** Another folder in the same place already has this name (ignoring case). */
export function nameTaken(folders: NoteFolder[], name: string, parent: string | null, exceptId?: string): NoteFolder | null {
  return folders.find((f) => f.parent_id === parent && f.id !== exceptId && collator.compare(f.name, name) === 0) ?? null;
}

/**
 * A folder by what someone called it: its name ("Recipes") when only one has
 * it, or its path ("Work/Clients", "Work › Clients"). Null when nothing, or
 * more than one, fits.
 */
export function findFolder(folders: NoteFolder[], said: string): NoteFolder | null {
  const parts = said
    .split(/\s*(?:\/|›|>)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const same = (f: NoteFolder, name: string) => collator.compare(f.name, name) === 0;
  if (parts.length === 1) {
    const hits = folders.filter((f) => same(f, parts[0]));
    return hits.length === 1 ? hits[0] : null;
  }
  let parent: string | null = null;
  let found: NoteFolder | null = null;
  for (const part of parts) {
    found = folders.find((f) => f.parent_id === parent && same(f, part)) ?? null;
    if (!found) return null;
    parent = found.id;
  }
  return found;
}

/** Every folder as a list in tree order (each parent, then what's inside it), with its depth: for pickers. */
export function folderTree(folders: NoteFolder[]): Array<{ folder: NoteFolder; depth: number }> {
  const out: Array<{ folder: NoteFolder; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    if (depth > MAX_FOLDER_DEPTH) return;
    for (const f of childFolders(folders, parent)) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  return out;
}

/** Where things go when a folder is deleted: its own parent. */
export const parentOnDelete = (folders: NoteFolder[], id: string): string | null => folders.find((f) => f.id === id)?.parent_id ?? null;
