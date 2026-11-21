/**
 * The step settings preview (mockup 6) reads real values: what the trigger
 * and each step gave on the flow's newest run that kept them (FlowRun.values,
 * by step id then key). With no such run yet, the sheet shows chip labels.
 * Pure, so it's tested.
 */
import type { FlowRun } from "../../../lib/flow-types";

/** { trigger: { company: "…" } } as { "trigger.company": "…" }, the keys refKey makes. */
export function flatValues(values: FlowRun["values"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, byKey] of Object.entries(values ?? {})) {
    if (!byKey || typeof byKey !== "object") continue;
    for (const [key, v] of Object.entries(byKey)) if (typeof v === "string" && v.trim()) out[`${from}.${key}`] = v;
  }
  return out;
}

/** The reverse, for sample mode's runs. */
export function nestValues(flat: Record<string, string>): NonNullable<FlowRun["values"]> {
  const out: NonNullable<FlowRun["values"]> = {};
  for (const [k, v] of Object.entries(flat)) {
    const dot = k.indexOf(".");
    if (dot <= 0) continue;
    (out[k.slice(0, dot)] ??= {})[k.slice(dot + 1)] = v;
  }
  return out;
}

/** The newest run with values kept, and those values; null when there's none (no run yet, or only runs from before values were kept). */
export function previewRun(runs: readonly FlowRun[]): { run: FlowRun; values: Record<string, string> } | null {
  const newestFirst = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
  for (const run of newestFirst) {
    const values = flatValues(run.values);
    if (Object.keys(values).length) return { run, values };
  }
  return null;
}
