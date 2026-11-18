/**
 * Log a day's health by hand, from the Health page: sleep, steps, weight,
 * resting heart rate, a workout, water, coffee, drinks, calories and mindful
 * minutes. For anyone without Apple Health or a supported device, or to put
 * right a day an app got wrong. What's typed in is kept as its own source
 * ("Added by hand", PUT /api/health/manual) and wins over every app for the
 * figures it has; the apps fill in the rest. Opening a day shows what was
 * typed in for it before; a field left empty is taken out. Ask's health card
 * opens it with what was said (`start`) laid over the day's typed figures
 * (lib/ask-logging.ts mergeHealth), so Save keeps the rest.
 */

import "../styles/manual-entry.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { field, input, pickerInput, select } from "./fields";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { clearManualHealth, loadManualHealth, saveManualHealth, type ManualHealth, type Workout } from "../db/health";
import { localToday } from "../lib/time";
import { addDays } from "../../../lib/dates";
import { MG_PER_COFFEE } from "../../../lib/health-line";
import { mergeHealth, type LoggedHealth } from "../../../lib/ask-logging";

const KINDS = [
  { value: "", label: "No workout" },
  { value: "run", label: "Run" },
  { value: "walk", label: "Walk" },
  { value: "ride", label: "Ride" },
  { value: "swim", label: "Swim" },
  { value: "strength", label: "Strength" },
  { value: "yoga", label: "Yoga" },
  { value: "hiit", label: "HIIT" },
  { value: "other", label: "Other" },
];

const num = (el: HTMLInputElement): number | undefined => {
  const v = el.value.trim().replace(",", ".");
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};
const set = (el: HTMLInputElement, v: number | undefined, f: (n: number) => string = String) => (el.value = v === undefined ? "" : f(v));
const trim1 = (n: number) => String(Math.round(n * 10) / 10);

function pair(a: HTMLInputElement, unitA: string, b?: HTMLInputElement, unitB?: string): HTMLElement {
  return h("span", { class: "manual-pair" }, a, h("span", { class: "manual-pair__unit" }, unitA), b ?? null, b && unitB ? h("span", { class: "manual-pair__unit" }, unitB) : null);
}

/** What a save did: the day, what was typed in for it before, and what it holds now (null when cleared). */
export interface HealthSaved {
  date: string;
  before: ManualHealth | null;
  figures: ManualHealth | null;
}

export function openHealthLogSheet(onSaved: (saved: HealthSaved) => void, opts: { date?: string; start?: LoggedHealth } = {}): void {
  const today = localToday();
  // "Add", not an example number: an empty field shows in the accent colour, and an example would read as a figure already saved.
  const numeric = (label: string, attrs: Record<string, string | number> = {}) => input("text", "", { inputmode: "decimal", autocomplete: "off", "aria-label": label, placeholder: "Add", ...attrs });
  const date = pickerInput("date", opts.date ?? addDays(today, -1), { max: today, min: addDays(today, -400), "aria-label": "Day" });
  const sleepH = numeric("Hours asleep");
  const sleepM = numeric("And minutes");
  const steps = numeric("Steps", { inputmode: "numeric" });
  const weight = numeric("Weight in kilograms");
  const hr = numeric("Resting heart rate", { inputmode: "numeric" });
  const kind = select("Workout", KINDS, "");
  const wMins = numeric("Workout minutes", { inputmode: "numeric" });
  const wKm = numeric("Workout distance in km");
  const water = numeric("Water in litres");
  const coffees = numeric("Coffees", { inputmode: "numeric" });
  const drinks = numeric("Alcoholic drinks", { inputmode: "numeric" });
  const kcal = numeric("Calories", { inputmode: "numeric" });
  const mindful = numeric("Mindful minutes", { inputmode: "numeric" });
  const workoutBits = h("span", { class: "manual-pair" }, wMins, h("span", { class: "manual-pair__unit" }, "min"), wKm, h("span", { class: "manual-pair__unit" }, "km"));
  const paintWorkout = () => (workoutBits.hidden = !kind.value);
  kind.addEventListener("change", paintWorkout);

  let had: ManualHealth | null = null;
  /** The day's other hand-added workouts, kept as they were (the form edits the first). */
  let otherWorkouts: Workout[] = [];

  /** The day's typed figures, with Ask's `start` laid over them; its workout first, so it's the one the form shows. */
  const shown = (f: ManualHealth | null): ManualHealth | null => {
    const start = opts.start;
    if (!start) return f;
    const out: ManualHealth = mergeHealth(f, start);
    const same = (a: Workout, b: Workout) => a.type === b.type && a.minutes === b.minutes && (a.distance_m ?? 0) === (b.distance_m ?? 0);
    if (start.workouts?.length) out.workouts = [...start.workouts, ...(out.workouts ?? []).filter((w) => !start.workouts!.some((s) => same(s, w)))];
    return out;
  };

  const fill = (day: ManualHealth | null) => {
    had = day;
    const f = shown(day);
    set(sleepH, f?.sleep_minutes === undefined ? undefined : Math.floor(f.sleep_minutes / 60));
    set(sleepM, f?.sleep_minutes === undefined ? undefined : f.sleep_minutes % 60);
    set(steps, f?.steps);
    set(weight, f?.weight_kg, trim1);
    set(hr, f?.resting_hr);
    const w = f?.workouts?.[0];
    otherWorkouts = f?.workouts?.slice(1) ?? [];
    kind.value = w ? (KINDS.some((k) => k.value === w.type) ? w.type : "other") : "";
    set(wMins, w?.minutes);
    set(wKm, w?.distance_m === undefined ? undefined : w.distance_m / 1000, trim1);
    set(water, f?.water_ml === undefined ? undefined : f.water_ml / 1000, trim1);
    set(coffees, f?.caffeine_mg === undefined ? undefined : Math.round(f.caffeine_mg / MG_PER_COFFEE));
    set(drinks, f?.alcohol_drinks);
    set(kcal, f?.kcal);
    set(mindful, f?.mindful_minutes);
    paintWorkout();
    clearBtn.hidden = !day;
  };

  let loading = 0;
  const loadDay = () => {
    const n = ++loading;
    const d = date.input.value;
    if (!d) return;
    loadManualHealth(d).then(
      (f) => n === loading && fill(f),
      () => n === loading && fill(null)
    );
  };
  date.input.addEventListener("change", loadDay);

  /** The form as figures, or a message saying what to fix. */
  function figures(): ManualHealth | string {
    const out: ManualHealth = {};
    const all = [sleepH, sleepM, steps, weight, hr, wMins, wKm, water, coffees, drinks, kcal, mindful];
    if (all.some((el) => Number.isNaN(num(el)))) return "Use numbers only, like 7 or 1.5";
    const sh = num(sleepH);
    const sm = num(sleepM);
    if (sh !== undefined || sm !== undefined) {
      const minutes = Math.round((sh ?? 0) * 60 + (sm ?? 0));
      if (minutes > 1440) return "Sleep: at most 24 hours";
      out.sleep_minutes = minutes;
    }
    const whole = (el: HTMLInputElement) => (num(el) === undefined ? undefined : Math.round(num(el)!));
    if (whole(steps) !== undefined) out.steps = whole(steps);
    if (num(weight) !== undefined) {
      if (num(weight)! < 20 || num(weight)! > 400) return "Weight: in kilograms, between 20 and 400";
      out.weight_kg = Math.round(num(weight)! * 10) / 10;
    }
    if (whole(hr) !== undefined) {
      if (whole(hr)! < 20 || whole(hr)! > 250) return "Resting heart rate: between 20 and 250";
      out.resting_hr = whole(hr);
    }
    if (kind.value) {
      const minutes = whole(wMins);
      if (!minutes) return "Workout: add how many minutes";
      const km = num(wKm);
      out.workouts = [{ type: kind.value, minutes, ...(km ? { distance_m: Math.round(km * 1000) } : {}) }, ...otherWorkouts];
    } else if (otherWorkouts.length) out.workouts = otherWorkouts;
    if (num(water) !== undefined) out.water_ml = Math.round(num(water)! * 1000);
    if (whole(coffees) !== undefined) out.caffeine_mg = whole(coffees)! * MG_PER_COFFEE;
    if (num(drinks) !== undefined) out.alcohol_drinks = Math.round(num(drinks)! * 10) / 10;
    if (whole(kcal) !== undefined) out.kcal = whole(kcal);
    if (whole(mindful) !== undefined) out.mindful_minutes = whole(mindful);
    return out;
  }

  const saveBtn = h("button", { class: "btn btn--primary", type: "submit" }, icons.check(), "Save") as HTMLButtonElement;
  const clearBtn = h("button", { class: "btn btn--ghost", type: "button", hidden: true }, "Clear this day") as HTMLButtonElement;
  const group = (t: string) => h("p", { class: "manual-sheet__group" }, t);
  const form = h(
    "form",
    { class: "loop-sheet" },
    h("div", { class: "card card--flush fields" }, field("Day", date.el)),
    group("Body"),
    h(
      "div",
      { class: "card card--flush fields" },
      field("Sleep", pair(sleepH, "h", sleepM, "min")),
      field("Steps", steps),
      field("Weight", pair(weight, "kg")),
      field("Resting HR", pair(hr, "bpm")),
      field("Workout", kind, workoutBits)
    ),
    group("Food, drink and mind"),
    h(
      "div",
      { class: "card card--flush fields" },
      field("Water", pair(water, "L")),
      field("Coffees", coffees),
      field("Drinks", pair(drinks, "alcoholic")),
      field("Calories", pair(kcal, "kcal")),
      field("Mindful", pair(mindful, "min"))
    ),
    h("p", { class: "manual-sheet__hint" }, "Only what you fill in is saved, and it takes the place of an app's figure for the same thing. Leave a field empty to take it out."),
    h("div", { class: "loop-sheet__foot" }, clearBtn, saveBtn)
  ) as HTMLFormElement;

  const sheet = openSheet({ label: "Log health by hand", title: "Log by hand", body: form });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = date.input.value;
    if (!d) return showToast("Pick a day");
    const f = figures();
    if (typeof f === "string") return showToast(f, { timeoutMs: 4000 });
    const empty = !Object.keys(f).length;
    if (empty && !had) return showToast("Fill in at least one figure");
    saveBtn.disabled = true;
    const before = had;
    try {
      if (empty) await clearManualHealth(d);
      else await saveManualHealth(d, f);
      showToast(empty ? "Cleared what you'd added" : "Saved", { icon: "check" });
      onSaved({ date: d, before, figures: empty ? null : f });
      sheet.close();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
    saveBtn.disabled = false;
  });
  clearBtn.addEventListener("click", () => {
    const d = date.input.value;
    void confirmDialog({ title: "Clear this day?", body: "What you typed in for this day is taken out. Figures from your apps stay.", confirmLabel: "Clear", danger: true }).then(async (ok) => {
      if (!ok) return;
      try {
        const before = had;
        await clearManualHealth(d);
        showToast("Cleared", { icon: "check" });
        onSaved({ date: d, before, figures: null });
        sheet.close();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff" });
      }
    });
  });

  fill(null);
  loadDay();
}
