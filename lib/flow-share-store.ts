/**
 * Shared flows on the server: adding one someone shared. NOT BUILT YET: a stub with its final signature, so the
 * Add screen (netlify/lib/community-add-routes.ts) can call it. The Flows session replaces this file.
 */
import type { FlowAnswers, SharedFlow } from "./flow-share";

/**
 * Add a shared flow: blanks filled from `answers`, paused, reading spending off, and, when it came from the
 * catalogue, the listing it came from. Returns the new flow's id. Not built yet.
 */
export async function addSharedFlow(shared: SharedFlow, answers: FlowAnswers, catalogue?: { id: string; hash: string; version?: string }): Promise<{ id: string }> {
  void shared;
  void answers;
  void catalogue;
  throw new Error("not built yet");
}
