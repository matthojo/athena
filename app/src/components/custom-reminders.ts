/**
 * Custom reminders on the Reminders page: "Remind me to …" with a day, a
 * time and an optional repeat, plus the list of what's pending. Days and
 * times are in this device's time zone, and sent with it, so a reminder
 * arrives at the time typed. Repeating ones then keep that time of day
 * wherever the owner is (lib/db.ts alignReminders).
 *
 * Creating and changing reminders needs a connection (the server sends the
 * push). Offline, the last list fetched is shown read-only from the device
 * cache. Sample mode explains that reminders come from a real Athena.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { deleteReminder, fetchReminders, isSampleMode, saveReminder } from "../db/api";
import { getMeta, setMeta } from "../db/idb";
import { addDays, zonedParts } from "../../../lib/dates";
import { deviceZone, localToday } from "../lib/time";
import { REMINDER_REPEATS, REPEAT_LABELS, describeWhen } from "../../../lib/reminders";
import type { EntityKind, Reminder, ReminderRepeat } from "../types";

const CACHE_KEY = "reminders";

/** In-app route per kind; projects have no page, so they don't link. */
const ROUTE: Partial<Record<EntityKind, string>> = {
  note: "notes",
  person: "people",
  place: "places",
  organisation: "organisations",
  event: "events",
};

interface QuickPick {
  label: string;
  date: string;
  time: string;
}

/** Local "now" rounded up to the next 5 minutes, plus `minutes`. */
function localIn(minutes: number, now: Date): { date: string; time: string } {
  const at = new Date(Math.ceil((now.getTime() + minutes * 60_000) / 300_000) * 300_000);
  const p = zonedParts(at, deviceZone());
  return { date: p.date, time: p.time };
}

function quickPicks(now = new Date()): QuickPick[] {
  const { date: today, hour } = zonedParts(now, deviceZone());
  const tomorrow = addDays(today, 1);
  const picks: QuickPick[] = [{ label: "In an hour", ...localIn(60, now) }];
  if (hour < 17) picks.push({ label: "This evening", date: today, time: "18:00" });
  picks.push({ label: "Tomorrow morning", date: tomorrow, time: "09:00" });
  if (hour >= 17) picks.push({ label: "Tomorrow evening", date: tomorrow, time: "18:00" });
  // Next Monday (a week on if today is Monday).
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  picks.push({ label: "Next week", date: addDays(today, ((8 - dow) % 7) || 7), time: "09:00" });
  return picks;
}

export function renderCustomReminders(): { el: HTMLElement; refresh: () => Promise<void> } {
  // ---------- composer ----------
  const text = h("input", {
    class: "field",
    type: "text",
    name: "text",
    placeholder: "Remind me to…",
    "aria-label": "What to be reminded of",
    maxlength: 500,
    autocomplete: "off",
    enterkeyhint: "done",
    required: true,
  }) as HTMLInputElement;
  const date = h("input", { class: "field", type: "date", name: "date", "aria-label": "Day", required: true }) as HTMLInputElement;
  const time = h("input", { class: "field", type: "time", name: "time", "aria-label": "Time", step: 300, required: true }) as HTMLInputElement;
  const repeat = h(
    "select",
    { class: "field", name: "repeat", "aria-label": "Repeat" },
    ...REMINDER_REPEATS.map((r) => h("option", { value: r }, REPEAT_LABELS[r]))
  ) as HTMLSelectElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, icons.plus(), "Add reminder") as HTMLButtonElement;
  const chips = h("div", { class: "chip-row remind-new__picks", role: "group", "aria-label": "Quick times" });
  const note = h("p", { class: "remind-new__note" });

  const syncChips = () => {
    for (const c of chips.querySelectorAll<HTMLButtonElement>(".chip")) {
      c.setAttribute("aria-pressed", String(c.dataset.date === date.value && c.dataset.time === time.value));
    }
  };

  const resetWhen = () => {
    const picks = quickPicks();
    chips.replaceChildren(
      ...picks.map((p) => {
        const c = h("button", { class: "chip", type: "button", "data-date": p.date, "data-time": p.time, "aria-pressed": "false" }, p.label);
        c.addEventListener("click", () => {
          date.value = p.date;
          time.value = p.time;
          syncChips();
          text.focus();
        });
        return c;
      })
    );
    const first = picks[0];
    date.value = first.date;
    time.value = first.time;
    date.min = localToday();
    repeat.value = "none";
    syncChips();
  };
  date.addEventListener("input", syncChips);
  time.addEventListener("input", syncChips);

  const form = h(
    "form",
    { class: "remind-new__form", novalidate: true },
    text,
    chips,
    h("div", { class: "remind-new__when" }, date, time, repeat),
    h("div", { class: "remind-new__foot" }, note, submit)
  ) as HTMLFormElement;

  const composer = h("section", { class: "card remind-new", "aria-labelledby": "remind-new-title" }, h("h2", { class: "catchup__title", id: "remind-new-title" }, "New reminder"), form);

  // ---------- list ----------
  const list = h("ul", { class: "remind-list", "aria-label": "Upcoming reminders" });
  const listCard = h(
    "section",
    { class: "card card--flush remind-list__card", "aria-labelledby": "remind-list-title" },
    h("h2", { class: "catchup__title remind-list__title", id: "remind-list-title" }, "Upcoming"),
    list
  );

  let items: Reminder[] = [];
  let canEdit = false;

  const setEditable = (on: boolean, why = "") => {
    canEdit = on;
    for (const el of [text, date, time, repeat, submit]) el.disabled = !on;
    for (const c of chips.querySelectorAll<HTMLButtonElement>(".chip")) c.disabled = !on;
    note.textContent = why;
  };

  function row(r: Reminder): HTMLElement {
    const now = new Date();
    const at = new Date(r.remind_at);
    const overdue = at.getTime() < now.getTime() - 5 * 60_000;
    const route = r.about_type ? ROUTE[r.about_type] : undefined;
    const about =
      r.about_id && r.about_title
        ? route
          ? h("a", { class: "remind-row__about", href: `#/${route}/${encodeURIComponent(r.about_id)}` }, r.about_title)
          : h("span", {}, r.about_title)
        : null;
    const done = h(
      "button",
      { class: "remind-row__done", type: "button", "aria-label": `Mark done: ${r.text}`, disabled: !canEdit },
      icons.check()
    ) as HTMLButtonElement;
    done.addEventListener("click", () => void markDone(r, done));
    const del = h(
      "button",
      { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Delete: ${r.text}`, disabled: !canEdit },
      icons.trash()
    ) as HTMLButtonElement;
    del.addEventListener("click", () => void remove(r));
    const meta: (HTMLElement | string)[] = [
      h("time", { datetime: at.toISOString() }, overdue ? `Overdue · ${describeWhen(at, now, deviceZone())}` : describeWhen(at, now, deviceZone())),
    ];
    if (r.repeat !== "none") meta.push(" · ", REPEAT_LABELS[r.repeat]);
    if (about) meta.push(" · ", about);
    return h(
      "li",
      { class: `remind-row${overdue ? " is-overdue" : ""}` },
      done,
      h("div", { class: "remind-row__body" }, h("p", { class: "remind-row__text" }, r.text), h("p", { class: "remind-row__meta" }, ...meta)),
      del
    );
  }

  function paintList() {
    const pending = items.filter((r) => !r.done_at).sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at));
    if (!pending.length) {
      list.replaceChildren(
        h(
          "li",
          { class: "empty remind-list__empty" },
          h("p", { class: "empty__title" }, "Nothing to remember yet"),
          h("p", { class: "empty__sub" }, "Add one above, or ask your agent to “remind me to…” through Athena.")
        )
      );
      return;
    }
    list.replaceChildren(...pending.map(row));
  }

  async function load() {
    if (isSampleMode()) {
      items = [];
      setEditable(false, "Connect Athena to set reminders.");
      paintList();
      return;
    }
    try {
      items = await fetchReminders();
      setEditable(true);
      void setMeta(CACHE_KEY, JSON.stringify(items)).catch(() => undefined);
    } catch {
      const cached = await getMeta(CACHE_KEY).catch(() => undefined);
      items = cached ? (JSON.parse(cached) as Reminder[]) : [];
      setEditable(false, "You're offline. Reminders can be added when you're back online.");
    }
    paintList();
  }

  async function markDone(r: Reminder, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      await saveReminder({ done: true }, r.id);
      items = items.filter((i) => i.id !== r.id);
      paintList();
      showToast(r.repeat === "none" ? "Done" : "Stopped repeating", {
        icon: "check",
        action: {
          label: "Undo",
          run: () =>
            void saveReminder({ done: false }, r.id)
              .then(load)
              .catch(() => showToast("Couldn't undo", { icon: "close" })),
        },
      });
    } catch (error) {
      button.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't update the reminder", { icon: "close" });
    }
  }

  async function remove(r: Reminder) {
    const ok = await confirmDialog({ title: "Delete this reminder?", body: `“${r.text}” won't be sent.`, confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await deleteReminder(r.id);
      items = items.filter((i) => i.id !== r.id);
      paintList();
      showToast("Reminder deleted", { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete the reminder", { icon: "close" });
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const value = text.value.trim();
    if (!value) {
      text.focus();
      showToast("Say what to remind you of", { icon: "bell" });
      return;
    }
    if (!date.value || !time.value) {
      showToast("Pick a day and a time", { icon: "clock" });
      return;
    }
    submit.disabled = true;
    try {
      const created = await saveReminder({ text: value, date: date.value, time: time.value, tz: deviceZone(), repeat: repeat.value as ReminderRepeat });
      if (Date.parse(created.remind_at) < Date.now() - 60_000) {
        showToast(`That time has passed, so it'll arrive in the next few minutes`, { icon: "bell", timeoutMs: 4000 });
      } else {
        showToast(`Reminder set for ${describeWhen(new Date(created.remind_at), new Date(), deviceZone()).replace(/^[A-Z]/, (c) => c.toLowerCase())}`, { icon: "bell" });
      }
      items = [...items, created];
      paintList();
      text.value = "";
      resetWhen();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't set the reminder", { icon: "close", timeoutMs: 5000 });
    } finally {
      submit.disabled = !canEdit;
    }
  });

  resetWhen();
  list.replaceChildren(h("li", { class: "skeleton", style: "height:56px;margin:var(--space-sm) var(--space-md)" }));
  return { el: h("div", { class: "remind" }, composer, listCard), refresh: load };
}
