/**
 * Blocks beyond StarterKit's: callouts and toggles (one node, read and
 * written with lib/callouts.ts's Obsidian syntax) and tables (Tiptap's own,
 * as GitHub-style Markdown tables).
 *
 *   callout       a shaded panel with its tone's icon. The icon opens the
 *                 tone menu: Plain, Tip, Key point, Warning, Make it a
 *                 toggle, Remove callout. An optional first line is its title.
 *   toggle        a callout with a fold ("-" or "+"): a title line with a
 *                 chevron, and what's inside shows when it's open. Open or
 *                 shut is how you're reading, not what the note says, so it
 *                 isn't saved; "-" opens shut and "+" opens open.
 *
 * The tone and fold controls are our own DOM, built with h(); ProseMirror
 * owns everything inside `.callout__body`.
 */

import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { CALLOUT_TONES, TONE_TYPE, formatCalloutHead, readCallout, toneOf, type CalloutFold, type CalloutTone } from "../../../lib/callouts";

export const TONE_LABEL: Record<CalloutTone, string> = { note: "Plain", tip: "Tip", key: "Key point", warning: "Warning" };
export const TONE_ICON: Record<CalloutTone, IconName> = { note: "callout", tip: "bulb", key: "flag", warning: "alert" };

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block in a callout, or a toggle when `fold` is given (its first line becomes the title). */
      setCallout: (opts?: { tone?: CalloutTone; fold?: CalloutFold }) => ReturnType;
    };
  }
}

// ---------- The title line ----------

export const CalloutTitle = Node.create({
  name: "calloutTitle",
  content: "inline*",
  defining: true,
  parseHTML: () => [{ tag: "div[data-callout-title]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-callout-title": "", class: "callout__title" }), 0],
  // Written by the callout itself, as its first line.
  renderMarkdown: (node, h) => h.renderChildren(node.content ?? []),
});

// ---------- Callout and toggle ----------

function calloutView(editor: Editor, initial: PMNode, getPos: () => number | undefined): NodeView {
  let node = initial;
  const fold = node.attrs.fold as CalloutFold;
  const toggle = fold !== null;
  const body = h("div", { class: "callout__body" });
  const lead = toggle
    ? (h("button", { class: "callout__fold", type: "button", contenteditable: "false", "aria-label": "Show what's inside" }, icons.chevronRight()) as HTMLButtonElement)
    : (h("button", { class: "callout__icon", type: "button", contenteditable: "false", "aria-haspopup": "menu" }) as HTMLButtonElement);
  const dom = h("div", { class: toggle ? "callout callout--toggle" : "callout" }, lead, body);

  // Only an editable note offers the tone menu; a read-only one keeps the icon quiet.
  if (!toggle && !editor.isEditable) lead.disabled = true;

  // Open or shut lives on the element (setToggleOpen), so the keyboard and the plugin below can open it too.
  if (fold === "+") dom.classList.add("is-open");
  const paint = () => {
    const tone = toneOf(node.attrs.type);
    dom.dataset.tone = tone;
    dom.dataset.type = node.attrs.type;
    if (toggle) {
      setToggleOpen(dom, dom.classList.contains("is-open"));
    } else {
      lead.replaceChildren(icons[TONE_ICON[tone]]());
      lead.setAttribute("aria-label", `Callout style: ${TONE_LABEL[tone]}`);
    }
  };
  paint();

  lead.addEventListener("mousedown", (e) => e.preventDefault());
  lead.addEventListener("click", (e) => {
    e.preventDefault();
    if (toggle) {
      const open = !dom.classList.contains("is-open");
      setToggleOpen(dom, open);
      // Opening one you're writing in keeps the caret where it is; shutting one with the caret inside moves it to the title.
      const pos = getPos();
      if (!open && pos !== undefined && editor.isEditable) {
        const { from } = editor.state.selection;
        if (from > pos && from < pos + node.nodeSize) editor.chain().setTextSelection(pos + 2).run();
      }
      return;
    }
    if (!editor.isEditable) return;
    void toneMenu(editor, lead, getPos);
  });

  return {
    dom,
    contentDOM: body,
    update(next) {
      // A toggle that becomes a callout (or back) needs its other control: draw it afresh.
      if (next.type !== node.type || (next.attrs.fold === null) !== (node.attrs.fold === null)) return false;
      node = next;
      paint();
      return true;
    },
    selectNode() {
      dom.classList.add("ProseMirror-selectednode");
    },
    deselectNode() {
      dom.classList.remove("ProseMirror-selectednode");
    },
    ignoreMutation: (m) => m.type !== "selection" && !body.contains(m.target),
    stopEvent: (e) => lead.contains(e.target as globalThis.Node),
  };
}

/** The callout's menu. The context menu loads when first used: this file is the schema, which tests read in Node. */
async function toneMenu(editor: Editor, anchor: HTMLElement, getPos: () => number | undefined) {
  const { openContextMenu } = await import("../components/context-menu");
  const pos = getPos();
  if (pos === undefined) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const tone = toneOf(node.attrs.type);
  const setAttrs = (attrs: Record<string, unknown>) => {
    const at = getPos();
    if (at === undefined) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...attrs }));
    editor.commands.focus();
  };
  openContextMenu(
    {
      label: "Callout",
      groups: [
        CALLOUT_TONES.map((t) => ({
          id: t,
          label: TONE_LABEL[t],
          icon: TONE_ICON[t],
          shortcut: t === tone ? "✓" : undefined,
          run: () => setAttrs({ type: t === tone ? node.attrs.type : TONE_TYPE[t] }),
        })),
        [
          ...(node.firstChild?.type.name === "calloutTitle"
            ? []
            : [{ id: "title", label: "Add a title", icon: "heading" as const, run: () => addTitle(editor, getPos) }]),
          { id: "toggle", label: "Make it a toggle", icon: "fold", run: () => setAttrs({ fold: "-" }) },
          {
            id: "remove",
            label: "Remove callout",
            icon: "close",
            run: () => {
              const at = getPos();
              if (at === undefined) return;
              unwrapCallout(editor, at);
            },
          },
        ],
      ],
    },
    { anchor, by: "mouse" }
  );
}

/** An empty title line at the top of a callout, with the caret in it. An empty one isn't saved. */
function addTitle(editor: Editor, getPos: () => number | undefined) {
  const at = getPos();
  if (at === undefined) return;
  const tr = editor.state.tr.insert(at + 1, editor.schema.nodes.calloutTitle.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  editor.view.dispatch(tr);
  editor.view.focus();
}

/** Take a callout's contents out of it, its title as a paragraph. */
export function unwrapCallout(editor: Editor, pos: number): void {
  const { state } = editor;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "callout") return;
  const kids: PMNode[] = [];
  node.forEach((child) => {
    if (child.type.name === "calloutTitle") {
      if (child.content.size) kids.push(state.schema.nodes.paragraph.create(null, child.content));
    } else kids.push(child);
  });
  if (!kids.length) kids.push(state.schema.nodes.paragraph.create());
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, kids);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
  editor.view.dispatch(tr);
  editor.commands.focus();
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "calloutTitle? block+",
  defining: true,

  addAttributes() {
    return {
      type: { default: "note", parseHTML: (el) => (el as HTMLElement).dataset.type ?? "note" },
      fold: { default: null, parseHTML: (el) => ((el as HTMLElement).dataset.fold as CalloutFold) || null },
    };
  },

  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-callout": "", "data-type": node.attrs.type, "data-fold": node.attrs.fold ?? undefined, "data-tone": toneOf(node.attrs.type), class: "callout" }),
    0,
  ],

  addNodeView() {
    return ({ editor, node, getPos }) => calloutView(editor, node, getPos as () => number | undefined);
  },

  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src: string) => {
      const m = /^ {0,3}>[ \t]?\[![A-Za-z]/m.exec(src);
      return m ? m.index : -1;
    },
    tokenize(src, _tokens, lexer) {
      const found = readCallout(src);
      if (!found) return undefined;
      return {
        type: "callout",
        raw: found.raw,
        calloutType: found.head.type,
        fold: found.head.fold,
        titleTokens: found.head.title ? lexer.inlineTokens(found.head.title) : [],
        tokens: lexer.blockTokens(found.inner),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const toggle = token.fold === "-" || token.fold === "+";
    const titleTokens = (token.titleTokens ?? []) as never[];
    const title = titleTokens.length || toggle ? [helpers.createNode("calloutTitle", {}, helpers.parseInline(titleTokens))] : [];
    const parse = helpers.parseBlockChildren ?? helpers.parseChildren;
    let blocks = parse(token.tokens ?? []).filter((b) => b.type !== "paragraph" || (b.content?.length ?? 0) > 0);
    if (!blocks.length) blocks = [{ type: "paragraph" }];
    return helpers.createNode("callout", { type: token.calloutType, fold: token.fold ?? null }, [...title, ...blocks]);
  },

  renderMarkdown(node, h) {
    const kids = (node.content ?? []) as Array<{ type: string; content?: unknown[] }>;
    const titled = kids[0]?.type === "calloutTitle";
    const title = titled ? h.renderChildren((kids[0].content ?? []) as never).trim() : "";
    const head = formatCalloutHead({ type: node.attrs?.type ?? "note", fold: node.attrs?.fold ?? null, title });
    const rest = titled ? kids.slice(1) : kids;
    const lines: string[] = [];
    rest.forEach((child, i) => {
      const text = (h.renderChild?.(child as never, i) ?? h.renderChildren([child as never])).replace(/\n+$/, "");
      if (lines.length) lines.push(">");
      for (const line of text.split("\n")) lines.push(line.trim() === "" ? ">" : `> ${line}`);
    });
    return [head, ...lines].join("\n");
  },

  addCommands() {
    return {
      setCallout:
        (opts = {}) =>
        ({ state, dispatch, editor }) => {
          const { $from } = state.selection;
          // The block the caret is in, at the top of the note or inside a list or quote.
          let depth = $from.depth;
          while (depth > 1 && !$from.node(depth).isBlock) depth--;
          if ($from.node(depth).isTextblock) depth = Math.max(1, depth);
          const block = $from.node(depth);
          const from = $from.before(depth);
          const to = $from.after(depth);
          const toggle = opts.fold === "-" || opts.fold === "+";
          const type = TONE_TYPE[opts.tone ?? "note"];
          const { schema } = state;
          let content: PMNode[];
          let caret: number;
          if (toggle) {
            // A toggle's first line is its title: the line you were on, with an empty line inside to write in.
            const title = schema.nodes.calloutTitle.create(null, block.isTextblock ? block.content : null);
            content = [title, block.isTextblock ? schema.nodes.paragraph.create() : block];
            caret = from + 2 + title.content.size;
          } else {
            content = [block.isTextblock && block.type.name !== "paragraph" && block.type.name !== "heading" ? schema.nodes.paragraph.create(null, block.content) : block];
            caret = from + 2 + (block.isTextblock ? block.content.size : 0);
          }
          const callout = schema.nodes.callout.create({ type, fold: toggle ? opts.fold : null }, content);
          if (dispatch) {
            const tr = state.tr.replaceWith(from, to, callout);
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))));
            dispatch(tr.scrollIntoView());
            // A toggle you've just made is one you're writing in.
            if (toggle) requestAnimationFrame(() => openFor(editor, from));
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [revealCaret];
  },

  addKeyboardShortcuts() {
    return {
      // In a title: Enter goes inside (opening a shut toggle), never a second title.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "calloutTitle") return false;
        const calloutPos = $from.before($from.depth - 1);
        const afterTitle = $from.after();
        const next = editor.state.doc.nodeAt(afterTitle);
        // Text after the caret moves down with it, as Enter does everywhere else.
        const tail = $from.parent.content.cut($from.parentOffset);
        const tr = editor.state.tr.delete($from.pos, $from.end());
        const para = editor.schema.nodes.paragraph.create(null, tail);
        const insertAt = tr.mapping.map(afterTitle);
        if (next && next.type.name === "paragraph" && !next.content.size && !tail.size) {
          tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
        } else {
          tr.insert(insertAt, para);
          tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
        }
        openFor(editor, calloutPos);
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
      // Backspace at the start of a callout's first line (or an empty title) takes the callout away, keeping its words.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parentOffset !== 0) return false;
        const d = $from.depth - 1;
        if (d < 1) return false;
        const parent = $from.node(d);
        if (parent.type.name !== "callout" || $from.index(d) !== 0) return false;
        unwrapCallout(editor, $from.before(d));
        return true;
      },
    };
  },
});

/** Show or hide what's inside a toggle's element. */
function setToggleOpen(dom: HTMLElement, open: boolean) {
  dom.classList.toggle("is-open", open);
  const btn = dom.querySelector(":scope > .callout__fold");
  btn?.setAttribute("aria-expanded", String(open));
  btn?.setAttribute("aria-label", open ? "Hide what's inside" : "Show what's inside");
}

/** Open the toggle at `pos`, if its view is drawn. */
function openFor(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  if (dom?.classList.contains("callout--toggle")) setToggleOpen(dom, true);
}

/** The caret landing inside a shut toggle (arrow keys, undo, search) opens it, so you never type where you can't see. */
const revealCaret = new Plugin({
  key: new PluginKey("calloutReveal"),
  view: () => ({
    update(view, prev) {
      if (prev && prev.selection.eq(view.state.selection)) return;
      const { $from } = view.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);
        if (n.type.name !== "callout" || n.attrs.fold === null) continue;
        // The title line stays visible when shut.
        if (d + 1 <= $from.depth && $from.node(d + 1).type.name === "calloutTitle") continue;
        const dom = view.nodeDOM($from.before(d)) as HTMLElement | null;
        if (dom && !dom.classList.contains("is-open")) setToggleOpen(dom, true);
      }
    },
  }),
});

// ---------- Tables ----------

/** Tables as GitHub writes them: a header row, then rows. No resizing: a note's table fits its column. */
export const tableExtensions = () => [Table.configure({ resizable: false, renderWrapper: true, HTMLAttributes: { class: "note-table" } }), TableRow, TableHeader, TableCell];
