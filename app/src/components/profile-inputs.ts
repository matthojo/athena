/**
 * One control per profile input kind (app/src/lib/profile-catalogue.ts), for
 * the setup wizard and Settings → About you. Each reads and writes the value
 * as it's stored: text as typed, a choice as the option's text, a list
 * comma-separated, people as Athena person links, goals one per line.
 */

import { h } from "../lib/dom";
import "../styles/profile.css";
import { icons } from "./icons";
import { choiceChips } from "./fields";
import { personPicker } from "./person-picker";
import { loadGoals } from "../db/memory";
import { formatPeople, joinList, parsePeople, splitLines, splitList, type ProfileInput } from "../lib/profile-catalogue";
import { hueFor, initials } from "../lib/format";
import { composeRegion, readRegion, regionChoices, regionDefaults, regionLine, regionParts, REGION_KEY, type RegionOption } from "../../../lib/region";
import type { PersonRef } from "../types";

export interface ProfileControl {
  el: HTMLElement;
  value: () => string;
  focus: () => void;
}

let seq = 0;

/** A labelled control, stacked: the question, the control, a hint under it. */
export function profileQuestion(label: string, control: ProfileControl, hint?: string | null): HTMLElement {
  const id = `profile-q-${++seq}`;
  const labelled = control.el.matches("input, textarea") ? control.el : control.el.querySelector<HTMLElement>("input, textarea");
  if (labelled && !labelled.id) labelled.id = id;
  return h(
    "div",
    { class: "profile-q", role: labelled ? undefined : "group", "aria-label": labelled ? undefined : label },
    labelled ? h("label", { class: "field-label", for: labelled.id }, label) : h("span", { class: "field-label" }, label),
    control.el,
    hint ? h("p", { class: "form__hint" }, hint) : null
  );
}

/** What the hint under each kind says when the catalogue has no example of its own. */
export function inputHint(input: ProfileInput, example?: string): string | null {
  if (input === "list") return example ? `For example: ${example}. Put a comma between each.` : "Put a comma between each.";
  return null;
}

export function profileControl(f: { key: string; label: string; input: ProfileInput; options?: readonly string[]; hint?: string }, value: string): ProfileControl {
  switch (f.input) {
    case "choice":
      return choiceControl(f.label, f.options ?? [], value);
    case "people":
      return peopleControl(f.label, value);
    case "goals":
      return goalsControl(value);
    case "list":
    case "long_text": {
      const area = h("textarea", { class: "field profile-q__area", rows: 2, autocomplete: "off", maxlength: 2000 }) as HTMLTextAreaElement;
      area.value = f.input === "list" ? joinList(splitList(value)) : value;
      grow(area);
      return { el: area, value: () => (f.input === "list" ? joinList(splitList(area.value)) : area.value.trim()), focus: () => area.focus() };
    }
    default: {
      if (f.key === REGION_KEY) return regionControl(value);
      const input = h("input", { class: "field", type: "text", autocomplete: "off", maxlength: 2000, placeholder: f.hint ?? "", enterkeyhint: "next" }) as HTMLInputElement;
      input.value = value;
      return { el: input, value: () => input.value.trim(), focus: () => input.focus() };
    }
  }
}

/** What Athena reads in the Region answer, as the owner types (lib/region.ts): the place web searches go out from. */
export function regionReading(value: string): string {
  const r = readRegion(value);
  if (r.country) return `Athena reads this as ${regionLine(r)}.`;
  if (r.unread.length) return `Athena doesn't know “${r.unread[0]}” as a country, so web searches won't look anywhere in particular.`;
  return value.trim() ? "Add a country too, so web searches look where you live." : "Add a country so web searches look where you live.";
}

/**
 * Region as three dropdowns: country, currency and language, each chosen by itself. Picking a
 * country fills the other two when they're empty or still that of the country before; a choice the owner made
 * stays. Stored as before, as one answer ("United Kingdom, GBP, English"), so what was typed by hand still reads.
 */
function regionControl(value: string): ProfileControl {
  const id = `profile-region-${++seq}`;
  const { countries, currencies, languages } = regionChoices();
  const start = regionParts(value);
  const pick = (label: string, empty: string, options: RegionOption[], chosen: string, show: (o: RegionOption) => string) => {
    const select = h(
      "select",
      { class: "field profile-region__pick", "aria-describedby": id },
      h("option", { value: "" }, empty),
      ...options.map((o) => h("option", { value: o.code }, show(o)))
    ) as HTMLSelectElement;
    select.value = options.some((o) => o.code === chosen) ? chosen : "";
    return { select, el: h("label", { class: "profile-region__part" }, h("span", { class: "profile-region__label" }, label), select) };
  };
  const country = pick("Country", "Choose a country", countries, start.country, (o) => o.name);
  const currency = pick("Currency", "Choose a currency", currencies, start.currency, (o) => `${o.name} (${o.code})`);
  const language = pick("Language", "Choose a language", languages, start.language, (o) => o.name);
  const line = h("p", { class: "form__hint profile-q__reading", id, "aria-live": "polite" });
  const current = () => composeRegion({ country: country.select.value, currency: currency.select.value, language: language.select.value });
  const paint = () => (line.textContent = regionReading(current()));
  let was = regionDefaults(country.select.value || "");
  country.select.addEventListener("change", () => {
    const now = regionDefaults(country.select.value || "");
    if (now.currency && (!currency.select.value || currency.select.value === was.currency)) currency.select.value = now.currency;
    if (now.language && (!language.select.value || language.select.value === was.language)) language.select.value = now.language;
    was = now;
    paint();
  });
  currency.select.addEventListener("change", paint);
  language.select.addEventListener("change", paint);
  paint();
  return {
    el: h("div", { class: "profile-q__with-reading" }, h("div", { class: "profile-region" }, country.el, currency.el, language.el), line),
    value: current,
    focus: () => country.select.focus(),
  };
}

function grow(area: HTMLTextAreaElement) {
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${Math.max(48, area.scrollHeight + 2)}px`;
  };
  area.addEventListener("input", fit);
  requestAnimationFrame(fit);
}

function choiceControl(label: string, options: readonly string[], value: string): ProfileControl {
  const current = options.find((o) => o.toLowerCase() === value.trim().toLowerCase()) ?? "";
  let chosen = current;
  const chips = choiceChips(label, options.map((o) => ({ value: o, label: o })), current, (v) => (chosen = v));
  chips.el.classList.add("form-chips");
  return { el: chips.el, value: () => chosen, focus: () => chips.el.querySelector<HTMLElement>("button")?.focus() };
}

/** Several people: a chip each (linked to People where they're there), and a picker for the next. */
function peopleControl(label: string, value: string): ProfileControl {
  let people: PersonRef[] = parsePeople(value).map(({ id, name }) => ({ id, name }));
  const chips = h("div", { class: "profile-people__chips" });
  const slot = h("div", { class: "profile-people__pick" });
  const el = h("div", { class: "profile-people" }, chips, slot);
  let picker: ReturnType<typeof personPicker>;

  function paint() {
    chips.replaceChildren(
      ...people.map((p) => {
        const remove = h("button", { class: "picker__clear", type: "button", "aria-label": `Remove ${p.name}` }, icons.close());
        remove.addEventListener("click", () => {
          people = people.filter((x) => x !== p);
          paint();
          picker.focus();
        });
        return h(
          "span",
          { class: "picker__chip" },
          h("span", { class: "avatar avatar--xs", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name)),
          h("span", { class: "picker__name" }, p.name),
          remove
        );
      })
    );
    chips.hidden = !people.length;
  }

  function newPicker(focus = false) {
    picker = personPicker({
      value: null,
      label: `Add someone to ${label.toLowerCase()}`,
      placeholder: people.length ? "Add someone else" : "Type a name",
      onChange: (p) => {
        if (!p) return;
        if (!people.some((x) => (x.id && x.id === p.id) || x.name.toLowerCase() === p.name.toLowerCase())) people.push(p);
        paint();
        newPicker(true);
      },
    });
    picker.el.classList.add("profile-people__picker");
    slot.replaceChildren(picker.el);
    if (focus) requestAnimationFrame(() => picker.focus());
  }

  paint();
  newPicker();
  return { el, value: () => formatPeople(people), focus: () => picker.focus() };
}

/** This year's goals: one per line, with the owner's active Goals offered as chips to add. */
function goalsControl(value: string): ProfileControl {
  const area = h("textarea", { class: "field profile-q__area", rows: 3, autocomplete: "off", maxlength: 2000 }) as HTMLTextAreaElement;
  area.value = splitLines(value).join("\n");
  grow(area);
  const offers = h("div", { class: "chip-row chip-row--wrap form-chips profile-goals", role: "group", "aria-label": "Add from Goals", hidden: true });
  const fromLabel = h("p", { class: "form__hint profile-goals__from", hidden: true }, "Add from Goals");
  const lines = () => splitLines(area.value);
  const paintOffers = (titles: string[]) => {
    const have = new Set(lines().map((l) => l.toLowerCase()));
    offers.replaceChildren(
      ...titles.map((t) => {
        const on = have.has(t.toLowerCase());
        const b = h("button", { class: "chip", type: "button", "aria-pressed": String(on) }, on ? icons.check() : icons.plus(), t);
        b.addEventListener("click", () => {
          const now = lines();
          area.value = (on ? now.filter((l) => l.toLowerCase() !== t.toLowerCase()) : [...now, t]).join("\n");
          area.dispatchEvent(new Event("input"));
          paintOffers(titles);
        });
        return b;
      })
    );
    offers.hidden = !titles.length;
    fromLabel.hidden = !titles.length;
  };
  void loadGoals()
    .then(({ items }) => {
      const titles = items.filter((g) => g.status === "active" && !g.archived_at).map((g) => g.title).slice(0, 8);
      paintOffers(titles);
      area.addEventListener("input", () => paintOffers(titles));
    })
    .catch(() => undefined);
  return { el: h("div", { class: "profile-goals__wrap" }, area, h("p", { class: "form__hint" }, "One per line."), fromLabel, offers), value: () => lines().join("\n"), focus: () => area.focus() };
}
