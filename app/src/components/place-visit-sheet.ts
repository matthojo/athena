/**
 * Add a place visit by hand, from the Library's Places page, a day's
 * Places section or a Place's Visits (with that Place picked): for someone
 * without Swarm or a Google Maps Timeline file.
 * A saved Place (picked like a person: type to filter, arrows + Enter, or
 * tap) or a typed address, the day, when you got there and how long you
 * stayed. The server finds it on the map and adds it to the day like any
 * other visit (POST /api/places/visits/manual, lib/places-visits.ts).
 */

import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { choiceChips, field, input, pickerInput, select } from "./fields";
import { showToast } from "./toast";
import { loadRecords } from "../db/records";
import { addManualVisit, type ManualVisit } from "../db/place-visits";
import { localToday } from "../lib/time";
import type { Place } from "../types";

type Where = "place" | "address";
const STAYS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480].map((m) => ({ value: String(m), label: m < 60 ? `${m} min` : m === 60 ? "1 hour" : m === 90 ? "1½ hours" : `${m / 60} hours` }));

let seq = 0;

/** A saved Place: a chip when one's chosen, otherwise a combobox over Places. A name that isn't there offers to use it as an address. */
function placePicker(onAddress: (text: string) => void): { el: HTMLElement; value: () => Place | null; choose: (p: Place | null) => void; focus: () => void } {
  const uid = `place-pick-${++seq}`;
  let selected: Place | null = null;
  let places: Place[] = [];
  let active = 0;
  let options: Array<{ place: Place | null; text: string }> = [];
  const box = h("input", {
    class: "prop__input picker__input",
    type: "text",
    role: "combobox",
    "aria-label": "Place",
    "aria-expanded": "false",
    "aria-controls": `${uid}-list`,
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: "Which Place?",
  }) as HTMLInputElement;
  const list = h("div", { class: "picker__list", id: `${uid}-list`, role: "listbox", "aria-label": "Place", hidden: true });
  const chipSlot = h("span", { class: "picker__chip-slot" });
  const el = h("span", { class: "picker" }, chipSlot, box, list);
  void loadRecords("place").then(({ items }) => {
    places = items.filter((p) => !p.archived_at);
    if (document.activeElement === box) paintList();
  });

  const mark = () => h("span", { class: "picker__add", "aria-hidden": "true" }, icons.pin());
  function open(show: boolean) {
    list.hidden = !show;
    box.setAttribute("aria-expanded", String(show));
  }
  function paintChip() {
    box.hidden = !!selected;
    if (!selected) return chipSlot.replaceChildren();
    const clear = h("button", { class: "picker__clear", type: "button", "aria-label": `Remove ${selected.name}` }, icons.close());
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      choose(null);
      requestAnimationFrame(() => box.focus());
    });
    chipSlot.replaceChildren(h("span", { class: "picker__chip" }, mark(), h("span", { class: "picker__name" }, selected.name), clear));
  }
  function paintList() {
    const q = box.value.trim().toLowerCase();
    options = places
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.address ?? "").toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((p) => ({ place: p, text: p.name }));
    if (q && !places.some((p) => p.name.toLowerCase() === q)) options.push({ place: null, text: box.value.trim() });
    active = Math.min(active, Math.max(0, options.length - 1));
    list.replaceChildren(
      ...options.map((o, i) => {
        const opt = h(
          "div",
          { class: "picker__option", role: "option", id: `${uid}-opt-${i}`, "aria-selected": String(i === active) },
          o.place ? mark() : h("span", { class: "picker__add", "aria-hidden": "true" }, icons.plus()),
          h(
            "span",
            { class: "picker__option-text" },
            h("span", { class: "picker__option-name" }, o.place ? o.text : `Use “${o.text}” as an address`),
            o.place?.address ? h("span", { class: "picker__option-sub" }, o.place.address) : null
          )
        );
        // pointerdown, not click: fires before the input's blur closes the list.
        opt.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          pick(o);
        });
        return opt;
      })
    );
    box.setAttribute("aria-activedescendant", options.length ? `${uid}-opt-${active}` : "");
    open(options.length > 0 && document.activeElement === box);
  }
  function pick(o: { place: Place | null; text: string }) {
    if (o.place) return choose(o.place);
    box.value = "";
    open(false);
    onAddress(o.text);
  }
  function choose(p: Place | null) {
    selected = p;
    box.value = "";
    open(false);
    paintChip();
  }
  box.addEventListener("focus", paintList);
  box.addEventListener("input", () => {
    active = 0;
    paintList();
  });
  box.addEventListener("blur", () => open(false));
  box.addEventListener("keydown", (e) => {
    if (list.hidden && e.key === "ArrowDown") return paintList();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length);
      paintList();
    } else if (e.key === "Enter" && !list.hidden && options[active]) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape" && !list.hidden) {
      // Close the list, not the sheet it's in.
      e.preventDefault();
      e.stopPropagation();
      open(false);
    }
  });
  paintChip();
  return { el, value: () => selected, choose, focus: () => (selected ? undefined : box.focus()) };
}

/** When you got there, to start with: now to the nearest quarter hour on today, midday on an earlier day. */
function startTime(day: string, today: string): string {
  if (day !== today) return "12:00";
  const now = new Date();
  const q = Math.min(95, Math.round((now.getHours() * 60 + now.getMinutes()) / 15));
  return `${String(Math.floor(q / 4)).padStart(2, "0")}:${String((q % 4) * 15).padStart(2, "0")}`;
}

export function openPlaceVisitSheet(onSaved: (visit: ManualVisit) => void, opts: { date?: string; place?: Place } = {}): void {
  const today = localToday();
  const picker = placePicker((text) => {
    where.set("address");
    address.value = text;
    paint();
    requestAnimationFrame(() => address.focus());
  });
  const address = input("text", "", { autocomplete: "street-address", "aria-label": "Address", placeholder: "Street, town or postcode" });
  const name = input("text", "", { autocomplete: "off", "aria-label": "Name, if it has one", placeholder: "Optional", maxlength: 120 });
  const date = pickerInput("date", opts.date && opts.date <= today ? opts.date : today, { max: today, "aria-label": "Day" });
  const time = pickerInput("time", startTime(date.input.value, today), { "aria-label": "Got there" });
  // A new day moves the time with it, until the time's been set by hand.
  let timeSet = false;
  time.input.addEventListener("change", () => (timeSet = true));
  date.input.addEventListener("change", () => {
    if (timeSet) return;
    time.input.value = startTime(date.input.value || today, today);
    time.paint();
  });
  const stay = select("Stayed", STAYS, "60");
  const where = choiceChips<Where>(
    "Where",
    [
      { value: "place", label: "A saved Place" },
      { value: "address", label: "An address" },
    ],
    "place",
    () => paint()
  );
  const placeRow = field("Place", picker.el);
  const addressRow = field("Address", address);
  const nameRow = field("Name", name);
  const hint = h("p", { class: "manual-sheet__hint" });
  function paint() {
    const isPlace = where.value() === "place";
    placeRow.hidden = !isPlace;
    addressRow.hidden = nameRow.hidden = isPlace;
    hint.textContent = isPlace
      ? "Athena finds the Place on the map from its address, and adds the visit to the day like any other."
      : "Athena finds the address on the map. Without a name, the map names it.";
  }

  const save = h("button", { class: "btn btn--primary", type: "submit" }, icons.check(), "Save") as HTMLButtonElement;
  const form = h(
    "form",
    { class: "loop-sheet" },
    h("div", { class: "card card--flush fields" }, field("Where", where.el), placeRow, addressRow, nameRow, field("Day", date.el), field("Got there", time.el), field("Stayed", stay)),
    hint,
    h("div", { class: "loop-sheet__foot" }, h("span", { class: "loop-sheet__hint" }, "Kept encrypted"), save)
  ) as HTMLFormElement;
  if (opts.place) picker.choose(opts.place);
  const sheet = openSheet({ label: "Add a visit", title: "Add a visit", body: form });
  paint();
  requestAnimationFrame(() => picker.focus());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const isPlace = where.value() === "place";
    const place = picker.value();
    if (isPlace && !place) {
      showToast("Pick a Place, or switch to an address");
      return picker.focus();
    }
    if (!isPlace && address.value.trim().length < 4) {
      showToast("Type the address: a street and town, or a postcode");
      return address.focus();
    }
    if (!time.input.value) {
      showToast("Add when you got there");
      return time.input.focus();
    }
    save.disabled = true;
    try {
      const visit = await addManualVisit(
        {
          date: date.input.value || today,
          time: time.input.value.slice(0, 5),
          minutes: Number(stay.value),
          ...(isPlace ? { place_id: place!.id } : { address: address.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) }),
        },
        place?.name
      );
      showToast(`Added ${visit.name}`, { icon: "check" });
      onSaved(visit);
      sheet.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 5000 });
    }
    save.disabled = false;
  });
}
