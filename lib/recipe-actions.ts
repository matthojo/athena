/**
 * Saved's "Move to Recipes" action (lib/saved-actions.ts registers it): a
 * recipe link in Saved, read into Recipes, with the Saved item filed there as
 * its pointer. New recipe links file themselves when they're saved (the hook
 * in lib/saved.ts); this is for one put back, or one Recipes couldn't read
 * at the time. Recipes loads on use, so Saved doesn't load it at start.
 */
import type { SavedAction } from "./saved-actions";

export const MOVE_TO_RECIPES: SavedAction = {
  id: "recipe",
  label: "Move to Recipes",
  icon: "pot",
  appliesTo: (item) => item.kind === "link" && !!item.url && item.thing === "recipe",
  fit: () => 12,
  async run(item) {
    const { recipeFromSaved } = await import("./recipes");
    const out = await recipeFromSaved(item.id, null, { minimal: true });
    if (!out) throw new Error("Athena couldn't read that page as a recipe.");
    return { label: "Recipes", href: `#/recipes/${out.recipe.id}`, filed: true, undo: null, done: out.created ? "Moved to Recipes" : "Already in Recipes", target: null };
  },
};
