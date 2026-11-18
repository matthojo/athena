/**
 * Settings → Days: whether each day shows what you spent (Monzo, Starling)
 * and your electricity (Octopus Energy). Both off until turned on: they're
 * sealed and personal, so the server leaves them out of a day until then
 * (lib/money.ts). Saved on the server, so every device agrees.
 */

import "../styles/life.css";
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { loadMoneyPrefs, saveMoneyPrefs, type MoneyPrefs } from "../db/life";
import { colourBy, setColourBy } from "./day-colour";

const ROWS: Array<{ key: keyof MoneyPrefs; name: string; sub: string }> = [
  { key: "money", name: "Money", sub: "What you spent that day, from your banking sources" },
  { key: "home", name: "Home", sub: "Your electricity and gas that day, from your energy supplier" },
];

export function moneyHomeSettings(): HTMLElement {
  const box = h("fieldset", { class: "life-prefs", "aria-busy": "true" }, h("legend", { class: "mood-styles__legend" }, "Show on each day"));
  const note = h("p", { class: "life-prefs__note" }, "Only you see these. They stay off until you turn them on.");
  void loadMoneyPrefs()
    .catch(() => ({ money: false, home: false }))
    .then((prefs) => {
      box.removeAttribute("aria-busy");
      for (const row of ROWS) {
        const id = `life-pref-${row.key}`;
        const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
        input.checked = prefs[row.key];
        input.addEventListener("change", async () => {
          const on = input.checked;
          input.disabled = true;
          try {
            await saveMoneyPrefs({ [row.key]: on });
            showToast(on ? `${row.name} shows on each day` : `${row.name} is off on Days`, { icon: "check" });
          } catch {
            input.checked = !on;
            showToast("That didn't save. Check you're online", { icon: "wifiOff" });
          } finally {
            input.disabled = false;
          }
        });
        box.append(h("label", { class: "life-prefs__row", for: id }, h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, row.name), h("span", { class: "life-prefs__sub", id: `${id}-sub` }, row.sub)), input));
      }
      box.append(note);
    });
  return box;
}

/** Settings → Days: what the calendar's colour shows. Kept on this device. */
export function colourBySettings(): HTMLElement {
  const box = h("fieldset", { class: "life-prefs" }, h("legend", { class: "mood-styles__legend" }, "Colour days by"));
  const now = colourBy();
  for (const [id, name, sub] of [
    ["activity", "How full the day was", "What you did, wrote and saved"],
    ["habits", "Habits done", "Darker when more of the day's habits were ticked off"],
  ] as const) {
    const inputId = `colour-by-${id}`;
    const input = h("input", { type: "radio", name: "colour-by", value: id, id: inputId, class: "life-prefs__radio", "aria-describedby": `${inputId}-sub` }) as HTMLInputElement;
    input.checked = now === id;
    input.addEventListener("change", () => input.checked && setColourBy(id));
    box.append(h("label", { class: "life-prefs__row", for: inputId }, h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, name), h("span", { class: "life-prefs__sub", id: `${inputId}-sub` }, sub)), input));
  }
  return box;
}
