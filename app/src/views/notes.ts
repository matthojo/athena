/**
 * Notes: search, filter by source, and read. Mobile is one column with a
 * sticky glass header and notes grouped by day; tapping opens the note in a
 * sheet. Desktop splits into a list column and a reading pane (the BrainJot
 * reference), with arrow-key navigation and the selection kept in the URL.
 */

import { lifeLogDate } from "../components/day-words";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { highlight, noteRow } from "../components/note-row";
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

export interface NotesContext {
  source: string | null;
  noteId: string | null;
  focusSearch: boolean;
  isDesktop: () => boolean;
  openNote: (note: Note) => void;
  openLink: (kind: EntityKind, id: string) => void;
  compose: () => void;
  go: (view: ViewId) => void;
  onSelectionChange: (source: string | null, noteId: string | null) => void;
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
    openTemplatePicker({ openLink: ctx.openLink, openFilled: (n) => openNoteSheet(null, { openLink: ctx.openLink, seed: n.body, seedTitle: n.title, keepSeed: true }) })
  );
  const head = pageHead({
    segments: librarySegments("notes", ctx.go),
    title: "Notes",
    count,
    actions: [fromTemplate],
    below: [h("label", { class: "search" }, icons.search(), input, clear, h("kbd", {}, "⌘K")), chips],
  });
  const list = h("div", { class: "notes__list" });
  const col = h("div", { class: "notes__col" }, head, list);
  const pane = h("section", { class: "notes__pane", "aria-label": "Note" });
  const el = h("div", { class: "view notes" }, col, pane);

  const visible = (notes: Note[]) => (source === null ? notes : notes.filter((n) => (n.source ?? "") === source));

  function paintChips() {
    const summary = summarizeSources(all);
    const chip = (key: string | null, label: string, n: number) => {
      const b = h("button", { class: "chip", type: "button", "aria-pressed": String(source === key) }, label, h("span", { class: "chip__count" }, String(n)));
      b.addEventListener("click", () => {
        source = source === key ? null : key;
        ctx.onSelectionChange(source, selectedId);
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
    ctx.onSelectionChange(source, selectedId);
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
    pane.replaceChildren(h("div", { class: "pane-empty" }, empty("notes", "Nothing selected", "Pick a note on the left to read it here.")));
  }

  function paintList() {
    const terms = query ? keywords(query).concat(query.trim().toLowerCase()) : [];
    const shown = visible(results ?? all);
    count.textContent = query ? "" : String(shown.length);

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
                h("div", { class: "card card--flush list" }, ...shown.map((n) => noteRow(n, { onOpen: open, terms, current: n.id === selectedId })))
              ),
            ]
          : talked
            ? []
            : [empty("search", `Nothing matches “${query.trim()}”`, "Try fewer words, or a name, project or topic.")]),
        ...(talked ? [talked] : [])
      );
    } else if (!all.length) {
      const btn = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "New note");
      btn.addEventListener("click", ctx.compose);
      list.replaceChildren(empty("inbox", "No notes yet", "Capture a thought, or let a collection fill this in overnight.", btn));
    } else if (!shown.length) {
      list.replaceChildren(empty("folder", `No notes from ${describeSource(source).name} yet`, "They'll appear here as soon as they arrive."));
    } else {
      const groups = new Map<DayBucket, Note[]>();
      for (const n of shown) {
        const b = dayBucket(n.updated_at);
        groups.set(b, [...(groups.get(b) ?? []), n]);
      }
      list.replaceChildren(
        ...BUCKETS.filter((b) => groups.has(b)).map((b) =>
          h(
            "section",
            { class: "group" },
            h("h2", { class: "group__label" }, b),
            h("div", { class: "card card--flush list" }, ...groups.get(b)!.map((n) => noteRow(n, { onOpen: open, current: n.id === selectedId })))
          )
        )
      );
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
  if (!notesSnapshot().loaded) {
    list.replaceChildren(
      h("div", { class: "card card--flush list" }, ...[0, 1, 2, 3].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:55%" }), h("span", { class: "skeleton", style: "height:10px;width:85%;margin-top:6px" })), h("span", {}))))
    );
  }

  const focusSearch = () => requestAnimationFrame(() => input.focus());
  if (ctx.focusSearch) focusSearch();

  return {
    el,
    focusSearch,
    destroy: () => {
      unsubscribe();
      clearPane();
      clearTimeout(timer);
      target.removeEventListener("scroll", onScroll);
    },
  };
}
