/**
 * The Notes navigator's numbers and its tag tree (components/notes-nav.ts):
 * how many notes a folder holds itself and with what's inside it, and tags
 * as a tree, where "ai/openai" sits under "ai" the way Obsidian nests them.
 *
 * Pure: notes and folders in, plain objects out.
 */

import { descendants, type NoteFolder } from "../../../lib/note-folder-rules";

interface Countable {
  folder_id?: string | null;
  tags: string[];
}

/** A folder's own notes, and its notes with every folder inside it. */
export function folderCounts(folders: NoteFolder[], notes: Countable[]): Map<string, { own: number; total: number }> {
  const own = new Map<string, number>();
  for (const n of notes) if (n.folder_id) own.set(n.folder_id, (own.get(n.folder_id) ?? 0) + 1);
  const out = new Map<string, { own: number; total: number }>();
  for (const f of folders) {
    const total = [f, ...descendants(folders, f.id)].reduce((sum, x) => sum + (own.get(x.id) ?? 0), 0);
    out.set(f.id, { own: own.get(f.id) ?? 0, total });
  }
  return out;
}

export interface TagNode {
  /** The whole tag: "ai/openai". */
  path: string;
  /** Its last part: "openai". */
  name: string;
  /** Notes with this tag or one under it. */
  count: number;
  children: TagNode[];
}

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });

/** "ai/openai" → ["ai", "openai"]; spaces round each part trimmed, empty parts dropped. */
export const tagParts = (tag: string): string[] =>
  tag
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

/** Tags as a tree, by name, each counting the notes with it or a tag under it (a note counts once). */
export function tagTree(notes: Countable[]): TagNode[] {
  const roots: TagNode[] = [];
  const nodes = new Map<string, TagNode>();
  const seen = new Map<string, Set<Countable>>();
  for (const n of notes) {
    for (const tag of n.tags) {
      const parts = tagParts(tag);
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join("/");
        const key = path.toLowerCase();
        let node = nodes.get(key);
        if (!node) {
          node = { path, name: parts[i], count: 0, children: [] };
          nodes.set(key, node);
          if (i === 0) roots.push(node);
          else nodes.get(parts.slice(0, i).join("/").toLowerCase())!.children.push(node);
        }
        const notesHere = seen.get(key) ?? new Set<Countable>();
        if (!notesHere.has(n)) {
          notesHere.add(n);
          node.count++;
        }
        seen.set(key, notesHere);
      }
    }
  }
  const sort = (list: TagNode[]) => {
    list.sort((a, b) => collator.compare(a.name, b.name));
    for (const t of list) sort(t.children);
  };
  sort(roots);
  return roots;
}

/** Whether a note has this tag, or one under it ("ai" matches "ai/openai"). Case doesn't matter. */
export function hasTag(note: Countable, tag: string): boolean {
  const want = tagParts(tag).join("/").toLowerCase();
  return note.tags.some((t) => {
    const have = tagParts(t).join("/").toLowerCase();
    return have === want || have.startsWith(`${want}/`);
  });
}
