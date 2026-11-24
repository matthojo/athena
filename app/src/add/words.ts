/**
 * The Add screen's words (app/src/add/view.ts): where an item came from, what it can reach, what it needs, and what
 * happens once it's added. Pure, so the tests can read the words without a DOM. Athena's words throughout, never
 * the file's: a file only supplies its name, summary, questions and content, each shown as its author's.
 */
import type { AddPreview } from "../../../lib/community-api";
import { LOOKUP_TOOLS } from "../../../lib/reach";
import type { Reach } from "../../../lib/reach";
import type { ShareKind } from "../../../lib/share-kinds";
import { FLOW_DRAFT_TOOLS, FLOW_LOOK_TOOLS, FLOW_SHARE_TOOLS, type FlowPick, type SharedFlowStep } from "../../../lib/flow-share";

export const KIND_LABEL: Record<ShareKind, string> = { assistant: "Assistant", skill: "Skill", flow: "Flow" };

/** "From Community", or "Not from Community" with where it did come from. */
export function originWords(p: Pick<AddPreview, "from" | "listing">): { community: boolean; title: string; detail: string } {
  if ("catalogue" in p.from) return { community: true, title: "From Community", detail: p.listing?.featured ? "Reviewed and featured in the catalogue" : "Reviewed for the catalogue" };
  if ("link" in p.from) return { community: false, title: "Not from Community", detail: linkWords(p.from.link) };
  return { community: false, title: "Not from Community", detail: p.from.files ? `From ${p.from.files}` : "From a file" };
}

/** "From github.com/sample-author/athena-items". */
export function linkWords(link: string): string {
  try {
    const u = new URL(link);
    const parts = u.pathname.split("/").filter(Boolean);
    return `From ${u.hostname.replace(/^www\./, "")}${parts.length ? `/${parts.slice(0, 2).join("/")}` : ""}`;
  } catch {
    return "From a link";
  }
}

/** "By @sample-author · version 1.2.0": who made it, as the file says. Empty when it doesn't say. */
export function makerWords(header: AddPreview["header"]): string {
  const parts: string[] = [];
  if (header.author) parts.push(`By @${header.author}`);
  if (header.version) parts.push(`version ${header.version}`);
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

/** "Based on github.com/…", when it says it was made from another item. */
export const basedOnWords = (header: AddPreview["header"]): string => (header.based_on ? `Based on ${header.based_on.replace(/^https:\/\/(www\.)?/, "")}` : "");

const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Its reach in plain words: the tier's headline, and a line for each thing it uses. */
export function reachWords(r: Reach, kind: ShareKind): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (r.model) lines.push(kind === "flow" ? "Some of its steps send what they work on to the AI model you've chosen" : "It sends what it works on to the AI model you've chosen");
  for (const tool of r.lookups) {
    const l = LOOKUP_TOOLS[tool];
    lines.push(l ? `${l.label}, from ${l.service}` : `Looks something up outside Athena`);
  }
  if (r.web) lines.push("It asks to search the web and read the pages it finds. That's off unless you allow it");
  if (r.tier === 1) return { title: "Nothing leaves your site", lines: ["Every step stays inside your Athena"] };
  if (r.tier === 3) return { title: "Can search the web", lines };
  if (r.lookups.length && !r.model) return { title: `Looks up ${list(r.lookups.map((t) => (LOOKUP_TOOLS[t]?.label ?? "something").toLowerCase()))}`, lines };
  return { title: r.lookups.length ? "Uses a model and a lookup" : "Uses a model", lines };
}

/** The confirmation once it's added: its headline, what to do next, and where it now lives. */
export function addedWords(kind: ShareKind, name: string): { title: string; body: string; open: string } {
  if (kind === "assistant") return { title: `${name} joined your team, paused`, body: "Nothing runs until you turn it on from its page. Its accounts and what it may do alone are there too.", open: `Open ${name}` };
  if (kind === "skill") return { title: `${name} is in your skills, off`, body: "Ask won't use it until you switch it on from its page.", open: "Open the skill" };
  return { title: `${name} is in your flows, off`, body: "It won't run until you turn it on. You can try it first from its page.", open: "Open the flow" };
}

const NOUN: Record<ShareKind, string> = { assistant: "assistant", skill: "skill", flow: "flow" };

/** "You already have this": what's here, which version, and the button that opens it. */
export function haveWords(kind: ShareKind, had: NonNullable<AddPreview["existing"]>, listed: string | null): { title: string; detail: string; open: string } {
  const open = kind === "assistant" ? "Open yours" : `Open your ${NOUN[kind]}`;
  if (!had.newer) return { title: "You already have this", detail: had.version ? `You added version ${had.version}, the same as this one.` : "You added it from Community, and it hasn't changed since.", open };
  const yours = had.version ? `You have version ${had.version}` : "You have an earlier version";
  return { title: "You already have this", detail: `${yours}. ${listed ? `This is version ${listed}` : "This one is newer"}: look it over, then update yours.`, open };
}

/** The confirmation once an Update is done. */
export function updatedWords(kind: ShareKind, name: string): { title: string; body: string; open: string } {
  const open = kind === "assistant" ? `Open ${name}` : kind === "skill" ? "Open the skill" : "Open the flow";
  const off = kind === "assistant" ? "paused" : "off";
  return { title: `${name} is updated, and ${off}`, body: `Its name and history stay. Look it over on its page, then switch it back on.`, open };
}

/** Under the Update button: what it changes. */
export function updateLandsWords(kind: ShareKind): string {
  return `Yours changes to this version and goes ${kind === "assistant" ? "paused" : "off"} until you switch it back on. Its name and history stay.`;
}

/** The Add button. */
export const addLabel = (kind: ShareKind, name: string): string => (kind === "assistant" ? `Add ${name} to your team` : `Add ${name}`);

/** Under the Add button: how it lands. */
export function landsWords(kind: ShareKind): string {
  if (kind === "assistant") return "It joins paused. Nothing runs until you turn it on.";
  if (kind === "skill") return "It starts off. Ask won't use it until you switch it on.";
  return "It starts off. Nothing runs until you turn it on.";
}

// ---------- a flow's steps ----------

/** Tools that change something: a flow step using one waits for the owner's Go once added. The rest only look. */
export const FLOW_CHANGE_TOOLS: ReadonlySet<string> = new Set(FLOW_SHARE_TOOLS.filter((t) => !FLOW_LOOK_TOOLS.includes(t)));

export const changesSomething = (s: SharedFlowStep): boolean => s.kind === "tool" && FLOW_CHANGE_TOOLS.has(s.tool);

/** The line under a step that changes something. */
export function goWords(s: SharedFlowStep): string | null {
  if (s.kind !== "tool" || !changesSomething(s)) return null;
  if (FLOW_DRAFT_TOOLS.includes(s.tool)) return "A draft: it always waits for your Go, and nothing is sent";
  return s.go === "auto" ? "It asked to run on its own. You can allow that once it's added" : null;
}

/** The hint under a question whose answer is one of the owner's records, lists or contexts. Empty for words. */
export function fillsWords(fills: string, pick?: FlowPick): string {
  if (pick === "list") return "The name of one of your lists. A new name starts a new list";
  if (pick) return "Pick one of your to-do contexts";
  if (fills === "text") return "";
  if (fills === "person") return "Pick one of your people";
  return `Type the name of one of your ${fills === "todo" ? "to-dos" : `${fills}s`}`;
}
