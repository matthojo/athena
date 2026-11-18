/**
 * A recipe read out of a reply's own text: its bulleted lines are the
 * ingredients, its numbered lines the steps. Sample mode's stand-in uses it
 * so "Turn this into a recipe" acts on the reply before it, as the real
 * assistant does with save_recipe (lib/assistant-recipes.ts). Pure.
 */
export interface ReplyRecipe {
  title: string;
  ingredients: string[];
  steps: string[];
  /** Minutes, added up from the times the steps name ("bake for 25 minutes"); null when they name none. */
  minutes: number | null;
}

const plain = (s: string) => s.replace(/\*\*/g, "").replace(/\s*\[\d+\]/g, "").trim();

/** The recipe in a reply, or null when it holds no list of ingredients and no steps to follow. */
export function recipeFromReply(text: string, asked = ""): ReplyRecipe | null {
  const lines = text.split("\n").map((l) => l.trim());
  const ingredients = lines.filter((l) => /^- /.test(l)).map((l) => plain(l.slice(2)));
  const steps = lines.filter((l) => /^\d+\. /.test(l)).map((l) => plain(l.replace(/^\d+\. /, "")));
  if (!ingredients.length || !steps.length) return null;
  // Its name: the words the reply makes bold first, else what was asked for ("How do I make brownies?").
  const bold = /\*\*([^*]{2,60})\*\*/.exec(text)?.[1];
  const from = /\b(?:make|cook|bake)\s+(?:an?\s+|some\s+|the\s+)?([\p{L}' -]{2,40}?)[?.!]*$/iu.exec(asked.trim())?.[1];
  const title = (bold ?? from ?? "Recipe").trim().replace(/^./, (c) => c.toUpperCase());
  const minutes = steps.reduce((sum, s) => sum + [...s.matchAll(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/gi)].reduce((n, m) => n + Number(m[1]), 0), 0);
  return { title, ingredients, steps, minutes: minutes || null };
}

/** Is this message asking to keep the reply before it as a recipe? Sample mode's own trigger, not a router. */
export const asksToKeepRecipe = (q: string): boolean => /^(?:please\s+)?(?:(?:turn|make)\s+(?:this|that|it)\s+into\s+a\s+recipe|save\s+(?:this|that|it)\s+(?:as\s+a\s+recipe|to\s+(?:my\s+)?recipes))\b/i.test(q.trim());
