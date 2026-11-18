/**
 * "Your cars" on the DVLA and DVSA MOT history account pages
 * (components/connector-detail.ts): the registrations Athena looks up, one
 * to add, and Remove on each. Both accounts share the list (db/car.ts).
 * Removing a car archives its Life admin renewals.
 */
import "../styles/car.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { showRegistration } from "../../../lib/car";
import { addCar, fetchCar, removeCar, type CarView } from "../db/car";

type Group = (title: string, ...children: Array<HTMLElement | null>) => HTMLElement;

export function carVehiclesGroup(group: Group): HTMLElement {
  const list = h("div", { class: "card card--flush list" });
  const input = h("input", { class: "field", type: "text", placeholder: "Registration, like AB12 CDE", "aria-label": "Registration number", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 10 }) as HTMLInputElement;
  const add = h("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Add") as HTMLButtonElement;
  const form = h("form", { class: "car-add" }, input, add);
  const hint = h("p", { class: "form__hint" }, "Athena looks each car up once a day. Its MOT and tax dates go into Life admin.");

  function paint(view: CarView) {
    list.replaceChildren(
      ...view.vehicles.map((c) => {
        const remove = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Remove ${c.label}` }, "Remove") as HTMLButtonElement;
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            paint(await removeCar(c.id));
            showToast(`${c.label} removed. Its dates are archived in Life admin.`, { icon: "archive" });
          } catch {
            remove.disabled = false;
            showToast("Couldn't remove it just now", { icon: "wifiOff" });
          }
        });
        return h(
          "div",
          { class: "row" },
          h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.car()),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.label), h("span", { class: "row__meta" }, showRegistration(c.registration))),
          remove
        );
      }),
      form
    );
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reg = input.value.trim();
    if (!reg) return input.focus();
    add.disabled = true;
    add.textContent = "Looking it up…";
    try {
      const view = await addCar(reg);
      input.value = "";
      paint(view);
      const added = view.vehicles.find((v) => v.id === view.id);
      showToast(added?.problem ?? `${added?.label ?? "Your car"} added to Life admin`, { icon: added?.problem ? "flag" : "car", timeoutMs: added?.problem ? 8000 : 4000 });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't add that car", { icon: "flag", timeoutMs: 6000 });
    } finally {
      add.disabled = false;
      add.textContent = "Add";
    }
  });

  paint({ vehicles: [], keys: { dvla: false, mot: false } });
  void fetchCar().then(paint, () => undefined);
  return group("Your cars", list, hint);
}
