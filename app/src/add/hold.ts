/**
 * Files on their way to `#/add`, held in memory: a drop on the Team page, a pick from Skills, or a file shared to
 * the installed app (sw.js keeps that one in Cache Storage until the Add screen takes it). An address can't carry
 * files, so whoever has them holds them here and opens `#/add`.
 */
import type { IntakeEntry } from "../../../lib/skills";

let held: File[] | null = null;

/** Hold these for the Add screen, then go there. */
export function openAddWithFiles(files: File[]): void {
  held = files.length ? files : null;
  location.hash = "#/add";
}

/** The files held for the Add screen, once. */
export function takeHeldFiles(): File[] | null {
  const f = held;
  held = null;
  return f;
}

/** A shared item the installed app was sent (sw.js, "/share-target/assistant"), once. Null when there's none. */
export async function takeSharedFile(): Promise<File | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open("athena-share");
    const res = await cache.match("/share-target/assistant");
    if (!res) return null;
    const name = decodeURIComponent(res.headers.get("X-File-Name") ?? "") || "shared.zip";
    const blob = await res.blob();
    await cache.delete("/share-target/assistant");
    return new File([blob], name, { type: blob.type });
  } catch {
    return null;
  }
}

/** A file's path in its folder (a folder pick or drop), else its name. */
const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || (f as File & { athenaPath?: string }).athenaPath || f.name;

/** Picked or dropped files as entries, with their paths. */
export async function entriesOf(files: readonly File[]): Promise<{ entries: IntakeEntry[]; name: string }> {
  const entries = await Promise.all(files.map(async (f) => ({ path: pathOf(f), bytes: new Uint8Array(await f.arrayBuffer()) })));
  const first = entries[0]?.path ?? "";
  return { entries, name: first.includes("/") ? first.split("/")[0] : first };
}

/**
 * What was dropped: files, and every file inside a dropped folder with its path ("plant-care/flow.json"). Folders
 * are read with the browser's entry API where it has one; otherwise only the files come.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  const roots = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
  if (!roots.some((r) => r?.isDirectory)) return [...dt.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (out.length >= 500 || depth > 6) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, "athenaPath", { value: entry.fullPath.replace(/^\//, "") });
      out.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, depth + 1);
    }
  };
  for (const r of roots) if (r) await walk(r, 0);
  return out;
}
