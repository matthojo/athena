/**
 * The Add screen's note template (lib/template-share.ts): the template drawn as a note made from it would look,
 * by the note editor itself, read-only (editor/editor.ts), so its headings, lists and to-dos look as they will and
 * each {{field}} is marked as a blank, as the editor marks one. Its opening heading is the note's title, as when a
 * note is made from it (lib/templates.ts splitTitle), with its blanks marked too. Under it, each field and where it
 * fills in from.
 *
 * The body was made plain as it was read: links are plain links, pictures and embedded pages are gone, so nothing in
 * the preview loads anything.
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { blankRanges, parseTemplate } from "../../../lib/templates";
import type { SharedTemplate } from "../../../lib/template-share";
import { fieldLine } from "./words";

export function templatePreview(t: SharedTemplate): { el: HTMLElement; fields: HTMLElement | null; destroy: () => void } {
  const m = /^\s*#\s+(.+)\n+/.exec(t.body);
  const title = m ? m[1].trim() : t.name;
  const body = m ? t.body.slice(m[0].length) : t.body;
  const content = h("div", { class: "add-tpl__body editor__content", "aria-busy": "true" });
  let destroy = () => undefined as void;
  void import("../editor/editor").then(({ createNoteEditor }) => {
    const ed = createNoteEditor({ markdown: body, readOnly: true, athenaWrote: true, onChange: () => undefined, onOpenLink: () => undefined, search: async () => [] });
    ed.content.classList.add("add-tpl__body");
    content.replaceWith(ed.content);
    destroy = ed.destroy;
  });
  const el = h(
    "figure",
    { class: "add-tpl", "aria-label": "How a note from it looks" },
    h("div", { class: "add-tpl__page" }, h("p", { class: "add-tpl__title" }, ...withBlanks(title)), content),
    h("figcaption", { class: "add-tpl__caption" }, icons.note(), h("span", {}, "As a note from it would look. Marked parts fill in when you use it, or stay for you to write."))
  );

  const parsed = parseTemplate(t.body);
  const fields = parsed.length
    ? h(
        "ul",
        { class: "add-tpl-fields card card--flush" },
        ...parsed.map((f) =>
          h(
            "li",
            { class: `add-tpl-field${f.info ? "" : " is-unknown"}` },
            h("code", { class: "add-tpl-field__name" }, `{{${f.name}}}`),
            h("span", { class: "add-tpl-field__source" }, fieldLine(f.info))
          )
        )
      )
    : null;
  return { el, fields, destroy: () => destroy() };
}

/** Text with each {{field}} in it marked as the editor marks a blank. */
function withBlanks(text: string): Array<string | HTMLElement> {
  const out: Array<string | HTMLElement> = [];
  let at = 0;
  for (const [from, to] of blankRanges(text)) {
    if (from > at) out.push(text.slice(at, from));
    out.push(h("span", { class: "doc-blank", title: "Left for you to fill in" }, text.slice(from, to)));
    at = to;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
