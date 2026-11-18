/**
 * "Getting there" on an upcoming event at a place (components/record-profile.ts):
 * this journey's own way of travelling for Leave by, or the owner's usual
 * (Settings → Notifications). Saved in the proactive prefs' travel_by_event.
 */
import "../styles/car.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { fetchProactive, saveProactive, type TravelMode } from "../db/nudges";
import { TRAVEL_MODES } from "../../../lib/proactive/types";
import { TRAVEL_WORDS } from "../lib/travel-words";

export function gettingThere(eventId: string): HTMLElement {
  const pick = h("select", { class: "field getting-there__pick", "aria-label": "Getting there" }) as HTMLSelectElement;
  const el = h(
    "label",
    { class: "fact getting-there" },
    h("span", { class: "fact__icon" }, icons.pin()),
    h("span", { class: "fact__body" }, h("span", { class: "fact__title" }, "Getting there"), h("span", { class: "fact__detail" }, "For Leave by")),
    pick
  );
  el.hidden = true;
  void fetchProactive().then(({ prefs }) => {
    const own = prefs.travel_by_event[eventId] ?? "";
    pick.replaceChildren(
      h("option", { value: "", selected: !own }, `Your usual (${TRAVEL_WORDS[prefs.travel_mode].toLowerCase()})`),
      ...TRAVEL_MODES.map((m) => h("option", { value: m, selected: m === own }, TRAVEL_WORDS[m]))
    );
    el.hidden = false;
  }, () => undefined);
  pick.addEventListener("change", async () => {
    try {
      await saveProactive({ travel_by_event: { [eventId]: (pick.value || null) as TravelMode | null } });
    } catch {
      showToast("Couldn't save that just now", { icon: "wifiOff" });
    }
  });
  return el;
}
