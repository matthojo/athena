/**
 * What Ask did (Settings → Ask) for a change a flow made. The engine logs a
 * plain flow's changes with the source "flow" (lib/ask-activity.ts); an
 * assistant's flow logs as "team", as its other runs do. Until the engine's
 * source lands, the app names it by this string, so nothing here imports it.
 *
 * The row reads "Flow: <name>" and links to the run that made the change.
 * Pure, so it's tested.
 */

export const FLOW_SOURCE = "flow" as const;

/** The parts of an activity entry this reads. The run id and the flow's name are read under the names the engine is expected to use. */
export interface FlowActivityFields {
  source: string;
  flow_run_id?: string | null;
  run_id?: string | null;
  flow_id?: string | null;
  flow_name?: string | null;
}

export const isFlowActivity = (e: Pick<FlowActivityFields, "source">): boolean => e.source === FLOW_SOURCE;

/** The run that made the change, if the entry says. */
export function flowRunOf(e: FlowActivityFields): string | null {
  const id = e.flow_run_id ?? e.run_id ?? null;
  return typeof id === "string" && id ? id : null;
}

/** "Flow: Delivery day", or "A flow" while the name isn't known. */
export function flowSourceWords(name: string | null | undefined): string {
  const n = name?.trim();
  return n ? `Flow: ${n}` : "A flow";
}

/** Where the row links: the run page. */
export const flowRunHref = (runId: string): string => `#/flows/runs/${encodeURIComponent(runId)}`;
