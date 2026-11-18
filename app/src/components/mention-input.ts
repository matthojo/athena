/**
 * Ask's message field, with @ mentions. Type @ and a few letters and the list
 * (components/mention-menu.ts) shows anything in Athena that matches; pick one
 * with the arrows and Enter or Tab (or a tap) and it sits in the text as a
 * chip. Backspace takes a chip away whole; Esc closes the list. A pasted
 * athena:// link becomes a chip too.
 *
 * Its value is the message as sent: plain text with each chip written as its
 * athena:// link (lib/links.ts), so the assistant gets the exact ids. A
 * contenteditable line rather than an <input>, because an input can't hold a
 * chip; nothing is ever set as HTML.
 */

import { h } from "../lib/dom";
import { linkDisplayLabel } from "../lib/markdown-text";
import { athenaLinkRegex, formatAthenaLink, LINK_KINDS, unescapeLabel, type LinkKind } from "../../../lib/links";
import { MENTION_KIND_LABEL, mentionLabel, mentionsToText, type MentionResult } from "../../../lib/mentions";
import { mentionIcon, mentionMenu, type MenuRow } from "./mention-menu";

export interface MentionInput {
  el: HTMLElement;
  /** The message with its mentions as athena:// links. Setting it draws the chips. */
  value: string;
  /** The message as it reads ("move @Green dress to…"). */
  readonly text: string;
  placeholder: string;
  focus(opts?: FocusOptions): void;
  /** The list is open (Enter picks rather than sends). */
  readonly suggesting: boolean;
  destroy(): void;
}

export interface MentionInputOptions {
  placeholder: string;
  label: string;
  search: (q: string, signal: AbortSignal) => Promise<MentionResult[]>;
  thumb?: (row: MentionResult) => Promise<string | null> | null;
  onPick?: (row: MentionResult) => void;
  /** A pasted bare athena:// link's real title (it arrives labelled with its kind until then). */
  lookup?: (kind: LinkKind, id: string) => Promise<Pick<MentionResult, "title"> | null>;
  onInput: () => void;
  onSubmit: () => void;
}

const SHEET = window.matchMedia("(max-width: 719px)");
/** An @ that starts a word, then what's typed since (spaces allowed, like the editor's). */
const TRIGGER = /(^|[\s([{"“'‘])@([^@\n]{0,48})$/u;

/** The chip for one mention: the same look as the editor's. */
export function mentionChip(kind: LinkKind, id: string, label: string, opts: { editable?: boolean } = {}): HTMLElement {
  return h(
    "span",
    {
      class: `mention mention--${kind}`,
      "data-athena-link": "",
      "data-kind": kind,
      "data-id": id,
      "data-label": label,
      ...(opts.editable ? { contenteditable: "false" } : { role: "link", tabindex: "0" }),
    },
    linkDisplayLabel(kind, label)
  );
}

/** Text with athena:// links as nodes: chips for links, text for the rest. */
export function mentionNodes(text: string, opts: { editable?: boolean } = {}): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(athenaLinkRegex())) {
    if (m.index! > at) out.push(document.createTextNode(text.slice(at, m.index)));
    out.push(mentionChip(m[2] as LinkKind, m[3].toLowerCase(), unescapeLabel(m[1]), opts));
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

/** A sent message or a reply, with its mentions as chips that open what they point at. */
export function mentionText(text: string, open: (kind: LinkKind, id: string) => void): Node[] {
  const nodes = mentionNodes(text);
  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    const go = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      open(n.dataset.kind as LinkKind, n.dataset.id!);
    };
    n.addEventListener("click", go);
    n.addEventListener("keydown", (e) => e.key === "Enter" && go(e));
  }
  return nodes;
}

const isChip = (n: Node | null | undefined): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute("data-athena-link");

export function mentionInput(opts: MentionInputOptions): MentionInput {
  const el = h("div", {
    class: "mention-input",
    contenteditable: "true",
    role: "textbox",
    "aria-multiline": "false",
    "aria-label": opts.label,
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-haspopup": "listbox",
    enterkeyhint: "send",
    autocapitalize: "sentences",
    spellcheck: "true",
    "data-placeholder": opts.placeholder,
  });

  let rows: MentionResult[] = [];
  /** The @ being answered: its text node and where the @ is in it. */
  let trigger: { node: Text; start: number; query: string } | null = null;
  /** An @ closed with Esc stays closed until the caret leaves it. */
  let dismissed: { node: Text; start: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;

  const menu = mentionMenu({ emptyText: "Type a name or a title", label: "Things to mention", onPick: (i) => pick(i) });
  el.setAttribute("aria-controls", menu.el.id);

  const toRows = (list: MentionResult[]): MenuRow[] =>
    list.map((r) => ({
      title: r.title,
      // A note's type ("capture") means nothing here; everything else says what it is, then a detail.
      sub: [MENTION_KIND_LABEL[r.kind], r.kind === "note" ? "" : r.subtitle].filter(Boolean).join(" · "),
      icon: mentionIcon(r.kind, r.kind_id),
      thumb: opts.thumb?.(r) ?? null,
    }));

  const place = () => {
    const bar = el.closest("form") ?? el;
    menu.place({ above: bar.getBoundingClientRect(), sheet: SHEET.matches });
  };

  const close = () => {
    clearTimeout(timer);
    inflight?.abort();
    inflight = null;
    trigger = null;
    rows = [];
    menu.remove();
    el.setAttribute("aria-expanded", "false");
    el.removeAttribute("aria-activedescendant");
  };

  const show = (list: MentionResult[], query: string) => {
    rows = list;
    // Spaces are allowed, so a sentence after an @ isn't a search: no matches and a space, and the list goes.
    if (!list.length && /\s/.test(query)) return close();
    menu.set(toRows(list), query);
    if (!menu.el.isConnected) (document.querySelector("dialog[open]") ?? document.body).append(menu.el);
    el.setAttribute("aria-expanded", "true");
    if (menu.size) el.setAttribute("aria-activedescendant", `${menu.el.id}-${menu.active}`);
    place();
  };

  /** What's before the caret, if it's an @ being typed. */
  const findTrigger = (): { node: Text; start: number; query: string } | null => {
    const sel = document.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    if (!(node instanceof Text)) return null;
    const before = node.data.slice(0, sel.anchorOffset).replace(/\u00a0/g, " ");
    const m = TRIGGER.exec(before);
    if (!m) return null;
    return { node, start: m.index + m[1].length, query: m[2] };
  };

  const check = () => {
    const t = findTrigger();
    if (dismissed && (!t || t.node !== dismissed.node || t.start !== dismissed.start)) dismissed = null;
    if (!t || dismissed) return trigger ? close() : undefined;
    const same = trigger && trigger.node === t.node && trigger.start === t.start && trigger.query === t.query;
    trigger = t;
    if (same) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      inflight?.abort();
      const stop = (inflight = new AbortController());
      const query = t.query.trim();
      try {
        const found = await opts.search(query, stop.signal);
        if (stop.signal.aborted || trigger?.query !== t.query) return;
        show(found, query);
      } catch {
        if (!stop.signal.aborted && trigger) show([], query);
      }
    }, 120);
  };

  /** The @query becomes a chip and a space; the caret goes after them. */
  const pick = (i: number) => {
    const row = rows[i];
    const t = trigger;
    if (!row || !t) return;
    const range = document.createRange();
    const end = Math.min(t.node.length, t.start + 1 + t.query.length);
    range.setStart(t.node, t.start);
    range.setEnd(t.node, end);
    range.deleteContents();
    const chip = mentionChip(row.kind, row.id, mentionLabel(row.title), { editable: true });
    // A non-breaking space, so the caret shows after a chip at the end of the line (it's sent as a plain space).
    const after = t.node.splitText(t.start);
    const space = document.createTextNode(/^[ \u00a0]/.test(after.data) ? "" : "\u00a0");
    t.node.after(chip, space);
    caretAfter(space.data ? space : chip);
    close();
    opts.onPick?.(row);
    changed();
  };

  const caretAfter = (node: Node) => {
    const sel = document.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  /** The chip just before (or after) a collapsed caret, if the caret is up against one. */
  const chipBeside = (forward: boolean): HTMLElement | null => {
    const sel = document.getSelection();
    if (!sel || !sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    const offset = sel.anchorOffset;
    if (node instanceof Text) {
      if (forward ? offset < node.length : offset > 0) return null;
      const next = forward ? node.nextSibling : node.previousSibling;
      return isChip(next) ? next : null;
    }
    const next = forward ? node.childNodes[offset] : node.childNodes[offset - 1];
    return isChip(next) ? next : null;
  };

  /** Tidy after an edit: an empty field is truly empty (so the placeholder shows), and the owner hears about it. */
  const changed = () => {
    if (!el.textContent?.replace(/\u00a0/g, " ").trim() && !el.querySelector("[data-athena-link]")) el.replaceChildren();
    wrap();
    opts.onInput();
  };
  /** More than one line: the bar becomes a rounded box and its buttons sit at the bottom (styles/mentions.css). */
  const wrap = () => el.closest("form")?.classList.toggle("is-wrapped", el.scrollHeight > 52);

  /** Put nodes where the caret is, replacing any selection; the caret goes after them. */
  const insertNodes = (nodes: Node[]) => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      el.append(...nodes);
      if (nodes.length) caretAfter(nodes[nodes.length - 1]);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    for (const n of [...nodes].reverse()) range.insertNode(n);
    if (nodes.length) caretAfter(nodes[nodes.length - 1]);
  };

  el.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (trigger && menu.el.isConnected) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (menu.move(e.key === "ArrowDown" ? 1 : -1)) el.setAttribute("aria-activedescendant", `${menu.el.id}-${menu.active}`);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && menu.size) {
        e.preventDefault();
        pick(menu.active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissed = { node: trigger.node, start: trigger.start };
        close();
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.shiftKey) opts.onSubmit();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const chip = chipBeside(e.key === "Delete");
      if (chip) {
        e.preventDefault();
        const prev = chip.previousSibling;
        chip.remove();
        if (prev) caretAfter(prev);
        el.normalize();
        changed();
      }
    }
  });

  el.addEventListener("input", () => {
    changed();
    check();
  });
  el.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") check();
  });
  el.addEventListener("click", check);
  el.addEventListener("blur", () => setTimeout(() => document.activeElement !== el && close(), 0));
  // Words only (a file pasted is the composer's); an athena:// link in them becomes a chip.
  el.addEventListener("paste", (e) => {
    if (e.clipboardData?.files.length) return;
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    const bare = /^\s*athena:\/\/([a-z]+)\/([0-9a-f-]{36})\s*$/i.exec(text);
    const one = bare && (LINK_KINDS as readonly string[]).includes(bare[1].toLowerCase()) ? formatAthenaLink(bare[1].toLowerCase() as LinkKind, bare[2].toLowerCase(), `@${MENTION_KIND_LABEL[bare[1].toLowerCase() as LinkKind]}`) : null;
    const nodes = mentionNodes((one ?? text).replace(/\s*\n\s*/g, " "), { editable: true });
    insertNodes(nodes);
    changed();
    if (one && opts.lookup) {
      const chip = nodes.find(isChip);
      const kind = bare![1].toLowerCase() as LinkKind;
      void opts.lookup(kind, bare![2].toLowerCase()).then((row) => {
        if (!row || !chip?.isConnected) return;
        const label = mentionLabel(row.title);
        chip.dataset.label = label;
        chip.textContent = linkDisplayLabel(kind, label);
        changed();
      });
    }
  });
  el.addEventListener("drop", (e) => {
    // Files dropped are the composer's; dropped text would bring its markup with it.
    if (!e.dataTransfer?.files.length) e.preventDefault();
  });
  const onResize = () => menu.el.isConnected && place();
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);

  const serialise = (): string => {
    let out = "";
    for (const n of el.childNodes) {
      if (n instanceof Text) out += n.data;
      else if (isChip(n)) out += formatAthenaLink(n.dataset.kind as LinkKind, n.dataset.id!, n.dataset.label ?? "");
      else if (n instanceof HTMLElement) out += n.tagName === "BR" ? " " : (n.textContent ?? "");
    }
    return out.replace(/\u00a0/g, " ");
  };

  return {
    el,
    get value() {
      return serialise();
    },
    set value(v: string) {
      close();
      el.replaceChildren(...mentionNodes(v, { editable: true }));
      requestAnimationFrame(wrap);
    },
    get text() {
      return mentionsToText(serialise());
    },
    get placeholder() {
      return el.dataset.placeholder ?? "";
    },
    set placeholder(p: string) {
      el.dataset.placeholder = p;
    },
    get suggesting() {
      return !!trigger && menu.el.isConnected;
    },
    focus(o) {
      el.focus(o);
      // At the end, as an input's focus would be.
      const sel = document.getSelection();
      if (sel && !el.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    },
    destroy() {
      close();
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    },
  };
}
