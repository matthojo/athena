/**
 * A filled template's blanks, {{like this}}, drawn as soft chips in the note
 * so the owner sees what's left to fill (lib/templates.ts). Decorations only:
 * the Markdown keeps the braces, and typing over a blank is ordinary editing.
 */
import "../styles/documents.css";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blankRanges } from "../../../lib/templates";

const key = new PluginKey("template-blanks");

function decorate(doc: PMNode): DecorationSet {
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes("{{")) return;
    for (const [from, to] of blankRanges(node.text)) out.push(Decoration.inline(pos + from, pos + to, { class: "doc-blank", title: "Left for you to fill in" }));
  });
  return DecorationSet.create(doc, out);
}

export const TemplateBlanks = Extension.create({
  name: "templateBlanks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
