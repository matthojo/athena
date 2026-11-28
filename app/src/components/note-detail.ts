/**
 * One note, editable: the mobile sheet and the desktop reading pane are the
 * same view. Large title, rich body (TipTap, lazy-loaded) with dictation from
 * the toolbar's mic (components/voice.ts), meta row (type,
 * tags, source), Linked chips and Backlinks, a small graph of what the note
 * links to (components/local-graph.ts), and an overflow menu with
 * Archive (undo toast), Delete permanently (confirmed — the only irreversible
 * action in the app), Copy link and Earlier versions: what the note held
 * before each change, yours included, with who made it and Restore
 * (lib/note-versions.ts on the server).
 *
 * Saves are local-first and debounced (db/sync.ts queues and coalesces them).
 * A new note (from + or C) isn't created until it has some content, so
 * opening and closing the composer leaves nothing behind.
 *
 * Note content can come from email digests: it is only ever rendered through
 * ProseMirror's schema (the editor) or as text nodes (the loading preview).
 *
 * A note whose text this copy of Athena can't decrypt (a deploy preview, see
 * docs: security/encryption) arrives with a placeholder in place of its title or body.
 * It opens read-only, so the placeholder can never be saved over it.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { openAsk } from "../lib/open-ask";
import { openLinked } from "../lib/open-linked";
import { h } from "../lib/dom";
import { setPageName } from "../lib/page-title";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmChoice } from "./confirm";
import { voiceButton, voiceSupported, type VoiceButton } from "./voice";
import { localGraphSection, type LocalGraphSection } from "./local-graph";
import { customFieldsSection } from "./custom-fields";
import { deleteFilesChoice, filesDeletedWithNote, noteFilesSection } from "./attachments";
import { entityIcon } from "../lib/entity-icon";
import { longDateTime, relativeTime, shortDate } from "../lib/format";
import { describeSource } from "../lib/sources";
import { markdownToText } from "../lib/markdown-text";
import { noteParts, TYPE_ICON, TYPE_LABEL } from "./note-row";
import { createNoteLocal, deleteNoteLocal, onNoteIdResolved, pullNotes, resolveId, setNoteArchivedLocal, updateNoteLocal } from "../db/sync";
import { loadConnections, onNotes, searchEntities } from "../db/data";
import { folderById, onFoldersChange, pathOf } from "../db/folders";
import { moveNoteTo } from "./folders-ui";
import { isSampleMode, request, saveRecord } from "../db/api";
import { isEncryptedPlaceholder } from "../../../lib/encrypted";
import { ownerWroteNote } from "../../../lib/links";
import { loadLinkChoices, saveLinkChoice } from "../db/link-choices";
import type { Connection, EntityKind, EntityRef, Note, NotePatch, NoteType } from "../types";
import type { NoteEditorHandle } from "../editor/editor";
import { noteDocuments } from "./note-documents";
import { downloadIcons, noteDownload } from "./note-download";
import { openTemplateEditor, openTemplatePicker } from "./templates";



const NOTE_TYPES: NoteType[] = ["note", "capture", "daily", "project", "area"];

export interface NoteViewContext {
  /** Close whatever holds this view (sheet) or clear it (desktop pane). */
  close: () => void;
  /** Follow an athena:// link / chip. */
  openLink: (kind: EntityKind, id: string) => void;
  /** A brand-new note was just created (temp id). */
  onCreated?: (note: Note) => void;
  /** Focus the body once the editor loads (new notes). */
  autofocus?: boolean;
  /** A new note's starting body (e.g. a link to the person it's about). It
   * isn't saved until something is added to it. */
  seed?: string;
  /** A filled template: its title, and the seed is saved straight away (it's the note, not a hint). */
  seedTitle?: string;
  keepSeed?: boolean;
  /** A new note started inside a folder (the Notes list's "Note" there): it's made in that folder. */
  folder?: string | null;
}

export interface NoteView {
  el: HTMLElement;
  noteId: () => string | null;
  destroy: () => void;
}

/** Title for an untitled note: its first line of plain text, like capture() on the server. */
function deriveTitle(plain: string): string {
  const first = plain.split("\n").find((l) => l.trim())?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function plainPreview(markdown: string): HTMLElement {
  const paragraphs = markdownToText(markdown).split(/\n{2,}/).filter((p) => p.trim());
  return h("div", { class: "note__body note__body--preview" }, ...paragraphs.map((p) => h("p", {}, p)));
}

let editorModule: Promise<typeof import("../editor/editor")> | null = null;
const loadEditor = () => (editorModule ??= import("../editor/editor"));

/** Load the editor chunk ahead of time (when idle), so the first note opens ready to edit. */
export function warmEditor(): void {
  void loadEditor().catch(() => {
    editorModule = null; // offline before the chunk was cached: try again on open
  });
}

/** What a note held before a change to its title or body (lib/note-versions.ts). */
interface NoteVersion {
  id: string;
  title: string;
  body: string;
  changed_by: string | null;
  created_at: string;
}

/** Who made the change that replaced a version. One that didn't say was Athena itself (Ask, a collection, a saved action). */
const CHANGED_BY: Record<string, string> = { owner: "Changed by you", api: "Changed by a script", mcp: "Changed by an agent", assistant: "Changed by Ask", collection: "Changed by a collection", restore: "Replaced by a restore" };

/**
 * Earlier versions of a note, newest first, each with Restore. `restore` puts
 * one back on the server and hands the note as it now is to the open editor.
 */
function openVersionsSheet(noteId: string, onRestored: (note: Note) => Promise<void>): void {
  const root = h("div", { class: "note-versions" }, h("div", { class: "card card--flush list" }, h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" })))));
  const sheet = openSheet({ label: "Earlier versions", title: "Earlier versions", body: root });
  const empty = (title: string, sub: string) => h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, title), h("p", { class: "empty__sub" }, sub));

  function row(v: NoteVersion): HTMLElement {
    const restore = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Restore the version from ${longDateTime(v.created_at)}` }, "Restore") as HTMLButtonElement;
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      try {
        const note = await request<Note>(`/notes/${encodeURIComponent(noteId)}/versions/${encodeURIComponent(v.id)}/restore`, { method: "POST" });
        await onRestored(note);
        sheet.close();
        showToast("Earlier version restored", { icon: "check" });
      } catch {
        restore.disabled = false;
        showToast("Couldn't restore it. Are you online?", { icon: "wifiOff" });
      }
    });
    const text = markdownToText(v.body).replace(/\s+/g, " ").trim();
    const by = (v.changed_by && CHANGED_BY[v.changed_by]) || "Changed by Athena";
    return h(
      "div",
      { class: "row" },
      h("span", { class: "tile tile--sm" }, icons.clock()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, `Until ${longDateTime(v.created_at)}`),
        h("span", { class: "row__meta", style: "white-space:normal" }, [by, text ? (text.length > 140 ? `${text.slice(0, 137)}...` : text) : "Empty"].join(" · "))
      ),
      restore
    );
  }

  void request<{ versions: NoteVersion[] }>(`/notes/${encodeURIComponent(noteId)}/versions`).then(
    ({ versions }) =>
      root.replaceChildren(
        versions.length
          ? h("div", { class: "card card--flush list" }, ...versions.map(row))
          : empty("No earlier versions", "Athena keeps what a note said each time it changes, whoever changes it. Your own typing is kept at most once every 10 minutes.")
      ),
    () => root.replaceChildren(empty("Couldn't load earlier versions", "Check your connection and try again."))
  );
}

/** Create a person/place/organisation from the @ popover (online only). */
async function createEntity(kind: "person" | "place" | "organisation", name: string): Promise<EntityRef | null> {
  try {
    const rec = await saveRecord<{ id: string; name: string; updated_at: string }>(kind, { name });
    showToast(`Added ${name}`, { icon: "check" });
    return { kind, id: rec.id, title: rec.name, subtitle: "", updated_at: rec.updated_at };
  } catch {
    showToast("Couldn't create that. Are you online?", { icon: "wifiOff" });
    return null;
  }
}

/** A to-do from a line in a note ("Add to To do"), linked back to the note when it has been saved. */
async function addTodoFromNote(title: string, noteId: string | null, noteTitle: string): Promise<{ id: string; title: string } | null> {
  const { saveCommitment } = await import("../db/memory");
  const from = noteId && !noteId.startsWith("local-") ? [{ id: crypto.randomUUID(), url: `athena://note/${noteId}`, title: noteTitle }] : [];
  try {
    const todo = await saveCommitment({ title, kind: "todo", ...(from.length ? { links: from } : {}) });
    showToast("Added to To do", { icon: "check" });
    return { id: todo.id, title: todo.title };
  } catch {
    showToast("Couldn't add it to To do. Are you online?", { icon: "wifiOff" });
    return null;
  }
}

/** A new, empty note from the [[ menu, so it can be linked straight away (online only: a link needs its real id). */
async function createLinkedNote(title: string): Promise<EntityRef | null> {
  try {
    const { createNote } = await import("../db/api");
    const made = await createNote({ title, body: "", type: "note", source: "manual", tags: [] });
    // So it's in the list, and in the next [[ search, straight away.
    void pullNotes().catch(() => undefined);
    showToast(`Made a note called “${title}”`, { icon: "check" });
    return { kind: "note", id: made.id, title: made.title, subtitle: "", updated_at: made.updated_at };
  } catch {
    showToast("Couldn't make the note. Are you online?", { icon: "wifiOff" });
    return null;
  }
}

export function noteView(initial: Note | null, ctx: NoteViewContext): NoteView {
  let note: Note | null = initial;
  let dead = false;
  let creating: Promise<void> | null = null;
  let editor: NoteEditorHandle | null = null;
  let voice: VoiceButton | null = null;
  let typeTouched = false;

  const parts = initial ? noteParts(initial) : null;
  // Encrypted and unreadable here: show it, but don't let anything be typed over it.
  const locked = !!initial && (isEncryptedPlaceholder(initial.title) || isEncryptedPlaceholder(initial.body));
  // A capture's title is just the start of its body; show it as a hint, not as
  // a typed title, and keep deriving it until the user writes a real one.
  const titleWasDerived = !!parts?.derived || !initial?.title.trim();
  let tags = [...(initial?.tags ?? [])];
  const seed = initial ? "" : (ctx.seed ?? "");
  let body = initial?.body ?? seed;
  // A note the owner didn't write (a collection, the assistant, a Shortcut): its web links load no preview.
  const athenaWrote = !!initial && !ownerWroteNote(initial.source);

  // ---------- Title ----------
  const titleInput = h("textarea", {
    class: "note__title-input",
    name: "title",
    rows: 1,
    placeholder: titleWasDerived && initial ? deriveTitle(markdownToText(body)) || "Title" : "Title",
    "aria-label": "Title",
    enterkeyhint: "next",
    maxlength: 300,
  }) as HTMLTextAreaElement;
  titleInput.value = titleWasDerived ? (initial ? "" : (ctx.seedTitle ?? "")) : (initial?.title ?? "");
  titleInput.readOnly = locked;
  const growTitle = () => {
    titleInput.style.height = "auto";
    titleInput.style.height = `${titleInput.scrollHeight}px`;
  };
  // The tab is called what the note is (lib/page-title.ts); never a placeholder for text that can't be read here.
  let unnameTab = setPageName(parts && !locked ? parts.title : null);
  titleInput.addEventListener("input", () => {
    growTitle();
    scheduleSave();
    unnameTab = setPageName(titleInput.value.trim() || titleInput.placeholder.replace(/^Title$/, "") || null);
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor?.focus();
    }
  });

  // ---------- Meta row ----------
  const typeSelect = h(
    "select",
    { class: "meta-chip meta-select", name: "type", "aria-label": "Note type" },
    ...NOTE_TYPES.map((t) => h("option", { value: t }, TYPE_LABEL[t]))
  ) as HTMLSelectElement;
  typeSelect.value = initial?.type ?? "note";
  typeSelect.disabled = locked;
  typeSelect.addEventListener("change", () => {
    typeTouched = true;
    paintTypeIcon();
    scheduleSave();
  });
  const typeWrap = h("label", { class: "meta-select-wrap" }, h("span", { class: "meta-select-icon" }), typeSelect);
  const paintTypeIcon = () =>
    typeWrap.firstElementChild!.replaceChildren(icons[TYPE_ICON[typeSelect.value as NoteType]]());
  paintTypeIcon();

  const metaChips = h("div", { class: "note__chips" });
  const menuId = `note-menu-${Math.random().toString(36).slice(2)}`;
  const moreBtn = h(
    "button",
    { class: "icon-btn icon-btn--sm icon-btn--ghost note__more", type: "button", "aria-label": "More actions", popovertarget: menuId },
    icons.more()
  ) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  // The chips wrap among themselves, so ⋯ stays at the top right however many there are.
  const bar = h("div", { class: "note__bar" }, h("div", { class: "note__bar-lead" }, typeWrap, metaChips), moreBtn, menu);

  const chip = (icon: IconName, text: string) => h("span", { class: "meta-chip" }, icons[icon](), text);
  /** The folder it's in, as a chip that opens Move to. None when it's in no folder: Move to is in the menu. */
  function folderChip(): HTMLElement | null {
    const id = note ? (note.folder_id ?? null) : (ctx.folder ?? null);
    const path = id ? pathOf(id) : "";
    if (!path) return null;
    // Its own name on the chip, so the row fits a phone; the whole path when it's read out or hovered.
    const b = h("button", { class: "meta-chip meta-chip--folder", type: "button", title: path, "aria-label": `In ${path}. Move it` }, icons.folder(), h("span", { class: "meta-chip__text" }, folderById(id)?.name ?? path));
    b.addEventListener("click", () => note && moveNoteTo(resolveId(note.id), note.folder_id ?? null));
    return b;
  }
  function paintMeta() {
    // Notes the owner writes carry no source chip; only ones that came from somewhere else say where.
    const source = describeSource(note?.source ?? "manual");
    const items: HTMLElement[] = source.key === "manual" ? [] : [chip(source.icon, source.label ? `${source.name} · ${source.label}` : source.name)];
    const inFolder = folderChip();
    if (inFolder) items.unshift(inFolder);
    if (note) items.push(chip("clock", shortDate(note.created_at)));
    if (note?.id.startsWith("local-")) items.push(h("span", { class: "badge badge--queued" }, "Waiting to sync"));
    metaChips.replaceChildren(...items);
    moreBtn.disabled = !note;
    foot.textContent = note ? `Created ${longDateTime(note.created_at)} · Updated ${relativeTime(note.updated_at)}` : "Saves as you type, even offline.";
  }

  // ---------- Overflow menu ----------
  const menuItem = (icon: IconName | (() => SVGElement), label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, typeof icon === "string" ? icons[icon]() : icon(), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  menu.replaceChildren(
    // Ask with this note attached (lib/open-ask.ts); collected emails are notes too.
    menuItem("chat", "Ask about this", () => note && openAsk({ context: { kind: "note", id: resolveId(note.id), label: titleInput.value.trim() || deriveTitle(markdownToText(body)) || "Untitled" } })),
    menuItem("link", "Copy link", copyLink),
    // Into a folder, or out of one (components/folders-ui.ts). Not for a note this copy can't read.
    locked ? "" : menuItem("folder", "Move to…", () => note && moveNoteTo(resolveId(note.id), note.folder_id ?? null)),
    // What it held before each change. Needs the server, so not in sample data or on a locked note.
    isSampleMode() || locked ? "" : menuItem("clock", "Earlier versions", versions),
    h("div", { class: "menu__sep" }),
    menuItem("external", "Send to Google Docs", () => void docs.send("google-docs")),
    menuItem("external", "Send to Notion", () => void docs.send("notion")),
    // As a file, or on paper (components/note-download.ts). Not for a note this copy can't read.
    locked ? "" : menuItem(downloadIcons.download, "Download as Markdown", () => void files.download("md")),
    locked ? "" : menuItem(downloadIcons.download, "Download as Word", () => void files.download("docx")),
    locked ? "" : menuItem(downloadIcons.print, "Print or save as PDF", () => files.print()),
    menuItem("copy", "Save as template", () => openTemplateEditor(null, { from: { name: titleInput.value.trim() || deriveTitle(markdownToText(body)) || "Untitled", body } })),
    h("div", { class: "menu__sep" }),
    menuItem("archive", "Archive", archive),
    h("div", { class: "menu__sep" }),
    menuItem("trash", "Delete permanently", remove, "menu__item--danger")
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8))}px`;
    placeMenuAcross(menu, moreBtn);
  });

  async function copyLink() {
    if (!note) return;
    const url = `${location.origin}/#/notes/${encodeURIComponent(resolveId(note.id))}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied", { icon: "link" });
    } catch {
      showToast("Couldn't copy the link", { icon: "close" });
    }
  }

  async function versions() {
    if (!note) return;
    await saveNow();
    if (note.id.startsWith("local-")) return void showToast("This note hasn't synced yet, so it has no earlier versions.", { icon: "clock" });
    openVersionsSheet(resolveId(note.id), async (restored) => {
      if (!note || dead) return;
      clearTimeout(saveTimer);
      // The open editor takes the restored text, and so does this device's copy.
      body = restored.body;
      const derived = restored.title === deriveTitle(markdownToText(restored.body));
      titleInput.value = derived ? "" : restored.title;
      if (derived) titleInput.placeholder = restored.title || "Title";
      growTitle();
      note = (await updateNoteLocal(note.id, { title: restored.title, body: restored.body }, note)) ?? note;
      voice?.destroy();
      voice = null;
      editor?.destroy();
      editor = null;
      await mountEditor();
      paintMeta();
      void paintLinks();
    });
  }

  async function archive() {
    if (!note) return;
    await saveNow();
    const archived = { ...note };
    dead = true;
    await setNoteArchivedLocal(archived, true);
    ctx.close();
    showToast("Note archived", {
      icon: "archive",
      action: { label: "Undo", run: () => void setNoteArchivedLocal(archived, false) },
    });
  }

  async function remove() {
    if (!note) return;
    // Files a conversation still has stay unless you tick the box.
    const held = noteFiles.files().filter((f) => f.in_conversation && !f.removed);
    const picked = await confirmChoice({
      title: "Delete this note permanently?",
      body: "It's removed from Athena everywhere, along with its links. This can't be undone. Archive it instead if you might want it back.",
      confirmLabel: "Delete permanently",
      danger: true,
      choice: deleteFilesChoice(held),
    });
    if (!picked) return;
    dead = true;
    clearTimeout(saveTimer);
    await deleteNoteLocal(note, { files: picked.choice });
    const said = await filesDeletedWithNote(held, picked.choice);
    ctx.close();
    showToast(said, { icon: "trash" });
  }

  // ---------- Body ----------
  const toolbarSlot = h("div", { class: "note__toolbar" });
  // The placeholder says it once, in the title; the body only repeats it if the title can be read.
  const showBody = !(locked && isEncryptedPlaceholder(body) && isEncryptedPlaceholder(initial?.title));
  const bodySlot = h("div", { class: "note__editor" }, showBody ? plainPreview(body) : null);

  // On touch screens the toolbar moves to the sheet's bottom edge while you
  // write, so it rides on top of the keyboard like a native notes app.
  const coarse = window.matchMedia("(pointer: coarse)");
  let dockPanel: HTMLElement | null = null;
  function dockToolbar() {
    const panel = el.closest<HTMLElement>(".sheet__panel");
    if (!coarse.matches || !panel || dockPanel) return;
    dockPanel = panel;
    toolbarSlot.classList.add("note__toolbar--docked");
    panel.append(toolbarSlot);
    requestAnimationFrame(() => {
      // Where the (fixed, panel-relative) style menu opens: just above the toolbar.
      panel.style.setProperty("--dock-h", `${Math.round(panel.getBoundingClientRect().bottom - toolbarSlot.getBoundingClientRect().top)}px`);
    });
  }
  function undockToolbar() {
    if (!dockPanel) return;
    toolbarSlot.classList.remove("note__toolbar--docked");
    bodySlot.before(toolbarSlot);
    dockPanel = null;
  }
  const maybeUndock = () =>
    setTimeout(() => {
      const active = document.activeElement;
      if (!dead && !(active && (bodySlot.contains(active) || toolbarSlot.contains(active)))) undockToolbar();
    }, 0);
  bodySlot.addEventListener("focusin", dockToolbar);
  bodySlot.addEventListener("focusout", maybeUndock);
  toolbarSlot.addEventListener("focusout", maybeUndock);

  // ---------- Tags ----------
  const tagInput = h("input", {
    class: "tag-input",
    name: "tag",
    type: "text",
    placeholder: "Add tag",
    "aria-label": "Add tag",
    enterkeyhint: "done",
    autocapitalize: "none",
    autocomplete: "off",
  }) as HTMLInputElement;
  const tagRow = h("div", { class: "note__tags" });
  function paintTags() {
    if (locked) {
      tagRow.replaceChildren(...tags.filter((t) => !isEncryptedPlaceholder(t)).map((t) => h("span", { class: "tag" }, `#${t}`)));
      return;
    }
    tagRow.replaceChildren(
      ...tags.map((t) => {
        const x = h("button", { class: "tag__remove", type: "button", "aria-label": `Remove tag ${t}` }, icons.close());
        x.addEventListener("click", () => {
          tags = tags.filter((v) => v !== t);
          paintTags();
          scheduleSave();
        });
        return h("span", { class: "tag tag--editable" }, `#${t}`, x);
      }),
      tagInput
    );
  }
  const addTag = () => {
    const t = tagInput.value.trim().replace(/^#/, "").replace(/,$/, "").trim();
    tagInput.value = "";
    if (!t || tags.includes(t)) return;
    tags = [...tags, t];
    paintTags();
    tagInput.focus();
    scheduleSave();
  };
  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && !tagInput.value && tags.length) {
      tags = tags.slice(0, -1);
      paintTags();
      tagInput.focus();
      scheduleSave();
    }
  });
  tagInput.addEventListener("blur", () => tagInput.value.trim() && addTag());

  // ---------- The owner's own fields (components/custom-fields.ts) ----------
  // Shown once the note exists; they save offline like the rest of the note.
  const custom = customFieldsSection("note");
  // Photos, PDFs and text files on the note, added here or by Athena from Ask (components/attachments.ts).
  const noteFiles = noteFilesSection({ readOnly: locked });

  // ---------- Links + backlinks ----------
  const linked = h("div", { class: "link-chips" });
  const backlinks = h("div", { class: "backlinks" });
  const linkedHead = h("h2", { class: "group__label" }, "Linked");
  const backlinksHead = h("h2", { class: "group__label" }, "Backlinks");
  // Each half shows once it has something in it; a new note shows neither.
  const links = h("section", { class: "note__links", "aria-label": "Links", hidden: true }, linkedHead, linked, backlinksHead, backlinks);

  const linkChip = (c: Connection) => {
    const b = h("button", { class: "link-chip", type: "button", "data-kind": c.kind }, icons[entityIcon(c.kind, c.kind_id, c.id, c.subtitle)](), c.title || "Untitled");
    b.addEventListener("click", () => openLinked(ctx.openLink, c.kind, c.id));
    return b;
  };
  // The small graph appears once the note exists, and follows the body's links as you type.
  let localGraph: LocalGraphSection | null = null;
  function paintGraph() {
    if (!note || dead) return;
    if (!localGraph) {
      localGraph = localGraphSection({
        kind: "note",
        id: resolveId(note.id),
        title: () => titleInput.value.trim() || titleInput.placeholder,
        body: () => body,
        openLink: ctx.openLink,
      });
      links.after(localGraph.el);
    } else localGraph.update(body);
  }

  let linksSeq = 0;
  async function paintLinks() {
    paintGraph();
    const seq = ++linksSeq;
    // Unsaved new note: outgoing links still come straight from the body.
    const { outgoing, backlinks: back } = note
      ? await loadConnections("note", resolveId(note.id), body)
      : await loadConnections("note", "local-unsaved", body);
    if (seq !== linksSeq || dead) return;
    linked.replaceChildren(...outgoing.map(linkChip));
    linkedHead.hidden = linked.hidden = !outgoing.length;
    backlinksHead.hidden = backlinks.hidden = !back.length;
    links.hidden = !outgoing.length && !back.length;
    backlinks.replaceChildren(
      back.length
        ? h(
            "div",
            { class: "card card--flush list" },
            ...back.map((c) => {
              const row = h(
                "button",
                { class: "row row--compact", type: "button" },
                h("span", { class: "tile tile--sm" }, icons[entityIcon(c.kind, c.kind_id, c.id, c.subtitle)]()),
                h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.title || "Untitled")),
                c.updated_at ? h("span", { class: "row__time" }, shortDate(c.updated_at)) : null
              );
              row.addEventListener("click", () => openLinked(ctx.openLink, c.kind, c.id));
              return row;
            })
          )
        : ""
    );
  }
  let linksTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- Saving ----------
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSave() {
    if (dead || locked) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 600);
  }

  async function saveNow(): Promise<void> {
    clearTimeout(saveTimer);
    if (dead || locked) return;
    if (creating) await creating;
    const typedTitle = titleInput.value.trim();
    const plain = markdownToText(body);
    const title = typedTitle || deriveTitle(plain);
    if (!typedTitle) titleInput.placeholder = deriveTitle(plain) || "Title";

    if (!note) {
      if (!ctx.keepSeed && !typedTitle && (!plain.trim() || body.trim() === seed.trim())) return;
      const type: NoteType = typeTouched ? (typeSelect.value as NoteType) : typedTitle ? "note" : "capture";
      typeSelect.value = type;
      paintTypeIcon();
      creating = createNoteLocal({ title, body, type, source: "manual", tags, folder_id: ctx.folder ?? null }).then((created) => {
        note = created;
        paintMeta();
        void paintLinks();
        ctx.onCreated?.(created);
        custom.show(created.id);
        noteFiles.show(created.id);
        docs.show(created.id);
      });
      await creating;
      creating = null;
      return;
    }

    const patch: NotePatch = {};
    if (title !== note.title) patch.title = title;
    if (body !== note.body) patch.body = body;
    if (tags.join("\u0000") !== note.tags.join("\u0000")) patch.tags = tags;
    if (typeSelect.value !== note.type) patch.type = typeSelect.value as NoteType;
    if (!Object.keys(patch).length) return;
    note = (await updateNoteLocal(note.id, patch, note)) ?? note;
    paintMeta();
  }

  const unresolved = onNoteIdResolved((tempId, id) => {
    if (note?.id === tempId) {
      note = { ...note, id };
      custom.show(id);
      noteFiles.show(id);
      docs.show(id);
      paintMeta();
      void paintLinks();
    }
  });
  // Moved into or out of a folder (its chip, Move to, a drag in the list, another device): the chip follows.
  const unNotes = onNotes((snap) => {
    if (!note || dead) return;
    const now = snap.notes.find((n) => n.id === resolveId(note!.id));
    if (now && (now.folder_id ?? null) !== (note.folder_id ?? null)) {
      note = { ...note, folder_id: now.folder_id ?? null };
      paintMeta();
    }
  });
  const unFolders = onFoldersChange(() => !dead && paintMeta());
  const onHide = () => void saveNow();
  window.addEventListener("pagehide", onHide);

  // ---------- Sent to Google Docs or Notion (components/note-documents.ts) ----------
  const docs = noteDocuments({ title: () => titleInput.value.trim() || note?.title || "Untitled", save: () => saveNow(), noteId: () => (note ? resolveId(note.id) : null) });

  // ---------- Download and print (components/note-download.ts) ----------
  const files = noteDownload({
    title: () => titleInput.value.trim() || (titleWasDerived ? "" : (note?.title ?? "")),
    body: () => body,
    save: () => saveNow(),
    noteId: () => (note ? resolveId(note.id) : null),
    content: () => bodySlot,
    onKept: () => noteFiles.show(note ? resolveId(note.id) : null),
  });

  // ---------- Assemble ----------
  const foot = h("footer", { class: "note__foot" });
  // Read-only and unreadable here: no editing hints, and no links (their titles would be placeholders too).
  const el = locked
    ? h("article", { class: "note note--edit note--encrypted" }, bar, titleInput, bodySlot, tagRow, foot)
    : h("article", { class: "note note--edit" }, bar, titleInput, docs.el, toolbarSlot, bodySlot, tagRow, custom.section(), noteFiles.el, links, foot);

  paintMeta();
  paintTags();
  if (!locked) void paintLinks();
  if (!locked) custom.show(note?.id ?? null);
  if (!locked) noteFiles.show(note ? resolveId(note.id) : null);
  if (!locked) docs.show(note ? resolveId(note.id) : null);
  // A filled template is a note already: save it now.
  if (!initial && ctx.keepSeed && seed) void saveNow();
  requestAnimationFrame(growTitle);

  // The owner's stored Card and Mention choices for this note: those links load; every other stays plain.
  const allowChosenLinks = () => {
    if (!athenaWrote || !initial) return;
    void loadLinkChoices(resolveId(initial.id)).then((choices) => {
      if (!dead && choices.length) editor?.allowPreviews(choices);
    });
  };
  const mountEditor = () => loadEditor().then(({ createNoteEditor }) => {
    if (dead) return;
    if (locked) {
      // Read-only: a body this copy can read still draws its links as Mentions, Cards and Embeds.
      if (showBody && !isEncryptedPlaceholder(body)) {
        editor = createNoteEditor({ markdown: body, readOnly: true, athenaWrote, onChange: () => undefined, onOpenLink: ctx.openLink, search: async () => [] });
        bodySlot.replaceChildren(editor.content);
        allowChosenLinks();
      }
      return;
    }
    editor = createNoteEditor({
      markdown: body,
      // A link the owner turns into a Card, Mention or Embed here is remembered with the note, on the server.
      athenaWrote: athenaWrote && initial ? { onChoice: (url, mode) => void saveLinkChoice(resolveId(initial.id), url, mode) } : false,
      onChange(md) {
        body = md;
        scheduleSave();
        clearTimeout(linksTimer);
        linksTimer = setTimeout(() => void paintLinks(), 500);
      },
      onOpenLink: ctx.openLink,
      search: async (q, kinds) => (await searchEntities(q, kinds)).results,
      // '@' offers everything, as Ask's does (db/mentions.ts); '[[' stays notes.
      mentions: async (q) => (await import("../db/mentions")).findMentions(q),
      thumb: (row) => (row.thumb ? import("../db/mentions").then((m) => m.mentionThumb(row)) : null),
      create: isSampleMode() ? null : createEntity,
      // A line made a to-do links back to this note, so the to-do says where it came from.
      addTodo: (title) => addTodoFromNote(title, note ? resolveId(note.id) : null, titleInput.value.trim() || deriveTitle(markdownToText(body)) || "Untitled"),
      createNote: isSampleMode() ? null : createLinkedNote,
    });
    // Dictation: the mic sits at the end of the toolbar, and its recording bar
    // takes the toolbar's place (docked above the keyboard while writing).
    if (voiceSupported()) {
      voice = voiceButton({
        purpose: "note",
        host: toolbarSlot,
        className: "toolbar__btn",
        keepFocus: true,
        begin: () => {
          if (!editor) return null;
          const slot = editor.dictate();
          return { transcribing: slot.transcribing, text: slot.insert, abandon: slot.cancel };
        },
      });
      editor.toolbar.append(h("span", { class: "toolbar__sep", "aria-hidden": "true" }), voice.el);
    }
    toolbarSlot.replaceChildren(editor.toolbar);
    bodySlot.replaceChildren(editor.content);
    allowChosenLinks();
    if (ctx.autofocus) editor.focus();
  });
  void mountEditor();

  return {
    el,
    noteId: () => (note ? resolveId(note.id) : null),
    destroy() {
      void saveNow().finally(() => {
        dead = true;
      });
      clearTimeout(linksTimer);
      unnameTab();
      unresolved();
      unNotes();
      unFolders();
      window.removeEventListener("pagehide", onHide);
      localGraph?.destroy();
      custom.destroy();
      noteFiles.destroy();
      voice?.destroy();
      editor?.destroy();
      editor = null;
    },
  };
}

/** Mobile (and desktop compose): the note in a sheet. `null` = a new note. */
export function openNoteSheet(note: Note | null, opts: { openLink: (kind: EntityKind, id: string) => void; seed?: string; seedTitle?: string; keepSeed?: boolean; folder?: string | null }): void {
  const desktop = window.matchMedia("(min-width: 1024px)").matches;
  let view: NoteView | null = null;
  const sheet = openSheet({
    label: note ? noteParts(note).title : "New note",
    title: note ? undefined : "New note",
    body: h("div", {}),
    variant: !note && desktop ? "compose" : "tall",
    onClose: () => view?.destroy(),
  });
  view = noteView(note, {
    close: () => sheet.close(),
    openLink: (kind, id) => {
      // Following a link replaces this sheet rather than stacking sheets.
      sheet.close();
      setTimeout(() => opts.openLink(kind, id), 260);
    },
    autofocus: !note && !opts.keepSeed,
    seed: opts.seed,
    seedTitle: opts.seedTitle,
    keepSeed: opts.keepSeed,
    folder: opts.folder,
  });
  // A blank new note can start from a template instead (components/templates.ts).
  if (!note && !opts.seed) {
    const start = h("button", { class: "chip tpl-start", type: "button" }, icons.copy(), "Start from a template");
    start.addEventListener("click", () => {
      sheet.close();
      setTimeout(() => openTemplatePicker({ openLink: opts.openLink, openFilled: (n) => openNoteSheet(null, { openLink: opts.openLink, seed: n.body, seedTitle: n.title, keepSeed: true, folder: opts.folder }) }), 260);
    });
    view.el.querySelector(".note__bar")?.after(start);
  }
  sheet.dialog.querySelector(".sheet__scroll")!.replaceChildren(view.el);
}
