// A recipe read out of a reply's own text (sample mode's "Turn this into a recipe").
// Run: npx tsx --test app/src/lib/ask-reply-recipe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksToKeepRecipe, recipeFromReply } from "./ask-reply-recipe";

const BROWNIES = "**Fudgy brownies** take about 40 minutes and make 16.\n\n- 200 g dark chocolate\n- 175 g unsalted butter\n- 3 eggs [1]\n\n1. Heat the oven to 180°C.\n2. Melt the **chocolate** and butter.\n3. Bake for 25 minutes, then cool for 10 minutes.";

test("ingredients are the bulleted lines, steps the numbered ones, as the reply gave them", () => {
  const r = recipeFromReply(BROWNIES)!;
  assert.equal(r.title, "Fudgy brownies");
  assert.deepEqual(r.ingredients, ["200 g dark chocolate", "175 g unsalted butter", "3 eggs"]);
  assert.deepEqual(r.steps, ["Heat the oven to 180°C.", "Melt the chocolate and butter.", "Bake for 25 minutes, then cool for 10 minutes."]);
  assert.equal(r.minutes, 35);
});

test("with no bold name, it's named from what was asked", () => {
  const r = recipeFromReply("- 2 eggs\n\n1. Whisk.", "How do I make brownies?")!;
  assert.equal(r.title, "Brownies");
  assert.equal(r.minutes, null);
});

test("a reply that isn't a recipe gives none", () => {
  assert.equal(recipeFromReply("Elena wants to test two prices [1]."), null);
  assert.equal(recipeFromReply("- one\n- two"), null);
});

test("the follow-ups that ask for it", () => {
  for (const q of ["Turn this into a recipe", "turn that into a recipe please", "Make it into a recipe", "Save this as a recipe", "save that to my recipes"]) assert.equal(asksToKeepRecipe(q), true, q);
  for (const q of ["What can I make with chicken?", "How do I make brownies?", "Is this a recipe?"]) assert.equal(asksToKeepRecipe(q), false, q);
});
