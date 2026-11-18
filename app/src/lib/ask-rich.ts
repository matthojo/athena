/**
 * An answer's text as Ask draws it: paragraphs split by a blank line, "- "
 * list lines, "1. " numbered lines, and **bold**, with citations and links inside any of them.
 * The same reading serves the finished reply and the draft while it's
 * written, so the words sit where they'll stay.
 *
 * richBlocks/boldSpans/plainText/draftRich are pure. richNodes builds
 * elements with the app's `h` (a DOM is needed, linkedom in tests); how a
 * citation and a run of text are drawn is the caller's.
 */
import { citationParts, stripCitations } from "../../../lib/answer-text";
import { linkPieces } from "../db/rich-links-rules";
import { h } from "./dom";

/** `nums`: each numbered line's own number, as the server kept it. */
export type RichBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] } | { kind: "ol"; items: string[]; nums: number[] };

const ITEM = /^[-•]\s+(.*)$/;
const STEP = /^(\d{1,3})\.\s+(.*)$/;
const isList = (b: RichBlock | null | undefined): b is Exclude<RichBlock, { kind: "p" }> => !!b && b.kind !== "p";

/** The text as blocks: a paragraph per blank-line gap, a list per run of "- " lines, a numbered one per run of "1. " lines. */
export function richBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let open: RichBlock | null = null;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (!t) {
      open = null;
      continue;
    }
    const item = ITEM.exec(t);
    const step = STEP.exec(t);
    const before: RichBlock | undefined = blocks[blocks.length - 1];
    const n = step ? Number(step[1]) : 0;
    // Straight under a paragraph's line only "1." starts a list: a wrapped line can begin with a figure ("…costs\n40. Then").
    if (step && (open?.kind !== "p" || n === 1)) {
      // Steps a blank line apart are still one list when the numbers run on.
      if (!open && before?.kind === "ol" && n === before.nums[before.nums.length - 1] + 1) open = before;
      if (open?.kind !== "ol") blocks.push((open = { kind: "ol", items: [], nums: [] }));
      open.items.push(step[2].trim());
      open.nums.push(n);
    } else if (item) {
      if (open?.kind !== "ul") blocks.push((open = { kind: "ul", items: [] }));
      open.items.push(item[1].trim());
    } else if (isList(open) && /^\s/.test(line) && open.items.length) {
      // An indented line carries on the item above it.
      open.items[open.items.length - 1] += ` ${t}`;
    } else if (open?.kind === "p") {
      open.text += ` ${t}`;
    } else blocks.push((open = { kind: "p", text: t }));
  }
  return blocks;
}

export interface BoldSpan {
  text: string;
  bold: boolean;
}

/** A line split at its **bold** runs. `open`: a run still being written is bold to the end; otherwise a stray marker is dropped. */
export function boldSpans(text: string, open = false): BoldSpan[] {
  const out: BoldSpan[] = [];
  const pieces = text.split("**");
  // An odd number of markers: the last one has no partner.
  const stray = pieces.length % 2 === 0;
  pieces.forEach((piece, i) => {
    let bold = i % 2 === 1;
    if (stray && i === pieces.length - 1) bold = open;
    if (!piece) return;
    const last = out[out.length - 1];
    if (last && last.bold === bold) last.text += piece;
    else out.push({ text: piece, bold });
  });
  return out;
}

/**
 * The text with its citation markers gone and its lines, list dashes and bold
 * kept (what a follow-up is sent). Its own reading of the markers: the shared
 * stripCitations is for speech and one-line previews, and flattens all three.
 */
export function withoutCitations(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) =>
      citationParts(line)
        .filter((part): part is string => typeof part === "string")
        .join("")
        .replace(/ +([.,;:!?])/g, "$1")
        .replace(/[ \t]+$/, "")
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text as it's said aloud: no markers, no bold, a list (dashes or numbers) read as sentences. */
export function plainText(text: string): string {
  const said = richBlocks(text).flatMap((b) => (b.kind === "p" ? [b.text] : b.items.map((item) => (/[.!?:;…]$/.test(stripCitations(item)) ? item : `${item}.`))));
  return stripCitations(said.join(" ").replace(/\*\*/g, ""));
}

/**
 * A draft cleaned for drawing: no code ticks or underscores, and nothing
 * half-written at its end (a marker, a link, one star of a bold marker, a
 * list dash or a step's number with no words yet). Its lines are kept.
 */
export function draftRich(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/__|`/g, "")
    // A marker or a link still being written ("[1", "[@Pri", "[@Priya](athena://pe") waits for the rest.
    .replace(/[ \t]?\[[^\]\n]*(?:\]\([^)\n]*)?$/, "")
    .replace(/(^|[^*])\*$/, "$1")
    // A new line's dash or number alone isn't drawn: "2" would read as a word, then jump into the list.
    .replace(/(?:^|\n)[ \t]*(?:[-•]|\d{1,3}\.?)?[ \t]*$/, "")
    .replace(/^\s+/, "");
}

export interface RichDraw {
  /** A citation's button (or a quiet placeholder while it's written); null when there's no such source. */
  cite: (n: number) => Node | null;
  /** A run of plain text as nodes, its links drawn. */
  text: (t: string) => Node[];
  /** A draft: a bold run still being written is bold to its end. */
  open?: boolean;
}

type Token = { t: string; bold: boolean } | { n: number };
const isText = (x: Token | undefined): x is { t: string; bold: boolean } => !!x && "t" in x;

/**
 * One line's words, bold runs and citations into `into`. A run of numbers is
 * glued to the word before it and the punctuation after it, so a number
 * never starts a line on its own.
 */
function drawInline(into: HTMLElement, line: string, draw: RichDraw): void {
  const tokens: Token[] = [];
  for (const span of boldSpans(line, draw.open)) for (const part of citationParts(span.text)) tokens.push(typeof part === "number" ? { n: part } : { t: part, bold: span.bold });
  const put = (target: HTMLElement, t: string, bold: boolean) => {
    if (!t) return;
    const nodes = draw.text(t);
    if (bold) target.append(h("strong", {}, ...nodes));
    else target.append(...nodes);
  };
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i];
    if (isText(tok) && isText(tokens[i + 1])) {
      put(into, tok.t, tok.bold);
      i++;
      continue;
    }
    if (isText(tok) && i === tokens.length - 1) {
      put(into, tok.t, tok.bold);
      break;
    }
    const before = isText(tok) ? tok.t : "";
    const bold = isText(tok) && tok.bold;
    // The word the number sticks to: a whole link when the text ends with one.
    const last = linkPieces(before).pop();
    const word = last && last.end === before.length ? before.slice(last.at) : /\S*$/.exec(before)![0];
    put(into, before.slice(0, before.length - word.length), bold);
    const group = h("span", { class: "cite-group" });
    put(group, word, bold);
    if (isText(tok)) i++;
    for (let next = tokens[i]; next && !isText(next); next = tokens[++i]) {
      const c = draw.cite(next.n);
      if (c) group.append(c);
    }
    const after = tokens[i];
    if (isText(after)) {
      const punct = /^[.,;:!?)\]]*/.exec(after.t)![0];
      put(group, punct, after.bold);
      tokens[i] = { t: after.t.slice(punct.length), bold: after.bold };
    }
    into.append(group);
  }
}

/** The text's blocks as elements: a <p> each, a <ul> for a list, an <ol> for numbered steps. Always at least one. */
export function richNodes(text: string, draw: RichDraw): HTMLElement[] {
  const blocks = richBlocks(text);
  if (!blocks.length) return [h("p", {})];
  return blocks.map((b) => {
    if (b.kind === "p") {
      const p = h("p", {});
      drawInline(p, b.text, draw);
      return p;
    }
    const items = b.items.map((item, i) => {
      // The number is drawn from data-n (styles/answer.css), in a column of its own; `value` says it to a screen reader.
      const li = b.kind === "ol" ? h("li", { value: b.nums[i], "data-n": b.nums[i] }) : h("li", {});
      drawInline(li, item, draw);
      return li;
    });
    // role="list": Safari drops a list's meaning once its markers are restyled.
    return b.kind === "ol" ? h("ol", { class: "rich__list rich__list--steps", role: "list", start: b.nums[0] }, ...items) : h("ul", { class: "rich__list" }, ...items);
  });
}

/** Where a draft's caret goes: the end of its last paragraph or list item. */
export function lastLine(nodes: HTMLElement[]): HTMLElement {
  const last = nodes[nodes.length - 1];
  return last.tagName === "UL" || last.tagName === "OL" ? ((last.lastElementChild as HTMLElement | null) ?? last) : last;
}
