/**
 * Food, drink and mind on a day page (a Day's health carries these fields
 * beside the body figures), from Apple Health or Oura (sealed like
 * every health figure; lib/health.ts).
 *  - foodRow: one line under the Body block's rows, "1,950 kcal · 3 coffees
 *    · 2 drinks · 1.8 L water", with "Last coffee 15:40, last meal 20:15"
 *    under it.
 *  - mindStrip: beside the mood picker, mindful minutes and, on a day the
 *    owner left without a mood, State of Mind's mood labelled "from Health".
 *    Athena's own mood always wins: the strip never sets or changes it.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { foodLine, valenceWord } from "../../../lib/health-line";
import type { FoodMind } from "../db/health";
import "../styles/day-food.css";
import { clockOfDay } from "../lib/clock";

/** The Body block's Food and drink row, or null on a day with none of it. */
export function foodRow(day: object | undefined): HTMLElement | null {
  const health = day as FoodMind | undefined;
  if (!health) return null;
  // The times go under the line, so the figures stay on one or two short lines in the rail.
  const words = foodLine({ ...health, caffeine_last: undefined }, { mindful: false });
  if (!words) return null;
  // Each figure stays whole ("1.8 L water"); the line breaks only between them.
  const line = words.split(" · ").map((p) => p.replace(/ /g, "\u00a0")).join("\u00a0· ");
  const aside = [health.caffeine_mg && health.caffeine_last ? `Last coffee ${clockOfDay(health.caffeine_last)}` : "", health.last_meal ? `last meal ${clockOfDay(health.last_meal)}` : ""].filter(Boolean).join(", ").replace(/^l/, "L");
  return h(
    "li",
    { class: "day-health__row day-health__row--food" },
    h("span", { class: "day-health__icon", "aria-hidden": "true" }, icons.cup()),
    h("span", { class: "day-health__words" }, h("span", { class: "visually-hidden" }, "Food and drink: "), h("span", { class: "day-health__text day-food__line" }, line), aside ? h("span", { class: "day-health__aside" }, aside) : null)
  );
}

/** A Body block of its own, for a day with food and drink but no sleep, steps or workouts. */
export function foodSection(health: object | undefined): HTMLElement | null {
  const row = foodRow(health);
  if (!row) return null;
  return h(
    "section",
    { class: "day-sec day-health", "aria-labelledby": "day-food-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-food-title" }, "Food and drink")),
    h("ul", { class: "day-health__list", role: "list" }, row)
  );
}

/**
 * The Mind strip, or null with nothing to show. `ownMood`: the owner set a
 * mood for the day, so State of Mind stays out of it.
 */
export function mindStrip(day: object | undefined, ownMood: boolean): HTMLElement | null {
  const health = day as FoodMind | undefined;
  if (!health) return null;
  const mindful = health.mindful_minutes ? Math.round(health.mindful_minutes) : 0;
  const fromHealth = !ownMood && health.mood_valence !== undefined ? valenceWord(health.mood_valence) : null;
  if (!mindful && !fromHealth) return null;
  const labels = fromHealth && health.mood_labels?.length ? health.mood_labels.slice(0, 3).join(", ") : null;
  return h(
    "p",
    { class: "day-mind", "aria-label": [mindful ? `${mindful} minutes mindful` : "", fromHealth ? `Mood from Apple Health: ${fromHealth}${labels ? `, ${labels}` : ""}` : ""].filter(Boolean).join(". ") },
    mindful ? h("span", { class: "day-mind__item", "aria-hidden": "true" }, h("span", { class: "day-mind__icon" }, icons.leaf()), h("span", {}, h("strong", {}, `${mindful} min`), " mindful")) : null,
    fromHealth
      ? h(
          "span",
          { class: "day-mind__item day-mind__item--mood", "aria-hidden": "true" },
          h("span", { class: "day-mind__icon" }, icons.heart()),
          h("span", {}, h("strong", {}, fromHealth), labels ? ` · ${labels}` : ""),
          h("span", { class: "day-mind__from" }, "from Health")
        )
      : null
  );
}
