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
import { acceptNotes, folderMenu, newFolder, NOTE_DRAG_TYPE } from "../components/folders-ui";
import { notesNavigator, type NotesNav, type NotesScope } from "../components/notes-nav";
import { hasTag, tagParts } from "../lib/note-tree";
import { folderById, foldersSnapshot, notesIn, onFoldersChange, pathOf } from "../db/folders";
import { childFolders, folderTrail } from "../../../lib/note-folder-rules";

export interface NotesContext {
  source: string | null;
  noteId: string | null;
  /** The folder open in the list (#/notes?folder=…), or null for All notes. */
  folder: string | null;
  /** A tag open in the list (#/notes?tag=…), or the notes with none (#/notes?untagged=1). */
  tag?: string | null;
  untagged?: boolean;
  focusSearch: boolean;
  isDesktop: () => boolean;
  openNote: (note: Note) => void;
  openLink: (kind: EntityKind, id: string) => void;
  compose: () => void;
  go: (view: ViewId) => void;
  onSelectionChange: (source: string | null, noteId: string | null, scope: NotesScope) => void;
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
  // A tag, or the notes with none: another way into the list, from the navigator (components/notes-nav.ts).
  let tag = folder ? null : (ctx.tag ?? null);
  let untagged = !folder && !tag && !!ctx.untagged;
  const scope = (): NotesScope => (folder ? { folder } : tag ? { tag } : untagged ? { untagged: true } : null);
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
  up.addEventListener("click", () => {
    if (folder) return openFolder(folderById(folder)?.parent_id ?? null);
    // A tag goes back to the tag above it, or to All notes.
    const parts = tag ? tagParts(tag) : [];
    openScope(parts.length > 1 ? { tag: parts.slice(0, -1).join("/") } : null);
  });
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
    const parts = tag ? tagParts(tag) : [];
    const scoped = !!(f || tag || untagged);
    title.textContent = f ? f.name : tag ? `#${parts[parts.length - 1] ?? tag}` : untagged ? "Untagged" : "Notes";
    head.classList.toggle("is-in-folder", scoped);
    up.hidden = !scoped;
    noteHere.hidden = folderMore.hidden = !f;
    fromTemplate.hidden = scoped;
    // The first folder is made from here, on a phone; once there are some, the navigator has its own +.
    addFolder.hidden = scoped || foldersSnapshot().length > 0;
    chips.hidden = scoped;
    if (!scoped) return void (trail.hidden = true);
    const crumb = (label: string, to: NotesScope) => {
      const b = h("button", { class: "folder-trail__step", type: "button" }, label);
      b.addEventListener("click", () => openScope(to));
      // On a desk, a note dropped on a folder's step moves there (on Notes: out of any folder).
      if (ctx.isDesktop() && (!to || "folder" in to)) acceptNotes(b, () => (to && "folder" in to ? to.folder : null));
      return b;
    };
    const sep = () => h("span", { class: "folder-trail__sep", "aria-hidden": "true" }, icons.chevronRight());
    const steps: HTMLElement[] = [crumb("Notes", null)];
    if (f) for (const s of folderTrail(foldersSnapshot(), f.id).slice(0, -1)) steps.push(crumb(s.name, { folder: s.id }));
    if (tag) for (let i = 1; i < parts.length; i++) steps.push(crumb(`#${parts[i - 1]}`, { tag: parts.slice(0, i).join("/") }));
    trail.replaceChildren(...steps.flatMap((s) => [s, sep()]));
    trail.hidden = false;
  }

  /** Open a folder in the list (null: All notes). */
  const openFolder = (id: string | null) => openScope(id ? { folder: id } : null);

  /** Show a folder, a tag, the notes with no tag, or everything (null). */
  function openScope(next: NotesScope) {
    folder = next && "folder" in next && folderById(next.folder) ? next.folder : null;
    tag = next && "tag" in next ? next.tag : null;
    untagged = !!(next && "untagged" in next);
    // On a desk the pane follows: a note from elsewhere gives way to the first one here.
    const here = selectedId ? all.find((n) => n.id === selectedId) : undefined;
    if (here && scope() && !inScope(here)) selectedId = null;
    if (query) {
      input.value = "";
      query = "";
      results = null;
      clear.hidden = true;
    }
    ctx.onSelectionChange(source, selectedId, scope());
    navColumn.setCurrent(scope());
    paintHead();
    paintList();
    (ctx.isDesktop() ? col : document.scrollingElement)?.scrollTo({ top: 0 });
  }
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane", "aria-label": "Note" });
  // On a wide desk, the navigator's own column at the left (components/notes-nav.ts); CSS shows it from 1360px.
  const navColumn = notesNavigator({ variant: "column", open: (to) => openScope(to) });
  navColumn.setCurrent(scope());
  const navCol = h("aside", { class: "notes__nav", "aria-label": "Folders and tags" }, navColumn.el);
  const el = h("div", { class: "view notes has-nav" }, navCol, col, pane);

  // Day headings folded by hand, kept on this device.
  const FOLDED_DAYS = "athena.notes.foldedDays";
  const foldedDays = (() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(FOLDED_DAYS) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  })();
  const saveFoldedDays = () => {
    try {
      localStorage.setItem(FOLDED_DAYS, JSON.stringify([...foldedDays]));
    } catch {
      // private window: kept until reload
    }
  };

  /** Whether a note belongs where the list is: the folder's own, the tag or one under it, or no tag. */
  const inScope = (n: Note) => (folder ? n.folder_id === folder : tag ? hasTag(n, tag) : untagged ? !n.tags.length : true);
  /** The notes the list shows: what's in scope, or all of them by source. A search looks everywhere. */
  const visible = (notes: Note[], searching = false) => {
    if (scope() && !searching) return notes.filter(inScope);
    return source === null || scope() ? notes : notes.filter((n) => (n.source ?? "") === source);
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
  /**
   * Under 1360px wide, the navigator at the top of the list (components/notes-nav.ts):
   * folders and tags at All notes, the folders inside it in a folder. A wider
   * desk has it in its own column, and CSS hides this one there.
   */
  let listNav: NotesNav | null = null;
  let listNavRoot: string | null | undefined;
  function navigatorHere(): HTMLElement | null {
    if (tag || untagged) return null;
    if (folder && !childFolders(foldersSnapshot(), folder).length) return null;
    if (!listNav || listNavRoot !== folder) {
      listNav?.destroy();
      listNavRoot = folder;
      listNav = notesNavigator({ variant: "list", root: folder, open: (to) => openScope(to) });
    }
    return listNav.el;
  }

  function paintChips() {
    const summary = summarizeSources(all);
    const chip = (key: string | null, label: string, n: number) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(source === key) }, label, h("span", { class: "chip__count" }, String(n)));
      b.addEventListener("click", () => {
        source = source === key ? null : key;
        ctx.onSelectionChange(source, selectedId, scope());
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
    ctx.onSelectionChange(source, selectedId, scope());
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
      const folders = navigatorHere();
      const groups = new Map<DayBucket, Note[]>();
      for (const n of shown) {
        const b = dayBucket(n.updated_at);
        groups.set(b, [...(groups.get(b) ?? []), n]);
      }
      let rest: HTMLElement[];
      if (shown.length) {
        // Each day's heading folds its notes away, and stays folded on this device (Older, say, out of sight).
        rest = BUCKETS.filter((b) => groups.has(b)).map((b) => {
          const shut = foldedDays.has(b);
          const n = groups.get(b)!.length;
          const fold = h(
            "button",
            { class: "notes__fold", type: "button", "aria-expanded": String(!shut), "aria-label": `${b}, ${n} ${n === 1 ? "note" : "notes"}. ${shut ? "Show" : "Hide"} them` },
            h("span", {}, b),
            shut ? h("span", { class: "notes__fold-count" }, String(n)) : null,
            icons.chevronDown()
          );
          fold.addEventListener("click", () => {
            if (foldedDays.has(b)) foldedDays.delete(b);
            else foldedDays.add(b);
            saveFoldedDays();
            paintList();
          });
          return h("section", { class: `group${shut ? " is-folded" : ""}` }, h("h2", { class: "group__label notes__day" }, fold), shut ? null : h("div", { class: "card card--flush list" }, ...groups.get(b)!.map((n) => row(n))));
        });
      } else if (folder || tag || untagged) {
        // An empty folder: say so, and offer a note here.
        const btn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New note here");
        btn.addEventListener("click", () => openNoteSheet(null, { openLink: ctx.openLink, folder }));
        const name = folderById(folder)?.name ?? "this folder";
        rest = tag || untagged
          ? [empty("tag", tag ? `No notes tagged #${tag}` : "Every note has a tag", tag ? "Give a note this tag and it shows up here." : "Notes without one show here.")]
          : folders
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
      listNav?.destroy();
      navColumn.destroy();
      clearPane();
      clearTimeout(timer);
      target.removeEventListener("scroll", onScroll);
    },
  };
}
