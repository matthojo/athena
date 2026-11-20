/**
 * Shared assistants (lib/team-share.ts) in plain words: what the share sheet took out
 * and flagged, and what the import sheet says about where one came from and
 * what it needs. Pure, so the tests can check the words without a DOM.
 */
import type { Finding, FindingKind, Removed, ImportNeed, ImportPreview } from "../../../lib/team-share";
import { connectorById } from "./trigger-editor-words";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "2 links to your notes and records", "1 link to your Athena's address": what the share sheet took out. */
export function removedWords(removed: readonly Removed[]): string[] {
  return removed.map((r) => {
    if (r.kind === "athena-link") return plural(r.count, "link to your notes and records", "links to your notes and records");
    if (r.kind === "site-link") return plural(r.count, "link to your Athena's address", "links to your Athena's address");
    return plural(r.count, "record id", "record ids");
  });
}

const KIND: Record<FindingKind, string> = {
  you: "About you",
  person: "One of your people",
  place: "One of your places",
  address: "An address you keep",
  organisation: "An organisation you keep",
  project: "One of your projects",
  email: "An email address",
  phone: "A phone number",
  account: "One of your accounts",
  link: "A link that may be private",
};

/** "One of your people": what a finding is. */
export function findingKindWords(kind: FindingKind): string {
  return KIND[kind];
}

const FIELD: Record<string, string> = {
  name: "name",
  job: "job",
  summary: "summary",
  instructions: "instructions",
  greeting: "greeting",
  traits: "traits",
  asks: "questions",
  triggers: "triggers",
  skill: "skill",
};

/** "In the instructions and the skill", "In shops.md": where a finding is. */
export function whereWords(where: readonly string[]): string {
  const parts = where.map((w) => (w.startsWith("file:") ? w.slice(5) : `the ${FIELD[w] ?? w}`));
  return `In ${list(parts)}`;
}

/** The share sheet's line over its findings. */
export function findingsLede(findings: readonly Finding[]): string {
  if (!findings.length) return "Nothing is flagged. Athena checked for your people, places, contact details and private links. Read it through yourself before you share it.";
  const one = findings.length === 1;
  return `${one ? "This looks like one" : "These look like some"} of your own details. Edit ${one ? "it" : "them"} out below, or mark ${one ? "it" : "them"} fine to share.`;
}

/** "Linear", "Calendar", "Outlook mail": an account's name. */
export function accountName(id: string): string {
  const known = connectorById(id)?.label;
  if (known) return known;
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Linear is connected" or "Needs Linear, which isn't connected. What it does with Linear starts once you connect it." */
export function needWords(n: ImportNeed): string {
  const name = accountName(n.id);
  return n.connected ? `${name} is connected` : `Needs ${name}, which isn't connected. What it does with ${name} starts once you connect it.`;
}

/** "From github.com/sample-author/athena-assistants", "From muse.zip". */
export function fromWords(p: Pick<ImportPreview, "source">): string {
  const s = p.source;
  if (s.kind === "link" && s.url) {
    try {
      const u = new URL(s.url);
      const parts = u.pathname.split("/").filter(Boolean);
      return `From ${u.hostname.replace(/^www\./, "")}${parts.length ? `/${parts.slice(0, 2).join("/")}` : ""}`;
    } catch {
      return "From a link";
    }
  }
  return s.file ? `From ${s.file}` : "From a file";
}

/** "By @sample-author · version 1.2.0 · based on github.com/…": who made it, when it says. Empty when it doesn't. */
export function creditWords(w: { author?: string; version?: string; based_on?: string }): string {
  const parts: string[] = [];
  if (w.author) parts.push(`By @${w.author}`);
  if (w.version) parts.push(`version ${w.version}`);
  if (w.based_on) parts.push(`based on ${w.based_on.replace(/^https:\/\/(www\.)?/, "")}`);
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}
