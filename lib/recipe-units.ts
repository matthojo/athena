/**
 * Recipe quantities (Recipes, migration 0053; notes in docs/notes/recipes.md):
 * reading an ingredient line into quantity, unit, item and note, scaling it,
 * switching it between metric and imperial, and writing it back with
 * sensible units and fractions ("1 ½ tbsp", "450 g", "1.2 kg").
 *
 * Pure and shared with the app: no network, no DOM.
 */

export type Dimension = "mass" | "volume" | "count";
export type UnitSystem = "metric" | "imperial";

export interface UnitDef {
  id: string;
  dim: Dimension;
  /** Grams or millilitres per one of it; 1 for count units. */
  base: number;
  system: UnitSystem | "both";
  /** Written as a fraction (spoons, cups, counts) rather than a decimal. */
  fraction: boolean;
  /** How it's written after a number: [one, many]. */
  label: [string, string];
}

const U = (id: string, dim: Dimension, base: number, system: UnitDef["system"], fraction: boolean, one: string, many = one): UnitDef => ({ id, dim, base, system, fraction, label: [one, many] });

export const UNITS: Record<string, UnitDef> = {
  g: U("g", "mass", 1, "metric", false, "g"),
  kg: U("kg", "mass", 1000, "metric", false, "kg"),
  oz: U("oz", "mass", 28.3495, "imperial", true, "oz"),
  lb: U("lb", "mass", 453.592, "imperial", true, "lb"),
  ml: U("ml", "volume", 1, "metric", false, "ml"),
  l: U("l", "volume", 1000, "metric", false, "l"),
  tsp: U("tsp", "volume", 5, "both", true, "tsp"),
  tbsp: U("tbsp", "volume", 15, "both", true, "tbsp"),
  cup: U("cup", "volume", 240, "imperial", true, "cup", "cups"),
  floz: U("floz", "volume", 29.5735, "imperial", true, "fl oz"),
  pint: U("pint", "volume", 568, "imperial", true, "pint", "pints"),
  // Counted things: only ever summed with the same unit.
  clove: U("clove", "count", 1, "both", true, "clove", "cloves"),
  can: U("can", "count", 1, "both", true, "can", "cans"),
  pack: U("pack", "count", 1, "both", true, "pack", "packs"),
  bunch: U("bunch", "count", 1, "both", true, "bunch", "bunches"),
  sprig: U("sprig", "count", 1, "both", true, "sprig", "sprigs"),
  slice: U("slice", "count", 1, "both", true, "slice", "slices"),
  rasher: U("rasher", "count", 1, "both", true, "rasher", "rashers"),
  stick: U("stick", "count", 1, "both", true, "stick", "sticks"),
  pinch: U("pinch", "count", 1, "both", true, "pinch", "pinches"),
  handful: U("handful", "count", 1, "both", true, "handful", "handfuls"),
  sheet: U("sheet", "count", 1, "both", true, "sheet", "sheets"),
};

/** Words for each unit, lower case, without a trailing full stop. */
const ALIASES: Record<string, string> = {
  g: "g", gr: "g", gram: "g", grams: "g", gramme: "g", grammes: "g",
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg", kilogramme: "kg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml", mls: "ml",
  l: "l", litre: "l", litres: "l", liter: "l", liters: "l", ltr: "l",
  tsp: "tsp", tsps: "tsp", teaspoon: "tsp", teaspoons: "tsp", t: "tsp",
  tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", T: "tbsp",
  cup: "cup", cups: "cup", c: "cup",
  "fl oz": "floz", "fl. oz": "floz", floz: "floz", "fluid ounce": "floz", "fluid ounces": "floz",
  pint: "pint", pints: "pint", pt: "pint",
  clove: "clove", cloves: "clove",
  can: "can", cans: "can", tin: "can", tins: "can",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack", pkg: "pack",
  bunch: "bunch", bunches: "bunch",
  sprig: "sprig", sprigs: "sprig",
  slice: "slice", slices: "slice",
  rasher: "rasher", rashers: "rasher",
  stick: "stick", sticks: "stick",
  pinch: "pinch", pinches: "pinch",
  handful: "handful", handfuls: "handful",
  sheet: "sheet", sheets: "sheet",
};

/** A unit word as Athena's unit id, or null. "T" is a tablespoon and "t" a teaspoon, as cookbooks write them. */
export function unitOf(word: string | null | undefined): string | null {
  if (!word) return null;
  const w = word.trim().replace(/\.$/, "");
  if (w === "T" || w === "Tbsp" || w === "Tbs") return "tbsp";
  return ALIASES[w.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

// ---------- numbers ----------

const VULGAR: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const VULGAR_CLASS = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5, dozen: 12 };

/** One number as written: "2", "1.5", "1,5", "3/4", "1 1/2", "1½", "½", "1 ½". NaN when it isn't one. */
export function parseNumber(raw: string): number {
  const s = raw.trim().replace(/⁄/g, "/");
  let m = new RegExp(`^(\\d+)?\\s*([${VULGAR_CLASS}])$`).exec(s);
  if (m) return (m[1] ? Number(m[1]) : 0) + VULGAR[m[2]];
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : NaN;
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
  m = /^\d+(?:[.,]\d+)?$/.exec(s);
  if (m) return Number(s.replace(",", "."));
  const w = WORDS[s.toLowerCase()];
  return w ?? NaN;
}

const NUM = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\s?[${VULGAR_CLASS}]|\\d+(?:[.,]\\d+)?)`;
const NUM_RE = new RegExp(`^(${NUM})`);

// ---------- ingredient lines ----------

export interface Ingredient {
  /** null: "a squeeze of lemon", "salt to taste". */
  quantity: number | null;
  /** The top of a range ("3 or 4 bananas", "2-3 cloves"). */
  quantity_max?: number | null;
  /** A unit id from UNITS, or null for a plain count ("2 onions"). */
  unit: string | null;
  item: string;
  /** What's left: "finely chopped", "or 2 tbsp dried". */
  note: string | null;
  /** The step section it belongs to ("For the sauce"), when the recipe groups them. */
  group?: string | null;
}

const PREP = "halved|quartered|sliced|chopped|diced|minced|grated|crushed|peeled|cubed|torn|shredded|trimmed|drained|rinsed|beaten|softened|melted|deseeded|deveined|zested|juiced";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Notes written as a site's own markers: "(Note 1)", "((Note 2))". */
const NOTE_REF = /\(\s*note\s*\d+\s*\)/gi;

/**
 * One ingredient line, read: "2 tbsp plain flour, sifted" →
 * { quantity: 2, unit: "tbsp", item: "plain flour", note: "sifted" }.
 * A second measure ("30g / 2 tbsp butter", "6 oz. (170 g) chocolate") is
 * dropped from the item and the first one kept; brackets go to the note.
 */
export function parseIngredient(raw: string): Ingredient {
  let s = squash(raw.replace(NOTE_REF, "").replace(/ /g, " "));
  let quantity: number | null = null;
  let max: number | null = null;
  let unit: string | null = null;
  const notes: string[] = [];

  const take = (): number | null => {
    const m = NUM_RE.exec(s);
    if (!m || !m[1].trim()) return null;
    const n = parseNumber(m[1]);
    if (!Number.isFinite(n)) return null;
    s = s.slice(m[0].length).trimStart();
    return n;
  };

  quantity = take();
  let article = false;
  if (quantity === null) {
    // "a pinch of salt", "one onion", "half a lemon"
    const w = /^(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|half|a dozen)\b\s*/i.exec(s);
    if (w) {
      quantity = w[1].toLowerCase() === "a dozen" ? 12 : WORDS[w[1].toLowerCase()];
      article = /^an?$/i.test(w[1]);
      s = s.slice(w[0].length);
      if (w[1].toLowerCase() === "half") s = s.replace(/^an?\s+/i, "");
    }
  }
  if (quantity !== null) {
    // A range: "2-3", "2 – 3", "3 or 4", "2 to 3"
    const r = new RegExp(`^(?:-|–|—|to|or)\\s*(${NUM})(?![\\d/])`, "i").exec(s);
    if (r) {
      const n = parseNumber(r[1]);
      if (Number.isFinite(n) && n > quantity) max = n;
      s = s.slice(r[0].length).trimStart();
    }
    // "x 400g can", "2 x 400g tins": the count times a pack size.
    const pack = new RegExp(`^x\\s*(${NUM})\\s*(g|kg|ml|l|oz)\\b\\s*`, "i").exec(s);
    if (pack) {
      const size = parseNumber(pack[1]);
      const u = unitOf(pack[2])!;
      notes.push(`${pack[1]}${pack[2]} each`);
      s = s.slice(pack[0].length);
      if (Number.isFinite(size)) {
        quantity = quantity * size;
        max = max !== null ? max * size : null;
        unit = u;
      }
      s = s.replace(/^(?:tins?|cans?|packs?|packets?|jars?|cartons?)\s+(?:of\s+)?/i, "");
    }
  }
  if (!unit) {
    const u = /^(fl\.?\s?oz|fluid ounces?|[A-Za-z]+)\.?(?=[\s,()/]|$)/.exec(s);
    const id = u ? unitOf(u[1]) : null;
    // A lone "t", "c" or "l" only counts as a unit straight after a number.
    if (u && id && (quantity !== null || u[1].length > 1)) {
      unit = id;
      s = s.slice(u[0].length).trimStart();
    } else if (quantity === null || article) {
      // "squeeze of lemon juice", "a knob of butter": no amount to shop for
      const lead = /^(squeeze|dash|drizzle|knob|splash|sprinkle|glug)\s+(?:of\s+)?/i.exec(s);
      if (lead) {
        quantity = null;
        notes.push(lead[1].toLowerCase());
        s = s.slice(lead[0].length);
      }
    }
  }
  s = s.replace(/^of\s+/i, "");
  // A second measure straight after the first: "/ 2 tbsp", "(200 g)", "(1½ sticks; 169 g)".
  s = s.replace(new RegExp(`^\\/\\s*${NUM}\\s*[A-Za-z.]*\\s*`), "");
  s = s.replace(/^\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*/, (_, inner: string) => {
    if (!new RegExp(`^${NUM}`).test(inner.trim())) notes.push(squash(inner));
    return "";
  });
  s = s.replace(/^(?:plus|\+)\s+\d[^,(]*?(?=\s\(|,|$)/i, (m) => {
    notes.push(m.trim());
    return "";
  }).trimStart();
  s = s.replace(/^\([^)]*\)\s*/, "");

  // Brackets anywhere else are notes; then the first comma ends the item.
  const brackets: string[] = [];
  let depth = 0;
  let item = "";
  let buf = "";
  for (const ch of s) {
    if (ch === "(") {
      if (depth++ === 0) {
        buf = "";
        continue;
      }
    } else if (ch === ")" && depth > 0) {
      if (--depth === 0) {
        const b = squash(buf.replace(/^[,;\s]+|[,;\s]+$/g, "")).replace(/^\((.*)\)$/, "$1").trim();
        if (b) brackets.push(b);
        continue;
      }
    }
    if (depth > 0) buf += ch;
    else item += ch;
  }
  item = squash(item);
  const comma = item.search(/,|;|\s[-–—]\s/);
  if (comma > 0) {
    const rest = squash(item.slice(comma + 1).replace(/^[-–—]\s*/, ""));
    if (rest) notes.push(rest);
    item = item.slice(0, comma).trim();
  }
  // "cooking salt / kosher salt": the first, with the other as a note.
  const alt = /\s+\/\s+(.+)$/.exec(item);
  if (alt) {
    notes.push(`or ${alt[1]}`);
    item = item.slice(0, alt.index).trim();
  }
  // "salt and pepper, to taste" keeps "to taste" as the note.
  const taste = /\s+(to taste|to serve|for frying|for greasing|optional)$/i.exec(item);
  if (taste) {
    notes.push(taste[1].toLowerCase());
    item = item.slice(0, taste.index).trim();
  }
  // Prep words with no comma before them: "1 onion halved", "2 leeks thinly sliced".
  const prep = new RegExp(`\\s+((?:(?:thinly|finely|roughly|coarsely)\\s+)?(?:${PREP}))\\b(.*)$`, "i").exec(item);
  if (prep && prep.index > 0) {
    notes.unshift(squash(prep[1] + prep[2]));
    item = item.slice(0, prep.index).trim();
  }
  // A counted thing named after what it's counted in: "3 garlic cloves", "6 bacon rashers".
  if (!unit && quantity !== null) {
    const last = /\s(cloves?|sprigs?|rashers?|slices?|sticks?|sheets?)$/i.exec(item);
    if (last) {
      unit = unitOf(last[1]);
      item = item.slice(0, last.index).trim();
    }
  }
  notes.push(...brackets);
  const note = squash(notes.filter(Boolean).join("; ").replace(/\(\s*\)/g, ""));
  return { quantity, quantity_max: max, unit, item: item || squash(raw), note: note || null };
}

// ---------- the same thing, by name ----------

const DROP = new Set(["large", "medium", "small", "big", "fresh", "freshly", "ripe", "chopped", "finely", "roughly", "thinly", "sliced", "diced", "minced", "grated", "crushed", "beaten", "softened", "melted", "cold", "warm", "whole", "boneless", "skinless", "organic", "free-range", "free", "range", "good", "quality", "good-quality", "heaped", "level", "halved", "packed", "extra", "plump", "unwaxed", "peeled", "trimmed", "bought", "shop-bought", "homemade", "home-made", "dried", "of"]);
const PLURAL_KEEP = new Set(["asparagus", "couscous", "hummus", "molasses", "swiss", "brussels", "lemongrass", "grass", "chickpeas", "peas", "oats", "greens", "lentils", "noodles", "anchovies", "chives", "herbs", "leaves", "spices", "sprouts"]);

function singular(w: string): string {
  if (w.length < 4 || PLURAL_KEEP.has(w) || w.endsWith("ss") || w.endsWith("us")) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(tomato|potato|mango)es$/.test(w)) return w.slice(0, -2);
  if (/(ch|sh|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ves") && !w.endsWith("olives") && !w.endsWith("chives")) return `${w.slice(0, -3)}f`;
  if (w.endsWith("s") && !w.endsWith("'s")) return w.slice(0, -1);
  return w;
}

/**
 * The name two recipes would share for one thing: "2 large leeks" and
 * "1 leek, sliced" are both "leek"; "garlic cloves" is "garlic". Lower case,
 * size and prep words off, the last word singular.
 */
export function itemKey(item: string): string {
  const words = item
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}'&\-\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !DROP.has(w));
  if (words.at(-1) === "clove" || words.at(-1) === "cloves") words.pop();
  while (words.length > 1 && (words[0] === "or" || words[0] === "and")) words.shift();
  if (!words.length) return item.toLowerCase().trim();
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(" ").replace(/\s+or\s+.*$/, "");
}

// ---------- scaling and systems ----------

export interface Amount {
  quantity: number;
  unit: string | null;
}

/** An amount in another system: grams to ounces and pounds, cups to millilitres. Spoons and counts stay as they are. */
export function toSystem(a: Amount, system: UnitSystem): Amount {
  const def = a.unit ? UNITS[a.unit] : null;
  if (!def || def.dim === "count" || def.system === "both" || def.system === system) return a;
  return bestUnit(a.quantity * def.base, def.dim, system);
}

/** A base amount (grams or millilitres) in the unit a cook would use. */
export function bestUnit(base: number, dim: Exclude<Dimension, "count">, system: UnitSystem): Amount {
  if (dim === "mass") {
    if (system === "metric") return base >= 1000 ? { quantity: base / 1000, unit: "kg" } : { quantity: base, unit: "g" };
    const oz = base / UNITS.oz.base;
    return oz >= 16 ? { quantity: base / UNITS.lb.base, unit: "lb" } : { quantity: oz, unit: "oz" };
  }
  if (system === "metric") return base >= 1000 ? { quantity: base / 1000, unit: "l" } : { quantity: base, unit: "ml" };
  if (base < 15) return { quantity: base / UNITS.tsp.base, unit: "tsp" };
  if (base < 60) return { quantity: base / UNITS.tbsp.base, unit: "tbsp" };
  return { quantity: base / UNITS.cup.base, unit: "cup" };
}

/** One ingredient at a new size and in a system: quantities times factor. */
export function scaleIngredient(ing: Ingredient, factor: number, system: UnitSystem | null = null): Ingredient {
  if (ing.quantity === null) return ing;
  const q = ing.quantity * factor;
  const max = ing.quantity_max ? ing.quantity_max * factor : null;
  let unit = ing.unit;
  let quantity = q;
  let quantity_max = max;
  if (system) {
    const to = toSystem({ quantity: q, unit }, system);
    if (to.unit !== unit && unit) {
      const ratio = to.quantity / q;
      quantity_max = max !== null ? max * ratio : null;
      ({ quantity, unit } = to);
    }
  }
  // Metric amounts step up past 1000 (1500 g is 1.5 kg) and back down under 1 (0.75 kg is 750 g).
  const step = (to: string, by: number) => {
    quantity *= by;
    quantity_max = quantity_max !== null ? quantity_max * by : null;
    unit = to;
  };
  if (unit === "g" && quantity >= 1000) step("kg", 1 / 1000);
  else if (unit === "ml" && quantity >= 1000) step("l", 1 / 1000);
  else if (unit === "kg" && quantity < 1) step("g", 1000);
  else if (unit === "l" && quantity < 1) step("ml", 1000);
  return { ...ing, quantity, quantity_max, unit };
}

// ---------- writing ----------

const FRACTIONS: Array<[number, string]> = [
  [0, ""], [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"], [1, ""],
];

/** A number for a cook: fractions for spoons, cups and counts ("1 ½"), round numbers for grams and millilitres. */
export function formatQuantity(n: number, unit: string | null): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const def = unit ? UNITS[unit] : null;
  const fraction = def ? def.fraction : true;
  if (!fraction) {
    // g and ml: whole numbers, and to the nearest 5 or 10 once they're big; kg and l to one or two places.
    if (unit === "kg" || unit === "l") return String(Math.round(n * 100) / 100);
    if (n >= 500) return String(Math.round(n / 10) * 10);
    if (n >= 100) return String(Math.round(n / 5) * 5);
    if (n >= 10) return String(Math.round(n));
    return String(Math.round(n * 10) / 10);
  }
  if (n >= 10) return String(Math.round(n));
  // Things you count (2 onions, 3 sprigs) don't come in thirds: whole from 2 up, halves below.
  if (!def || def.dim === "count") {
    if (n >= 2) return String(Math.round(n));
    const half = Math.max(0.5, Math.round(n * 2) / 2);
    return half === 0.5 ? "½" : half === 1.5 ? "1 ½" : String(half);
  }
  const whole = Math.floor(n);
  const rest = n - whole;
  let best = FRACTIONS[0];
  for (const f of FRACTIONS) if (Math.abs(f[0] - rest) < Math.abs(best[0] - rest)) best = f;
  const w = best[0] === 1 ? whole + 1 : whole;
  if (!w && !best[1]) return fraction && n > 0 ? "⅛" : "0";
  return w && best[1] ? `${w} ${best[1]}` : w ? String(w) : best[1];
}

/** A unit after a number: "g", "tbsp", "cups", "cloves". */
export function unitLabel(unit: string | null, quantity: number | null): string {
  if (!unit) return "";
  const def = UNITS[unit];
  if (!def) return unit;
  return quantity !== null && quantity > 1 ? def.label[1] : def.label[0];
}

/** "1 ½ tbsp", "450 g", "2–3 cloves", "" for no quantity. Grams and millilitres sit close: "450g". */
export function formatAmount(ing: Pick<Ingredient, "quantity" | "quantity_max" | "unit">): string {
  if (ing.quantity === null) return "";
  const q = formatQuantity(ing.quantity, ing.unit);
  const max = ing.quantity_max ? formatQuantity(ing.quantity_max, ing.unit) : "";
  const num = max && max !== q ? `${q}–${max}` : q;
  const label = unitLabel(ing.unit, ing.quantity_max ?? ing.quantity);
  if (!label) return num;
  return ["g", "kg", "ml", "l"].includes(ing.unit!) ? `${num}${label}` : `${num} ${label}`;
}

/** The item worded for its amount: "1 leek", not "1 leeks", once a recipe for four is cooked for one. Plain counts only. */
export function itemFor(ing: Pick<Ingredient, "item" | "quantity" | "quantity_max" | "unit">): string {
  if (ing.unit || ing.quantity === null || ing.quantity > 1 || (ing.quantity_max ?? 0) > 1) return ing.item;
  const words = ing.item.split(" ");
  const last = words[words.length - 1];
  const one = last.toLowerCase() === "leaves" ? "leaf" : singular(last.toLowerCase());
  if (one === last.toLowerCase()) return ing.item;
  words[words.length - 1] = last[0] === last[0].toUpperCase() ? one[0].toUpperCase() + one.slice(1) : one;
  return words.join(" ");
}

/** The whole line again, for a list or a copy: "2 tbsp plain flour (sifted)". */
export function formatIngredient(ing: Ingredient): string {
  const amount = formatAmount(ing);
  return [amount, itemFor(ing)].filter(Boolean).join(" ") + (ing.note ? `, ${ing.note}` : "");
}

/** How many it serves, from a recipe's yield: 6, ["4"], "Makes 16", "1 loaf, 10 serving(s)", "Serves 4-6". */
export function servingsOf(raw: unknown): number | null {
  const one = Array.isArray(raw) ? raw.find((v) => /\d/.test(String(v))) : raw;
  if (typeof one === "number") return one > 0 && one < 200 ? Math.round(one) : null;
  if (typeof one !== "string") return null;
  const s = one.toLowerCase();
  const serving = /(\d+)\s*(?:-\s*\d+\s*)?(?:serving|portion|people|person)/.exec(s) ?? /serves\s*(\d+)/.exec(s);
  const n = Number((serving ?? /(\d+)/.exec(s))?.[1]);
  return n > 0 && n < 200 ? n : null;
}
