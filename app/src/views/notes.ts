/**
 * Notes: search, filter by source, folders, and read. Mobile is one column
 * with a sticky glass header and notes grouped by day; tapping opens the note
 * in a sheet. Desktop splits into a list column and a reading pane (the
 * BrainJot reference), with arrow-key navigation and the selection kept in
 * the URL.
 *
 * Folders (db/folders.ts, components/folders-ui.ts) sit at the top of the
 * list: the top ones under All notes, and inside a folder the ones it holds,
 * then its notes. A trail above the title ("Notes › Work") goes back up; on a
 * desk a note's row drags onto a folder, or onto the trail, to move it.
 */

import { lifeLogDate } from "../components/day-words";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { highlight, noteParts, noteRow } from "../components/note-row";
import { noteView, openNoteSheet, type NoteView } from "../components/note-detail";
import { openTemplatePicker } from "../components/templates";
import { librarySegments } from "../components/library-nav";
import type { ViewId } from "../components/nav";
import { notesSnapshot, onNotes, searchNotes } from "../db/data";
import { keywords } from "../lib/ask";
import { compactTime, dayBucket, type DayBucket } from "../lib/format";
import { relevant, requestOpen, searchThreads, threadTitle, type ThreadMatch } from "../db/ask-threads";
import { describeSource, sourceText, summarizeSources } from "../lib/sources";
import { resolveId } from "../db/sync";
import type { EntityKind, Note } from "../types";
import { pageHead } from "../components/page-head";
import { acceptNotes, folderMenu, folderRow, newFolder, NOTE_DRAG_TYPE } from "../components/folders-ui";
import { folderById, foldersSnapshot, notesIn, onFoldersChange, pathOf } from "../db/folders";
import { childFolders, folderTrail, newFolderProblem } from "../../../lib/note-folder-rules";

export interface NotesContext {
  source: string | null;
  noteId: string | null;
  /** The folder open in the list (#/notes?folder=…), or null for All notes. */
  folder: string | null;
  focusSearch: boolean;
  isDesktop: () => boolean;
  openNote: (note: Note) => void;
  openLink: (kind: EntityKind, id: string) => void;
  compose: () => void;
  go: (view: ViewId) => void;
  onSelectionChange: (source: string | null, noteId: string | null, folder: string | null) => void;
}

const BUCKETS: DayBucket[] = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

function empty(icon: keyof typeof icons, title: string, sub: string, action?: HTMLElement) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "tile" }, icons[icon]()),
    h("p", { class: "empty__title" }, title),
    h("p", { class: "empty__sub" }, sub),
    action ?? null
  );
}

export function renderNotes(ctx: NotesContext): { el: HTMLElement; destroy: () => void; focusSearch: () => void } {
  let source = ctx.source;
  let selectedId = ctx.noteId;
  let folder = ctx.folder && folderById(ctx.folder) ? ctx.folder : ctx.folder && !foldersSnapshot().length ? ctx.folder : null;
  let query = "";
  let results: Note[] | null = null;
  /** Ask conversations that match the search, from this device. */
  let conversations: ThreadMatch[] = [];
  let all: Note[] = notesSnapshot().notes;

  const count = h("span", { class: "page-count" });
  const input = h("input", {
    type: "search",
    name: "q",
    placeholder: "Search notes",
    autocomplete: "off",
    "aria-label": "Search notes",
    enterkeyhint: "search",
  }) as HTMLInputElement;
  const clear = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Clear search", hidden: true }, icons.close());
  const chips = h("div", { class: "chip-row", role: "toolbar", "aria-label": "Filter by source" });
  // New from template (components/templates.ts): fills from Athena and opens the note.
  const fromTemplate = h("button", { class: "btn btn--soft btn--sm notes__template", type: "button" }, icons.copy(), "From template");
  fromTemplate.addEventListener("click", () =>
    openTemplatePicker({ openLink: ctx.openLink, openFilled: (n) => openNoteSheet(null, { openLink: ctx.openLink, seed: n.body, seedTitle: n.title, keepSeed: true, folder }) })
  );
  // At All notes: a new folder at the top. Inside one: a new note here, and the folder's own menu.
  const addFolder = h("button", { class: "icon-btn icon-btn--sm notes__new-folder", type: "button", "aria-label": "New folder", title: "New folder" }, icons.folderPlus());
  addFolder.addEventListener("click", () => newFolder(null, (f) => openFolder(f.id)));
  const noteHere = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Note");
  noteHere.addEventListener("click", () => openNoteSheet(null, { openLink: ctx.openLink, folder }));
  const folderMore = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Folder actions", "aria-haspopup": "menu" }, icons.more());
  folderMore.addEventListener("click", () => {
    const f = folderById(folder);
    if (f) folderMenu(folderMore, f, { opened: (id) => openFolder(id) });
  });
  const title = h("h1", { class: "page-title" }, "Notes") as HTMLHeadingElement;
  // Inside a folder on a phone: back to where it is.
  const up = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost notes__up", type: "button", "aria-label": "Back" }, icons.back());
  up.addEventListener("click", () => openFolder(folderById(folder)?.parent_id ?? null));
  const trail = h("nav", { class: "folder-trail", "aria-label": "Folders", hidden: true });
  const head = pageHead({
    segments: h("div", { class: "notes__top" }, librarySegments("notes", ctx.go), trail),
    title,
    lead: up,
    count,
    actions: [noteHere, fromTemplate, addFolder, folderMore],
    below: [h("label", { class: "search" }, icons.search(), input, clear, h("kbd", {}, "⌘K")), chips],
  });

  /** The title, the trail and the actions for where the list is. */
  function paintHead() {
    const f = folderById(folder);
    title.textContent = f ? f.name : "Notes";
    head.classList.toggle("is-in-folder", !!f);
    up.hidden = !f;
    noteHere.hidden = folderMore.hidden = !f;
    fromTemplate.hidden = !!f;
    // The first folder is made from here; once there are some, "New folder" sits above them.
    addFolder.hidden = !!f || foldersSnapshot().length > 0;
    chips.hidden = !!f;
    if (!f) return void (trail.hidden = true);
    const crumb = (label: string, to: string | null) => {
      const b = h("button", { class: "folder-trail__step", type: "button" }, label);
      b.addEventListener("click", () => openFolder(to));
      // On a desk, a note dropped here moves up to that level.
      if (ctx.isDesktop()) acceptNotes(b, () => to);
      return b;
    };
    const steps = folderTrail(foldersSnapshot(), f.id).slice(0, -1);
    trail.replaceChildren(
      crumb("Notes", null),
      ...steps.flatMap((s) => [h("span", { class: "folder-trail__sep", "aria-hidden": "true" }, icons.chevronRight()), crumb(s.name, s.id)]),
      h("span", { class: "folder-trail__sep", "aria-hidden": "true" }, icons.chevronRight())
    );
    trail.hidden = false;
  }

  /** Open a folder in the list (null: All notes). */
  function openFolder(id: string | null) {
    folder = id && folderById(id) ? id : null;
    // On a desk the pane follows: a note from elsewhere gives way to this folder's first.
    if (folder && selectedId && all.find((n) => n.id === selectedId)?.folder_id !== folder) selectedId = null;
    if (query) {
      input.value = "";
      query = "";
      results = null;
      clear.hidden = true;
    }
    ctx.onSelectionChange(source, selectedId, folder);
    paintHead();
    paintList();
    (ctx.isDesktop() ? col : document.scrollingElement)?.scrollTo({ top: 0 });
  }
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane", "aria-label": "Note" });
  const el = h("div", { class: "view notes" }, col, pane);

  /** The notes the list shows: a folder's own, or all of them by source. A search looks in every folder. */
  const visible = (notes: Note[], searching = false) => {
    if (folder && !searching) return notes.filter((n) => n.folder_id === folder);
    return source === null || folder ? notes : notes.filter((n) => (n.source ?? "") === source);
  };
  /** A note's row, saying which folder it's in where that isn't plain from the list, and draggable onto a folder on a desk. */
  const row = (n: Note, terms?: string[]) => {
    const r = noteRow(n, { onOpen: open, terms, current: n.id === selectedId, folder: n.folder_id && (n.folder_id !== folder || terms?.length) ? pathOf(n.folder_id) : undefined });
    if (ctx.isDesktop()) {
      r.draggable = true;
      r.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData(NOTE_DRAG_TYPE, n.id);
        e.dataTransfer?.setData("text/plain", noteParts(n).title);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        el.classList.add("is-dragging-note");
      });
      r.addEventListener("dragend", () => el.classList.remove("is-dragging-note"));
    }
    return r;
  };
  /** The folders at this level, as a group at the top of the list. */
  function foldersGroup(): HTMLElement | null {
    const here = childFolders(foldersSnapshot(), folder);
    if (!here.length) return null;
    const add = h("button", { class: "group__action", type: "button" }, icons.plus(), "New folder");
    add.addEventListener("click", () => newFolder(folder, (f) => openFolder(f.id)));
    const canAdd = !newFolderProblem(foldersSnapshot(), folder);
    return h(
      "section",
      { class: "group notes__folders", "aria-label": "Folders" },
      h("div", { class: "group__head" }, h("h2", { class: "group__label" }, "Folders"), canAdd ? add : null),
      h("div", { class: "card card--flush list" }, ...here.map((f) => folderRow(f, { onOpen: (x) => openFolder(x.id), desktop: ctx.isDesktop() })))
    );
  }

  function paintChips() {
    const summary = summarizeSources(all);
    const chip = (key: string | null, label: string, n: number) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(source === key) }, label, h("span", { class: "chip__count" }, String(n)));
      b.addEventListener("click", () => {
        source = source === key ? null : key;
        ctx.onSelectionChange(source, selectedId, folder);
        paintChips();
        paintList();
      });
      return b;
    };
    chips.replaceChildren(chip(null, "All", all.length), ...summary.map(({ info, count: n }) => chip(info.key, sourceText(info.key || null), n)));
  }

  // The pane hosts a live editor: it is only rebuilt when the selection
  // changes, never on a store refresh (that would drop the caret mid-word).
  let paneView: NoteView | null = null;
  function clearPane() {
    paneView?.destroy();
    paneView = null;
  }
  function showInPane(note: Note) {
    if (paneView && paneView.noteId() === resolveId(note.id)) return;
    clearPane();
    paneView = noteView(note, {
      close: () => {
        clearPane();
        selectedId = null;
        paintList();
      },
      openLink: ctx.openLink,
    });
    pane.replaceChildren(paneView.el);
    pane.scrollTop = 0;
  }

  function select(note: Note, focusRow = false) {
    selectedId = note.id;
    showInPane(note);
    list.querySelectorAll<HTMLElement>(".row").forEach((r) => {
      if (r.dataset.id === note.id) {
        r.setAttribute("aria-current", "true");
        if (focusRow) r.focus();
      } else r.removeAttribute("aria-current");
    });
    ctx.onSelectionChange(source, selectedId, folder);
  }

  // A Life log note opens its day instead (main.ts).
  const open = (note: Note) => (ctx.isDesktop() && !lifeLogDate(note, (iso) => iso) ? select(note) : ctx.openNote(note));

  function paintPane(shown: Note[]) {
    if (!ctx.isDesktop()) return;
    const current = all.find((n) => n.id === selectedId) ?? (results ?? []).find((n) => n.id === selectedId);
    if (current) {
      showInPane(current);
      return;
    }
    // A note being edited whose id just changed (temp -> server) is still the same note.
    if (paneView && selectedId && paneView.noteId() === resolveId(selectedId)) {
      selectedId = resolveId(selectedId);
      return;
    }
    if (shown[0]) {
      select(shown[0]);
      return;
    }
    clearPane();
    // A folder with no notes of its own says where they are; anywhere else, nothing's been picked yet.
    const f = folderById(folder);
    const inner = f ? childFolders(foldersSnapshot(), f.id).length : 0;
    pane.replaceChildren(
      h(
        "div",
        { class: "pane-empty" },
        f
          ? empty("folder", inner ? `No notes in ${f.name} itself` : `Nothing in ${f.name} yet`, inner ? "Its folders are on the left." : "Use Move to in a note's menu, or start one with Note.")
          : empty("notes", "Nothing selected", "Pick a note on the left to read it here.")
      )
    );
  }

  function paintList() {
    const terms = query ? keywords(query).concat(query.trim().toLowerCase()) : [];
    const shown = visible(results ?? all, !!(query && results !== null));
    // In a folder, everything inside it, its folders' notes too, as its row in the list says.
    count.textContent = query ? "" : String(folder ? notesIn(folder) : shown.length);

    if (query && results !== null) {
      // Ask conversations that mention it, under the notes; one opens in Ask.
      const talked = conversations.length
        ? h(
            "section",
            { class: "group" },
            h("h2", { class: "group__label" }, conversations.length === 1 ? "1 conversation" : `${conversations.length} conversations`),
            h(
              "div",
              { class: "card card--flush list" },
              ...conversations.map(({ thread, snippet }) => {
                const row = h(
                  "button",
                  { class: "row", type: "button" },
                  h("span", { class: "tile tile--sm" }, icons.chat()),
                  h(
                    "span",
                    { class: "row__body" },
                    h("span", { class: "row__title" }, ...highlight(threadTitle(thread), terms)),
                    snippet ? h("span", { class: "row__snippet" }, ...highlight(snippet, terms)) : null,
                    h("span", { class: "row__meta" }, "Conversation in Ask")
                  ),
                  h("span", { class: "row__time" }, compactTime(thread.updated_at))
                );
                row.addEventListener("click", () => {
                  requestOpen(thread.id);
                  ctx.go("ask");
                });
                return row;
              })
            )
          )
        : null;
      list.replaceChildren(
        ...(shown.length
          ? [
              h(
                "section",
                { class: "group" },
                h("h2", { class: "group__label" }, `${shown.length} ${shown.length === 1 ? "result" : "results"}`),
                h("div", { class: "card card--flush list" }, ...shown.map((n) => row(n, terms)))
              ),
            ]
          : talked
            ? []
            : [empty("search", `Nothing matches “${query.trim()}”`, "Try fewer words, or a name, project or topic.")]),
        ...(talked ? [talked] : [])
      );
    } else if (!all.length && !folder && !foldersSnapshot().length) {
      const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "New note");
      btn.addEventListener("click", ctx.compose);
      list.replaceChildren(empty("inbox", "No notes yet", "Capture a thought, or let a collection fill this in overnight.", btn));
    } else {
      const folders = foldersGroup();
      const groups = new Map<DayBucket, Note[]>();
      for (const n of shown) {
        const b = dayBucket(n.updated_at);
        groups.set(b, [...(groups.get(b) ?? []), n]);
      }
      let rest: HTMLElement[];
      if (shown.length) {
        rest = BUCKETS.filter((b) => groups.has(b)).map((b) =>
          h("section", { class: "group" }, h("h2", { class: "group__label" }, b), h("div", { class: "card card--flush list" }, ...groups.get(b)!.map((n) => row(n))))
        );
      } else if (folder) {
        // An empty folder: say so, and offer a note here.
        const btn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New note here");
        btn.addEventListener("click", () => openNoteSheet(null, { openLink: ctx.openLink, folder }));
        const name = folderById(folder)?.name ?? "this folder";
        rest = folders
          ? [h("p", { class: "notes__folder-empty" }, `No notes in ${name} itself yet.`)]
          : [empty("folder", `Nothing in ${name} yet`, "Use Move to in a note's menu, or start one here.", btn)];
      } else {
        rest = [empty("folder", `No notes from ${describeSource(source).name} yet`, "They'll appear here as soon as they arrive.")];
      }
      list.replaceChildren(...(folders ? [folders] : []), ...rest);
    }
    paintPane(shown);
  }

  // ---------- Search ----------
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clear.hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      query = input.value;
      if (!query.trim()) {
        results = null;
        paintList();
        return;
      }
      const asked = query;
      const words = keywords(asked);
      const [{ notes }, talked] = await Promise.all([
        searchNotes(asked.trim()),
        searchThreads(words.length ? words : [asked.trim()], { limit: 5 }).catch(() => []),
      ]);
      if (asked !== query) return;
      results = notes;
      conversations = words.length > 1 ? talked.filter(relevant) : talked;
      paintList();
    }, 200);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) {
      e.preventDefault();
      e.stopPropagation();
      clear.click();
    } else if (e.key === "Escape") {
      // Already empty: leave the box, so the keyboard shortcuts (c for a new note) work again.
      input.blur();
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });

  // ---------- Keyboard: arrows move through notes on desktop ----------
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".row")];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    next.focus();
    if (ctx.isDesktop()) next.click();
  });

  // ---------- Sticky header hairline once content scrolls under it ----------
  const scroller = () => (ctx.isDesktop() ? col : window);
  const onScroll = () => {
    const y = ctx.isDesktop() ? col.scrollTop : window.scrollY;
    head.classList.toggle("is-scrolled", y > 4);
  };
  const target = scroller();
  target.addEventListener("scroll", onScroll, { passive: true });

  const unsubscribe = onNotes((snap) => {
    all = snap.notes;
    paintChips();
    paintList();
  });
  // Folders made, renamed, moved or deleted (here or on another device): the head and the list follow.
  const unfolders = onFoldersChange(() => {
    if (folder && !folderById(folder)) folder = null;
    paintHead();
    paintList();
  });
  paintHead();
  if (!notesSnapshot().loaded) {
    list.replaceChildren(
      h("div", { class: "card card--flush list" }, ...[0, 1, 2, 3].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:55%" }), h("span", { class: "skeleton", style: "height:10px;width:85%;margin-top:var(--space-2xs-xs)" })), h("span", {}))))
    );
  }

  const focusSearch = () => requestAnimationFrame(() => input.focus());
  if (ctx.focusSearch) focusSearch();

  return {
    el,
    focusSearch,
    destroy: () => {
      unsubscribe();
      unfolders();
      clearPane();
      clearTimeout(timer);
      target.removeEventListener("scroll", onScroll);
    },
  };
}
