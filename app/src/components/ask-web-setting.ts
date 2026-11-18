/**
 * Settings → Ask: "Let Ask search the web" (owner, 12 Nov 2026). On by
 * default. While it's on, a question your own notes and accounts don't
 * answer can be looked up on the web; the answer says it came from there and
 * its sources are the pages (lib/ask-contract.ts). While it's off, Ask
 * answers only from what's yours and from general knowledge. Built like
 * ask-money-setting.ts, on GET/PUT /api/profile/ask-web.
 */
import "../styles/life.css";
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { loadAskWeb, setAskWeb } from "../db/api";

export function askWebSetting(): HTMLElement {
  const id = "ask-web";
  // On until the server says otherwise, as the setting itself is.
  const input = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub`, checked: true, disabled: true }) as HTMLInputElement;
  void loadAskWeb().then(
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
      await setAskWeb(on);
      showToast(on ? "Ask can search the web now" : "Ask won't search the web now", { icon: "check" });
    } catch {
      input.checked = !on;
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      input.disabled = false;
    }
  });
  return h(
    "label",
    { class: "life-prefs__row ask-web", for: id, "data-setting": "ask-web" },
    h(
      "span",
      { class: "life-prefs__words" },
      h("span", { class: "life-prefs__name" }, "Let Ask search the web"),
      h("span", { class: "life-prefs__sub", id: `${id}-sub` }, "Ask searches the web when your notes and accounts don\u2019t answer a question. The answer names the pages it used.")
    ),
    input
  );
}
