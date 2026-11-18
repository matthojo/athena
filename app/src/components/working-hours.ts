/**
 * Settings → Days: working hours, for finding times (lib/scheduling.ts).
 * Which days, from when to when, and how long to keep clear around each
 * meeting. 09:00–18:00 on weekdays with 10 minutes either side until the
 * owner changes it; kept on the server so every device finds the same times.
 */
import "../styles/scheduling.css";
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { DEFAULT_HOURS, fetchFocusTime, fetchWorkingHours, saveFocusTime, saveWorkingHours, type WorkingHours } from "../db/scheduling";

const DAYS: Array<[number, string, string]> = [
  [1, "M", "Monday"],
  [2, "T", "Tuesday"],
  [3, "W", "Wednesday"],
  [4, "T", "Thursday"],
  [5, "F", "Friday"],
  [6, "S", "Saturday"],
  [0, "S", "Sunday"],
];
const BUFFERS = [0, 5, 10, 15, 30];

export function workingHoursSettings(): HTMLElement {
  let hours: WorkingHours = { ...DEFAULT_HOURS };
  const dayButtons = DAYS.map(([n, short, long]) => {
    const b = h("button", { class: "hours__day", type: "button", "aria-pressed": "false", "aria-label": long, "data-day": String(n) }, short);
    b.addEventListener("click", () => {
      const on = new Set(hours.days);
      if (on.has(n)) on.delete(n);
      else on.add(n);
      if (!on.size) return showToast("Keep at least one working day", { icon: "calendar" });
      void save({ days: [...on].sort() });
    });
    return b;
  });
  const start = h("input", { type: "time", step: "900", "aria-label": "Start of your working day", value: hours.start }) as HTMLInputElement;
  const end = h("input", { type: "time", step: "900", "aria-label": "End of your working day", value: hours.end }) as HTMLInputElement;
  const buffer = h("select", { "aria-label": "Time kept clear around meetings" }, ...BUFFERS.map((m) => h("option", { value: String(m) }, m ? `${m} min` : "None"))) as HTMLSelectElement;

  const paint = () => {
    dayButtons.forEach((b) => b.setAttribute("aria-pressed", String(hours.days.includes(Number(b.dataset.day)))));
    start.value = hours.start;
    end.value = hours.end;
    buffer.value = String(hours.buffer);
  };
  async function save(patch: Partial<WorkingHours>) {
    const before = hours;
    hours = { ...hours, ...patch };
    paint();
    try {
      hours = await saveWorkingHours(patch);
      paint();
    } catch (e) {
      hours = before;
      paint();
      showToast(e instanceof Error && e.message && !/fetch/i.test(e.message) ? e.message : "That didn't save. Check you're online", { icon: "wifiOff" });
    }
  }
  start.addEventListener("change", () => (start.value && start.value < end.value ? void save({ start: start.value }) : (showToast("Start before the end of your day", { icon: "clock" }), paint())));
  end.addEventListener("change", () => (end.value && end.value > start.value ? void save({ end: end.value }) : (showToast("End after the start of your day", { icon: "clock" }), paint())));
  buffer.addEventListener("change", () => void save({ buffer: Number(buffer.value) }));
  void fetchWorkingHours()
    .then((got) => {
      hours = got;
      paint();
    })
    .catch(() => paint());
  paint();

  // "Block time as Focus time": how a to-do's "Block time for this" lands on Google Calendar.
  const focus = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Block time as Focus time" }) as HTMLInputElement;
  void fetchFocusTime()
    .then((on) => (focus.checked = on))
    .catch(() => undefined);
  focus.addEventListener("change", async () => {
    const next = focus.checked;
    focus.disabled = true;
    try {
      focus.checked = await saveFocusTime(next);
    } catch {
      focus.checked = !next;
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      focus.disabled = false;
    }
  });

  return h(
    "fieldset",
    { class: "life-prefs hours" },
    h("legend", { class: "mood-styles__legend" }, "Working hours"),
    h("p", { class: "life-prefs__sub" }, "When Athena looks for times for a call or meeting."),
    h("div", { class: "life-prefs__row hours__row" }, h("div", { class: "hours__days", role: "group", "aria-label": "Working days" }, ...dayButtons)),
    h("div", { class: "life-prefs__row hours__row" }, h("div", { class: "hours__times" }, start, h("span", { "aria-hidden": "true" }, "to"), end)),
    h("label", { class: "life-prefs__row hours__row" }, h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "Around meetings"), h("span", { class: "life-prefs__sub" }, "Kept clear before and after each one")), buffer),
    h(
      "label",
      { class: "life-prefs__row hours__row hours__focus" },
      h(
        "span",
        { class: "life-prefs__words" },
        h("span", { class: "life-prefs__name" }, "Block time as Focus time"),
        h("span", { class: "life-prefs__sub" }, "Google Calendar only. Focus time can decline meetings booked over the block. When this is off, a block is a plain busy event.")
      ),
      focus
    )
  );
}
