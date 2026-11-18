/**
 * Make or change one of the owner's own habits, in the same sheet as goals
 * and to-dos (components/editor-sheet.ts): its name, the days it's due (every
 * day, weekdays, chosen days, or a number of times a week), an optional
 * target with a unit ("8 glasses"), and an icon. A new habit is added with
 * the button; an existing one saves each change as it's made. Archive keeps
 * its history; an archived habit can be brought back here.
 */

import "../styles/own-habits.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openEditorSheet } from "./editor-sheet";
import { choiceChips, field, input } from "./fields";
import { showToast } from "./toast";
import { saveHabit, type HabitInput, type OwnHabit } from "../db/habits";
import { EVERY_DAY, HABIT_ICONS, WEEKDAYS_ONLY, WEEKENDS_ONLY, scheduleWords } from "../../../lib/habit-rules";
import { relativeTime } from "../lib/format";

type Pattern = "every" | "weekdays" | "days" | "week";
const LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function patternOf(h: Pick<OwnHabit, "days" | "per_week"> | null): Pattern {
  if (!h) return "every";
  if (h.per_week) return "week";
  if (h.days === EVERY_DAY) return "every";
  if (h.days === WEEKDAYS_ONLY) return "weekdays";
  return "days";
}

export function openHabitSheet(initial: OwnHabit | null): void {
  let rec = initial;
  let days = initial && !initial.per_week ? initial.days : EVERY_DAY;
  let perWeek = initial?.per_week ?? 3;

  let saving: Promise<void> = Promise.resolve();
  function save(patch: HabitInput) {
    if (!rec) return;
    saving = saving.then(async () => {
      try {
        rec = await saveHabit(patch, rec!.id);
        editor.refresh();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }
  const schedule = (): HabitInput => (pattern.value() === "week" ? { per_week: perWeek } : { per_week: null, days });

  // ---- days ----
  const dayBtns = LETTERS.map((l, i) => {
    const b = h("button", { class: "habit-day", type: "button", "aria-label": NAMES[i] }, l) as HTMLButtonElement;
    b.addEventListener("click", () => {
      const next = days ^ (1 << i);
      if (!next) return; // at least one day
      days = next;
      paintDays();
      save(schedule());
    });
    return b;
  });
  const dayRow = h("div", { class: "habit-days", role: "group", "aria-label": "Days it's due" }, ...dayBtns);
  const perWeekValue = h("span", { class: "habit-step__value habit-week-n__value" });
  const less = h("button", { class: "habit-step__btn", type: "button", "aria-label": "Fewer times" }, "−") as HTMLButtonElement;
  const more = h("button", { class: "habit-step__btn", type: "button", "aria-label": "More times" }, icons.plus()) as HTMLButtonElement;
  const weekRow = h("div", { class: "habit-week-n" }, less, perWeekValue, more, h("span", { class: "habit-week-n__hint" }, "on any days"));
  const stepWeek = (by: number) => {
    perWeek = Math.max(1, Math.min(6, perWeek + by));
    paintDays();
    save(schedule());
  };
  less.addEventListener("click", () => stepWeek(-1));
  more.addEventListener("click", () => stepWeek(1));

  const pattern = choiceChips<Pattern>(
    "Days",
    [
      { value: "every", label: "Every day" },
      { value: "weekdays", label: "Weekdays" },
      { value: "days", label: "Choose days" },
      { value: "week", label: "Times a week" },
    ],
    patternOf(initial),
    (p) => {
      if (p === "every") days = EVERY_DAY;
      if (p === "weekdays") days = WEEKDAYS_ONLY;
      if (p === "days" && (days === EVERY_DAY || days === WEEKDAYS_ONLY)) days = days === EVERY_DAY ? WEEKENDS_ONLY | 1 : 1 | 4 | 16;
      paintDays();
      save(schedule());
    }
  );
  const summary = h("p", { class: "habit-sheet__summary" });
  function paintDays() {
    const p = pattern.value();
    dayRow.hidden = p !== "days";
    weekRow.hidden = p !== "week";
    dayBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(!!(days & (1 << i)))));
    perWeekValue.textContent = `${perWeek} ${perWeek === 1 ? "time" : "times"}`;
    less.disabled = perWeek <= 1;
    more.disabled = perWeek >= 6;
    summary.hidden = p === "every" || p === "weekdays";
    summary.textContent = p === "week" ? `${scheduleWords({ days, per_week: perWeek })}, on any days` : scheduleWords({ days, per_week: null });
  }

  // ---- target ----
  const target = input("number", initial?.target ? String(initial.target) : "", { inputmode: "numeric", min: 2, max: 1000, placeholder: "Just tick it", "aria-label": "Target", class: "prop__input habit-target__n" });
  const unit = input("text", initial?.unit ?? "", { placeholder: "glasses, pages", autocomplete: "off", "aria-label": "Unit", maxlength: 24, class: "prop__input habit-target__unit" });
  const targetBox = h("span", { class: "habit-target" }, target, unit);
  const paintTarget = () => unit.toggleAttribute("hidden", !(Number(target.value) > 1));
  target.addEventListener("input", paintTarget);
  const targetPatch = (): HabitInput => {
    const n = Math.round(Number(target.value));
    return n > 1 ? { target: Math.min(1000, n), unit: unit.value.trim() || null } : { target: null, unit: null };
  };
  target.addEventListener("change", () => save(targetPatch()));
  unit.addEventListener("change", () => save(targetPatch()));

  // ---- icon ----
  let icon = initial?.icon ?? "check";
  const iconBtns = HABIT_ICONS.map((name) => {
    const b = h("button", { class: "habit-icon", type: "button", role: "radio", "aria-label": name, "aria-checked": String(name === icon) }, icons[name as IconName]());
    b.addEventListener("click", () => {
      icon = name;
      iconBtns.forEach((x, i) => x.setAttribute("aria-checked", String(HABIT_ICONS[i] === icon)));
      mark.replaceChildren(icons[icon as IconName]());
      save({ icon });
    });
    return b;
  });
  const iconRow = h("div", { class: "habit-icons", role: "radiogroup", "aria-label": "Icon" }, ...iconBtns);

  const fields = h(
    "div",
    { class: "card card--flush fields habit-sheet" },
    field("Days", h("div", { class: "habit-sheet__days" }, pattern.el, dayRow, weekRow, summary)),
    field("Target", targetBox),
    field("Icon", iconRow)
  );
  paintDays();
  paintTarget();

  const mark = h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[icon as IconName]());
  const editor = openEditorSheet({
    newLabel: "New habit",
    isNew: !initial,
    titleValue: initial?.name ?? "",
    placeholder: "Read, walk, drink water…",
    mark,
    sections: [fields],
    onTitle: (name) => save({ name }),
    createLabel: "Add habit",
    create: async () => {
      const made = await saveHabit({ name: editor.title.value.trim(), ...schedule(), ...targetPatch(), icon });
      rec = made;
      showToast(`${made.name} is on your list from today`, { icon: "check" });
      return true;
    },
    status: () => (rec ? (rec.archived_at ? "Archived. Its history is kept." : `Changed ${relativeTime(rec.updated_at)}`) : ""),
    action: () => (rec?.archived_at ? { icon: "restore", label: "Bring back", run: () => save({ archived: false }) } : null),
    ...(initial && !initial.archived_at
      ? {
          archive: async () => {
            const { id, name } = rec!;
            await saveHabit({ archived: true }, id);
            showToast(`${name} archived`, { icon: "archive", action: { label: "Undo", run: () => void saveHabit({ archived: false }, id) } });
          },
        }
      : {}),
  });
}
