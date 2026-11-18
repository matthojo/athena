/**
 * Where dictated text will land. Starting a dictation drops a small marker at
 * the caret ("Listening" / "Transcribing"); the position is mapped through
 * every edit, so you can keep typing elsewhere while a recording is
 * transcribed and the text still arrives where you started. The transcript
 * is inserted as plain text nodes (never parsed as HTML or Markdown) and
 * briefly highlighted so you can see what was added.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { h } from "../lib/dom";

type Phase = "listening" | "transcribing";

interface DictationState {
  /** The pending insertion point, or null when nothing is being dictated. */
  pos: number | null;
  phase: Phase;
  /** Just-inserted text, highlighted for a moment. */
  flash: { from: number; to: number } | null;
}

const key = new PluginKey<DictationState>("athenaDictation");

export interface DictationSlot {
  transcribing: () => void;
  insert: (text: string) => void;
  cancel: () => void;
}

function marker(phase: Phase): HTMLElement {
  return h(
    "span",
    { class: "dictation-mark", "data-phase": phase, "aria-hidden": "true", contenteditable: "false" },
    h("span", { class: "dictation-mark__dot" }),
    phase === "listening" ? "Listening" : "Transcribing"
  );
}

export const Dictation = Extension.create({
  name: "athenaDictation",
  addProseMirrorPlugins() {
    return [
      new Plugin<DictationState>({
        key,
        state: {
          init: () => ({ pos: null, phase: "listening", flash: null }),
          apply(tr, prev) {
            let next = prev;
            if (tr.docChanged) {
              next = {
                ...next,
                pos: next.pos === null ? null : tr.mapping.map(next.pos),
                flash: next.flash && { from: tr.mapping.map(next.flash.from), to: tr.mapping.map(next.flash.to, -1) },
              };
            }
            const meta = tr.getMeta(key) as Partial<DictationState> | undefined;
            return meta ? { ...next, ...meta } : next;
          },
        },
        props: {
          decorations(state: EditorState) {
            const s = key.getState(state);
            if (!s) return null;
            const decos: Decoration[] = [];
            if (s.pos !== null) decos.push(Decoration.widget(s.pos, () => marker(s.phase), { side: 1, key: `dictation-${s.phase}` }));
            if (s.flash && s.flash.to > s.flash.from) decos.push(Decoration.inline(s.flash.from, s.flash.to, { class: "dictation-new" }));
            return decos.length ? DecorationSet.create(state.doc, decos) : null;
          },
        },
      }),
    ];
  },
});

const setMeta = (editor: Editor, meta: Partial<DictationState>) => {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(key, meta));
};

/** Mark the caret as the place the next dictation goes. */
export function beginDictation(editor: Editor): DictationSlot {
  setMeta(editor, { pos: editor.state.selection.to, phase: "listening", flash: null });
  let done = false;

  return {
    transcribing: () => !done && setMeta(editor, { phase: "transcribing" }),
    cancel() {
      if (done) return;
      done = true;
      setMeta(editor, { pos: null });
    },
    insert(text) {
      if (done || editor.isDestroyed) return;
      done = true;
      const pos = key.getState(editor.state)?.pos ?? editor.state.selection.to;
      const doc = editor.state.doc;
      const $pos = doc.resolve(pos);
      // Space it from the words either side, unless it starts or ends a line.
      const before = $pos.parentOffset > 0 ? doc.textBetween(pos - 1, pos, "\n", "￼") : "";
      const after = $pos.parentOffset < $pos.parent.content.size ? doc.textBetween(pos, pos + 1, "\n", "￼") : "";
      const lead = before && !/\s/.test(before) ? " " : "";
      const trail = after && !/[\s.,;:!?)]/.test(after) ? " " : "";

      const paragraphs = text
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean);
      if (!paragraphs.length) {
        setMeta(editor, { pos: null });
        return;
      }
      const content =
        paragraphs.length === 1
          ? [{ type: "text", text: `${lead}${paragraphs[0]}${trail}` }]
          : paragraphs.map((p, i) => ({
              type: "paragraph",
              content: [{ type: "text", text: `${i === 0 ? lead : ""}${p}${i === paragraphs.length - 1 ? trail : ""}` }],
            }));

      const sizeBefore = doc.content.size;
      setMeta(editor, { pos: null });
      editor.chain().insertContentAt(pos, content).scrollIntoView().run();
      const added = editor.state.doc.content.size - sizeBefore;
      // Highlight the words, not the spacing added around them.
      const inline = paragraphs.length === 1;
      setMeta(editor, { flash: { from: pos + (inline ? lead.length : 0), to: pos + added - (inline ? trail.length : 0) } });
      setTimeout(() => setMeta(editor, { flash: null }), 1800);
    },
  };
}
