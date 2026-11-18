/**
 * Recipes for the app (lib/recipes.ts on the server; contract in
 * docs/notes/recipes.md): the grid, one recipe, importing from a link, the
 * week plan, the grocery list and Settings → Recipes.
 *
 * Offline: the last copy of the grid, each recipe opened, the plan and the
 * grocery list are kept in IndexedDB's meta store and shown when the server
 * can't be reached. Ticks, own lines and "Clear ticked" made offline change
 * that copy at once and wait in a queue (meta "recipes:outbox"), sent in
 * order the next time the list loads online.
 *
 * Sample mode answers from db/sample-recipes.ts and never touches the network.
 */

import { ApiError, getToken, isSampleMode, request } from "./api";
import { getMeta, setMeta } from "./idb";
import { savedImageUrl } from "./saved";
import type { GroceryItem, GroceryList, ImportMiss, Recipe, RecipeCard, RecipePrefs, TimeFilter, WeekPlan } from "../../../lib/recipe-rules";
import { parseIngredient } from "../../../lib/recipe-units";
import { aisleOf } from "../../../lib/grocery";

export type { GroceryItem, GroceryList, ImportMiss, Recipe, RecipeCard, RecipePrefs, TimeFilter, WeekPlan };
export type Loaded<T> = T & { state: "online" | "offline" | "sample" };

const sample = () => import("./sample-recipes");

type Listener = () => void;
const listeners = new Set<Listener>();
export function onRecipesChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

type ElsewhereListener = (ids: string[]) => void;
const elsewhere = new Set<ElsewhereListener>();
/** Hear that recipes, the week's plan or the grocery list changed somewhere else. `ids` are recipe ids, plan dates and grocery line ids; empty when the change can't be named. */
export function onRecipesElsewhere(fn: ElsewhereListener): () => void {
  elsewhere.add(fn);
  return () => elsewhere.delete(fn);
}
/** Called by the live channel (app/src/live). The grid reloads as after a change made here; the plan and the list decide for themselves. */
export function recipesChanged(ids: string[] = []): void {
  changed();
  elsewhere.forEach((fn) => fn(ids));
}

async function cached<T>(key: string, live: () => Promise<T>): Promise<Loaded<T>> {
  try {
    const value = await live();
    void setMeta(key, JSON.stringify(value)).catch(() => undefined);
    return { ...value, state: "online" };
  } catch (error) {
    if (error instanceof ApiError && error.status && error.status !== 0 && error.status < 500 && navigator.onLine) throw error;
    const raw = await getMeta(key).catch(() => undefined);
    if (!raw) throw error;
    return { ...(JSON.parse(raw) as T), state: "offline" };
  }
}

// ---------- recipes ----------

export interface RecipeQuery {
  q?: string;
  tag?: string | null;
  time?: TimeFilter | null;
}

export async function loadRecipes(query: RecipeQuery = {}): Promise<Loaded<{ recipes: RecipeCard[]; tags: string[]; moved: number }>> {
  if (isSampleMode()) return { ...(await sample()).sampleRecipes(query), state: "sample" };
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.tag) p.set("tag", query.tag);
  if (query.time) p.set("time", query.time);
  const plain = !p.size;
  const live = () => request<{ recipes: RecipeCard[]; tags: string[]; moved: number }>(`/recipes${p.size ? `?${p}` : ""}`);
  // The unfiltered grid is what's kept for offline; a filtered one offline filters that copy.
  if (plain) return cached("recipes:grid", live);
  try {
    return { ...(await live()), state: "online" };
  } catch (error) {
    const raw = await getMeta("recipes:grid").catch(() => undefined);
    if (!raw) throw error;
    const { recipes, tags } = JSON.parse(raw) as { recipes: RecipeCard[]; tags: string[] };
    const { matchesTime } = await import("../../../lib/recipe-rules");
    const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return {
      recipes: recipes.filter((r) => words.every((w) => `${r.title} ${r.tags.join(" ")}`.toLowerCase().includes(w)) && (!query.tag || r.tags.includes(query.tag)) && matchesTime(r.total_minutes, query.time ?? null)),
      tags,
      moved: 0,
      state: "offline",
    };
  }
}

export async function loadRecipe(id: string): Promise<Loaded<{ recipe: Recipe }>> {
  if (isSampleMode()) {
    const recipe = (await sample()).sampleRecipe(id);
    if (!recipe) throw new ApiError("That recipe isn't here", 404);
    return { recipe, state: "sample" };
  }
  return cached(`recipes:one:${id}`, () => request<{ recipe: Recipe }>(`/recipes/${encodeURIComponent(id)}`));
}

export type ImportResult = { ok: true; recipe: Recipe; created: boolean } | { ok: false; miss: ImportMiss };

/** A recipe from a link. `harder`: let Ask's model read the page when its recipe data can't be found. */
export async function importRecipe(url: string, harder = false): Promise<ImportResult> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 700));
    return { ok: false, miss: { error: "Sample mode can't read pages. In your own Athena this adds the recipe from the link.", code: "unreachable", saved_id: null, harder: false } };
  }
  const token = getToken();
  const res = await fetch("/api/recipes/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ url, harder }),
  }).catch(() => null);
  if (!res) throw new ApiError("You're offline", 0);
  const body = (await res.json().catch(() => ({}))) as Partial<ImportMiss> & { recipe?: Recipe; created?: boolean };
  if (res.ok && body.recipe) {
    changed();
    return { ok: true, recipe: body.recipe, created: !!body.created };
  }
  if (res.status === 422) return { ok: false, miss: { error: body.error ?? "No recipe found on that page", code: body.code ?? "no_recipe", saved_id: body.saved_id ?? null, harder: !!body.harder } };
  throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
}

export interface RecipeInput {
  title?: string;
  servings?: number | null;
  prep_minutes?: number | null;
  cook_minutes?: number | null;
  total_minutes?: number | null;
  ingredients?: string[];
  steps?: string[];
  tags?: string[];
  notes?: string;
}

export async function createRecipe(input: RecipeInput & { title: string }): Promise<Recipe> {
  const recipe = isSampleMode() ? (await sample()).sampleCreate(input) : (await request<{ recipe: Recipe }>("/recipes", { method: "POST", body: JSON.stringify(input) })).recipe;
  changed();
  return recipe;
}

export async function patchRecipe(id: string, patch: RecipeInput): Promise<Recipe> {
  const recipe = isSampleMode() ? (await sample()).samplePatch(id, patch as Record<string, unknown>) : (await request<{ recipe: Recipe }>(`/recipes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })).recipe;
  if (!recipe) throw new ApiError("That recipe isn't here", 404);
  changed();
  return recipe;
}

export async function archiveRecipe(id: string): Promise<void> {
  if (isSampleMode()) (await sample()).sampleArchive(id);
  else await request(`/recipes/${encodeURIComponent(id)}`, { method: "DELETE" });
  changed();
}

export async function markCooked(id: string, on?: string): Promise<Recipe> {
  const recipe = isSampleMode()
    ? (await sample()).sampleCooked(id, on ?? null)
    : (await request<{ recipe: Recipe }>(`/recipes/${encodeURIComponent(id)}/cooked`, { method: "POST", body: JSON.stringify(on ? { on } : {}) })).recipe;
  if (!recipe) throw new ApiError("That recipe isn't here", 404);
  changed();
  return recipe;
}

export async function unmarkCooked(id: string, on: string): Promise<Recipe> {
  const recipe = isSampleMode() ? (await sample()).sampleCooked(id, on, true) : (await request<{ recipe: Recipe }>(`/recipes/${encodeURIComponent(id)}/cooked/${on}`, { method: "DELETE" })).recipe;
  if (!recipe) throw new ApiError("That recipe isn't here", 404);
  changed();
  return recipe;
}

/** A recipe's picture as something an <img> can show: Saved's sealed image through the token, or a sample's own file. */
export function recipePhoto(r: Pick<RecipeCard, "id" | "photo_url">, size: "sm" | "lg"): Promise<string | null> {
  if (!r.photo_url) return Promise.resolve(null);
  if (!r.photo_url.startsWith("/api/")) return Promise.resolve(r.photo_url);
  const savedId = /\/api\/saved\/([^/?]+)\/image/.exec(r.photo_url)?.[1] ?? r.id;
  return savedImageUrl({ id: savedId, image_url: r.photo_url.replace(/\?.*$/, "") }, size);
}

// ---------- the week ----------

export async function loadPlan(week: string, fresh = false): Promise<Loaded<WeekPlan>> {
  if (isSampleMode()) return { ...(await sample()).samplePlan(week, fresh), state: "sample" };
  const path = `/recipes/plan?week=${week}${fresh ? "&fresh=1" : ""}`;
  return fresh ? { ...(await request<WeekPlan>(path)), state: "online" } : cached(`recipes:plan:${week}`, () => request<WeekPlan>(path));
}

export async function savePlan(week: string, days: Array<{ date: string; recipe_id: string | null; servings?: number | null }>): Promise<WeekPlan> {
  const plan = isSampleMode() ? (await sample()).sampleSavePlan(week, days) : await request<WeekPlan>("/recipes/plan", { method: "PUT", body: JSON.stringify({ week, days }) });
  if (!isSampleMode()) void setMeta(`recipes:plan:${week}`, JSON.stringify(plan)).catch(() => undefined);
  return plan;
}

// ---------- the grocery list ----------

type Op = { op: "tick"; id: string; ticked: boolean } | { op: "add"; item: string; temp: string } | { op: "remove"; id: string } | { op: "clear" };
const LIST = "recipes:grocery";
const OUTBOX = "recipes:outbox";

const readList = async (): Promise<GroceryList | null> => {
  const raw = await getMeta(LIST).catch(() => undefined);
  return raw ? (JSON.parse(raw) as GroceryList) : null;
};
const writeList = (list: GroceryList) => setMeta(LIST, JSON.stringify({ items: list.items })).catch(() => undefined);
const readOutbox = async (): Promise<Op[]> => JSON.parse((await getMeta(OUTBOX).catch(() => undefined)) ?? "[]") as Op[];
const writeOutbox = (ops: Op[]) => setMeta(OUTBOX, JSON.stringify(ops)).catch(() => undefined);

/** Send what was done offline, in order. Stops at the first that can't be sent yet. */
async function flush(): Promise<void> {
  const ops = await readOutbox();
  if (!ops.length) return;
  const temps = new Map<string, string>();
  while (ops.length) {
    const op = ops[0];
    try {
      if (op.op === "tick") {
        const id = temps.get(op.id) ?? op.id;
        if (!id.startsWith("offline-")) await request(`/recipes/grocery/items/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ticked: op.ticked }) });
      } else if (op.op === "remove") {
        const id = temps.get(op.id) ?? op.id;
        if (!id.startsWith("offline-")) await request(`/recipes/grocery/items/${encodeURIComponent(id)}`, { method: "DELETE" });
      } else if (op.op === "clear") await request("/recipes/grocery/clear", { method: "POST" });
      else {
        const list = await request<GroceryList>("/recipes/grocery/items", { method: "POST", body: JSON.stringify({ item: op.item }) });
        const made = [...list.items].reverse().find((i) => i.own);
        if (made) temps.set(op.temp, made.id);
      }
    } catch (error) {
      // A line that's gone from the server already isn't worth keeping in the queue.
      if (!(error instanceof ApiError && (error.status === 404 || error.status === 400))) break;
    }
    ops.shift();
    await writeOutbox(ops);
  }
}

export async function loadGrocery(): Promise<Loaded<GroceryList> & { pending: number }> {
  if (isSampleMode()) return { ...(await sample()).sampleGrocery(), state: "sample", pending: 0 };
  try {
    await flush();
    const list = await request<GroceryList>("/recipes/grocery");
    void writeList(list);
    return { ...list, state: "online", pending: (await readOutbox()).length };
  } catch (error) {
    const list = await readList();
    if (!list) throw error;
    return { ...list, state: "offline", pending: (await readOutbox()).length };
  }
}

/** Change the list: online through the server; offline on this device's copy, queued. */
async function change(op: Op, online: () => Promise<GroceryList>, local: (list: GroceryList) => void): Promise<Loaded<GroceryList>> {
  if (isSampleMode()) {
    const list = await online();
    return { ...list, state: "sample" };
  }
  try {
    if ((await readOutbox()).length) throw new Error("queued first");
    const list = await online();
    void writeList(list);
    return { ...list, state: "online" };
  } catch (error) {
    if (error instanceof ApiError && error.status && error.status < 500 && navigator.onLine) throw error;
    const list = (await readList()) ?? { items: [] };
    local(list);
    await writeList(list);
    await writeOutbox([...(await readOutbox()), op]);
    return { ...list, state: "offline" };
  }
}

export async function tickGrocery(id: string, ticked: boolean): Promise<Loaded<GroceryList>> {
  const s = isSampleMode() ? await sample() : null;
  return change(
    { op: "tick", id, ticked },
    () => (s ? Promise.resolve(s.samplePatchItem(id, { ticked })) : request<GroceryList>(`/recipes/grocery/items/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ticked }) })),
    (list) => list.items.forEach((i) => i.id === id && (i.ticked = ticked))
  );
}

export async function addOwnGrocery(text: string): Promise<Loaded<GroceryList>> {
  const s = isSampleMode() ? await sample() : null;
  const temp = `offline-${Date.now().toString(36)}`;
  return change(
    { op: "add", item: text, temp },
    () => (s ? Promise.resolve(s.sampleAddOwn(text)) : request<GroceryList>("/recipes/grocery/items", { method: "POST", body: JSON.stringify({ item: text }) })),
    (list) => {
      const ing = parseIngredient(text);
      list.items.push({ id: temp, item: ing.item, quantity: ing.quantity, unit: ing.unit, aisle: aisleOf(ing.item), recipes: [], own: true, ticked: false });
    }
  );
}

export async function removeGrocery(id: string): Promise<Loaded<GroceryList>> {
  const s = isSampleMode() ? await sample() : null;
  return change(
    { op: "remove", id },
    () => (s ? Promise.resolve(s.sampleRemoveItem(id)) : request<GroceryList>(`/recipes/grocery/items/${encodeURIComponent(id)}`, { method: "DELETE" })),
    (list) => (list.items = list.items.filter((i) => i.id !== id))
  );
}

export async function clearTicked(): Promise<Loaded<GroceryList>> {
  const s = isSampleMode() ? await sample() : null;
  return change(
    { op: "clear" },
    () => (s ? Promise.resolve(s.sampleClearTicked()) : request<GroceryList>("/recipes/grocery/clear", { method: "POST" })),
    (list) => (list.items = list.items.filter((i) => !i.ticked))
  );
}

/** Recipes (with how many each serves), or a week's plan, onto the list. Needs a connection. */
export async function addToGrocery(body: { recipe_ids?: string[]; servings?: Record<string, number>; week?: string }): Promise<GroceryList & { added: number; pantry: string[] }> {
  if (isSampleMode()) return (await sample()).sampleAddToGrocery(body);
  const out = await request<GroceryList & { added: number; pantry: string[] }>("/recipes/grocery/add", { method: "POST", body: JSON.stringify(body) });
  void writeList(out);
  return out;
}

// ---------- settings ----------

const PREFS = "recipes:prefs";

export async function loadRecipePrefs(): Promise<RecipePrefs> {
  if (isSampleMode()) return (await sample()).samplePrefs();
  try {
    const prefs = await request<RecipePrefs>("/recipes/prefs");
    void setMeta(PREFS, JSON.stringify(prefs)).catch(() => undefined);
    return prefs;
  } catch {
    const raw = await getMeta(PREFS).catch(() => undefined);
    if (raw) return JSON.parse(raw) as RecipePrefs;
    const { DEFAULT_PANTRY } = await import("../../../lib/grocery");
    return { pantry: [...DEFAULT_PANTRY], system: "metric" };
  }
}

export async function saveRecipePrefs(prefs: Partial<RecipePrefs>): Promise<RecipePrefs> {
  const out = isSampleMode() ? (await sample()).sampleSavePrefs(prefs) : await request<RecipePrefs>("/recipes/prefs", { method: "PUT", body: JSON.stringify(prefs) });
  if (!isSampleMode()) void setMeta(PREFS, JSON.stringify(out)).catch(() => undefined);
  return out;
}
