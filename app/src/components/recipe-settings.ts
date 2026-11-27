/**
 * Settings → Recipes: the pantry staples the grocery list leaves off (salt,
 * oil and the like), the units a recipe opens in, and what the list learns
 * from past shops (usuals offered when they're due, and forgetting every
 * shop). Kept on the server (GET/PUT /api/recipes/prefs, GET/DELETE
 * /api/recipes/grocery/history), so every device agrees; sample mode keeps
 * them in memory.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { choiceChips } from "./fields";
import { confirmDialog } from "./confirm";
import { forgetGroceryHistory, loadGroceryHistory, loadRecipePrefs, saveRecipePrefs } from "../db/recipes";
import { plural } from "../lib/format";
import "../styles/life.css";
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

  // What the list learns from past shops.
  const usualsId = "recipes-usuals";
  const usuals = h("input", { type: "checkbox", role: "switch", class: "switch", id: usualsId, "aria-describedby": `${usualsId}-sub`, checked: true, disabled: true }) as HTMLInputElement;
  usuals.addEventListener("change", () => void save({ usuals: usuals.checked }, usuals.checked ? "The list will offer your usuals" : "The list won't offer usuals now"));
  const historyWords = h("span", { class: "life-prefs__sub" }, " ");
  const forget = h("button", { class: "btn btn--soft btn--sm", type: "button", disabled: true }, "Forget");
  const paintHistory = (hist: { shops: number; since: string | null } | null) => {
    if (!hist) return void (historyWords.textContent = "Couldn't check. You may be offline.");
    historyWords.textContent = hist.shops
      ? `${plural(hist.shops, "One shop", `${hist.shops} shops`)} since ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${hist.since}T12:00:00Z`))}. Your usuals and aisle order come from these.`
      : "None yet. Tap Done shopping on the list when you've finished a shop.";
    forget.toggleAttribute("disabled", !hist.shops);
  };
  forget.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Forget your past shops?", body: "The list stops offering usuals and sorts aisles the standard way until you've done a few more shops. What's on the list now stays.", confirmLabel: "Forget" });
    if (!ok) return;
    forget.setAttribute("disabled", "");
    try {
      const out = await forgetGroceryHistory();
      paintHistory({ shops: 0, since: null });
      showToast(`Forgot ${plural(out.shops, "one shop", `${out.shops} shops`)}`, { icon: "check" });
    } catch {
      forget.removeAttribute("disabled");
      showToast("That didn't go through. Check you're online", { icon: "wifiOff" });
    }
  });

  async function save(patch: { pantry?: string[]; system?: UnitSystem; usuals?: boolean }, said?: string) {
    try {
      const out = await saveRecipePrefs(patch);
      pantry = out.pantry;
      usuals.checked = out.usuals;
      units.set(out.system);
      paint();
      if (said) showToast(said, { icon: "check" });
    } catch {
      if (patch.usuals !== undefined) usuals.checked = !patch.usuals;
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
    usuals.checked = p.usuals;
    usuals.disabled = false;
    paint();
  });
  void loadGroceryHistory().then(paintHistory);

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--recipes", "aria-labelledby": "settings-recipes" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-recipes" }, icons.pot(), "Recipes")),
      h("p", { class: "settings__lede" }, "What the grocery list leaves off, what it learns from your shops, and the units recipes open in."),
      h(
        "div",
        { class: "settings__body" },
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Pantry staples")), h("div", { class: "card rs-pantry__card" }, chips, form, reset)),
        h("p", { class: "form__hint" }, "Things you always have in. Athena matches the name, so “sea salt” counts as salt but “red pepper” isn't black pepper."),
        h(
          "section",
          { class: "group" },
          h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Past shops")),
          h(
            "div",
            { class: "card rs-shops" },
            h(
              "label",
              { class: "life-prefs__row", for: usualsId },
              h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "Offer my usuals"), h("span", { class: "life-prefs__sub", id: `${usualsId}-sub` }, "Things you buy every so often show at the top of the list when they're due.")),
              usuals
            ),
            h("div", { class: "life-prefs__row rs-shops__forget" }, h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "What the list remembers"), historyWords), forget)
          )
        ),
        h("p", { class: "form__hint" }, "Done shopping keeps what you ticked and when. It stays in your Athena, encrypted like the list itself, and none of it goes to a model."),
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Units")), units.el),
        h("p", { class: "form__hint" }, "You can switch on any recipe too. Spoons and counts stay as they are.")
      )
    ),
    destroy: () => undefined,
  };
}
