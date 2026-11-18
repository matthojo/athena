/**
 * The inline "athena link" node: a person, place, organisation, event, note
 * or anything else in Athena mentioned in a note body. Stored in Markdown as
 * `[@Priya Shah](athena://person/<uuid>)`, with how it's shown in the link
 * title when it isn't the default: `[@Priya Shah](athena://person/<uuid> "link")`.
 * The custom tokenizer below runs before marked's own link tokenizer, so
 * these never become ordinary links. See lib/links.ts for the syntax.
 *
 * In the text it's a Mention (a pill) or a Link (words). A Card on its own
 * line is a block (link-nodes.ts LinkBlock); one written mid-sentence keeps
 * its "card" and is drawn as a Link, so it saves exactly as it was.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { ATHENA_LINK_START, formatAthenaLink, LINK_KINDS, parseLinkMode, unescapeLabel, type LinkKind, type LinkMode } from "../../../lib/links";
import { linkDisplayLabel } from "../lib/markdown-text";
import { linkNodeView } from "./link-view";

export interface AthenaLinkAttrs {
  kind: LinkKind;
  id: string;
  label: string;
  /** As the Markdown says it; null is the default (Mention). */
  mode: LinkMode | null;
}

/** Index of the first possible athena link in `src`, or -1. */
function startOf(src: string): number {
  const m = /\[(?:\\.|[^\]\\\n])*\]\(athena:\/\//.exec(src);
  return m ? m.index : -1;
}

/** A mode as an attribute: null for the default, card for an embed (things in Athena never embed). */
export function athenaModeAttr(raw: string | null | undefined): LinkMode | null {
  const m = parseLinkMode(raw);
  if (!m || m === "mention") return null;
  return m === "embed" ? "card" : m;
}

export const AthenaLink = Node.create({
  name: "athenaLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  // The Markdown serializer only wraps text in marks, so a bolded mention
  // would silently lose its bold on save. Mentions take no formatting.
  marks: "",
  draggable: false,

  addAttributes() {
    return {
      kind: { default: "person" },
      id: { default: null },
      label: { default: "" },
      mode: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-athena-link]",
        getAttrs: (el) => {
          const e = el as HTMLElement;
          const kind = e.dataset.kind as LinkKind;
          if (!LINK_KINDS.includes(kind) || !e.dataset.id) return false;
          return { kind, id: e.dataset.id, label: e.dataset.label ?? e.textContent ?? "", mode: athenaModeAttr(e.dataset.mode) };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { kind, id, label, mode } = node.attrs as AthenaLinkAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-athena-link": "",
        "data-kind": kind,
        "data-id": id,
        "data-mode": mode ?? undefined,
        class: `mention mention--${kind}`,
        "data-label": label,
        role: "link",
        tabindex: "0",
      }),
      // The stored label keeps the agents' "@" convention; only people show it.
      linkDisplayLabel(kind, label),
    ];
  },

  addNodeView() {
    return linkNodeView();
  },

  renderText({ node }) {
    return (node.attrs as AthenaLinkAttrs).label;
  },

  markdownTokenizer: {
    name: "athenaLink",
    level: "inline",
    start: startOf,
    tokenize(src) {
      const m = ATHENA_LINK_START.exec(src);
      if (!m) return undefined;
      return { type: "athenaLink", raw: m[0], label: unescapeLabel(m[1]), kind: m[2], id: m[3].toLowerCase(), mode: athenaModeAttr(m[4] ?? m[5]) };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("athenaLink", { kind: token.kind, id: token.id, label: token.label, mode: token.mode ?? null });
  },

  renderMarkdown(node) {
    const { kind, id, label, mode } = (node.attrs ?? {}) as AthenaLinkAttrs;
    return formatAthenaLink(kind, id, label, mode);
  },
});
