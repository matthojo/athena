/**
 * The note editor (lazy chunk — imported with `import()` from
 * components/note-detail.ts so Home doesn't pay for ProseMirror).
 *
 * WYSIWYG over Markdown: the body loads from and saves back to Markdown via
 * @tiptap/markdown, so notes.body stays plain Markdown for search, agents and
 * the Obsidian export. Two suggestion triggers insert athena:// links:
 *   '@'  people, places, organisations, events and the owner's own records
 *        ("Château Musar 2017 · Wine"), with "create" rows online, and
 *        "Paste a link" at the foot (link-menu.ts)
 *   '[[' other notes
 * Links show as a Mention, Link, Card or Embed (rich links: link-editor.ts
 * for pasting, the switcher, peeks and the context menu; link-nodes.ts and
 * athena-link.ts for the nodes). `readOnly` draws a note the same way
 * without editing.
 * The suggestion popover and toolbar are our own DOM, built with h() and the
 * app's tokens; nothing here sets innerHTML.
 */

import { Editor, Extension, type Range } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { mentionIcon } from "../components/mention-menu";
import { MENTION_KIND_LABEL, type MentionResult } from "../../../lib/mentions";
import { baseExtensions } from "./extensions";
import { TemplateBlanks } from "./template-blanks";
import { atMenu, type AtMenu, type AtRow } from "./link-menu";
import { RichLinks, afterInsert, insertWebLink } from "./link-editor";
import "../styles/rich-links.css";
import "../styles/note-blocks.css";
import { SlashMenu } from "./slash";
import { BlockHandle } from "./block-handle";
import { BLOCK_STYLES, BlockKeys, canMove, deleteBlock, duplicateBlock, moveBlock } from "./block-actions";
import { addLineToTodo, canAddTodo, TodoLines, type CreateTodo } from "./todo-line";
import { Dictation, beginDictation, type DictationSlot } from "./dictation";
import type { EntityKind, EntityRef } from "../types";
import { allowChosen, holdPreviewsIn, type OnLinkChoice } from "./link-view";
import type { LinkChoice } from "../../../lib/links";

export interface NoteEditorOptions {
  markdown: string;
  placeholder?: string;
  onChange: (markdown: string) => void;
  onOpenLink: (kind: EntityKind, id: string) => void;
  search: (query: string, kinds: EntityKind[]) => Promise<EntityRef[]>;
  /** '@' suggests everything (saved items, to-dos, Watch & read too) when given: db/mentions.ts. */
  mentions?: (query: string) => Promise<MentionResult[]>;
  /** A saved image or link's picture for its row. */
  thumb?: (row: MentionResult) => Promise<string | null> | null;
  /** Create a new entity from the @ popover; null when offline/sample. */
  create?: ((kind: "person" | "place" | "organisation", name: string) => Promise<EntityRef | null>) | null;
  /** Draw the note without editing (rich links still peek, play and open). */
  readOnly?: boolean;
  /**
   * The note wasn't written by the owner (a collection, the assistant, a Shortcut): its web links stay plain and
   * load no preview (editor/link-view.ts). `onChoice` hears each link the owner turns into a Card, Mention or Embed.
   */
  athenaWrote?: boolean | { onChoice: OnLinkChoice };
  /** Make a to-do from a line ("Add to To do" in the / and block menus). Absent where to-dos can't be made. */
  addTodo?: CreateTodo | null;
  /** Make a note from the [[ menu when none is called what you typed. Null offline or in sample data. */
  createNote?: ((title: string) => Promise<EntityRef | null>) | null;
}

export interface NoteEditorHandle {
  toolbar: HTMLElement;
  content: HTMLElement;
  getMarkdown: () => string;
  /** In a note Athena wrote: the owner's stored link choices have arrived, so those links load (editor/link-view.ts). */
  allowPreviews: (choices: LinkChoice[]) => void;
  focus: () => void;
  /** Mark the caret for dictated text (see dictation.ts). */
  dictate: () => DictationSlot;
  destroy: () => void;
}

const ENTITY_KINDS: EntityKind[] = ["person", "place", "organisation", "event", "project", "record"];

export const KIND_LABEL: Record<EntityKind, string> = {
  note: "Note",
  person: "Person",
  place: "Place",
  organisation: "Organisation",
  event: "Event",
  project: "Project",
  record: "Record",
};

/** What a row links to: an entity, or (from the mentions list) anything with a link kind. */
type LinkRef = Pick<MentionResult, "kind" | "id" | "title" | "subtitle" | "kind_id"> & { thumb?: Promise<string | null> | null };

type MenuItem =
  | { type: "ref"; ref: LinkRef }
  | { type: "create"; kind: "person" | "place" | "organisation" | "note"; name: string };

// ---------- Suggestion popover ----------

function suggestionRenderer(emptyText: string, editor: () => Editor) {
  return () => {
    let items: MenuItem[] = [];
    let props: SuggestionProps<MenuItem, MenuItem> | null = null;
    let menu: AtMenu | null = null;

    const rows = (): AtRow[] =>
      items.map((item) =>
        item.type === "create"
          ? { title: `New ${KIND_LABEL[item.kind].toLowerCase()} “${item.name}”`, sub: "Create and link", icon: "plus", kind: item.kind, create: true }
          : {
              title: item.ref.title,
              sub: item.ref.kind === "note" || !item.ref.subtitle ? MENTION_KIND_LABEL[item.ref.kind] : `${MENTION_KIND_LABEL[item.ref.kind]} · ${item.ref.subtitle}`,
              icon: mentionIcon(item.ref.kind, item.ref.kind_id),
              kind: item.ref.kind,
              thumb: item.ref.thumb ?? null,
            }
      );
    const place = () => {
      const rect = props?.clientRect?.();
      if (menu && rect) menu.place(rect);
    };
    const close = () => {
      menu?.remove();
      menu = null;
    };

    return {
      onStart(p: SuggestionProps<MenuItem, MenuItem>) {
        props = p;
        items = p.items;
        menu = atMenu({
          emptyText,
          onPick: (i) => props?.command(items[i]),
          // "Paste a link": the address goes in where the @ was, by position, and the switcher opens.
          onPaste: (url) => {
            if (!props) return;
            const ed = editor();
            const range = props.range;
            close();
            ed.commands.focus();
            afterInsert(ed, url, insertWebLink(ed, url, range));
          },
          onCancel: () => {
            close();
            editor().commands.focus();
          },
        });
        // Inside the open <dialog> when there is one, so it stays above the backdrop.
        (document.querySelector("dialog[open]") ?? document.body).append(menu.el);
        menu.set(rows(), p.query);
        place();
      },
      onUpdate(p: SuggestionProps<MenuItem, MenuItem>) {
        props = p;
        items = p.items;
        if (menu && !menu.pasting) menu.set(rows(), p.query);
        place();
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (!menu || menu.pasting) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          menu.move(event.key === "ArrowDown" ? 1 : -1);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          menu.pick();
          return true;
        }
        return false;
      },
      onExit() {
        // Moving into "Paste a link"'s field isn't leaving.
        if (menu?.pasting && menu.el.contains(document.activeElement)) return;
        close();
        props = null;
      },
    };
  };
}

function insertLink(editor: Editor, range: Range, ref: LinkRef) {
  const label = ref.kind === "note" ? ref.title : `@${ref.title}`;
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: "athenaLink", attrs: { kind: ref.kind, id: ref.id, label } },
      { type: "text", text: " " },
    ])
    .run();
}

function mentionExtension(opts: NoteEditorOptions) {
  return Extension.create({
    name: "athenaSuggestions",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const command = async ({ range, props }: { editor: Editor; range: Range; props: MenuItem }) => {
        if (props.type === "ref") return insertLink(editor, range, props.ref);
        const created = props.kind === "note" ? await opts.createNote?.(props.name) : await opts.create?.(props.kind, props.name);
        if (created) insertLink(editor, range, created);
      };
      return [
        Suggestion<MenuItem, MenuItem>({
          editor,
          pluginKey: new PluginKey("athenaMention"),
          // Not TipTap's default "suggestion": that's the Review inbox's card class, and it broke the line.
          decorationClass: "mention-query",
          char: "@",
          allowSpaces: true,
          debounce: 120,
          items: async ({ query }) => {
            const refs: LinkRef[] = opts.mentions
              ? (await opts.mentions(query.trim()).catch(() => [])).map((r) => ({ ...r, thumb: opts.thumb?.(r) ?? null }))
              : await opts.search(query, ENTITY_KINDS).catch(() => []);
            const out: MenuItem[] = refs.map((ref) => ({ type: "ref", ref }));
            const name = query.trim();
            const exact = refs.some((r) => r.title.toLowerCase() === name.toLowerCase());
            if (opts.create && name.length >= 2 && !exact) {
              for (const kind of ["person", "place", "organisation"] as const) out.push({ type: "create", kind, name });
            }
            return out;
          },
          command,
          render: suggestionRenderer("Type a name to link a person, place, event or anything you keep", () => editor),
        }),
        Suggestion<MenuItem, MenuItem>({
          editor,
          pluginKey: new PluginKey("athenaNoteLink"),
          decorationClass: "mention-query",
          char: "[[",
          allowSpaces: true,
          allowedPrefixes: null,
          debounce: 120,
          items: async ({ query }) => {
            const out: MenuItem[] = (await opts.search(query, ["note"]).catch(() => [])).map((ref) => ({ type: "ref" as const, ref }));
            // Nothing called that yet: make it, and link it, without leaving this note.
            const name = query.trim().replace(/\]+$/, "");
            if (opts.createNote && name.length >= 2 && !out.some((r) => r.type === "ref" && r.ref.title.trim().toLowerCase() === name.toLowerCase())) {
              out.push({ type: "create", kind: "note", name });
            }
            return out;
          },
          command,
          render: suggestionRenderer("Type to link another note", () => editor),
        }),
      ];
    },
  });
}

// ---------- Toolbar ----------

/** What the block menu offers beyond its styles, in the toolbar and on the margin grip (block-handle.ts). */
interface BlockAction {
  id: string;
  label: string;
  icon: IconName;
  run: (e: Editor) => void;
  danger?: boolean;
  /** Offered only when this says so. */
  when?: (e: Editor) => boolean;
}

function blockActions(addTodo: ((e: Editor) => void) | null): BlockAction[] {
  return [
    { id: "up", label: "Move up", icon: "arrowUp", run: (e) => moveBlock(e, -1), when: (e) => canMove(e, -1) },
    { id: "down", label: "Move down", icon: "arrowDown", run: (e) => moveBlock(e, 1), when: (e) => canMove(e, 1) },
    { id: "copy", label: "Duplicate", icon: "copy", run: (e) => duplicateBlock(e) },
    ...(addTodo ? [{ id: "todo", label: "Add to To do", icon: "check" as const, run: addTodo, when: (e: Editor) => canAddTodo(e) }] : []),
    { id: "delete", label: "Delete", icon: "trash", run: (e) => deleteBlock(e), danger: true },
  ];
}

function buildToolbar(editor: Editor, addTodo: ((e: Editor) => void) | null): { el: HTMLElement; update: () => void; destroy: () => void } {
  const styleLabel = h("span", { class: "toolbar__style-label" }, "Text");
  // A phone shows the block's icon in place of its name, so the bar fits beside the keyboard.
  const styleIcon = h("span", { class: "toolbar__style-icon", "aria-hidden": "true" }, icons.text());
  const styleBtn = h(
    "button",
    { class: "toolbar__style", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Style of this line, and more" },
    styleIcon,
    styleLabel,
    icons.chevronDown()
  );
  const styleMenu = h("div", { class: "menu toolbar__menu", role: "menu", hidden: true });
  const actions = blockActions(addTodo);

  const closeMenu = () => {
    styleMenu.hidden = true;
    styleBtn.setAttribute("aria-expanded", "false");
  };
  const item = (label: string, icon: IconName, run: () => void, extra: { checked?: boolean; danger?: boolean; short?: string } = {}) => {
    const b = h(
      "button",
      {
        class: `menu__item${extra.danger ? " menu__item--danger" : ""}${extra.short ? " menu__item--style" : ""}`,
        type: "button",
        role: extra.checked === undefined ? "menuitem" : "menuitemradio",
        "aria-checked": extra.checked === undefined ? undefined : String(extra.checked),
        "aria-label": extra.short ? label : undefined,
      },
      icons[icon](),
      // A phone's tiles use the short name (Bullets); a desk's rows the full one.
      extra.short ? h("span", { class: "menu__long" }, label) : label,
      extra.short ? h("span", { class: "menu__short", "aria-hidden": "true" }, extra.short) : null,
      extra.checked ? h("span", { class: "menu__check" }, icons.check()) : null
    );
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      closeMenu();
      run();
    });
    return b;
  };
  styleBtn.addEventListener("mousedown", (e) => e.preventDefault());
  styleBtn.addEventListener("click", () => {
    const open = styleMenu.hidden;
    styleMenu.hidden = !open;
    styleBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const offered = actions.filter((a) => !a.when || a.when(editor));
      styleMenu.replaceChildren(
        h("div", { class: "toolbar__styles", role: "group", "aria-label": "Turn into" }, ...BLOCK_STYLES.map((b) => item(b.label, b.icon, () => b.run(editor), { checked: b.isActive(editor), short: b.short }))),
        h("div", { class: "menu__sep", role: "separator" }),
        ...offered.map((a) => item(a.label, a.icon, () => a.run(editor), { danger: a.danger }))
      );
      // A keyboard starts on the current style; a finger doesn't need a focus ring.
      if (!window.matchMedia("(pointer: coarse)").matches) (styleMenu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus({ preventScroll: true });
    }
  });
  const onDocDown = (e: Event) => {
    if (!styleMenu.hidden && !styleMenu.contains(e.target as Node) && e.target !== styleBtn && !styleBtn.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener("pointerdown", onDocDown);
  styleMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
      editor.commands.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...styleMenu.querySelectorAll<HTMLElement>(".menu__item")];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    }
  });

  const tool = (label: string, icon: IconName, run: () => void, cls = "") => {
    const b = h("button", { class: `toolbar__btn ${cls}`.trim(), type: "button", "aria-label": label }, icons[icon]());
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", run);
    return b;
  };

  // + opens the / menu where the caret is: the one way in on a phone, and a visible one on a desk.
  const insert = tool("Add a heading, list, callout or more", "plus", () => {
    const { from } = editor.state.selection;
    const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, "\n", "\n") : "";
    editor.chain().focus().insertContent(before && !/\s/.test(before) ? " /" : "/").run();
  }, "toolbar__btn--insert");

  const mark = (name: string, label: string, glyph: string, cls: string, run: () => void) => {
    const b = h("button", { class: `toolbar__btn ${cls}`, type: "button", "aria-label": label, "aria-pressed": "false", "data-mark": name }, glyph);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", run);
    return b;
  };
  const marks = [
    mark("bold", "Bold", "B", "toolbar__btn--bold", () => editor.chain().focus().toggleBold().run()),
    mark("italic", "Italic", "I", "toolbar__btn--italic", () => editor.chain().focus().toggleItalic().run()),
    mark("underline", "Underline", "U", "toolbar__btn--underline", () => editor.chain().focus().toggleUnderline().run()),
    mark("strike", "Strikethrough", "S", "toolbar__btn--strike", () => editor.chain().focus().toggleStrike().run()),
  ];

  // In a list on a touch screen, where there's no Tab key: in and out.
  const itemType = () => (editor.isActive("taskItem") ? "taskItem" : "listItem");
  const outdent = tool("Move out a level", "outdent", () => editor.chain().focus().liftListItem(itemType()).run(), "toolbar__btn--list");
  const indent = tool("Move in a level", "indent", () => editor.chain().focus().sinkListItem(itemType()).run(), "toolbar__btn--list");
  const listGroup = h("div", { class: "toolbar__group toolbar__group--list", hidden: true }, h("span", { class: "toolbar__sep", "aria-hidden": "true" }), outdent, indent);

  const at = h("button", { class: "toolbar__btn", type: "button", "aria-label": "Mention a person, place, organisation or event" }, icons.at());
  at.addEventListener("mousedown", (e) => e.preventDefault());
  at.addEventListener("click", () => {
    const { from } = editor.state.selection;
    const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, "\n", "\n") : "";
    editor.chain().focus().insertContent(before && !/\s/.test(before) ? " @" : "@").run();
  });

  const el = h(
    "div",
    { class: "toolbar", role: "toolbar", "aria-label": "Formatting" },
    insert,
    h("div", { class: "toolbar__group toolbar__style-wrap" }, styleBtn, styleMenu),
    h("span", { class: "toolbar__sep", "aria-hidden": "true" }),
    h("div", { class: "toolbar__group" }, ...marks),
    listGroup,
    h("span", { class: "toolbar__sep", "aria-hidden": "true" }),
    at
  );

  const update = () => {
    const style = BLOCK_STYLES.find((b) => b.isActive(editor)) ?? BLOCK_STYLES[0];
    styleLabel.textContent = style.label;
    styleIcon.replaceChildren(icons[style.icon]());
    for (const b of marks) b.setAttribute("aria-pressed", String(editor.isActive(b.dataset.mark!)));
    const inList = editor.isActive("listItem") || editor.isActive("taskItem");
    listGroup.hidden = !inList;
    outdent.toggleAttribute("disabled", !editor.can().liftListItem(itemType()));
    indent.toggleAttribute("disabled", !editor.can().sinkListItem(itemType()));
  };

  return { el, update, destroy: () => document.removeEventListener("pointerdown", onDocDown) };
}

// ---------- Factory ----------

export function createNoteEditor(opts: NoteEditorOptions): NoteEditorHandle {
  const content = h("div", { class: opts.readOnly ? "editor editor--read" : "editor" });
  if (opts.athenaWrote) holdPreviewsIn(content, typeof opts.athenaWrote === "object" ? opts.athenaWrote : {});
  let lastMarkdown = opts.markdown;
  const readOnly = !!opts.readOnly;

  const create = opts.addTodo;
  const addTodo = create && !readOnly ? (e: Editor) => void addLineToTodo(e, create) : null;
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const start = opts.placeholder ?? "Start writing… type @ to mention someone, [[ to link a note";

  const editor = new Editor({
    element: content,
    editable: !readOnly,
    extensions: [
      ...baseExtensions(),
      RichLinks.configure({ onOpenLink: opts.onOpenLink }),
      TemplateBlanks,
      TodoLines,
      ...(readOnly
        ? []
        : [
            Placeholder.configure({
              includeChildren: true,
              // An empty note says how to start; the empty line you're on says / is there (on a desk: a phone has the +); a toggle's title asks for one.
              placeholder: ({ editor: ed, node, pos }) => {
                if (node.type.name === "calloutTitle") return ed.state.doc.resolve(pos).parent.attrs.fold ? "Toggle" : "Title";
                if (ed.isEmpty) return start;
                return fine && node.type.name === "paragraph" && ed.state.doc.resolve(pos).depth === 0 ? "Type / for headings, lists, callouts and more" : "";
              },
            }),
            mentionExtension(opts),
            Dictation,
            SlashMenu.configure({ addTodo }),
            BlockHandle.configure({ addTodo }),
            BlockKeys,
          ]),
    ],
    content: opts.markdown,
    contentType: "markdown",
    editorProps: {
      attributes: readOnly
        ? { class: "editor__content", "aria-label": "Note body", "aria-readonly": "true" }
        : { class: "editor__content", "aria-label": "Note body", "aria-multiline": "true", role: "textbox", spellcheck: "true" },
    },
  });

  const toolbar = buildToolbar(editor, addTodo);
  editor.on("transaction", toolbar.update);
  editor.on("update", () => {
    const md = editor.getMarkdown();
    // An empty last line (after a Card or Embed) isn't an edit.
    if (md === lastMarkdown || md.trimEnd() === lastMarkdown.trimEnd()) return;
    lastMarkdown = md;
    opts.onChange(md);
  });

  toolbar.update();
  return {
    toolbar: toolbar.el,
    content,
    getMarkdown: () => editor.getMarkdown(),
    allowPreviews: (choices) => allowChosen(content, choices),
    focus: () => editor.commands.focus("end"),
    dictate: () => beginDictation(editor),
    destroy: () => {
      toolbar.destroy();
      editor.destroy();
    },
  };
}
