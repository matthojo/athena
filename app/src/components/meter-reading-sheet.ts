/**
 * Add a meter reading by hand, from the House page: for a home whose
 * supplier or meter Athena can't read. The number on the meter and the day
 * it was read; what was used between two readings is spread over the days
 * between them (lib/manual-entry.ts readingDays, POST /api/life/readings).
 * A gas meter may read in kWh, cubic metres or hundreds of cubic feet.
 * Ask's reading card opens it filled in from what was said (`start`).
 */

import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { choiceChips, field, input, pickerInput, select } from "./fields";
import { showToast } from "./toast";
import { addReading, type MeterReading } from "../db/house";
import { localToday } from "../lib/time";

type Fuel = MeterReading["fuel"];
type Unit = MeterReading["unit"];
const UNITS: Array<{ value: Unit; label: string }> = [
  { value: "m3", label: "m³" },
  { value: "ft3", label: "hundreds of ft³" },
  { value: "kwh", label: "kWh" },
];

/** Starting values (Ask's card). */
export interface MeterReadingStart {
  value?: number;
  unit?: Unit;
  date?: string;
}

/** `onSaved` gets every reading, newest first, and the one just saved. */
export function openMeterReadingSheet(readings: MeterReading[], onSaved: (next: MeterReading[], saved: MeterReading | undefined) => void, opts: { fuel?: Fuel; start?: MeterReadingStart } = {}): void {
  const today = localToday();
  const start = opts.start ?? {};
  const lastOf = (f: Fuel) => readings.find((r) => r.fuel === f);
  const value = input("text", start.value === undefined ? "" : String(start.value), { inputmode: "decimal", autocomplete: "off", "aria-label": "Meter reading", placeholder: "12345.6" });
  const unit = select("Unit", UNITS, (opts.fuel === "gas" ? start.unit : undefined) ?? lastOf("gas")?.unit ?? "m3");
  const kwhUnit = h("span", { class: "manual-pair__unit" }, "kWh");
  const date = pickerInput("date", start.date ?? today, { max: today, "aria-label": "Day read" });
  const last = h("p", { class: "manual-sheet__hint" });
  const fuel = choiceChips<Fuel>(
    "Meter",
    [
      { value: "electricity", label: "Electricity" },
      { value: "gas", label: "Gas" },
    ],
    opts.fuel ?? "electricity",
    () => paint()
  );
  function paint() {
    const gas = fuel.value() === "gas";
    unit.hidden = !gas;
    kwhUnit.hidden = gas;
    const prev = lastOf(fuel.value());
    last.textContent = prev
      ? `Last reading ${prev.value.toLocaleString("en-GB")} ${prev.unit === "kwh" ? "kWh" : prev.unit === "m3" ? "m³" : "hundreds of ft³"}, on ${new Date(`${prev.date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}. What you used since is spread over the days between.`
      : "Your first reading. Add another in a week or a month and Athena spreads what you used over the days between.";
  }

  const save = h("button", { class: "btn btn--primary", type: "submit" }, icons.check(), "Save") as HTMLButtonElement;
  const form = h(
    "form",
    { class: "loop-sheet" },
    h(
      "div",
      { class: "card card--flush fields" },
      field("Meter", fuel.el),
      field("Reading", h("span", { class: "manual-pair" }, value, kwhUnit, unit)),
      field("Day", date.el)
    ),
    last,
    h("div", { class: "loop-sheet__foot" }, h("span", { class: "loop-sheet__hint" }, "Kept encrypted"), save)
  ) as HTMLFormElement;
  const sheet = openSheet({ label: "Add a meter reading", title: "Add a meter reading", body: form });
  paint();
  requestAnimationFrame(() => value.focus());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = Number(value.value.trim().replace(/,/g, ""));
    if (!value.value.trim() || !Number.isFinite(n) || n < 0) {
      showToast("Add the number on the meter");
      return value.focus();
    }
    const f = fuel.value();
    const u: Unit = f === "gas" ? (unit.value as Unit) : "kwh";
    const prev = readings.filter((r) => r.fuel === f && r.date < (date.input.value || today)).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (prev && prev.unit === u && n < prev.value) {
      showToast(`That's lower than the reading before it (${prev.value.toLocaleString("en-GB")}). Check the number, or remove the old reading if the meter was changed.`, { timeoutMs: 6000 });
      return value.focus();
    }
    save.disabled = true;
    try {
      const day = date.input.value || today;
      const next = await addReading({ fuel: f, date: day, value: n, unit: u });
      showToast("Reading saved", { icon: "check" });
      onSaved(next, next.find((r) => r.fuel === f && r.date === day));
      sheet.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
    save.disabled = false;
  });
}
