/**
 * Ask, honestly: a question becomes its meaningful keywords, each keyword is
 * a keyword search, and notes are ranked by how many keywords they matched.
 * The same keywords also run through recall (ranked full-text search over
 * to-dos, facts, people, catch-ups and watch & read). No model is involved, and
 * the Ask view says so. Searching the whole
 * sentence ("What did I decide about Q3?") as one ILIKE pattern would match
 * nothing, which is why this splits it first.
 */

import { searchNotes } from "../db/data";
import { recall } from "../db/memory";
import type { ConnectionState, Note, RecallHit } from "../types";

const STOP = new Set(
  (
    "a about above after again all also am an and any are as at be because been before being below between both but by can could " +
    "did do does doing done down during each few for from further had has have having he her here hers him his how i if in into is " +
    "it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so " +
    "some such than that the their theirs them then there these they this those through to too under until up very was we were what " +
    "when where which while who whom why will with would you your yours yourself " +
    "anything something everything thing things stuff tell show find say said write wrote note notes know think thought decide decided " +
    "remember mention mentioned get got make made any lately recently please ask"
  ).split(/\s+/)
);

/** Words that say little about what's wanted: when, how much, how good. Kept, but last. */
const WEAK = new Set(
  (
    "today tonight tomorrow yesterday day days week weeks weekend month months year years time times last next ago soon later early late " +
    "new old good best better great nice like much many lot lots really still ever every want wanted need needed going go went look looking " +
    "help way kind sort bit one two first"
  ).split(/\s+/)
);

export const MAX_KEYWORDS = 8;

/** How telling a word is: a name or a figure most, then longer words; a weak word least. */
function telling(word: string, raw: string, first: boolean): number {
  let score = Math.min(word.length, 12) / 12;
  // A capital mid-sentence is a name ("Priya", "Lisbon"); the first word has one anyway.
  if (!first && /^\p{Lu}/u.test(raw)) score += 2;
  if (/\p{N}/u.test(word)) score += 1.5;
  if (WEAK.has(word)) score -= 1;
  return score;
}

/** The question's words worth searching for, the most telling first: up to eight. */
export function keywords(question: string): string[] {
  const found = new Map<string, number>();
  let first = true;
  // "What's", "I'm", "don't": the word without its ending is what's checked, so a contraction of a stop word is one too.
  for (const raw of question.replace(/[\u2018\u2019]/g, "'").split(/[^\p{L}\p{N}'-]+/u)) {
    const trimmed = raw.replace(/^['-]+|['-]+$/g, "");
    if (!trimmed) continue;
    const starts = first;
    first = false;
    const word = trimmed.toLowerCase().replace(/(n't|'(s|re|ll|ve|d|m))$/, "");
    if (word.length < 2 || STOP.has(word) || found.has(word)) continue;
    found.set(word, telling(word, trimmed, starts));
  }
  // A stable sort: words as telling as each other stay in the order asked.
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word).slice(0, MAX_KEYWORDS);
}

export interface AskAnswer {
  terms: string[];
  notes: Note[];
  /** Everything else that matched: to-dos, facts, people, catch-ups, reading (ranked recall). */
  others: RecallHit[];
  state: ConnectionState;
}

export async function askNotes(question: string): Promise<AskAnswer> {
  const terms = keywords(question);
  if (!terms.length) return { terms, notes: [], others: [], state: "online" };

  // Notes by keyword (works offline from the cache); the rest by ranked recall, any keyword.
  const [results, recalled] = await Promise.all([
    Promise.all(terms.map((t) => searchNotes(t))),
    recall(terms.join(" or ")).catch(() => ({ hits: [] as RecallHit[] })),
  ]);
  const others = recalled.hits.filter((h) => h.kind !== "note").slice(0, 6);
  const hits = new Map<string, { note: Note; score: number }>();
  results.forEach(({ notes }, i) => {
    // A match on a more telling keyword counts for a little more.
    const weight = 1 + (terms.length - i) / (terms.length * 4);
    for (const note of notes) {
      const entry = hits.get(note.id);
      if (entry) entry.score += weight;
      else hits.set(note.id, { note, score: weight });
    }
  });

  const ranked = [...hits.values()]
    .sort((a, b) => b.score - a.score || b.note.updated_at.localeCompare(a.note.updated_at))
    .map((h) => h.note)
    .slice(0, 6);

  const state = results.some((r) => r.state === "sample") ? "sample" : results.some((r) => r.state === "offline") ? "offline" : "online";
  return { terms, notes: ranked, others, state };
}
