/**
 * Cook mode's helpers (Recipes, migration 0053): the timers a step's own
 * words call for ("simmer for 1 hr–1 hr 15", "boil for 6 minutes") and the
 * ingredients a step uses, by name. Pure and shared with the app.
 */
import { itemKey, type Ingredient } from "./recipe-units";

export interface StepTimer {
  /** What the step says, as written: "6 minutes", "1 hr-1 hr 15". */
  label: string;
  /** The shortest time it says, in seconds (a range starts at its low end). */
  seconds: number;
}

const HOUR = "(?:hours?|hrs?|h)";
const MIN = "(?:minutes?|mins?|m)";
const SEC = "(?:seconds?|secs?|s)";
const N = "(\\d+(?:[.,]\\d+)?|½|an?|one|half)";
const word = (n: string) => (/^an?$|^one$/i.test(n) ? 1 : /^half$|^½$/i.test(n) ? 0.5 : Number(n.replace(",", ".")));

/** "1 hr 15", "1 hour 15 minutes", "45 mins", "90 seconds", "1½ hours", "an hour", "half an hour" → seconds. */
function durationOf(text: string): number | null {
  const t = text.toLowerCase().replace(/(\d)\s*½/, (_, d: string) => `${d}.5`);
  if (/^half an hour/.test(t)) return 1800;
  const hm = new RegExp(`^${N}\\s*${HOUR}\\b(?:\\s*(?:and\\s*)?(\\d+)\\s*(?:${MIN}\\b)?)?`).exec(t);
  if (hm) return Math.round(word(hm[1]) * 3600 + (hm[2] ? Number(hm[2]) * 60 : 0));
  const m = new RegExp(`^${N}\\s*${MIN}\\b`).exec(t);
  if (m) return Math.round(word(m[1]) * 60);
  const s = new RegExp(`^${N}\\s*${SEC}\\b`).exec(t);
  if (s) return Math.round(word(s[1]));
  return null;
}

const ONE = `${N}\\s*(?:${HOUR}|${MIN}|${SEC})\\b(?:\\s*(?:and\\s*)?\\d+\\s*(?:${MIN}\\b)?)?`;
const RANGE = new RegExp(`(?:${N}\\s*(?:-|–|—|to|or)\\s*)?${ONE}(?:\\s*(?:-|–|—|to|or)\\s*${ONE})?`, "gi");

/**
 * The timers in a step: each time it names, at its shortest. "10-12 mins"
 * is one timer of 10 minutes labelled "10-12 mins". Times under 30 seconds
 * and over 12 hours aren't timers (a marinade overnight is planning).
 */
export function stepTimers(step: string): StepTimer[] {
  const out: StepTimer[] = [];
  const text = step.replace(/(\d)\s*½/g, "$1.5").replace(/\bhalf an hour\b/gi, "30 minutes");
  for (const m of text.matchAll(RANGE)) {
    const label = m[0].trim();
    if (!/\d|an?\s|one|half/i.test(label)) continue;
    // "10-12 mins": the first number carries the unit of the second.
    const low = /^(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|or)\s*(\d)/.exec(label);
    let seconds: number | null;
    if (low) {
      const unitPart = label.slice(low[0].length - 1);
      const unitSecs = durationOf(unitPart);
      const hi = Number(/^(\d+(?:[.,]\d+)?)/.exec(unitPart)?.[1] ?? NaN);
      seconds = unitSecs !== null && hi ? Math.round((Number(low[1]) / hi) * unitSecs) : null;
    } else seconds = durationOf(label);
    if (seconds === null || seconds < 30 || seconds > 12 * 3600) continue;
    if (out.some((o) => o.label === label)) continue;
    out.push({ label, seconds });
  }
  return out;
}

/** "6:00", "1:15:00": a timer's face. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Things made from something else: "chicken stock" isn't "the chicken". */
export const DERIVED = new Set(["stock", "broth", "sauce", "paste", "powder", "oil", "juice", "zest", "extract", "fat", "flakes", "seeds", "leaves", "water", "vinegar", "puree", "purée", "cube"]);

const forms = (w: string) => [w, `${w}s`, `${w}es`, w.endsWith("y") ? `${w.slice(0, -1)}ies` : "", w.endsWith("f") ? `${w.slice(0, -1)}ves` : ""].filter(Boolean);

/**
 * The ingredients a step mentions, by index: a step that says "the leeks"
 * uses "2 leeks, thinly sliced". Matched on the whole name, its last word,
 * or its first word unless it's made from that ("the chicken" finds
 * "chicken thighs", not "chicken stock").
 */
export function ingredientsForStep(step: string, ingredients: Ingredient[]): number[] {
  const text = ` ${step.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ")} `;
  const has = (w: string) => forms(w).some((f) => text.includes(` ${f} `));
  const out: number[] = [];
  ingredients.forEach((ing, i) => {
    const words = itemKey(ing.item).split(" ").filter((w) => w.length >= 3);
    if (!words.length) return;
    const last = words[words.length - 1];
    if (text.includes(` ${words.join(" ")}`) || has(last) || (words.length > 1 && !DERIVED.has(last) && has(words[0]))) out.push(i);
  });
  return out;
}

/**
 * Does an ingredient count as this thing ("chicken", "leeks")? Its whole
 * name, its last words ("corn-fed chicken"), or its first word unless it's
 * made from that: "chicken thighs" is chicken, "chicken stock" isn't.
 */
export function ingredientIs(item: string, asked: string): boolean {
  const key = itemKey(item);
  const want = itemKey(asked);
  if (!want) return false;
  if (key === want || key.endsWith(` ${want}`)) return true;
  const last = key.split(" ").at(-1) ?? "";
  return key.startsWith(`${want} `) && !DERIVED.has(last);
}
