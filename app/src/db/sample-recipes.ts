/**
 * Recipes in sample mode (db/recipes.ts): eight recipes with their own
 * pictures (public/sample/recipes/), a week with two busy evenings and a
 * train, and a grocery list with eight weeks of past shops behind it, all
 * kept in memory on this device. The plan's suggestions come from the same
 * scoring the server uses (lib/meal-plan.ts), and the list's usuals and aisle
 * order from the same reasoning (lib/grocery-usuals.ts).
 */

import { parseIngredient } from "../../../lib/recipe-units";
import { buildGroceryLines, cleanPantry, DEFAULT_PANTRY, mergeIntoList, aisleOf } from "../../../lib/grocery";
import { dueUsuals, learnedOrder, learnUsuals, skipUntil, walkOrder, type BoughtEntry } from "../../../lib/grocery-usuals";
import { suggestPlan, weekDates, type Evening } from "../../../lib/meal-plan";
import { cleanRecipeTags, matchesTime, minutesOf, type GroceryItem, type GroceryList, type PlanDay, type Recipe, type RecipeCard, type RecipePrefs, type TimeFilter, type WeekPlan } from "../../../lib/recipe-rules";
import { addDays, weekStart } from "../components/day-words";
import { localToday } from "../lib/time";

const id = (n: number) => `5a3e0000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`;
export const SAMPLE_RECIPE_IDS = { pie: id(1), stirFry: id(2), pasta: id(3), curry: id(4), soup: id(5), ragu: id(6), bread: id(7), shakshuka: id(8) } as const;

interface Seed {
  id: string;
  title: string;
  slug: string;
  by: string;
  site: string;
  servings: number;
  prep: number;
  cook: number;
  tags: string[];
  ingredients: string[];
  steps: string[];
  notes?: string;
  /** Days ago it was cooked. */
  cooked?: number[];
  description?: string;
}

const SEEDS: Seed[] = [
  {
    id: SAMPLE_RECIPE_IDS.pie,
    title: "Chicken & leek pie",
    slug: "chicken-leek-pie",
    by: "Mary Cadogan",
    site: "https://www.bbcgoodfood.com/recipes/chicken-leek-pie",
    servings: 6,
    prep: 40,
    cook: 140,
    tags: ["pie", "make ahead", "british"],
    ingredients: ["1.5kg whole chicken", "2 bay leaves", "3-4 thyme sprigs", "25g butter", "2 tbsp olive oil", "6 bacon rashers, cut into pieces", "2 leeks, thinly sliced", "2 tbsp plain flour", "2 tbsp grainy mustard", "4 tbsp crème fraîche", "250g puff pastry", "1 egg, beaten"],
    steps: [
      "Put the chicken in a deep pan with the bay leaves and thyme, half-cover with water and bring to the boil. Cover and simmer for 1 hr 15 mins until tender.",
      "Lift the chicken out, keep 425ml of the stock, then strip the meat into bite-sized pieces.",
      "Heat the butter and olive oil, fry the bacon for 5 minutes, then add the leeks and cook for 8 minutes until soft.",
      "Stir in the flour, then the stock, mustard and crème fraîche. Simmer for 2 minutes, then fold in the chicken.",
      "Tip into a pie dish, cover with the puff pastry, brush with the egg and bake for 30-35 mins until golden.",
    ],
    notes: "Makes a good Sunday batch: the filling freezes.",
    cooked: [24],
  },
  {
    id: SAMPLE_RECIPE_IDS.stirFry,
    title: "Prawn and greens stir-fry",
    slug: "prawn-stir-fry",
    by: "Athena sample",
    site: "https://example.org/recipes/prawn-stir-fry",
    servings: 2,
    prep: 10,
    cook: 10,
    tags: ["quick", "weeknight"],
    ingredients: ["200g raw king prawns", "2 garlic cloves, sliced", "thumb-sized piece of ginger, grated", "1 head of broccoli, cut into florets", "100g sugar snap peas", "2 spring onions, sliced", "2 tbsp soy sauce", "1 tbsp vegetable oil", "1 red chilli, sliced"],
    steps: ["Heat the oil in a wok until smoking.", "Stir-fry the broccoli and sugar snap peas for 3 minutes.", "Add the garlic, ginger and chilli and cook for 1 minute.", "Add the prawns and cook for 2-3 minutes until pink, then toss with the soy sauce and spring onions."],
    cooked: [12],
  },
  {
    id: SAMPLE_RECIPE_IDS.pasta,
    title: "Lemon and parmesan spaghetti",
    slug: "lemon-spaghetti",
    by: "Athena sample",
    site: "https://example.org/recipes/lemon-spaghetti",
    servings: 2,
    prep: 5,
    cook: 15,
    tags: ["quick", "vegetarian", "pasta"],
    ingredients: ["200g spaghetti", "1 lemon, zested and juiced", "40g parmesan, grated", "25g butter", "a handful of basil leaves", "salt and black pepper"],
    steps: ["Cook the spaghetti in salted water for 10 minutes.", "Melt the butter with the lemon zest in a wide pan.", "Toss in the spaghetti with a splash of its water, the lemon juice and the parmesan until glossy.", "Finish with the basil and plenty of black pepper."],
    cooked: [3],
  },
  {
    id: SAMPLE_RECIPE_IDS.curry,
    title: "Chickpea and spinach curry",
    slug: "chickpea-curry",
    by: "Athena sample",
    site: "https://example.org/recipes/chickpea-curry",
    servings: 4,
    prep: 10,
    cook: 30,
    tags: ["vegetarian", "curry"],
    ingredients: ["1 onion, chopped", "3 garlic cloves", "1 tbsp curry powder", "1 tsp ground cumin", "2 x 400g tins chickpeas, drained", "400g tin chopped tomatoes", "400ml coconut milk", "200g spinach", "1 tbsp vegetable oil"],
    steps: ["Soften the onion in the oil for 8 minutes.", "Add the garlic and spices and cook for 1 minute.", "Add the chickpeas, tomatoes and coconut milk and simmer for 20 minutes.", "Stir in the spinach until it wilts, then season."],
  },
  {
    id: SAMPLE_RECIPE_IDS.soup,
    title: "Leek and potato soup",
    slug: "leek-potato-soup",
    by: "Athena sample",
    site: "https://example.org/recipes/leek-potato-soup",
    servings: 4,
    prep: 15,
    cook: 30,
    tags: ["soup", "vegetarian"],
    ingredients: ["3 leeks, sliced", "2 large potatoes, diced", "1 onion, chopped", "25g butter", "1 litre vegetable stock", "100ml double cream", "a few chives, snipped"],
    steps: ["Melt the butter and soften the leeks and onion for 10 minutes.", "Add the potatoes and stock and simmer for 20 minutes.", "Blend until smooth, stir in the cream and top with the chives."],
    cooked: [40],
  },
  {
    id: SAMPLE_RECIPE_IDS.ragu,
    title: "Slow beef ragù",
    slug: "beef-ragu",
    by: "Athena sample",
    site: "https://example.org/recipes/beef-ragu",
    servings: 8,
    prep: 20,
    cook: 180,
    tags: ["batch", "freezer", "pasta"],
    ingredients: ["1kg beef shin, in large chunks", "2 onions, chopped", "2 carrots, chopped", "2 celery sticks, chopped", "4 garlic cloves", "2 tbsp tomato purée", "250ml red wine", "2 x 400g tins chopped tomatoes", "500ml beef stock", "2 bay leaves", "2 tbsp olive oil"],
    steps: ["Brown the beef in the olive oil in batches and set aside.", "Soften the onions, carrots and celery for 10 minutes, then add the garlic and tomato purée.", "Pour in the wine and bubble for 2 minutes, then add the tomatoes, stock, bay leaves and beef.", "Cover and cook gently for 3 hours, until the beef falls apart. Shred it into the sauce."],
    notes: "Freeze in portions of two.",
  },
  {
    id: SAMPLE_RECIPE_IDS.bread,
    title: "Banana bread",
    slug: "banana-bread",
    by: "lkadlec",
    site: "https://www.food.com/recipe/best-banana-bread-2886",
    servings: 10,
    prep: 10,
    cook: 60,
    tags: ["baking"],
    ingredients: ["½ cup butter, softened", "1 cup granulated sugar", "2 eggs, beaten", "3 bananas, mashed", "1 ½ cups plain flour", "1 tsp baking soda", "½ tsp salt", "½ tsp vanilla extract"],
    steps: ["Preheat the oven to 180°C.", "Cream the butter and sugar, then beat in the eggs and bananas.", "Fold in the flour, baking soda, salt and vanilla.", "Pour into a lined loaf tin and bake for 55 minutes."],
  },
  {
    id: SAMPLE_RECIPE_IDS.shakshuka,
    title: "Shakshuka",
    slug: "shakshuka",
    by: "Athena sample",
    site: "https://example.org/recipes/shakshuka",
    servings: 2,
    prep: 5,
    cook: 20,
    tags: ["quick", "eggs", "vegetarian"],
    ingredients: ["1 onion, sliced", "1 red pepper, sliced", "2 garlic cloves", "1 tsp ground cumin", "1 tsp smoked paprika", "400g tin chopped tomatoes", "4 eggs", "a handful of coriander", "1 tbsp olive oil"],
    steps: ["Soften the onion and pepper in the oil for 6 minutes.", "Add the garlic and spices, then the tomatoes, and simmer for 8 minutes.", "Make four hollows, crack in the eggs, cover and cook for 5-6 minutes.", "Scatter over the coriander and serve with bread."],
  },
];

const daysAgo = (n: number) => addDays(localToday(), -n);
const iso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function make(s: Seed): Recipe {
  return {
    id: s.id,
    title: s.title,
    url: s.site,
    photo: null,
    by: s.by,
    description: null,
    servings: s.servings,
    yield_text: null,
    prep_minutes: s.prep,
    cook_minutes: s.cook,
    total_minutes: s.prep + s.cook,
    ingredients: s.ingredients.map(parseIngredient),
    steps: s.steps.map((text) => ({ text, section: null })),
    tags: s.tags,
    notes: s.notes ?? "",
    parse: "json-ld",
    saved_id: null,
    photo_url: `/sample/recipes/${s.slug}.webp`,
    cooked: (s.cooked ?? []).map((n) => ({ on: daysAgo(n) })),
    created_at: iso(60),
    updated_at: iso(2),
    archived: false,
  } as Recipe;
}

/** A past shop: its day, what it bought (as the lines were, for Undo) and the walk round the shop. */
interface Shop {
  id: string;
  day: string;
  lines: GroceryItem[];
  aisle_order: string[];
}

interface State {
  recipes: Recipe[];
  plans: Map<string, PlanDay[]>;
  grocery: GroceryItem[];
  prefs: RecipePrefs;
  shops: Shop[];
  skips: Array<{ item: string; until: string }>;
}

let state: State | null = null;
function s(): State {
  if (!state) state = { recipes: SEEDS.map(make), plans: new Map(), grocery: seedGrocery(), prefs: { pantry: [...DEFAULT_PANTRY], system: "metric", usuals: true }, shops: seedShops(), skips: [] };
  return state;
}

/**
 * Eight weeks of shops, counted back from today so the same usuals are always
 * due: milk every four days, a loaf every five, yoghurt every six, bananas
 * weekly. Eggs and lemons were bought lately, and coffee beans are on the list
 * already, so none of those three is offered. The walks go bread first, which
 * isn't the list's usual order.
 */
function seedShops(): Shop[] {
  const today = localToday();
  const buys: Array<{ text: string; every: number; last: number }> = [
    { text: "2 pints milk", every: 4, last: 4 },
    { text: "Sourdough loaf", every: 5, last: 6 },
    { text: "500 g Greek yoghurt", every: 6, last: 6 },
    { text: "6 bananas", every: 7, last: 7 },
    { text: "12 eggs", every: 7, last: 3 },
    { text: "4 lemons", every: 10, last: 4 },
    { text: "Coffee beans", every: 12, last: 12 },
    { text: "Spinach", every: 8, last: 5 },
  ];
  // Three shops a week; each thing goes on the shop on or just before the day it was needed.
  const shopDays = Array.from({ length: 57 }, (_, ago) => ago).filter((ago) => [0, 3, 4].includes(ago % 7) && ago > 0);
  const byDay = new Map<string, GroceryItem[]>();
  for (const b of buys) {
    const ing = parseIngredient(b.text);
    for (let due = b.last; due <= 56; due += b.every) {
      const ago = shopDays.find((d) => d >= due) ?? due;
      const day = addDays(today, -ago);
      if (byDay.get(day)?.some((l) => l.item === ing.item)) continue;
      const lines = byDay.get(day) ?? [];
      lines.push({ id: crypto.randomUUID(), item: ing.item, quantity: ing.quantity, unit: ing.unit, aisle: aisleOf(ing.item), recipes: [], own: true, ticked: true });
      byDay.set(day, lines);
    }
  }
  const walk = ["bakery", "produce", "dairy-eggs", "meat-fish", "chilled", "tins-jars", "dry", "baking", "spices", "drinks", "frozen", "other"];
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, lines], i) => ({ id: `sample-shop-${i}`, day, lines, aisle_order: walk.filter((a) => lines.some((l) => l.aisle === a)) }));
}

const boughtEntries = (): BoughtEntry[] => s().shops.flatMap((shop) => shop.lines.map((l) => ({ item: l.item, quantity: l.quantity, unit: l.unit, aisle: l.aisle, day: shop.day })));

function seedGrocery(): GroceryItem[] {
  return [
    { id: "g-own-1", item: "Coffee beans", quantity: null, unit: null, aisle: "drinks", recipes: [], own: true, ticked: false },
    { id: "g-own-2", item: "Kitchen roll", quantity: null, unit: null, aisle: "other", recipes: [], own: true, ticked: true },
  ];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const card = (r: Recipe): RecipeCard => ({
  id: r.id,
  title: r.title,
  photo_url: r.photo_url,
  total_minutes: minutesOf(r),
  tags: r.tags,
  servings: r.servings,
  parse: r.parse,
  last_cooked: r.cooked[0]?.on ?? null,
  ingredient_count: r.ingredients.length,
});

export function sampleRecipes(q: { q?: string; tag?: string | null; time?: TimeFilter | null } = {}): { recipes: RecipeCard[]; tags: string[]; moved: number } {
  const live = s().recipes.filter((r) => !r.archived);
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (r: Recipe) => {
    const text = [r.title, ...r.tags, ...r.ingredients.map((i) => i.item)].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const tags = [...new Set(live.flatMap((r) => r.tags))].sort();
  const recipes = live
    .filter((r) => hit(r) && (!q.tag || r.tags.includes(q.tag)) && matchesTime(minutesOf(r), q.time ?? null))
    .sort((a, b) => a.title.localeCompare(b.title, "en-GB"))
    .map(card);
  return { recipes, tags, moved: 0 };
}

export function sampleRecipe(rid: string): Recipe | null {
  const r = s().recipes.find((x) => x.id === rid);
  return r ? clone(r) : null;
}

export function sampleRecipesByIngredient(words: string[]): Recipe[] {
  const want = words.map((w) => w.toLowerCase().replace(/s$/, ""));
  return s()
    .recipes.filter((r) => !r.archived)
    .map((r) => ({ r, n: want.filter((w) => r.ingredients.some((i) => i.item.toLowerCase().includes(w))).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || (minutesOf(a.r) ?? 999) - (minutesOf(b.r) ?? 999))
    .map((x) => clone(x.r));
}

export function sampleCreate(body: { title: string; ingredients?: string[]; steps?: string[]; servings?: number | null; total_minutes?: number | null; tags?: string[]; notes?: string }): Recipe {
  const r: Recipe = {
    ...make({ id: crypto.randomUUID(), title: body.title, slug: "", by: "", site: "", servings: body.servings ?? 2, prep: 0, cook: 0, tags: cleanRecipeTags(body.tags ?? []), ingredients: body.ingredients ?? [], steps: body.steps ?? [], notes: body.notes }),
    url: null,
    by: null,
    photo_url: null,
    prep_minutes: null,
    cook_minutes: null,
    total_minutes: body.total_minutes ?? null,
    parse: "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  s().recipes.push(r);
  return clone(r);
}

export function samplePatch(rid: string, patch: Record<string, unknown>): Recipe | null {
  const r = s().recipes.find((x) => x.id === rid);
  if (!r) return null;
  if (typeof patch.title === "string") r.title = patch.title;
  for (const k of ["servings", "prep_minutes", "cook_minutes", "total_minutes"] as const) if (k in patch) (r[k] as number | null) = (patch[k] as number | null) ?? null;
  if (Array.isArray(patch.ingredients)) r.ingredients = (patch.ingredients as string[]).filter((l) => l.trim()).map(parseIngredient);
  if (Array.isArray(patch.steps)) r.steps = (patch.steps as string[]).filter((l) => l.trim()).map((text) => ({ text, section: null }));
  if (Array.isArray(patch.tags)) r.tags = cleanRecipeTags(patch.tags);
  if (typeof patch.notes === "string") r.notes = patch.notes;
  r.updated_at = new Date().toISOString();
  return clone(r);
}

export function sampleArchive(rid: string): void {
  const r = s().recipes.find((x) => x.id === rid);
  if (r) r.archived = true;
}

export function sampleCooked(rid: string, on: string | null, remove = false): Recipe | null {
  const r = s().recipes.find((x) => x.id === rid);
  if (!r) return null;
  const day = on ?? localToday();
  r.cooked = r.cooked.filter((c) => c.on !== day);
  if (!remove) r.cooked.unshift({ on: day });
  r.cooked.sort((a, b) => b.on.localeCompare(a.on));
  return clone(r);
}

// ---------- the week ----------

/** The sample calendar: book club on Tuesday, a late workshop on Wednesday, a train on Thursday. */
function sampleEvenings(week: string): Evening[] {
  const days = weekDates(week);
  return days.map((date, i): Evening => {
    if (i === 1) return { date, kind: "late", why: "Book club at 19:00" };
    if (i === 2) return { date, kind: "late", why: "Team dinner at 18:30" };
    if (i === 3) return { date, kind: "travel", why: "Train home from Leeds" };
    if (i === 5 || i === 6) return { date, kind: "free", why: null };
    return { date, kind: "normal", why: null };
  });
}

export function samplePlan(week: string, fresh = false): WeekPlan {
  const evenings = sampleEvenings(week);
  const kept = fresh ? undefined : s().plans.get(week);
  const keep: Record<string, string | null> = {};
  for (const d of kept ?? []) keep[d.date] = d.recipe_id;
  const recipes = s()
    .recipes.filter((r) => !r.archived)
    .map((r) => ({ id: r.id, title: r.title, minutes: minutesOf(r), tags: r.tags, cooked: r.cooked.map((c) => c.on) }));
  const picks = suggestPlan(evenings, recipes, { weekStart: week, keep: kept ? keep : undefined });
  return {
    week,
    days: picks.map((p, i) => ({
      date: p.date,
      recipe_id: p.recipe_id,
      servings: kept?.find((d) => d.date === p.date)?.servings ?? null,
      reason: kept ? (kept.find((d) => d.date === p.date)?.reason ?? p.reason) : p.reason,
      evening: { kind: evenings[i].kind, why: evenings[i].why },
      suggested: !kept,
    })),
    unread: [],
  };
}

export function sampleSavePlan(week: string, days: Array<{ date: string; recipe_id: string | null; servings?: number | null }>): WeekPlan {
  const before = samplePlan(week);
  const stored: PlanDay[] = before.days.map((d) => {
    const next = days.find((x) => x.date === d.date);
    const changed = next && next.recipe_id !== d.recipe_id;
    return { ...d, recipe_id: next ? next.recipe_id : d.recipe_id, servings: next?.servings ?? d.servings, suggested: false, reason: changed ? (next!.recipe_id ? "Your pick" : "No dinner planned") : d.reason };
  });
  s().plans.set(week, stored);
  return { week, days: clone(stored), unread: [] };
}

export const thisSampleWeek = () => weekStart(localToday());

// ---------- the grocery list ----------

const titleOf = (rid: string) => s().recipes.find((r) => r.id === rid)?.title ?? "A recipe";

export function sampleGrocery(): GroceryList {
  const today = localToday();
  const usuals = s().prefs.usuals ? dueUsuals(boughtEntries(), { today, onList: s().grocery.map((g) => g.item), skipped: s().skips }) : [];
  return { items: clone(s().grocery), usuals, order: learnedOrder(s().shops.map((shop) => shop.aisle_order)) };
}

/** "Done shopping": the ticked lines filed as today's shop. Sample ticks carry no times, so the walk is the order they sit in the list. */
export function sampleDone(): GroceryList & { trip_id: string | null; count: number } {
  const ticked = s().grocery.filter((g) => g.ticked);
  if (!ticked.length) return { ...sampleGrocery(), trip_id: null, count: 0 };
  const id = `sample-shop-${crypto.randomUUID()}`;
  const at = Date.now();
  const walk = walkOrder(ticked.map((g, i) => ({ aisle: g.aisle, at: at + i * 60_000 })));
  s().shops.unshift({ id, day: localToday(), lines: clone(ticked), aisle_order: walk });
  s().grocery = s().grocery.filter((g) => !g.ticked);
  return { ...sampleGrocery(), trip_id: id, count: ticked.length };
}

export function sampleUndoShop(id: string): GroceryList | null {
  const shop = s().shops.find((x) => x.id === id);
  if (!shop) return null;
  s().shops = s().shops.filter((x) => x.id !== id);
  s().grocery.push(...shop.lines.map((l) => ({ ...l, ticked: true })));
  return sampleGrocery();
}

export function sampleSkip(item: string): GroceryList {
  const today = localToday();
  const usual = learnUsuals(boughtEntries(), today).find((u) => u.item.toLowerCase() === item.toLowerCase());
  s().skips.push({ item, until: skipUntil({ every: usual?.every ?? 7 }, today) });
  return sampleGrocery();
}

export function sampleHistory(): { shops: number; since: string | null } {
  const days = s().shops.map((x) => x.day).sort();
  return { shops: days.length, since: days[0] ?? null };
}

export function sampleForget(): { shops: number } {
  const shops = s().shops.length;
  s().shops = [];
  s().skips = [];
  return { shops };
}

export function sampleAddToGrocery(body: { recipe_ids?: string[]; servings?: Record<string, number>; week?: string }): GroceryList & { added: number; pantry: string[] } {
  let ids = body.recipe_ids ?? [];
  const serves: Record<string, number> = { ...(body.servings ?? {}) };
  if (body.week) {
    const plan = samplePlan(body.week);
    ids = plan.days.map((d) => d.recipe_id).filter((x): x is string => !!x);
    for (const d of plan.days) if (d.recipe_id && d.servings) serves[d.recipe_id] = d.servings;
  }
  const recipes = s().recipes.filter((r) => ids.includes(r.id));
  const { lines, pantry } = buildGroceryLines(
    recipes.map((r) => ({ id: r.id, servings: r.servings, ingredients: r.ingredients, serves: serves[r.id] ?? null })),
    s().prefs.pantry,
    s().prefs.system
  );
  const list = s().grocery;
  const { update, insert } = mergeIntoList(
    list.map((g) => ({ id: g.id, item: g.item, quantity: g.quantity, unit: g.unit, recipes: g.recipes.map((r) => r.id), ticked: g.ticked })),
    lines,
    s().prefs.system
  );
  for (const u of update) {
    const g = list.find((x) => x.id === u.id)!;
    g.quantity = u.quantity;
    g.unit = u.unit;
    g.recipes = u.recipes.map((rid) => ({ id: rid, title: titleOf(rid) }));
  }
  for (const l of insert) list.push({ id: crypto.randomUUID(), item: l.item, quantity: l.quantity, unit: l.unit, aisle: l.aisle, recipes: l.recipes.map((rid) => ({ id: rid, title: titleOf(rid) })), own: false, ticked: false });
  return { ...sampleGrocery(), added: update.length + insert.length, pantry };
}

export function sampleAddOwn(text: string): GroceryList {
  const ing = parseIngredient(text);
  s().grocery.push({ id: crypto.randomUUID(), item: ing.item, quantity: ing.quantity, unit: ing.unit, aisle: aisleOf(ing.item), recipes: [], own: true, ticked: false });
  return sampleGrocery();
}

export function samplePatchItem(gid: string, patch: { ticked?: boolean; item?: string }): GroceryList {
  const g = s().grocery.find((x) => x.id === gid);
  if (g && typeof patch.ticked === "boolean") g.ticked = patch.ticked;
  if (g && typeof patch.item === "string" && patch.item.trim()) g.item = patch.item.trim();
  return sampleGrocery();
}

export function sampleRemoveItem(gid: string): GroceryList {
  s().grocery = s().grocery.filter((x) => x.id !== gid);
  return sampleGrocery();
}

export function sampleClearTicked(): GroceryList {
  s().grocery = s().grocery.filter((x) => !x.ticked);
  return sampleGrocery();
}

export function samplePrefs(): RecipePrefs {
  return clone(s().prefs);
}

export function sampleSavePrefs(p: Partial<RecipePrefs>): RecipePrefs {
  if (p.pantry) s().prefs.pantry = cleanPantry(p.pantry);
  if (p.system === "metric" || p.system === "imperial") s().prefs.system = p.system;
  if (typeof p.usuals === "boolean") s().prefs.usuals = p.usuals;
  return samplePrefs();
}
