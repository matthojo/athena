/**
 * The small pieces every Flows screen shares: a step's icon and tile in its
 * colour (mint for the trigger, blue for a plain step, violet for thinking,
 * amber when it waits for you), a value chip coloured like the graph, text
 * with chips in it, a flow's chain of tiles for its card, and its badge.
 */
import { h, svg } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { renderAvatarTile } from "../team/avatar";
import type { AvatarSpec } from "../../../lib/team-types";
import type { Flow, FlowStep, FlowText, FlowTrigger, FlowValue, ValueKind, ValueRef } from "../../../lib/flow-types";
import { stepTone, valueColour, type FlowBadge, type Tone } from "./words";
import { walk } from "./tree";

const base = (inner: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/** Icons Flows needs that the app's set doesn't have. */
const OWN = {
  branch: () => svg(base(`<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 3.5-3 5-9.5 6"/>`)),
  question: () => svg(base(`<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14M12 17.5v.01"/>`)),
  card: () => svg(base(`<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14.5h2"/>`)),
  todo: () => svg(base(`<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`)),
  lock: () => svg(base(`<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`)),
};

type AnyIcon = IconName | keyof typeof OWN;
const icon = (name: AnyIcon): SVGSVGElement => (name in OWN ? OWN[name as keyof typeof OWN]() : icons[name as IconName]());
export const flowIcon = icon;

const TOOL_ICON: Record<string, AnyIcon> = {
  find_notes: "notes",
  find_people: "person",
  find_todos: "checklist",
  find_watch_read: "film",
  money: "card",
  weather: "cloud",
  flight_status: "plane",
  train_status: "train",
  add_todo: "todo",
  add_reminder: "bell",
  save_note: "note",
  add_to_list: "listBullet",
  draft_email: "mail",
  draft_message: "chat",
  add_person: "person",
};

export function stepIconName(s: Pick<FlowStep, "kind"> & { tool?: string }): AnyIcon {
  switch (s.kind) {
    case "tool":
      return TOOL_ICON[s.tool ?? ""] ?? "sliders";
    case "check":
      return "branch";
    case "ask":
      return "question";
    case "wait":
      return "hourglass";
    case "notify":
      return "phone";
    case "think":
      return "sparkle";
    case "assignment":
      return "team";
  }
}

export function triggerIconName(t: FlowTrigger): AnyIcon {
  switch (t.kind) {
    case "schedule":
      return "clock";
    case "manual":
      return "play";
    case "before":
      return t.what === "event" ? "calendar" : t.eventKind === "birthday" ? "gift" : "calendar";
    case "event":
      if (t.event.source === "saved") return t.event.savedAction?.startsWith("gift") ? "gift" : "bookmark";
      if (t.event.source === "note") return "note";
      if (t.event.connector === "linear") return "project";
      if (t.event.connector === "google-calendar") return "calendar";
      if (t.event.kind === "delivery") return "parcel";
      return "mail";
  }
}

/** A tile in a step's colour. `size`: "lg" in the editor, "sm" in a card's chain. */
export function tile(tone: Tone, name: AnyIcon, size: "lg" | "md" | "sm" = "lg"): HTMLElement {
  return h("span", { class: `flow-tile flow-tile--${size} flow-tone--${tone}`, "aria-hidden": "true" }, icon(name));
}

export const stepTile = (s: FlowStep, size: "lg" | "md" | "sm" = "lg") => tile(stepTone(s), stepIconName(s), size);
export const triggerTile = (t: FlowTrigger, size: "lg" | "md" | "sm" = "lg") => tile("trigger", triggerIconName(t), size);

/** The assistant's face in place of a thinking step's tile. */
export function face(spec: AvatarSpec, size = 36, name?: string): HTMLElement {
  const t = renderAvatarTile(spec, { size, animate: false });
  t.classList.add("flow-face");
  if (name) {
    t.setAttribute("role", "img");
    t.setAttribute("aria-label", name);
  }
  return t;
}

/** A value as a chip, coloured like its kind in the graph. */
export function chip(v: Pick<FlowValue, "label" | "kind">, opts: { button?: boolean; broken?: boolean } = {}): HTMLElement {
  const dot = h("i", { class: "flow-chip__dot", style: `background:${valueColour(v.kind)}`, "aria-hidden": "true" });
  const cls = `flow-chip${opts.broken ? " flow-chip--broken" : ""}`;
  return opts.button ? h("button", { class: cls, type: "button" }, dot, v.label) : h("span", { class: cls }, dot, v.label);
}

/** How the editor looks up a value pointer's label and kind. */
export type Lookup = (r: ValueRef) => { label: string; kind: ValueKind; known: boolean };

/** Text with values in it: words, with each value as its chip. */
export function textWithChips(t: FlowText, look: Lookup): HTMLElement {
  return h(
    "span",
    { class: "flow-text" },
    ...t.map((p) => {
      if (typeof p === "string") return p;
      const v = look(p);
      return chip(v, { broken: !v.known });
    })
  );
}

/** "Gives you" and its chips, under a trigger or a step that gives values. */
export function givesRow(values: readonly FlowValue[]): HTMLElement | null {
  if (!values.length) return null;
  return h("div", { class: "flow-gives" }, h("span", { class: "flow-gives__label" }, "Gives you"), ...values.map((v) => chip(v)));
}

/** A flow's shape for its card: the trigger's tile, then its steps' (the first few). */
export function chain(f: Pick<Flow, "trigger" | "steps">, max = 6): HTMLElement {
  const tiles: HTMLElement[] = [triggerTile(f.trigger, "sm")];
  let n = 0;
  walk(f.steps, (s) => {
    n++;
    if (n <= max) tiles.push(stepTile(s, "sm"));
  });
  const el = h("span", { class: "flow-chain", "aria-hidden": "true" });
  tiles.forEach((t, i) => {
    if (i) el.append(h("span", { class: "flow-chain__link" }));
    el.append(t);
  });
  if (n > max) el.append(h("span", { class: "flow-chain__more" }, `+${n - max}`));
  return el;
}

export function badge(b: FlowBadge): HTMLElement {
  return h("span", { class: `flow-badge flow-badge--${b.tone}` }, h("span", { class: "flow-badge__dot", "aria-hidden": "true" }), b.words);
}

/** A switch like the app's others (input.switch). */
export function switchInput(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": label }) as HTMLInputElement;
  sw.checked = checked;
  sw.addEventListener("change", () => onChange(sw.checked));
  return sw;
}

/** Two or more buttons, one pressed: "Wait for my Go" · "Just add it". */
export function segmented<V extends string>(label: string, options: ReadonlyArray<{ value: V; label: string }>, value: V, onPick: (v: V) => void): HTMLElement {
  const el = h("div", { class: "flow-seg", role: "group", "aria-label": label });
  const paint = (cur: V) => el.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === cur)));
  for (const o of options) {
    const b = h("button", { class: "flow-seg__item", type: "button", "data-value": o.value }, o.label);
    b.addEventListener("click", () => {
      paint(o.value);
      onPick(o.value);
    });
    el.append(b);
  }
  paint(value);
  return el;
}
