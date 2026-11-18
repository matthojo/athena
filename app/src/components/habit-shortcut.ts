/**
 * Settings → From your iPhone → Habits: a "Log a habit" Shortcut, so
 * "Hey Siri, log a habit" ticks one of the owner's own habits, or adds to a
 * target ("two glasses"). It posts to POST /api/habits/log with a capture
 * key (netlify/lib/habits/routes.ts); the habit is matched by name in any
 * case, and the reply's message is what Siri reads out.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { freshKeyCard } from "./api-keys";
import { copyLine } from "./shortcut-panel";
import { makeKey } from "./api-keys";

export function habitShortcutPanel(opts: { manageKeys: () => void }): HTMLElement {
  const endpoint = `${location.origin}/api/habits/log`;
  let fresh: string | null = null;
  const root = h("div", { class: "shortcut" });

  async function make(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      fresh = (await makeKey("Habits", "capture")).token;
      paint();
    } catch (error) {
      btn.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't make a key", { icon: "close", timeoutMs: 5000 });
    }
  }

  function paint() {
    const step = (...children: Array<Node | string | null>) => h("li", { class: "shortcut__step" }, ...children);
    const steps = h(
      "ol",
      { class: "card shortcut__steps" },
      step("In the Shortcuts app, tap ", h("strong", {}, "+"), " and name the shortcut ", h("strong", {}, "Log a habit"), "."),
      step("Add ", h("strong", {}, "Ask for Input"), " with the question ", h("strong", {}, "Which habit?"), " For a habit with a target, add a second one that asks ", h("strong", {}, "How many?"), " and set its type to Number."),
      step(
        "Add ",
        h("strong", {}, "Get Contents of URL"),
        ". Set the method to POST and add a header called Authorization. Set the request body to JSON, with a text field ",
        h("strong", {}, "habit"),
        " set to the first answer, and a number field ",
        h("strong", {}, "count"),
        " set to the second if you added it.",
        copyLine("URL", endpoint, "Address"),
        fresh ? copyLine("Authorization", `Bearer ${fresh}`, "Key") : h("p", { class: "shortcut__hint" }, "For Authorization, use “Bearer” and a space, then a capture key. Make one below, or use the key from your Athena Shortcut.")
      ),
      step("Add ", h("strong", {}, "Get Dictionary Value"), " for ", h("strong", {}, "message"), ", then ", h("strong", {}, "Speak Text"), ", so Siri says what was logged."),
      step("Say ", h("strong", {}, "“Hey Siri, log a habit”"), " and answer with the habit's name. Any case works, and the first word is enough when only one habit starts with it.")
    );
    const makeBtn = h("button", { class: `btn ${fresh ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), fresh ? "Make another capture key" : "Make a capture key") as HTMLButtonElement;
    makeBtn.addEventListener("click", () => void make(makeBtn));
    const manage = h("button", { class: "settings__link", type: "button" }, "API keys");
    manage.addEventListener("click", () => opts.manageKeys());
    root.replaceChildren(
      ...[
        fresh ? freshKeyCard(fresh) : null,
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h2", { class: "group__label" }, "Set up the Shortcut")), steps),
        h(
          "p",
          { class: "shortcut__hint" },
          "Leave out count to tick a habit, or to add one to a target. Send date as yesterday, or as 2026-11-07, to log an earlier day. A count of 0 clears the day."
        ),
        h("div", { class: "shortcut__actions" }, makeBtn),
        h("p", { class: "shortcut__manage" }, icons.key(), "A capture key can only send things in. See and remove keys in ", manage),
      ].filter((x): x is HTMLElement => !!x)
    );
  }

  paint();
  return root;
}
