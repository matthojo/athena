/**
 * Settings → API keys: a short card on setting up the Save to Athena browser
 * extension (extension/README.md). It only explains; the key is made with the
 * section's own New key button.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";

export function extensionCard(): HTMLElement {
  return h(
    "div",
    { class: "card card--flush list" },
    h(
      "div",
      { class: "row" },
      h("span", { class: "tile tile--sm" }, icons.link()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, "Browser extension"),
        h(
          "span",
          { class: "row__meta" },
          `Save to Athena keeps pages, quotes, images and links from Chrome, Edge, Firefox or Safari. Make a capture key here, then paste it and ${location.origin} into the extension's settings.`
        )
      )
    )
  );
}
