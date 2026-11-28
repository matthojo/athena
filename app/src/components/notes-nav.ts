/**
 * The Notes navigator: All notes, folders as a tree, then tags and Untagged,
 * each row with how many notes it holds. On a wide desk it's a column of its
 * own at the left of Notes; on a narrower one and on a phone it sits at the
 * top of the list.
 *
 *   Folders   a tree three deep. A chevron opens a folder's folders in place;
 *             the name opens the folder in Notes. A count reads "own · all":
 *             the notes in the folder itself, then with every folder inside
 *             it ("· 12" when it holds none of its own). On a desk a note's
 *             row drops onto a folder, and right-click opens its menu.
 *   Tags      the tags on your notes, nested on "/" (ai/openai sits under ai),
 *             then Untagged.
 *
 * Which folders are open, and which sections are folded, is kept on this
 * device. The folder or tag on show is marked, and the folders above it open.
 *
 * Built with h() and text nodes: folder names and tags are the owner's words.
 */

import "../styles/notes-nav.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { acceptNotes, folderMenu, newFolder } from "./folders-ui";
import { foldersSnapshot, onFoldersChange } from "../db/folders";
import { notesSnapshot, onNotes } from "../db/data";
import { childFolders, folderTrail, newFolderProblem, type NoteFolder } from "../../../lib/note-folder-rules";
import { folderCounts, tagParts, tagTree, type TagNode } from "../lib/note-tree";

/** What Notes is showing: a folder, a tag, the notes with no tag, or everything (null). */
export type NotesScope = { folder: string } | { tag: string } | { untagged: true } | null;

export interface NotesNav {
  el: HTMLElement;
  /** Mark what Notes is showing (null: All notes, or another page). */
  setCurrent: (scope: NotesScope) => void;
  destroy: () => void;
}

export interface NotesNavOptions {
  /** Open a folder, a tag or Untagged in Notes (null: All notes). */
  open: (scope: NotesScope) => void;
  /** "column" at the left of Notes on a wide desk; "list" at the top of the list elsewhere. */
  variant: "column" | "list";
  /** On a phone inside a folder: only the folders inside this one, and no tags. */
  root?: string | null;
}

const OPEN_KEY = "athena.notesNav.open";
const FOLD_KEY = "athena.notesNav.folded";

function readSet(key: string, fallback: string[] = []): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : fallback;
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : fallback);
  } catch {
    return new Set(fallback);
  }
}

function writeSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // private window: kept until reload
  }
}

const sameScope = (a: NotesScope, b: NotesScope) => JSON.stringify(a) === JSON.stringify(b);

export function notesNavigator(opts: NotesNavOptions): NotesNav {
  const root = opts.root ?? null;
  const withTags = root === null;
  // Folders opened by hand (folder ids, "tag:" paths); sections folded by hand. Tags start folded.
  const opened = readSet(OPEN_KEY);
  const folded = readSet(FOLD_KEY, ["tags"]);
  let current: NotesScope = null;
  const desk = opts.variant === "column";

  // ---------- A section: its head folds it ----------

  function section(id: "folders" | "tags", label: string, extra: HTMLElement | null) {
    const bodyId = `notes-nav-${opts.variant}-${id}`;
    const chevron = icons.chevronRight();
    chevron.setAttribute("class", "side-group__chev");
    chevron.setAttribute("aria-hidden", "true");
    const count = h("span", { class: "side-group__count", "aria-hidden": "true" });
    const toggle = h(
      "button",
      { class: "side-group__head notes-nav__head", type: "button", "aria-controls": bodyId },
      h("span", { class: "side-group__label" }, label),
      count,
      chevron
    );
    const inner = h("div", { class: "side-group__inner notes-nav__inner", role: "tree", "aria-label": label });
    const body = h("div", { class: "side-group__body", id: bodyId }, inner);
    const el = h("section", { class: `side-group notes-nav__section notes-nav__section--${id}`, "data-group": `notes-${id}` }, h("div", { class: "notes-nav__bar" }, toggle, extra), body);
    const setOpen = (open: boolean, remember = false) => {
      el.dataset.open = String(open);
      toggle.setAttribute("aria-expanded", String(open));
      body.inert = !open;
      if (remember) {
        if (open) folded.delete(id);
        else folded.add(id);
        writeSet(FOLD_KEY, folded);
      }
    };
    toggle.addEventListener("click", () => setOpen(el.dataset.open === "false", true));
    setOpen(!folded.has(id));
    return { el, inner, count, setOpen };
  }

  const addFolder = h("button", { class: "notes-nav__add", type: "button", "aria-label": "New folder", title: "New folder" }, icons.plus());
  addFolder.addEventListener("click", () => newFolder(root, (f) => opts.open({ folder: f.id })));
  const folders = section("folders", "Folders", addFolder);
  const tags = withTags ? section("tags", "Tags", null) : null;
  // The column starts with All notes, as a vault's own row does: every note, whatever folder or tag.
  const allNotes = desk ? (h("button", { class: "notes-nav__row notes-nav__all-notes", type: "button" }, icons.notes(), h("span", { class: "notes-nav__name" }, "All notes"), h("span", { class: "notes-nav__count" })) as HTMLButtonElement) : null;
  allNotes?.addEventListener("click", () => opts.open(null));
  const el = h("nav", { class: `notes-nav notes-nav--${opts.variant}`, "aria-label": "Folders and tags" }, allNotes, folders.el, tags?.el ?? null);

  // ---------- Rows ----------

  /** One row: a chevron when it holds more (or the room for one), then the name and its count. */
  function row(o: {
    key: string;
    depth: number;
    icon: SVGElement;
    label: string;
    count: HTMLElement | null;
    scope: Exclude<NotesScope, null>;
    kids: HTMLElement[] | null;
    folder?: NoteFolder;
  }): HTMLElement {
    const isOpen = !!o.kids && opened.has(o.key);
    const twisty = o.kids
      ? (h("button", { class: "notes-nav__twisty", type: "button", "aria-expanded": String(isOpen), "aria-label": `${isOpen ? "Hide" : "Show"} what's in ${o.label}`, tabindex: "-1" }, icons.chevronRight()) as HTMLButtonElement)
      : h("span", { class: "notes-nav__twisty notes-nav__twisty--none", "aria-hidden": "true" });
    const name = h(
      "button",
      { class: "notes-nav__row", type: "button", role: "treeitem", "aria-level": String(o.depth + 1), "aria-expanded": o.kids ? String(isOpen) : undefined, "aria-current": sameScope(current, o.scope) ? "true" : undefined },
      o.icon,
      h("span", { class: "notes-nav__name" }, o.label),
      o.count
    ) as HTMLButtonElement;
    const line = h("div", { class: "notes-nav__line", style: `--depth:${o.depth}` }, twisty, name);
    const group = o.kids ? h("div", { class: "notes-nav__kids", role: "group", hidden: !isOpen }, ...o.kids) : null;
    const toggle = () => {
      if (!o.kids) return;
      const now = !opened.has(o.key);
      if (now) opened.add(o.key);
      else opened.delete(o.key);
      writeSet(OPEN_KEY, opened);
      paint();
    };
    if (twisty instanceof HTMLButtonElement) twisty.addEventListener("click", toggle);
    name.addEventListener("click", () => opts.open(o.scope));
    // Keys on a row: Right opens what it holds, Left folds it.
    name.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" && o.kids && !opened.has(o.key)) toggle();
      else if (e.key === "ArrowLeft" && o.kids && opened.has(o.key)) toggle();
      else return;
      e.preventDefault();
      requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-key="${CSS.escape(o.key)}"] .notes-nav__row`)?.focus());
    });
    if (o.folder) {
      const f = o.folder;
      if (desk) acceptNotes(line, () => f.id);
      // A folder's menu, where a right-click or a long press asks for it.
      name.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        folderMenu(name, f, { opened: (id) => opts.open(id ? { folder: id } : null) });
      });
    }
    return h("div", { class: "notes-nav__item", "data-key": o.key }, line, group);
  }

  /** "2 · 14": its own notes, then with every folder inside it. One number when they're the same; none at nought. */
  function countFor(own: number, total: number): HTMLElement | null {
    if (!total) return null;
    if (total === own) return h("span", { class: "notes-nav__count" }, String(own));
    return h("span", { class: "notes-nav__count", "aria-label": `${own} here, ${total} in all` }, own ? String(own) : "", h("span", { class: "notes-nav__all" }, `${own ? " · " : "· "}${total}`));
  }

  function folderRows(all: NoteFolder[], parent: string | null, depth: number, counts: ReturnType<typeof folderCounts>): HTMLElement[] {
    return childFolders(all, parent).map((f) => {
      const kids = childFolders(all, f.id).length ? folderRows(all, f.id, depth + 1, counts) : null;
      const c = counts.get(f.id) ?? { own: 0, total: 0 };
      return row({ key: f.id, depth, icon: icons.folder(), label: f.name, count: countFor(c.own, c.total), scope: { folder: f.id }, kids, folder: f });
    });
  }

  function tagRows(list: TagNode[], depth: number): HTMLElement[] {
    return list.map((t) =>
      row({
        key: `tag:${t.path.toLowerCase()}`,
        depth,
        icon: icons.tag(),
        label: t.name,
        count: h("span", { class: "notes-nav__count" }, String(t.count)),
        scope: { tag: t.path },
        kids: t.children.length ? tagRows(t.children, depth + 1) : null,
      })
    );
  }

  // ---------- Painting ----------

  function paint() {
    const all = foldersSnapshot();
    const notes = notesSnapshot().notes;
    const counts = folderCounts(all, notes);
    // The folders above what's on show open, so it's never hidden.
    if (current && "folder" in current) for (const f of folderTrail(all, current.folder).slice(0, -1)) opened.add(f.id);
    if (current && "tag" in current) {
      const parts = tagParts(current.tag);
      for (let i = 1; i < parts.length; i++) opened.add(`tag:${parts.slice(0, i).join("/").toLowerCase()}`);
    }
    if (allNotes) {
      allNotes.lastElementChild!.textContent = String(notes.length);
      allNotes.toggleAttribute("aria-current", current === null);
      if (current === null) allNotes.setAttribute("aria-current", "true");
    }
    const rows = folderRows(all, root, 0, counts);
    folders.inner.replaceChildren(...(rows.length ? rows : [h("p", { class: "notes-nav__empty" }, root ? "No folders in here." : "Keep notes together in folders. Make one with +.")]));
    folders.count.textContent = rows.length ? String(childFolders(all, root).length) : "";
    addFolder.hidden = !!newFolderProblem(all, root);
    if (tags) {
      const tree = tagTree(notes);
      const untagged = notes.filter((n) => !n.tags.length).length;
      tags.inner.replaceChildren(
        ...tagRows(tree, 0),
        row({ key: "untagged", depth: 0, icon: icons.tag(), label: "Untagged", count: untagged ? h("span", { class: "notes-nav__count" }, String(untagged)) : null, scope: { untagged: true }, kids: null })
      );
      tags.inner.lastElementChild?.classList.add("notes-nav__item--untagged");
      tags.count.textContent = tree.length ? String(tree.length) : "";
    }
  }

  const offNotes = onNotes(() => paint());
  const offFolders = onFoldersChange(paint);
  paint();

  return {
    el,
    setCurrent(scope) {
      if (sameScope(scope, current)) return;
      current = scope;
      // Arriving on a tag opens Tags.
      if (scope && ("tag" in scope || "untagged" in scope)) tags?.setOpen(true);
      paint();
    },
    destroy() {
      offNotes();
      offFolders();
    },
  };
}
