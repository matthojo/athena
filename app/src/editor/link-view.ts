/**
 * One node view for every rich link the editor draws (link-nodes.ts): an
 * Athena link (Mention or Link), a web Mention and a Card or Embed block.
 * The view's own element stays put; what's inside is drawn again when the
 * link's data arrives or changes (link-data.ts) or its mode changes.
 *
 * The editor's controller (link-editor.ts) finds a link from a DOM element
 * through `linkAt()`, which gives the node, its position and what it points at.
 */

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { h } from "../lib/dom";
import { showToast } from "../components/toast";
import { CHOICE_MODES, holdsPreview, linkChosen, newHeldLinks, type ChoiceMode, type HeldLinks, type LinkChoice, type LinkKind } from "../../../lib/links";
import { linkData, previewFor, previewKnown, type LinkPreview, type LiveCard } from "./link-data";
import { isBlockMode, shownMode, type LinkMode, type LinkTarget } from "./link-model";
import { loadPlayer, renderLink, thingFor, type LinkState, type Thing } from "./link-render";

/** What a link node points at and how it's shown, from its attributes. */
export function targetOf(node: PMNode): LinkTarget | null {
  const a = node.attrs as Record<string, string | null>;
  if (node.type.name === "athenaLink" || (node.type.name === "linkBlock" && a.target === "athena")) {
    return a.kind && a.id ? { target: "athena", kind: a.kind as LinkKind, id: a.id } : null;
  }
  return a.url ? { target: "web", url: a.url } : null;
}

export const keyOf = (t: LinkTarget) => (t.target === "athena" ? `${t.kind}:${t.id}` : t.url);

// ---------- A note Athena wrote: its web links stay plain (security review M6) ----------

/**
 * A note written by a collection, the assistant or anything but the owner
 * (the editor's element was passed to `holdPreviewsIn`): every web link that
 * was in the body when it opened is drawn as a plain link and never asks for
 * a preview, whatever mode it was written with or what the text around it
 * says. A link the owner pastes, or one whose mode they change, is theirs: it
 * loads as usual and the choice is handed to `onChoice`, which keeps it with
 * the note on the server (lib/note-link-choices.ts), never in the Markdown.
 * `allowChosen` lets those through when the note is opened again.
 */
interface HeldEditor {
  links: HeldLinks;
  onChoice?: OnLinkChoice;
}
/** Hears each choice the owner makes in a note Athena wrote: a Card, Mention or Embed, or "link" when they take it back. */
export type OnLinkChoice = (url: string, mode: ChoiceMode | "link") => void;
const heldEditors = new WeakMap<Element, HeldEditor>();
const writtenAs = (node: PMNode) => `${node.type.name}:${String(node.attrs.mode ?? "")}`;
const isChoiceMode = (m: unknown): m is ChoiceMode => (CHOICE_MODES as readonly unknown[]).includes(m);

/** Call before the editor is made on `el`: its web links are held from the first draw. */
export function holdPreviewsIn(el: Element, opts: { onChoice?: OnLinkChoice } = {}): void {
  const links = newHeldLinks();
  heldEditors.set(el, { links, onChoice: opts.onChoice });
  // The body's views are all made in the same task as the editor.
  queueMicrotask(() => (links.opening = false));
}

function heldFor(editor: Editor): HeldEditor | null {
  const el = editor.options.element as unknown;
  return typeof Element !== "undefined" && el instanceof Element ? (heldEditors.get(el) ?? null) : null;
}

/**
 * The owner picked a mode for the link at `el` in the switcher (link-editor.ts). Picking the mode a held link
 * was written with changes nothing in the document, so the view never hears of it: this is how it does.
 * `mode` "link" on a web address takes the choice back.
 */
export function ownerPicked(editor: Editor, el: Element | null, target: LinkTarget, mode: LinkMode): void {
  const held = heldFor(editor);
  if (!held || target.target !== "web") return;
  if (mode === "link") {
    if (!held.links.choices.some((c) => c.url === target.url)) return;
    held.links.choices = held.links.choices.filter((c) => c.url !== target.url);
    held.onChoice?.(target.url, "link");
    return;
  }
  linkAt(el)?.view.pickedByOwner();
}

/** The owner's stored choices for this note have arrived: those links load, in the mode chosen. */
export function allowChosen(el: Element, choices: LinkChoice[]): void {
  const held = heldEditors.get(el);
  if (!held) return;
  held.links.choices = choices;
  for (const v of views) v.allowIfChosen(el);
}

// ---------- Live cards: one request per thing, redrawn when they change ----------

const lives = new Map<string, Promise<LiveCard | null>>();
/** Live cards that have arrived, so a view made again (undo, a mode change) draws at once. */
const livesKnown = new Map<string, LiveCard | null>();
const views = new Set<LinkNodeView>();
let unlisten: (() => void) | null = null;

function liveFor(kind: LinkKind, id: string, fresh = false): Promise<LiveCard | null> {
  const key = `${kind}:${id}`;
  if (!fresh && lives.has(key)) return lives.get(key)!;
  const p = linkData()
    .liveCard(kind, id)
    .catch(() => null);
  lives.set(key, p);
  void p.then((l) => {
    if (lives.get(key) === p) livesKnown.set(key, l);
  });
  return p;
}

function listen() {
  if (unlisten) return;
  unlisten = linkData().onLiveChange((kind, id) => {
    const key = `${kind}:${id}`;
    lives.delete(key);
    for (const v of views) if (v.key === key) v.refresh();
  });
}

/** What's known about a link right now, for peeks and menus: waits for its data. */
export async function thingNow(t: LinkTarget, label: string): Promise<Thing> {
  if (t.target === "web") return thingFor(t, label, { preview: await previewFor(t.url) });
  return thingFor(t, label, { live: await liveFor(t.kind, t.id) });
}

// ---------- The view ----------

const byDom = new WeakMap<HTMLElement, LinkNodeView>();

export interface LinkAt {
  node: PMNode;
  pos: number;
  target: LinkTarget;
  mode: LinkMode;
  label: string;
  view: LinkNodeView;
}

/** The link node a DOM element belongs to, or null. */
export function linkAt(el: Element | null): LinkAt | null {
  const holder = el?.closest<HTMLElement>("[data-rl-holder]");
  const v = holder ? byDom.get(holder) : undefined;
  if (!v) return null;
  const pos = v.pos();
  if (pos == null) return null;
  return { node: v.node, pos, target: v.target, mode: v.mode, label: v.label, view: v };
}

export class LinkNodeView implements NodeView {
  dom: HTMLElement;
  node: PMNode;
  target: LinkTarget;
  key: string;
  private preview: LinkPreview | null | undefined;
  private live: LiveCard | null | undefined;
  private drawn: HTMLElement | null = null;
  private playing = false;
  private dead = false;
  /** A web link Athena wrote: a plain link, no preview (see `Held`). */
  private plain = false;

  constructor(
    node: PMNode,
    private editor: Editor,
    private getPos: () => number | undefined
  ) {
    this.node = node;
    this.target = targetOf(node) ?? { target: "web", url: "" };
    this.key = keyOf(this.target);
    const block = node.type.name === "linkBlock";
    this.dom = h(block ? "div" : "span", { class: block ? "rl-holder rl-holder--block" : "rl-holder", "data-rl-holder": "", contenteditable: "false" });
    byDom.set(this.dom, this);
    views.add(this);
    listen();
    // What's already here draws straight away; no skeleton for a link seen before.
    const t = this.target;
    const held = t.target === "web" ? heldFor(editor) : null;
    this.plain = t.target === "web" && holdsPreview(held?.links ?? null, t.url, writtenAs(node), node.attrs.mode);
    // A link the owner added or changed after the note opened: theirs, and remembered.
    if (held && !held.links.opening && !this.plain) this.chose();
    if (this.plain) this.preview = null;
    else if (t.target === "web") this.preview = previewKnown(t.url);
    else if (livesKnown.has(this.key)) this.live = livesKnown.get(this.key);
    this.draw();
    this.load();
  }

  get mode(): LinkMode {
    if (this.plain) return "link";
    return shownMode(this.target, (this.node.attrs.mode as LinkMode | null) ?? null);
  }

  get label(): string {
    return String(this.node.attrs.label ?? "");
  }

  /** The element standing for the link now (for the switcher, peeks and the morph). */
  get el(): HTMLElement {
    return this.drawn ?? this.dom;
  }

  pos(): number | null {
    const p = this.getPos();
    return typeof p === "number" ? p : null;
  }

  thing(): Thing {
    return thingFor(this.target, this.label, { preview: this.preview, live: this.live });
  }

  private state(): LinkState {
    if (this.plain) return "loaded";
    const t = this.target;
    const data = t.target === "web" ? this.preview : this.live;
    if (data === undefined) {
      // Pills and Links know their words already; only cards and embeds wait in their final shape.
      if (!isBlockMode(this.mode)) return "loaded";
      return typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "loading";
    }
    if (t.target === "web" && this.preview?.status === "failed") return "failed";
    if (t.target === "athena" && this.live?.archived) return "failed";
    if (t.target === "athena" && this.live?.stale) return "offline";
    if (data === null && typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
    return "loaded";
  }

  private load(fresh = false) {
    const t = this.target;
    if (t.target === "web") {
      if (!t.url || this.plain) return;
      void previewFor(t.url, fresh).then((p) => {
        if (this.dead) return;
        this.preview = p;
        this.draw();
      });
    } else {
      void liveFor(t.kind, t.id, fresh).then((l) => {
        if (this.dead) return;
        this.live = l;
        this.draw();
      });
    }
  }

  /** In a note Athena wrote: tell the note this address and mode are the owner's choice (once). */
  private chose() {
    const t = this.target;
    const mode = this.node.attrs.mode;
    const held = heldFor(this.editor);
    if (!held || t.target !== "web" || !t.url || !isChoiceMode(mode) || linkChosen(held.links.choices, t.url, mode)) return;
    held.links.choices = [...held.links.choices.filter((c) => c.url !== t.url), { url: t.url, mode }];
    held.onChoice?.(t.url, mode);
  }

  /** The owner picked this link's mode in the switcher: it's theirs, it loads, and the choice is remembered. */
  pickedByOwner() {
    const t = this.target;
    if (t.target !== "web") return;
    if (this.plain) {
      this.plain = false;
      heldFor(this.editor)?.links.urls.delete(t.url);
      this.preview = previewKnown(t.url);
      this.draw();
      this.load();
    }
    this.chose();
  }

  /** The stored choices arrived (allowChosen): a held link the owner chose before loads now. */
  allowIfChosen(el: Element) {
    const t = this.target;
    if (!this.plain || t.target !== "web" || this.editor.options.element !== el) return;
    if (!linkChosen(heldFor(this.editor)?.links.choices ?? [], t.url, this.node.attrs.mode)) return;
    this.plain = false;
    this.preview = previewKnown(t.url);
    this.draw();
    this.load();
  }

  /** Ask again (a live change, or Try again). */
  refresh() {
    this.load(true);
  }

  draw() {
    if (this.playing) return;
    const t = this.thing();
    const mode = this.mode;
    const label = mode === "link" && this.node.type.name === "athenaLink" ? t.title : this.label;
    const el = renderLink(t, mode, this.state(), label, {
      onTodo: (done) => this.tick(done),
      onPlay: (el, byKeyboard) => {
        if (loadPlayer(el, t, byKeyboard)) this.playing = true;
      },
    });
    el.querySelector("[data-rl-retry]")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.preview = undefined;
      this.draw();
      this.load(true);
    });
    const selected = this.drawn?.classList.contains("is-selected");
    if (selected) el.classList.add("is-selected");
    // Keep the keyboard where it was when the link is drawn again.
    const hadFocus = !!this.drawn && this.drawn === document.activeElement;
    this.drawn = el;
    this.dom.replaceChildren(el);
    if (hadFocus) el.focus({ preventScroll: true });
  }

  private tick(done: boolean) {
    if (this.target.target !== "athena") return;
    const id = this.target.id;
    const data = linkData();
    data.toggleTodo(id).then(
      (now) =>
        showToast(now ? "Marked done" : "Marked not done", {
          icon: "check",
          action: { label: "Undo", run: () => void data.toggleTodo(id) },
        }),
      () => {
        showToast("Couldn't change that to-do", { icon: "close" });
        this.draw();
      }
    );
    void done;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const before = this.node;
    this.node = node;
    const t = targetOf(node);
    // The owner touched this link (its mode, label or address): it's theirs now, and remembered.
    if (this.plain) {
      this.plain = false;
      if (this.target.target === "web") heldFor(this.editor)?.links.urls.delete(this.target.url);
      this.preview = undefined;
      if (t && keyOf(t) === this.key) {
        this.chose();
        this.playing = false;
        this.draw();
        this.load();
        return true;
      }
    }
    if (t && keyOf(t) !== this.key) {
      this.target = t;
      this.key = keyOf(t);
      this.preview = undefined;
      this.live = undefined;
      this.playing = false;
      this.draw();
      this.load();
      return true;
    }
    if (t && keyOf(t) !== this.key || before.attrs.mode !== node.attrs.mode) queueMicrotask(() => this.chose());
    if (before.attrs.mode !== node.attrs.mode || before.attrs.label !== node.attrs.label) {
      this.playing = false;
      this.draw();
    }
    return true;
  }

  selectNode() {
    this.el.classList.add("is-selected");
  }

  deselectNode() {
    this.el.classList.remove("is-selected");
  }

  /** Buttons, the to-do's tick and a loaded player handle their own events. */
  stopEvent(e: Event): boolean {
    const t = e.target as Element | null;
    return !!t?.closest?.("button, input, a, iframe, .rl-embed__player");
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy() {
    this.dead = true;
    views.delete(this);
  }
}

/** A factory for TipTap's addNodeView(). */
export const linkNodeView =
  () =>
  ({ node, editor, getPos }: { node: PMNode; editor: Editor; getPos: () => number | undefined }) =>
    new LinkNodeView(node, editor, getPos);
