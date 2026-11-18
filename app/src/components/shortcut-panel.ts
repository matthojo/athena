/**
 * Capture from your iPhone: set up an "Athena" Shortcut that Siri and the
 * share sheet can use. It sends with a capture-only API key, made here in
 * one tap (or in Settings → API keys, where every key is listed and can be
 * removed). The key only lets a Shortcut send things in to be filed (POST
 * /api/assistant/capture); it's shown once, when it's made. Shown in full
 * on Settings → From your iPhone (components/connector-settings.ts).
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { copyText, freshKeyCard } from "./api-keys";
import { listKeys, makeKey } from "./api-keys";
import { plural } from "../lib/format";

/** A value to type into the Shortcut, with a Copy button. */
export function copyLine(label: string, value: string, copyAs: string): HTMLElement {
  const btn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Copy ${label.toLowerCase()}` }, "Copy");
  btn.addEventListener("click", () => void copyText(value, copyAs));
  return h("div", { class: "shortcut__value" }, h("span", { class: "shortcut__value-label" }, label), h("code", { class: "prop__mono shortcut__value-text" }, value), btn);
}

/** The steps, a key to make, and where the keys are kept. */
export function shortcutPanel(opts: { manageKeys: () => void }): HTMLElement {
  const endpoint = `${location.origin}/api/assistant/capture`;
  let captureKeys: number | null = null;
  let fresh: string | null = null;

  const root = h("div", { class: "shortcut" });

  async function count() {
    try {
      captureKeys = (await listKeys(false)).filter((k) => k.scope === "capture").length;
    } catch {
      captureKeys = null;
    }
    paint();
  }

  async function make(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      const made = await makeKey(captureKeys ? `iPhone ${captureKeys + 1}` : "iPhone", "capture");
      fresh = made.token;
      captureKeys = (captureKeys ?? 0) + 1;
      paint();
    } catch (error) {
      btn.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't make a key", { icon: "close", timeoutMs: 5000 });
    }
  }

  function steps(): HTMLElement {
    const step = (...children: Array<Node | string | null>) => h("li", { class: "shortcut__step" }, ...children);
    return h(
      "ol",
      { class: "card shortcut__steps" },
      step("In the Shortcuts app, tap ", h("strong", {}, "+"), " and name the shortcut ", h("strong", {}, "Athena"), "."),
      step("Tap ", h("strong", {}, "ⓘ"), " and turn on ", h("strong", {}, "Show in Share Sheet"), ". Let it receive Text and URLs, and if there's no input, choose ", h("strong", {}, "Ask For Text"), ". That's what Siri listens for."),
      step(
        "Add ",
        h("strong", {}, "Get Contents of URL"),
        ". Set the method to POST, add a header called Authorization, and set the request body to Form with a text field called text, set to Shortcut Input.",
        copyLine("URL", endpoint, "Address"),
        fresh ? copyLine("Authorization", `Bearer ${fresh}`, "Key") : h("p", { class: "shortcut__hint" }, "For Authorization, use “Bearer” and a space, then a capture key. Make one below.")
      ),
      step("Add ", h("strong", {}, "Show Result"), " (or ", h("strong", {}, "Speak Text"), ") with the Contents of URL, so you hear what Athena did."),
      step("Say ", h("strong", {}, "“Hey Siri, Athena”"), ", or share a link and pick Athena.")
    );
  }

  function paint() {
    const makeBtn = h("button", { class: `btn ${fresh ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), fresh ? "Make another capture key" : "Make a capture key") as HTMLButtonElement;
    makeBtn.addEventListener("click", () => void make(makeBtn));
    const manage = h("button", { class: "settings__link", type: "button" }, "API keys");
    manage.addEventListener("click", () => opts.manageKeys());
    const have = captureKeys ? `You have ${captureKeys} capture ${plural(captureKeys, "key", "keys")}. ` : "";
    root.replaceChildren(
      ...[
        fresh ? freshKeyCard(fresh) : null,
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h2", { class: "group__label" }, "Set up the Shortcut")), steps()),
        h("div", { class: "shortcut__actions" }, makeBtn),
        h("p", { class: "shortcut__manage" }, icons.key(), have, "See and remove keys in ", manage),
      ].filter((x): x is HTMLElement => !!x)
    );
  }

  paint();
  void count();
  return root;
}
