/**
 * A night by stage (lib/health-line.ts SleepStages), drawn two ways:
 *
 *  - stageBar(): the Health page's Sleep card. One segmented bar, deep →
 *    REM → core → awake, each part as wide as its share of the night, with a
 *    legend under it that names each stage and its time. Core sits under 3:1
 *    against the surface, so the legend's amounts carry it, never colour alone.
 *  - slimStageBar(): the Body row on a day page. 6px, no legend: the row's
 *    words say the time; the bar's accessible name says every stage.
 *
 * Segmented-bar spec per the dataviz skill: no baseline, rounded whole ends,
 * a 2px surface gap between parts, a part at zero draws nothing.
 */

import "../styles/sleep-stages.css";
import { h } from "../lib/dom";
import { hoursMinutes } from "../../../lib/health-line";
import type { SleepStages } from "../db/health";

export interface StageInfo {
  key: "deep" | "rem" | "core" | "awake" | "asleep_unspecified";
  name: string;
  cls: string;
}

/** Bottom of a stacked bar first: deep, then REM, so both read from near the baseline. */
export const STAGES: StageInfo[] = [
  { key: "deep", name: "Deep", cls: "stage--deep" },
  { key: "rem", name: "REM", cls: "stage--rem" },
  { key: "core", name: "Core", cls: "stage--core" },
];
export const UNSTAGED: StageInfo = { key: "asleep_unspecified", name: "No stage", cls: "stage--none" };
export const AWAKE: StageInfo = { key: "awake", name: "Awake", cls: "stage--awake" };

/** Has the night got stages worth drawing (deep, REM or core)? */
export const hasStages = (s: SleepStages | undefined): s is SleepStages => !!s && !!((s.deep ?? 0) + (s.rem ?? 0) + (s.core ?? 0));

/** The parts a bar shows, in order, with their minutes; zero parts left out. */
function partsOf(s: SleepStages, withAwake: boolean): Array<StageInfo & { minutes: number }> {
  const all = [...STAGES, UNSTAGED, ...(withAwake ? [AWAKE] : [])];
  return all.map((st) => ({ ...st, minutes: Math.round(s[st.key] ?? 0) })).filter((p) => p.minutes > 0);
}

/** "Deep 1h 25m, REM 1h 50m, Core 4h 25m, Awake 20m". */
export function stagesSentence(s: SleepStages): string {
  return partsOf(s, true)
    .map((p) => `${p.name} ${hoursMinutes(p.minutes)}`)
    .join(", ");
}

function bar(parts: Array<StageInfo & { minutes: number }>, cls: string, label: string): HTMLElement {
  const total = parts.reduce((n, p) => n + p.minutes, 0) || 1;
  return h(
    "div",
    { class: cls, role: "img", "aria-label": label },
    ...parts.map((p) => h("span", { class: `stagebar__part ${p.cls}`, style: `flex-grow: ${p.minutes / total}` }))
  );
}

/** The Sleep card's night: the bar, then a legend that names each stage and its time. */
export function stageBar(s: SleepStages, opts: { label: string }): HTMLElement {
  const parts = partsOf(s, true);
  return h(
    "div",
    { class: "stagebar" },
    bar(parts, "stagebar__track", `${opts.label}: ${stagesSentence(s)}`),
    h(
      "ul",
      { class: "stage-legend", "aria-hidden": "true" },
      ...parts.map((p) => h("li", { class: "stage-legend__item" }, h("i", { class: `stage-legend__swatch ${p.cls}` }), h("span", { class: "stage-legend__name" }, p.name), h("span", { class: "stage-legend__value" }, hoursMinutes(p.minutes))))
    )
  );
}

/** A chart's legend: each stage's name and, when given, its average. */
export function stageLegend(items: Array<{ stage: StageInfo; minutes?: number }>): HTMLElement {
  return h(
    "ul",
    { class: "stage-legend stage-legend--chart" },
    ...items.map(({ stage, minutes }) =>
      h("li", { class: "stage-legend__item" }, h("i", { class: `stage-legend__swatch ${stage.cls}`, "aria-hidden": "true" }), h("span", { class: "stage-legend__name" }, stage.name), minutes !== undefined ? h("span", { class: "stage-legend__value" }, hoursMinutes(minutes)) : null)
    )
  );
}

/** The day page's Body row: a slim bar under the sleep sentence. */
export function slimStageBar(s: SleepStages): HTMLElement | null {
  if (!hasStages(s)) return null;
  return bar(partsOf(s, true), "stagebar__track stagebar__track--slim", `Sleep by stage: ${stagesSentence(s)}`);
}
