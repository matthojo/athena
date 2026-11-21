/**
 * What starts a flow: on a schedule, when something arrives (Team's event
 * triggers), before an event or a date, or only by hand. The server fills in
 * what each trigger gives; steps that used a value the new trigger doesn't
 * give are marked in the editor.
 */
import { h } from "../lib/dom";
import { openSheet } from "../components/sheet";
import type { FlowTrigger } from "../../../lib/flow-types";
import type { EventFilter, TeamWeekday } from "../../../lib/team-types";
import { EMAIL_KINDS, WEEK } from "../team/trigger-editor-words";
import { segmented, switchInput } from "./parts";
import { DATE_KINDS, triggerWords } from "./words";

type Mode = "event" | "schedule" | "before-event" | "before-date" | "manual";

const modeOf = (t: FlowTrigger): Mode => (t.kind === "before" ? (t.what === "event" ? "before-event" : "before-date") : t.kind);

/** What can set off an event trigger, as one list. */
const ARRIVALS: ReadonlyArray<{ id: string; label: string; event: EventFilter }> = [
  ...EMAIL_KINDS.map((k) => ({ id: `mail:${k.kind}`, label: k.kind === "email" ? "Any email" : `An email: ${k.label.toLowerCase()}`, event: { source: "collected", kind: k.kind } as EventFilter })),
  { id: "saved:gift", label: "You save a gift idea", event: { source: "saved", savedAction: "gift-idea" } },
  { id: "saved:link", label: "You save a link", event: { source: "saved", savedAction: "saved" } },
  { id: "note", label: "You tag a note", event: { source: "note", tag: "" } },
  { id: "linear", label: "A Linear issue is assigned to you", event: { source: "collected", connector: "linear", kind: "issue" } },
  { id: "calendar", label: "A calendar event is added", event: { source: "collected", connector: "google-calendar", kind: "event" } },
];

function arrivalId(e: EventFilter): string {
  if (e.source === "saved") return e.savedAction?.startsWith("gift") ? "saved:gift" : "saved:link";
  if (e.source === "note") return "note";
  if (e.connector === "linear") return "linear";
  if (e.connector === "google-calendar") return "calendar";
  return `mail:${e.kind ?? "email"}`;
}

function field(label: string, control: Node): HTMLElement {
  return h("label", { class: "flow-sheet__group" }, h("span", { class: "flow-field__label" }, label), control);
}

function select(label: string, options: ReadonlyArray<{ value: string; label: string }>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = h("select", { class: "field flow-select", "aria-label": label }) as HTMLSelectElement;
  for (const o of options) s.append(h("option", { value: o.value }, o.label));
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

export function openTriggerSheet(o: { trigger: FlowTrigger; onDone: (t: FlowTrigger) => void }): void {
  const t0 = o.trigger;
  // Each kind keeps its own settings while the owner looks around.
  let mode: Mode = modeOf(t0);
  const sched: Extract<FlowTrigger, { kind: "schedule" }> = t0.kind === "schedule" ? structuredClone(t0) : { kind: "schedule", days: [1, 2, 3, 4, 5], time: "09:00" };
  const event: Extract<FlowTrigger, { kind: "event" }> = t0.kind === "event" ? structuredClone(t0) : { kind: "event", event: { source: "collected", kind: "email" } };
  const bEvent: Extract<FlowTrigger, { kind: "before"; what: "event" }> = t0.kind === "before" && t0.what === "event" ? structuredClone(t0) : { kind: "before", what: "event", minutes: 30, withPeople: true };
  const bDate: Extract<FlowTrigger, { kind: "before"; what: "date" }> = t0.kind === "before" && t0.what === "date" ? structuredClone(t0) : { kind: "before", what: "date", days: 7, at: "09:00", eventKind: "birthday" };

  const current = (): FlowTrigger => {
    switch (mode) {
      case "schedule":
        return sched;
      case "event":
        return event;
      case "before-event":
        return bEvent;
      case "before-date":
        return bDate;
      case "manual":
        return { kind: "manual" };
    }
  };

  const settings = h("div", { class: "flow-trigger-settings" });
  const sentence = h("p", { class: "flow-trigger-sentence", "aria-live": "polite" });
  const paintSentence = () => (sentence.textContent = triggerWords(current()));

  const matchInput = (get: () => string | undefined, set: (v: string | undefined) => void, label: string) => {
    const i = h("input", { class: "field", type: "text", maxlength: 60, placeholder: "Leave empty for any", "aria-label": label }) as HTMLInputElement;
    i.value = get() ?? "";
    i.addEventListener("input", () => (set(i.value.trim() || undefined), paintSentence()));
    return field(label, i);
  };

  function paintSettings() {
    settings.replaceChildren();
    if (mode === "schedule") {
      const days = h("div", { class: "flow-days", role: "group", "aria-label": "Days" });
      for (const w of WEEK) {
        const b = h("button", { class: "flow-day", type: "button", "aria-pressed": String(sched.days.includes(w.day as TeamWeekday)), "aria-label": w.long }, w.letter);
        b.addEventListener("click", () => {
          const on = sched.days.includes(w.day as TeamWeekday);
          if (on && sched.days.length === 1) return;
          sched.days = (on ? sched.days.filter((d) => d !== w.day) : [...sched.days, w.day as TeamWeekday]).sort();
          b.setAttribute("aria-pressed", String(!on));
          paintSentence();
        });
        days.append(b);
      }
      const time = h("input", { class: "field flow-time", type: "time", "aria-label": "At" }) as HTMLInputElement;
      time.value = sched.time;
      time.addEventListener("input", () => ((sched.time = time.value || "09:00"), paintSentence()));
      settings.append(field("On", days), field("At", time));
    } else if (mode === "event") {
      const which = select("What arrives", ARRIVALS.map((a) => ({ value: a.id, label: a.label })), arrivalId(event.event), (id) => {
        const a = ARRIVALS.find((x) => x.id === id);
        if (a) event.event = { ...structuredClone(a.event), ...(event.event.match ? { match: event.event.match } : {}) };
        paintSettings();
        paintSentence();
      });
      settings.append(field("When", which));
      if (event.event.source === "note") {
        const tag = h("input", { class: "field", type: "text", maxlength: 40, placeholder: "travel", "aria-label": "Tag" }) as HTMLInputElement;
        tag.value = event.event.tag ?? "";
        tag.addEventListener("input", () => ((event.event.tag = tag.value.replace(/^#/, "").trim()), paintSentence()));
        settings.append(field("Tag", tag));
      }
      settings.append(matchInput(() => event.event.match, (v) => (event.event.match = v), "With this in the title"));
    } else if (mode === "before-event") {
      const mins = select("How long before", [5, 10, 15, 30, 60, 120].map((m) => ({ value: String(m), label: m >= 60 ? `${m / 60} hour${m > 60 ? "s" : ""}` : `${m} minutes` })), String(bEvent.minutes), (v) => ((bEvent.minutes = Number(v)), paintSentence()));
      const people = switchInput("Only with people you know", bEvent.withPeople === true, (on) => ((bEvent.withPeople = on), paintSentence()));
      settings.append(field("How long before", mins), h("label", { class: "flow-switch-row" }, h("span", {}, "Only with people you know"), people), matchInput(() => bEvent.match, (v) => (bEvent.match = v), "With this in the title"));
    } else if (mode === "before-date") {
      const kind = select("What date", [...DATE_KINDS.map((k) => ({ value: k.kind, label: k.label.replace(/^an? /, "").replace(/^./, (c) => c.toUpperCase()) })), { value: "", label: "Any date" }], bDate.eventKind ?? "", (v) => ((bDate.eventKind = v || undefined), paintSentence()));
      const days = select("How long before", [0, 1, 2, 3, 7, 14, 30].map((d) => ({ value: String(d), label: d === 0 ? "On the day" : d === 1 ? "The day before" : d === 7 ? "A week before" : `${d} days before` })), String(bDate.days), (v) => ((bDate.days = Number(v)), paintSentence()));
      const at = h("input", { class: "field flow-time", type: "time", "aria-label": "At" }) as HTMLInputElement;
      at.value = bDate.at;
      at.addEventListener("input", () => ((bDate.at = at.value || "09:00"), paintSentence()));
      settings.append(field("What date", kind), field("When", days), field("At", at), matchInput(() => bDate.match, (v) => (bDate.match = v), "With this in its name"));
    } else {
      settings.append(h("p", { class: "flow-note" }, "It only runs when you tap Run now or start it from a Shortcut."));
    }
  }

  const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
  const body = h(
    "div",
    { class: "flow-sheet" },
    segmented(
      "What starts it",
      [
        { value: "event", label: "Something arrives" },
        { value: "schedule", label: "A schedule" },
        { value: "before-event", label: "Before an event" },
        { value: "before-date", label: "Before a date" },
        { value: "manual", label: "By hand" },
      ] as const,
      mode,
      (m) => {
        mode = m;
        paintSettings();
        paintSentence();
      }
    ),
    sentence,
    settings,
    h("p", { class: "flow-note" }, "Steps that used a value this trigger doesn't give are marked, so you can choose another."),
    h("div", { class: "flow-sheet__foot" }, done)
  );
  paintSettings();
  paintSentence();
  const sheet = openSheet({ label: "What starts it", title: "What starts it", body, variant: "tall" });
  done.addEventListener("click", () => {
    sheet.close();
    o.onDone(structuredClone(current()));
  });
}
