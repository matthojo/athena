/**
 * An account address as labelled groups (lib/address-fields.ts), for the
 * Connect and Sign-in settings sheets. Each field is checked when you leave it and again on
 * Connect, with its problem said under its group. A finder (an account
 * number, say) can fill the groups in from the service.
 *
 * The values go to the server as JSON in `url`; the adapter checks them
 * again with the same rules.
 */

import { h } from "../lib/dom";
import { checkAddressFields, cleanInput, type AddressFields, type AddressValues } from "../../../lib/address-fields";
import { errorText } from "../lib/connectors-ui";

export interface AddressChoice {
  group: string;
  values: Record<string, string>;
  label: string;
}

export interface AddressFieldsHandle {
  el: HTMLElement;
  /** Shows every problem; true when at least one group is complete and nothing's wrong. */
  check(): boolean;
  /** What to send as `url`. */
  json(): string;
  /** Anything different from what it started with. */
  changed(): boolean;
  /** The first field with a problem, or the first field. */
  focus(): void;
  /** The problem when nothing's filled in (the spec's `none`), or "". */
  problem(): string;
}

let seq = 0;

export function addressFields(spec: AddressFields, opts: { initial?: AddressValues | null; find?: (query: string) => Promise<AddressChoice[]> } = {}): AddressFieldsHandle {
  const inputs = new Map<string, HTMLInputElement>();
  const errors = new Map<string, HTMLElement>();
  const toggles = new Map<string, HTMLInputElement>();
  const groupEls: HTMLElement[] = [];

  for (const g of spec.groups) {
    const rows: HTMLElement[] = [];
    const errorLines: HTMLElement[] = [];
    for (const i of g.inputs) {
      const id = `af-${++seq}`;
      const input = h("input", {
        class: "prop__input",
        id,
        type: "text",
        autocomplete: "off",
        autocapitalize: i.upper ? "characters" : "off",
        spellcheck: "false",
        inputmode: i.numeric ? "numeric" : "text",
        placeholder: i.placeholder,
        "aria-describedby": `${id}-error`,
      }) as HTMLInputElement;
      const start = opts.initial?.[g.key]?.[i.key];
      if (typeof start === "string") input.value = start;
      const key = `${g.key}.${i.key}`;
      inputs.set(key, input);
      const error = h("p", { class: "form__error af-error", id: `${id}-error` });
      errors.set(key, error);
      errorLines.push(error);
      rows.push(h("div", { class: "prop" }, h("label", { class: "prop__label", for: id }, i.label), h("span", { class: "prop__control" }, input)));
      input.addEventListener("input", () => show(key, ""));
      // Leaving a field says what's wrong with it, and with the rest of its group once that's started.
      input.addEventListener("blur", () => {
        if (input.value.trim()) paint(g.key);
      });
    }
    if (g.toggle) {
      const id = `af-${++seq}`;
      const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id }) as HTMLInputElement;
      sw.checked = opts.initial?.[g.key]?.[g.toggle.key] === true;
      toggles.set(g.key, sw);
      rows.push(h("div", { class: "prop af-toggle" }, h("label", { class: "prop__label af-toggle__label", for: id }, g.toggle.label), sw));
    }
    const el = h("div", { class: "af-group" }, h("p", { class: "af-group__title" }, g.title), h("div", { class: "card card--flush fields" }, ...rows), ...errorLines, g.sub ? h("p", { class: "form__hint" }, g.sub) : null);
    groupEls.push(el);
  }

  const raw = (): AddressValues =>
    Object.fromEntries(
      spec.groups.map((g) => [
        g.key,
        { ...Object.fromEntries(g.inputs.map((i) => [i.key, inputs.get(`${g.key}.${i.key}`)!.value])), ...(g.toggle ? { [g.toggle.key]: toggles.get(g.key)!.checked } : {}) },
      ])
    );
  const startJson = JSON.stringify(normalised(spec, opts.initial ?? {}));

  function show(key: string, text: string) {
    const input = inputs.get(key)!;
    errors.get(key)!.textContent = text;
    if (text) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  /** Problems in words, for one group or all. Fields are tidied as they're checked: spaces out, serials in capitals. */
  function paint(only?: string): ReturnType<typeof checkAddressFields> {
    const c = checkAddressFields(spec, raw());
    for (const g of spec.groups) {
      if (only && g.key !== only) continue;
      for (const i of g.inputs) {
        const key = `${g.key}.${i.key}`;
        const input = inputs.get(key)!;
        const clean = cleanInput(i, input.value);
        if (clean && clean !== input.value) input.value = clean;
        show(key, c.errors[key] ?? "");
      }
    }
    return c;
  }

  // ----- the finder -----
  let finderEl: HTMLElement | null = null;
  if (spec.finder && opts.find) {
    const f = spec.finder;
    const id = `af-${++seq}`;
    const query = h("input", { class: "prop__input", id, type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: f.placeholder, "aria-describedby": `${id}-state` }) as HTMLInputElement;
    const button = h("button", { class: "btn btn--soft btn--sm", type: "button" }, f.button) as HTMLButtonElement;
    const state = h("p", { class: "form__hint af-find__state", id: `${id}-state`, role: "status" });
    const list = h("div", { class: "af-find__list", role: "group", "aria-label": f.button });
    const run = async () => {
      const q = query.value.replace(/\s+/g, "").toUpperCase();
      query.value = q;
      list.replaceChildren();
      if (!new RegExp(f.pattern).test(q)) {
        state.className = "form__error af-find__state";
        state.textContent = f.message;
        query.setAttribute("aria-invalid", "true");
        query.focus();
        return;
      }
      query.removeAttribute("aria-invalid");
      button.disabled = true;
      state.className = "form__hint af-find__state";
      state.textContent = f.asking;
      try {
        const choices = await opts.find!(q);
        // The service knew the number: keep it where the spec says (Octopus's account number, for costs).
        const keep = f.keeps ? inputs.get(f.keeps) : undefined;
        if (keep) {
          keep.value = q;
          show(f.keeps!, "");
        }
        state.textContent = choices.length ? f.pick : f.empty;
        list.replaceChildren(...choices.map((c) => choiceButton(c)));
      } catch (err) {
        state.className = "form__error af-find__state";
        state.textContent = errorText(err, f.failed);
      } finally {
        button.disabled = false;
      }
    };
    button.addEventListener("click", () => void run());
    query.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void run();
      }
    });
    const choiceButton = (c: AddressChoice) => {
      const b = h("button", { class: "af-find__choice", type: "button", "aria-pressed": "false" }, c.label);
      b.addEventListener("click", () => {
        for (const [k, v] of Object.entries(c.values)) {
          const input = inputs.get(`${c.group}.${k}`);
          if (input) input.value = v;
        }
        paint(c.group);
        for (const other of list.querySelectorAll<HTMLElement>(".af-find__choice")) if (other.dataset.group === c.group) other.setAttribute("aria-pressed", "false");
        b.setAttribute("aria-pressed", "true");
      });
      b.dataset.group = c.group;
      return b;
    };
    finderEl = h(
      "div",
      { class: "af-group af-find" },
      h("p", { class: "af-group__title" }, "Or find them"),
      h("div", { class: "card card--flush fields" }, h("div", { class: "prop" }, h("label", { class: "prop__label", for: id }, f.label), h("span", { class: "prop__control" }, query, button))),
      h("p", { class: "form__hint" }, f.sub),
      state,
      list
    );
  }

  const el = h("div", { class: "af" }, ...groupEls, finderEl);
  return {
    el,
    check: () => {
      const c = paint();
      return !c.none && !Object.keys(c.errors).length;
    },
    json: () => JSON.stringify(checkAddressFields(spec, raw()).values),
    changed: () => JSON.stringify(normalised(spec, raw())) !== startJson,
    focus: () => {
      const bad = [...inputs.values()].find((i) => i.getAttribute("aria-invalid") === "true");
      (bad ?? inputs.values().next().value)?.focus();
    },
    problem: () => checkAddressFields(spec, raw()).none ?? "",
  };
}

/** The complete groups' cleaned values, for telling whether anything changed. */
function normalised(spec: AddressFields, v: AddressValues): AddressValues {
  return checkAddressFields(spec, v).values;
}
