/**
 * Sharing a flow (lib/flow-share.ts) in plain words: what it reaches, where a finding is, which steps ask a
 * question, and why a step can't go yet. Pure, so the tests can check the words without a DOM.
 */
import { LOOKUP_TOOLS, type Reach } from "../../../lib/reach";

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export interface ReachWords {
  title: string;
  detail: string;
  /** For the tile's icon: shield (stays here), sparkle (a model or a lookup), globe (the web). */
  icon: "shield" | "sparkle" | "globe";
}

/** The reach card on the share sheet: the tier in a line, then what puts it there. */
export function reachWords(r: Pick<Reach, "tier" | "model" | "lookups" | "web">): ReachWords {
  if (r.tier === 1) return { title: "Nothing leaves your site", detail: "Every step stays inside Athena: it finds, adds, checks, asks and tells you.", icon: "shield" };
  const parts: string[] = [];
  if (r.model) parts.push("Some of its steps use a model.");
  const looks = r.lookups.map((t) => {
    const l = LOOKUP_TOOLS[t];
    return l ? `${l.label.charAt(0).toLowerCase()}${l.label.slice(1)} from ${l.service}` : t.replace(/_/g, " ");
  });
  if (looks.length) parts.push(`It looks up ${list(looks)}.`);
  if (r.tier === 3) return { title: "Can search the web", detail: [...parts, "It asks to search the web. Whoever adds it decides whether it can."].join(" "), icon: "globe" };
  return { title: "Uses a model or a lookup", detail: parts.join(" "), icon: "sparkle" };
}

/** "In the name", "In the step “Add a to-do”", "In the steps “Call” and “Text”, and the name": where a finding is. */
export function flowWhereWords(where: readonly string[], stepName: (id: string) => string): string {
  const steps = [...new Set(where.filter((w) => w.startsWith("step:")).map((w) => `“${stepName(w.slice(5))}”`))];
  const rest = where.filter((w) => !w.startsWith("step:")).map((w) => (w === "asks" ? "the questions" : `the ${w}`));
  const parts = [...(steps.length ? [`the ${steps.length === 1 ? "step" : "steps"} ${list(steps)}`] : []), ...new Set(rest)];
  return `In ${parts.length > 1 && steps.length > 1 ? `${parts[0]}, and ${list(parts.slice(1))}` : list(parts)}`;
}

/** "Used by Add a to-do and Draft an email": the steps a question fills. */
export function usedByWords(stepIds: readonly string[], stepName: (id: string) => string): string {
  return `Used by ${list([...new Set(stepIds.map(stepName))])}`;
}

/** The line over the steps that can't go yet. */
export function blockedLede(n: number): string {
  return n === 1 ? "This step can't go in a file yet. Change it or take it out, then share the flow." : `These ${n} steps can't go in a file yet. Change them or take them out, then share the flow.`;
}

/** The hint under the questions, with or without any. */
export function asksHint(n: number): string {
  return n
    ? "Where a step points at one of your own records, whoever adds the flow picks one of theirs. Word each question so it makes sense to them."
    : "None. No step points at one of your own records.";
}

/** The line over the findings: a step's words change on the flow's page, the rest here. */
export function flowFindingsLede(n: number): string {
  if (!n) return "Nothing is flagged. Athena checked for your people, places, contact details and private links. Read it through yourself before you share it.";
  return `${n === 1 ? "This looks like one" : "These look like some"} of your own details. Change ${n === 1 ? "it" : "them"} below or in the flow's steps, or mark ${n === 1 ? "it" : "each one"} fine to share.`;
}
