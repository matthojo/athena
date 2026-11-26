/**
 * Ranked text search, run in the Function. Recall used Postgres full-text
 * search, but Postgres can't index what it can't read: with content
 * encrypted at rest (docs: security/encryption) the Function decrypts the candidates
 * and ranks them here instead. At personal scale (thousands of rows) that's
 * quick, and it keeps what recall did:
 *
 *  - English stemming (Porter), so "meeting" finds "meetings";
 *  - Postgres's English stop words dropped, so questions still match;
 *  - web-search syntax: words are ANDed, "quoted phrases" must be adjacent,
 *    OR between words gives alternatives, -word excludes;
 *  - weighted fields (a note's title counts more than its body), and a
 *    snippet around the first match.
 *
 * Pure, no imports.
 */

// ---------- Words ----------

/** Postgres's english.stop list, so the same words are ignored as before. */
const STOP_WORDS = new Set(
  (
    "i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself " +
    "it its itself they them their theirs themselves what which who whom this that these those am is are was were be " +
    "been being have has had having do does did doing a an the and but if or because as until while of at by for with " +
    "about against between into through during before after above below to from up down in out on off over under again " +
    "further then once here there when where why how all any both each few more most other some such no nor not only own " +
    "same so than too very s t can will just don should now"
  ).split(" "),
);

const isVowelAt = (w: string, i: number): boolean => {
  const c = w[i];
  if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return true;
  // "y" is a vowel after a consonant: the y in "happy", not the one in "yes" or "toy".
  return c === "y" && i > 0 && !isVowelAt(w, i - 1);
};

/** Porter's m: how many vowel-consonant runs the stem has. */
function measure(s: string): number {
  let m = 0;
  let i = 0;
  while (i < s.length && !isVowelAt(s, i)) i++;
  while (i < s.length) {
    while (i < s.length && isVowelAt(s, i)) i++;
    if (i >= s.length) break;
    while (i < s.length && !isVowelAt(s, i)) i++;
    m++;
  }
  return m;
}

const hasVowel = (s: string) => [...s].some((_, i) => isVowelAt(s, i));
const doubleConsonant = (s: string) => s.length >= 2 && s.at(-1) === s.at(-2) && !isVowelAt(s, s.length - 1);
/** Consonant-vowel-consonant at the end, the last not w, x or y ("hop", not "snow"). */
const cvc = (s: string) =>
  s.length >= 3 && !isVowelAt(s, s.length - 3) && isVowelAt(s, s.length - 2) && !isVowelAt(s, s.length - 1) && !"wxy".includes(s.at(-1)!);

const byLength = (rules: Array<[string, string]>) => rules.sort((a, b) => b[0].length - a[0].length);

const STEP2 = byLength([
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"], ["bli", "ble"],
  ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
  ["iviti", "ive"], ["biliti", "ble"], ["logi", "log"],
]);
const STEP3 = byLength([["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""]]);
const STEP4 = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
].sort((a, b) => b.length - a.length);

/** Replace the longest matching suffix whose stem passes `ok`; only the longest is ever tried. */
function replaceSuffix(w: string, rules: Array<[string, string]>, ok: (stem: string) => boolean): string {
  const rule = rules.find(([suffix]) => w.endsWith(suffix));
  if (!rule) return w;
  const stem = w.slice(0, w.length - rule[0].length);
  return ok(stem) ? stem + rule[1] : w;
}

/** Porter's stemmer (1980): "meetings" and "meeting" both become "meet". Words outside a–z pass through. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 2 || !/^[a-z]+$/.test(w)) return w;

  // Step 1a: plurals.
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b: -ed, -ing.
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const cut = w.endsWith("ed") && hasVowel(w.slice(0, -2)) ? 2 : w.endsWith("ing") && hasVowel(w.slice(0, -3)) ? 3 : 0;
    if (cut) {
      w = w.slice(0, -cut);
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
      else if (doubleConsonant(w) && !"lsz".includes(w.at(-1)!)) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += "e";
    }
  }

  // Step 1c: y -> i after a vowel somewhere in the stem.
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  // Steps 2 and 3: double and single suffixes.
  w = replaceSuffix(w, STEP2, (s) => measure(s) > 0);
  w = replaceSuffix(w, STEP3, (s) => measure(s) > 0);

  // Step 4: drop a suffix from a long enough stem.
  const suffix = STEP4.find((s) => w.endsWith(s));
  if (suffix) {
    const s = w.slice(0, w.length - suffix.length);
    if (measure(s) > 1 && (suffix !== "ion" || s.endsWith("s") || s.endsWith("t"))) w = s;
  }

  // Step 5: a final -e, and -ll.
  if (w.endsWith("e")) {
    const s = w.slice(0, -1);
    const m = measure(s);
    if (m > 1 || (m === 1 && !cvc(s))) w = s;
  }
  if (measure(w) > 1 && doubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}

/** Text -> stems in order, stop words dropped. */
export function analyse(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP_WORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

// ---------- Queries ----------

interface Clause {
  /** One stem, or several that must be adjacent (a phrase). */
  stems: string[];
  not: boolean;
}

/** Alternatives (OR) of clauses that must all hold (AND). */
export interface TextQuery {
  alternatives: Clause[][];
}

/** Web-search syntax, as Postgres's websearch_to_tsquery reads it. Null when nothing searchable is left. */
export function parseQuery(input: string): TextQuery | null {
  const alternatives: Clause[][] = [];
  let current: Clause[] = [];
  for (const m of input.matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const word = m[3];
    if (word !== undefined && word.toLowerCase() === "or") {
      if (current.length) alternatives.push(current);
      current = [];
      continue;
    }
    const not = m[1] === "-" || (word?.startsWith("-") ?? false);
    const text = word !== undefined ? word.replace(/^-+/, "") : m[2];
    const stems = analyse(text);
    if (stems.length) current.push({ stems, not });
  }
  if (current.length) alternatives.push(current);
  const usable = alternatives.filter((clauses) => clauses.some((c) => !c.not));
  return usable.length ? { alternatives: usable } : null;
}

// ---------- Ranking ----------

export interface SearchField {
  text: string;
  /** How much a match here counts: a note's title 1, its body 0.4 (Postgres's A and B weights). */
  weight: number;
}

function occurrences(stems: string[], clause: Clause): number {
  let n = 0;
  const [first, ...rest] = clause.stems;
  for (let i = 0; i <= stems.length - clause.stems.length; i++) {
    if (stems[i] === first && rest.every((s, j) => stems[i + 1 + j] === s)) n++;
  }
  return n;
}

/**
 * How well `fields` match: 0 for no match, else higher for more, and more
 * important, matches. Every positive word of every alternative that holds
 * counts, so a note matching three of "a or b or c" outranks one matching one.
 */
export function score(query: TextQuery, fields: SearchField[]): number {
  const analysed = fields.map((f) => ({ stems: analyse(f.text), weight: f.weight }));
  const counted = new Map<string, number>();
  let matched = false;
  for (const clauses of query.alternatives) {
    let holds = true;
    const contributions: Array<[string, number]> = [];
    for (const clause of clauses) {
      let total = 0;
      for (const f of analysed) {
        const n = occurrences(f.stems, clause);
        if (n) total += f.weight * (1 + Math.log(n));
      }
      if (clause.not ? total > 0 : total === 0) {
        holds = false;
        break;
      }
      if (!clause.not) contributions.push([clause.stems.join(" "), total]);
    }
    if (!holds) continue;
    matched = true;
    for (const [key, value] of contributions) counted.set(key, value);
  }
  if (!matched) return 0;
  return [...counted.values()].reduce((a, b) => a + b, 0);
}

/** Up to `maxWords` words of `text` around its first match, "…" where it's cut. */
export function headline(text: string, query: TextQuery, maxWords = 26): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const wanted = new Set(query.alternatives.flat().filter((c) => !c.not).flatMap((c) => c.stems));
  const hit = words.findIndex((w) => analyse(w).some((s) => wanted.has(s)));
  const start = hit < 0 ? 0 : Math.max(0, Math.min(hit - 8, words.length - maxWords));
  const end = Math.min(words.length, start + maxWords);
  return `${start > 0 ? "… " : ""}${words.slice(start, end).join(" ")}${end < words.length ? " …" : ""}`;
}

/** `text` with each matching word wrapped in « », and runs of matching words wrapped once: "«Bowie afternoon»". */
export function markMatches(text: string, query: TextQuery): string {
  const wanted = new Set(query.alternatives.flat().filter((c) => !c.not).flatMap((c) => c.stems));
  const parts = text.split(/(\s+)/);
  const hit = parts.map((p, i) => i % 2 === 0 && !!p && analyse(p).some((s) => wanted.has(s)));
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1) {
      out += p;
      continue;
    }
    const open = hit[i] && !hit[i - 2];
    const close = hit[i] && !hit[i + 2];
    out += `${open ? "«" : ""}${p}${close ? "»" : ""}`;
  }
  return out;
}
