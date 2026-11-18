/**
 * Recipes over REST (docs/notes/recipes.md), mounted by
 * netlify/functions/api.ts behind the app token or a full key:
 *
 *   GET    /api/recipes?q=&tag=&time=        { recipes, tags, moved }: the grid (moves a few Saved recipe links in first)
 *   POST   /api/recipes                      { title, ingredients?, steps?, … } → { recipe }: typed in
 *   POST   /api/recipes/import               { url, harder? } → { recipe, created } | 422 ImportMiss
 *   GET    /api/recipes/:id                  { recipe }
 *   PATCH  /api/recipes/:id                  { title?, servings?, …, ingredients?, steps?, tags?, notes? } → { recipe }
 *   DELETE /api/recipes/:id                  → { ok } (archived)
 *   POST   /api/recipes/:id/restore          → { recipe }
 *   POST   /api/recipes/:id/reread           → { recipe }: its page read again
 *   POST   /api/recipes/:id/cooked           { on? } → { recipe }
 *   DELETE /api/recipes/:id/cooked/:date     → { recipe }
 *   GET    /api/recipes/plan?week=&fresh=1   WeekPlan
 *   PUT    /api/recipes/plan                 { week, days } → WeekPlan
 *   GET    /api/recipes/grocery              GroceryList
 *   POST   /api/recipes/grocery/add          { recipe_ids?, servings?, week? } → GroceryList + { added, pantry }
 *   POST   /api/recipes/grocery/items        { item } → GroceryList
 *   PATCH  /api/recipes/grocery/items/:id    { ticked?, item? } → GroceryList
 *   DELETE /api/recipes/grocery/items/:id    → GroceryList
 *   POST   /api/recipes/grocery/clear        → GroceryList (ticked lines removed)
 *   GET    /api/recipes/prefs, PUT { pantry?, system? } → RecipePrefs
 */
import { AthenaInputError } from "../../lib/db";
import { takeSaveSlot } from "../../lib/saved";
import {
  addOwnGroceryItem,
  addToGroceryList,
  archiveRecipe,
  clearTickedGroceries,
  createRecipe,
  deleteGroceryItem,
  draftFromInput,
  getGroceryList,
  getRecipe,
  getRecipePrefs,
  getWeekPlan,
  ImportFailed,
  importRecipe,
  listRecipes,
  markCooked,
  moveSavedRecipes,
  putWeekPlan,
  rereadRecipe,
  setRecipePrefs,
  thisMonday,
  unmarkCooked,
  updateGroceryItem,
  updateRecipe,
  type PlanCalendar,
} from "../../lib/recipes";
import type { TimeFilter } from "../../lib/recipe-rules";

type Reply = (data: unknown, status?: number) => Response;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Send a JSON object");
}

const TIMES: TimeFilter[] = ["quick", "under-hour", "longer"];

/** /api/recipes*; null for anything else. */
export async function handleRecipeRoutes(req: Request, url: URL, segments: string[], reply: Reply, deps: { calendar: PlanCalendar | null }): Promise<Response | null> {
  const [, first, second, third, fourth] = segments;
  if (first !== "recipes") return null;
  const m = req.method;
  const notAllowed = () => reply({ error: "Method not allowed" }, 405);

  if (!second) {
    if (m === "GET") {
      // Saved's recipe links from before (or saved while a page wouldn't read) move in, a few each time.
      const moved = await moveSavedRecipes().catch(() => 0);
      const time = url.searchParams.get("time") as TimeFilter | null;
      const list = await listRecipes({ q: url.searchParams.get("q") ?? undefined, tag: url.searchParams.get("tag"), time: time && TIMES.includes(time) ? time : null });
      return reply({ ...list, moved });
    }
    if (m === "POST") {
      const b = await body(req);
      const out = await createRecipe(draftFromInput(b), { parse: "manual", notes: typeof b.notes === "string" ? b.notes : "" });
      return reply({ recipe: out.recipe }, 201);
    }
    return notAllowed();
  }

  if (second === "import" && !third) {
    if (m !== "POST") return notAllowed();
    if (!(await takeSaveSlot(req))) return reply({ error: "That's a lot of imports at once. Try again in a minute." }, 429);
    const b = await body(req);
    try {
      const out = await importRecipe(b.url, { harder: b.harder === true });
      return reply(out, out.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ImportFailed) return reply(error.miss, 422);
      throw error;
    }
  }

  if (second === "plan" && !third) {
    if (m === "GET") {
      const week = url.searchParams.get("week") || (await thisMonday());
      return reply(await getWeekPlan(week, { calendar: deps.calendar, fresh: url.searchParams.get("fresh") === "1" }));
    }
    if (m === "PUT") return reply(await putWeekPlan(await body(req), { calendar: deps.calendar }));
    return notAllowed();
  }

  if (second === "prefs" && !third) {
    if (m === "GET") return reply(await getRecipePrefs());
    if (m === "PUT") return reply(await setRecipePrefs(await body(req)));
    return notAllowed();
  }

  if (second === "grocery") {
    if (!third) return m === "GET" ? reply(await getGroceryList()) : notAllowed();
    if (third === "add" && !fourth) return m === "POST" ? reply(await addToGroceryList(await body(req))) : notAllowed();
    if (third === "clear" && !fourth) return m === "POST" ? reply(await clearTickedGroceries()) : notAllowed();
    if (third === "items") {
      if (!fourth) return m === "POST" ? reply(await addOwnGroceryItem((await body(req)).item)) : notAllowed();
      if (segments.length !== 5) return reply({ error: "Not found" }, 404);
      const out = m === "PATCH" ? await updateGroceryItem(fourth, await body(req)) : m === "DELETE" ? await deleteGroceryItem(fourth) : undefined;
      if (out === undefined) return notAllowed();
      return out ? reply(out) : reply({ error: "Not found" }, 404);
    }
    return reply({ error: "Not found" }, 404);
  }

  // One recipe.
  const id = second;
  if (!third) {
    if (m === "GET") {
      const recipe = await getRecipe(id);
      return recipe ? reply({ recipe }) : reply({ error: "Not found" }, 404);
    }
    if (m === "PATCH") {
      const recipe = await updateRecipe(id, await body(req));
      return recipe ? reply({ recipe }) : reply({ error: "Not found" }, 404);
    }
    if (m === "DELETE") return (await archiveRecipe(id)) ? reply({ ok: true }) : reply({ error: "Not found" }, 404);
    return notAllowed();
  }
  if (third === "restore" && !fourth && m === "POST") return (await archiveRecipe(id, false)) ? reply({ recipe: await getRecipe(id) }) : reply({ error: "Not found" }, 404);
  if (third === "reread" && !fourth && m === "POST") {
    const recipe = await rereadRecipe(id);
    return recipe ? reply({ recipe }) : reply({ error: "Not found" }, 404);
  }
  if (third === "cooked") {
    const recipe = !fourth && m === "POST" ? await markCooked(id, (await body(req).catch(() => ({}) as Record<string, unknown>)).on) : fourth && m === "DELETE" ? await unmarkCooked(id, fourth) : undefined;
    if (recipe === undefined) return notAllowed();
    return recipe ? reply({ recipe }) : reply({ error: "Not found" }, 404);
  }
  return reply({ error: "Not found" }, 404);
}
