/**
 * The rest of the editor's rich-link schema (athena-link.ts has the inline
 * Athena link):
 *
 *   webLink    a web page in the text, shown as a Mention (a pill with its
 *              favicon): [A slow walk](https://… "mention"). A web link that
 *              says "card" or "embed" in the middle of a sentence is kept here
 *              too and drawn as a Link, so it saves as it was.
 *   linkBlock  a Card or an Embed on its own line, for a web page or a thing
 *              in Athena: [@Priya Shah](athena://person/<id> "card"),
 *              [Canal locks](https://youtu.be/… "embed").
 *   link       StarterKit's Link mark, for a web link shown as plain words
 *              (the default), with a `mode` attribute read from the link title
 *              and written back with formatWebLink.
 *
 * Everything is read from and written back to Markdown with lib/links.ts, so
 * opening and saving a note keeps every link's mode.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import {
  ATHENA_LINK_START,
  LINK_KINDS,
  WEB_LINK_START,
  formatAthenaLink,
  formatWebLink,
  parseLinkMode,
  unescapeLabel,
  type LinkKind,
  type LinkMode,
} from "../../../lib/links";
import { athenaModeAttr } from "./athena-link";
import { linkNodeView } from "./link-view";

const isHttp = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

// ---------- webLink: a web Mention ----------

export const WebLink = Node.create({
  name: "webLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "",
  draggable: false,

  addAttributes() {
    return { url: { default: null }, label: { default: "" }, mode: { default: "mention" } };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-web-link]",
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const url = e.dataset.url;
          if (!isHttp(url)) return false;
          return { url, label: e.dataset.label ?? e.textContent ?? "", mode: parseLinkMode(e.dataset.mode) ?? "mention" };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-web-link": "", "data-url": node.attrs.url, "data-label": node.attrs.label, "data-mode": node.attrs.mode }), node.attrs.label];
  },

  addNodeView() {
    return linkNodeView();
  },

  renderText({ node }) {
    return String(node.attrs.label ?? "");
  },

  markdownTokenizer: {
    name: "webLink",
    level: "inline",
    start: (src: string) => {
      const m = /\[(?:\\.|[^\]\\\n])*\]\(https?:\/\/[^\s)]*[^)\n]*["'](?:mention|card|embed)["']/i.exec(src);
      return m ? m.index : -1;
    },
    tokenize(src: string) {
      const m = WEB_LINK_START.exec(src);
      if (!m) return undefined;
      const mode = parseLinkMode(m[3] ?? m[4]);
      // Plain Links (no title, or "link") stay ordinary Markdown links: the Link mark below.
      if (!mode || mode === "link") return undefined;
      return { type: "webLink", raw: m[0], label: unescapeLabel(m[1]), url: m[2], mode };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("webLink", { url: token.url, label: token.label, mode: token.mode });
  },

  renderMarkdown(node) {
    const { url, label, mode } = node.attrs as { url: string; label: string; mode: LinkMode };
    return formatWebLink(url, label, mode);
  },
});

// ---------- linkBlock: a Card or an Embed on its own line ----------

/** One link alone on a line, then a blank line or the end. Groups as ATHENA_LINK_START's or WEB_LINK_START's. */
const ATHENA_LINE = new RegExp(`^ {0,3}${ATHENA_LINK_START.source.slice(1)}[ \\t]*(?:\\n[ \\t]*(?:\\n|$)|$)`);
const WEB_LINE = new RegExp(`^ {0,3}${WEB_LINK_START.source.slice(1)}[ \\t]*(?:\\n[ \\t]*(?:\\n|$)|$)`);

export interface LinkBlockAttrs {
  target: "athena" | "web";
  kind: LinkKind | null;
  id: string | null;
  url: string | null;
  label: string;
  mode: "card" | "embed";
}

export const LinkBlock = Node.create({
  name: "linkBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  defining: true,

  addAttributes() {
    return {
      target: { default: "web" },
      kind: { default: null },
      id: { default: null },
      url: { default: null },
      label: { default: "" },
      mode: { default: "card" },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-link-block]",
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const d = e.dataset;
          const mode = parseLinkMode(d.mode);
          if (mode !== "card" && mode !== "embed") return false;
          if (d.target === "athena") {
            if (!LINK_KINDS.includes(d.kind as LinkKind) || !d.id) return false;
            return { target: "athena", kind: d.kind, id: d.id, label: d.label ?? "", mode: "card" };
          }
          if (!isHttp(d.url)) return false;
          return { target: "web", url: d.url, label: d.label ?? "", mode };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as LinkBlockAttrs;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-link-block": "",
        "data-target": a.target,
        "data-kind": a.kind ?? undefined,
        "data-id": a.id ?? undefined,
        "data-url": a.url ?? undefined,
        "data-label": a.label,
        "data-mode": a.mode,
      }),
      a.label,
    ];
  },

  addNodeView() {
    return linkNodeView();
  },

  renderText({ node }) {
    return String(node.attrs.label ?? "");
  },

  markdownTokenizer: {
    name: "linkBlock",
    level: "block",
    // Our own start: the default one runs a whole lexer per paragraph and loses its words.
    start: (src: string) => {
      const m = /(?:^|\n) {0,3}\[(?:\\.|[^\]\\\n])*\]\((?:athena|https?):\/\/[^\n]*["'](?:card|embed)["'][ \t]*\)[ \t]*(?:\n|$)/.exec(src);
      return m ? m.index + (m[0].startsWith("\n") ? 1 : 0) : -1;
    },
    tokenize(src: string) {
      const a = ATHENA_LINE.exec(src);
      if (a) {
        const mode = athenaModeAttr(a[4] ?? a[5]);
        if (mode !== "card") return undefined;
        return { type: "linkBlock", raw: a[0], target: "athena", kind: a[2], id: a[3].toLowerCase(), label: unescapeLabel(a[1]), mode: "card" };
      }
      const w = WEB_LINE.exec(src);
      if (w) {
        const mode = parseLinkMode(w[3] ?? w[4]);
        if (mode !== "card" && mode !== "embed") return undefined;
        return { type: "linkBlock", raw: w[0], target: "web", url: w[2], label: unescapeLabel(w[1]), mode };
      }
      return undefined;
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("linkBlock", { target: token.target, kind: token.kind ?? null, id: token.id ?? null, url: token.url ?? null, label: token.label, mode: token.mode });
  },

  renderMarkdown(node) {
    const a = node.attrs as LinkBlockAttrs;
    if (a.target === "athena" && a.kind && a.id) return formatAthenaLink(a.kind, a.id, a.label, "card");
    return formatWebLink(a.url ?? "", a.label, a.mode);
  },
});

// ---------- link: a web link shown as words ----------

/**
 * StarterKit's Link mark with the link's mode. The mode lives in the Markdown
 * link title; any other title is kept as a title, as before.
 */
export const WebLinkMark = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mode: {
        default: null,
        parseHTML: (el: HTMLElement) => parseLinkMode(el.dataset.mode) ?? null,
        renderHTML: (attrs: { mode?: string | null }) => ({ "data-rl-mode": attrs.mode ?? "link" }),
      },
    };
  },

  parseMarkdown: (token, helpers) => {
    const mode = parseLinkMode(token.title);
    return helpers.applyMark("link", helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: mode ? null : token.title || null,
      mode: mode ?? null,
    });
  },

  renderMarkdown: (node, h) => {
    const href: string = node.attrs?.href ?? "";
    const title: string = node.attrs?.title ?? "";
    const mode = parseLinkMode(node.attrs?.mode);
    const text = h.renderChildren(node);
    if (isHttp(href) && !title) {
      // formatWebLink writes the address and the mode; the words keep their own Markdown.
      const empty = formatWebLink(href, "", mode);
      return `[${text}${empty.slice(1)}`;
    }
    return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
  },
});
