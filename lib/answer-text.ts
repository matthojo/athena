/**
 * Ask's written answers (lib/answer.ts): their shape, and the wording the
 * server and the PWA share: citation markers ("[1]"), the text without them
 * (what Talk says), and "a, b and c" lists. Pure, no imports.
 *
 * An answer's text is short prose by default. A list, summary, plan,
 * comparison or draft may be longer (ANSWER_MAX_CHARS) and uses three shapes
 * and nothing else: paragraphs split by a blank line, list lines that start
 * "- " or, for steps in order, a number ("1. "), and **bold**. answerProse()
 * turns whatever the model wrote into exactly that.
 */

/** What a source is: something in Athena, or something in a connected account. */
import type { Pattern } from "./patterns";
import type { ModelRef } from "./model-types";

export type AnswerSourceKind =
  | "note"
  | "person"
  | "todo"
  | "record"
  // A Day (lib/days.ts): its id is the date.
  | "day"
  // Something the owner kept in Saved (lib/saved.ts).
  | "saved"
  // A goal, trip or order (lib/ask-tools.ts): opens its sheet.
  | "goal"
  | "trip"
  | "purchase"
  // One of the owner's recipes (lib/recipes.ts).
  | "recipe"
  // A title on Watch & read (a book, film, show, video… or music saved to get to): opens its sheet.
  | "watch"
  // The Work page for a period (lib/ask-tools.ts `work`): its id is month, quarter, year or YYYY.
  | "work"
  | "meeting"
  | "email"
  | "event"
  | "message"
  | "page"
  // The Life log's: what the owner watched, read, played, listened to or posted.
  | "film"
  | "episode"
  | "show"
  | "video"
  | "track"
  | "album"
  | "artist"
  | "book"
  | "game"
  | "post"
  | "comment";

/** One numbered source: [n] in the answer's text points at it. */
export interface AnswerSource {
  n: number;
  kind: AnswerSourceKind;
  /** Athena's own (note, person, to-do, one of the owner's records): opens in the app. */
  id: string | null;
  /** A connected account's (a call in Granola, an email in Gmail): opens there. */
  url: string | null;
  /** "Pricing sync with Gayle", "Re: Q4 pricing", "Gayle Lee". */
  title: string;
  /** YYYY-MM-DD, when known. */
  date: string | null;
  /** Which account it came from: "Granola", "Gmail (work)". Null for Athena's own. */
  account: string | null;
  /** Its cover, for a film, show, video, book, game, album or track, when Athena holds one (lib/answer-art.ts). The app shows the source as a card. */
  art?: { id: string; w: number; h: number; tone?: string };
  /** A Watch & read title's kind and where it's up to: "Film · To watch", "Book · Page 84 of 136". */
  detail?: string;
}

/**
 * A page the web search returned (lib/answer.ts): `kind` is "web" on the wire,
 * with `url` and the page's `title`, no id and no account. It isn't in
 * AnswerSourceKind yet: the app keeps maps over every kind, so the union
 * widens when the app's side of this lands.
 */
export const WEB_SOURCE_KIND = "web";

/** Something else in Athena that matched the question, beyond what was cited. */
export interface RelatedItem {
  kind: "note" | "person" | "todo" | "record";
  id: string;
  title: string;
  snippet: string;
  date: string | null;
}

/** A question back to the owner, with the answers they can tap. */
export interface AskQuestion {
  question: string;
  options: string[];
}

export interface AnswerReply {
  /** Prose with [n] markers, numbered as `sources`: paragraphs split by a blank line, "- " and "1. " list lines and **bold**, nothing else. */
  text: string;
  sources: AnswerSource[];
  related: RelatedItem[];
  /** "Searched your notes, 2 calls and Gmail". */
  searched: string;
  /** Accounts that couldn't be searched this time: "Slack (needs signing in)". */
  skipped: string[];
  /** False when nothing answered the question (the text says so). */
  found: boolean;
  /** The answer doesn't rest on the owner's data: it's general knowledge, or from the web (then `sources` are of kind "web"). The app labels it. */
  general?: boolean;
  /** Something read along the way looked like it was trying to instruct an AI; it was treated as data. */
  flagged: boolean;
  /** Summaries written for the files this question read, by file id (the app keeps them for search). */
  file_summaries?: Record<string, string>;
  /** It was a request to change something, not a question: the app sends the same message to the assistant instead (text is empty). */
  handoff?: boolean;
  /** A setting that would let Ask answer, shown as a link under the text ("Let Ask read transactions" while money search is off). */
  setting?: { label: string; href: string };
  /** Patterns the answer read (lib/patterns.ts), at most two, shown as cards under the text. Their dates are left out. */
  patterns?: Pattern[];
  /** Two or three short follow-ups written with the answer (lib/ask-stream.ts); tapping one asks it. */
  next?: string[];
  /** The text is a question back to the owner, because theirs could mean more than one thing; `next` holds the choices to tap. Nothing was answered yet. */
  clarify?: boolean;
  /** With clarify, when Athena asked more than one thing at once: each question with its own choices (the first one's are also in `next`). */
  asks?: AskQuestion[];
  /** The owner's skills this answer used (lib/skills-ask.ts): the "Used" line under it. */
  skills?: UsedSkill[];
  /** Team assistants main Ask checked with (check_with_assistant): "Checked with Moss", and what each said. Each is also a source of kind "assistant". */
  checked?: Array<{ assistant_id: string; name: string; question: string; answer: string }>;
  /** Said by this Team assistant, not main Ask (lib/team-chat.ts). */
  assistant_id?: string;
  /** The model that answered: "Answered with …". Missing on older servers. */
  model?: ModelRef;
  /** The chosen model failed before answering, so the default answered instead. */
  fell_back?: boolean;
  /** With fell_back: the model that didn't answer. */
  tried?: ModelRef;
  /** It read Linear or GitHub live (someone's work, maybe not the owner's): shown now, and kept in the chat only as LIVE_ONLY_KEPT. */
  live_only?: true;
}

/**
 * The one switch for live-only answers: true, an answer that read Linear or GitHub is shown but its chat keeps only
 * LIVE_ONLY_KEPT (the app and lib/ask-threads.ts both follow the answer's `live_only`, which is set only while this
 * is on). False, such answers are kept like any other.
 */
// Off: an answer about a teammate stays in the chat like any other, and can be deleted.
export const LIVE_ANSWERS_NOT_KEPT = false;

/** What a chat keeps of an answer read live from the work accounts, in place of its text and sources. */
export const LIVE_ONLY_KEPT = "Read live from your work accounts and not kept. Ask again to see it.";

/** A skill a reply used, for its "Used: …" line. */
export interface UsedSkill {
  id: string;
  name: string;
}

/** A question and its answer, for a follow-up ("and what about last week?"). */
export interface AnswerTurn {
  role: "user" | "assistant";
  text: string;
  /** What an earlier reply cited, so it can be read again: Athena refs ("note:<id>") or https links, eight at most. */
  refs?: string[];
}

/** The longest an answer's text gets. */
export const ANSWER_MAX_CHARS = 6000;

/** Bold that opens and closes on one line survives; any other asterisk, underscore pair or backtick goes. */
function inline(line: string): string {
  const kept: string[] = [];
  return line
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, (_m, inner: string) => `\u0000${kept.push(inner) - 1}\u0000`)
    .replace(/\*+|__|`/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `**${kept[Number(i)]}**`)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * The answer's text in its three shapes: paragraphs, list lines ("- ", or
 * "1. " for steps in order) and **bold**. Blocks are split by one blank line;
 * a list is one block, a line per item, all dashes or all numbers. A numbered
 * item keeps the number the model gave it ("3)" becomes "3. "), so steps
 * split by a note or by dashes between them carry on from the last number. A heading becomes
 * a bold line, a starred item a "- " line, a line break inside a paragraph a
 * space. Anything past `max` is cut at the end of a block or a word, with "…".
 */
export function answerProse(text: string, max = ANSWER_MAX_CHARS): string {
  const blocks: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let numbered = false;
  const flush = () => {
    if (para.length) blocks.push(para.join(" "));
    if (list.length) blocks.push(list.join("\n"));
    para = [];
    list = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const words = inline(heading[1].replace(/\*\*/g, "")).replace(/:$/, "");
      if (words) blocks.push(`**${words}**`);
      continue;
    }
    // "[x]" boxes are a note's, not an answer's: a plain item.
    const item = /^(?:[-*•–]|(\d{1,2})[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      const words = inline(item[2]);
      if (!words) continue;
      // Dashes and numbers don't share a block.
      if (para.length || (list.length && numbered !== !!item[1])) flush();
      numbered = !!item[1];
      list.push(numbered ? `${Number(item[1])}. ${words}` : `- ${words}`);
      continue;
    }
    if (list.length) flush();
    const words = inline(line.replace(/^>\s?/, ""));
    if (words) para.push(words);
  }
  flush();
  const out = blocks.join("\n\n");
  if (out.length <= max) return out;
  // Cut where a block or a line ends when that keeps most of it, else at a word.
  const cut = out.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". ") + 1);
  const kept = (at > max * 0.6 ? cut.slice(0, at) : cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 80))).trimEnd();
  // A bold left open by the cut would show its asterisks.
  const tail = kept.slice(kept.lastIndexOf("\n") + 1);
  const open = (tail.match(/\*\*/g)?.length ?? 0) % 2 === 1;
  return `${open ? kept.slice(0, kept.lastIndexOf("**")).trimEnd() : kept}…`;
}

/**
 * The answer's text while it's still being written, in the same shape it will end in, so what the owner
 * watches arrive is what stays. Two things are held back until they're settled, because showing them early
 * would mean taking words back: a last line too short to tell a list marker or heading from prose ("1", "-",
 * "#"), and a bold that has opened but not closed.
 */
export function answerProseSoFar(partial: string): string {
  const text = partial.replace(/\r\n?/g, "\n");
  const at = text.lastIndexOf("\n") + 1;
  let last = text.slice(at);
  // A bold still open, or a lone star that may become one.
  if ((last.match(/\*\*/g)?.length ?? 0) % 2 === 1) last = last.slice(0, last.lastIndexOf("**"));
  else if (/(^|[^*])\*$/.test(last)) last = last.slice(0, -1);
  // A heading is one bold line: shown once it's whole. A marker with nothing after it yet isn't shown at all.
  if (/^\s*#/.test(last) || /^\s*(?:[-*•–>]+|\d{1,2}[.)]?)?\s*$/.test(last)) last = "";
  return answerProse(text.slice(0, at) + last);
}

/** "[1]", "[2][3]", "[1, 2]" or "[1-3]", with the space before it (never a line break: the text has paragraphs and lists). */
const MARKER = /[^\S\n]?\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g;

/** The numbers inside one marker: "1, 3" → [1, 3]; "2-4" → [2, 3, 4]. */
function markerNumbers(inside: string): number[] {
  const out: number[] = [];
  for (const part of inside.split(",")) {
    const [a, b] = part.split(/[–-]/).map((s) => Number(s.trim()));
    if (!Number.isFinite(a)) continue;
    const end = Number.isFinite(b) && b >= a && b - a < 10 ? b : a;
    for (let n = a; n <= end; n++) out.push(n);
  }
  return out;
}

/** Every number cited, in the order they first appear. */
export function citedNumbers(text: string): number[] {
  const seen: number[] = [];
  for (const m of text.matchAll(MARKER)) for (const n of markerNumbers(m[1])) if (!seen.includes(n)) seen.push(n);
  return seen;
}

/** Renumber (or drop, when map has no entry) every marker. */
export function renumberCitations(text: string, map: Map<number, number>): string {
  return text
    .replace(MARKER, (all: string, inside: string) => {
      const kept = [...new Set(markerNumbers(inside).map((n) => map.get(n)))].filter((n): n is number => n !== undefined);
      const space = all.startsWith("[") ? "" : " ";
      return kept.length ? `${space}${kept.map((n) => `[${n}]`).join("")}` : "";
    })
    .replace(/([^\s[\]])\[(\d)/g, "$1 [$2")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/\n +/g, "\n")
    .trim();
}

/** The answer as it's said aloud, or shown on one line: no markers, list dashes or bold. A step keeps its number. */
export function stripCitations(text: string): string {
  return text
    .replace(MARKER, "")
    .replace(/\*\*/g, "")
    .replace(/^- /gm, "")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text split for display: plain runs, and the source number each marker points at. */
export function citationParts(text: string): Array<string | number> {
  const parts: Array<string | number> = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(...markerNumbers(m[1]));
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
