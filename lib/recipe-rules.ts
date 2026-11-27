/**
 * Recipes' shapes (migration 0053), shared
 * by the server (lib/recipes.ts), the API, Ask's tools and the app.
 */
import type { Ingredient, UnitSystem } from "./recipe-units";
import type { Usual } from "./grocery-usuals";

export type { Ingredient, UnitSystem };

export interface RecipeStep {
  text: string;
  /** The section it's under ("For the sauce"), when the recipe has sections. */
  section?: string | null;
}

/** How a recipe got here: read from the page's schema.org data, by the model ("Try harder"), typed in, or a sample. */
export type RecipeParse = "json-ld" | "microdata" | "model" | "manual";

/** A recipe as read from a page (or typed in), before it's stored. */
export interface RecipeDraft {
  title: string;
  /** The page's own address for itself (its canonical link), else the address it was read from. */
  url: string | null;
  /** The page's photo, by address; stored through Saved (its sealed image), never hot-linked by the app. */
  photo: string | null;
  by: string | null;
  description: string | null;
  servings: number | null;
  /** The yield as written ("Makes 16", "1 loaf"). */
  yield_text: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  total_minutes: number | null;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  tags: string[];
}

export interface CookedLog {
  /** YYYY-MM-DD, the owner's day. */
  on: string;
}

export interface Recipe extends RecipeDraft {
  id: string;
  notes: string;
  parse: RecipeParse;
  /** The Saved item this came from, kept as the pointer to the page. */
  saved_id: string | null;
  /** The photo as the app loads it (/api/saved/:id/image), or a sample's own. */
  photo_url: string | null;
  /** Newest first. */
  cooked: CookedLog[];
  created_at: string;
  updated_at: string;
  archived: boolean;
}

/** What the grid shows. */
export type RecipeCard = Pick<Recipe, "id" | "title" | "photo_url" | "total_minutes" | "tags" | "servings" | "parse"> & { last_cooked: string | null; ingredient_count: number };

export const MAX_RECIPE_TITLE = 200;
export const MAX_INGREDIENTS = 80;
export const MAX_STEPS = 60;
export const MAX_STEP_TEXT = 2000;
export const MAX_RECIPE_NOTES = 10_000;
export const MAX_TAGS = 12;

/** A recipe's minutes for filters and the week plan: total, else prep plus cook. */
export function minutesOf(r: Pick<RecipeDraft, "total_minutes" | "prep_minutes" | "cook_minutes">): number | null {
  if (r.total_minutes) return r.total_minutes;
  const sum = (r.prep_minutes ?? 0) + (r.cook_minutes ?? 0);
  return sum || null;
}

/** "45 min", "1 hr 15 min", "2 hr". */
export function minutesLabel(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return h ? (m ? `${h} hr ${m} min` : `${h} hr`) : `${m} min`;
}

/** Tags as kept: lower case, short, no duplicates, at most MAX_TAGS. */
export function cleanRecipeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const tag = t.replace(/\s+/g, " ").trim().toLowerCase();
    if (!tag || tag.length > 30 || /[<>{}]|https?:/.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Quick enough for a busy evening. */
export const QUICK_MINUTES = 30;

export type TimeFilter = "quick" | "under-hour" | "longer";
export function matchesTime(minutes: number | null, f: TimeFilter | null): boolean {
  if (!f) return true;
  if (f === "quick") return minutes !== null && minutes <= QUICK_MINUTES;
  if (f === "under-hour") return minutes !== null && minutes <= 60;
  return minutes === null || minutes > 60;
}

/** Recipe settings (Settings → Recipes): what stays off the grocery list, and the units shown. */
export interface RecipePrefs {
  pantry: string[];
  system: UnitSystem;
  /** Offer the usuals that are due at the top of the grocery list (lib/grocery-memory.ts). On unless turned off. */
  usuals: boolean;
}

/**
 * Which Saved items become recipes (Saved → Recipes): recipe links that are
 * live and have an address, and that no recipe already points at, kept or
 * archived. Running it again after a move finds nothing, and a run that
 * stopped half way picks up the rest.
 */
export function savedToMigrate(saved: Array<{ id: string; thing: string | null; url: string | null; archived: boolean }>, recipes: Array<{ saved_id: string | null }>): string[] {
  const done = new Set(recipes.map((r) => r.saved_id).filter(Boolean));
  return saved.filter((s) => s.thing === "recipe" && !s.archived && !!s.url && !done.has(s.id)).map((s) => s.id);
}

// ---------- the API's shapes ----------

/** One line on the grocery list. */
export interface GroceryItem {
  id: string;
  item: string;
  quantity: number | null;
  unit: string | null;
  /** An aisle id from lib/grocery.ts. */
  aisle: string;
  /** The recipes it's for; empty for the owner's own lines. */
  recipes: Array<{ id: string; title: string }>;
  /** Added by the owner, not from a recipe. */
  own: boolean;
  ticked: boolean;
}

export interface GroceryList {
  items: GroceryItem[];
  /** Usuals due now, from past shops (lib/grocery-usuals.ts). Absent on an older copy. */
  usuals?: Usual[];
  /** The aisles in the order the owner walks their shop, once learned; null until then. */
  order?: string[] | null;
}

/** One evening of the week plan. */
export interface PlanDay {
  date: string;
  recipe_id: string | null;
  /** Cook it for this many; null = the recipe's own servings. */
  servings: number | null;
  /** Why this one, in words ("Quick: Book club at 19:00"). */
  reason: string;
  evening: { kind: "free" | "late" | "travel" | "away" | "normal"; why: string | null };
  /** Athena's suggestion, not yet kept by the owner. */
  suggested: boolean;
}

export interface WeekPlan {
  /** The Monday. */
  week: string;
  days: PlanDay[];
  /** The calendar accounts that couldn't be read for it, by name. */
  unread: string[];
}

/** What POST /api/recipes/import answers when the page has no recipe Athena can read without the model. */
export interface ImportMiss {
  error: string;
  code: "no_recipe" | "unreachable" | "model_failed" | "no_model";
  /** The Saved item the link was kept as, when it was. */
  saved_id: string | null;
  /** Can "Try harder" (the model) be offered? */
  harder: boolean;
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i;

/** A recipe page's address as Recipes compares it (its blind index): tracking parameters, the fragment and a trailing slash off, lower case. */
export function recipeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = "";
    u.hostname = u.hostname.replace(/^(www|m)\./, "");
    return u.toString().replace(/\?$/, "").replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
