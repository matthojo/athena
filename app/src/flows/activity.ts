/**
 * What Ask did (Settings → Ask) for a change a flow made. The engine logs a
 * plain flow's changes with the source "flow" and gives flow_id, flow_run_id
 * and flow_name (lib/ask-activity.ts ActivityEntry); an assistant's flow logs
 * as "team", as its other runs do.
 *
 * The row reads "Flow: <name>" and links to the run that made the change.
 * Pure, so it's tested.
 */

export const FLOW_SOURCE = "flow" as const;

/** The parts of an activity entry this reads, as lib/ask-activity.ts gives them. */
export interface FlowActivityFields {
  source: string;
  flow_run_id?: string | null;
  flow_id?: string | null;
  flow_name?: string | null;
}

export const isFlowActivity = (e: Pick<FlowActivityFields, "source">): boolean => e.source === FLOW_SOURCE;

/** The run that made the change, if the entry says. */
export function flowRunOf(e: FlowActivityFields): string | null {
  const id = e.flow_run_id ?? null;
  return typeof id === "string" && id ? id : null;
}

/** "Flow: Delivery day", or "A flow" while the name isn't known. */
export function flowSourceWords(name: string | null | undefined): string {
  const n = name?.trim();
  return n ? `Flow: ${n}` : "A flow";
}

/** Where the row links: the run page. */
export const flowRunHref = (runId: string): string => `#/flows/runs/${encodeURIComponent(runId)}`;
