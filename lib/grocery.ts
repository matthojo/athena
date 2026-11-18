/**
 * The grocery list (Recipes, migration 0053): recipes' ingredients merged
 * into one list, quantities added up across recipes with their units
 * normalised, pantry staples left off, and lines grouped by aisle from a
 * small static map. Pure and shared with the app, so a list ticked offline
 * groups the same way.
 */
import { bestUnit, itemKey, scaleIngredient, UNITS, type Ingredient, type UnitSystem } from "./recipe-units";

export const AISLES = ["produce", "meat-fish", "dairy-eggs", "bakery", "chilled", "tins-jars", "dry", "baking", "spices", "frozen", "drinks", "other"] as const;
export type Aisle = (typeof AISLES)[number];

export const AISLE_LABEL: Record<Aisle, string> = {
  produce: "Fruit and veg",
  "meat-fish": "Meat and fish",
  "dairy-eggs": "Dairy and eggs",
  bakery: "Bread",
  chilled: "Chilled",
  "tins-jars": "Tins, jars and stock",
  dry: "Pasta, rice and grains",
  baking: "Baking",
  spices: "Herbs and spices",
  frozen: "Frozen",
  drinks: "Drinks",
  other: "Other",
};

/** Whole names first (they beat a single word: "chicken stock" is a cupboard thing, "chicken" is meat). */
const PHRASES: Array<[string, Aisle]> = [
  ["chicken stock", "tins-jars"], ["beef stock", "tins-jars"], ["vegetable stock", "tins-jars"], ["stock cube", "tins-jars"], ["fish sauce", "tins-jars"], ["soy sauce", "tins-jars"],
  ["tomato paste", "tins-jars"], ["tomato puree", "tins-jars"], ["tomato purée", "tins-jars"], ["chopped tomato", "tins-jars"], ["coconut milk", "tins-jars"], ["peanut butter", "tins-jars"],
  ["puff pastry", "chilled"], ["shortcrust pastry", "chilled"], ["filo pastry", "chilled"], ["crème fraîche", "dairy-eggs"], ["creme fraiche", "dairy-eggs"], ["sour cream", "dairy-eggs"],
  ["baking soda", "baking"], ["baking powder", "baking"], ["bicarbonate of soda", "baking"], ["vanilla extract", "baking"], ["brown sugar", "baking"], ["icing sugar", "baking"], ["caster sugar", "baking"],
  ["chocolate chip", "baking"], ["plain flour", "baking"], ["self-raising flour", "baking"], ["all-purpose flour", "baking"], ["bread flour", "baking"],
  ["spring onion", "produce"], ["red pepper", "produce"], ["green pepper", "produce"], ["bell pepper", "produce"], ["sweet potato", "produce"], ["lemon juice", "produce"], ["lime juice", "produce"],
  ["black pepper", "spices"], ["bay leaf", "spices"], ["chilli flake", "spices"], ["ground cumin", "spices"], ["olive oil", "tins-jars"], ["vegetable oil", "tins-jars"], ["sesame oil", "tins-jars"],
  ["frozen pea", "frozen"], ["ice cream", "frozen"],
];

const WORDS: Partial<Record<Aisle, string[]>> = {
  produce: ["onion", "shallot", "garlic", "leek", "carrot", "celery", "potato", "tomato", "mushroom", "pepper", "courgette", "zucchini", "aubergine", "eggplant", "spinach", "kale", "lettuce", "cabbage", "broccoli", "cauliflower", "cucumber", "avocado", "lemon", "lime", "orange", "apple", "banana", "berry", "berries", "pear", "ginger", "chilli", "chili", "squash", "pumpkin", "pea", "bean sprout", "herb", "parsley", "coriander", "cilantro", "basil", "mint", "thyme", "rosemary", "sage", "dill", "chive", "tarragon", "rocket", "fennel", "beetroot", "parsnip", "swede", "asparagus", "corn", "lemongrass", "radish", "watercress"],
  "meat-fish": ["chicken", "beef", "pork", "lamb", "bacon", "sausage", "mince", "steak", "thigh", "drumstick", "breast", "ham", "chorizo", "pancetta", "prosciutto", "turkey", "duck", "salmon", "cod", "haddock", "tuna", "prawn", "shrimp", "mussel", "fish", "anchovy", "anchovies"],
  "dairy-eggs": ["egg", "milk", "butter", "cream", "cheese", "cheddar", "parmesan", "mozzarella", "feta", "yoghurt", "yogurt", "ricotta", "mascarpone", "halloumi"],
  bakery: ["bread", "baguette", "roll", "bun", "pitta", "pita", "tortilla", "wrap", "naan", "sourdough", "breadcrumb"],
  chilled: ["pastry", "tofu", "hummus", "pesto"],
  "tins-jars": ["stock", "broth", "tin", "can", "passata", "paste", "sauce", "ketchup", "mayonnaise", "mustard", "vinegar", "oil", "honey", "syrup", "jam", "olive", "caper", "chickpeas", "lentils", "beans", "bean", "coconut"],
  dry: ["pasta", "spaghetti", "penne", "fusilli", "linguine", "lasagne", "noodles", "noodle", "rice", "couscous", "quinoa", "oats", "barley", "bulgur", "polenta", "nut", "almond", "walnut", "cashew", "peanut", "seed", "raisin"],
  baking: ["flour", "sugar", "yeast", "cocoa", "chocolate", "cornflour", "cornstarch", "vanilla", "gelatine"],
  spices: ["salt", "peppercorn", "cumin", "paprika", "turmeric", "cinnamon", "nutmeg", "oregano", "chilli powder", "garam masala", "curry powder", "cardamom", "clove", "allspice", "spice", "seasoning", "saffron", "fenugreek"],
  frozen: ["frozen"],
  drinks: ["wine", "beer", "brandy", "sherry", "cider", "juice", "water", "rum", "vodka", "gin", "whisky", "port"],
};

/** Which aisle a thing is in. Unknown things are "other". */
export function aisleOf(item: string): Aisle {
  const key = itemKey(item);
  // Phrases against the name as written too: "chopped tomatoes" is a tin, though "chopped" is a prep word to itemKey.
  const raw = item.toLowerCase().replace(/\s+/g, " ");
  for (const [phrase, aisle] of PHRASES) if (key.includes(phrase) || raw.includes(phrase)) return aisle;
  const words = key.split(" ");
  const last = words.at(-1) ?? "";
  // The last word names the thing ("red wine vinegar" is vinegar); any word is the fallback.
  for (const aisle of AISLES) if (WORDS[aisle]?.includes(last)) return aisle;
  for (const w of [...words].reverse()) for (const aisle of AISLES) if (WORDS[aisle]?.includes(w)) return aisle;
  return "other";
}

// ---------- pantry ----------

/** What's left off unless the owner changes it (Settings → Recipes). */
export const DEFAULT_PANTRY = ["salt", "black pepper", "olive oil", "vegetable oil", "sunflower oil", "water"];

const PANTRY_DESCRIPTORS = new Set(["kosher", "sea", "cooking", "table", "fine", "flaky", "rock", "ground", "freshly", "fresh", "extra", "virgin", "extra-virgin", "light", "mild", "good", "quality", "a", "little", "some", "neutral", "boiling", "cold", "hot", "warm", "tap"]);

/** A name as the pantry compares it: "freshly ground black pepper" is "black pepper", "kosher salt" is "salt". */
export function pantryKey(item: string): string {
  const words = itemKey(item)
    .split(" ")
    .filter((w) => !PANTRY_DESCRIPTORS.has(w));
  return words.join(" ");
}

/** Is it a staple the owner keeps in? Exact names only, so "red pepper" isn't "black pepper" and "salted butter" isn't salt. */
export function isPantry(item: string, pantry: string[]): boolean {
  const key = pantryKey(item);
  if (!key) return false;
  // "salt and pepper": both halves staples.
  const parts = key.split(/\s+(?:and|&|or)\s+/);
  const keys = new Set(pantry.map(pantryKey).filter(Boolean));
  return parts.every((p) => keys.has(p) || (p === "pepper" && keys.has("black pepper")));
}

/** Pantry words as kept: trimmed, lower case, no duplicates, at most 60. */
export function cleanPantry(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const w of list) {
    if (typeof w !== "string") continue;
    const s = w.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 60) break;
  }
  return out;
}

// ---------- merging ----------

export interface GroceryLine {
  /** itemKey of the item: what lines merge on. */
  key: string;
  item: string;
  quantity: number | null;
  unit: string | null;
  aisle: Aisle;
  /** The recipes it's for (ids). Empty for the owner's own lines. */
  recipes: string[];
}

export interface RecipeForList {
  id: string;
  servings: number | null;
  ingredients: Ingredient[];
  /** Cook it for this many (the plan's servings, or the recipe view's scale). */
  serves?: number | null;
}

/** Which bucket an amount adds into: mass and volume by dimension, counts by their own unit. */
const bucketOf = (unit: string | null): string => {
  const def = unit ? UNITS[unit] : null;
  if (!def) return "each";
  return def.dim === "count" ? `count:${def.id}` : def.dim;
};

interface Acc {
  key: string;
  item: string;
  bucket: string;
  units: Set<string | null>;
  base: number | null;
  recipes: Set<string>;
  /** Each recipe's wording for it, to pick the one that reads right with the total. */
  names?: string[];
}

/** "5 onions", not the first recipe's "1 onion": a plural wording for a count over one, else the shortest. */
function wordingFor(a: Acc, amount: { quantity: number | null; unit: string | null }): string {
  const names = a.names?.length ? a.names : [a.item];
  const singular = (n: string) => itemKey(n).split(" ").at(-1) === n.toLowerCase().split(" ").at(-1);
  const many = amount.unit === null && amount.quantity !== null && amount.quantity > 1;
  const pick = many ? names.find((n) => !singular(n)) : names.find((n) => singular(n));
  if (pick) return pick;
  if (!many) return names.reduce((x, y) => (y.length < x.length ? y : x));
  // No recipe said it in the plural: add an s the simple way ("onion" → "onions"), leaving odd words alone.
  const one = names[0];
  return /[^s]$/.test(one) && /[a-z]$/i.test(one) && !/(sh|ch|x|y)$/.test(one) ? `${one}s` : one;
}

function addTo(acc: Acc, quantity: number | null, unit: string | null): void {
  if (quantity === null) return;
  const def = unit ? UNITS[unit] : null;
  acc.base = (acc.base ?? 0) + quantity * (def && def.dim !== "count" ? def.base : 1);
  acc.units.add(unit);
}

/** The added-up amount, in the unit a shopper would read. */
function amountOf(acc: Acc, system: UnitSystem): { quantity: number | null; unit: string | null } {
  if (acc.base === null) return { quantity: null, unit: null };
  const units = [...acc.units];
  if (acc.bucket === "each" || acc.bucket.startsWith("count:")) return { quantity: acc.base, unit: units[0] ?? null };
  // One unit throughout stays that unit: three recipes' "1 tbsp" is "3 tbsp", not 45 ml.
  if (units.length === 1 && units[0]) {
    const def = UNITS[units[0]];
    const stays = def.system === "both" || def.system === system;
    if (stays) return { quantity: acc.base / def.base, unit: def.id };
  }
  if (acc.bucket === "volume" && units.every((u) => u === "tsp" || u === "tbsp")) {
    return acc.base >= 15 ? { quantity: acc.base / 15, unit: "tbsp" } : { quantity: acc.base / 5, unit: "tsp" };
  }
  return bestUnit(acc.base, acc.bucket as "mass" | "volume", system);
}

/**
 * One merged list from several recipes: each scaled to the servings asked,
 * pantry staples left off (and returned, so the app can say so), the same
 * thing added up across recipes. Quantities in different dimensions (200 g
 * of spinach and "a bag") stay separate lines.
 */
export function buildGroceryLines(recipes: RecipeForList[], pantry: string[], system: UnitSystem = "metric"): { lines: GroceryLine[]; pantry: string[] } {
  const accs = new Map<string, Acc>();
  const skipped = new Set<string>();
  for (const r of recipes) {
    const factor = r.serves && r.servings ? r.serves / r.servings : 1;
    for (const raw of r.ingredients) {
      if (!raw.item) continue;
      if (isPantry(raw.item, pantry)) {
        for (const part of pantryKey(raw.item).split(/\s+(?:and|&|or)\s+/)) skipped.add(part === "pepper" ? "black pepper" : part);
        continue;
      }
      const ing = scaleIngredient(raw, factor);
      const key = itemKey(ing.item);
      const bucket = bucketOf(ing.unit);
      // A line with no amount ("a squeeze of lemon juice") joins one that has: the shop is the same.
      const sameKey = [...accs.values()].filter((a) => a.key === key);
      let acc = accs.get(`${key}\u0000${bucket}`) ?? (ing.quantity === null ? sameKey[0] : undefined);
      if (!acc) {
        // A first amount for something listed without one so far takes that line over.
        const bare = sameKey.find((a) => a.base === null);
        if (bare) {
          accs.delete(`${bare.key}\u0000${bare.bucket}`);
          bare.bucket = bucket;
          acc = bare;
        } else acc = { key, item: ing.item, bucket, units: new Set(), base: null, recipes: new Set(), names: [] };
        accs.set(`${key}\u0000${bucket}`, acc);
      }
      addTo(acc, ing.quantity, ing.unit);
      acc.recipes.add(r.id);
      acc.names?.push(ing.item);
    }
  }
  const lines = [...accs.values()].map((a) => {
    const amount = amountOf(a, system);
    return { key: a.key, item: wordingFor(a, amount), ...amount, aisle: aisleOf(a.item), recipes: [...a.recipes] };
  });
  return { lines, pantry: [...skipped].sort() };
}

/** A line already on the stored list. */
export interface ListedLine {
  id: string;
  item: string;
  quantity: number | null;
  unit: string | null;
  recipes: string[];
  ticked: boolean;
}

/**
 * Lines for an existing list: added into an unticked line for the same thing
 * in the same kind of amount, else new. Ticked lines are left alone (that
 * shop's done).
 */
export function mergeIntoList(existing: ListedLine[], add: GroceryLine[], system: UnitSystem = "metric"): { update: Array<{ id: string; quantity: number | null; unit: string | null; recipes: string[] }>; insert: GroceryLine[] } {
  const update = new Map<string, { id: string; quantity: number | null; unit: string | null; recipes: string[] }>();
  const insert: GroceryLine[] = [];
  for (const line of add) {
    const into = existing.find((e) => !e.ticked && itemKey(e.item) === line.key && (bucketOf(e.unit) === bucketOf(line.unit) || e.quantity === null || line.quantity === null));
    if (!into) {
      insert.push(line);
      continue;
    }
    const cur = update.get(into.id) ?? { id: into.id, quantity: into.quantity, unit: into.unit, recipes: [...into.recipes] };
    const acc: Acc = { key: line.key, item: into.item, bucket: bucketOf(cur.unit ?? line.unit), units: new Set(), base: null, recipes: new Set() };
    addTo(acc, cur.quantity, cur.unit);
    addTo(acc, line.quantity, line.unit);
    const amount = amountOf(acc, system);
    update.set(into.id, { id: into.id, ...amount, recipes: [...new Set([...cur.recipes, ...line.recipes])] });
    // Later additions see the new amount.
    into.quantity = amount.quantity;
    into.unit = amount.unit;
  }
  return { update: [...update.values()], insert };
}

/** Lines grouped by aisle, aisles in shop order, lines by name; ticked lines last in each aisle. */
export function groupByAisle<T extends { item: string; aisle: Aisle | string; ticked?: boolean }>(lines: T[]): Array<{ aisle: Aisle; label: string; lines: T[] }> {
  const out: Array<{ aisle: Aisle; label: string; lines: T[] }> = [];
  for (const aisle of AISLES) {
    const here = lines.filter((l) => (AISLES.includes(l.aisle as Aisle) ? l.aisle : "other") === aisle);
    if (!here.length) continue;
    here.sort((a, b) => Number(!!a.ticked) - Number(!!b.ticked) || a.item.localeCompare(b.item, "en-GB", { sensitivity: "base" }));
    out.push({ aisle, label: AISLE_LABEL[aisle], lines: here });
  }
  return out;
}
