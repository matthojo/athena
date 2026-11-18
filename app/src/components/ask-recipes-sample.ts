/**
 * Sample mode's answer to "What can I make with chicken and leeks?": the
 * sample recipes that use what's named, best match first, each cited as a
 * recipe (recipe:<id>, which opens #/recipes/<id>). The real answer comes
 * from the server's find_recipes tool (lib/assistant-recipes.ts).
 */
import type { AnswerReply, AnswerSource } from "../../../lib/answer-text";
import { sampleRecipesByIngredient } from "../db/sample-recipes";
import { minutesLabel, minutesOf } from "../../../lib/recipe-rules";

export const isRecipeQuestion = (q: string): boolean => /\bwhat (?:can|could|should) i (?:make|cook)\b|\bcook with\b|\brecipes? (?:with|for|using)\b/i.test(q);

/** The foods a question names: "chicken and leeks" → ["chicken", "leek"]. */
function foods(q: string): string[] {
  const tail = /\b(?:with|using|from)\s+(.+?)[?.!]*$/i.exec(q)?.[1] ?? q;
  return tail
    .toLowerCase()
    .split(/,|\band\b|\bor\b|&/)
    .map((w) => w.replace(/\b(some|the|a|an|my|leftover|left-over)\b/g, "").trim())
    .filter((w) => w.length > 1)
    .map((w) => w.replace(/s$/, ""));
}

export const RECIPE_STEPS: Array<[string, string]> = [["Searching your recipes", "Searched your recipes"]];

export function sampleRecipeAnswer(question: string): AnswerReply {
  const want = foods(question);
  const found = sampleRecipesByIngredient(want).slice(0, 3);
  if (!found.length) {
    return { text: `None of your recipes use ${want.join(" and ") || "that"}.`, sources: [], related: [], searched: "Searched your recipes", skipped: [], found: false, flagged: false };
  }
  const uses = (r: (typeof found)[number]) => want.filter((w) => r.ingredients.some((i) => i.item.toLowerCase().includes(w)));
  const sources = found.map((r, i) => ({ n: i + 1, kind: "recipe", id: r.id, url: null, title: r.title, date: null, account: null }) as unknown as AnswerSource);
  const lines = found.map((r, i) => {
    const m = minutesLabel(minutesOf(r));
    const used = uses(r);
    const what = used.length === want.length && want.length > 1 ? "uses both" : `uses the ${used.map((w) => `${w}s`).join(" and ")}`;
    return `${r.title} ${what}${m ? `, ${m}` : ""} [${i + 1}].`;
  });
  const first = found[0];
  const quick = [...found].sort((a, b) => (minutesOf(a) ?? 999) - (minutesOf(b) ?? 999))[0];
  const text = [...lines, quick.id !== first.id ? `${quick.title} is the quicker one for a busy evening.` : ""].filter(Boolean).join(" ");
  return { text, sources, related: [], searched: `Searched your ${found.length > 1 ? "recipes" : "recipe"} by ingredient`, skipped: [], found: true, flagged: false };
}
