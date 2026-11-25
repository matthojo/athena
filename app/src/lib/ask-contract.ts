/**
 * What Ask's written answer carries beyond lib/answer-text.ts, read here
 * through local types (the server's side lands separately):
 *
 * - `reply.general === true`: no checked source of the owner's is behind the
 *   text. The app says so under it, in place of "Searched…".
 * - A source of kind "web" (url, title): a page found by searching the web.
 *   Its chip opens the link and shows the site's name.
 * - Each of Athena's turns in the history sent with a follow-up carries
 *   `refs`: up to 8 of what it cited, as `kind:id`, or the link.
 *
 * Pure, no DOM.
 */
import type { AnswerReply, AnswerSource, AnswerTurn } from "../../../lib/answer-text";
import type { AskConfirmCard, AskLineupCard, AskPlan, AssistantChange, WatchPick } from "../types";
import type { SchedulingCard } from "../db/scheduling";
import type { AskFlowCard } from "../../../lib/flow-types";

/**
 * What a reply carries when the turn changed something, or is waiting for you to (lib/answer.ts AskActed).
 * Ask is one assistant: the same reply that answers with sources can hold receipts, choices, cards and a plan.
 */
export interface AskActed {
  /** Each change made, as a receipt with Open and Undo. */
  changes?: AssistantChange[];
  /** Athena needs you to pick; each becomes a button that answers it. */
  choices?: string[];
  /** Three times to pick from, or a move or a new event to confirm. */
  scheduling?: SchedulingCard;
  /** An invite answer, a draft, or a note for Docs or Notion: each waits for your tap. */
  confirm?: AskConfirmCard[];
  /** Changes waiting for you to tick and Go. `why`: even one change is waiting, because of what the turn read first. */
  plan?: AskPlan & { why?: "read" | "flagged" | "link" };
  /** Tonight's picks from your own list (the assistant's watch_tonight): the same card the evening chip shows. */
  picks?: WatchPick[];
  /** start_assignment's lineup: a card to change, then Go. Nothing has run. */
  lineup?: AskLineupCard;
  /** propose_flow's flow, kept off until you turn it on (components/ask-flow-card.ts). `on`: turned on here since. */
  flow?: AskFlowCard & { on?: boolean };
}

/** One reply from Ask: the answer, and whatever the turn did. */
export type AskReply = AnswerReply & AskActed;

/** What the conversation keeps of what a reply did, beside the answer: the receipts and cards, and what you've done with them since. */
export interface ActedKept extends AskActed {
  /** Change keys undone here, and ones whose undo no longer works (hidden). */
  undone?: string[];
  gone?: string[];
  /** You've answered its choices. */
  answered?: boolean;
}

/** Did the turn change, plan or prepare anything, or ask you to pick? */
export const acted = (r: AskActed | null | undefined): boolean => !!r && !!(r.changes?.length || r.choices?.length || r.scheduling || r.confirm?.length || r.plan || r.picks?.length || r.lineup || r.flow);

/**
 * A reply as the app draws it, whatever sent it: an older server's instruction reply (text, changes, choices and
 * no sources) or a run kept from before the two were one. Missing lists become empty ones.
 */
export function wholeReply(raw: unknown): AskReply {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<AskReply>;
  return {
    ...r,
    text: typeof r.text === "string" ? r.text : "",
    sources: Array.isArray(r.sources) ? r.sources : [],
    related: Array.isArray(r.related) ? r.related : [],
    searched: typeof r.searched === "string" ? r.searched : "",
    skipped: Array.isArray(r.skipped) ? r.skipped : [],
    // An instruction reply never said whether it "found" anything: its words stand.
    found: typeof r.found === "boolean" ? r.found : true,
    flagged: r.flagged === true,
  };
}

/** Under a plan that holds even one change: why it's waiting for Go (lib/ask-guard.ts). */
export function heldNote(why: "read" | "flagged" | "link" | undefined): string | null {
  if (why === "flagged") return "Something I read looked like an instruction, so I haven't changed anything. Tick what you want and tap Approve.";
  if (why === "read") return "I read your accounts, files or the web before suggesting this, so I haven't done it. Tap Approve if you want it.";
  if (why === "link") return "I chose this link, so it waits for you: Athena only opens links you've approved. Tap Approve if it's right.";
  return null;
}

/** A page from a web search. */
export interface WebSource {
  n: number;
  kind: "web";
  id: null;
  url: string;
  title: string;
  date?: string | null;
  account?: string | null;
}

export type AskSource = AnswerSource | WebSource;

/** A turn of the conversation, as a follow-up sends it. */
export interface AskTurn extends AnswerTurn {
  /** What Athena's turn cited: `kind:id`, or the link. At most MAX_REFS. */
  refs?: string[];
}

export const MAX_TURNS = 12;
export const MAX_REFS = 8;

/** "bbc.co.uk" from a link: the host without "www.". Empty when it isn't a web link. */
export function siteName(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** A page from the web, with a link that is one (http or https): nothing else is ever drawn as a link. */
export const isWebSource = (s: { kind: string; url?: string | null }): s is WebSource => s.kind === "web" && typeof s.url === "string" && siteName(s.url) !== "";

/** No checked source of the owner's is behind this answer. */
export const isGeneral = (reply: AnswerReply | null | undefined): boolean => (reply as { general?: unknown } | null | undefined)?.general === true;

/** The reply's sources, the web's among them. A "web" source without a real web link is left out, and so is its number in the text. */
export const sourcesOf = (reply: AnswerReply): AskSource[] => (reply.sources as AskSource[]).filter((s) => (s.kind as string) !== "web" || isWebSource(s));

/** A source as a ref: `kind:id` for Athena's own, else its link. Null when it has neither. */
export function sourceRef(s: { kind: string; id?: string | null; url?: string | null }): string | null {
  if (s.id) return `${s.kind}:${s.id}`;
  return s.url || null;
}

const GENERAL = "General knowledge, with nothing of yours behind it";
const GENERAL_WEB = "From the web, with nothing of yours behind it";

/** What goes under a general answer in place of "Searched…". */
export function generalNote(reply: AnswerReply): string {
  return sourcesOf(reply).some(isWebSource) ? GENERAL_WEB : GENERAL;
}

/**
 * A kept answer has no field for `general` (the conversation's shape is the
 * server's), so it's kept as this line in `searched`, and read back from it.
 */
export const isGeneralNote = (searched: string): boolean => searched === GENERAL || searched === GENERAL_WEB;
