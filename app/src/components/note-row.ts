import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { compactTime } from "../lib/format";
import { sourceText } from "../lib/sources";
import { linkDisplayLabel, markdownToText } from "../lib/markdown-text";
import { replaceAthenaLinks } from "../../../lib/links";
import { isEncryptedPlaceholder } from "../../../lib/encrypted";
import type { Note, NoteType } from "../types";

export const TYPE_ICON: Record<NoteType, IconName> = {
  note: "note",
  daily: "clock",
  project: "project",
  area: "folder",
  capture: "capture",
};

export const TYPE_LABEL: Record<NoteType, string> = {
  note: "Note",
  daily: "Daily",
  project: "Project",
  area: "Area",
  capture: "Capture",
};

/**
 * Captures get their title from the first ~77 characters of the body
 * (lib/db.ts capture()), so showing title and body as-is repeats the same
 * words. `rest` is the body (as plain text) with that duplicated opening removed.
 */
export function noteParts(note: Note): { title: string; rest: string; derived: boolean } {
  const { title, rest, derived } = markedParts(note);
  return { title, rest: unmark(rest), derived };
}

/*
 * Mentions in a snippet: a person is kept as their name between two
 * private-use marks, so a row can draw them as a chip; other things read
 * as their name (markdown-text.ts linkDisplayLabel). Plain
 * text (noteParts) drops the marks, so a person reads "Priya Shah", never
 * "@Priya Shah".
 */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const MARKED = /\uE000([^\uE000\uE001]*)\uE001/g;
const unmark = (s: string) => s.replace(/[\uE000\uE001]/g, "");

/** Like noteParts, with mentions marked in `rest`. */
function markedParts(note: Note): { title: string; rest: string; derived: boolean } {
  // Bodies are Markdown; every list/snippet shows the plain-text projection.
  // A body this copy of Athena can't decrypt says so once, in the title, not twice.
  const marked = isEncryptedPlaceholder(note.body)
    ? ""
    : markdownToText(replaceAthenaLinks(note.body.replace(/[\uE000\uE001]/g, ""), (l) => (l.kind === "person" ? `${OPEN}${l.label.replace(/^@/, "")}${CLOSE}` : linkDisplayLabel(l.kind, l.label))));
  const body = unmark(marked);
  const title = plainTitle(note.title) || body.split("\n")[0].slice(0, 80) || "Untitled";
  const stem = title.replace(/(\.\.\.|…)$/, "").trim();
  const derived = stem.length > 0 && body.startsWith(stem);
  return { title, rest: derived ? dropPlain(marked, stem.length).replace(/^[\s.,;:—-]+/, "") : marked, derived };
}

/**
 * A capture's title is the start of its raw text (lib/db.ts capture()), so a
 * mention can arrive whole ("[@Priya Shah](athena://person/…)") or cut short
 * at 77 characters ("[@Priya Shah](athena://pe..."). Either way it reads as the name.
 */
export function plainTitle(raw: string): string {
  const linked = replaceAthenaLinks(raw.trim(), (l) => l.label.replace(/^@/, ""));
  return linked
    .replace(/\[@?([^\]\n]*)\]\(athena:\/\/[^)\s]*?(\.\.\.|…)?$/, (_m, name: string, dots?: string) => `${name}${dots ?? ""}`)
    .replace(/\[@([^\]\n]*?)(\.\.\.|…)$/, "$1$2")
    .trim();
}

/** `marked` without its first `n` visible characters (marks don't count); a mention cut in two stays a chip. */
function dropPlain(marked: string, n: number): string {
  let i = 0;
  let open = false;
  for (; i < marked.length && n > 0; i++) {
    if (marked[i] === OPEN) open = true;
    else if (marked[i] === CLOSE) open = false;
    else n--;
  }
  return (open ? OPEN : "") + marked.slice(i);
}

/** Text with marked mentions as quiet chips: inside a row, which is the button, so they aren't buttons themselves. */
function mentionText(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKED)) {
    if (m.index! > at) out.push(document.createTextNode(text.slice(at, m.index)));
    out.push(h("span", { class: "mention mention--person row__mention" }, m[1]));
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(unmark(text.slice(at))));
  return out;
}

/** The first `max` visible characters of a marked snippet, with no mention left open. */
function clipMarked(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let n = 0;
  let i = 0;
  let open = false;
  for (; i < flat.length && n < max; i++) {
    if (flat[i] === OPEN) open = true;
    else if (flat[i] === CLOSE) open = false;
    else n++;
  }
  return flat.slice(0, i) + (open ? CLOSE : "");
}

/** Text nodes with case-insensitive matches of `terms` wrapped in <mark>. Never innerHTML. */
export function highlight(text: string, terms: string[]): Node[] {
  const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return [document.createTextNode(text)];
  const nodes: Node[] = [];
  text.split(new RegExp(`(${escaped.join("|")})`, "gi")).forEach((part, i) => {
    if (part) nodes.push(i % 2 ? h("mark", {}, part) : document.createTextNode(part));
  });
  return nodes;
}

function snippetFor(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined || at < 60) return flat.slice(0, 180);
  return `…${flat.slice(at - 40, at + 140)}`;
}

export function noteRow(note: Note, opts: { onOpen: (n: Note) => void; terms?: string[]; current?: boolean }): HTMLButtonElement {
  const terms = opts.terms ?? [];
  const { title, rest: marked } = markedParts(note);
  const rest = unmark(marked);
  // Searching highlights matches in plain text; otherwise mentions show as chips.
  const snippet = rest ? (terms.length ? snippetFor(rest, terms) : clipMarked(marked, 180)) : "";
  const queued = note.id.startsWith("local-");

  const row = h(
    "button",
    {
      class: "row",
      type: "button",
      "data-id": note.id,
      "aria-current": opts.current ? "true" : undefined,
      "data-encrypted": isEncryptedPlaceholder(note.title),
    },
    h("span", { class: "tile tile--sm" }, icons[TYPE_ICON[note.type]]()),
    h(
      "span",
      { class: "row__body" },
      h(
        "span",
        { class: "row__title-line" },
        h("span", { class: "row__title" }, ...highlight(title, terms)),
        queued ? h("span", { class: "badge badge--queued" }, "Waiting to sync") : null
      ),
      snippet ? h("span", { class: "row__snippet" }, ...(terms.length ? highlight(snippet, terms) : mentionText(snippet))) : null,
      // Your own notes need no source line; ones from a collection say which.
      note.source === "manual" ? null : h("span", { class: "row__meta" }, sourceText(note.source))
    ),
    h("span", { class: "row__time" }, compactTime(note.updated_at))
  );
  row.addEventListener("click", () => opts.onOpen(note));
  return row;
}
