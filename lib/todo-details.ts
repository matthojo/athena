/**
 * A to-do's details beyond its title (migration 0084): its steps (a
 * checklist), its links (web pages and things in Athena) and its priority.
 * The description is the commitment's existing `notes`, as Markdown.
 *
 * Steps and links are stored sealed, each list as one JSON value on the row
 * (lib/encryption.ts), and every write replaces the whole list. These are the
 * pure rules for both: what a valid list looks like, how an agent's loose
 * input is tidied into one, and the counts the app and agents show. The
 * server (lib/memory.ts upsertCommitment), the app's sample mode and the MCP
 * tool all go through cleanSteps() and cleanLinks().
 */

import { athenaUrl, escapeLabel, parseAthenaUrl, type LinkKind } from "./links";

/** Bad input. The server turns it into a 400 (lib/memory.ts); this file stays free of server code so the app can use it. */
export class TodoDetailsError extends Error {}

export interface TodoStep {
  /** Stable within the to-do, so a reorder or a tick never mixes two steps up. */
  id: string;
  text: string;
  done: boolean;
}

export interface TodoLink {
  id: string;
  /** An http(s) address, or athena://<kind>/<uuid> for something in Athena. */
  url: string;
  /** What the link is called; for an Athena link, the item's name when it was linked. */
  title: string;
}

/** 0 none, 1 low, 2 medium, 3 high. */
export type TodoPriority = 0 | 1 | 2 | 3;
export const PRIORITIES: readonly TodoPriority[] = [0, 1, 2, 3];
export const PRIORITY_LABEL: Record<TodoPriority, string> = { 0: "No priority", 1: "Low", 2: "Medium", 3: "High" };

export const MAX_STEPS = 100;
export const STEP_LENGTH = 300;
export const MAX_LINKS = 30;
export const LINK_TITLE_LENGTH = 200;
const URL_LENGTH = 2000;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

let seq = 0;
/** A short id for a new step or link. Unique enough within one to-do. */
export function newItemId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${rand}${(++seq).toString(36)}`;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A step list from anything: an array of strings ("Call the surgery") or of
 * { id?, text, done? }. Blank steps go, text is trimmed to one line and
 * STEP_LENGTH, ids are kept when valid and unique (else given one). Throws
 * on more than MAX_STEPS or on something that isn't a list at all.
 */
export function cleanSteps(raw: unknown): TodoStep[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TodoDetailsError("'steps' must be a list");
  if (raw.length > MAX_STEPS) throw new TodoDetailsError(`A to-do can have at most ${MAX_STEPS} steps`);
  const seen = new Set<string>();
  const out: TodoStep[] = [];
  for (const item of raw) {
    const obj = typeof item === "string" ? { text: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!obj || typeof obj.text !== "string") throw new TodoDetailsError("Each step needs its text");
    const text = squash(obj.text).slice(0, STEP_LENGTH);
    if (!text) continue;
    let id = typeof obj.id === "string" && ID_RE.test(obj.id) && !seen.has(obj.id) ? obj.id : newItemId();
    while (seen.has(id)) id = newItemId();
    seen.add(id);
    out.push({ id, text, done: obj.done === true });
  }
  return out;
}

/** Lines pasted into a step, as steps' words: list marks and checkboxes trimmed off, blank lines dropped. */
export function pastedSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])?\s*(?:\[[ xX]?\]\s*)?/, "").trim())
    .filter(Boolean);
}

/** http(s) only, or an athena:// link to something that can be linked. Null when it's neither. */
export function cleanLinkUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > URL_LENGTH) return null;
  const athena = parseAthenaUrl(v);
  if (athena) return athenaUrl(athena.kind, athena.id);
  // A bare "example.com/page" is a web address too.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v) ? `https://${v}` : v;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** A web link's site as people say it: "nhs.uk", "docs.example.com". */
export function linkSite(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A link list from anything: strings (addresses) or { id?, url, title? }.
 * An address that isn't http(s) or a valid athena:// link is refused, the
 * same address twice is kept once, and an untitled web link is called by its
 * site. Throws on more than MAX_LINKS.
 */
export function cleanLinks(raw: unknown): TodoLink[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TodoDetailsError("'links' must be a list");
  if (raw.length > MAX_LINKS) throw new TodoDetailsError(`A to-do can have at most ${MAX_LINKS} links`);
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const out: TodoLink[] = [];
  for (const item of raw) {
    const obj = typeof item === "string" ? { url: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!obj || typeof obj.url !== "string") throw new TodoDetailsError("Each link needs its address");
    const url = cleanLinkUrl(obj.url);
    if (!url) throw new TodoDetailsError(`Not a link Athena can keep: ${obj.url.slice(0, 80)}`);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    const given = typeof obj.title === "string" ? squash(obj.title).slice(0, LINK_TITLE_LENGTH) : "";
    const title = given || (parseAthenaUrl(url) ? "Untitled" : linkSite(url));
    let id = typeof obj.id === "string" && ID_RE.test(obj.id) && !seenIds.has(obj.id) ? obj.id : newItemId();
    while (seenIds.has(id)) id = newItemId();
    seenIds.add(id);
    out.push({ id, url, title });
  }
  return out;
}

export function cleanPriority(raw: unknown): TodoPriority | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !PRIORITIES.includes(n as TodoPriority)) throw new TodoDetailsError("'priority' must be 0 (none), 1 (low), 2 (medium) or 3 (high)");
  return n as TodoPriority;
}

/** A stored list (a JSON string once opened, an array from sample data, or nothing) as a list. */
export function readList<T>(raw: unknown, clean: (v: unknown) => T[]): T[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Sealed under a key this copy doesn't have: shown as no items rather than breaking the to-do.
      return [];
    }
  }
  try {
    return clean(value);
  } catch {
    return [];
  }
}

export interface StepProgress {
  done: number;
  total: number;
}

export function stepProgress(steps: readonly TodoStep[] | null | undefined): StepProgress {
  const list = steps ?? [];
  return { done: list.filter((s) => s.done).length, total: list.length };
}

/** The Athena item an athena:// link points at, or null for a web link. */
export function linkTarget(link: Pick<TodoLink, "url">): { kind: LinkKind; id: string } | null {
  return parseAthenaUrl(link.url);
}

/**
 * The to-do's text that can link to things, for content edges and search:
 * its description, then each link as Markdown. Mentions in either become
 * graph edges from the to-do (lib/db.ts syncContentLinks).
 */
export function linkableText(t: { notes?: string | null; links?: readonly TodoLink[] | null }): string {
  const links = (t.links ?? []).map((l) => `[${escapeLabel(l.title)}](${l.url})`);
  return [t.notes ?? "", ...links].filter(Boolean).join("\n");
}

/** Steps as plain text, one per line, for search and agents. */
export function stepsText(steps: readonly TodoStep[] | null | undefined): string {
  return (steps ?? []).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`).join("\n");
}

// ---------- steps that Athena files itself ----------

/**
 * What a step is, for every prompt that can add one (collections, Ask, Team
 * assistants, flows, MCP). Most action items are to-dos of their own, and a
 * meeting's list of actions is not one to-do's checklist, so the rule leans
 * towards leaving steps out.
 */
export const STEPS_RULE =
  "Steps are the parts of one to-do that the owner works through to finish it, and only when the source spells them out (a checklist, " +
  "\"first X, then Y\", the documents a form needs). Each step only makes sense inside that to-do. Anything that would stand alone is a to-do in " +
  "its own right: a separate promise, something for a different person or with its own due date, another person's action item, or the " +
  "next item in a meeting's list of actions. Don't break a simple to-do into steps, don't make up steps the source doesn't give, and leave " +
  "steps out when unsure.";

/** The same rule in one line, for tool descriptions where space is tight. */
export const STEPS_RULE_SHORT =
  "Only the parts of this one to-do that the source spells out (a checklist, \"first X, then Y\"); anything that stands on its own, " +
  "has its own person or date, or is the next action from a meeting is a separate to-do. Leave out when unsure, never invent them.";

/** Most steps an agent files on one to-do; a longer list is a project, not a to-do. */
export const MAX_FILED_STEPS = 12;

const sameWords = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Steps an agent (a collection, Athena's own summaries) offers for a to-do, tidied
 * before they're kept: blanks and repeats go, as does a step that only restates
 * the title. One step left on its own is the to-do said twice, so it's dropped,
 * and more than MAX_FILED_STEPS means the agent split up something bigger, so
 * none are kept rather than a cut-off list. The owner (in the app or asking Ask)
 * isn't held to this: they asked for what they asked for.
 */
export function filedSteps(title: string, raw: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const s of raw ?? []) {
    const text = s.replace(/\s+/g, " ").trim().slice(0, STEP_LENGTH);
    if (!text || sameWords(text, title) || out.some((o) => sameWords(o, text))) continue;
    out.push(text);
  }
  if (out.length < 2 || out.length > MAX_FILED_STEPS) return [];
  return out;
}

/** Priority as Ask's tools and agents say it. */
export const PRIORITY_NAMES = ["none", "low", "medium", "high"] as const;
export type PriorityName = (typeof PRIORITY_NAMES)[number];
export const priorityOfName = (name: PriorityName): TodoPriority => PRIORITY_NAMES.indexOf(name) as TodoPriority;
export const nameOfPriority = (p: TodoPriority | null | undefined): PriorityName => PRIORITY_NAMES[p ?? 0] ?? "none";

// ---------- for Ask's tools (lib/assistant.ts, lib/assistant-records.ts) ----------

/** Links Ask was given for a to-do: kept when they're web or athena:// addresses, a clear error when one isn't. */
export function askLinks(raw: readonly string[] | undefined): TodoLink[] {
  if (!raw?.length) return [];
  try {
    return cleanLinks([...raw]);
  } catch (error) {
    if (error instanceof TodoDetailsError) throw new Error(`${error.message}. Links are https addresses or athena://<kind>/<id>.`);
    throw error;
  }
}

/** "3 steps", "2 links", "High priority": what a to-do carries besides its title, for what Ask did. */
export function todoExtras(c: { steps?: { done: boolean }[]; links?: unknown[]; priority?: number; notes?: string }): string[] {
  const out: string[] = [];
  const p = stepProgress(c.steps as TodoStep[] | undefined);
  if (p.total) out.push(p.done ? `${p.done} of ${p.total} steps done` : `${p.total} ${p.total === 1 ? "step" : "steps"}`);
  const n = c.links?.length ?? 0;
  if (n) out.push(`${n} ${n === 1 ? "link" : "links"}`);
  if (c.priority) out.push(`${nameOfPriority(c.priority as TodoPriority).replace(/^./, (x) => x.toUpperCase())} priority`);
  return out;
}
