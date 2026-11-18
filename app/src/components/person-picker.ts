/**
 * Pick a person: a chip when someone's chosen, otherwise a combobox over the
 * People list (type to filter, arrows + Enter, or tap). Typing a name that
 * isn't there offers to add them. Used by open loops ("owed to", "waiting
 * on") and reading ("recommended by").
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { loadRecords, saveRecord } from "../db/records";
import { hueFor, initials } from "../lib/format";
import type { Person, PersonRef } from "../types";

let pickerSeq = 0;

export function personPicker(opts: {
  value: PersonRef | null;
  placeholder?: string;
  label: string;
  onChange: (person: PersonRef | null) => void;
}): { el: HTMLElement; value: () => PersonRef | null; focus: () => void; set: (person: PersonRef | null) => void } {
  const uid = `picker-${++pickerSeq}`;
  let selected = opts.value;
  let people: Person[] = [];
  let active = 0;
  let options: Array<{ person: Person | null; name: string }> = [];

  const field = h("input", {
    class: "prop__input picker__input",
    type: "text",
    role: "combobox",
    "aria-label": opts.label,
    "aria-expanded": "false",
    "aria-controls": `${uid}-list`,
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: opts.placeholder ?? "Who?",
  }) as HTMLInputElement;
  const list = h("div", { class: "picker__list", id: `${uid}-list`, role: "listbox", "aria-label": opts.label, hidden: true });
  const chipSlot = h("span", { class: "picker__chip-slot" });
  const el = h("span", { class: "picker" }, chipSlot, field, list);

  void loadRecords("person").then(({ items }) => {
    people = items;
    // Focused before People arrived (a sheet that opens on the picker): show them now.
    if (document.activeElement === field) renderList();
  });

  const avatar = (name: string) => h("span", { class: "avatar avatar--xs", style: `--h:${hueFor(name)}`, "aria-hidden": "true" }, initials(name));

  function paint() {
    field.hidden = !!selected;
    if (!selected) {
      chipSlot.replaceChildren();
      return;
    }
    const clear = h("button", { class: "picker__clear", type: "button", "aria-label": `Remove ${selected.name}` }, icons.close());
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      choose(null);
      requestAnimationFrame(() => field.focus());
    });
    chipSlot.replaceChildren(h("span", { class: "picker__chip" }, avatar(selected.name), h("span", { class: "picker__name" }, selected.name), clear));
  }

  function open(show: boolean) {
    list.hidden = !show;
    field.setAttribute("aria-expanded", String(show));
  }

  function renderList() {
    const q = field.value.trim().toLowerCase();
    const matches = people
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.relationship ?? "").toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 6);
    options = matches.map((p) => ({ person: p, name: p.name }));
    if (q && !people.some((p) => p.name.toLowerCase() === q)) options.push({ person: null, name: field.value.trim() });
    active = Math.min(active, Math.max(0, options.length - 1));
    list.replaceChildren(
      ...options.map((o, i) => {
        const opt = h(
          "div",
          { class: "picker__option", role: "option", id: `${uid}-opt-${i}`, "aria-selected": String(i === active) },
          o.person ? avatar(o.name) : h("span", { class: "picker__add", "aria-hidden": "true" }, icons.plus()),
          h(
            "span",
            { class: "picker__option-text" },
            h("span", { class: "picker__option-name" }, o.person ? o.name : `Add “${o.name}”`),
            o.person?.relationship ? h("span", { class: "picker__option-sub" }, o.person.relationship) : null
          )
        );
        // pointerdown, not click: fires before the input's blur closes the list.
        opt.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          void pick(o);
        });
        return opt;
      })
    );
    field.setAttribute("aria-activedescendant", options.length ? `${uid}-opt-${active}` : "");
    open(options.length > 0 && document.activeElement === field);
  }

  async function pick(o: { person: Person | null; name: string }) {
    if (o.person) return choose({ id: o.person.id, name: o.person.name });
    try {
      const created = await saveRecord("person", { name: o.name });
      people.push(created);
      choose({ id: created.id, name: created.name });
      showToast(`Added ${created.name} to People`, { icon: "person" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't add them", { icon: "wifiOff" });
    }
  }

  function choose(person: PersonRef | null) {
    selected = person;
    field.value = "";
    open(false);
    paint();
    opts.onChange(person);
  }

  field.addEventListener("focus", renderList);
  field.addEventListener("input", () => {
    active = 0;
    renderList();
  });
  field.addEventListener("blur", () => open(false));
  field.addEventListener("keydown", (e) => {
    if (list.hidden && e.key === "ArrowDown") return renderList();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length);
      renderList();
    } else if (e.key === "Enter" && !list.hidden && options[active]) {
      e.preventDefault();
      void pick(options[active]);
    } else if (e.key === "Escape" && !list.hidden) {
      // Close the list, not the sheet it's in.
      e.preventDefault();
      e.stopPropagation();
      open(false);
    }
  });

  paint();
  // set: choose someone from outside (a suggestion tapped), exactly as picking them from the list does.
  return { el, value: () => selected, focus: () => (selected ? undefined : field.focus()), set: choose };
}
