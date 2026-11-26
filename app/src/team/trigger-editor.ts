/**
 * Team: "When it runs", edited as sentences in setup and on the detail
 * page. Each trigger reads as one line ("Every weekday at 8:00",
 * "When a Linear issue is assigned to you") with its controls under it:
 * weekday pills and a time for a schedule; a source, then filter chips, for
 * an event. The sentence follows every change.
 */
import "../styles/team-trigger.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { MAX_TRIGGERS, type EventFilter, type TeamTriggerInput } from "../../../lib/team-types";
import { CONNECTORS, EMAIL_KINDS, MAIL_CONNECTORS, WEEK, connectorById, dayList, triggerSentence } from "./trigger-editor-words";

export const newSchedule = (): TeamTriggerInput => ({ kind: "schedule", days: [1, 2, 3, 4, 5], time: "09:00" });
export const newEvent = (): TeamTriggerInput => ({ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } });

let seq = 0;

/** A row of single-choice chips (role radiogroup; arrows move and pick). */
function choiceRow<T extends string>(label: string, options: ReadonlyArray<{ value: T; label: string }>, value: T | null, pick: (v: T) => void): HTMLElement {
  const row = h("div", { class: "trg-chips", role: "radiogroup", "aria-label": label });
  const buttons = options.map((o) => {
    const on = o.value === value;
    const b = h("button", { class: "chip trg-chip", type: "button", role: "radio", "aria-checked": on ? "true" : "false", tabindex: on || (value === null && o === options[0]) ? 0 : -1 }, o.label);
    b.addEventListener("click", () => pick(o.value));
    return b;
  });
  row.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
  row.append(...buttons);
  return row;
}

function clean(e: EventFilter): EventFilter {
  const out: EventFilter = { source: e.source };
  if (e.source === "collected") {
    if (e.connector) out.connector = e.connector;
    if (e.kind) out.kind = e.kind;
  }
  if (e.source === "saved" && e.savedAction) out.savedAction = e.savedAction;
  if (e.source === "note" && e.tag?.trim()) out.tag = e.tag.trim().replace(/^#/, "");
  if (e.source !== "note" && e.match?.trim()) out.match = e.match.trim();
  return out;
}

export interface TriggerEditorOptions {
  onChange: (t: TeamTriggerInput) => void;
  onRemove?: () => void;
}

/** One trigger: its sentence, then its controls. */
export function triggerEditor(initial: TeamTriggerInput, opts: TriggerEditorOptions): HTMLElement {
  let t: TeamTriggerInput = structuredClone(initial);
  const id = `trg-${++seq}`;
  const sentence = h("p", { class: "trg__sentence", id: `${id}-s`, "aria-live": "polite" });
  const remove = opts.onRemove ? h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost trg__remove", type: "button", "aria-label": "Remove this trigger" }, icons.close()) : null;
  remove?.addEventListener("click", () => opts.onRemove?.());
  const body = h("div", { class: "trg__body" });
  const el = h("div", { class: "trg", role: "group", "aria-labelledby": `${id}-s` }, h("div", { class: "trg__head" }, sentence, remove), body);

  const emit = () => {
    sentence.textContent = triggerSentence(t);
    opts.onChange(structuredClone(t));
  };
  const set = (next: TeamTriggerInput, redraw = true) => {
    t = next;
    if (redraw) draw();
    emit();
  };

  function scheduleControls(): HTMLElement[] {
    const days = dayList(t.days);
    const pills = h("div", { class: "trg-days", role: "group", "aria-label": "Days" });
    for (const w of WEEK) {
      const on = days.includes(w.day);
      const b = h("button", { class: "trg-day", type: "button", "aria-pressed": on ? "true" : "false", "aria-label": w.long, title: w.long }, h("span", { "aria-hidden": "true" }, w.short.slice(0, 2)));
      b.addEventListener("click", () => {
        const now = dayList(t.days);
        const next = now.includes(w.day) ? now.filter((d) => d !== w.day) : [...now, w.day];
        // No days reads as every day; keep at least one so the pills say what the sentence says.
        if (!next.length) return;
        b.setAttribute("aria-pressed", next.includes(w.day) ? "true" : "false");
        set({ ...t, days: next.sort((a, c) => a - c) }, false);
        syncPresets();
      });
      pills.append(b);
    }
    const presets: Array<[string, number[]]> = [
      ["Every day", [0, 1, 2, 3, 4, 5, 6]],
      ["Weekdays", [1, 2, 3, 4, 5]],
      ["Weekends", [0, 6]],
    ];
    const presetRow = h("div", { class: "trg-chips trg-chips--quiet" });
    const presetBtns = presets.map(([label, ds]) => {
      const b = h("button", { class: "chip chip--sm trg-chip", type: "button", "aria-pressed": "false" }, label);
      b.addEventListener("click", () => set({ ...t, days: ds }));
      presetRow.append(b);
      return [b, ds.join("")] as const;
    });
    const syncPresets = () => {
      const key = dayList(t.days).join("");
      for (const [b, k] of presetBtns) b.setAttribute("aria-pressed", k === key ? "true" : "false");
    };
    syncPresets();
    const time = h("input", { class: "trg-time", type: "time", value: t.time ?? "09:00", "aria-label": "Time", step: 300, required: true }) as HTMLInputElement;
    time.addEventListener("input", () => {
      if (/^\d{2}:\d{2}$/.test(time.value)) set({ ...t, time: time.value }, false);
    });
    return [pills, h("div", { class: "trg-line" }, presetRow, h("label", { class: "trg-at" }, h("span", { class: "trg-word" }, "at"), time))];
  }

  function eventControls(): HTMLElement[] {
    const e: EventFilter = t.event ?? { source: "collected" };
    const setEvent = (next: EventFilter, redraw = true) => set({ ...t, event: clean(next) }, redraw);
    const out: HTMLElement[] = [
      choiceRow(
        "What it waits for",
        [
          { value: "collected" as const, label: "Something collected" },
          { value: "saved" as const, label: "Something you save" },
          { value: "note" as const, label: "A note" },
        ],
        e.source,
        (source) => {
          if (source === e.source) return;
          if (source === "collected") setEvent({ source, connector: "linear", kind: "issue" });
          else if (source === "saved") setEvent({ source });
          else setEvent({ source });
        }
      ),
    ];
    if (e.source === "collected") {
      out.push(
        h(
          "div",
          { class: "trg-line" },
          h("span", { class: "trg-word" }, "from"),
          choiceRow(
            "From",
            CONNECTORS.map((c) => ({ value: c.id, label: c.label })),
            e.connector ?? null,
            (connector) => setEvent({ ...e, connector, kind: connectorById(connector)?.kind })
          )
        )
      );
      if (e.connector && MAIL_CONNECTORS.has(e.connector)) {
        out.push(
          choiceRow(
            "What kind",
            EMAIL_KINDS.map((k) => ({ value: k.kind, label: k.label })),
            EMAIL_KINDS.some((k) => k.kind === e.kind) ? e.kind! : "email",
            (kind) => setEvent({ ...e, kind })
          )
        );
      }
    } else if (e.source === "saved") {
      out.push(
        choiceRow(
          "What kind",
          [
            { value: "any", label: "Any link" },
            { value: "gift-idea", label: "A gift idea" },
          ],
          e.savedAction === "gift-idea" || e.savedAction === "gift_idea" ? "gift-idea" : "any",
          (v) => setEvent({ ...e, savedAction: v === "any" ? undefined : v })
        )
      );
    } else {
      const tag = h("input", { class: "trg-input", type: "text", value: e.tag ?? "", placeholder: "tag", "aria-label": "Tag", autocomplete: "off", spellcheck: "false", maxlength: 80 }) as HTMLInputElement;
      tag.addEventListener("input", () => setEvent({ ...e, tag: tag.value }, false));
      out.push(h("label", { class: "trg-line trg-field" }, h("span", { class: "trg-word" }, "tagged"), h("span", { class: "trg-hash", "aria-hidden": "true" }, "#"), tag));
    }
    if (e.source !== "note") {
      const has = e.match !== undefined;
      if (has) {
        const match = h("input", { class: "trg-input", type: "text", value: e.match ?? "", placeholder: "a word or two", "aria-label": "Title contains", autocomplete: "off", maxlength: 120 }) as HTMLInputElement;
        match.addEventListener("input", () => {
          t = { ...t, event: { ...clean(e), ...(match.value.trim() ? { match: match.value } : {}) } };
          sentence.textContent = triggerSentence({ ...t, event: clean(t.event!) });
          opts.onChange({ ...t, event: clean(t.event!) });
        });
        const drop = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Remove the title filter" }, icons.close());
        drop.addEventListener("click", () => setEvent({ ...e, match: undefined }));
        out.push(h("label", { class: "trg-line trg-field" }, h("span", { class: "trg-word" }, "title contains"), match, drop));
        queueMicrotask(() => {
          if (el.dataset.focusMatch) {
            delete el.dataset.focusMatch;
            match.focus();
          }
        });
      } else {
        const add = h("button", { class: "chip chip--sm trg-chip trg-chip--add", type: "button" }, icons.plus(), "Title contains…");
        add.addEventListener("click", () => {
          el.dataset.focusMatch = "1";
          t = { ...t, event: { ...e, match: "" } };
          draw();
        });
        out.push(h("div", { class: "trg-chips trg-chips--quiet" }, add));
      }
    }
    return out;
  }

  function draw() {
    // Keep keyboard focus on the same control through a redraw (arrow keys pick, which redraws).
    const active = document.activeElement as HTMLElement | null;
    const keep = active && el.contains(active) ? { text: active.textContent, group: active.closest("[aria-label]")?.getAttribute("aria-label") ?? "" } : null;
    const kind = choiceRow(
      "How it starts",
      [
        { value: "schedule" as const, label: "On a schedule" },
        { value: "event" as const, label: "When something arrives" },
      ],
      t.kind,
      (k) => {
        if (k !== t.kind) set(k === "schedule" ? newSchedule() : newEvent());
      }
    );
    kind.classList.add("trg-kind");
    body.replaceChildren(kind, ...(t.kind === "schedule" ? scheduleControls() : eventControls()));
    sentence.textContent = triggerSentence(t);
    if (keep && !el.dataset.focusMatch) {
      const again = [...body.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === keep.text && (b.closest("[aria-label]")?.getAttribute("aria-label") ?? "") === keep.group);
      again?.focus();
    }
  }

  draw();
  return el;
}

export interface TriggerListHandle {
  el: HTMLElement;
  value: () => TeamTriggerInput[];
}

/** Every trigger, editable, with "Add another". None reads as "only when you chat". */
export function triggerList(initial: TeamTriggerInput[], onChange: (ts: TeamTriggerInput[]) => void, name = "It"): TriggerListHandle {
  let list = structuredClone(initial);
  const el = h("div", { class: "trg-list" });
  const emit = () => onChange(structuredClone(list));

  function draw(focusLast = false) {
    const rows = list.map((t, i) =>
      triggerEditor(t, {
        onChange: (next) => {
          list[i] = next;
          emit();
        },
        onRemove: () => {
          list.splice(i, 1);
          draw();
          emit();
        },
      })
    );
    const add = (make: () => TeamTriggerInput) => () => {
      list.push(make());
      draw(true);
      emit();
    };
    const schedule = h("button", { class: "btn btn--soft btn--sm trg-add", type: "button" }, icons.clock(), "On a schedule");
    const event = h("button", { class: "btn btn--soft btn--sm trg-add", type: "button" }, icons.bell(), "When something arrives");
    schedule.addEventListener("click", add(newSchedule));
    event.addEventListener("click", add(newEvent));
    const foot = list.length
      ? list.length < MAX_TRIGGERS
        ? h("div", { class: "trg-foot" }, h("span", { class: "trg-foot__label" }, "Add another"), schedule, event)
        : h("p", { class: "trg-note" }, `That's ${MAX_TRIGGERS}, the most one assistant can have.`)
      : h("div", { class: "trg-empty" }, h("p", { class: "trg-empty__text" }, `No triggers. ${name} works only when you chat with it.`), h("div", { class: "trg-foot" }, schedule, event));
    el.replaceChildren(...rows, foot);
    if (focusLast) rows[rows.length - 1]?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }

  draw();
  return { el, value: () => structuredClone(list) };
}
