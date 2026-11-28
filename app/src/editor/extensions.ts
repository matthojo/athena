/**
 * The editor's schema: what a note body can contain. Shared by the live
 * editor and the Markdown round-trip tests so they can't drift apart.
 * Anything outside this schema (raw HTML from an email digest, scripts,
 * images) is dropped by ProseMirror on parse — that is the sanitiser.
 */

import type { AnyExtension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { AthenaLink } from "./athena-link";
import { LinkBlock, WebLink, WebLinkMark } from "./link-nodes";
import { Callout, CalloutTitle, tableExtensions } from "./blocks";

/** Web links as words (lib/links.ts formatWebLink keeps their mode). */
const LINK_OPTIONS = {
  openOnClick: false,
  autolink: true,
  protocols: ["http", "https", "mailto", "tel"],
  HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank", class: "rl-link" },
};

/** A line's words as read aloud: a mention reads as its name. */
function checkboxWords(node: PMNode): string {
  return node
    .textBetween(0, node.content.size, " ", (leaf) => String((leaf.attrs as { label?: string }).label ?? "").replace(/^@/, ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function baseExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      codeBlock: {},
      // The line that shows where a dragged block lands (editor/block-handle.ts).
      dropcursor: { color: "var(--accent)", width: 2, class: "drop-cursor" },
    }),
    TaskList,
    // A line's checkbox says the line's words, a linked to-do's name included.
    TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node, checked) => `${checked ? "Done" : "Not done"}: ${checkboxWords(node) || "empty line"}` } }),
    WebLinkMark.configure(LINK_OPTIONS),
    AthenaLink,
    WebLink,
    LinkBlock,
    // Callouts and toggles (Obsidian's syntax, lib/callouts.ts) and GitHub-style tables.
    Callout,
    CalloutTitle,
    ...tableExtensions(),
    Markdown.configure({ indentation: { style: "space", size: 2 } }),
  ];
}
