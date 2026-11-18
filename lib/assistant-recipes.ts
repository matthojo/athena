/**
 * Ask and Recipes (lib/recipes.ts): "what can I make with chicken and
 * leeks?" and "save this recipe" with a link.
 *
 * find_recipes is a read tool, so both of Ask's back ends offer it: the
 * answers path (lib/answer.ts, which cites each recipe as recipe:<id>) and
 * the assistant (lib/assistant.ts). import_recipe is the assistant's only:
 * it reads the page (schema.org data, no model) and keeps it, with Undo.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { archiveRecipe, createRecipe, draftFromInput, findRecipesByIngredients, ImportFailed, importRecipe } from "./recipes";
import { MAX_INGREDIENTS, MAX_RECIPE_NOTES, MAX_RECIPE_TITLE, MAX_STEP_TEXT, MAX_STEPS, minutesLabel, minutesOf } from "./recipe-rules";
import type { Change } from "./assistant";

export const FIND_RECIPES_TOOL: Anthropic.Tool = {
  name: "find_recipes",
  description:
    "The owner's own recipes (Recipes in Athena), found by ingredient: for \"what can I make with chicken and leeks?\", \"something quick with eggs\" or \"my leek recipes\". " +
    "Give ingredients as plain names (\"chicken\", \"leeks\"); query narrows by words in the title or tags; max_minutes keeps quick ones. " +
    "Ranked by how many of the ingredients each uses. Each recipe has a ref (recipe:<id>) to cite, its time, and which of the ingredients it has and lacks.",
  input_schema: {
    type: "object",
    properties: {
      ingredients: { type: "array", items: { type: "string" } },
      query: { type: "string" },
      max_minutes: { type: "number" },
    },
  },
};

export const IMPORT_RECIPE_TOOL: Anthropic.Tool = {
  name: "import_recipe",
  description:
    "Keep a recipe from a link the owner sent (\"save this recipe\", or a recipe page's address on its own) in their Recipes. Athena reads the page's recipe itself; " +
    "if the page has none it can read, say so and that they can tap Try harder in Recipes. The same recipe twice is the one already there.",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

export const SAVE_RECIPE_TOOL: Anthropic.Tool = {
  name: "save_recipe",
  description:
    "Keep a recipe in the owner's Recipes from its words, when there's no link to read: one you gave earlier in this conversation (\"turn this into a recipe\", \"save that recipe\"), " +
    "or one the owner typed or dictated. Give every ingredient as its own line with its amount (\"200 g dark chocolate\") and every step as its own line, in order, " +
    "copied from the recipe as it was given: nothing added, nothing left out. A recipe on a web page goes to import_recipe instead.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      ingredients: { type: "array", items: { type: "string" }, description: "One line each, amount first: \"3 eggs\", \"250 g caster sugar\"." },
      steps: { type: "array", items: { type: "string" }, description: "One line each, in order, without numbers." },
      servings: { type: "number" },
      prep_minutes: { type: "number" },
      cook_minutes: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      notes: { type: "string", description: "Tips or variations given with the recipe, if any." },
    },
    required: ["title", "ingredients", "steps"],
  },
};

export const RECIPE_TOOLS: Anthropic.Tool[] = [FIND_RECIPES_TOOL, IMPORT_RECIPE_TOOL, SAVE_RECIPE_TOOL];
export const RECIPE_TOOL_NAMES: ReadonlySet<string> = new Set(RECIPE_TOOLS.map((t) => t.name));

export const RECIPE_GUIDANCE = `- Recipes: for "what can I make with…" use find_recipes with the ingredients named. A recipe link the owner sends to keep goes to import_recipe, not save_item or save_note. A recipe with no link (one you gave in this conversation, or one the owner typed) goes to save_recipe, with its ingredients and steps as they were given.`;

const inputs = {
  find_recipes: z.object({
    ingredients: z.array(z.string().max(60)).max(12).default([]),
    query: z.string().max(200).optional(),
    max_minutes: z.number().positive().max(10_000).optional(),
  }),
  import_recipe: z.object({ url: z.string().min(4).max(2000) }),
  save_recipe: z.object({
    title: z.string().min(1).max(MAX_RECIPE_TITLE),
    ingredients: z.array(z.string().min(1).max(300)).min(1).max(MAX_INGREDIENTS),
    steps: z.array(z.string().min(1).max(MAX_STEP_TEXT)).min(1).max(MAX_STEPS),
    servings: z.number().positive().max(200).optional(),
    prep_minutes: z.number().min(0).max(10_000).optional(),
    cook_minutes: z.number().min(0).max(10_000).optional(),
    tags: z.array(z.string().max(40)).max(12).optional(),
    notes: z.string().max(MAX_RECIPE_NOTES).optional(),
  }),
};

/**
 * find_recipes for either back end. `cite` makes each recipe's ref: the
 * answers path records it as evidence (recipe:<id>); the assistant passes it
 * through.
 */
export async function findRecipesJson(raw: unknown, cite: (id: string, title: string) => string = (id) => `recipe:${id}`): Promise<string> {
  const input = inputs.find_recipes.parse(raw ?? {});
  const found = await findRecipesByIngredients(input.ingredients, { query: input.query, maxMinutes: input.max_minutes ?? null, limit: 8 });
  if (!found.length) {
    const what = input.ingredients.length ? input.ingredients.join(", ") : (input.query ?? "that");
    return `No recipes in Athena use ${what}.`;
  }
  return JSON.stringify(
    found.map((m) => ({
      ref: cite(m.recipe.id, m.recipe.title),
      title: m.recipe.title,
      ...(m.recipe.total_minutes ? { time: minutesLabel(m.recipe.total_minutes) } : {}),
      ...(m.recipe.servings ? { serves: m.recipe.servings } : {}),
      ...(m.recipe.tags.length ? { tags: m.recipe.tags } : {}),
      ...(input.ingredients.length ? { has: m.has, lacks: m.missing } : {}),
      ...(m.recipe.last_cooked ? { last_cooked: m.recipe.last_cooked } : {}),
    })),
  );
}

export interface RecipeUndo {
  op: "archive_recipe";
  id: string;
}

export async function runRecipeTool(name: string, raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  if (name === "find_recipes") return findRecipesJson(raw);
  if (name === "save_recipe") {
    const input = inputs.save_recipe.parse(raw);
    const draft = draftFromInput({ title: input.title, ingredients: input.ingredients, steps: input.steps, servings: input.servings, prep_minutes: input.prep_minutes, cook_minutes: input.cook_minutes, tags: input.tags ?? [] });
    const { recipe } = await createRecipe(draft, { parse: "manual", notes: input.notes });
    return record({
      kind: "recipe",
      id: recipe.id,
      action: "created",
      title: recipe.title,
      // The same line an imported recipe's receipt has.
      detail: [`${recipe.ingredients.length} ${recipe.ingredients.length === 1 ? "ingredient" : "ingredients"}`, minutesLabel(minutesOf(recipe))].filter(Boolean).join(" · "),
      open: { kind: "recipe", id: recipe.id },
      undo: { op: "archive_recipe", id: recipe.id },
    });
  }
  const { url } = inputs.import_recipe.parse(raw);
  try {
    const { recipe, created } = await importRecipe(url);
    if (!created) return JSON.stringify({ done: `${recipe.title} is already in Recipes`, ref: `recipe:${recipe.id}` });
    return record({
      kind: "recipe",
      id: recipe.id,
      action: "created",
      title: recipe.title,
      detail: [`${recipe.ingredients.length} ingredients`, minutesLabel(recipe.total_minutes)].filter(Boolean).join(" · "),
      open: { kind: "recipe", id: recipe.id },
      undo: { op: "archive_recipe", id: recipe.id },
    });
  } catch (error) {
    if (error instanceof ImportFailed) return JSON.stringify({ error: error.miss.error, ...(error.miss.harder ? { next: "The owner can tap Try harder in Recipes, which uses the model." } : {}) });
    throw error;
  }
}

const UNDO = z.object({ op: z.literal("archive_recipe"), id: z.string().uuid() });

export const isRecipeUndo = (raw: unknown): boolean => UNDO.safeParse(raw).success;

export async function applyRecipeUndo(raw: unknown): Promise<void> {
  await archiveRecipe(UNDO.parse(raw).id);
}
