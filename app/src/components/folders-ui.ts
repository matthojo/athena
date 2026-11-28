/**
 * Folders in the app (db/folders.ts holds them; lib/note-folder-rules.ts the
 * rules): a folder's row in the Notes list, the sheet that names a folder,
 * Move to (for a note or a folder), and a folder's menu.
 *
 * On a desk a note's row can be dragged onto a folder's row, or onto the
 * trail above the list, to move it there.
 *
 * Built with h() and text nodes only: folder names are the owner's words.
 */

import "../styles/folders.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { afterSheetClosed, openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmChoice } from "./confirm";
import { openContextMenu } from "./context-menu";
import {
  FolderError,
  createFolder,
  deleteFolder,
  fileNotes,
  folderById,
  foldersSnapshot,
  moveFolder,
  notesIn,
  pathOf,
  renameFolder,
  type NoteFolder,
} from "../db/folders";
import { childFolders, descendants, folderTree, moveFolderProblem, newFolderProblem, MAX_FOLDER_NAME, MAX_FOLDER_DEPTH } from "../../../lib/note-folder-rules";
import { notesSnapshot } from "../db/data";

/** What a dragged note row carries. */
export const NOTE_DRAG_TYPE = "application/x-athena-note";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Accept dragged notes on `el`, moving them into `folder` (null: out of any). */
export function acceptNotes(el: HTMLElement, folder: () => string | null): void {
  let depth = 0;
  el.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes(NOTE_DRAG_TYPE)) return;
    e.preventDefault();
    depth++;
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(NOTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove("is-drop-target");
  });
  el.addEventListener("drop", (e) => {
    const id = e.dataTransfer?.getData(NOTE_DRAG_TYPE);
    depth = 0;
    el.classList.remove("is-drop-target");
    if (!id) return;
    e.preventDefault();
    void moveNotesWithUndo([id], folder());
  });
}

/** Move notes, and say where with an Undo. */
export async function moveNotesWithUndo(ids: string[], to: string | null): Promise<void> {
  const before = new Map(notesSnapshot().notes.filter((n) => ids.includes(n.id)).map((n) => [n.id, n.folder_id ?? null]));
  const moving = ids.filter((id) => (before.get(id) ?? null) !== to);
  if (!moving.length) return;
  await fileNotes(moving, to);
  const where = to ? pathOf(to) : "";
  showToast(to ? `Moved to ${where}` : "Moved out of its folder", {
    icon: "folder",
    action: {
      label: "Undo",
      run: () => {
        for (const id of moving) void fileNotes([id], before.get(id) ?? null);
      },
    },
  });
}

// ---------- A folder's row in the Notes list ----------

export function folderRow(f: NoteFolder, opts: { onOpen: (f: NoteFolder) => void; desktop: boolean }): HTMLButtonElement {
  const n = notesIn(f.id);
  const inside = childFolders(foldersSnapshot(), f.id).length;
  const row = h(
    "button",
    { class: "row row--compact folder-row", type: "button", "data-folder": f.id, "aria-label": `${f.name}, ${plural(n, "note")}${inside ? `, ${plural(inside, "folder")} inside` : ""}` },
    h("span", { class: "tile tile--sm folder-row__tile" }, icons.folder()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.name)),
    h("span", { class: "folder-row__end", "aria-hidden": "true" }, h("span", { class: "folder-row__count" }, String(n)), h("span", { class: "folder-row__chevron" }, icons.chevronRight()))
  ) as HTMLButtonElement;
  row.addEventListener("click", () => opts.onOpen(f));
  if (opts.desktop) acceptNotes(row, () => f.id);
  return row;
}

// ---------- Naming a folder ----------

/**
 * A small sheet with one field: a new folder's name, or a new name for one.
 * `save` resolves when it's done, or throws a FolderError whose words show
 * under the field. What it resolves to, if a function, runs once the sheet
 * has closed and handed back its history entry (so it can change the address).
 */
export function openFolderName(opts: { title: string; sub?: string; value?: string; cta: string; save: (name: string) => Promise<unknown> }): void {
  const input = h("input", { class: "field folder-name__input", type: "text", value: opts.value ?? "", maxlength: MAX_FOLDER_NAME, placeholder: "Folder name", "aria-label": "Folder name", autocomplete: "off", enterkeyhint: "done" }) as HTMLInputElement;
  const error = h("p", { class: "folder-name__error", role: "alert", hidden: true });
  const cancel = h("button", { class: "btn btn--soft", type: "button" }, "Cancel");
  const go = h("button", { class: "btn btn--primary", type: "button" }, opts.cta) as HTMLButtonElement;
  const body = h(
    "form",
    { class: "folder-name" },
    opts.sub ? h("p", { class: "folder-name__sub" }, opts.sub) : null,
    input,
    error,
    h("div", { class: "folder-name__actions" }, cancel, go)
  ) as HTMLFormElement;
  const sheet = openSheet({ label: opts.title, title: opts.title, body });
  const paint = () => (go.disabled = !input.value.trim());
  paint();
  input.addEventListener("input", () => {
    error.hidden = true;
    paint();
  });
  cancel.addEventListener("click", () => sheet.close());
  body.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    go.disabled = true;
    try {
      const after = await opts.save(input.value);
      sheet.close();
      if (typeof after === "function") void afterSheetClosed().then(() => (after as () => void)());
    } catch (err) {
      error.textContent = err instanceof FolderError ? err.message : "Couldn't save that. Try again.";
      error.hidden = false;
      go.disabled = false;
    }
  });
  go.addEventListener("click", () => body.requestSubmit());
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/** "New folder", inside `parent` (null: at the top). Resolves to the folder, or null. */
export function newFolder(parent: string | null, then?: (f: NoteFolder) => void): void {
  const problem = newFolderProblem(foldersSnapshot(), parent);
  if (problem) return void showToast(problem, { icon: "folder" });
  openFolderName({
    title: "New folder",
    sub: parent ? `Inside ${pathOf(parent)}` : undefined,
    cta: "Make folder",
    save: async (name) => {
      const f = await createFolder(name, parent);
      // Opening it changes the address: so after the sheet has closed.
      return () => then?.(f);
    },
  });
}

// ---------- Move to ----------

interface MoveToOptions {
  title: string;
  /** Where it is now: marked, and picking it does nothing. */
  current: string | null;
  /** Moving a folder: the folder, so it and what's inside it can't be picked, and too-deep places say why. */
  folder?: string;
  /** "No folder" (notes) or "At the top" (folders). */
  noneLabel: string;
  pick: (to: string | null) => void | Promise<void>;
}

export function openMoveTo(opts: MoveToOptions): void {
  const list = h("div", { class: "card card--flush list move-to__list", role: "listbox", "aria-label": opts.title });
  const sheet = openSheet({ label: opts.title, title: opts.title, body: h("div", { class: "move-to" }, list) });

  function option(to: string | null, label: string, depth: number, why: string | null) {
    const current = to === opts.current;
    const row = h(
      "button",
      {
        class: `row row--compact move-to__row${why ? " is-unavailable" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": String(current),
        "aria-disabled": why ? "true" : undefined,
        style: `--depth:${depth}`,
      },
      h("span", { class: "move-to__icon" }, to ? icons.folder() : icons.notes()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, label), why ? h("span", { class: "row__meta" }, why) : null),
      current ? h("span", { class: "move-to__check", "aria-label": "Here now" }, icons.check()) : null
    ) as HTMLButtonElement;
    row.addEventListener("click", async () => {
      if (why) return void showToast(why, { icon: "folder" });
      if (current) return sheet.close();
      sheet.close();
      await opts.pick(to);
    });
    return row;
  }

  function paint() {
    const all = foldersSnapshot();
    const blocked = new Set(opts.folder ? [opts.folder, ...descendants(all, opts.folder).map((f) => f.id)] : []);
    const rows: HTMLElement[] = [option(null, opts.noneLabel, 0, null)];
    for (const { folder, depth } of folderTree(all)) {
      if (blocked.has(folder.id)) continue;
      const why = opts.folder ? moveFolderProblem(all, opts.folder, folder.id) : null;
      rows.push(option(folder.id, folder.name, depth, why));
    }
    const add = h("button", { class: "row row--compact move-to__row move-to__new", type: "button" }, h("span", { class: "move-to__icon" }, icons.plus()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "New folder")));
    // A new folder at the top, then straight there.
    add.addEventListener("click", () => {
      sheet.close();
      newFolder(null, (f) => void opts.pick(f.id));
    });
    list.replaceChildren(...rows, add);
  }
  paint();
}

/** Move to… for a note. */
export function moveNoteTo(noteId: string, current: string | null): void {
  openMoveTo({
    title: "Move to",
    current,
    noneLabel: "No folder",
    pick: (to) => moveNotesWithUndo([noteId], to),
  });
}

// ---------- A folder's menu ----------

export function folderMenu(anchor: HTMLElement, f: NoteFolder, ctx: { opened: (id: string | null) => void }): void {
  const all = foldersSnapshot();
  const canNest = !newFolderProblem(all, f.id);
  openContextMenu(
    {
      label: f.name,
      groups: [
        [
          {
            id: "new",
            label: "New folder inside",
            icon: "plus",
            disabled: !canNest,
            hint: canNest ? undefined : `Folders go ${MAX_FOLDER_DEPTH} deep at most`,
            run: () => newFolder(f.id),
          },
          {
            id: "rename",
            label: "Rename",
            icon: "pen",
            run: () =>
              openFolderName({ title: "Rename folder", value: f.name, cta: "Rename", save: (name) => renameFolder(f.id, name) }),
          },
          {
            id: "move",
            label: "Move to…",
            icon: "folder",
            run: () =>
              openMoveTo({
                title: `Move “${f.name}”`,
                current: f.parent_id,
                folder: f.id,
                noneLabel: "At the top",
                pick: async (to) => {
                  try {
                    await moveFolder(f.id, to);
                    showToast(to ? `Moved to ${pathOf(to)}` : "Moved to the top", { icon: "folder" });
                  } catch (err) {
                    showToast(err instanceof FolderError ? err.message : "Couldn't move it. Try again.", { icon: "close" });
                  }
                },
              }),
          },
        ],
        [{ id: "delete", label: "Delete folder", icon: "trash", destructive: true, run: () => void removeFolder(f, ctx) }],
      ],
    },
    { anchor, by: "mouse" }
  );
}

async function removeFolder(f: NoteFolder, ctx: { opened: (id: string | null) => void }) {
  const notes = notesSnapshot().notes.filter((n) => n.folder_id === f.id).length;
  const kids = childFolders(foldersSnapshot(), f.id).length;
  const to = f.parent_id ? (folderById(f.parent_id)?.name ?? "the folder it's in") : null;
  // Where each kind goes: notes into the parent (or out of any folder), folders into the parent (or to the top).
  const parts: string[] = [];
  if (to) {
    const held = [notes ? plural(notes, "note") : "", kids ? plural(kids, "folder") : ""].filter(Boolean).join(" and ");
    if (held) parts.push(`Its ${held} ${notes + kids === 1 ? "moves" : "move"} to ${to}.`);
  } else {
    if (notes) parts.push(`Its ${plural(notes, "note")} ${notes === 1 ? "moves" : "move"} out of any folder.`);
    if (kids) parts.push(`Its ${plural(kids, "folder")} ${kids === 1 ? "moves" : "move"} to the top.`);
  }
  const body = parts.length ? `${parts.join(" ")} Nothing in it is deleted.` : "It's empty, so nothing moves.";
  const ok = await confirmChoice({ title: `Delete “${f.name}”?`, body, confirmLabel: "Delete folder", danger: true });
  if (!ok) return;
  try {
    const went = await deleteFolder(f.id);
    showToast(`Deleted “${f.name}”`, { icon: "trash" });
    await afterSheetClosed();
    ctx.opened(went);
  } catch (err) {
    showToast(err instanceof FolderError ? err.message : "Couldn't delete it. Try again.", { icon: "close" });
  }
}
