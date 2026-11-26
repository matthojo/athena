/**
 * Text with links in it, as Ask shows a message or an answer: every link by
 * its mode (lib/links.ts), never as raw Markdown.
 *
 *  - A thing in Athena: a Mention or a Card is the mention chip; a Link is
 *    its name as a text link. A card in a chat line stays a chip, since a
 *    message is a sentence.
 *  - A web page: always its label as a plain link, whatever mode its title
 *    asks for. Ask's text is written by a model, so a link in it never gets
 *    a card, a favicon or a preview: nothing is fetched until the owner
 *    clicks it (security review M6).
 *
 * Built from text nodes and elements only, never HTML.
 */

import { h } from "../lib/dom";
import { mentionChip } from "./mention-input";
import { linkDisplayLabel } from "../lib/markdown-text";
import { linkPieces } from "../db/rich-links-rules";
import type { LinkKind } from "../../../lib/links";
import "../styles/link-text.css";

export { linkPieces };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Text as nodes, with every link drawn by its mode. `open` is called for a
 * thing in Athena; web links are ordinary links that open in a new tab.
 */
export function linkTextNodes(text: string, open: (kind: LinkKind, id: string) => void): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const p of linkPieces(text)) {
    if (p.at > at) out.push(document.createTextNode(text.slice(at, p.at)));
    at = p.end;
    if (p.target === "web") {
      // Always a plain link, whatever mode its title asks for: this text may be a model's, and a preview would read the page.
      out.push(h("a", { class: "text-link", href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.label || hostOf(p.url)));
      continue;
    }
    const el = p.mode === "link" ? h("span", { class: "text-link", role: "link", tabindex: "0", "data-athena-link": "", "data-kind": p.kind, "data-id": p.id }, linkDisplayLabel(p.kind, p.label).replace(/^@/, "")) : mentionChip(p.kind, p.id, p.label);
    const go = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      open(p.kind, p.id);
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && go(e));
    out.push(el);
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}
