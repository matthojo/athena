/**
 * The margin grip on a desk: a faint six-dot handle beside the block under
 * the pointer. It isn't there while you type, only when you move the mouse.
 *
 *   click        the block menu: Turn into, Move up and down, Duplicate,
 *                Add to To do, Delete
 *   drag         move the block; a line shows where it will land
 *
 * Touch screens have no hover, so phones use the toolbar's block menu
 * (editor.ts) for the same things, and no grip is drawn there.
 */

import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openContextMenu, type MenuGroup } from "../components/context-menu";
import { lineCanBeTodo } from "./todo-line";
import { blockAtResolved, BLOCK_STYLES, canMove, deleteBlock, duplicateBlock, moveBlock, type BlockAt } from "./block-actions";

export interface BlockHandleOptions {
  /** "Add to To do" for the line, when to-dos can be made here. */
  addTodo?: ((editor: Editor) => void) | null;
}

const fine = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** The block menu's entries for `b`, shared by the grip and Shift+F10 on a selected block. */
export function blockMenuGroups(editor: Editor, b: BlockAt, opts: BlockHandleOptions): MenuGroup[] {
  const select = () => {
    // Put the caret in the block's first line, so Turn into and Add to To do act on it.
    const inside = TextSelection.near(editor.state.doc.resolve(Math.min(b.pos + 1, editor.state.doc.content.size)));
    editor.view.dispatch(editor.state.tr.setSelection(inside));
    editor.view.focus();
  };
  // Asked of the block's first line, which is what Add to To do turns into one.
  let first = b.node;
  while (!first.isTextblock && first.firstChild) first = first.firstChild;
  const todoOk = !!opts.addTodo && lineCanBeTodo(first);
  return [
    [
      {
        id: "turn",
        label: "Turn into",
        icon: "text",
        submenu: [
          BLOCK_STYLES.map((s) => ({
            id: s.id,
            label: s.label,
            icon: s.icon,
            run: () => {
              select();
              s.run(editor);
            },
          })),
        ],
      },
    ],
    [
      { id: "up", label: "Move up", icon: "arrowUp", shortcut: "⌥⇧↑", disabled: !canMove(editor, -1, b), run: () => moveBlock(editor, -1, b) },
      { id: "down", label: "Move down", icon: "arrowDown", shortcut: "⌥⇧↓", disabled: !canMove(editor, 1, b), run: () => moveBlock(editor, 1, b) },
      { id: "copy", label: "Duplicate", icon: "copy", shortcut: "⌘D", run: () => duplicateBlock(editor, b) },
      ...(todoOk
        ? [
            {
              id: "todo",
              label: "Add to To do",
              icon: "check" as const,
              run: () => {
                select();
                opts.addTodo?.(editor);
              },
            },
          ]
        : []),
    ],
    [{ id: "delete", label: "Delete", icon: "trash", destructive: true, run: () => deleteBlock(editor, b) }],
  ];
}

/**
 * What the grip moves: a whole block at the top of the note (a callout, a
 * quote, a table, a list's line), never a line inside a callout or a quote,
 * so dragging a callout takes all of it.
 */
function gripBlock($pos: import("@tiptap/pm/model").ResolvedPos): BlockAt | null {
  const b = blockAtResolved($pos);
  if (!b) return null;
  const $b = $pos.doc.resolve(b.pos);
  if ($b.depth === 0) return b;
  // A list's line, in a list at the top of the note, keeps its own grip.
  if ((b.node.type.name === "listItem" || b.node.type.name === "taskItem") && $b.depth === 1) return b;
  return { pos: $b.before(1), node: $b.node(1), parent: $pos.doc, index: $b.index(0) };
}

/** What the menu is about, in words: "Callout", "Table", "Heading 2". */
function partName(b: BlockAt): string {
  const n = b.node;
  if (n.type.name === "heading") return `Heading ${n.attrs.level}`;
  if (n.type.name === "callout") return n.attrs.fold ? "Toggle" : "Callout";
  const names: Record<string, string> = { paragraph: "Text", bulletList: "Bulleted list", orderedList: "Numbered list", taskList: "Checklist", listItem: "List line", taskItem: "Checklist line", blockquote: "Quote", codeBlock: "Code", table: "Table", horizontalRule: "Divider", linkBlock: "Link" };
  return names[n.type.name] ?? "This part";
}

function handlePlugin(editor: Editor, opts: BlockHandleOptions) {
  return new Plugin({
    key: new PluginKey("blockHandle"),
    view(view: EditorView) {
      const host = view.dom.parentElement;
      if (!host || !view.editable) return {};
      host.classList.add("editor--handles");
      const grip = h("button", { class: "block-grip", type: "button", draggable: "true", "aria-label": "Drag to move, or click for more", tabindex: "-1", hidden: true }, icons.grip()) as HTMLButtonElement;
      host.append(grip);
      let current: BlockAt | null = null;
      let menuOpen = false;

      const hide = () => {
        if (menuOpen) return;
        grip.hidden = true;
        current = null;
      };

      const show = (b: BlockAt) => {
        const dom = view.nodeDOM(b.pos) as HTMLElement | null;
        if (!dom || !(dom instanceof HTMLElement)) return hide();
        current = b;
        const box = host.getBoundingClientRect();
        // Beside the block's first line: its text's line for words, its top edge for a table or a divider.
        let mid: number;
        if (b.node.isTextblock || b.node.firstChild?.isTextblock || b.node.type.name === "callout") {
          const at = Math.min(b.pos + (b.node.isTextblock ? 1 : 2), view.state.doc.content.size);
          const c = view.coordsAtPos(at);
          mid = (c.top + c.bottom) / 2;
        } else {
          const r = dom.getBoundingClientRect();
          mid = r.top + Math.min(r.height / 2, 16);
        }
        grip.style.top = `${Math.round(mid - box.top - 13)}px`;
        grip.hidden = false;
      };

      const onMove = (e: MouseEvent) => {
        if (menuOpen || !fine() || !view.editable) return;
        if (e.target === grip || grip.contains(e.target as Node)) return;
        const content = view.dom.getBoundingClientRect();
        // In the margin too: read the line at the pointer's height, just inside the text.
        const hit = view.posAtCoords({ left: Math.max(e.clientX, content.left + 8), top: e.clientY });
        if (!hit) return hide();
        const b = gripBlock(view.state.doc.resolve(hit.inside >= 0 ? hit.inside + 1 : hit.pos));
        if (!b) return hide();
        if (current && current.pos === b.pos && !grip.hidden) return;
        show(b);
      };

      const openMenu = () => {
        if (!current) return;
        const b = current;
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, b.pos)));
        menuOpen = true;
        grip.classList.add("is-active");
        openContextMenu(
          { label: partName(b), groups: blockMenuGroups(editor, b, opts) },
          {
            anchor: grip,
            by: "mouse",
            onClose: () => {
              // Picked nothing, or something that kept the block: back to writing in it, not a selected block.
              const sel = view.state.selection;
              if (sel instanceof NodeSelection && sel.from === b.pos && view.state.doc.nodeAt(b.pos) === b.node) {
                view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(b.pos + 1))));
              }
              menuOpen = false;
              grip.classList.remove("is-active");
              hide();
            },
          }
        );
      };

      grip.addEventListener("mousedown", (e) => e.stopPropagation());
      grip.addEventListener("click", (e) => {
        e.preventDefault();
        openMenu();
      });
      grip.addEventListener("dragstart", (e) => {
        if (!current || !e.dataTransfer) return;
        const sel = NodeSelection.create(view.state.doc, current.pos);
        view.dispatch(view.state.tr.setSelection(sel));
        const slice = sel.content();
        const { dom, text } = view.serializeForClipboard(slice);
        e.dataTransfer.clearData();
        e.dataTransfer.setData("text/html", dom.innerHTML);
        e.dataTransfer.setData("text/plain", text);
        e.dataTransfer.effectAllowed = "move";
        const blockDom = view.nodeDOM(current.pos);
        if (blockDom instanceof HTMLElement) e.dataTransfer.setDragImage(blockDom, 0, 12);
        view.dragging = { slice, move: true };
        host.classList.add("is-dragging");
      });
      grip.addEventListener("dragend", () => {
        host.classList.remove("is-dragging");
        hide();
      });

      host.addEventListener("mousemove", onMove);
      host.addEventListener("mouseleave", hide);
      // Typing puts it away until the mouse moves again.
      view.dom.addEventListener("keydown", hide);

      return {
        update() {
          if (!grip.hidden && current && !menuOpen) {
            // The document moved under it: find the block again on the next mouse move.
            const n = view.state.doc.nodeAt(current.pos);
            if (n !== current.node) hide();
          }
        },
        destroy() {
          host.removeEventListener("mousemove", onMove);
          host.removeEventListener("mouseleave", hide);
          view.dom.removeEventListener("keydown", hide);
          host.classList.remove("editor--handles");
          grip.remove();
        },
      };
    },
  });
}

export const BlockHandle = Extension.create<BlockHandleOptions>({
  name: "blockHandle",
  addOptions() {
    return { addTodo: null };
  },
  addProseMirrorPlugins() {
    return [handlePlugin(this.editor, this.options)];
  },
});
