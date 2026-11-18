/**
 * Rich links in the editor: what happens when someone pastes, clicks, holds
 * or right-clicks a link (docs/notes/rich-links.md, with the owner's answers).
 *
 *   paste      a lone web address on an empty line becomes a Card (an Embed
 *              for the nine players); inside a sentence it's a Link. Either
 *              way the switcher opens with "Pasted a … link" above it.
 *   click      a link opens what it points at (an Embed's still selects it).
 *   switcher   after a paste, and from the menu's Show as: Mention · Link ·
 *              Card · Embed. Tab and the arrows move along it, Enter picks,
 *              Esc closes. Switching morphs the link into its new shape. Card
 *              or Embed for a link inside a sentence keeps the words as a Link
 *              and puts the block after the paragraph.
 *   hover      a peek after 380ms (80ms between links).
 *   menu       right-click, a long press or Shift+F10: Open, the kind's own
 *              action, Copy link, Show as, Remove.
 *   keys       on a focused link: Enter or ⌘↵ opens, ⌘C copies its link,
 *              Backspace removes it.
 *   /card, /embed   ask for an address and add it as that block.
 *
 * A read-only note's menu has no Show as or Remove.
 */

import { Extension, getMarkRange, type Editor, type Range } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { showToast } from "../components/toast";
import { attachContextMenu, contextMenuOpen, closeContextMenu } from "../components/context-menu";
import { PROVIDER_NAMES, embedFor, isEmbeddable } from "../../../lib/embeds";
import { previewFor, previewKnown } from "./link-data";
import { blockPlacement, isBlockMode, MODE_LABEL, NO_PLAYER, pasteMode, pastedUrl, shownMode, tapAction, type LinkMode, type LinkTarget } from "./link-model";
import { linkAt, ownerPicked, thingNow } from "./link-view";
import { thingFor, type Thing } from "./link-render";
import { closeSwitcher, openSwitcher, switcherOpen, type Switcher } from "./link-switcher";
import { hidePeek, peekShowing, wirePeeks } from "./link-peek";
import { linkMenu, copyLink, openInBrowser, KEYS } from "./link-context";
import { atMenu, type AtMenu } from "./link-menu";
import { morph } from "./link-motion";
import type { EntityKind } from "../types";

export interface RichLinksOptions {
  /** Open a thing in Athena. */
  onOpenLink: (kind: EntityKind, id: string) => void;
}

/** A link where it sits in the document: a node (Mention, Link, Card, Embed) or a web link's words (the Link mark). */
interface Loc {
  at: "node" | "mark";
  pos: number;
  /** End of the mark's words, or pos + nodeSize. */
  end: number;
  target: LinkTarget;
  mode: LinkMode;
  label: string;
  el: HTMLElement;
}

// ---------- Finding links ----------

function locate(editor: Editor, el: Element | null): Loc | null {
  const n = linkAt(el);
  if (n) return { at: "node", pos: n.pos, end: n.pos + n.node.nodeSize, target: n.target, mode: n.mode, label: n.label, el: n.view.el };
  const a = el?.closest<HTMLAnchorElement>("a.rl-link[href]");
  if (!a || !editor.view.dom.contains(a)) return null;
  const url = a.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(url)) return null;
  let pos: number;
  try {
    pos = editor.view.posAtDOM(a, 0);
  } catch {
    return null;
  }
  const type = editor.schema.marks.link;
  const range = getMarkRange(editor.state.doc.resolve(pos), type, { href: url }) ?? getMarkRange(editor.state.doc.resolve(pos + 1), type);
  if (!range) return null;
  return { at: "mark", pos: range.from, end: range.to, target: { target: "web", url }, mode: "link", label: editor.state.doc.textBetween(range.from, range.to), el: a };
}

/** The element standing for the link at `pos` after a change. */
function elementAt(editor: Editor, pos: number, at: "node" | "mark"): HTMLElement | null {
  const view = editor.view;
  if (at === "node") {
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    return (dom?.querySelector?.(".rl-node") as HTMLElement | null) ?? dom;
  }
  try {
    const { node } = view.domAtPos(pos + 1);
    const el = node instanceof Element ? node : node.parentElement;
    return el?.closest<HTMLElement>("a.rl-link") ?? null;
  } catch {
    return null;
  }
}

// ---------- Building nodes ----------

function inlineFor(editor: Editor, t: LinkTarget, label: string, mode: "mention" | "link"): PMNode[] {
  const s = editor.schema;
  if (t.target === "athena") return [s.nodes.athenaLink.create({ kind: t.kind, id: t.id, label, mode: mode === "mention" ? null : "link" })];
  if (mode === "mention") return [s.nodes.webLink.create({ url: t.url, label, mode: "mention" })];
  return [s.text(label || t.url, [s.marks.link.create({ href: t.url, mode: null })])];
}

function blockFor(editor: Editor, t: LinkTarget, label: string, mode: "card" | "embed"): PMNode {
  if (t.target === "athena") return editor.schema.nodes.linkBlock.create({ target: "athena", kind: t.kind, id: t.id, label, mode: "card" });
  return editor.schema.nodes.linkBlock.create({ target: "web", url: t.url, label, mode });
}

/** Nothing else in the link's paragraph but the link (and spaces). */
function aloneInParagraph(parent: PMNode, loc: Loc, startOfParent: number): boolean {
  let alone = true;
  parent.forEach((child, offset) => {
    const from = startOfParent + offset;
    const to = from + child.nodeSize;
    const inLink = from >= loc.pos && to <= loc.end;
    if (!inLink && !(child.isText && !child.text!.trim())) alone = false;
  });
  return alone;
}

/** Make sure there's a line after a block at `pos` to keep typing on, and put the caret there. */
function caretAfterBlock(tr: Transaction, blockPos: number) {
  const block = tr.doc.nodeAt(blockPos);
  if (!block) return;
  const after = blockPos + block.nodeSize;
  const $after = tr.doc.resolve(after);
  const next = $after.nodeAfter;
  if (!next || !next.isTextblock) tr.insert(after, tr.doc.type.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
}

/**
 * Change a link's mode. Returns where the link (or its new block) now is, for
 * the switcher and the morph.
 */
function setMode(editor: Editor, loc: Loc, mode: LinkMode): { pos: number; at: "node" | "mark" } | null {
  const { state } = editor;
  const tr = state.tr;
  const t = loc.target;
  const label = loc.label || (t.target === "web" ? t.url : "");
  if (t.target === "athena" && mode === "embed") return null;
  const node = loc.at === "node" ? state.doc.nodeAt(loc.pos) : null;

  if (!isBlockMode(mode)) {
    const m = mode as "mention" | "link";
    // Athena link in the text: just its attribute.
    if (node?.type.name === "athenaLink") {
      tr.setNodeMarkup(loc.pos, undefined, { ...node.attrs, mode: m === "mention" ? null : "link" });
      editor.view.dispatch(tr);
      return { pos: loc.pos, at: "node" };
    }
    const parts = inlineFor(editor, t, label, m);
    if (node?.type.name === "linkBlock") {
      tr.replaceWith(loc.pos, loc.end, state.schema.nodes.paragraph.create(null, parts));
      editor.view.dispatch(tr);
      return { pos: loc.pos + 1, at: m === "link" && t.target === "web" ? "mark" : "node" };
    }
    // A web Mention ↔ the Link's words.
    tr.replaceWith(loc.pos, loc.end, Fragment.from(parts));
    editor.view.dispatch(tr);
    return { pos: loc.pos, at: m === "link" && t.target === "web" ? "mark" : "node" };
  }

  const b = mode as "card" | "embed";
  if (node?.type.name === "linkBlock") {
    tr.setNodeMarkup(loc.pos, undefined, { ...node.attrs, mode: t.target === "athena" ? "card" : b });
    editor.view.dispatch(tr);
    return { pos: loc.pos, at: "node" };
  }
  // In the text: alone on its line, the line becomes the block; inside a sentence, the words stay a Link and the block goes after.
  const $pos = state.doc.resolve(loc.pos);
  const parent = $pos.parent;
  const depth = $pos.depth;
  const block = blockFor(editor, t, label, b);
  if (blockPlacement(aloneInParagraph(parent, loc, $pos.start(depth))) === "replace") {
    const from = $pos.before(depth);
    try {
      tr.replaceWith(from, $pos.after(depth), block);
      caretAfterBlock(tr, from);
      editor.view.dispatch(tr);
      return { pos: from, at: "node" };
    } catch {
      // A list item must start with a line of text: fall through and add the block after it.
    }
  }
  if (node?.type.name === "athenaLink") tr.setNodeMarkup(loc.pos, undefined, { ...node.attrs, mode: "link" });
  else if (node?.type.name === "webLink") tr.replaceWith(loc.pos, loc.end, Fragment.from(inlineFor(editor, t, label, "link")));
  const after = tr.mapping.map($pos.after(depth));
  tr.insert(after, block);
  editor.view.dispatch(tr);
  return { pos: after, at: "node" };
}

/** Take a link out, with Undo in a toast. A block takes its line with it. */
function removeLink(editor: Editor, loc: Loc) {
  const tr = editor.state.tr.delete(loc.pos, loc.end);
  const slice = editor.state.doc.slice(loc.pos, loc.end);
  editor.view.dispatch(tr);
  const after = editor.state.doc;
  const name = loc.target.target === "web" ? loc.label || "Link" : loc.label.replace(/^@/, "");
  showToast(`${name} removed`, {
    icon: "trash",
    action: {
      label: "Undo",
      run: () => {
        if (editor.isDestroyed) return;
        if (editor.state.doc.eq(after)) editor.commands.undo();
        else editor.view.dispatch(editor.state.tr.replace(Math.min(loc.pos, editor.state.doc.content.size), Math.min(loc.pos, editor.state.doc.content.size), slice));
      },
    },
  });
}

// ---------- Paste ----------

/**
 * Put an address in where the caret is, by position: the empty line becomes a
 * Card or Embed, words get a Link. `range` (an "@query" or "/card") is taken
 * out first. `force` picks the block mode (from /card or /embed).
 */
export function insertWebLink(editor: Editor, url: string, range: Range | null, force?: "card" | "embed"): { pos: number; at: "node" | "mark"; mode: LinkMode } | null {
  const { state } = editor;
  const tr = state.tr;
  if (range) tr.delete(range.from, range.to);
  const $from = tr.selection.$from;
  const parent = $from.parent;
  if (parent.type.spec.code) return null;
  const empty = parent.isTextblock && !parent.textContent.trim() && parent.childCount === 0;
  const place = empty || force ? "empty-line" : "in-text";
  const mode = force ?? pasteMode(url, place);
  const t: LinkTarget = { target: "web", url };
  if (isBlockMode(mode)) {
    const block = blockFor(editor, t, url, mode as "card" | "embed");
    const depth = $from.depth;
    let at: number;
    if (empty && depth > 0) {
      at = $from.before(depth);
      try {
        tr.replaceWith(at, $from.after(depth), block);
      } catch {
        at = $from.after(depth);
        tr.insert(at, block);
      }
    } else {
      at = $from.after(depth);
      tr.insert(at, block);
    }
    caretAfterBlock(tr, at);
    editor.view.dispatch(tr.scrollIntoView());
    return { pos: at, at: "node", mode };
  }
  const from = $from.pos;
  const linkMark = state.schema.marks.link.create({ href: url, mode: null });
  tr.insert(from, state.schema.text(url, [linkMark]));
  // Type on after the link, not inside it.
  tr.setSelection(TextSelection.create(tr.doc, from + url.length));
  tr.removeStoredMark(state.schema.marks.link);
  editor.view.dispatch(tr.scrollIntoView());
  return { pos: from, at: "mark", mode };
}

/** Once the page's title arrives, a pasted link shows it instead of its address. */
function titleWhenReady(editor: Editor, url: string) {
  void previewFor(url).then((p) => {
    const title = p?.status === "ok" ? p.title?.trim() : null;
    if (!title || editor.isDestroyed) return;
    const { state } = editor;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (node.type.name === "linkBlock" && node.attrs.url === url && node.attrs.label === url) tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, label: title });
      if (node.type.name === "webLink" && node.attrs.url === url && node.attrs.label === url) tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, label: title });
      if (node.isText && node.text === url && node.marks.some((m) => m.type.name === "link" && m.attrs.href === url)) {
        const from = tr.mapping.map(pos);
        tr.replaceWith(from, from + url.length, state.schema.text(title, node.marks));
      }
    });
    if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
  });
}

// ---------- The controller ----------

interface Controller {
  openSwitcherAt(placed: { pos: number; at: "node" | "mark" }, reason: "paste" | "menu"): void;
  destroy(): void;
}

function controller(editor: Editor, opts: RichLinksOptions): Controller {
  const root = editor.view.dom as HTMLElement;
  const scope = (root.parentElement ?? root) as HTMLElement;
  let current: { loc: Loc; sw: Switcher } | null = null;

  const open = (loc: Loc) => {
    const t = loc.target;
    if (t.target === "athena") opts.onOpenLink(t.kind as EntityKind, t.id);
    else openInBrowser(t.url);
  };

  const thingSync = (loc: Loc): Thing => {
    const n = linkAt(loc.el);
    if (n) return n.view.thing();
    return thingFor(loc.target, loc.label, loc.target.target === "web" ? { preview: previewKnown(loc.target.url) } : {});
  };

  function showSwitcher(loc: Loc, reason: "paste" | "menu", focus: boolean) {
    hidePeek();
    const t = thingSync(loc);
    const provider = loc.target.target === "web" ? embedFor(loc.target.url)?.provider : null;
    const sw = openSwitcher(loc.el, loc.target, t.title, loc.mode, (m) => pick(m), {
      reason,
      focus,
      provider: provider ? PROVIDER_NAMES[provider] : null,
      onClose: () => {
        if (current?.sw === sw) current = null;
      },
    });
    current = { loc, sw };
  }

  function pick(mode: LinkMode) {
    if (!current) return;
    const { loc, sw } = current;
    let placed: { pos: number; at: "node" | "mark" } | null = null;
    morph(loc.el, () => {
      placed = setMode(editor, loc, mode);
      return placed ? elementAt(editor, placed.pos, placed.at) : null;
    });
    if (!placed) return;
    const p = placed as { pos: number; at: "node" | "mark" };
    const el = elementAt(editor, p.pos, p.at);
    // In a note Athena wrote, this pick is the owner's choice for the link (link-view.ts).
    ownerPicked(editor, el, loc.target, mode);
    const next = el ? locate(editor, el) : null;
    if (!el || !next) return sw.close();
    current = { loc: next, sw };
    sw.retarget(el, next.mode);
  }

  function changeMode(loc: Loc, mode: LinkMode) {
    morph(loc.el, () => {
      const placed = setMode(editor, loc, mode);
      const el = placed ? elementAt(editor, placed.pos, placed.at) : null;
      if (placed) ownerPicked(editor, el, loc.target, mode);
      return el;
    });
  }

  // Click: opens the link (tapAction in link-model.ts).
  const click = (e: MouseEvent) => {
    const target = e.target as Element;
    if (target.closest("button, input, a.rl-chip, a.rl-play, iframe, .rl-embed__player")) return;
    const loc = locate(editor, target);
    if (!loc) return;
    e.preventDefault();
    // The mode as drawn: a Card or Embed written mid-sentence is drawn as a Link.
    const drawn = (target.closest<HTMLElement>("[data-rl-mode]")?.dataset.rlMode ?? "link") as LinkMode;
    if (tapAction(drawn, editor.isEditable) === "open") return open(loc);
    if (loc.at === "node") editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, loc.pos)));
  };

  // Keys on a focused link; Tab into a switcher that opened without focus.
  const keydown = (e: KeyboardEvent) => {
    const sw = switcherOpen();
    if (sw && current && !sw.el.contains(document.activeElement)) {
      if (e.key === "Tab") {
        e.preventDefault();
        (sw.el.querySelector<HTMLElement>('[aria-pressed="true"]') ?? sw.el.querySelector<HTMLElement>("button"))?.focus();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSwitcher();
        return;
      }
      if (!["Shift", "Control", "Meta", "Alt"].includes(e.key)) closeSwitcher();
    }
    const focused = (document.activeElement as Element | null)?.closest?.(".rl-node");
    if (!focused || !root.contains(focused)) return;
    const loc = locate(editor, focused);
    if (!loc) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && !(focused as HTMLElement).closest(".rl-card, .rl-embed")) {
      e.preventDefault();
      open(loc);
    } else if (e.key === "Enter" && mod) {
      e.preventDefault();
      open(loc);
    } else if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyLink(thingSync(loc));
    } else if ((e.key === "Backspace" || e.key === "Delete") && editor.isEditable) {
      e.preventDefault();
      removeLink(editor, loc);
      editor.commands.focus();
    }
  };

  const peeks = wirePeeks(
    root,
    async (el) => {
      const loc = locate(editor, el);
      return loc ? thingNow(loc.target, loc.label) : null;
    },
    () => !!switcherOpen() || contextMenuOpen(),
    (el) => {
      const loc = locate(editor, el);
      if (loc) open(loc);
    }
  );

  const menu = attachContextMenu(root, {
    target: (el) => locate(editor, el)?.el ?? null,
    onOpen: () => {
      hidePeek();
      closeSwitcher();
    },
    build: (el) => {
      const loc = locate(editor, el);
      if (!loc) return null;
      const t = thingSync(loc);
      const editable = editor.isEditable;
      return linkMenu(
        t,
        shownMode(loc.target, loc.mode),
        {
          open: () => open(loc),
          show: editable ? (m) => changeMode(locate(editor, el) ?? loc, m) : undefined,
          remove: editable ? () => removeLink(editor, locate(editor, el) ?? loc) : undefined,
        },
        { offline: navigator.onLine === false }
      );
    },
  });

  root.addEventListener("click", click);
  root.addEventListener("keydown", keydown, true);

  return {
    openSwitcherAt(placed, reason) {
      requestAnimationFrame(() => {
        const el = elementAt(editor, placed.pos, placed.at);
        const loc = el ? locate(editor, el) : null;
        if (loc) showSwitcher(loc, reason, false);
      });
    },
    destroy() {
      root.removeEventListener("click", click);
      root.removeEventListener("keydown", keydown, true);
      peeks.destroy();
      menu.destroy();
      if (current) closeSwitcher();
      if (peekShowing()) hidePeek();
      if (contextMenuOpen()) closeContextMenu();
      void scope;
    },
  };
}

const controllers = new WeakMap<Editor, Controller>();

/** After an address goes in (paste, @ menu, /card): the title when it comes, and the switcher. */
export function afterInsert(editor: Editor, url: string, placed: { pos: number; at: "node" | "mark" } | null): void {
  if (!placed) return;
  titleWhenReady(editor, url);
  controllers.get(editor)?.openSwitcherAt(placed, "paste");
}

// ---------- /card and /embed ----------

type SlashItem = { mode: "card" | "embed" | "paste"; title: string; sub: string };

const SLASH: SlashItem[] = [
  { mode: "card", title: "Card", sub: "A link as a card, with its picture" },
  { mode: "embed", title: "Embed", sub: "A video, song, map or design to play here" },
];

function slashRenderer(editor: Editor) {
  return () => {
    let menu: AtMenu | null = null;
    let props: SuggestionProps<SlashItem, SlashItem> | null = null;
    let items: SlashItem[] = [];
    let chosen: "card" | "embed" | null = null;

    const submit = (url: string) => {
      if (!props) return;
      const mode = chosen ?? (pasteMode(url, "empty-line") as "card" | "embed");
      if (mode === "embed" && !isEmbeddable(url)) {
        menu?.el.querySelector(".rl-menu__err")?.replaceChildren(NO_PLAYER);
        return;
      }
      const range = props.range;
      menu?.remove();
      menu = null;
      editor.commands.focus();
      afterInsert(editor, url, insertWebLink(editor, url, range, mode));
    };

    const rows = () => items.map((i) => ({ title: i.title, sub: i.sub, icon: i.mode === "card" ? ("image" as const) : ("play" as const), kind: "web" }));

    return {
      onStart(p: SuggestionProps<SlashItem, SlashItem>) {
        props = p;
        items = p.items;
        menu = atMenu({
          emptyText: "",
          onPick: (i) => {
            chosen = items[i]?.mode === "embed" ? "embed" : "card";
            menu?.startPaste(`Paste a link to show as ${MODE_LABEL[chosen].toLowerCase() === "card" ? "a card" : "an embed"}`);
          },
          onPaste: submit,
          onCancel: () => {
            menu?.remove();
            menu = null;
            editor.commands.focus();
          },
        });
        (document.querySelector("dialog[open]") ?? document.body).append(menu.el);
        menu.set(rows(), p.query);
        // Only "/c…" or "/e…" opens it: a slash in a date or a path doesn't.
        menu.el.hidden = !items.length;
        const r = p.clientRect?.();
        if (r) menu.place(r);
      },
      onUpdate(p: SuggestionProps<SlashItem, SlashItem>) {
        props = p;
        items = p.items;
        if (menu && !menu.pasting) {
          menu.set(rows(), p.query);
          menu.el.hidden = !items.length;
        }
        const r = p.clientRect?.();
        if (r && menu) menu.place(r);
      },
      onKeyDown({ event }: SuggestionKeyDownProps) {
        if (!menu || menu.pasting || !items.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          menu.move(event.key === "ArrowDown" ? 1 : -1);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          menu.pick();
          return true;
        }
        if (event.key === "Escape") {
          menu.remove();
          menu = null;
          return true;
        }
        return false;
      },
      onExit() {
        // Leaving for the address field isn't leaving.
        if (menu?.pasting && menu.el.contains(document.activeElement)) return;
        menu?.remove();
        menu = null;
        props = null;
      },
    };
  };
}

// ---------- The extension ----------

export const RichLinks = Extension.create<RichLinksOptions>({
  name: "richLinks",
  priority: 1000,

  addOptions() {
    return { onOpenLink: () => undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("richLinkPaste"),
        props: {
          handlePaste(view, event) {
            if (!editor.isEditable || !view.state.selection.empty) return false;
            const url = pastedUrl(event.clipboardData?.getData("text/plain"));
            if (!url) return false;
            const placed = insertWebLink(editor, url, null);
            if (!placed) return false;
            afterInsert(editor, url, placed);
            return true;
          },
        },
      }),
      Suggestion<SlashItem, SlashItem>({
        editor,
        pluginKey: new PluginKey("richLinkSlash"),
        char: "/",
        decorationClass: "mention-query",
        startOfLine: false,
        items: ({ query }) => SLASH.filter((i) => i.mode.startsWith(query.trim().toLowerCase())),
        command: () => undefined,
        render: slashRenderer(editor),
      }),
    ];
  },

  onCreate() {
    if (!this.editor.view?.dom) return;
    // A note that ends on a Card or Embed gets its line to type on now, not on
    // the first click (TrailingNode adds it then, mid-click, and the click's
    // selection would point at the old document).
    const last = this.editor.state.doc.lastChild;
    if (last?.type.name === "linkBlock" && this.editor.isEditable) {
      const end = this.editor.state.doc.content.size;
      this.editor.view.dispatch(this.editor.state.tr.insert(end, this.editor.schema.nodes.paragraph.create()).setMeta("addToHistory", false));
    }
    controllers.set(this.editor, controller(this.editor, this.options));
  },

  onDestroy() {
    controllers.get(this.editor)?.destroy();
    controllers.delete(this.editor);
  },
});

export { KEYS };
