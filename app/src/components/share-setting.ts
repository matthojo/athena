/**
 * Settings → About you: "Always save what I share from this device". Off by
 * default; also offered as a tick box the first time a
 * share waits for a tap (views/saved.ts). Per device (db/share-prefs.ts).
 */
import "../styles/life.css";
import "../styles/knows.css";
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { alwaysSaveShares, setAlwaysSaveShares } from "../db/share-prefs";

export function shareSetting(): HTMLElement {
  const id = "share-always";
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
  input.checked = alwaysSaveShares();
  input.addEventListener("change", () => {
    setAlwaysSaveShares(input.checked);
    showToast(input.checked ? "Shares from this device save without asking now" : "Athena will ask before saving a share", { icon: "check" });
  });
  return h(
    "label",
    { class: "life-prefs__row ask-money", for: id, "data-setting": "share-always" },
    h(
      "span",
      { class: "life-prefs__words" },
      h("span", { class: "life-prefs__name" }, "Always save what I share from this device"),
      h("span", { class: "life-prefs__sub", id: `${id}-sub` }, "When you share to Athena and it can't tell the share came from your share sheet, save it without asking. A form on another website is always refused.")
    ),
    input
  );
}
