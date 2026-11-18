/**
 * Plain-text projection of a note's Markdown body, for everywhere that shows
 * a snippet rather than the editor: list rows, Home, Ask, search results.
 * '**', '#', list markers and link syntax never show; athena:// links become
 * their label ("@Priya Shah"). Returns text only — callers render it as text
 * nodes, never HTML.
 */

import { replaceAthenaLinks, unescapeLabel, webLinkRegex } from "../../../lib/links";

/** What a link shows: "@" marks people only, so "@Dentist" reads "Dentist". */
export function linkDisplayLabel(kind: string, label: string): string {
  return kind === "person" ? label : label.replace(/^@/, "");
}

/** "example.com" from an address: what a link with no words of its own reads as. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function markdownToText(markdown: string): string {
  // Links in any mode (lib/links.ts) read as their label: "card" and "embed" never show.
  let s = replaceAthenaLinks(markdown, (l) => linkDisplayLabel(l.kind, l.label)).replace(webLinkRegex(), (_m, label: string, url: string) => unescapeLabel(label) || hostOf(url));
  s = s
    // fenced code: keep the code, drop the fences
    .replace(/^```[^\n]*\n?/gm, "")
    // images, then links: keep the visible text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))+(?:\s+"[^"]*")?\)/g, "$1")
    // inline HTML the editor may emit (<u>) and any other tags
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, "")
    // headings, blockquotes, task and list markers at line start
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/gm, "$1")
    .replace(/^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/gm, "$1")
    // horizontal rules
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    // emphasis / strike / code spans
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    // backslash escapes
    .replace(/\\([\\`*_{}\[\]()#+\-.!~>|])/g, "$1")
    // entities the serializer may write
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
