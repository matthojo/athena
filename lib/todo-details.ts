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
