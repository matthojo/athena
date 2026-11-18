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
  | { type: "create"; kind: "person" | "place" | "organisation"; name: string };

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
        const created = await opts.create?.(props.kind, props.name);
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
          items: async ({ query }) =>
            (await opts.search(query, ["note"]).catch(() => [])).map((ref) => ({ type: "ref" as const, ref })),
          command,
          render: suggestionRenderer("Type to link another note", () => editor),
        }),
      ];
    },
  });
}

// ---------- Toolbar ----------

type BlockStyle = { id: string; label: string; icon: IconName; isActive: (e: Editor) => boolean; run: (e: Editor) => void };

const BLOCKS: BlockStyle[] = [
  { id: "p", label: "Text", icon: "text", isActive: (e) => e.isActive("paragraph") && !e.isActive("listItem") && !e.isActive("taskItem"), run: (e) => e.chain().focus().setParagraph().run() },
  { id: "h1", label: "Heading 1", icon: "heading", isActive: (e) => e.isActive("heading", { level: 1 }), run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", icon: "heading", isActive: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", icon: "heading", isActive: (e) => e.isActive("heading", { level: 3 }), run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { id: "ul", label: "Bulleted list", icon: "listBullet", isActive: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", label: "Numbered list", icon: "listNumber", isActive: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", label: "Checklist", icon: "checklist", isActive: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
];

function buildToolbar(editor: Editor): { el: HTMLElement; update: () => void; destroy: () => void } {
  const styleLabel = h("span", {}, "Text");
  const styleBtn = h(
    "button",
    { class: "toolbar__style", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Text style" },
    styleLabel,
    icons.chevronDown()
  );
  const styleMenu = h("div", { class: "menu toolbar__menu", role: "menu", hidden: true });

  const closeMenu = () => {
    styleMenu.hidden = true;
    styleBtn.setAttribute("aria-expanded", "false");
  };
  styleBtn.addEventListener("mousedown", (e) => e.preventDefault());
  styleBtn.addEventListener("click", () => {
    const open = styleMenu.hidden;
    styleMenu.hidden = !open;
    styleBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      styleMenu.replaceChildren(
        ...BLOCKS.map((b) => {
          const item = h(
            "button",
            { class: "menu__item", type: "button", role: "menuitemradio", "aria-checked": String(b.isActive(editor)) },
            icons[b.icon](),
            b.label,
            b.isActive(editor) ? h("span", { class: "menu__check" }, icons.check()) : null
          );
          item.addEventListener("mousedown", (e) => e.preventDefault());
          item.addEventListener("click", () => {
            b.run(editor);
            closeMenu();
          });
          return item;
        })
      );
      (styleMenu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus({ preventScroll: true });
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
    }
  });

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
    h("div", { class: "toolbar__group toolbar__style-wrap" }, styleBtn, styleMenu),
    h("span", { class: "toolbar__sep", "aria-hidden": "true" }),
    h("div", { class: "toolbar__group" }, ...marks),
    h("span", { class: "toolbar__sep", "aria-hidden": "true" }),
    at
  );

  const update = () => {
    styleLabel.textContent = BLOCKS.find((b) => b.isActive(editor))?.label ?? "Text";
    for (const b of marks) b.setAttribute("aria-pressed", String(editor.isActive(b.dataset.mark!)));
  };

  return { el, update, destroy: () => document.removeEventListener("pointerdown", onDocDown) };
}

// ---------- Factory ----------

export function createNoteEditor(opts: NoteEditorOptions): NoteEditorHandle {
  const content = h("div", { class: opts.readOnly ? "editor editor--read" : "editor" });
  if (opts.athenaWrote) holdPreviewsIn(content, typeof opts.athenaWrote === "object" ? opts.athenaWrote : {});
  let lastMarkdown = opts.markdown;
  const readOnly = !!opts.readOnly;

  const editor = new Editor({
    element: content,
    editable: !readOnly,
    extensions: [
      ...baseExtensions(),
      RichLinks.configure({ onOpenLink: opts.onOpenLink }),
      TemplateBlanks,
      ...(readOnly
        ? []
        : [Placeholder.configure({ placeholder: opts.placeholder ?? "Start writing… type @ to mention someone, [[ to link a note" }), mentionExtension(opts), Dictation]),
    ],
    content: opts.markdown,
    contentType: "markdown",
    editorProps: {
      attributes: readOnly
        ? { class: "editor__content", "aria-label": "Note body", "aria-readonly": "true" }
        : { class: "editor__content", "aria-label": "Note body", "aria-multiline": "true", role: "textbox", spellcheck: "true" },
    },
  });

  const toolbar = buildToolbar(editor);
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
