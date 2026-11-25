/**
 * Settings → Appearance: System, Light or Dark, for this device
 * (lib/appearance.ts). Native radio buttons in a fieldset, so arrow keys move
 * between them and a screen reader hears the group's name and each choice.
 * The choice applies at once and works the same in sample mode.
 */

import "../styles/appearance.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { appearance, onSchemeChange, setAppearance, type Appearance } from "../lib/appearance";

export const APPEARANCE_COPY = {
  heading: "Appearance",
  detail: "Light, dark, or match this device",
  lede: "How Athena looks on this device.",
  legend: "Mode",
  system: "System",
  systemSub: "Follows this device's setting, and changes when it does",
  light: "Light",
  dark: "Dark",
  hint: "Your other devices keep their own setting.",
};

const NAMES: Record<Appearance, string> = { system: APPEARANCE_COPY.system, light: APPEARANCE_COPY.light, dark: APPEARANCE_COPY.dark };

export function appearanceSection(): { el: HTMLElement; destroy: () => void } {
  const inputs = new Map<Appearance, HTMLInputElement>();
  const choice = (id: Appearance) => {
    const inputId = `appearance-${id}`;
    const input = h("input", { class: "appearance-choice__input", type: "radio", name: "appearance", value: id, id: inputId }) as HTMLInputElement;
    if (id === "system") input.setAttribute("aria-describedby", `${inputId}-sub`);
    inputs.set(id, input);
    input.addEventListener("change", () => input.checked && setAppearance(id));
    return h(
      "label",
      { class: "appearance-choice", for: inputId },
      input,
      h("span", { class: "appearance-choice__words" }, h("span", { class: "appearance-choice__name" }, NAMES[id]), id === "system" ? h("span", { class: "appearance-choice__sub", id: `${inputId}-sub` }, APPEARANCE_COPY.systemSub) : null)
    );
  };
  const fieldset = h("fieldset", { class: "appearance-choices" }, h("legend", { class: "appearance-choices__legend" }, APPEARANCE_COPY.legend), choice("system"), choice("light"), choice("dark"));
  const paint = () => inputs.forEach((input, id) => (input.checked = id === appearance()));
  paint();
  // Another tab can change it too.
  const stop = onSchemeChange(paint);
  addEventListener("storage", paint);

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--appearance", "aria-labelledby": "settings-appearance" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-appearance" }, icons.contrast(), APPEARANCE_COPY.heading)),
      h("p", { class: "settings__lede" }, APPEARANCE_COPY.lede),
      h("div", { class: "settings__body" }, fieldset, h("p", { class: "form__hint" }, APPEARANCE_COPY.hint))
    ),
    destroy: () => {
      stop();
      removeEventListener("storage", paint);
    },
  };
}
