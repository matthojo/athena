/**
 * Callouts and toggles in a note's Markdown, written the way Obsidian writes
 * them, so a note reads the same in Athena, in an exported vault and on
 * GitHub (other renderers show a quote):
 *
 *   > [!tip] Optional title
 *   > What the callout says.
 *
 *   > [!note]- Packing list        a toggle: "-" starts folded, "+" open
 *   > - Passport
 *
 * The type after "!" is kept exactly as written. Athena draws four tones
 * from it (toneOf): plain, tip, key and warning; any type it doesn't know
 * is plain. A callout with "-" or "+" after its type is a toggle.
 *
 * Pure, no imports: the editor (app/src/editor/callout.ts), plain-text
 * snippets and the server's readers share it.
 */

/** For agents that write note bodies (MCP, Ask): the blocks beyond plain Markdown, in one sentence. */
export const NOTE_BLOCKS_SYNTAX =
  "A body can also hold GitHub-style tables, and callouts and toggles as Obsidian writes them: '> [!tip] Optional title' then '> ' lines " +
  "(types note, tip, important, warning), and a toggle with '-' after the type: '> [!note]- Packing list'.";

export const CALLOUT_TONES = ["note", "tip", "key", "warning"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/** The type Athena writes for each tone. */
export const TONE_TYPE: Record<CalloutTone, string> = { note: "note", tip: "tip", key: "important", warning: "warning" };

const TONE_OF: Record<string, CalloutTone> = {
  tip: "tip",
  hint: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  important: "key",
  question: "key",
  help: "key",
  faq: "key",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  danger: "warning",
  error: "warning",
  bug: "warning",
  failure: "warning",
  fail: "warning",
  missing: "warning",
};

/** The tone a callout type is drawn in. */
export function toneOf(type: string): CalloutTone {
  return TONE_OF[type.toLowerCase()] ?? "note";
}

export type CalloutFold = "-" | "+" | null;

export interface CalloutHead {
  type: string;
  fold: CalloutFold;
  /** The title as written (inline Markdown), or "". */
  title: string;
}

/** A callout's first line: `> [!type]`, then an optional fold and title. Groups: 1 type, 2 fold, 3 title. */
export const CALLOUT_HEAD = /^ {0,3}>[ \t]?\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+([^\n]*?))?[ \t]*$/;

/** The callout a line opens, or null. */
export function calloutHead(line: string): CalloutHead | null {
  const m = CALLOUT_HEAD.exec(line);
  if (!m) return null;
  return { type: m[1], fold: (m[2] || null) as CalloutFold, title: m[3] ?? "" };
}

/** The first line Athena writes for a callout. */
export function formatCalloutHead(head: CalloutHead): string {
  return `> [!${head.type}]${head.fold ?? ""}${head.title ? ` ${head.title}` : ""}`;
}

/**
 * A callout at the start of `src`: its head, the Markdown inside it (with
 * each line's "> " taken off) and how much of `src` it covers. It runs until
 * the first line that isn't part of the quote.
 */
export function readCallout(src: string): { head: CalloutHead; inner: string; raw: string } | null {
  const lines = src.split("\n");
  const head = calloutHead(lines[0]);
  if (!head) return null;
  let n = 1;
  while (n < lines.length && /^ {0,3}>/.test(lines[n])) n++;
  const inner = lines
    .slice(1, n)
    .map((l) => l.replace(/^ {0,3}>[ \t]?/, ""))
    .join("\n");
  // The newline after the last line belongs to the callout, as marked's own blocks take theirs.
  const raw = lines.slice(0, n).join("\n") + (n < lines.length ? "\n" : "");
  return { head, inner, raw };
}

/** A callout's head line as plain text: its title, or nothing. For snippets and search previews. */
export function calloutHeadText(markdown: string): string {
  return markdown.replace(/^([ \t]*>[ \t]?)\[![A-Za-z][\w-]*\][+-]?[ \t]*/gm, "$1");
}

/**
 * Callouts and toggles as plain quotes, for readers outside Athena that don't
 * know Obsidian's syntax (Word, Google Docs, Notion): the head line becomes the
 * title in bold, or goes when there's no title, and what's inside stays.
 */
export function calloutsAsQuotes(markdown: string): string {
  return markdown
    .split("\n")
    .flatMap((line) => {
      const head = calloutHead(line);
      if (!head) return [line];
      const lead = line.slice(0, line.indexOf(">") + 1);
      return head.title ? [`${lead} **${head.title}**`, lead] : [];
    })
    .join("\n");
}
