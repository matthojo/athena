/**
 * Where a streamed Ask reply runs. As a function, stepStream
 * (netlify/functions/api.ts) runs it inside the request and stops it when the
 * app goes away. On the Netlify Server, routes/assistant.ts sets `current`,
 * and a request that names its run (X-Ask-Run) is handed to runs.ts instead:
 * the run carries on without the app and can be picked up again.
 * Types only, so api.ts can import this without pulling in the server.
 */
import type { TextSink } from "../../../lib/ask-stream";
import type { StepSink } from "../../../lib/steps";

/** What a hosted run tells the loop (netlify/server/assistant/runs.ts). Without a host there's neither. */
export interface RunCare {
  /** Awaited just before the reply's one change: the run's record says so first, so the run is never started again. */
  beforeChange?: () => Promise<void>;
  /** Whether this run had already started couldn't be checked: plan any change, make none. */
  careful?: boolean;
}

/** The work of one reply: Ask's one loop (lib/answer.ts runAsk), with its sinks. */
export type RunWork = (onStep: StepSink, onText: TextSink, care?: RunCare) => Promise<unknown>;

/** Null when this request isn't hosted (no run id): stepStream handles it as before. */
export type RunHost = (req: Request, work: RunWork, headers: Record<string, string>) => Promise<Response> | null;

export const runHost: { current: RunHost | null } = { current: null };
