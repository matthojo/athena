/**
 * A line in a note that is also a to-do in To do.
 *
 * "Add to To do" (the / menu, the block menu) makes a to-do from the line
 * you're on and writes the line as a checklist line holding a link to it:
 *
 *   - [ ] [@Book the dentist](athena://todo/<uuid> "link")
 *
 * In a bulleted or numbered list the line keeps its bullet and holds the
 * link. Nothing becomes a to-do unless you ask.
 *
 * The tick is the to-do's: ticking the line ticks the to-do, and a to-do
 * ticked in To do (or anywhere else) ticks its line the next time the note
 * is open (the note then says [x], and saves). Only lines that hold one
 * to-do link and nothing else are tied this way.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { linkData } from "./link-data";

export interface MadeTodo {
  id: string;
  title: string;
}

/** Makes the to-do; null when it couldn't (offline), having said so. */
export type CreateTodo = (title: string) => Promise<MadeTodo | null>;

/** A line's words as you read them: a mention reads as its name. */
export function readableText(node: PMNode): string {
  return node
    .textBetween(0, node.content.size, " ", (leaf) => {
      const label = (leaf.attrs as { label?: string }).label;
      return label ? label.replace(/^@/, "") : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The to-do a checklist line is tied to: its only content is one to-do link. */
export function tiedTodo(item: PMNode): string | null {
  if (item.type.name !== "taskItem") return null;
  const para = item.firstChild;
  if (!para || para.type.name !== "paragraph") return null;
  let id: string | null = null;
  let other = false;
  para.forEach((n) => {
    if (n.type.name === "athenaLink" && n.attrs.kind === "todo" && !id) id = n.attrs.id;
    else if (!(n.isText && !n.text?.trim())) other = true;
  });
  return other ? null : id;
}

/** Whether a line can become a to-do: it has words, and isn't one already. `typing` is a "/query" to leave out. */
export function lineCanBeTodo(block: PMNode, typing?: RegExp): boolean {
  if (!block.isTextblock || block.type.name === "codeBlock" || block.type.name === "calloutTitle") return false;
  let tied = false;
  block.forEach((n) => {
    if (n.type.name === "athenaLink" && n.attrs.kind === "todo") tied = true;
  });
  if (tied) return false;
  const text = readableText(block);
  return (typing ? text.replace(typing, "") : text).trim().length > 0;
}

/** The same, for the line the caret is on. */
export const canAddTodo = (editor: Editor, typing?: RegExp): boolean => lineCanBeTodo(editor.state.selection.$from.parent, typing);

/** Turn the line the caret is on into a to-do. */
export async function addLineToTodo(editor: Editor, create: CreateTodo): Promise<void> {
  const { $from } = editor.state.selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type.name === "codeBlock" || block.type.name === "calloutTitle") return;
  const title = readableText(block);
  if (!title) return;
  const made = await create(title);
  if (!made || editor.isDestroyed) return;

  // Find the line again: the note may have changed while the to-do was being made.
  const state = editor.state;
  let at = -1;
  state.doc.descendants((n, pos) => {
    if (at >= 0) return false;
    if (n === block) at = pos;
    return true;
  });
  if (at < 0) {
    const pos = Math.min($from.pos, state.doc.content.size);
    const $p = state.doc.resolve(pos);
    if (!$p.parent.isTextblock) return;
    at = $p.before();
  }
  const { schema } = state;
  const link = schema.nodes.athenaLink.create({ kind: "todo", id: made.id, label: `@${made.title}`, mode: "link" });
  const para = schema.nodes.paragraph.create(null, link);
  const $at = state.doc.resolve(at);
  const holder = $at.parent;
  const tr = state.tr;
  if (holder.type.name === "taskItem" || holder.type.name === "listItem") {
    // Already a list line: it keeps its place, and its words become the link.
    tr.replaceWith(at, at + block.nodeSize, para);
    if (holder.type.name === "taskItem") tr.setNodeMarkup($at.before(), undefined, { ...holder.attrs, checked: false });
  } else {
    const item = schema.nodes.taskItem.create({ checked: false }, para);
    tr.replaceWith(at, at + block.nodeSize, schema.nodes.taskList.create(null, item));
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 4, tr.doc.content.size)), -1));
  editor.view.dispatch(tr.scrollIntoView());
}

// ---------- Keeping the tick and the to-do together ----------

const SYNC = "todoLineSync";

function tiedLines(doc: PMNode): Array<{ pos: number; id: string; checked: boolean }> {
  const out: Array<{ pos: number; id: string; checked: boolean }> = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== "taskItem") return true;
    const id = tiedTodo(n);
    if (id) out.push({ pos, id, checked: !!n.attrs.checked });
    return true;
  });
  return out;
}

/** Tick each tied line the way its to-do is now. */
async function catchUp(editor: Editor, only?: string): Promise<void> {
  const lines = tiedLines(editor.state.doc).filter((l) => !only || l.id === only);
  for (const l of lines) {
    const live = await linkData().liveCard("todo", l.id).catch(() => null);
    if (!live || live.kind !== "todo" || editor.isDestroyed) continue;
    const now = editor.state.doc.nodeAt(l.pos);
    if (!now || now.type.name !== "taskItem" || tiedTodo(now) !== l.id) continue;
    if (!!now.attrs.checked === live.done) continue;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(l.pos, undefined, { ...now.attrs, checked: live.done }).setMeta(SYNC, true).setMeta("addToHistory", false));
  }
}

export const TodoLines = Extension.create({
  name: "todoLines",

  onCreate() {
    if (!this.editor.isEditable) return;
    const editor = this.editor;
    void catchUp(editor);
    const off = linkData().onLiveChange((kind, id) => {
      if (kind === "todo") void catchUp(editor, id);
    });
    editor.on("destroy", off);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("todoLines"),
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((t) => t.docChanged && !t.getMeta(SYNC))) return null;
          const before = new Map(tiedLines(oldState.doc).map((l) => [l.id, l.checked]));
          for (const l of tiedLines(newState.doc)) {
            const was = before.get(l.id);
            if (was === undefined || was === l.checked) continue;
            // Ticked here: tick the to-do too, unless it already is.
            void linkData()
              .liveCard("todo", l.id)
              .then((live) => {
                if (live && live.kind === "todo" && live.done !== l.checked) return linkData().toggleTodo(l.id);
              })
              .catch(() => undefined);
          }
          return null;
        },
      }),
    ];
  },
});
