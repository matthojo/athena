/**
 * Recipes (#/recipes; server in lib/recipes.ts).
 *
 *  - #/recipes: the grid (photo, title, time, tags) with search, tag and time
 *    filters, and "Add from a link". Recipe links kept in Saved move in on
 *    their own, with Saved keeping a pointer.
 *  - #/recipes/<id>: one recipe. Servings rescale the quantities (fractions
 *    for spoons and counts, round grams), Metric and Imperial switch units,
 *    "Mark as cooked" keeps a log, Edit, and the source link.
 *  - #/recipes/<id>/cook: cook mode. Large text, one step at a time with the
 *    ingredients it uses, timers from the step's own words, and the screen
 *    kept on (Wake Lock) while it's open.
 *  - #/recipes/plan: the week's dinners, suggested around the calendar (quick
 *    on busy evenings, longer on free ones). Drag a day onto another to swap.
 *  - #/recipes/list: the grocery list, by aisle (in the order the owner walks
 *    their shop, once Athena has seen a couple of shops), with the usuals that
 *    are due offered on top. "Done shopping" files the ticked lines as a shop
 *    (lib/grocery-memory.ts). Ticks work offline.
 *  - #/recipes/list/shop: shopping mode. Large lines, the screen kept on.
 *
 * Every word on the page is set with textContent (h()): a recipe's text
 * comes from other people's pages.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { pageHead } from "../components/page-head";
import { showToast } from "../components/toast";
import { openSheet } from "../components/sheet";
import { confirmDialog } from "../components/confirm";
import { autoTextarea, field, input } from "../components/fields";
import { plural, relativeTime } from "../lib/format";
import { localToday } from "../lib/time";
import { addDays, weekStart } from "../components/day-words";
import type { ViewId } from "../components/nav";
import {
  addOwnGrocery,
  addToGrocery,
  archiveRecipe,
  createRecipe,
  importRecipe,
  loadGrocery,
  loadPlan,
  loadRecipe,
  loadRecipePrefs,
  loadRecipes,
  markCooked,
  onRecipesChange,
  onRecipesElsewhere,
  recipesChanged,
  patchRecipe,
  recipePhoto,
  removeGrocery,
  finishShopping,
  skipUsual,
  savePlan,
  tickGrocery,
  unmarkCooked,
  type GroceryItem,
  type GroceryList,
  type Usual,
  type Recipe,
  type RecipeCard,
  type TimeFilter,
  type WeekPlan,
} from "../db/recipes";
import { formatAmount, formatIngredient, itemFor, scaleIngredient, type Ingredient, type UnitSystem } from "../../../lib/recipe-units";
import { clock, ingredientsForStep, stepTimers, type StepTimer } from "../../../lib/recipe-steps";
import { groupByAisle, type Aisle } from "../../../lib/grocery";
import { collapse, expand } from "../lib/finish-motion";
import { isSampleMode } from "../db/api";
import { minutesLabel, minutesOf } from "../../../lib/recipe-rules";
import "../styles/recipes.css";

type Go = (view: ViewId, opts?: { noteId?: string | null }) => void;
interface Ctx {
  go: Go;
  path: string | null;
  isDesktop: () => boolean;
}
type Mounted = { el: HTMLElement; destroy: () => void };

/** Move within Recipes, with a history entry so Back comes back. */
function to(ctx: Ctx, path: string | null): void {
  history.pushState(history.state, "", `#/recipes${path ? `/${path}` : ""}`);
  ctx.go("recipes", { noteId: path });
}

const hostOf = (raw: string | null) => {
  try {
    return raw ? new URL(raw).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};
const safeHref = (raw: string | null) => (raw && /^https?:\/\//i.test(raw) ? raw : null);

/** "Mon 9", "Tue 10". */
const dayName = (date: string, long = false) =>
  new Intl.DateTimeFormat("en-GB", { weekday: long ? "long" : "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(`${date}T12:00:00Z`));
const weekLabel = (monday: string) => {
  const end = addDays(monday, 6);
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone: "UTC" }).format(Date.parse(`${d}T12:00:00Z`));
  return monday.slice(5, 7) === end.slice(5, 7) ? `${f(monday, { day: "numeric" })}–${f(end, { day: "numeric", month: "short" })}` : `${f(monday, { day: "numeric", month: "short" })} – ${f(end, { day: "numeric", month: "short" })}`;
};

/** A recipe's picture, faded in once it's loaded; a quiet tile with the pot when there's none. */
function photo(r: Pick<RecipeCard, "id" | "photo_url" | "title">, size: "sm" | "lg", cls = "rc-photo"): HTMLElement {
  const box = h("div", { class: `${cls} is-empty` }, h("span", { class: "rc-photo__mark", "aria-hidden": "true" }, icons.pot()));
  void recipePhoto(r, size).then((src) => {
    if (!src) return;
    const img = h("img", { src, alt: "", loading: "lazy", decoding: "async" }) as HTMLImageElement;
    img.addEventListener("load", () => box.classList.remove("is-empty"), { once: true });
    box.replaceChildren(img);
  });
  return box;
}

/** Recipes · Meal plan · Grocery list. */
function tabs(ctx: Ctx, active: "all" | "plan" | "list"): HTMLElement {
  const items: Array<[typeof active, string, string | null]> = [
    ["all", "Recipes", null],
    ["plan", "Meal plan", "plan"],
    ["list", "Grocery list", "list"],
  ];
  return h(
    "nav",
    { class: "segmented segmented--sub rc-tabs", "aria-label": "Recipes" },
    ...items.map(([key, label, path]) => {
      const b = h("button", { class: "segmented__item", type: "button", "aria-current": key === active ? "page" : undefined }, label);
      b.addEventListener("click", () => key !== active && to(ctx, path));
      return b;
    })
  );
}

function offlineNote(state: string, extra = ""): HTMLElement | null {
  if (state !== "offline") return null;
  return h("p", { class: "rc-offline", role: "status" }, icons.wifiOff(), `You're offline. This is the copy on this device${extra}.`);
}

export function renderRecipes(ctx: Ctx): Mounted {
  const path = ctx.path ?? "";
  if (path === "plan") return renderPlan(ctx);
  if (path === "list") return renderGrocery(ctx);
  if (path === "list/shop") return renderShop(ctx);
  const [rid, sub] = path.split("/");
  if (rid && sub === "cook") return renderCook(ctx, rid);
  if (rid) return renderRecipe(ctx, rid);
  return renderGrid(ctx);
}

// ---------- the grid ----------

const TIMES: Array<{ value: TimeFilter; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "under-hour", label: "Under an hour" },
  { value: "longer", label: "Longer" },
];

function renderGrid(ctx: Ctx): Mounted {
  let q = "";
  let tag: string | null = null;
  let time: TimeFilter | null = null;
  let alive = true;
  let seq = 0;
  let tags: string[] = [];

  const count = h("span", { class: "page-count" });
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New");
  add.addEventListener("click", () => openAddSheet(ctx));
  const box = h("input", { type: "search", placeholder: "Search recipes or ingredients", "aria-label": "Search recipes", autocomplete: "off", enterkeyhint: "search" }) as HTMLInputElement;
  const search = h("label", { class: "search rc-search" }, icons.search(), box);
  const chips = h("div", { class: "chip-row rc-filters", role: "toolbar", "aria-label": "Filter recipes" });
  const grid = h("div", { class: "rc-grid", "aria-live": "polite" });
  const note = h("div", {});

  const el = h(
    "div",
    { class: "view recipes" },
    pageHead({
      segments: librarySegments("recipes", ctx.go),
      title: "Recipes",
      count,
      actions: [add],
      below: [tabs(ctx, "all"), search, chips],
    }),
    note,
    grid
  );

  function paintChips() {
    const chip = (label: string, on: boolean, run: () => void, cls = "") => {
      const b = h("button", { class: `chip chip--sm${cls}`, type: "button", "aria-pressed": String(on) }, label);
      b.addEventListener("click", run);
      return b;
    };
    chips.replaceChildren(
      ...TIMES.map((t) => chip(t.label, time === t.value, () => ((time = time === t.value ? null : t.value), void load()), " rc-filters__time")),
      ...(tags.length ? [h("span", { class: "rc-filters__rule", "aria-hidden": "true" })] : []),
      ...tags.map((t) => chip(t, tag === t, () => ((tag = tag === t ? null : t), void load())))
    );
  }

  function card(r: RecipeCard): HTMLElement {
    const mins = minutesLabel(r.total_minutes);
    const meta = [mins, r.servings ? `Serves ${r.servings}` : null].filter(Boolean).join(" · ");
    const a = h(
      "a",
      { class: "rc-card", href: `#/recipes/${encodeURIComponent(r.id)}` },
      photo(r, "sm"),
      h(
        "span",
        { class: "rc-card__body" },
        h("span", { class: "rc-card__title" }, r.title),
        meta ? h("span", { class: "rc-card__meta" }, r.total_minutes ? icons.clock() : null, meta) : null,
        r.tags.length ? h("span", { class: "rc-card__tags" }, r.tags.slice(0, 3).join(" · ")) : null
      )
    );
    return a;
  }

  async function load() {
    const mine = ++seq;
    paintChips();
    try {
      const page = await loadRecipes({ q, tag, time });
      if (!alive || mine !== seq) return;
      tags = page.tags;
      paintChips();
      count.textContent = page.recipes.length ? String(page.recipes.length) : "";
      note.replaceChildren(offlineNote(page.state) ?? "");
      if (page.moved) showToast(`Moved ${plural(page.moved, "a recipe", `${page.moved} recipes`)} in from Saved`, { icon: "pot" });
      if (!page.recipes.length) {
        const filtered = q || tag || time;
        grid.replaceChildren(
          h(
            "div",
            { class: "empty rc-empty" },
            h("span", { class: "tile" }, icons.pot()),
            h("p", { class: "empty__title" }, filtered ? "Nothing matches" : "No recipes yet"),
            h("p", { class: "empty__sub" }, filtered ? "Try other words, or clear a filter." : "Paste a link to a recipe, or share one to Athena from your phone. Recipe links you've kept in Saved move here too.")
          )
        );
        return;
      }
      grid.replaceChildren(...page.recipes.map(card));
    } catch (error) {
      if (!alive) return;
      grid.replaceChildren(h("div", { class: "empty rc-empty" }, h("p", { class: "empty__title" }, "Couldn't load your recipes"), h("p", { class: "empty__sub" }, error instanceof Error ? error.message : "Try again in a moment.")));
    }
  }

  let timer = 0;
  box.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      q = box.value.trim();
      void load();
    }, 200);
  });

  const off = onRecipesChange(() => void load());
  void load();
  return {
    el,
    destroy: () => {
      alive = false;
      off();
      clearTimeout(timer);
    },
  };
}

/** "Add a recipe": paste a link (read from the page's own recipe data), or type one in. */
function openAddSheet(ctx: Ctx): void {
  const url = input("url", "", { placeholder: "https://…", autocomplete: "off", inputmode: "url", "aria-label": "Recipe link" });
  const go = h("button", { class: "btn btn--primary", type: "submit" }, "Add");
  const status = h("div", { class: "rc-add__status", role: "status" });
  const typeIn = h("button", { class: "btn btn--ghost", type: "button" }, "Type one in instead");
  const form = h(
    "form",
    { class: "rc-add" },
    h("p", { class: "rc-add__lede" }, "Paste a link to a recipe. Athena reads it from the page's own recipe data, so it doesn't use Ask."),
    h("div", { class: "rc-add__row" }, url, go),
    status,
    typeIn
  );
  const sheet = openSheet({ label: "Add a recipe", title: "Add a recipe", body: form });
  typeIn.addEventListener("click", () => {
    sheet.close();
    openEditSheet(ctx, null);
  });
  const run = async (harder: boolean) => {
    const link = url.value.trim();
    if (!/^https?:\/\/\S+\.\S+/i.test(link)) {
      status.replaceChildren(h("p", { class: "rc-add__miss" }, "That doesn't look like a link."));
      return;
    }
    go.setAttribute("disabled", "");
    status.replaceChildren(h("p", { class: "rc-add__working" }, harder ? "Asking Ask's model to read the page…" : "Reading the page…"));
    try {
      const out = await importRecipe(link, harder);
      if (out.ok) {
        sheet.close();
        showToast(out.created ? `Added “${out.recipe.title}”` : `“${out.recipe.title}” was already here`, { icon: "pot" });
        to(ctx, out.recipe.id);
        return;
      }
      const lines: HTMLElement[] = [h("p", { class: "rc-add__miss" }, out.miss.error)];
      if (out.miss.saved_id) lines.push(h("p", { class: "rc-add__sub" }, "The link is kept in Saved either way."));
      if (out.miss.harder && !harder) {
        const harderBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.sparkle(), "Try harder");
        harderBtn.addEventListener("click", () => void run(true));
        lines.push(h("div", { class: "rc-add__harder" }, harderBtn, h("span", { class: "rc-add__sub" }, "Ask's model reads the page's text. This uses AI credits.")));
      }
      status.replaceChildren(...lines);
    } catch (error) {
      status.replaceChildren(h("p", { class: "rc-add__miss" }, error instanceof Error ? error.message : "Couldn't add that"));
    } finally {
      go.removeAttribute("disabled");
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(false);
  });
  requestAnimationFrame(() => url.focus());
}

/** Edit (or type in) a recipe: lines of ingredients and steps, as a cook writes them. */
function openEditSheet(ctx: Ctx, r: Recipe | null, done?: (r: Recipe) => void): void {
  const title = input("text", r?.title ?? "", { placeholder: "Name", autocomplete: "off" });
  const servings = input("number", r?.servings ? String(r.servings) : "", { min: 1, max: 99, inputmode: "numeric", placeholder: "4" });
  const prep = input("number", r?.prep_minutes ? String(r.prep_minutes) : "", { min: 0, inputmode: "numeric", placeholder: "Minutes" });
  const cook = input("number", r?.cook_minutes ? String(r.cook_minutes) : "", { min: 0, inputmode: "numeric", placeholder: "Minutes" });
  const total = input("number", r?.total_minutes ? String(r.total_minutes) : "", { min: 0, inputmode: "numeric", placeholder: "Minutes" });
  const ingredients = autoTextarea((r?.ingredients ?? []).map(formatIngredient).join("\n"), { placeholder: "One per line: 2 leeks, sliced", "aria-label": "Ingredients" }, 120);
  const steps = autoTextarea((r?.steps ?? []).map((s) => s.text).join("\n\n"), { placeholder: "One step per paragraph", "aria-label": "Method" }, 140);
  const tags = input("text", (r?.tags ?? []).join(", "), { placeholder: "quick, vegetarian", autocomplete: "off" });
  const notes = autoTextarea(r?.notes ?? "", { placeholder: "Your own notes", "aria-label": "Notes" }, 60);
  const save = h("button", { class: "btn btn--primary btn--block", type: "submit" }, r ? "Save" : "Add recipe");
  const num = (el: HTMLInputElement) => (el.value.trim() ? Math.max(0, Math.round(Number(el.value))) || null : null);
  const form = h(
    "form",
    { class: "rc-edit" },
    field("Name", title),
    field("Serves", servings),
    field("Prep", prep),
    field("Cook", cook),
    field("Total", total),
    h("label", { class: "rc-edit__label" }, "Ingredients", ingredients),
    h("label", { class: "rc-edit__label" }, "Method", steps),
    field("Tags", tags),
    h("label", { class: "rc-edit__label" }, "Notes", notes),
    save
  );
  const sheet = openSheet({ label: r ? "Edit recipe" : "New recipe", title: r ? "Edit recipe" : "New recipe", body: form, variant: "tall" });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!title.value.trim()) {
      title.focus();
      return;
    }
    save.setAttribute("disabled", "");
    const body = {
      title: title.value.trim(),
      servings: num(servings),
      prep_minutes: num(prep),
      cook_minutes: num(cook),
      total_minutes: num(total),
      ingredients: ingredients.value.split("\n").map((l) => l.trim()).filter(Boolean),
      steps: steps.value.split(/\n\s*\n|\n(?=\d+[.)]\s)/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean),
      tags: tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      notes: notes.value,
    };
    try {
      const saved = r ? await patchRecipe(r.id, body) : await createRecipe(body);
      sheet.close();
      showToast(r ? "Saved" : `Added “${saved.title}”`, { icon: "check" });
      if (done) done(saved);
      else to(ctx, saved.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    } finally {
      save.removeAttribute("disabled");
    }
  });
}

// ---------- one recipe ----------

/** Servings and units chosen on this device, so cook mode and a return visit keep them. */
const viewKey = (id: string) => `athena.recipes.view.${id}`;
function viewPrefs(id: string): { serves: number | null; system: UnitSystem | null } {
  try {
    return { serves: null, system: null, ...(JSON.parse(sessionStorage.getItem(viewKey(id)) ?? "{}") as object) };
  } catch {
    return { serves: null, system: null };
  }
}
function keepViewPrefs(id: string, p: { serves: number | null; system: UnitSystem | null }): void {
  try {
    sessionStorage.setItem(viewKey(id), JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

/** One ingredient at this size and in these units: [amount, the rest]. */
function lineParts(ing: Ingredient, factor: number, system: UnitSystem | null): [string, string] {
  const scaled = scaleIngredient(ing, factor, system);
  return [formatAmount(scaled), itemFor(scaled) + (ing.note ? `, ${ing.note}` : "")];
}

function cookedLine(r: Recipe): string {
  if (!r.cooked.length) return "Not cooked yet";
  const last = r.cooked[0].on;
  const days = Math.round((Date.parse(`${localToday()}T12:00:00Z`) - Date.parse(`${last}T12:00:00Z`)) / 86_400_000);
  const when = days <= 0 ? "today" : days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : relativeTime(`${last}T12:00:00Z`);
  return `Cooked ${when}${r.cooked.length > 1 ? ` · ${r.cooked.length} times` : ""}`;
}

function renderRecipe(ctx: Ctx, id: string): Mounted {
  let alive = true;
  const el = h("div", { class: "view recipes rc-one", "aria-busy": "true" });
  const back = h("button", { class: "rc-back", type: "button" }, icons.back(), "Recipes");
  back.addEventListener("click", () => (history.length > 1 && history.state ? history.back() : to(ctx, null)));
  el.append(back, h("p", { class: "rc-loading" }, "Opening…"));

  void (async () => {
    try {
      const [{ recipe, state }, prefs] = await Promise.all([loadRecipe(id), loadRecipePrefs()]);
      if (!alive) return;
      el.removeAttribute("aria-busy");
      paint(recipe, state, prefs.system);
    } catch (error) {
      if (!alive) return;
      el.replaceChildren(back, h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That recipe isn't here"), h("p", { class: "empty__sub" }, error instanceof Error ? error.message : "It may have been archived.")));
    }
  })();

  function paint(r: Recipe, state: string, defaultSystem: UnitSystem) {
    const kept = viewPrefs(r.id);
    const base = r.servings ?? 0;
    let serves = kept.serves ?? (base || 0);
    let system: UnitSystem = kept.system ?? defaultSystem;
    const factor = () => (base && serves ? serves / base : 1);
    const minutes = minutesOf(r);

    const list = h("ul", { class: "rc-ings" });
    const ticked = new Set<number>();
    const paintList = () => {
      list.replaceChildren(
        ...r.ingredients.map((ing, i) => {
          const [amount, rest] = lineParts(ing, factor(), system);
          const box = h("input", { type: "checkbox", class: "rc-ings__tick", "aria-label": `Got ${ing.item}` }) as HTMLInputElement;
          box.checked = ticked.has(i);
          box.addEventListener("change", () => (box.checked ? ticked.add(i) : ticked.delete(i), li.classList.toggle("is-ticked", box.checked)));
          const li = h("li", { class: `rc-ings__line${ticked.has(i) ? " is-ticked" : ""}` }, h("label", {}, box, h("span", { class: "rc-ings__amount" }, amount), h("span", { class: "rc-ings__item" }, rest)));
          return li;
        })
      );
    };

    const count = h("output", { class: "rc-serves__n", "aria-live": "polite" });
    const minus = h("button", { class: "icon-btn icon-btn--sm", type: "button", "aria-label": "Fewer servings" }, icons.minus());
    const plus = h("button", { class: "icon-btn icon-btn--sm", type: "button", "aria-label": "More servings" }, icons.plus());
    const paintServes = () => {
      count.textContent = serves ? `Serves ${serves}` : "Serves —";
      minus.toggleAttribute("disabled", serves <= 1);
      keepViewPrefs(r.id, { serves: serves && serves !== base ? serves : null, system: system !== defaultSystem ? system : null });
      paintList();
    };
    minus.addEventListener("click", () => ((serves = Math.max(1, serves - 1)), paintServes()));
    plus.addEventListener("click", () => ((serves = (serves || base || 1) + 1), paintServes()));
    const units = h("div", { class: "segmented rc-units", role: "radiogroup", "aria-label": "Units" });
    const paintUnits = () =>
      units.replaceChildren(
        ...(["metric", "imperial"] as UnitSystem[]).map((s) => {
          const b = h("button", { class: "segmented__item", type: "button", role: "radio", "aria-checked": String(s === system), "aria-current": s === system ? "page" : undefined }, s === "metric" ? "Metric" : "Imperial");
          b.addEventListener("click", () => {
            system = s;
            paintUnits();
            paintServes();
          });
          return b;
        })
      );
    paintUnits();
    paintServes();

    const cooked = h("p", { class: "rc-cooked" }, cookedLine(r));
    const cookBtn = h("button", { class: "btn btn--primary", type: "button" }, icons.play(), "Cook");
    cookBtn.addEventListener("click", () => to(ctx, `${r.id}/cook`));
    const markBtn = h("button", { class: "btn btn--soft", type: "button" }, icons.check(), "Mark as cooked");
    markBtn.addEventListener("click", async () => {
      try {
        const today = localToday();
        const had = r.cooked.some((c) => c.on === today);
        r = await markCooked(r.id);
        cooked.textContent = cookedLine(r);
        showToast("Marked as cooked today", {
          icon: "check",
          action: had ? undefined : { label: "Undo", run: () => void unmarkCooked(r.id, today).then((x) => ((r = x), (cooked.textContent = cookedLine(x)))) },
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
      }
    });
    const listBtn = h("button", { class: "btn btn--soft", type: "button" }, icons.bag(), "Add to grocery list");
    listBtn.addEventListener("click", async () => {
      try {
        const out = await addToGrocery({ recipe_ids: [r.id], servings: serves ? { [r.id]: serves } : undefined });
        rememberPantry(out.pantry);
        showToast(`Added ${plural(out.added, "a line", `${out.added} lines`)} to the grocery list`, { icon: "bag", action: { label: "Open", run: () => to(ctx, "list") } });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Adding to the list needs a connection", { icon: "wifiOff" });
      }
    });
    const more = h("button", { class: "icon-btn icon-btn--ghost", type: "button", "aria-label": "Edit or archive" }, icons.more());
    more.addEventListener("click", () => {
      const edit = h("button", { class: "row", type: "button" }, h("span", { class: "tile tile--sm" }, icons.pen()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Edit")));
      const arch = h("button", { class: "row", type: "button" }, h("span", { class: "tile tile--sm" }, icons.archive()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Archive"), h("span", { class: "row__meta" }, "Off the grid and the week plan")));
      const sheet = openSheet({ label: r.title, title: r.title, body: h("div", { class: "card card--flush list" }, edit, arch) });
      edit.addEventListener("click", () => {
        sheet.close();
        openEditSheet(ctx, r, (next) => {
          r = next;
          el.replaceChildren(back);
          paint(next, state, defaultSystem);
        });
      });
      arch.addEventListener("click", async () => {
        sheet.close();
        if (!(await confirmDialog({ title: "Archive this recipe?", body: "It leaves Recipes and the week plan. Its Saved link stays in Saved.", confirmLabel: "Archive" }))) return;
        await archiveRecipe(r.id);
        showToast("Archived", { icon: "archive" });
        to(ctx, null);
      });
    });

    const src = safeHref(r.url);
    const by = r.by ?? "";
    const meta = h(
      "p",
      { class: "rc-meta" },
      minutes ? h("span", {}, icons.clock(), minutesLabel(minutes)) : null,
      r.prep_minutes && r.cook_minutes ? h("span", {}, `${minutesLabel(r.prep_minutes)} prep, ${minutesLabel(r.cook_minutes)} cooking`) : null,
      r.yield_text ? h("span", {}, r.yield_text) : null
    );
    const source = src
      ? h("a", { class: "rc-source", href: src, target: "_blank", rel: "noopener noreferrer" }, hostOf(src) ?? "Source", icons.external())
      : null;
    const fromSaved = r.saved_id ? h("a", { class: "rc-source rc-source--saved", href: `#/saved/${encodeURIComponent(r.saved_id)}` }, icons.bookmark(), "In Saved") : null;

    const steps = h("ol", { class: "rc-steps" });
    let section: string | null | undefined;
    for (const s of r.steps) {
      if (s.section && s.section !== section) steps.append(h("li", { class: "rc-steps__section", "aria-hidden": "true" }, s.section));
      section = s.section;
      steps.append(h("li", { class: "rc-steps__step" }, s.text));
    }

    el.replaceChildren(
      back,
      offlineNote(state) ?? "",
      h(
        "header",
        { class: "rc-hero" },
        photo(r, "lg", "rc-photo rc-hero__photo"),
        h(
          "div",
          { class: "rc-hero__text" },
          h("h1", { class: "page-title rc-hero__title" }, r.title),
          by || source || fromSaved ? h("p", { class: "rc-by" }, by ? h("span", {}, `By ${by}`) : null, source, fromSaved) : null,
          meta.childNodes.length ? meta : null,
          r.tags.length ? h("p", { class: "rc-tags" }, ...r.tags.map((t) => h("span", { class: "chip chip--sm" }, t))) : null,
          cooked,
          h("div", { class: "rc-actions" }, cookBtn, markBtn, listBtn, more)
        )
      ),
      h(
        "div",
        { class: "rc-body" },
        h(
          "section",
          { class: "card rc-panel rc-panel--ings", "aria-labelledby": "rc-ings-h" },
          h("div", { class: "rc-panel__head" }, h("h2", { class: "rc-panel__title", id: "rc-ings-h" }, "Ingredients"), units),
          h("div", { class: "rc-serves" }, minus, count, plus, base && serves !== base ? h("span", { class: "rc-serves__was" }, `Recipe serves ${base}`) : null),
          list
        ),
        h(
          "section",
          { class: "rc-panel rc-panel--method", "aria-labelledby": "rc-method-h" },
          h("h2", { class: "rc-panel__title", id: "rc-method-h" }, "Method"),
          r.steps.length ? steps : h("p", { class: "rc-muted" }, "No steps yet. Add them with Edit."),
          r.notes ? h("div", { class: "rc-notes" }, h("h3", { class: "rc-panel__title rc-panel__title--sm" }, "Notes"), ...r.notes.split(/\n{2,}/).map((p) => h("p", {}, p))) : null
        )
      )
    );
    // The "Recipe serves 4" hint follows the stepper.
    const head = el.querySelector(".rc-serves");
    const paintWas = () => {
      head?.querySelector(".rc-serves__was")?.remove();
      if (base && serves !== base) head?.append(h("span", { class: "rc-serves__was" }, `Recipe serves ${base}`));
    };
    minus.addEventListener("click", paintWas);
    plus.addEventListener("click", paintWas);
  }

  return {
    el,
    destroy: () => {
      alive = false;
    },
  };
}

// ---------- cook mode ----------

interface Running {
  key: string;
  label: string;
  step: number;
  ends: number;
  done: boolean;
}

function chime(): void {
  try {
    const ac = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.3);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + t);
      o.stop(ac.currentTime + t + 0.32);
    });
  } catch {
    /* no sound here */
  }
  navigator.vibrate?.([300, 150, 300]);
}

function renderCook(ctx: Ctx, id: string): Mounted {
  let alive = true;
  let at = 0;
  let r: Recipe | null = null;
  let factor = 1;
  let system: UnitSystem | null = null;
  const timers: Running[] = [];
  let tick = 0;
  let lock: { release: () => Promise<void> } | null = null;

  const exit = () => to(ctx, id);
  const close = h("button", { class: "icon-btn rc-cook__close", type: "button", "aria-label": "Close cook mode" }, icons.close());
  close.addEventListener("click", exit);
  const title = h("p", { class: "rc-cook__title" });
  const progress = h("p", { class: "rc-cook__count", "aria-live": "polite" });
  const awake = h("p", { class: "rc-cook__awake", hidden: true }, "Screen stays on");
  const stepText = h("p", { class: "rc-cook__step" });
  const section = h("p", { class: "rc-cook__section" });
  const uses = h("ul", { class: "rc-cook__uses", "aria-label": "Ingredients for this step" });
  const startTimers = h("div", { class: "rc-cook__timers" });
  const running = h("div", { class: "rc-cook__running", "aria-live": "polite" });
  const prev = h("button", { class: "btn btn--soft rc-cook__nav", type: "button" }, icons.back(), "Back");
  const next = h("button", { class: "btn btn--primary rc-cook__nav", type: "button" }, "Next", icons.chevronRight());
  const bar = h("div", { class: "rc-cook__bar", "aria-hidden": "true" }, h("span", {}));
  const main = h("div", { class: "rc-cook__main" }, section, stepText, uses, startTimers);
  const el = h(
    "div",
    { class: "rc-cook", role: "dialog", "aria-modal": "true", "aria-label": "Cook mode" },
    h("header", { class: "rc-cook__head" }, close, h("div", { class: "rc-cook__head-text" }, title, progress), awake),
    bar,
    main,
    running,
    h("footer", { class: "rc-cook__foot" }, prev, next)
  );

  function paint() {
    if (!r) return;
    const steps = r.steps.length ? r.steps : [{ text: "This recipe has no steps yet.", section: null }];
    at = Math.max(0, Math.min(at, steps.length - 1));
    const step = steps[at];
    title.textContent = r.title;
    progress.textContent = `Step ${at + 1} of ${steps.length}`;
    (bar.firstChild as HTMLElement).style.width = `${((at + 1) / steps.length) * 100}%`;
    section.textContent = step.section ?? "";
    section.hidden = !step.section;
    stepText.textContent = step.text;
    const idx = ingredientsForStep(step.text, r.ingredients);
    uses.replaceChildren(
      ...idx.map((i) => {
        const [amount, rest] = lineParts(r!.ingredients[i], factor, system);
        return h("li", {}, amount ? h("strong", {}, amount) : null, " ", rest);
      })
    );
    uses.hidden = !idx.length;
    startTimers.replaceChildren(
      ...stepTimers(step.text).map((t: StepTimer) => {
        const b = h("button", { class: "btn btn--soft rc-cook__timer", type: "button" }, icons.clock(), `Start timer · ${t.label}`);
        b.addEventListener("click", () => startTimer(t, at));
        return b;
      })
    );
    prev.toggleAttribute("disabled", at === 0);
    const last = at === steps.length - 1;
    next.replaceChildren(...(last ? [icons.check(), "Done"] : ["Next", icons.chevronRight()]));
    main.classList.remove("is-in");
    void main.offsetWidth;
    main.classList.add("is-in");
  }

  function startTimer(t: StepTimer, step: number) {
    const key = `${step}:${t.label}`;
    if (timers.some((x) => x.key === key && !x.done)) return;
    timers.push({ key, label: t.label, step, ends: Date.now() + t.seconds * 1000, done: false });
    paintTimers();
    if (!tick) tick = window.setInterval(paintTimers, 500);
  }

  function paintTimers() {
    const now = Date.now();
    for (const t of timers) {
      if (!t.done && t.ends <= now) {
        t.done = true;
        chime();
      }
    }
    running.replaceChildren(
      ...timers.map((t) => {
        const left = Math.max(0, Math.ceil((t.ends - now) / 1000));
        const stop = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": t.done ? "Dismiss timer" : "Stop timer" }, icons.close());
        stop.addEventListener("click", () => {
          timers.splice(timers.indexOf(t), 1);
          paintTimers();
        });
        return h("div", { class: `rc-timer${t.done ? " is-done" : ""}` }, h("span", { class: "rc-timer__time" }, t.done ? "Done" : clock(left)), h("span", { class: "rc-timer__label" }, `Step ${t.step + 1} · ${t.label}`), stop);
      })
    );
    if (!timers.length && tick) {
      clearInterval(tick);
      tick = 0;
    }
  }

  const go = (d: number) => {
    if (!r) return;
    if (d > 0 && at >= Math.max(1, r.steps.length) - 1) {
      exit();
      return;
    }
    at += d;
    paint();
  };
  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === " ") (e.preventDefault(), go(1));
    else if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
    else if (e.key === "Escape") exit();
  };
  document.addEventListener("keydown", onKey);
  let x0: number | null = null;
  main.addEventListener("pointerdown", (e) => (x0 = e.clientX));
  main.addEventListener("pointerup", (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
  });

  // Keep the screen on while cooking; ask again when the page comes back (the browser lets it go when hidden).
  const wake = async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wl || document.visibilityState !== "visible" || !alive) return;
    try {
      lock = await wl.request("screen");
      awake.hidden = false;
    } catch {
      awake.hidden = true;
    }
  };
  const onVisible = () => document.visibilityState === "visible" && void wake();
  document.addEventListener("visibilitychange", onVisible);
  void wake();
  document.documentElement.classList.add("is-cooking");

  void (async () => {
    try {
      const [{ recipe }, prefs] = await Promise.all([loadRecipe(id), loadRecipePrefs()]);
      if (!alive) return;
      r = recipe;
      const kept = viewPrefs(id);
      factor = kept.serves && recipe.servings ? kept.serves / recipe.servings : 1;
      system = kept.system ?? prefs.system;
      const start = Number(new URLSearchParams(location.hash.split("?")[1] ?? "").get("step"));
      if (start > 0) at = start - 1;
      paint();
      if (new URLSearchParams(location.hash.split("?")[1] ?? "").has("demo")) {
        const t = stepTimers(recipe.steps[at]?.text ?? "")[0];
        if (t) startTimer({ ...t, seconds: t.seconds - 83 }, at);
      }
    } catch {
      if (alive) stepText.textContent = "That recipe isn't here.";
    }
  })();

  return {
    el,
    destroy: () => {
      alive = false;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.classList.remove("is-cooking");
      if (tick) clearInterval(tick);
      void lock?.release().catch(() => undefined);
    },
  };
}

// ---------- the week plan ----------

const thisWeek = () => weekStart(localToday());

function renderPlan(ctx: Ctx): Mounted {
  let alive = true;
  let week = thisWeek();
  let plan: WeekPlan | null = null;
  let cards = new Map<string, RecipeCard>();
  const label = h("span", { class: "rc-week__label", "aria-live": "polite" });
  const prevW = h("button", { class: "icon-btn icon-btn--sm", type: "button", "aria-label": "Previous week" }, icons.back());
  const nextW = h("button", { class: "icon-btn icon-btn--sm", type: "button", "aria-label": "Next week" }, icons.chevronRight());
  prevW.addEventListener("click", () => ((week = addDays(week, -7)), void load()));
  nextW.addEventListener("click", () => ((week = addDays(week, 7)), void load()));
  const days = h("ol", { class: "rc-plan" });
  const note = h("div", {});
  const keep = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.check(), "Keep this plan");
  const banner = h("div", { class: "rc-week__banner", role: "status" }, h("p", {}, "Suggested from your calendar. Keep it, or change any day."), keep);
  const again = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Suggest again");
  const toList = h("button", { class: "btn btn--soft", type: "button" }, icons.bag(), "Add the week to the grocery list");
  const lede = h("p", { class: "page-lede" }, "Quick dinners on busy evenings, slower ones when you're free. Drag a day onto another to swap.");

  const el = h(
    "div",
    { class: "view recipes rc-week" },
    pageHead({
      segments: librarySegments("recipes", ctx.go),
      title: "Meal plan",
      lede,
      below: [tabs(ctx, "plan"), h("div", { class: "rc-week__nav" }, prevW, label, nextW)],
    }),
    note,
    banner,
    days,
    h("div", { class: "rc-week__actions" }, toList, again)
  );

  keep.addEventListener("click", () => void store(plan!.days, "Kept"));
  again.addEventListener("click", () => void load(true));
  toList.addEventListener("click", async () => {
    try {
      if (plan?.days.some((d) => d.suggested)) await store(plan.days, null);
      const out = await addToGrocery({ week });
      rememberPantry(out.pantry);
      showToast(`Added the week: ${plural(out.added, "a line", `${out.added} lines`)}`, { icon: "bag", action: { label: "Open", run: () => to(ctx, "list") } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Adding to the list needs a connection", { icon: "wifiOff" });
    }
  });

  async function store(next: WeekPlan["days"], said: string | null) {
    try {
      plan = await savePlan(
        week,
        next.map((d) => ({ date: d.date, recipe_id: d.recipe_id, servings: d.servings }))
      );
      paint();
      if (said) showToast(said, { icon: "check" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    }
  }

  function swap(a: string, b: string) {
    if (!plan || a === b) return;
    const next = plan.days.map((d) => ({ ...d }));
    const da = next.find((d) => d.date === a)!;
    const db = next.find((d) => d.date === b)!;
    [da.recipe_id, db.recipe_id] = [db.recipe_id, da.recipe_id];
    [da.servings, db.servings] = [db.servings, da.servings];
    void store(next, `Swapped ${dayName(a, true).split(" ")[0]} and ${dayName(b, true).split(" ")[0]}`);
  }

  function pick(date: string) {
    const list = h("div", { class: "card card--flush list rc-pick" });
    const others = plan!.days.filter((d) => d.date !== date);
    const swaps = h(
      "div",
      { class: "chip-row chip-row--wrap rc-swaps", role: "group", "aria-label": "Swap with another day" },
      ...others.map((d) => {
        const b = h("button", { class: "chip chip--sm", type: "button" }, dayName(d.date));
        b.addEventListener("click", () => {
          sheet.close();
          swap(date, d.date);
        });
        return b;
      })
    );
    const body = h("div", { class: "rc-picker" }, h("p", { class: "rc-picker__label" }, "Swap with"), swaps, h("p", { class: "rc-picker__label" }, "Or cook"), list);
    const sheet = openSheet({ label: `Dinner on ${dayName(date, true)}`, title: dayName(date, true), body, variant: "tall" });
    const none = h("button", { class: "row", type: "button" }, h("span", { class: "tile tile--sm" }, icons.close()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "No dinner planned")));
    none.addEventListener("click", () => {
      sheet.close();
      void store(plan!.days.map((d) => (d.date === date ? { ...d, recipe_id: null } : d)), null);
    });
    list.append(none);
    for (const c of [...cards.values()].sort((a, b) => a.title.localeCompare(b.title, "en-GB"))) {
      const row = h(
        "button",
        { class: "row", type: "button" },
        photo(c, "sm", "rc-thumb"),
        h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.title), h("span", { class: "row__meta" }, [minutesLabel(c.total_minutes), c.last_cooked ? `cooked ${relativeTime(`${c.last_cooked}T12:00:00Z`)}` : null].filter(Boolean).join(" · ")))
      );
      row.addEventListener("click", () => {
        sheet.close();
        void store(plan!.days.map((d) => (d.date === date ? { ...d, recipe_id: c.id } : d)), null);
      });
      list.append(row);
    }
  }

  function dayRow(d: WeekPlan["days"][number]): HTMLElement {
    const c = d.recipe_id ? cards.get(d.recipe_id) : null;
    const today = d.date === localToday();
    const handle = h("button", { class: "rc-day__handle", type: "button", "aria-label": `Move ${dayName(d.date, true)}'s dinner`, title: "Drag onto another day to swap" }, h("span", { "aria-hidden": "true" }, "⠿"));
    const change = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Change or swap ${dayName(d.date, true)}'s dinner`, title: "Change or swap" }, icons.pen());
    change.addEventListener("click", () => pick(d.date));
    const body = c
      ? h("a", { class: "rc-day__recipe", href: `#/recipes/${encodeURIComponent(c.id)}` }, photo(c, "sm", "rc-thumb"), h("span", { class: "rc-day__name" }, h("span", { class: "rc-day__title" }, c.title), h("span", { class: "rc-day__meta" }, minutesLabel(c.total_minutes))))
      : h("p", { class: "rc-day__empty" }, "Nothing planned");
    const li = h(
      "li",
      { class: `rc-day${d.suggested ? " is-suggested" : ""}${today ? " is-today" : ""}${d.evening.kind === "away" ? " is-away" : ""}`, "data-date": d.date },
      h("div", { class: "rc-day__when" }, h("span", { class: "rc-day__dow" }, dayName(d.date).split(" ")[0]), h("span", { class: "rc-day__num" }, d.date.slice(8).replace(/^0/, ""))),
      h("div", { class: "rc-day__main" }, body, d.evening.kind === "normal" && /^ordinary/i.test(d.reason) ? null : h("p", { class: `rc-day__why rc-day__why--${d.evening.kind}` }, d.reason)),
      h("div", { class: "rc-day__tools" }, change, handle)
    );
    // Drag the handle onto another day to swap (mouse, pen or finger).
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      li.classList.add("is-dragging");
      const y0 = e.clientY;
      let over: HTMLElement | null = null;
      const move = (ev: PointerEvent) => {
        li.style.transform = `translateY(${ev.clientY - y0}px)`;
        const target = (document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n instanceof HTMLElement && n.classList.contains("rc-day") && n !== li) as HTMLElement | undefined) ?? null;
        if (target !== over) {
          over?.classList.remove("is-over");
          over = target;
          over?.classList.add("is-over");
        }
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        li.classList.remove("is-dragging");
        li.style.transform = "";
        over?.classList.remove("is-over");
        if (over?.dataset.date) swap(d.date, over.dataset.date);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
      handle.addEventListener("pointercancel", up, { once: true });
    });
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const other = addDays(d.date, e.key === "ArrowUp" ? -1 : 1);
      if (plan?.days.some((x) => x.date === other)) swap(d.date, other);
    });
    return li;
  }

  function paint() {
    if (!plan) return;
    label.textContent = week === thisWeek() ? `This week · ${weekLabel(week)}` : weekLabel(week);
    days.replaceChildren(...plan.days.map(dayRow));
    const suggested = plan.days.some((d) => d.suggested);
    banner.hidden = !suggested;
    note.replaceChildren(plan.unread.length ? h("p", { class: "rc-offline" }, icons.calendar(), `Couldn't read ${plan.unread.join(" and ")}, so those evenings count as free.`) : "");
  }

  async function load(fresh = false) {
    try {
      const [p, page] = await Promise.all([loadPlan(week, fresh), cards.size ? null : loadRecipes()]);
      if (!alive) return;
      if (page) cards = new Map(page.recipes.map((c) => [c.id, c]));
      plan = p;
      if (p.state === "offline") note.replaceChildren(offlineNote("offline") ?? "");
      paint();
      if (fresh) showToast("New suggestions. Keep them, or change any day.", { icon: "sparkle" });
    } catch (error) {
      if (!alive) return;
      days.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Couldn't load the week"), h("p", { class: "empty__sub" }, error instanceof Error ? error.message : "Try again in a moment.")));
    }
  }
  void load();
  // The plan changed somewhere else (the live channel): the week loads again, unless suggestions are waiting to be kept or a day is being dragged.
  const off = onRecipesElsewhere(() => {
    if (!plan || plan.days.some((d) => d.suggested) || days.querySelector(".is-dragging")) return;
    void load();
  });
  return {
    el,
    destroy: () => {
      alive = false;
      off();
    },
  };
}

// ---------- the grocery list ----------

const PANTRY_NOTE = "athena.recipes.leftOff";
function rememberPantry(list: string[]): void {
  try {
    if (list.length) sessionStorage.setItem(PANTRY_NOTE, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}
function takePantry(): string[] {
  try {
    const raw = sessionStorage.getItem(PANTRY_NOTE);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function amountOf(g: Pick<GroceryItem, "quantity" | "unit">): string {
  return g.quantity === null ? "" : formatAmount({ quantity: g.quantity, quantity_max: null, unit: g.unit });
}

/** A usual as a list line would say it: "2 pints milk". */
const usualText = (u: Usual) => [amountOf(u), u.item].filter(Boolean).join(" ");

/** "every 4 days", "every week", "every 2 weeks". */
function everyWords(days: number): string {
  if (days % 7 === 0) return days === 7 ? "every week" : `every ${days / 7} weeks`;
  return `every ${days} days`;
}
/** "today", "yesterday", "6 days ago", "2 weeks ago". */
function agoWords(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days % 7 === 0) return days === 7 ? "a week ago" : `${days / 7} weeks ago`;
  return `${days} days ago`;
}
/** Why a usual is offered, in words: "Usually every 4 days · bought 4 days ago". */
const usualWhy = (u: Usual) => `Usually ${everyWords(u.every)} · bought ${agoWords(u.since)}`;

/** The lines still to buy, by aisle in the owner's order, as plain text to paste anywhere. */
function listAsText(list: GroceryList): string {
  const groups = groupByAisle(list.items.filter((i) => !i.ticked), learned(list));
  return groups.map((g) => [g.label, ...g.lines.map((l) => `- ${[amountOf(l), l.item].filter(Boolean).join(" ")}`)].join("\n")).join("\n\n");
}

const learned = (list: GroceryList): Aisle[] | null => (list.order?.length ? (list.order as Aisle[]) : null);

/**
 * The list as both its views use it (the list and shopping mode): loading,
 * ticks, "Done shopping" with Undo, and changes made elsewhere arriving over
 * the live channel, which give way to a tick or a change made here.
 */
function groceryModel(paint: () => void) {
  const m = {
    alive: true,
    list: { items: [] } as GroceryList,
    state: "online",
    pending: 0,
    loaded: false,
    failed: null as string | null,
    /** Ticks on their way, and how many changes made here have landed. */
    saving: 0,
    rev: 0,
    took(out: GroceryList & { state?: string }) {
      m.rev++;
      m.list = out;
      if (out.state) m.state = out.state;
      if (m.state === "offline") m.pending++;
      paint();
    },
    async tick(g: GroceryItem, ticked: boolean) {
      g.ticked = ticked;
      paint();
      m.saving++;
      try {
        m.took(await tickGrocery(g.id, ticked));
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
      } finally {
        m.saving--;
      }
    },
    async done() {
      const n = m.list.items.filter((i) => i.ticked).length;
      if (!n) return;
      try {
        const out = await finishShopping();
        m.took(out.list);
        showToast(`Shop saved, ${plural(out.count || n, "one thing", `${out.count || n} things`)} off the list`, {
          icon: "bag",
          timeoutMs: 8000,
          action: {
            label: "Undo",
            run: () =>
              void out
                .undo()
                // Shopping mode may have closed by now: the list that's showing hears it as a change.
                .then((list) => (m.alive ? m.took(list) : recipesChanged()))
                .catch(() => showToast("Couldn't undo that. Check you're online", { icon: "wifiOff" })),
          },
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
      }
    },
    async load() {
      try {
        const out = await loadGrocery();
        if (!m.alive) return;
        m.list = out;
        m.state = out.state;
        m.pending = out.pending;
        m.loaded = true;
        m.failed = null;
      } catch (error) {
        if (!m.alive) return;
        m.failed = error instanceof Error ? error.message : "Try again in a moment.";
      }
      paint();
    },
    destroy: () => undefined as void,
  };
  const online = () => void m.load();
  window.addEventListener("online", online);
  const off = onRecipesElsewhere(async () => {
    if (m.saving) return;
    const at = m.rev;
    const out = await loadGrocery().catch(() => null);
    if (!out || !m.alive || m.saving || at !== m.rev) return;
    m.list = out;
    m.state = out.state;
    m.pending = out.pending;
    paint();
  });
  m.destroy = () => {
    m.alive = false;
    off();
    window.removeEventListener("online", online);
  };
  return m;
}

/** One line of the list: tick it, and take off a line the owner added. */
function groceryLine(g: GroceryItem, model: ReturnType<typeof groceryModel>, opts: { removable: boolean }): HTMLElement {
  const box = h("input", { type: "checkbox", class: "rc-check", "aria-label": `${g.ticked ? "Untick" : "Tick"} ${g.item}` }) as HTMLInputElement;
  box.checked = g.ticked;
  box.addEventListener("change", () => void model.tick(g, box.checked));
  const amount = amountOf(g);
  const remove = opts.removable && g.own ? h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost rc-line__remove", type: "button", "aria-label": `Remove ${g.item}` }, icons.close()) : null;
  remove?.addEventListener("click", async () => {
    try {
      model.took(await removeGrocery(g.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    }
  });
  return h(
    "li",
    { class: `rc-line${g.ticked ? " is-ticked" : ""}` },
    h(
      "label",
      { class: "rc-line__label" },
      box,
      h(
        "span",
        { class: "rc-line__text" },
        h("span", { class: "rc-line__what" }, amount ? h("strong", { class: "rc-line__amount" }, amount) : null, amount ? " " : null, g.item),
        g.recipes.length ? h("span", { class: "rc-line__for" }, g.recipes.map((r) => r.title).join(", ")) : null
      )
    ),
    remove
  );
}

/**
 * The aisles, in the owner's order once it's learned. `steady`: lines keep
 * their place when ticked (shopping mode, where a line moving under the thumb
 * means a wrong tap), and an aisle with everything ticked fades back.
 */
function aisleSections(model: ReturnType<typeof groceryModel>, opts: { removable: boolean; steady?: boolean }): HTMLElement[] {
  const groups = groupByAisle(model.list.items, learned(model.list));
  if (opts.steady) for (const g of groups) g.lines.sort((a, b) => a.item.localeCompare(b.item, "en-GB", { sensitivity: "base" }));
  return groups.map((g) =>
    h(
      "section",
      { class: `rc-aisle${opts.steady && g.lines.every((l) => l.ticked) ? " is-done" : ""}`, "aria-label": g.label },
      h("h2", { class: "rc-aisle__label" }, g.label, h("span", { class: "rc-aisle__n" }, String(g.lines.filter((l) => !l.ticked).length || ""))),
      h("ul", { class: "card card--flush rc-aisle__lines" }, ...g.lines.map((l) => groceryLine(l, model, opts)))
    )
  );
}

/** Copy or share what's left to buy. */
async function shareList(list: GroceryList): Promise<void> {
  const text = listAsText(list);
  if (!text) return;
  const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void>; canShare?: (d: { text?: string }) => boolean };
  if (nav.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await nav.share({ title: "Grocery list", text });
      return;
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied the list", { icon: "copy" });
  } catch {
    showToast("Couldn't copy the list", { icon: "close" });
  }
}

function renderGrocery(ctx: Ctx): Mounted {
  const count = h("span", { class: "page-count" });
  const share = h("button", { class: "icon-btn", type: "button", "aria-label": "Copy or share the list" }, icons.copy());
  const shop = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.bag(), "Shop");
  const addRecipes = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add recipes");
  const own = h("input", { class: "quick-add__input", type: "text", placeholder: "Add an item: 2 lemons", "aria-label": "Add to the list", autocomplete: "off", enterkeyhint: "done" }) as HTMLInputElement;
  const form = h("form", { class: "quick-add rc-own" }, h("span", { class: "quick-add__icon", "aria-hidden": "true" }, icons.plus()), own);
  const leftOff = h("div", {});
  const note = h("div", {});
  const usuals = h("div", {});
  const orderNote = h("div", {});
  const body = h("div", { class: "rc-list", "aria-live": "polite" });
  const done = h("button", { class: "btn btn--primary rc-done", type: "button", hidden: true });

  const model = groceryModel(() => paint());

  const el = h(
    "div",
    { class: "view recipes rc-grocery" },
    pageHead({
      segments: librarySegments("recipes", ctx.go),
      title: "Grocery list",
      count,
      actions: [share, shop],
      below: [tabs(ctx, "list"), h("div", { class: "rc-own-row" }, form, addRecipes)],
    }),
    note,
    leftOff,
    usuals,
    orderNote,
    body,
    done
  );

  const paintLeftOff = () => {
    const off = takePantry();
    if (!off.length) return leftOff.replaceChildren();
    const settings = h("a", { href: "#/settings/recipes" }, "Change in Settings");
    leftOff.replaceChildren(h("p", { class: "rc-leftoff" }, `Left off: ${off.join(", ")}. `, settings, "."));
  };

  /** Put a usual on the list: its row folds away and the line appears in its aisle. */
  async function addUsual(u: Usual, row: HTMLElement | null) {
    row?.querySelectorAll("button").forEach((b) => b.setAttribute("disabled", ""));
    try {
      const out = await addOwnGrocery(usualText(u));
      if (row) await collapse(row);
      model.took(out);
    } catch (error) {
      row?.querySelectorAll("button").forEach((b) => b.removeAttribute("disabled"));
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    }
  }

  async function skip(u: Usual, row: HTMLElement) {
    row.querySelectorAll("button").forEach((b) => b.setAttribute("disabled", ""));
    try {
      const out = await skipUsual(u.item);
      await collapse(row);
      model.took(out);
    } catch (error) {
      row.querySelectorAll("button").forEach((b) => b.removeAttribute("disabled"));
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    }
  }

  function usualRow(u: Usual): HTMLElement {
    const text = usualText(u);
    const add = h("button", { class: "rc-usual__add", type: "button", "aria-label": `Add ${text} to the list` }, icons.plus());
    const no = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost rc-usual__skip", type: "button", "aria-label": `Not this time: ${u.item}`, title: "Not this time" }, icons.close());
    const amount = amountOf(u);
    const row = h(
      "li",
      { class: "rc-usual" },
      add,
      h("span", { class: "rc-line__text" }, h("span", { class: "rc-line__what" }, amount ? h("strong", { class: "rc-line__amount" }, amount) : null, amount ? " " : null, u.item), h("span", { class: "rc-line__for" }, usualWhy(u))),
      no
    );
    add.addEventListener("click", () => void addUsual(u, row));
    no.addEventListener("click", () => void skip(u, row));
    return row;
  }

  /** Three usuals show; the rest fold behind "Show N more", so the list itself stays near the top of a phone. */
  const SHOWN = 3;
  let allUsuals = false;
  function paintUsuals() {
    const due = model.list.usuals ?? [];
    if (!due.length) return usuals.replaceChildren();
    const hidden = allUsuals ? 0 : Math.max(0, due.length - SHOWN);
    const more = hidden ? h("button", { class: "btn btn--ghost btn--sm rc-usuals__more", type: "button", "aria-expanded": "false" }, icons.chevronDown(), `Show ${hidden} more`) : null;
    more?.addEventListener("click", () => {
      allUsuals = true;
      paintUsuals();
      usuals.querySelectorAll<HTMLElement>(".rc-usual").forEach((row, i) => i >= SHOWN && void expand(row));
    });
    const all = due.length > 1 ? h("button", { class: "btn btn--ghost btn--sm rc-usuals__all", type: "button" }, icons.plus(), hidden ? `Add all ${due.length}` : "Add all") : null;
    all?.addEventListener("click", async () => {
      all.setAttribute("disabled", "");
      let added = 0;
      for (const u of due) {
        try {
          model.took(await addOwnGrocery(usualText(u)));
          added++;
        } catch {
          break;
        }
      }
      if (added) showToast(`Added ${plural(added, "one usual", `${added} usuals`)}`, { icon: "bag" });
      else all.removeAttribute("disabled");
    });
    usuals.replaceChildren(
      h(
        "section",
        { class: "rc-usuals", "aria-labelledby": "rc-usuals-title" },
        h("div", { class: "rc-usuals__head" }, h("h2", { class: "rc-usuals__title", id: "rc-usuals-title" }, "Due about now"), all),
        h("ul", { class: "rc-usuals__list" }, ...due.slice(0, due.length - hidden).map(usualRow)),
        more
      )
    );
  }

  function paint() {
    const list = model.list;
    const open = list.items.filter((i) => !i.ticked).length;
    const ticked = list.items.length - open;
    count.textContent = list.items.length ? String(open) : "";
    share.toggleAttribute("disabled", !open);
    done.hidden = !ticked;
    done.replaceChildren(icons.check(), "Done shopping", h("span", { class: "rc-done__n" }, plural(ticked, "1 ticked", `${ticked} ticked`)));
    note.replaceChildren(model.state === "offline" ? (offlineNote("offline", model.pending ? `. ${plural(model.pending, "One change", `${model.pending} changes`)} will go when you're back online` : "") ?? "") : "");
    if (model.failed && !model.loaded) {
      body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Couldn't load the list"), h("p", { class: "empty__sub" }, model.failed)));
      return;
    }
    paintUsuals();
    // Said only when the owner's order puts these aisles differently from the usual one.
    const reordered = !!learned(list) && groupByAisle(list.items, learned(list)).map((g) => g.aisle).join() !== groupByAisle(list.items).map((g) => g.aisle).join();
    orderNote.replaceChildren(reordered ? h("p", { class: "rc-ordernote" }, icons.lines(), "Aisles follow the way you walk your shop") : "");
    if (!list.items.length) {
      body.replaceChildren(
        model.loaded
          ? h(
              "div",
              { class: "empty" },
              h("span", { class: "tile" }, icons.bag()),
              h("p", { class: "empty__title" }, "Nothing on the list"),
              h("p", { class: "empty__sub" }, list.usuals?.length ? "Add your usuals above, a recipe from its page, or the whole week from Meal plan." : "Add a recipe from its page, or the whole week from Meal plan.")
            )
          : ""
      );
      return;
    }
    body.replaceChildren(...aisleSections(model, { removable: true }));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = own.value.trim();
    if (!text) return;
    own.value = "";
    try {
      model.took(await addOwnGrocery(text));
    } catch (error) {
      own.value = text;
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
    }
  });
  done.addEventListener("click", () => void model.done());
  share.addEventListener("click", () => void shareList(model.list));
  shop.addEventListener("click", () => to(ctx, "list/shop"));
  addRecipes.addEventListener("click", () =>
    void openRecipePicker(async (ids) => {
      try {
        const out = await addToGrocery({ recipe_ids: ids });
        rememberPantry(out.pantry);
        model.took({ ...out, state: isSampleMode() ? "sample" : "online" });
        paintLeftOff();
        showToast(`Added ${plural(out.added, "a line", `${out.added} lines`)}`, { icon: "bag" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Adding recipes needs a connection", { icon: "wifiOff" });
      }
    })
  );

  paintLeftOff();
  void model.load();
  return { el, destroy: () => model.destroy() };
}

// ---------- shopping mode ----------

/**
 * #/recipes/list/shop: the list for walking round a shop. Large lines in the
 * order the owner walks, nothing to type, the screen kept on, and "Done
 * shopping" always in reach. Ticks work offline, as on the list.
 */
function renderShop(ctx: Ctx): Mounted {
  let lock: { release: () => Promise<void> } | null = null;
  const exit = () => to(ctx, "list");
  const close = h("button", { class: "icon-btn rc-cook__close", type: "button", "aria-label": "Close shopping mode" }, icons.close());
  close.addEventListener("click", exit);
  const progress = h("p", { class: "rc-cook__count", "aria-live": "polite" });
  const awake = h("p", { class: "rc-cook__awake", hidden: true }, "Screen stays on");
  const bar = h("div", { class: "rc-cook__bar", "aria-hidden": "true" }, h("span", {}));
  const note = h("div", {});
  const body = h("div", { class: "rc-shop__aisles" });
  const done = h("button", { class: "btn btn--primary btn--block rc-shop__done", type: "button" });
  const el = h(
    "div",
    { class: "rc-cook rc-shop", role: "dialog", "aria-modal": "true", "aria-label": "Shopping mode" },
    h("header", { class: "rc-cook__head" }, close, h("div", { class: "rc-cook__head-text" }, h("p", { class: "rc-cook__title" }, "Shopping"), progress), awake),
    bar,
    h("div", { class: "rc-shop__main" }, note, body),
    h("footer", { class: "rc-shop__foot" }, done)
  );

  const model = groceryModel(() => paint());

  function paint() {
    const items = model.list.items;
    const ticked = items.filter((i) => i.ticked).length;
    progress.textContent = items.length ? `${ticked} of ${items.length} in the basket` : "";
    (bar.firstChild as HTMLElement).style.width = items.length ? `${(ticked / items.length) * 100}%` : "0";
    note.replaceChildren(model.state === "offline" ? (offlineNote("offline", ". Ticks are kept here until you're back online") ?? "") : "");
    done.toggleAttribute("disabled", !ticked);
    done.replaceChildren(icons.check(), ticked && ticked === items.length ? "Done shopping" : ticked ? `Done shopping · ${ticked} ticked` : "Tick things as they go in the basket");
    if (model.failed && !model.loaded) {
      body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Couldn't load the list"), h("p", { class: "empty__sub" }, model.failed)));
      return;
    }
    if (model.loaded && !items.length) {
      const back = h("button", { class: "btn btn--soft", type: "button" }, icons.back(), "Back to the list");
      back.addEventListener("click", exit);
      body.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.bag()), h("p", { class: "empty__title" }, "Nothing left to buy"), back));
      return;
    }
    body.replaceChildren(...aisleSections(model, { removable: false, steady: true }));
  }

  done.addEventListener("click", async () => {
    await model.done();
    if (!model.list.items.length) exit();
  });
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && exit();
  document.addEventListener("keydown", onKey);

  // Keep the screen on in the shop; ask again when the page comes back (the browser lets it go when hidden).
  const wake = async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wl || document.visibilityState !== "visible" || !model.alive) return;
    try {
      lock = await wl.request("screen");
      awake.hidden = false;
    } catch {
      awake.hidden = true;
    }
  };
  const onVisible = () => document.visibilityState === "visible" && void wake();
  document.addEventListener("visibilitychange", onVisible);
  void wake();
  document.documentElement.classList.add("is-cooking");
  void model.load();

  return {
    el,
    destroy: () => {
      model.destroy();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.classList.remove("is-cooking");
      void lock?.release().catch(() => undefined);
    },
  };
}

/** Pick recipes for the list: tick any number, then Add. */
async function openRecipePicker(done: (ids: string[]) => void): Promise<void> {
  const chosen = new Set<string>();
  const add = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: true }, "Add to the list");
  const rows = h("div", { class: "card card--flush list rc-pick" });
  const sheet = openSheet({ label: "Add recipes to the list", title: "Add recipes", body: h("div", { class: "rc-picker" }, rows, add), variant: "tall" });
  add.addEventListener("click", () => {
    sheet.close();
    done([...chosen]);
  });
  const page = await loadRecipes();
  for (const c of page.recipes) {
    const box = h("input", { type: "checkbox", class: "rc-check" }) as HTMLInputElement;
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(c.id);
      else chosen.delete(c.id);
      add.toggleAttribute("disabled", !chosen.size);
      add.textContent = chosen.size ? `Add ${plural(chosen.size, "1 recipe", `${chosen.size} recipes`)}` : "Add to the list";
    });
    rows.append(h("label", { class: "row" }, box, photo(c, "sm", "rc-thumb"), h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.title), h("span", { class: "row__meta" }, `${c.ingredient_count} ingredients`))));
  }
}
