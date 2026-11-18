/**
 * Reading a recipe from its page (Recipes, migration 0053), without a model:
 * the page's schema.org Recipe in JSON-LD first, then in microdata. Most
 * recipe sites publish one or the other so search engines can show them,
 * which is why this costs no credits. When neither is there, lib/recipes.ts
 * offers "Try harder" (the model reads the page's text), and only when the
 * owner taps it.
 *
 * No network here: it takes the HTML lib/saved-fetch.ts already fetched.
 */
import { parseHTML } from "linkedom";
import { jsonLdNodes } from "./saved-kinds";
import { parseIngredient, servingsOf } from "./recipe-units";
import { cleanRecipeTags, MAX_INGREDIENTS, MAX_RECIPE_TITLE, MAX_STEP_TEXT, MAX_STEPS, type RecipeDraft, type RecipeParse, type RecipeStep } from "./recipe-rules";

type Node = Record<string, unknown>;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Text as a person reads it: tags off, entities decoded (&ordm;, &frac12;, &#8217;…), spaces squashed. */
export function plainText(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const s = String(raw);
  if (!/[<&]/.test(s)) return squash(s);
  const { document } = parseHTML(`<!doctype html><html><body>${s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n")}</body></html>`);
  // Decoding can reveal escaped tags (&lt;p&gt;): strip once more.
  return squash((document.body.textContent ?? "").replace(/<[^>]+>/g, " "));
}

/**
 * Minutes from a schema.org duration ("PT1H10M", "P0DT0H40M", "PT90M") or
 * plain words ("40 minutes", "1 hr 15 mins", "1 hour"). Null when there's none.
 */
export function durationMinutes(raw: unknown): number | null {
  if (typeof raw === "number") return raw > 0 && raw < 10_000 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const n = Number(iso[1] ?? 0) * 1440 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0) + Number(iso[4] ?? 0) / 60;
    return n > 0 && n < 10_000 ? Math.round(n) : null;
  }
  const h = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i.exec(s);
  const m = /(\d+)\s*(?:minutes?|mins?|m)\b/i.exec(s);
  if (!h && !m) return null;
  const n = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return n > 0 && n < 10_000 ? Math.round(n) : null;
}

const isRecipe = (n: Node) => {
  const t = n["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
};

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** An image as an address: a string, an ImageObject, or a list of either. */
function imageOf(raw: unknown, base: string): string | null {
  const v = first(raw);
  const url = typeof v === "string" ? v : v && typeof v === "object" ? ((v as Node).url ?? (v as Node).contentUrl) : null;
  return typeof url === "string" ? absolute(url, base) : null;
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A person or organisation's name: a string, a Person, a list, or an @id pointing elsewhere in the graph. */
function nameOf(raw: unknown, byId: Map<string, Node>): string | null {
  const v = first(raw);
  if (typeof v === "string") return plainText(v) || null;
  if (v && typeof v === "object") {
    const n = v as Node;
    const target = typeof n["@id"] === "string" && !n.name ? byId.get(n["@id"] as string) : n;
    const name = target?.name;
    return typeof name === "string" ? plainText(name) || null : null;
  }
  return null;
}

/** One paragraph of method, split into steps the way a cook reads them: by line, else by sentence once it's long. */
export function splitMethod(text: string): string[] {
  const lines = text
    .split(/\n+|\r+/)
    .map((l) => squash(l.replace(/^\s*(?:step\s*)?\d+[.):]\s+/i, "")))
    .filter(Boolean);
  if (lines.length > 1) return lines;
  const one = lines[0] ?? "";
  if (one.length < 220) return one ? [one] : [];
  // Sentences, kept whole: "Preheat to 180°C. Mix the flour…" (not after "approx." or "e.g.").
  return one
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(squash)
    .filter(Boolean);
}

/** recipeInstructions in any of its shapes: a string, HowToStep and HowToSection lists, plain lists. */
function stepsOf(raw: unknown, section: string | null = null): RecipeStep[] {
  if (typeof raw === "string") {
    // A string with list markup keeps one step per item; plain text splits by line or sentence.
    const withBreaks = raw.replace(/<\/li>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
    return splitMethod(plainTextKeepLines(withBreaks)).map((text) => ({ text, section }));
  }
  if (Array.isArray(raw)) return raw.flatMap((v) => stepsOf(v, section));
  if (raw && typeof raw === "object") {
    const n = raw as Node;
    const type = n["@type"];
    if (type === "HowToSection" || (Array.isArray(type) && type.includes("HowToSection"))) {
      const name = typeof n.name === "string" ? plainText(n.name) || null : null;
      return stepsOf(n.itemListElement ?? n.steps ?? [], name);
    }
    if (n.itemListElement) return stepsOf(n.itemListElement, section);
    const text = plainText(n.text ?? n.name ?? n.description ?? "");
    return text ? [{ text, section }] : [];
  }
  return [];
}

/** Some sites put a short version of the method first, as its own section ("Abbreviated Recipe"): the full one is enough. */
function withoutSummary(steps: RecipeStep[]): RecipeStep[] {
  const summary = /\b(abbreviated|short(?:er)? version|summary|at a glance|quick version)\b/i;
  const rest = steps.filter((s) => !(s.section && summary.test(s.section)));
  return rest.length ? rest : steps;
}

function plainTextKeepLines(s: string): string {
  return s
    .split("\n")
    .map((l) => plainText(l))
    .join("\n");
}

function tagsOf(...raws: unknown[]): string[] {
  const words: string[] = [];
  for (const raw of raws) {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    for (const w of list) if (typeof w === "string") words.push(plainText(w));
  }
  // Site furniture isn't a tag: "web", "Good Food", "< 4 Hours".
  return cleanRecipeTags(words.filter((w) => w && w.length <= 24 && !/\d/.test(w) && !/^(web|good food|recipe|recipes|food)$/i.test(w))).slice(0, 8);
}

/** The page's own address for itself: rel=canonical, else og:url, else where it was read from. */
export function canonicalUrl(html: string, pageUrl: string): string {
  const link = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html)?.[0];
  const og = /<meta\b[^>]*property\s*=\s*["']og:url["'][^>]*>/i.exec(html)?.[0];
  const href = (link && /href\s*=\s*["']([^"']+)["']/i.exec(link)?.[1]) || (og && /content\s*=\s*["']([^"']+)["']/i.exec(og)?.[1]) || null;
  const abs = href ? absolute(href.replace(/&amp;/g, "&"), pageUrl) : null;
  return abs ?? pageUrl;
}

function draftFrom(fields: {
  name: unknown;
  image: unknown;
  author: unknown;
  description: unknown;
  yield: unknown;
  prep: unknown;
  cook: unknown;
  total: unknown;
  ingredients: unknown[];
  steps: RecipeStep[];
  tags: string[];
  url: string;
  base: string;
  byId?: Map<string, Node>;
}): RecipeDraft | null {
  const title = clip(plainText(first(fields.name)), MAX_RECIPE_TITLE);
  const lines = fields.ingredients.map((l) => plainText(l)).filter(Boolean);
  if (!title || (!lines.length && !fields.steps.length)) return null;
  const yieldRaw = first(Array.isArray(fields.yield) ? fields.yield.find((y) => /\D/.test(String(y))) ?? fields.yield : fields.yield);
  const yieldText = typeof yieldRaw === "string" && /\D/.test(yieldRaw) ? plainText(yieldRaw) : null;
  const prep = durationMinutes(first(fields.prep));
  const cook = durationMinutes(first(fields.cook));
  const total = durationMinutes(first(fields.total)) ?? (prep || cook ? (prep ?? 0) + (cook ?? 0) : null);
  return {
    title,
    url: fields.url,
    photo: imageOf(fields.image, fields.base),
    by: nameOf(fields.author, fields.byId ?? new Map()),
    description: plainText(first(fields.description)) || null,
    servings: servingsOf(fields.yield),
    yield_text: yieldText,
    prep_minutes: prep,
    cook_minutes: cook,
    total_minutes: total,
    ingredients: lines.slice(0, MAX_INGREDIENTS).map(parseIngredient),
    steps: fields.steps.slice(0, MAX_STEPS).map((s) => ({ ...s, text: clip(s.text, MAX_STEP_TEXT) })),
    tags: fields.tags,
  };
}

/** The page's Recipe in JSON-LD (a @graph, a list, or a lone block), or null. */
export function recipeFromJsonLd(html: string, pageUrl: string): RecipeDraft | null {
  const nodes = jsonLdNodes(html);
  const byId = new Map<string, Node>();
  for (const n of nodes) if (typeof n["@id"] === "string") byId.set(n["@id"] as string, n);
  const r = nodes.find(isRecipe);
  if (!r) return null;
  const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : Array.isArray(r.ingredients) ? r.ingredients : typeof r.recipeIngredient === "string" ? [r.recipeIngredient] : []) as unknown[];
  return draftFrom({
    name: r.name ?? r.headline,
    image: r.image ?? r.thumbnailUrl,
    author: r.author,
    description: r.description,
    yield: r.recipeYield ?? r.yield,
    prep: r.prepTime,
    cook: r.cookTime,
    total: r.totalTime,
    ingredients,
    steps: withoutSummary(stepsOf(r.recipeInstructions)),
    tags: tagsOf(r.recipeCategory, r.recipeCuisine, r.keywords),
    url: canonicalUrl(html, pageUrl),
    base: pageUrl,
    byId,
  });
}

/**
 * The page's Recipe in microdata (itemscope itemtype=schema.org/Recipe, or
 * the older data-vocabulary.org/Recipe), or null. Each itemprop belongs to
 * its nearest itemscope, so a nested PropertyValue or NutritionInformation
 * doesn't leak its name into the recipe's.
 */
export function recipeFromMicrodata(html: string, pageUrl: string): RecipeDraft | null {
  if (!/itemtype\s*=\s*["']?https?:\/\/(?:www\.)?(?:schema|data-vocabulary)\.org\/Recipe/i.test(html)) return null;
  const { document } = parseHTML(html);
  const scope = Array.from(document.querySelectorAll("[itemscope][itemtype]") as ArrayLike<Element>).find((el) => /(?:schema|data-vocabulary)\.org\/Recipe\b/i.test(el.getAttribute("itemtype") ?? ""));
  if (!scope) return null;
  type El = (typeof scope);
  const owner = (el: El): El | null => {
    let p = el.parentElement as El | null;
    while (p && !p.hasAttribute("itemscope")) p = p.parentElement as El | null;
    return p;
  };
  const props = new Map<string, El[]>();
  for (const el of Array.from(scope.querySelectorAll("[itemprop]") as ArrayLike<Element>)) {
    if (owner(el as El) !== scope) continue;
    for (const name of (el.getAttribute("itemprop") ?? "").split(/\s+/)) {
      if (!name) continue;
      props.set(name, [...(props.get(name) ?? []), el as El]);
    }
  }
  const value = (el: El): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === "meta") return el.getAttribute("content") ?? "";
    if (tag === "img" || tag === "source") return el.getAttribute("src") ?? "";
    if (tag === "a" || tag === "link") return el.getAttribute("href") ?? "";
    if (tag === "time") return el.getAttribute("datetime") ?? el.textContent ?? "";
    return el.getAttribute("content") ?? el.textContent ?? "";
  };
  const one = (...names: string[]) => {
    for (const n of names) {
      const el = props.get(n)?.[0];
      if (el) return value(el);
    }
    return undefined;
  };
  const all = (...names: string[]) => names.flatMap((n) => (props.get(n) ?? []).map(value));
  const stepEls = props.get("recipeInstructions") ?? props.get("instructions") ?? [];
  const steps: RecipeStep[] = stepEls.flatMap((el) => {
    const items = Array.from(el.querySelectorAll("li") as ArrayLike<Element>);
    if (items.length) return items.map((li) => ({ text: squash(li.textContent ?? ""), section: null })).filter((s) => s.text);
    // Microdata text is wrapped as the page's source was: one paragraph, split by sentence when long.
    return splitMethod(squash(el.textContent ?? "")).map((text) => ({ text, section: null }));
  });
  return draftFrom({
    name: one("name"),
    image: one("image", "photo"),
    author: one("author"),
    description: one("description", "summary"),
    yield: one("recipeYield", "yield"),
    prep: one("prepTime"),
    cook: one("cookTime"),
    total: one("totalTime"),
    ingredients: all("recipeIngredient", "ingredients"),
    steps,
    tags: tagsOf(all("recipeCategory"), all("recipeCuisine"), one("keywords")),
    url: canonicalUrl(html, pageUrl),
    base: pageUrl,
  });
}

/** JSON-LD first, then microdata. Null when the page has neither. */
export function parseRecipePage(html: string, pageUrl: string): { draft: RecipeDraft; parse: RecipeParse } | null {
  const ld = recipeFromJsonLd(html, pageUrl);
  if (ld) return { draft: ld, parse: "json-ld" };
  const md = recipeFromMicrodata(html, pageUrl);
  return md ? { draft: md, parse: "microdata" } : null;
}
