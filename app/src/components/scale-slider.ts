/**
 * A check-in's 1 to 5 scale: the sentence large in the middle ("Right now
 * I feel" / "energised"), following the slider under it, with the two ends
 * named below. A native range input, so arrow keys, Home, End and Page keys
 * work and screen readers hear the sentence (aria-valuetext), not "3".
 */

import { h } from "../lib/dom";
import { scaleSentence, scaleWords } from "./checkin-rules";
import type { CheckinQuestion, ScaleValue } from "../../../lib/checkin-types";

export interface ScaleSlider {
  el: HTMLElement;
  value: () => ScaleValue;
  focus: () => void;
}

export function scaleSlider(q: CheckinQuestion, opts: { value?: ScaleValue; labelledBy?: string; onInput?: (v: ScaleValue) => void } = {}): ScaleSlider {
  let value: ScaleValue = opts.value ?? 3;
  const lead = h("span", { class: "scale__lead" });
  const level = h("strong", { class: "scale__level" });
  const input = h("input", {
    class: "scale__input",
    type: "range",
    min: 1,
    max: 5,
    step: 1,
    value,
    "aria-labelledby": opts.labelledBy,
  }) as HTMLInputElement;

  const paint = () => {
    const w = scaleWords(q, value);
    lead.textContent = w.lead;
    level.textContent = w.level;
    input.setAttribute("aria-valuetext", scaleSentence(q, value));
    input.style.setProperty("--fill", `${((value - 1) / 4) * 100}%`);
    el.dataset.value = String(value);
  };
  input.addEventListener("input", () => {
    value = Math.min(5, Math.max(1, Math.round(Number(input.value)))) as ScaleValue;
    paint();
    opts.onInput?.(value);
  });

  const el = h(
    "div",
    { class: "scale" },
    h("p", { class: "scale__sentence", "aria-hidden": "true" }, lead, level),
    h("div", { class: "scale__track" }, input),
    h("div", { class: "scale__ends", "aria-hidden": "true" }, h("span", {}, q.low ?? ""), h("span", {}, q.high ?? ""))
  );
  paint();
  return { el, value: () => value, focus: () => input.focus() };
}
