/**
 * Who a to-do is about: the rules, shared by the server and the app (no I/O here).
 *
 * A to-do with nobody linked, whose words name someone Athena knows, is offered
 * that person to link in one tap (To do and the to-do's sheet). `peopleNamedIn`
 * is the one place that decides who to offer. It only ever compares whole
 * words, the way resolve_person compares a name (lowercased, spaces tidied):
 *   - a whole name or nickname of two or more words ("Priya Shah", "P Shah");
 *   - a one-word name or nickname ("Mum");
 *   - a first name ("Priya" for Priya Shah).
 * A word inside a longer match isn't matched again, so "Call Priya Shah"
 * offers Priya Shah and not every Priya. Several people on the same word are
 * all offered, up to MAX_PERSON_SUGGESTIONS; it never picks one for you.
 *
 * To stay quiet, a one-word match that is very short or is also an everyday
 * word ("Will", "Mark", "May") counts only where it's written as a name: with
 * a capital, and not as the first word. "Mark the invoices paid" offers nobody.
 *
 * Nothing here is stored: names are compared in memory after the Function (or
 * the app, in sample mode) has opened them, and the answer is only ids and names.
 */

export interface NamedPerson {
  id: string;
  name: string;
  /** Their nicknames (identities of kind `alias`). */
  aliases?: string[];
  last_contacted_at?: string | null;
}

export const MAX_PERSON_SUGGESTIONS = 3;

/** Names that are also everyday words: matched only when written as a name (here, and in lib/team-share.ts). */
export const EVERYDAY = new Set(
  (
    "will mark may april june august bill rob pat sue hope joy faith grace rose dawn eve jack frank penny don ray drew chase miles art " +
    "summer autumn olive ivy lily daisy holly amber ruby pearl jade sky rich nick dean guy carol harry bob sandy rusty ginger"
  ).split(" "),
);

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof"]);

interface Token {
  word: string;
  /** Written with a capital first letter. */
  capital: boolean;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/’/g, "'").toLowerCase();

/** The words of some text, in order: lowercased, accents and a trailing 's dropped. */
function tokens(text: string): Token[] {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).map((raw) => ({
    word: fold(raw).replace(/'s$/, ""),
    capital: /^\p{Lu}/u.test(raw),
  }));
}

/** A name as words, without a leading title ("Dr Elena Rossi" → elena, rossi). */
function nameWords(name: string): string[] {
  const words = tokens(name).map((t) => t.word).filter(Boolean);
  return words.length > 1 && TITLES.has(words[0]) ? words.slice(1) : words;
}

/** A one-word match counts anywhere, unless it's short or an everyday word: then only as a capitalised word after the first. */
function reads(word: string, at: number, text: Token[]): boolean {
  if (word.length >= 3 && !EVERYDAY.has(word)) return true;
  return at > 0 && text[at].capital;
}

/** The people a to-do's words name, in the order they're named, at most MAX_PERSON_SUGGESTIONS. */
export function peopleNamedIn(text: string, people: NamedPerson[]): Array<{ id: string; name: string }> {
  const words = tokens(text);
  if (!words.length || !people.length) return [];

  const phrases: Array<{ person: NamedPerson; words: string[] }> = [];
  const singles = new Map<string, NamedPerson[]>();
  const single = (word: string, person: NamedPerson) => {
    if (!word) return;
    const list = singles.get(word) ?? [];
    if (!list.includes(person)) list.push(person);
    singles.set(word, list);
  };
  for (const person of people) {
    const full = nameWords(person.name);
    if (!full.length) continue;
    if (full.length > 1) phrases.push({ person, words: full });
    single(full[0], person);
    for (const alias of person.aliases ?? []) {
      const w = nameWords(alias);
      if (w.length > 1) phrases.push({ person, words: w });
      else single(w[0] ?? "", person);
    }
  }

  // Whole names first; the words they cover aren't matched again as first names.
  const found = new Map<string, { person: NamedPerson; at: number }>();
  const add = (person: NamedPerson, at: number) => {
    const had = found.get(person.id);
    if (!had || at < had.at) found.set(person.id, { person, at });
  };
  const taken = new Set<number>();
  for (const p of phrases) {
    for (let i = 0; i + p.words.length <= words.length; i++) {
      if (!p.words.every((w, j) => words[i + j].word === w)) continue;
      add(p.person, i);
      for (let j = 0; j < p.words.length; j++) taken.add(i + j);
    }
  }
  words.forEach((t, i) => {
    if (taken.has(i) || !reads(t.word, i, words)) return;
    for (const person of singles.get(t.word) ?? []) add(person, i);
  });

  return [...found.values()]
    .sort((a, b) => a.at - b.at || (b.person.last_contacted_at ?? "").localeCompare(a.person.last_contacted_at ?? "") || a.person.name.localeCompare(b.person.name))
    .slice(0, MAX_PERSON_SUGGESTIONS)
    .map(({ person }) => ({ id: person.id, name: person.name }));
}

/** Which to-dos get a suggestion: open, nobody linked, and not a decision (a record, not something to hand to someone). */
export function wantsPersonSuggestion(c: { kind: string; status: string; person_id?: string | null; archived_at?: string | null }): boolean {
  return c.status === "open" && !c.person_id && !c.archived_at && c.kind !== "decision";
}
