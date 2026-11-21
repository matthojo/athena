/**
 * Flows drafting (lib/flow-draft.ts): the tools a drawn flow may use, as the engine's step catalogue has them
 * (lib/flow-catalog.ts flowCatalog: the same list GET /api/flows/catalog gives the Add a step sheet), with each
 * tool's fields and the values it gives later steps. What a trigger gives is triggers' own (lib/flow-triggers.ts
 * triggerGives). Drafting keeps no list of its own.
 *
 * The catalogue is loaded when first needed: it reads Ask's tool list (lib/assistant.ts), which imports
 * propose_flow, which imports drafting.
 */
import type { CatalogEntry, FlowValue, GoMode } from "./flow-types";

/** One of Ask's tools as a draft may use it: an entry from the engine's catalogue. */
export interface DraftTool {
  name: string;
  /** The first sentence of its description, for the model. */
  line: string;
  /** Its input fields, and the ones it can't do without. */
  fields: string[];
  required: string[];
  /** Changes something, so it has a Go setting. */
  changes: boolean;
  /** Reads spending: only while Ask may (Settings). */
  money: boolean;
  /** A draft step: always waits for Go, and is never sent (lib/flow-catalog.ts DRAFT_TOOLS). */
  draft: boolean;
  /** Runs alone unless the owner asks to check first (lib/flow-catalog.ts AUTO_BY_DEFAULT: reminders, to-dos, list lines). */
  runsAlone: boolean;
  /** What the step gives later steps: the engine fills exactly these, so the model picks from them. */
  gives: FlowValue[];
}

/** A drawn step's Go: a draft always asks; a change runs alone only when it's one the engine runs alone by default and the model didn't ask for a Go. Looks always run. Pure. */
export function goFor(tool: DraftTool, asked: unknown): GoMode {
  if (tool.draft) return "ask";
  if (!tool.changes) return "auto";
  return tool.runsAlone && asked !== "ask" ? "auto" : "ask";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The first sentence of a description, at most `n` characters. Pure. */
export function firstSentence(s: string | undefined, n = 160): string {
  const one = oneLine(s ?? "");
  const first = one.split(/(?<=[.!?])\s/)[0] ?? one;
  return first.length <= n ? first : `${first.slice(0, n - 1).trimEnd()}…`;
}

/** The engine's catalogue entries for tools, as drafting uses them. `describe` gives a tool's description, for its first line. Pure. */
export function draftToolsFrom(entries: CatalogEntry[], how: { describe: (name: string) => string | undefined; draft: (name: string) => boolean; runsAlone: (name: string) => boolean }): DraftTool[] {
  return entries.flatMap((e): DraftTool[] => {
    if (e.kind !== "tool" || !e.tool) return [];
    return [
      {
        name: e.tool,
        line: firstSentence(how.describe(e.tool)) || e.hint,
        fields: e.fields.map((f) => f.key),
        required: e.fields.filter((f) => f.required).map((f) => f.key),
        changes: e.changes,
        money: !!e.money,
        draft: how.draft(e.tool),
        runsAlone: how.runsAlone(e.tool),
        gives: e.gives,
      },
    ];
  });
}

/** The engine's catalogue as drafting uses it, loaded when first needed. */
export async function catalogDraftTools(): Promise<DraftTool[]> {
  const { defaultGo, flowCatalog, flowTool, isDraftTool } = await import("./flow-catalog");
  return draftToolsFrom(flowCatalog(), { describe: (n) => flowTool(n)?.description, draft: isDraftTool, runsAlone: (n) => defaultGo(n) === "auto" });
}
