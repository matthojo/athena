// Recipes, pure parts: reading real recipe pages (fixtures saved from BBC Good Food, RecipeTin Eats,
// Bon Appétit and Food.com, trimmed to their head and JSON-LD, plus schema.org's own microdata example),
// ingredient lines, scaling and units, timers, merging and aisles, the pantry, and the week plan's scoring.
// Run: npx tsx --test lib/recipes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalUrl, durationMinutes, parseRecipePage, recipeFromJsonLd, recipeFromMicrodata } from "./recipe-parse";
import { formatAmount, formatIngredient, formatQuantity, itemKey, parseIngredient, scaleIngredient, servingsOf, toSystem } from "./recipe-units";
import { ingredientsForStep, stepTimers } from "./recipe-steps";
import { aisleOf, buildGroceryLines, cleanPantry, DEFAULT_PANTRY, groupByAisle, isPantry, mergeIntoList } from "./grocery";
import { classifyEvenings, scoreRecipe, suggestPlan, weekDates, type Evening, type PlanRecipe } from "./meal-plan";
import { savedToMigrate, cleanRecipeTags, minutesLabel, matchesTime } from "./recipe-rules";

const page = (name: string) => readFileSync(new URL(`./fixtures/recipes/${name}.html`, import.meta.url), "utf8");

// ---------- reading pages ----------

test("BBC Good Food: JSON-LD in a list of blocks, a whole-number yield, ISO total time, author list", () => {
  const r = parseRecipePage(page("bbc-good-food"), "https://www.bbcgoodfood.com/recipes/chicken-leek-pie?utm_source=share");
  assert.ok(r);
  assert.equal(r.parse, "json-ld");
  const d = r.draft;
  assert.equal(d.title, "Chicken & leek pie");
  assert.equal(d.url, "https://www.bbcgoodfood.com/recipes/chicken-leek-pie", "the canonical link, not the shared address");
  assert.equal(d.by, "Mary Cadogan");
  assert.equal(d.servings, 6);
  assert.equal(d.total_minutes, 180);
  assert.match(d.photo ?? "", /^https:\/\/images\.immediate\.co\.uk\/.*Chicken-leek-pie/);
  assert.equal(d.ingredients.length, 18);
  assert.deepEqual(d.ingredients[0], { quantity: 1.5, quantity_max: null, unit: "kg", item: "whole corn-fed chicken", note: null });
  assert.deepEqual(pick(d.ingredients[3]), { quantity: 3, quantity_max: 4, unit: "sprig", item: "thyme" });
  assert.deepEqual(pick(d.ingredients.find((i) => i.item === "leeks")!), { quantity: 2, quantity_max: null, unit: null, item: "leeks" });
  assert.equal(d.steps.length, 8);
  assert.match(d.steps[2].text, /boil for 6 minutes/);
  assert.ok(d.tags.includes("british") && d.tags.includes("chicken"), d.tags.join());
  assert.ok(d.tags.length <= 8);
});

test("RecipeTin Eats: @graph, author by @id, sections, the abbreviated method dropped, (Note n) markers gone", () => {
  const r = parseRecipePage(page("recipetin-eats"), "https://www.recipetineats.com/chicken-chasseur/");
  assert.ok(r);
  const d = r.draft;
  assert.equal(d.title, "JB's Chicken Chasseur");
  assert.equal(d.by, "Chef JB (RecipeTin)");
  assert.deepEqual([d.servings, d.prep_minutes, d.cook_minutes, d.total_minutes], [4, 15, 45, 60]);
  assert.ok(!d.steps.some((s) => /abbreviated/i.test(s.section ?? "")), "the short version isn't a step");
  assert.equal(d.steps[0].section, "Chicken");
  assert.ok(d.steps.some((s) => s.section === "Chasseur Sauce"));
  const thighs = d.ingredients[0];
  assert.deepEqual(pick(thighs), { quantity: 4, quantity_max: null, unit: null, item: "chicken thighs" });
  assert.equal(thighs.note, "bone-in, skin on; ~250g/8oz each");
  assert.ok(!d.ingredients.some((i) => /note \d/i.test(`${i.item} ${i.note}`)));
  const butter = d.ingredients.find((i) => /butter/.test(i.item))!;
  assert.deepEqual(pick(butter), { quantity: 30, quantity_max: null, unit: "g", item: "unsalted butter" }, "30g / 2 tbsp: the first measure");
  const garlic = d.ingredients.find((i) => /garlic/.test(i.item))!;
  assert.deepEqual(pick(garlic), { quantity: 3, quantity_max: null, unit: "clove", item: "garlic" });
});

test("Bon Appétit: plain-English times, 'Makes 16', cups with grams in brackets", () => {
  const d = recipeFromJsonLd(page("bon-appetit"), "https://www.bonappetit.com/recipe/bas-best-chocolate-chip-cookies")!;
  assert.equal(d.title, "BA’s Best Chocolate Chip Cookies");
  assert.deepEqual([d.cook_minutes, d.total_minutes, d.servings, d.yield_text], [20, 40, 16, "Makes 16"]);
  assert.deepEqual(pick(d.ingredients[0]), { quantity: 1.5, quantity_max: null, unit: "cup", item: "all-purpose flour" });
  assert.match(d.ingredients[0].note ?? "", /plus 1 Tbsp/);
  assert.deepEqual(pick(d.ingredients.find((i) => i.item.includes("chocolate"))!), { quantity: 6, quantity_max: null, unit: "oz", item: "bittersweet chocolate" });
  assert.ok(d.tags.includes("dessert") && !d.tags.includes("web"));
});

test("Food.com: padded lines, entities (&ordm;) decoded, a yield with servings in it", () => {
  const d = recipeFromJsonLd(page("food-com"), "https://www.food.com/recipe/best-banana-bread-2886")!;
  assert.equal(d.servings, 10, "1 loaf, 10 serving(s)");
  assert.deepEqual([d.prep_minutes, d.cook_minutes, d.total_minutes], [10, 60, 70]);
  assert.deepEqual(pick(d.ingredients[0]), { quantity: 0.5, quantity_max: null, unit: "cup", item: "butter" });
  assert.equal(d.ingredients[0].note, "softened");
  assert.equal(d.steps[1].text, "Preheat oven to 350º / 180º.");
  assert.ok(!d.tags.some((t) => /</.test(t)), "'< 4 Hours' isn't a tag");
});

test("microdata: schema.org's own example, nested PropertyValues, relative image, prep and cook added up", () => {
  const html = page("schema-org-microdata");
  assert.equal(recipeFromJsonLd(html, "https://example.org/x"), null);
  const r = parseRecipePage(html, "https://example.org/recipes/banana-bread?ref=1");
  assert.ok(r);
  assert.equal(r.parse, "microdata");
  const d = r.draft;
  assert.equal(d.title, "Mom's World Famous Banana Bread", "the nested PropertyValue's name isn't the title");
  assert.equal(d.by, "John Smith");
  assert.equal(d.photo, "https://example.org/recipes/bananabread.jpg");
  assert.deepEqual([d.prep_minutes, d.cook_minutes, d.total_minutes, d.yield_text], [15, 60, 75, "1 loaf"]);
  assert.deepEqual(d.ingredients.map(pick), [
    { quantity: 3, quantity_max: 4, unit: null, item: "ripe bananas" },
    { quantity: 1, quantity_max: null, unit: null, item: "egg" },
    { quantity: 0.75, quantity_max: null, unit: "cup", item: "sugar" },
  ]);
  assert.equal(d.steps.length, 1);
  assert.match(d.steps[0].text, /^Preheat the oven to 350 degrees\. .* bake for one hour\.$/);
});

test("microdata: the older data-vocabulary.org vocabulary and a list of steps", () => {
  const html = `<div itemscope itemtype="http://data-vocabulary.org/Recipe"><h1 itemprop="name">Leek soup</h1>
    <span itemprop="ingredients">2 leeks</span><span itemprop="ingredients">1 potato, diced</span>
    <ol itemprop="instructions"><li>Soften the leeks.</li><li>Add the potato and simmer for 20 minutes.</li></ol></div>`;
  const d = recipeFromMicrodata(html, "https://old.example/soup")!;
  assert.equal(d.title, "Leek soup");
  assert.deepEqual(d.steps.map((s) => s.text), ["Soften the leeks.", "Add the potato and simmer for 20 minutes."]);
  assert.equal(d.ingredients[1].note, "diced");
});

test("a page with neither is null; durations and canonical addresses", () => {
  assert.equal(parseRecipePage("<html><head><title>Hi</title></head><body><p>Just words.</p></body></html>", "https://x.test/"), null);
  assert.equal(parseRecipePage(`<script type="application/ld+json">{"@type":"Recipe","name":"Empty"}</script>`, "https://x.test/"), null, "a name alone isn't a recipe");
  assert.equal(durationMinutes("PT1H10M"), 70);
  assert.equal(durationMinutes("P0DT0H40M"), 40);
  assert.equal(durationMinutes("PT90M"), 90);
  assert.equal(durationMinutes("1 hr 15 mins"), 75);
  assert.equal(durationMinutes("PT0S"), null);
  assert.equal(durationMinutes("soon"), null);
  assert.equal(canonicalUrl(`<meta property="og:url" content="https://a.test/r">`, "https://a.test/r?utm=1"), "https://a.test/r");
  assert.equal(canonicalUrl(`<link rel="canonical" href="/r/1">`, "https://a.test/x"), "https://a.test/r/1");
});

// ---------- lines, scaling, units ----------

const pick = (i: { quantity: number | null; quantity_max?: number | null; unit: string | null; item: string }) => ({ quantity: i.quantity, quantity_max: i.quantity_max ?? null, unit: i.unit, item: i.item });

test("ingredient lines", () => {
  assert.deepEqual(pick(parseIngredient("2 x 400g tins chopped tomatoes")), { quantity: 800, quantity_max: null, unit: "g", item: "chopped tomatoes" });
  assert.deepEqual(pick(parseIngredient("a pinch of salt")), { quantity: 1, quantity_max: null, unit: "pinch", item: "salt" });
  assert.deepEqual(pick(parseIngredient("squeeze of lemon juice")), { quantity: null, quantity_max: null, unit: null, item: "lemon juice" });
  assert.deepEqual(pick(parseIngredient("1 onion halved")), { quantity: 1, quantity_max: null, unit: null, item: "onion" });
  assert.deepEqual(pick(parseIngredient("1 T olive oil")), { quantity: 1, quantity_max: null, unit: "tbsp", item: "olive oil" });
  assert.deepEqual(pick(parseIngredient("1 t cumin")), { quantity: 1, quantity_max: null, unit: "tsp", item: "cumin" });
  assert.deepEqual(pick(parseIngredient("half a lemon")), { quantity: 0.5, quantity_max: null, unit: null, item: "lemon" });
  assert.equal(parseIngredient("salt and pepper, to taste").note, "to taste");
  assert.equal(itemKey("large or medium eggs"), "egg");
  assert.equal(itemKey("garlic cloves"), "garlic");
  assert.equal(itemKey("Tomatoes"), "tomato");
  assert.equal(itemKey("finely chopped fresh parsley"), "parsley");
  assert.equal(servingsOf("Serves 4-6"), 4);
  assert.equal(servingsOf(["4", "4 servings"]), 4);
});

test("scaling: fractions for spoons and counts, round metric amounts, kg and l once they pass 1000", () => {
  const flour = parseIngredient("2 tbsp plain flour");
  assert.equal(formatIngredient(scaleIngredient(flour, 0.75)), "1 ½ tbsp plain flour");
  assert.equal(formatIngredient(scaleIngredient(parseIngredient("1 ½kg chicken"), 2)), "3kg chicken");
  assert.equal(formatIngredient(scaleIngredient(parseIngredient("700g potatoes"), 1.5)), "1.05kg potatoes");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("425ml stock"), 4 / 6)), "285ml");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("3 eggs"), 1 / 3)), "1");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("3-4 thyme sprigs"), 2)), "6–8 sprigs");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("1 egg"), 1 / 2)), "½");
  assert.equal(formatQuantity(1 / 3, "cup"), "⅓");
  assert.equal(formatQuantity(2.98, "tsp"), "3");
  assert.equal(formatQuantity(1234, "g"), "1230");
  assert.equal(formatQuantity(7.25, "g"), "7.3");
  assert.equal(formatIngredient(scaleIngredient(parseIngredient("salt, to taste"), 3)), "salt, to taste", "no amount, nothing to scale");
});

test("metric and imperial: cups to ml, grams to ounces and pounds, spoons and counts unchanged", () => {
  assert.deepEqual(toSystem({ quantity: 1, unit: "cup" }, "metric"), { quantity: 240, unit: "ml" });
  assert.deepEqual(toSystem({ quantity: 0.5, unit: "cup" }, "imperial"), { quantity: 0.5, unit: "cup" });
  const oz = toSystem({ quantity: 200, unit: "g" }, "imperial");
  assert.equal(oz.unit, "oz");
  assert.equal(formatQuantity(oz.quantity, "oz"), "7");
  assert.equal(toSystem({ quantity: 900, unit: "g" }, "imperial").unit, "lb");
  assert.deepEqual(toSystem({ quantity: 2, unit: "tbsp" }, "imperial"), { quantity: 2, unit: "tbsp" });
  assert.deepEqual(toSystem({ quantity: 3, unit: "clove" }, "metric"), { quantity: 3, unit: "clove" });
  assert.equal(formatIngredient(scaleIngredient(parseIngredient("1½ cups all-purpose flour"), 2, "metric")), "720ml all-purpose flour");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("500ml milk"), 1, "imperial")), "2 ⅛ cups");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("6 oz chocolate"), 1, "metric")), "170g");
});

test("cook mode: timers from a step's words, and the ingredients each step uses", () => {
  assert.deepEqual(stepTimers("simmer for 1 hr-1 hr 15 until tender"), [{ label: "1 hr-1 hr 15", seconds: 3600 }]);
  assert.deepEqual(stepTimers("Bake for 25-30 mins until golden."), [{ label: "25-30 mins", seconds: 1500 }]);
  assert.deepEqual(stepTimers("Cook about 4 minutes, then rest 90 seconds."), [
    { label: "4 minutes", seconds: 240 },
    { label: "90 seconds", seconds: 90 },
  ]);
  assert.deepEqual(stepTimers("Simmer for half an hour."), [{ label: "30 minutes", seconds: 1800 }]);
  assert.deepEqual(stepTimers("Roast for 1½ hours."), [{ label: "1.5 hours", seconds: 5400 }]);
  assert.deepEqual(stepTimers("Leave overnight, or at least 13 hours"), [], "over 12 hours is planning, not a timer");
  assert.deepEqual(stepTimers("Preheat to 200C, gas 6."), []);
  const ings = ["4 chicken thighs", "500ml chicken stock", "2 leeks, sliced", "25g unsalted butter", "3 garlic cloves"].map(parseIngredient);
  assert.deepEqual(ingredientsForStep("Brown the chicken in the butter.", ings), [0, 3]);
  assert.deepEqual(ingredientsForStep("Pour in the stock and add the leeks and garlic.", ings), [1, 2, 4]);
});

// ---------- the grocery list ----------

const pie = { id: "pie", servings: 6, ingredients: ["2 leeks, sliced", "25g butter", "2 tbsp olive oil", "1 tsp salt", "425ml chicken stock", "250g puff pastry", "4 eggs"].map(parseIngredient) };
const soup = { id: "soup", servings: 4, ingredients: ["3 leeks", "1 large potato", "15g butter", "1 litre chicken stock", "salt and freshly ground black pepper", "a squeeze of lemon juice"].map(parseIngredient) };
const cookies = { id: "cookies", servings: 16, ingredients: ["¾ cup unsalted butter", "1 tbsp vanilla extract", "1 tsp vanilla extract", "2 large eggs"].map(parseIngredient) };

test("merging: the same thing added up across recipes, units normalised, counts by their unit", () => {
  const { lines, pantry } = buildGroceryLines([pie, soup], DEFAULT_PANTRY);
  const line = (key: string) => lines.find((l) => l.key === key)!;
  assert.deepEqual(pick(line("leek")), { quantity: 5, quantity_max: null, unit: null, item: "leeks" });
  assert.deepEqual(line("leek").recipes, ["pie", "soup"]);
  assert.deepEqual(pick(line("butter")), { quantity: 40, quantity_max: null, unit: "g", item: "butter" });
  assert.deepEqual(pick(line("chicken stock")), { quantity: 1.425, quantity_max: null, unit: "l", item: "chicken stock" }, "425 ml and 1 litre: 1.425 l");
  assert.deepEqual(pantry, ["black pepper", "olive oil", "salt"]);
  assert.ok(!lines.some((l) => /salt|olive oil|pepper/.test(l.key)));
  assert.equal(line("lemon juice").quantity, null);
});

test("merging: servings scale each recipe; cups and grams of one thing add up in grams' system", () => {
  const twice = buildGroceryLines([{ ...pie, serves: 12 }], DEFAULT_PANTRY).lines;
  assert.equal(twice.find((l) => l.key === "leek")!.quantity, 4);
  assert.equal(twice.find((l) => l.key === "egg")!.quantity, 8);
  const both = buildGroceryLines([pie, cookies], DEFAULT_PANTRY).lines;
  // 25 g of butter (mass) and ¾ cup (volume) can't be added: two lines.
  assert.equal(both.filter((l) => l.key === "butter" || l.key === "unsalted butter").length, 2);
  const vanilla = both.find((l) => l.key === "vanilla extract")!;
  assert.equal(formatAmount(vanilla), "1 ⅓ tbsp", "a tablespoon and a teaspoon");
  assert.equal(both.find((l) => l.key === "egg")!.quantity, 6);
  // Imperial: grams go to ounces.
  const imp = buildGroceryLines([pie], DEFAULT_PANTRY, "imperial").lines;
  assert.equal(imp.find((l) => l.key === "puff pastry")!.unit, "oz");
});

test("merging into a stored list: open lines add up, ticked lines are left alone", () => {
  const existing = [
    { id: "a", item: "leeks", quantity: 2, unit: null, recipes: ["pie"], ticked: false },
    { id: "b", item: "butter", quantity: 25, unit: "g", recipes: ["pie"], ticked: true },
    { id: "c", item: "Milk", quantity: null, unit: null, recipes: [], ticked: false },
  ];
  const { lines } = buildGroceryLines([soup], DEFAULT_PANTRY);
  const { update, insert } = mergeIntoList(existing, [...lines, { key: "milk", item: "milk", quantity: 500, unit: "ml", aisle: "dairy-eggs", recipes: ["x"] }]);
  assert.deepEqual(update.find((u) => u.id === "a"), { id: "a", quantity: 5, unit: null, recipes: ["pie", "soup"] });
  assert.ok(!update.some((u) => u.id === "b"), "the ticked butter isn't changed");
  assert.ok(insert.some((l) => l.key === "butter" && l.quantity === 15), "new butter is a new line");
  assert.deepEqual(update.find((u) => u.id === "c"), { id: "c", quantity: 500, unit: "ml", recipes: ["x"] }, "my own 'Milk' takes the amount");
});

test("aisles: a small static map, whole names before single words", () => {
  assert.equal(aisleOf("leeks"), "produce");
  assert.equal(aisleOf("chicken thighs"), "meat-fish");
  assert.equal(aisleOf("chicken stock"), "tins-jars");
  assert.equal(aisleOf("red wine vinegar"), "tins-jars");
  assert.equal(aisleOf("crème fraîche"), "dairy-eggs");
  assert.equal(aisleOf("puff pastry"), "chilled");
  assert.equal(aisleOf("all-purpose flour"), "baking");
  assert.equal(aisleOf("spaghetti"), "dry");
  assert.equal(aisleOf("red pepper"), "produce");
  assert.equal(aisleOf("smoked paprika"), "spices");
  assert.equal(aisleOf("kitchen foil"), "other");
  const groups = groupByAisle([
    { item: "leeks", aisle: "produce", ticked: true },
    { item: "carrots", aisle: "produce" },
    { item: "eggs", aisle: "dairy-eggs" },
    { item: "foil", aisle: "nonsense" },
    { item: "apples", aisle: "produce" },
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.lines.map((l) => l.item)]), [
    ["Fruit and veg", ["apples", "carrots", "leeks"]],
    ["Dairy and eggs", ["eggs"]],
    ["Other", ["foil"]],
  ]);
});

test("pantry: exact names after descriptors, so red pepper and salted butter stay on the list", () => {
  assert.ok(isPantry("kosher salt", DEFAULT_PANTRY));
  assert.ok(isPantry("cooking salt", DEFAULT_PANTRY));
  assert.ok(isPantry("freshly ground black pepper", DEFAULT_PANTRY));
  assert.ok(isPantry("extra virgin olive oil", DEFAULT_PANTRY));
  assert.ok(isPantry("salt and pepper", DEFAULT_PANTRY));
  assert.ok(isPantry("boiling water", DEFAULT_PANTRY));
  assert.ok(!isPantry("red pepper", DEFAULT_PANTRY));
  assert.ok(!isPantry("salted butter", DEFAULT_PANTRY));
  assert.ok(!isPantry("sesame oil", DEFAULT_PANTRY));
  assert.ok(!isPantry("garlic", DEFAULT_PANTRY));
  // The owner's own list, edited in Settings.
  const mine = cleanPantry("Salt, plain flour,\n  plain flour , butter");
  assert.deepEqual(mine, ["salt", "plain flour", "butter"]);
  assert.ok(isPantry("2 tbsp plain flour".replace(/^2 tbsp /, ""), mine));
  assert.ok(!isPantry("olive oil", mine), "olive oil isn't in their pantry any more");
  const { lines } = buildGroceryLines([pie], mine);
  assert.ok(lines.some((l) => l.key === "olive oil"));
  assert.ok(!lines.some((l) => l.key === "butter"));
});

// ---------- the week plan ----------

const monday = "2026-11-09";
const recipes: PlanRecipe[] = [
  { id: "stir-fry", title: "Prawn stir-fry", minutes: 20, tags: ["quick"], cooked: [] },
  { id: "omelette", title: "Omelette", minutes: 10, tags: [], cooked: ["2026-11-07"] },
  { id: "pie", title: "Chicken & leek pie", minutes: 180, tags: ["make ahead"], cooked: [] },
  { id: "ragu", title: "Beef ragù", minutes: 150, tags: ["batch"], cooked: [] },
  { id: "pasta", title: "Lemon pasta", minutes: 25, tags: [], cooked: ["2026-10-20"] },
  { id: "curry", title: "Chickpea curry", minutes: 40, tags: [], cooked: [] },
  { id: "soup", title: "Leek soup", minutes: 45, tags: [], cooked: [] },
  { id: "salad", title: "Salad", minutes: null, tags: [], cooked: [] },
];
const evening = (date: string, kind: Evening["kind"], why: string | null = null): Evening => ({ date, kind, why });

test("scoring: quick on late or travel evenings, long or batch on a free one, not again within 7 days", () => {
  const late = evening("2026-11-10", "late", "Book club at 19:00");
  const free = evening("2026-11-11", "free");
  const r = (id: string) => recipes.find((x) => x.id === id)!;
  assert.ok(scoreRecipe(r("stir-fry"), late) > scoreRecipe(r("curry"), late));
  assert.ok(scoreRecipe(r("curry"), late) > scoreRecipe(r("pie"), late));
  assert.ok(scoreRecipe(r("pie"), late) < 0, "three hours on a late evening is out");
  assert.ok(scoreRecipe(r("ragu"), free) > scoreRecipe(r("stir-fry"), free));
  assert.ok(scoreRecipe(r("omelette"), late) < scoreRecipe(r("pasta"), late), "cooked three days ago");
  assert.ok(scoreRecipe(r("omelette"), evening("2026-11-15", "late")) > 0, "eight days later it's fine again");
  assert.equal(scoreRecipe(r("stir-fry"), evening("2026-11-12", "away")), -Infinity);
  assert.ok(scoreRecipe(r("stir-fry"), late, { usedThisWeek: new Set(["stir-fry"]) }) < 0, "not twice in a week");
});

test("the plan: deterministic, no repeats, quick meals where the calendar is busy, the owner's picks kept", () => {
  const days = weekDates(monday);
  assert.equal(days.length, 7);
  const evenings = [
    evening(days[0], "normal"),
    evening(days[1], "late", "Book club at 19:00"),
    evening(days[2], "travel", "Train to Leeds"),
    evening(days[3], "away", "Away"),
    evening(days[4], "free"),
    evening(days[5], "free"),
    evening(days[6], "normal"),
  ];
  const plan = suggestPlan(evenings, recipes, { weekStart: monday });
  assert.deepEqual(plan, suggestPlan(evenings, recipes, { weekStart: monday }), "same week, same plan");
  const ids = plan.map((p) => p.recipe_id);
  const chosen = ids.filter(Boolean);
  assert.equal(new Set(chosen).size, chosen.length, "nothing twice");
  const minutes = (id: string | null) => recipes.find((r) => r.id === id)?.minutes ?? null;
  assert.ok(minutes(ids[1])! <= 30 && minutes(ids[2])! <= 30, `quick on Tue and Wed: ${ids}`);
  assert.equal(ids[3], null);
  assert.match(plan[3].reason, /no dinner/);
  assert.ok(["ragu", "pie"].includes(ids[4]!) && ["ragu", "pie"].includes(ids[5]!), `long cooks on the free evenings: ${ids}`);
  assert.match(plan[1].reason, /^Quick: Book club at 19:00$/);
  assert.match(plan[4].reason, /^Free evening/);
  assert.ok(!ids.includes("omelette") || ids.indexOf("omelette") >= 6, "the omelette was cooked on Saturday");
  const kept = suggestPlan(evenings, recipes, { weekStart: monday, keep: { [days[0]]: "stir-fry" } });
  assert.equal(kept[0].recipe_id, "stir-fry");
  assert.equal(kept[0].reason, "Your pick");
  assert.notEqual(kept[1].recipe_id, "stir-fry", "a kept recipe isn't used again");
  assert.notDeepEqual(suggestPlan(evenings, recipes, { weekStart: "2026-11-16" }).map((p) => p.recipe_id), [], "another week plans too");
});

test("evenings from the calendar: late events, travel and trips, in the owner's zone", () => {
  const tz = "Europe/London";
  const at = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00Z`);
  const days = weekDates(monday);
  const busy = [
    { start: at(days[0], "10:00"), end: at(days[0], "11:00"), kind: "event", title: "Standup" },
    { start: at(days[1], "19:00"), end: at(days[1], "21:00"), kind: "event", title: "Book club" },
    { start: at(days[2], "16:00"), end: at(days[2], "18:30"), kind: "event", title: "Workshop" },
    { start: at(days[3], "08:00"), end: at(days[3], "10:00"), kind: "travel", title: "Train to Leeds" },
  ];
  const ev = classifyEvenings(days, busy, [days[3]], [days[4]], tz);
  assert.deepEqual(
    ev.map((e) => [e.kind, e.why]),
    [
      ["free", null],
      ["late", "Book club at 19:00"],
      ["late", "Workshop at 16:00"],
      ["travel", "Train to Leeds"],
      ["away", "Away"],
      ["free", null],
      ["free", null],
    ],
  );
});

// ---------- Saved → Recipes ----------

test("moving Saved recipe links: each once, never one that's already a recipe, kept or archived", () => {
  const saved = [
    { id: "s1", thing: "recipe", url: "https://a.test/pie", archived: false },
    { id: "s2", thing: "recipe", url: "https://b.test/soup", archived: false },
    { id: "s3", thing: "book", url: "https://c.test/book", archived: false },
    { id: "s4", thing: "recipe", url: "https://d.test/old", archived: true },
    { id: "s5", thing: "recipe", url: null, archived: false },
  ];
  const first = savedToMigrate(saved, []);
  assert.deepEqual(first, ["s1", "s2"]);
  // After the first run both are recipes (one archived since): a second run moves nothing.
  assert.deepEqual(savedToMigrate(saved, [{ saved_id: "s1" }, { saved_id: "s2" }]), []);
  assert.deepEqual(savedToMigrate(saved, [{ saved_id: "s1" }]), ["s2"], "a run that stopped half way picks up where it was");
});

test("tags, minutes and the time filter", () => {
  assert.deepEqual(cleanRecipeTags(["Dinner", "dinner", " Quick ", "<b>", "x".repeat(40)]), ["dinner", "quick"]);
  assert.equal(minutesLabel(75), "1 hr 15 min");
  assert.equal(minutesLabel(120), "2 hr");
  assert.equal(minutesLabel(null), "");
  assert.ok(matchesTime(30, "quick") && !matchesTime(31, "quick") && !matchesTime(null, "quick"));
  assert.ok(matchesTime(null, "longer") && matchesTime(61, "longer") && !matchesTime(60, "longer"));
});

test("asking by ingredient: chicken is the thighs and the whole bird, not the stock", async () => {
  const { ingredientIs } = await import("./recipe-steps");
  assert.ok(ingredientIs("whole corn-fed chicken", "chicken"));
  assert.ok(ingredientIs("chicken thighs", "chicken"));
  assert.ok(!ingredientIs("chicken stock", "chicken"));
  assert.ok(ingredientIs("leeks", "leek") && ingredientIs("leek", "leeks"));
});

test("fixes: grams step back down, counts round, a merged line reads right, tins by their name, honest reasons", () => {
  assert.equal(formatIngredient(scaleIngredient(parseIngredient("1.5kg chicken"), 0.5)), "750g chicken");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("1-1.5kg potatoes"), 0.5)), "500–750g");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("2 bay leaves"), 4 / 6)), "1 ½");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("3-4 thyme sprigs"), 0.5)), "1 ½–2 sprigs");
  assert.equal(formatAmount(scaleIngredient(parseIngredient("4 onions"), 4 / 6)), "3");
  const { lines } = buildGroceryLines(
    [
      { id: "a", servings: 4, ingredients: [parseIngredient("1 onion, chopped")] },
      { id: "b", servings: 4, ingredients: [parseIngredient("4 onions")] },
    ],
    DEFAULT_PANTRY,
  );
  assert.equal(formatIngredient({ ...lines[0], note: null }), "5 onions");
  assert.equal(aisleOf("chopped tomatoes"), "tins-jars");
  const plan = suggestPlan([evening("2026-11-10", "late", "Book club at 19:00")], [{ id: "slow", title: "Stew", minutes: 45, tags: [], cooked: [] }], { weekStart: monday });
  assert.equal(plan[0].reason, "Busy evening: Book club at 19:00", "not called quick when it isn't");
});

test("an item worded for its amount", async () => {
  const { itemFor } = await import("./recipe-units");
  assert.equal(itemFor(scaleIngredient(parseIngredient("4 leeks, sliced"), 0.25)), "leeks".replace(/s$/, ""));
  assert.equal(itemFor(scaleIngredient(parseIngredient("2 bay leaves"), 0.5)), "bay leaf");
  assert.equal(itemFor(parseIngredient("3 eggs")), "eggs");
  assert.equal(itemFor(parseIngredient("2 tbsp capers")), "capers", "a unit takes the plural");
});
