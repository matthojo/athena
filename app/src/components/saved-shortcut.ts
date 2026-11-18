/**
 * Settings → From your iPhone → Save to Athena: a Share-sheet Shortcut that
 * sends a link, some text or a picture to POST /api/saved with a capture key
 * (netlify/lib/saved/routes.ts). It also works by voice: with no input, it
 * asks for the text. The installed app on Android and desktop Chrome is a
 * share target instead (manifest.json), so it needs nothing set up.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { freshKeyCard } from "./api-keys";
import { copyLine } from "./shortcut-panel";
import { makeKey } from "./api-keys";

export function savedShortcutPanel(opts: { manageKeys: () => void }): HTMLElement {
  const endpoint = `${location.origin}/api/saved`;
  let fresh: string | null = null;
  const root = h("div", { class: "shortcut" });

  async function make(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      fresh = (await makeKey("Save to Athena", "capture")).token;
      paint();
    } catch (error) {
      btn.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't make a key", { icon: "close", timeoutMs: 5000 });
    }
  }

  function paint() {
    const step = (...children: Array<Node | string | null>) => h("li", { class: "shortcut__step" }, ...children);
    const b = (t: string) => h("strong", {}, t);
    const steps = h(
      "ol",
      { class: "card shortcut__steps" },
      step("In the Shortcuts app, tap ", b("+"), " and name the shortcut ", b("Save to Athena"), ". In its details (", b("ⓘ"), "), turn on ", b("Show in Share Sheet"), "."),
      step("In the first block, set it to receive ", b("Images"), ", ", b("URLs"), " and ", b("Text"), ". Under “If there's no input”, choose ", b("Ask For"), " ", b("Text"), ", so you can also say “Hey Siri, Save to Athena”."),
      step("Add ", b("Get Type"), " of Shortcut Input, then ", b("If"), " Type ", b("is"), " Image."),
      step(
        "Inside If: add ",
        b("Convert Image"),
        " to JPEG, then ",
        b("Get Contents of URL"),
        ". Method POST, a header called Authorization, and Request Body ",
        b("Form"),
        " with a File field ",
        b("image"),
        " set to the Converted Image and a Text field ",
        b("source"),
        " set to shortcut.",
        copyLine("URL", endpoint, "Address"),
        fresh ? copyLine("Authorization", `Bearer ${fresh}`, "Key") : h("p", { class: "shortcut__hint" }, "For Authorization, use “Bearer” and a space, then a capture key. Make one below, or reuse the key from your Athena Shortcut.")
      ),
      step("Under ", b("Otherwise"), ": the same ", b("Get Contents of URL"), " with Request Body ", b("JSON"), ", a Text field ", b("text"), " set to Shortcut Input and ", b("source"), " set to shortcut."),
      step("After ", b("End If"), ", add ", b("Show Notification"), " with the text ", b("Saved to Athena"), ". Share any page, photo or selection and pick Save to Athena.")
    );
    const makeBtn = h("button", { class: `btn ${fresh ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), fresh ? "Make another capture key" : "Make a capture key") as HTMLButtonElement;
    makeBtn.addEventListener("click", () => void make(makeBtn));
    const manage = h("button", { class: "settings__link", type: "button" }, "API keys");
    manage.addEventListener("click", () => opts.manageKeys());
    root.replaceChildren(
      ...[
        fresh ? freshKeyCard(fresh) : null,
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h2", { class: "group__label" }, "Set up the Shortcut")), steps),
        h("p", { class: "shortcut__hint" }, "A link keeps a readable copy of the page. Text that starts with a link is saved as that link, with the rest as your note. On Android or a computer, install Athena and pick it from the share menu instead."),
        h("div", { class: "shortcut__actions" }, makeBtn),
        h("p", { class: "shortcut__manage" }, icons.key(), "A capture key can only send things in. See and remove keys in ", manage),
      ].filter((x): x is HTMLElement => !!x)
    );
  }

  paint();
  return root;
}
