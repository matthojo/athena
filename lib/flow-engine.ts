/**
 * Flows, plugged together. Importing this module once is what turns flows on in a function:
 *
 * - triggers (lib/flow-triggers-db.ts) get the engine's ports, so the reminders pass starts runs and the owner's
 *   own events (startTeamEvent: a save, a tagged note) start their flows at once;
 * - Ask's propose_flow (lib/flow-draft-ask.ts) gets the engine's createFlow, so a "whenever…" card saves a real flow;
 * - suggestions (lib/flow-suggest-store.ts) read the owner's flows through engineFlows.
 *
 * netlify/functions/api.ts, reminders.ts and mcp.ts import it. It's a module of its own, not part of lib/flows.ts,
 * so tests that import the store don't plug hooks into Team's events.
 */
import { createFlow, createFlowSource, createFlowStarter, listFlows } from "./flows";
import { useFlowEngine } from "./flow-triggers-db";
import { useFlowCreator } from "./flow-draft-ask";
import type { FlowReader } from "./flow-suggest-store";

useFlowEngine({ source: createFlowSource(), starter: createFlowStarter() });
useFlowCreator({ create: createFlow });

/** Suggestions' view of the owner's flows: every flow, on or off, as "already a flow" reads it. */
export const engineFlows: FlowReader = { list: listFlows };
