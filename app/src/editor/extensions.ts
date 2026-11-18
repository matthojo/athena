/**
 * The editor's schema: what a note body can contain. Shared by the live
 * editor and the Markdown round-trip tests so they can't drift apart.
 * Anything outside this schema (raw HTML from an email digest, scripts,
 * images) is dropped by ProseMirror on parse — that is the sanitiser.
 */

import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "@tiptap/markdown";
import { AthenaLink } from "./athena-link";
import { LinkBlock, WebLink, WebLinkMark } from "./link-nodes";

/** Web links as words (lib/links.ts formatWebLink keeps their mode). */
const LINK_OPTIONS = {
  openOnClick: false,
  autolink: true,
  protocols: ["http", "https", "mailto", "tel"],
  HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank", class: "rl-link" },
};

export function baseExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      codeBlock: {},
      dropcursor: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    WebLinkMark.configure(LINK_OPTIONS),
    AthenaLink,
    WebLink,
    LinkBlock,
    Markdown.configure({ indentation: { style: "space", size: 2 } }),
  ];
}
