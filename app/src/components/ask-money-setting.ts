/**
 * Settings → About you: "Let Ask read transactions" (owner, 9 Nov 2026).
 * Off by default. While it's off, Ask isn't given your card payments and
 * direct debits at all (lib/ask-tools.ts), and a spending question gets
 * "Money search is off" with a link back here. Separate from the Days switch
 * that shows a day's spending line.
 */
import "../styles/life.css";
import "../styles/knows.css";
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { loadAskMoney, setAskMoney } from "../db/knows";

export function askMoneySetting(): HTMLElement {
  const id = "ask-money";
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub`, disabled: true }) as HTMLInputElement;
  void loadAskMoney().then(
    (on) => {
      input.checked = on;
      input.disabled = false;
    },
    () => undefined
  );
  input.addEventListener("change", async () => {
    const on = input.checked;
    input.disabled = true;
    try {
      await setAskMoney(on);
      showToast(on ? "Ask can read your payments now" : "Ask can't read your payments now", { icon: "check" });
    } catch {
      input.checked = !on;
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      input.disabled = false;
    }
  });
  return h(
    "label",
    { class: "life-prefs__row ask-money", for: id, "data-setting": "ask-money" },
    h(
      "span",
      { class: "life-prefs__words" },
      h("span", { class: "life-prefs__name" }, "Let Ask read transactions"),
      h("span", { class: "life-prefs__sub", id: `${id}-sub` }, "Card payments and direct debits from your banking sources, so Ask can answer “how much did I spend at Tesco?”. Never your balance.")
    ),
    input
  );
}
