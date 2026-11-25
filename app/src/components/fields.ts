/**
 * The compact labelled rows every editor in Athena uses (profiles, open
 * loops, life admin, reading, goals): a 96px label column and a control that
 * edits in place. Built only with h() — values can come from agents.
 */

import { h } from "../lib/dom";
import { addDays } from "../../../lib/dates";
import { localToday } from "../lib/time";
import { longDate } from "../lib/record-story";
import { clockOfDay } from "../lib/clock";

let fieldSeq = 0;

/** One labelled row. The label points at the primary control only, so extra
 * controls (a checkbox, a year box) stay independently clickable. */
export function field(label: string, control: HTMLElement, extra?: HTMLElement | null): HTMLElement {
  const labelable = control.matches("input, select, textarea");
  if (labelable && !control.id) control.id = `field-${++fieldSeq}`;
  if (labelable && !control.getAttribute("name")) control.setAttribute("name", label.toLowerCase().replace(/\W+/g, "-"));
  return h(
    "div",
    { class: "prop", role: labelable ? undefined : "group", "aria-label": labelable ? undefined : label },
    labelable ? h("label", { class: "prop__label", for: control.id }, label) : h("span", { class: "prop__label" }, label),
    h("span", { class: "prop__control" }, control, extra ?? null)
  );
}

export function input(type: string, value: string, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLInputElement {
  const el = h("input", { class: "prop__input", type, ...attrs }) as HTMLInputElement;
  el.value = value;
  return el;
}

export function select(label: string, options: { value: string; label: string }[], value: string): HTMLSelectElement {
  const el = h("select", { class: "prop__input prop__select", "aria-label": label }, ...options.map((o) => h("option", { value: o.value }, o.label))) as HTMLSelectElement;
  el.value = value;
  return el;
}

/**
 * A date or time that reads the way the app writes it ("Tuesday 10 November",
 * "09:30" or "9:30 am" as lib/clock.ts has it), and still edits with the system's
 * own picker: the native input lies over the words, unseen, so a tap (or
 * Enter, or typing) goes to it. `input` is that native input, so callers read
 * .value and listen for "change" as before.
 */
export function pickerInput(type: "date" | "time", value: string, attrs: Record<string, string | number | boolean | undefined> = {}, empty = type === "date" ? "Add a date" : "Add a time"): { el: HTMLElement; input: HTMLInputElement; paint: () => void } {
  const native = input(type, value, attrs);
  native.classList.add("prop__picker-native");
  const words = h("span", { class: "prop__picker-text", "aria-hidden": "true" });
  const paint = () => {
    const v = native.value;
    words.textContent = v ? (type === "date" ? longDate(v, localToday()) : clockOfDay(v)) : empty;
    words.classList.toggle("is-empty", !v);
  };
  native.addEventListener("input", paint);
  native.addEventListener("change", paint);
  // Desktop browsers only open the calendar from their own little icon: open it from anywhere on the words.
  native.addEventListener("click", () => {
    try {
      (native as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      // Not allowed here (no user gesture, or a cross-origin frame): the native input still works.
    }
  });
  paint();
  return { el: h("span", { class: `prop__picker prop__picker--${type}` }, words, native), input: native, paint };
}

/**
 * A value shown as words ("On the day and the day before", "Nebbiolo"), with
 * its editor (a row of chips) behind a tap. The editor folds away again when
 * focus leaves it, or when `fold()` is called after a pick.
 */
export function foldedEditor(label: string, words: () => string, editor: HTMLElement): { el: HTMLElement; fold: () => void; paint: () => void } {
  const text = h("button", { class: "prop__shown", type: "button", "aria-label": `${label}: change` }) as HTMLButtonElement;
  const wrap = h("span", { class: "prop__folded" }, text, editor);
  const paint = () => {
    const w = words();
    text.textContent = w || "None";
    text.classList.toggle("is-empty", !w);
  };
  const fold = () => {
    editor.hidden = true;
    text.hidden = false;
    paint();
  };
  text.addEventListener("click", () => {
    text.hidden = true;
    editor.hidden = false;
    editor.querySelector<HTMLElement>("[aria-pressed='true'], [aria-checked='true'], button, input, select")?.focus();
  });
  wrap.addEventListener("focusout", (e) => {
    if (editor.hidden || wrap.contains(e.relatedTarget as Node | null)) return;
    fold();
  });
  fold();
  return { el: wrap, fold, paint };
}

/** A textarea that grows with its content. */
export function autoTextarea(value: string, attrs: Record<string, string | number | undefined>, min = 40): HTMLTextAreaElement {
  const el = h("textarea", { class: "prop__input prop__textarea", rows: 1, ...attrs }) as HTMLTextAreaElement;
  el.value = value;
  const grow = () => {
    el.style.height = "auto";
    el.style.height = `${Math.max(min, el.scrollHeight + 2)}px`;
  };
  el.addEventListener("input", grow);
  requestAnimationFrame(grow);
  return el;
}

/**
 * A segmented choice (radio semantics) as a row of chips. `onChange` fires
 * with the new value; `set` repaints from outside.
 */
export function choiceChips<T extends string>(
  label: string,
  options: { value: T; label: string; icon?: SVGElement }[],
  value: T,
  onChange: (value: T) => void
): { el: HTMLElement; value: () => T; set: (v: T) => void } {
  let current = value;
  const buttons = options.map((o) => {
    const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(o.value === current) }, o.icon ?? null, o.label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (o.value === current) return;
      set(o.value);
      onChange(o.value);
    });
    return b;
  });
  function set(v: T) {
    current = v;
    buttons.forEach((b, i) => b.setAttribute("aria-checked", String(options[i].value === v)));
  }
  return { el: h("span", { class: "chip-row chip-row--wrap choice", role: "radiogroup", "aria-label": label }, ...buttons), value: () => current, set };
}

/**
 * A date input with quick picks (Today, Tomorrow, Next week, No date) — how
 * due dates are set on a phone without opening a calendar.
 */
export function dueDatePicker(value: string | null, onChange: (date: string | null) => void): { el: HTMLElement; value: () => string | null } {
  const today = localToday();
  const date = input("date", value ?? "", { "aria-label": "Due date" });
  const picks: { label: string; value: string | null }[] = [
    { label: "Today", value: today },
    { label: "Tomorrow", value: addDays(today, 1) },
    { label: "Next week", value: addDays(today, 7) },
    { label: "No date", value: null },
  ];
  const chips = picks.map((p) => {
    const b = h("button", { class: "chip chip--sm", type: "button", "aria-pressed": String((date.value || null) === p.value) }, p.label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      date.value = p.value ?? "";
      paint();
      onChange(p.value);
    });
    return b;
  });
  const paint = () => chips.forEach((b, i) => b.setAttribute("aria-pressed", String((date.value || null) === picks[i].value)));
  date.addEventListener("change", () => {
    paint();
    onChange(date.value || null);
  });
  return {
    el: h("span", { class: "due-picker" }, date, h("span", { class: "chip-row chip-row--wrap due-picker__chips" }, ...chips)),
    value: () => date.value || null,
  };
}
