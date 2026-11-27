/**
 * Ask and Recipes (lib/recipes.ts): "what can I make with chicken and
 * leeks?", "save this recipe" with a link, and the grocery list: "we're out
 * of milk", "what's on the shopping list?".
 *
 * find_recipes and grocery_list are read tools, so both of Ask's back ends
 * offer them: the answers path (lib/answer.ts, which cites each recipe as
 * recipe:<id> and the list as recipe:list) and the assistant
 * (lib/assistant.ts). import_recipe is the assistant's only: it reads the
 * page (schema.org data, no model) and keeps it, with Undo.
 * add_to_grocery_list puts the owner's own lines on the list, with Undo; a
 * Shortcut capture may use it too (lib/assistant.ts CAPTURE_TOOLS).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { archiveRecipe, createRecipe, insertOwnGroceryLine, listGroceryLines, removeOpenGroceryLines, draftFromInput, findRecipesByIngredients, getGroceryList, ImportFailed, importRecipe } from "./recipes";
import { formatAmount, itemKey, parseIngredient } from "./recipe-units";
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

export const GROCERY_LIST_TOOL: Anthropic.Tool = {
  name: "grocery_list",
  description:
    "What's on the owner's grocery list in Athena now: each line with its amount, whether it's ticked (in the basket), and the recipes it's for; and the usuals that are due " +
    "(things they buy every so often, worked out from their past shops, with how often and when they last bought each). " +
    "For \"what's on the shopping list?\", \"do I need milk?\", \"what am I running low on?\". The list has a ref (recipe:list) to cite.",
  input_schema: { type: "object", properties: {} },
};

export const ADD_TO_GROCERY_TOOL: Anthropic.Tool = {
  name: "add_to_grocery_list",
  description:
    "Put food and household shopping on the owner's grocery list in Athena: \"we're out of milk\", \"add eggs and two lemons to the shopping\", \"need kitchen roll\". " +
    "One line per thing, amount first when one was said (\"2 lemons\", \"500 g Greek yoghurt\", \"milk\"); lines sort into aisles by themselves. " +
    "Something already on the list and not yet ticked isn't added twice. A recipe's ingredients are added from the recipe in Recipes, not line by line. " +
    "Gift ideas, packing and other lists go to add_to_list.",
  input_schema: {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" }, description: "One line each: \"2 lemons\", \"milk\"." } },
    required: ["items"],
  },
};

export const RECIPE_TOOLS: Anthropic.Tool[] = [FIND_RECIPES_TOOL, IMPORT_RECIPE_TOOL, SAVE_RECIPE_TOOL, GROCERY_LIST_TOOL, ADD_TO_GROCERY_TOOL];
export const RECIPE_TOOL_NAMES: ReadonlySet<string> = new Set(RECIPE_TOOLS.map((t) => t.name));

export const RECIPE_GUIDANCE = `- Recipes: for "what can I make with…" use find_recipes with the ingredients named. A recipe link the owner sends to keep goes to import_recipe, not save_item or save_note. A recipe with no link (one you gave in this conversation, or one the owner typed) goes to save_recipe, with its ingredients and steps as they were given.
- Groceries: food and household things to buy ("we're out of milk", "add bin bags to the shopping") go to add_to_grocery_list, not add_to_list or a to-do. For what's on it, or what's running low, use grocery_list.`;

const inputs = {
  find_recipes: z.object({
    ingredients: z.array(z.string().max(60)).max(12).default([]),
    query: z.string().max(200).optional(),
    max_minutes: z.number().positive().max(10_000).optional(),
  }),
  import_recipe: z.object({ url: z.string().min(4).max(2000) }),
  add_to_grocery_list: z.object({ items: z.array(z.string().min(1).max(200)).min(1).max(30) }),
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

const lineText = (l: { quantity: number | null; unit: string | null; item: string }) =>
  [l.quantity === null ? "" : formatAmount({ quantity: l.quantity, quantity_max: null, unit: l.unit }), l.item].filter(Boolean).join(" ");

/** grocery_list for either back end. `cite` makes the list's ref. */
export async function groceryListJson(cite: () => string = () => "recipe:list"): Promise<string> {
  const list = await getGroceryList();
  const usuals = (list.usuals ?? []).map((u) => ({ item: lineText(u), every_days: u.every, last_bought_days_ago: u.since }));
  if (!list.items.length && !usuals.length) return JSON.stringify({ ref: cite(), lines: [], note: "The grocery list is empty, and no usuals are due." });
  return JSON.stringify({
    ref: cite(),
    to_buy: list.items.filter((i) => !i.ticked).map((i) => ({ line: lineText(i), ...(i.recipes.length ? { for: i.recipes.map((r) => r.title) } : {}) })),
    ...(list.items.some((i) => i.ticked) ? { in_the_basket: list.items.filter((i) => i.ticked).map((i) => lineText(i)) } : {}),
    ...(usuals.length ? { usuals_due: usuals } : {}),
  });
}

/** Lines onto the list; anything already there unticked is skipped. Returns what went on (with each new line's id) and what was there. */
export async function addGroceryLines(items: string[]): Promise<{ added: Array<{ id: string; text: string }>; already: string[] }> {
  const open = new Set((await listGroceryLines()).filter((i) => !i.ticked).map((i) => itemKey(i.item)));
  const added: Array<{ id: string; text: string }> = [];
  const already: string[] = [];
  for (const raw of items) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = itemKey(parseIngredient(text).item);
    if (open.has(key)) {
      already.push(text);
      continue;
    }
    const line = await insertOwnGroceryLine(text);
    open.add(key);
    added.push({ id: line.id, text: lineText(line) });
  }
  return { added, already };
}

export type RecipeUndo = { op: "archive_recipe"; id: string } | { op: "remove_grocery_lines"; ids: string[] };

export async function runRecipeTool(name: string, raw: unknown, record: (change: Omit<Change, "label">) => string): Promise<string> {
  if (name === "find_recipes") return findRecipesJson(raw);
  if (name === "grocery_list") return groceryListJson();
  if (name === "add_to_grocery_list") {
    const { items } = inputs.add_to_grocery_list.parse(raw);
    const { added, already } = await addGroceryLines(items);
    if (!added.length) return JSON.stringify({ done: "Already on the list", already_on_the_list: already });
    return record({
      kind: "recipe",
      id: "list",
      action: "updated",
      title: "Grocery list",
      detail: [`Added ${added.map((a) => a.text).join(", ")}`, already.length ? `${already.join(", ")} already on it` : ""].filter(Boolean).join(" · "),
      open: { kind: "recipe", id: "list" },
      undo: { op: "remove_grocery_lines", ids: added.map((a) => a.id) },
    });
  }
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

const UNDO = z.union([z.object({ op: z.literal("archive_recipe"), id: z.string().uuid() }), z.object({ op: z.literal("remove_grocery_lines"), ids: z.array(z.string().uuid()).max(30) })]);

export const isRecipeUndo = (raw: unknown): boolean => UNDO.safeParse(raw).success;

export async function applyRecipeUndo(raw: unknown): Promise<void> {
  const undo = UNDO.parse(raw);
  if (undo.op === "archive_recipe") await archiveRecipe(undo.id);
  // A line ticked since is left as it is: it's in the basket.
  else await removeOpenGroceryLines(undo.ids);
}
