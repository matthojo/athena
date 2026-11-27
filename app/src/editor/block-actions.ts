/**
 * What you can do to the block you're in, wherever you ask from: the
 * toolbar's block menu, the margin grip on a desk (block-handle.ts) and the
 * keys (⌥⇧↑ and ⌥⇧↓ move it).
 *
 * "The block" is the line you're on, with what belongs to it: a list item
 * with its nested items, a callout's line inside the callout, a whole table
 * from any cell, a whole callout from its title.
 */

import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { IconName } from "../components/icons";

export interface BlockAt {
  pos: number;
  node: PMNode;
  /** Its parent and where it sits there, for moving. */
  parent: PMNode;
  index: number;
}

const ITEMS = new Set(["listItem", "taskItem"]);

/** The block at a resolved position (see the top of the file). */
export function blockAtResolved($pos: ResolvedPos): BlockAt | null {
  let d = $pos.depth;
  // A node selection of a block (a grip pick, a divider) is that block.
  const after = $pos.nodeAfter;
  if (after && after.isBlock && d >= 0 && !$pos.parent.isTextblock) return { pos: $pos.pos, node: after, parent: $pos.parent, index: $pos.index() };
  if (d === 0) return null;
  let pick = d;
  for (let i = d; i > 0; i--) {
    const n = $pos.node(i);
    if (ITEMS.has(n.type.name) || n.type.name === "table") {
      pick = i;
      break;
    }
    if (n.type.name === "calloutTitle") {
      pick = i - 1;
      break;
    }
    if (n.isTextblock) pick = i;
  }
  if (pick < 1) return null;
  return { pos: $pos.before(pick), node: $pos.node(pick), parent: $pos.node(pick - 1), index: $pos.index(pick - 1) };
}

export function currentBlock(editor: Editor): BlockAt | null {
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock) {
    const $pos = editor.state.doc.resolve(sel.from);
    return { pos: sel.from, node: sel.node, parent: $pos.parent, index: $pos.index() };
  }
  return blockAtResolved(sel.$from);
}

/** Where the caret was inside the block, kept across a move or a copy. */
function offsetIn(editor: Editor, b: BlockAt): number {
  const { from } = editor.state.selection;
  return Math.max(0, Math.min(from - b.pos, b.node.nodeSize - 1));
}

/** The block that would move and the neighbour it passes: at the end of a callout, quote or list (or under a callout's title) it's what holds it. */
function moveTarget(editor: Editor, dir: -1 | 1, b: BlockAt | null): { b: BlockAt; other: PMNode } | null {
  if (!b) return null;
  const swapIndex = b.index + dir;
  const other = swapIndex >= 0 && swapIndex < b.parent.childCount ? b.parent.child(swapIndex) : null;
  if (other && other.type.name !== "calloutTitle") return { b, other };
  const $b = editor.state.doc.resolve(b.pos);
  if ($b.depth === 0) return null;
  return moveTarget(editor, dir, { pos: $b.before($b.depth), node: $b.parent, parent: $b.node($b.depth - 1), index: $b.index($b.depth - 1) });
}

/** Whether the block can move that way at all. */
export const canMove = (editor: Editor, dir: -1 | 1, b = currentBlock(editor)): boolean => !!moveTarget(editor, dir, b);

/** Move the block up (-1) or down (1) past its neighbour. Returns false at the top or the bottom of the note. */
export function moveBlock(editor: Editor, dir: -1 | 1, start = currentBlock(editor)): boolean {
  const target = moveTarget(editor, dir, start);
  if (!target) return false;
  const { b, other } = target;
  const wasNode = editor.state.selection instanceof NodeSelection;
  const offset = offsetIn(editor, b);
  const tr = editor.state.tr;
  let at: number;
  if (dir === -1) {
    const otherPos = b.pos - other.nodeSize;
    tr.delete(b.pos, b.pos + b.node.nodeSize).insert(otherPos, b.node);
    at = otherPos;
  } else {
    const otherEnd = b.pos + b.node.nodeSize + other.nodeSize;
    tr.insert(otherEnd, b.node).delete(b.pos, b.pos + b.node.nodeSize);
    at = otherEnd - b.node.nodeSize;
  }
  tr.setSelection(wasNode ? NodeSelection.create(tr.doc, at) : TextSelection.near(tr.doc.resolve(at + offset)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** A copy of the block just after it, with the caret in the copy. */
export function duplicateBlock(editor: Editor, b = currentBlock(editor)): boolean {
  if (!b || b.node.type.name === "calloutTitle") return false;
  const offset = offsetIn(editor, b);
  const end = b.pos + b.node.nodeSize;
  const tr = editor.state.tr.insert(end, b.node.copy(b.node.content));
  tr.setSelection(TextSelection.near(tr.doc.resolve(end + Math.max(1, offset))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Remove the block; the caret goes to the line that takes its place. */
export function deleteBlock(editor: Editor, b = currentBlock(editor)): boolean {
  if (!b) return false;
  const { state } = editor;
  const tr = state.tr;
  if (b.parent.childCount === 1) {
    // The only block in a list, quote or callout: take its holder too, rather than leave it empty.
    const $pos = state.doc.resolve(b.pos);
    if ($pos.depth >= 1) {
      const holder = $pos.before($pos.depth);
      tr.delete(holder, holder + $pos.parent.nodeSize);
    } else tr.replaceWith(b.pos, b.pos + b.node.nodeSize, state.schema.nodes.paragraph.create());
  } else tr.delete(b.pos, b.pos + b.node.nodeSize);
  if (!tr.doc.childCount) tr.insert(0, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.mapping.map(b.pos), tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

// ---------- Turn into ----------

export interface BlockStyle {
  id: string;
  label: string;
  /** For a tile in the phone's block menu. */
  short: string;
  icon: IconName;
  isActive: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const inCallout = (e: Editor, toggle: boolean) => {
  const { $from } = e.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "callout") return (n.attrs.fold !== null) === toggle;
  }
  return false;
};

/** Leave any list, quote or callout first, so "Heading 1" on a bullet makes a heading, not a bulleted heading. */
const plain = (e: Editor) => {
  const c = e.chain().focus();
  if (e.isActive("bulletList")) c.toggleBulletList();
  else if (e.isActive("orderedList")) c.toggleOrderedList();
  else if (e.isActive("taskList")) c.toggleTaskList();
  if (e.isActive("blockquote")) c.lift("blockquote");
  return c;
};

export const BLOCK_STYLES: BlockStyle[] = [
  { id: "p", short: "Text", label: "Text", icon: "text", isActive: (e) => e.isActive("paragraph") && !e.isActive("listItem") && !e.isActive("taskItem") && !e.isActive("blockquote") && !e.isActive("callout"), run: (e) => plain(e).setParagraph().run() },
  { id: "h1", short: "Heading 1", label: "Heading 1", icon: "heading1", isActive: (e) => e.isActive("heading", { level: 1 }), run: (e) => plain(e).setHeading({ level: 1 }).run() },
  { id: "h2", short: "Heading 2", label: "Heading 2", icon: "heading2", isActive: (e) => e.isActive("heading", { level: 2 }), run: (e) => plain(e).setHeading({ level: 2 }).run() },
  { id: "h3", short: "Heading 3", label: "Heading 3", icon: "heading3", isActive: (e) => e.isActive("heading", { level: 3 }), run: (e) => plain(e).setHeading({ level: 3 }).run() },
  { id: "ul", short: "Bullets", label: "Bulleted list", icon: "listBullet", isActive: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", short: "Numbers", label: "Numbered list", icon: "listNumber", isActive: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "todo", short: "Checklist", label: "Checklist", icon: "checklist", isActive: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: "quote", short: "Quote", label: "Quote", icon: "quote", isActive: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "callout", short: "Callout", label: "Callout", icon: "callout", isActive: (e) => inCallout(e, false), run: (e) => (inCallout(e, false) ? undefined : void e.chain().focus().setCallout().run()) },
  { id: "toggle", short: "Toggle", label: "Toggle", icon: "fold", isActive: (e) => inCallout(e, true), run: (e) => (inCallout(e, true) ? undefined : void e.chain().focus().setCallout({ fold: "-" }).run()) },
  { id: "code", short: "Code", label: "Code", icon: "code", isActive: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

// ---------- Keys ----------

export const BlockKeys = Extension.create({
  name: "blockKeys",
  addKeyboardShortcuts() {
    return {
      "Alt-Shift-ArrowUp": ({ editor }) => moveBlock(editor, -1) || true,
      "Alt-Shift-ArrowDown": ({ editor }) => moveBlock(editor, 1) || true,
      "Mod-d": ({ editor }) => duplicateBlock(editor),
    };
  },
});
