/**
 * A new step from the catalogue (GET /api/flows/catalog), with settings that
 * read well before the owner changes anything, and the catalogue grouped as
 * the Add a step sheet shows it. Pure, so it's tested.
 */
import type { CatalogEntry, FlowStep, GoMode } from "../../../lib/flow-types";
import type { AvailableValue } from "./tree";

export const GROUPS: ReadonlyArray<{ group: CatalogEntry["group"]; label: string }> = [
  { group: "find", label: "Find" },
  { group: "add", label: "Add" },
  { group: "decide", label: "Decide" },
  { group: "tell", label: "Tell me" },
  { group: "team", label: "Assistants and Team" },
];

/** Drafting steps: offered under Tell me, and they always wait for your Go (owner, 21 Nov 2026). */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set(["draft_email", "draft_message"]);
export const isDraftTool = (tool: string): boolean => DRAFT_TOOLS.has(tool);

/** The only changes a new step lets run alone: each just adds to your own Athena, with Undo (owner, 21 Nov 2026). */
export const RUNS_ALONE_TOOLS: ReadonlySet<string> = new Set(["add_reminder", "add_todo", "add_to_list"]);

/** A draft step's settings when the catalogue doesn't list them. */
export const DRAFT_FIELDS: CatalogEntry["fields"] = [
  { key: "to", label: "To", kind: "person", required: true },
  { key: "subject", label: "Subject", kind: "text", required: false },
  { key: "body", label: "Message", kind: "text", required: true },
];

/** A new tool step's Go: "Just add it" only for the three that may run alone, else "Wait for my Go". A look has nothing to wait for. */
export function defaultGo(e: Pick<CatalogEntry, "tool" | "changes">): GoMode {
  const tool = e.tool ?? "";
  if (isDraftTool(tool)) return "ask";
  if (!e.changes) return "auto";
  return RUNS_ALONE_TOOLS.has(tool) ? "auto" : "ask";
}

/** Whether the owner may change a step's Go: never for a draft. */
export const goLocked = (step: FlowStep): boolean => step.kind === "tool" && isDraftTool(step.tool);

/** Why an entry can't go here, or null when it can. */
export function unavailable(e: CatalogEntry, o: { hasAssistant: boolean; canBranch: boolean }): string | null {
  if (e.needsAssistant && !o.hasAssistant) return "Hand this flow to an assistant first";
  if ((e.kind === "check" || e.kind === "ask") && !o.canBranch) return "Branches can't go any deeper here";
  return null;
}

/** Entries matching what the owner typed, in the order they were listed. */
export function searchCatalog(entries: readonly CatalogEntry[], q: string): CatalogEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => {
    const hay = `${e.label} ${e.hint} ${e.tool ?? ""} ${e.kind}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A step for an entry, ready for its settings sheet. */
export function stepFromEntry(e: CatalogEntry, id: string, before: readonly AvailableValue[]): FlowStep {
  const base = { id, title: null };
  switch (e.kind) {
    case "tool":
      return { ...base, kind: "tool", tool: e.tool ?? "", input: Object.fromEntries((e.fields.length || !isDraftTool(e.tool ?? "") ? e.fields : DRAFT_FIELDS).map((f) => [f.key, []])), go: defaultGo(e), gives: e.gives.map((g) => ({ ...g })) };
    case "check": {
      const first = before[before.length - 1];
      return { ...base, kind: "check", condition: { left: first ? first.ref : { from: "trigger", key: "" }, op: "exists" }, yes: [], no: [] };
    }
    case "ask":
      return { ...base, kind: "ask", question: [], choices: [{ label: "Yes", steps: [] }, { label: "No", steps: [] }] };
    case "wait":
      return { ...base, kind: "wait", days: 1, at: "09:00" };
    case "notify":
      return { ...base, kind: "notify", text: [] };
    case "think":
      return { ...base, kind: "think", task: [], web: false, gives: e.gives.length ? e.gives.map((g) => ({ ...g })) : [{ key: "answer", label: "the answer", kind: "text" }] };
    case "assignment":
      return { ...base, kind: "assignment", brief: [] };
  }
}

/** The catalogue entry a step came from, for its fields and words. */
export function entryFor(step: FlowStep, entries: readonly CatalogEntry[]): CatalogEntry | undefined {
  return entries.find((e) => e.kind === step.kind && (step.kind !== "tool" || e.tool === step.tool));
}

/** Does this step change something (so it has a Go setting)? */
export const changes = (step: FlowStep, entries: readonly CatalogEntry[]): boolean => step.kind === "tool" && (isDraftTool(step.tool) || (entryFor(step, entries)?.changes ?? step.go === "ask"));
