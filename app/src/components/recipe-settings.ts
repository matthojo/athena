/**
 * Settings → Recipes: the pantry staples the grocery list leaves off (salt,
 * oil and the like), and the units a recipe opens in. Kept on the server
 * (GET/PUT /api/recipes/prefs), so every device agrees; sample mode keeps
 * them in memory.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { choiceChips } from "./fields";
import { loadRecipePrefs, saveRecipePrefs } from "../db/recipes";
import { DEFAULT_PANTRY } from "../../../lib/grocery";
import type { UnitSystem } from "../../../lib/recipe-units";
import "../styles/recipes.css";

export function recipeSettingsSection(): { el: HTMLElement; destroy: () => void } {
  let pantry: string[] = [];
  const chips = h("ul", { class: "rs-pantry", "aria-label": "Pantry staples" });
  const add = h("input", { class: "prop__input rs-pantry__input", type: "text", placeholder: "Add a staple: plain flour", "aria-label": "Add a pantry staple", autocomplete: "off", enterkeyhint: "done" }) as HTMLInputElement;
  const form = h("form", { class: "rs-pantry__add" }, add, h("button", { class: "btn btn--soft btn--sm", type: "submit" }, "Add"));
  const reset = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Back to the usual list");
  const units = choiceChips<UnitSystem>(
    "Units",
    [
      { value: "metric", label: "Metric (g, ml)" },
      { value: "imperial", label: "Imperial (oz, cups)" },
    ],
    "metric",
    (system) => void save({ system }, "Recipes open in that now")
  );

  async function save(patch: { pantry?: string[]; system?: UnitSystem }, said?: string) {
    try {
      const out = await saveRecipePrefs(patch);
      pantry = out.pantry;
      units.set(out.system);
      paint();
      if (said) showToast(said, { icon: "check" });
    } catch {
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    }
  }

  function paint() {
    chips.replaceChildren(
      ...pantry.map((p) => {
        const x = h("button", { class: "rs-pantry__x", type: "button", "aria-label": `Remove ${p}` }, icons.close());
        x.addEventListener("click", () => void save({ pantry: pantry.filter((q) => q !== p) }));
        return h("li", { class: "chip rs-pantry__chip" }, p, x);
      })
    );
    if (!pantry.length) chips.append(h("li", { class: "rs-pantry__none" }, "Nothing. Every ingredient goes on the list."));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const words = add.value.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (!words.length) return;
    add.value = "";
    void save({ pantry: [...pantry, ...words.filter((w) => !pantry.includes(w))] });
  });
  reset.addEventListener("click", () => void save({ pantry: [...DEFAULT_PANTRY] }, "Back to salt, pepper, oils and water"));

  void loadRecipePrefs().then((p) => {
    pantry = p.pantry;
    units.set(p.system);
    paint();
  });

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--recipes", "aria-labelledby": "settings-recipes" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-recipes" }, icons.pot(), "Recipes")),
      h("p", { class: "settings__lede" }, "What the grocery list leaves off, and the units recipes open in."),
      h(
        "div",
        { class: "settings__body" },
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Pantry staples")), h("div", { class: "card rs-pantry__card" }, chips, form, reset)),
        h("p", { class: "form__hint" }, "Things you always have in. Athena matches the name, so “sea salt” counts as salt but “red pepper” isn't black pepper."),
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Units")), units.el),
        h("p", { class: "form__hint" }, "You can switch on any recipe too. Spoons and counts stay as they are.")
      )
    ),
    destroy: () => undefined,
  };
}
