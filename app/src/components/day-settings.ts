/**
 * Settings, Days: how mood is drawn. Three choices, each shown with its five
 * steps so the owner sees what they'd get before picking. The choice applies
 * at once, everywhere mood shows (the day, Today, the feed, the calendar
 * and recaps), and is kept on this device. Then memories on Home: one day
 * from an earlier year each morning, on by default, kept for every device.
 */

import "../styles/days.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { MOODS } from "./day-words";
import { MOOD_STYLES, moodGlyph, moodStyle, setMoodStyle, type MoodStyle } from "./day-mood";
import { colourBySettings, moneyHomeSettings } from "./life-settings";
import { showToast } from "./toast";
import { memoryPrefs, setMemoriesOn, syncMemoryPrefs } from "../db/memories-app";
import { workingHoursSettings } from "./working-hours";

/** "Memories on Home": on by default; the same on every device (lib/day-prefs.ts). */
function memoriesSettings(): HTMLElement {
  const id = "days-memories";
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
  input.checked = memoryPrefs().on;
  void syncMemoryPrefs().then((p) => {
    if (!input.disabled) input.checked = p.on;
  });
  input.addEventListener("change", async () => {
    const on = input.checked;
    input.disabled = true;
    try {
      await setMemoriesOn(on);
      showToast(on ? "Memories are back on Home" : "No more memories on Home", { icon: "check" });
    } catch {
      input.checked = !on;
      await setMemoriesOn(!on).catch(() => undefined);
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      input.disabled = false;
    }
  });
  return h(
    "fieldset",
    { class: "life-prefs" },
    h("legend", { class: "mood-styles__legend" }, "Memories"),
    h(
      "label",
      { class: "life-prefs__row", for: id },
      h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "Memories on Home"), h("span", { class: "life-prefs__sub", id: `${id}-sub` }, "A day from an earlier year each morning, in your own words when you wrote some.")),
      input
    ),
    h("p", { class: "life-prefs__note" }, "Memories stay in the app and are never sent as a notification. Tap Not this one under a memory and that day won't come back.")
  );
}

export function daysSettingsSection(): { el: HTMLElement; destroy: () => void } {
  const chosen = moodStyle();
  const choice = (id: MoodStyle, name: string) => {
    const input = h("input", { class: "mood-style__input", type: "radio", name: "mood-style", value: id }) as HTMLInputElement;
    input.checked = id === chosen;
    input.addEventListener("change", () => input.checked && setMoodStyle(id));
    return h(
      "label",
      { class: "mood-style" },
      input,
      h("span", { class: "mood-style__name" }, name),
      h(
        "span",
        { class: "mood-style__preview", "aria-hidden": "true" },
        ...MOODS.map(({ value, word }) => h("span", { class: "mood-style__step" }, moodGlyph(value, { size: "md", label: false, style: id }), h("span", { class: "mood-style__word" }, word)))
      )
    );
  };
  return {
    el: h(
      "section",
      { class: "settings__section settings__section--days", "aria-labelledby": "settings-days" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-days" }, icons.calendar(), "Days")),
      h("p", { class: "settings__lede" }, "Choose how your mood looks, and what else each day shows."),
      h(
        "div",
        { class: "settings__body" },
        h("fieldset", { class: "mood-styles" }, h("legend", { class: "mood-styles__legend" }, "Mood"), ...MOOD_STYLES.map((s) => choice(s.id, s.name))),
        colourBySettings(),
        memoriesSettings(),
        workingHoursSettings(),
        moneyHomeSettings()
      )
    ),
    destroy: () => undefined,
  };
}
