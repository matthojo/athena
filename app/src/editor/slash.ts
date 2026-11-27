/**
 * The / menu: every block a note can hold, and the things from Athena you can
 * put in one, in a single list you can search in your own words ("box" finds
 * Callout, "line" finds Divider). Typing after the / filters it; Up and Down
 * move, Enter or Tab picks, Esc closes. On a desk each row shows the Markdown
 * that does the same ("##", "---"), so the faster way is learnt by using it.
 *
 * It opens after a space or at the start of a line, so a slash in a date or a
 * path doesn't, and it stays shut when nothing matches. On a phone the
 * toolbar's + types the / for you (editor.ts), and the list rises as a sheet.
 *
 * Card and Embed ask for an address in the same menu (link-menu.ts), so
 * /card and /embed work as they did.
 */

import { Extension, type Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import type { IconName } from "../components/icons";
import { atMenu, type AtMenu, type AtRow } from "./link-menu";
import { afterInsert, insertWebLink } from "./link-editor";
import { NO_PLAYER, pasteMode } from "./link-model";
import { isEmbeddable } from "../../../lib/embeds";
import { canAddTodo } from "./todo-line";

export interface SlashOptions {
  /** "Add to To do" turns the line you're on into a to-do. Absent where a to-do can't be made (a record's notes). */
  addTodo?: ((editor: Editor) => void) | null;
}

interface SlashItem {
  id: string;
  title: string;
  sub: string;
  icon: IconName;
  section: "Write" | "From Athena" | "From the web";
  /** Other words people use for it. */
  words: string;
  hint?: string;
  /** Run once the "/query" is gone. Card and Embed ask for an address instead. */
  run?: (editor: Editor) => void;
  paste?: "card" | "embed";
  /** Only offered when this says so. */
  when?: (editor: Editor) => boolean;
}

function items(opts: SlashOptions): SlashItem[] {
  const write: SlashItem[] = [
    { id: "text", title: "Text", sub: "Plain writing", icon: "text", section: "Write", words: "paragraph plain body normal", run: (e) => e.chain().focus().setParagraph().run() },
    { id: "h1", title: "Heading 1", sub: "A big section heading", icon: "heading1", section: "Write", words: "title h1 big large section", hint: "#", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
    { id: "h2", title: "Heading 2", sub: "A medium heading", icon: "heading2", section: "Write", words: "subtitle h2 medium section", hint: "##", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
    { id: "h3", title: "Heading 3", sub: "A small heading", icon: "heading3", section: "Write", words: "h3 small subheading", hint: "###", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
    { id: "ul", title: "Bulleted list", sub: "Points, one to a line", icon: "listBullet", section: "Write", words: "bullets unordered points dots", hint: "-", run: (e) => e.chain().focus().toggleBulletList().run() },
    { id: "ol", title: "Numbered list", sub: "A list in order", icon: "listNumber", section: "Write", words: "ordered numbers steps sequence", hint: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: "check", title: "Checklist", sub: "Lines to tick off", icon: "checklist", section: "Write", words: "tasks tick boxes checkbox todo list", hint: "[ ]", run: (e) => e.chain().focus().toggleTaskList().run() },
    { id: "quote", title: "Quote", sub: "Someone else's words", icon: "quote", section: "Write", words: "blockquote citation said", hint: ">", run: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: "callout", title: "Callout", sub: "Words that stand out, in a box", icon: "callout", section: "Write", words: "box aside note tip warning info highlight panel important", run: (e) => e.chain().focus().setCallout().run() },
    { id: "toggle", title: "Toggle", sub: "A line that opens to show more", icon: "fold", section: "Write", words: "fold collapse expand hide details disclosure spoiler accordion", run: (e) => e.chain().focus().setCallout({ fold: "-" }).run() },
    { id: "table", title: "Table", sub: "Rows and columns", icon: "table", section: "Write", words: "grid columns rows spreadsheet", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "divider", title: "Divider", sub: "A line between parts", icon: "divider", section: "Write", words: "line rule separator break hr horizontal", hint: "---", run: (e) => e.chain().focus().setHorizontalRule().run() },
    { id: "code", title: "Code", sub: "Text exactly as typed", icon: "code", section: "Write", words: "snippet monospace pre preformatted", hint: "```", run: (e) => e.chain().focus().setCodeBlock().run() },
  ];
  const athena: SlashItem[] = [
    { id: "mention", title: "Mention", sub: "A person, place or anything you keep", icon: "at", section: "From Athena", words: "person people place link someone at", hint: "@", run: (e) => e.chain().focus().insertContent("@").run() },
    { id: "note", title: "Link a note", sub: "Another of your notes", icon: "note", section: "From Athena", words: "page note wiki backlink reference", hint: "[[", run: (e) => e.chain().focus().insertContent("[[").run() },
    ...(opts.addTodo
      ? [
          {
            id: "todo",
            title: "Add to To do",
            sub: "Tick it here or in To do",
            icon: "check" as const,
            section: "From Athena" as const,
            words: "todo task remind action commitment do",
            run: opts.addTodo,
            when: (e: Editor) => canAddTodo(e, /(^|\s)\/\S*/),
          },
        ]
      : []),
    { id: "card", title: "Card", sub: "A link as a card, with its picture", icon: "image", section: "From the web", words: "link url bookmark preview web page", paste: "card" },
    { id: "embed", title: "Embed", sub: "A video, song, map or design to play here", icon: "play", section: "From the web", words: "video youtube music spotify map figma player", paste: "embed" },
  ];
  return [...write, ...athena];
}

/** How well a row matches what's typed: 0 is no match. */
function score(item: SlashItem, q: string): number {
  if (!q) return 1;
  const title = item.title.toLowerCase();
  if (title.startsWith(q)) return 5;
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 4;
  if (item.id.startsWith(q)) return 3;
  const words = item.words.split(/\s+/);
  if (words.includes(q)) return 2.5;
  if (words.some((w) => w.startsWith(q))) return 2;
  if (title.includes(q) || item.hint === q) return 1;
  return 0;
}

export function filterSlash(all: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all
    .map((item, i) => ({ item, s: score(item, q), i }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.item);
}

function slashRenderer(editor: Editor) {
  return () => {
    let menu: AtMenu | null = null;
    let props: SuggestionProps<SlashItem, SlashItem> | null = null;
    let list: SlashItem[] = [];
    let chosen: "card" | "embed" | null = null;

    const close = () => {
      menu?.remove();
      menu = null;
    };

    const submit = (url: string) => {
      if (!props) return;
      const mode = chosen ?? (pasteMode(url, "empty-line") as "card" | "embed");
      if (mode === "embed" && !isEmbeddable(url)) {
        menu?.el.querySelector(".rl-menu__err")?.replaceChildren(NO_PLAYER);
        return;
      }
      const range = props.range;
      close();
      editor.commands.focus();
      afterInsert(editor, url, insertWebLink(editor, url, range, mode));
    };

    const rows = (): AtRow[] => list.map((i) => ({ title: i.title, sub: i.sub, icon: i.icon, kind: "block", section: i.section, hint: i.hint }));

    const draw = (p: SuggestionProps<SlashItem, SlashItem>) => {
      props = p;
      list = p.items;
      if (!menu || menu.pasting) return;
      menu.set(rows(), p.query);
      // Nothing matches (a date, a path, or a word that isn't a block): no menu.
      menu.el.hidden = !list.length;
      const r = p.clientRect?.();
      if (r) menu.place(r);
    };

    return {
      onStart(p: SuggestionProps<SlashItem, SlashItem>) {
        menu = atMenu({
          emptyText: "",
          paste: false,
          label: "Add to the note",
          onPick: (i) => {
            const item = list[i];
            if (!item || !props) return;
            if (item.paste) {
              chosen = item.paste;
              menu?.startPaste(item.paste === "card" ? "Paste a link to show as a card" : "Paste a link to show as an embed");
              return;
            }
            const range = props.range;
            close();
            editor.chain().focus().deleteRange(range).run();
            item.run?.(editor);
          },
          onPaste: submit,
          onCancel: () => {
            close();
            editor.commands.focus();
          },
        });
        menu.el.classList.add("rl-menu--slash");
        (document.querySelector("dialog[open]") ?? document.body).append(menu.el);
        draw(p);
      },
      onUpdate: draw,
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (!menu || menu.pasting || !list.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          menu.move(event.key === "ArrowDown" ? 1 : -1);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          menu.pick();
          return true;
        }
        if (event.key === "Escape") {
          close();
          return true;
        }
        return false;
      },
      onExit() {
        // Leaving for the address field isn't leaving.
        if (menu?.pasting && menu.el.contains(document.activeElement)) return;
        close();
        props = null;
        chosen = null;
      },
    };
  };
}

export const SlashMenu = Extension.create<SlashOptions>({
  name: "slashMenu",

  addOptions() {
    return { addTodo: null };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const all = items(this.options);
    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        decorationClass: "mention-query",
        // Not inside code, where a / is just a /.
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterSlash(all, query).filter((i) => !i.when || i.when(editor)),
        command: () => undefined,
        render: slashRenderer(editor),
      }),
    ];
  },
});

