/**
 * To-do contexts: the rules, shared by the server and the app (no I/O here).
 *
 * A to-do can carry one **area** (which part of life: Work, Health…) and one
 * **where/how** (Phone, Errands…), each optional. The owner keeps the list in
 * Settings → To do; the starter set below is seeded by migration 0037 and
 * keeps a stable `key` through renames, so the rules still find "Phone" after
 * it's renamed "Calls".
 *
 * `chooseContext` is the one place Athena decides a to-do's context when it
 * files one itself (collections, MCP agents, Ask, accepted suggestions). It
 * sets a context only when it's clear, in this order:
 *   1. the owner's last correction for the same sender or source (a hint);
 *   2. the source: a work account or a work tool means area Work;
 *   3. words in the title or notes ("call" → Phone, "dentist" → Health), when
 *      exactly one context matches;
 *   4. a personal account means area Personal;
 *   5. the model's suggestion, only when it said it's sure, the name is one of
 *      the owner's live contexts, and the words don't point elsewhere.
 * Anything else stays blank.
 */

export type ContextKind = "area" | "where";
export const CONTEXT_KINDS: readonly ContextKind[] = ["area", "where"];

export const CONTEXT_COLOURS = ["grey", "blue", "teal", "green", "amber", "orange", "red", "pink", "violet"] as const;
export type ContextColour = (typeof CONTEXT_COLOURS)[number];

/** Icons a context can use (names from the app's icon set). */
export const CONTEXT_ICONS = [
  "briefcase", "person", "heart", "wallet", "people", "home", "laptop", "phone", "bag", "building", "chat", "globe",
  "car", "paw", "book", "cup", "leaf", "plane", "gift", "star", "target", "flag", "music", "game", "pin", "tag",
] as const;

export const CONTEXT_LIMITS = { name: 30, perKind: 20 } as const;

export interface TodoContext {
  id: string;
  kind: ContextKind;
  /** The starter context it began as ("work", "phone"), kept through renames; null for the owner's own. */
  key: string | null;
  name: string;
  icon: string;
  colour: ContextColour;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StarterContext {
  kind: ContextKind;
  key: string;
  name: string;
  icon: (typeof CONTEXT_ICONS)[number];
  colour: ContextColour;
}

/** Seeded by migration 0037 in this order (keep the two in step). */
export const STARTER_CONTEXTS: readonly StarterContext[] = [
  { kind: "area", key: "work", name: "Work", icon: "briefcase", colour: "blue" },
  { kind: "area", key: "personal", name: "Personal", icon: "person", colour: "violet" },
  { kind: "area", key: "health", name: "Health", icon: "heart", colour: "red" },
  { kind: "area", key: "money", name: "Money", icon: "wallet", colour: "green" },
  { kind: "area", key: "family", name: "Family", icon: "people", colour: "amber" },
  { kind: "area", key: "home", name: "Home", icon: "home", colour: "teal" },
  { kind: "where", key: "computer", name: "Computer", icon: "laptop", colour: "blue" },
  { kind: "where", key: "phone", name: "Phone", icon: "phone", colour: "green" },
  { kind: "where", key: "errands", name: "Errands", icon: "bag", colour: "amber" },
  { kind: "where", key: "home", name: "Home", icon: "home", colour: "teal" },
  { kind: "where", key: "office", name: "Office", icon: "building", colour: "grey" },
  { kind: "where", key: "with_someone", name: "With someone", icon: "chat", colour: "pink" },
  { kind: "where", key: "anywhere", name: "Anywhere", icon: "globe", colour: "grey" },
];

// ---------- names ----------

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const singularOf = (s: string) => s.replace(/s$/, "");

/** Other words people use for a starter context, so "on my phone" or "out and about" finds it. */
const ALIASES: Record<string, string[]> = {
  "area:work": ["job", "office work"],
  "area:personal": ["me", "myself", "life"],
  "area:health": ["medical", "fitness", "wellbeing"],
  "area:money": ["finance", "finances", "admin money", "bills"],
  "area:family": ["kids", "relatives"],
  "area:home": ["house", "household", "flat"],
  "where:computer": ["laptop", "desk", "online", "mac", "pc"],
  "where:phone": ["calls", "call", "mobile", "on the phone", "on my phone", "iphone"],
  "where:errands": ["errand", "out", "out and about", "shops", "shopping", "town"],
  "where:home": ["at home", "house"],
  "where:office": ["at the office", "at work", "in the office"],
  "where:with_someone": ["in person", "together", "face to face", "with people", "someone"],
  "where:anywhere": ["any", "wherever", "anywhere at all"],
};

/** The live context of `kind` a name means: its own name first, then a starter's other words. Null when none or unclear. */
export function contextByName(name: string | null | undefined, contexts: readonly TodoContext[], kind: ContextKind): TodoContext | null {
  const n = norm(name ?? "");
  if (!n) return null;
  const live = contexts.filter((c) => c.kind === kind && !c.archived_at);
  const exact = live.filter((c) => norm(c.name) === n || singularOf(norm(c.name)) === singularOf(n));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const alias = live.filter((c) => c.key && (ALIASES[`${kind}:${c.key}`] ?? []).some((a) => a === n || singularOf(a) === singularOf(n)));
  return alias.length === 1 ? alias[0] : null;
}

// ---------- the source ----------

export type Account = "work" | "personal";

/** Tools that are only ever work. */
const WORK_TOOLS = /^(work-activity|linear|github|jira|confluence|asana|clickup|zendesk|salesforce|hubspot|notion-work|teams)(\b|-)/;

/**
 * Whose account an item came from, from its source ("email-digest-work",
 * "work-activity", "calendar-meetings-personal") or the collection's label.
 * Null when it doesn't say.
 */
export function accountOf(source: string | null | undefined, label?: string | null): Account | null {
  const l = norm(label ?? "");
  if (/\bwork\b/.test(l)) return "work";
  if (/\b(personal|home|family|private)\b/.test(l)) return "personal";
  const s = (source ?? "").toLowerCase();
  if (!s || s === "manual" || s === "assistant") return null;
  if (WORK_TOOLS.test(s)) return "work";
  const parts = s.split(/[-_:]+/);
  if (parts.includes("work")) return "work";
  if (parts.some((p) => p === "personal" || p === "home" || p === "family" || p === "private")) return "personal";
  return null;
}

// ---------- words ----------

/** Words that clearly put a to-do in a starter area. Kept short on purpose: when in doubt, leave it blank. */
const AREA_WORDS: Record<string, RegExp> = {
  health: /\b(dentist|doctors?|gp|nurse|prescriptions?|pharmacy|chemist|physio|physiotherapist|hospital|clinic|vaccin\w*|jab|blood test|optician|eye test|therap(y|ist)|medication|check ?up|dermatologist|surgery appointment)\b/,
  money: /\b(tax|tax return|self assessment|hmrc|bank|mortgage|pension|isa|insurance|refund|budget|savings|direct debit|credit card|loan|bills?|pay (the|my|back)|payslip|accountant)\b/,
  family: /\b(mum|mom|dad|kids?|school|nursery|grandma|grandad|grandpa|granny|nan|sister|brother|son|daughter|wife|husband|family|babysitter|parents evening|in laws)\b/,
  home: /\b(boiler|plumber|electrician|landlord|bins?|laundry|hoover|vacuum|dishwasher|fridge|garden|lawn|gutters?|fix the (tap|door|shelf|light)|tidy the|clean the (house|flat|kitchen|bathroom))\b/,
  work: /\b(deck|slides|standup|stand up|sprint|pull request|pr|code review|roadmap|okrs?|q[1-4]|client|stakeholders?|deploy|release notes|offsite|all hands|retro|jira|linear)\b/,
};

/** Where or how, from how the to-do starts or what it names. */
const WHERE_WORDS: Record<string, RegExp> = {
  phone: /^(call|ring|phone|facetime|text)\b|\bgive \w+ a (call|ring)\b|\bon the phone\b|\bcall (back|them|him|her)\b/,
  errands: /^(buy|pick up|collect|drop off)\b|\b(groceries|supermarket|post office|dry cleaning|the shops|food shop)\b/,
  computer: /^(draft|submit|upload|fill (in|out)|update the (doc|spreadsheet|deck|slides|wiki))\b|\b(online|spreadsheet|google doc|the doc|website|inbox|pull request)\b/,
  home: /^(tidy|hoover|vacuum|do the laundry|water the plants|take (out )?the bins)\b|\bat home\b/,
  office: /\b(at|in) the office\b/,
  with_someone: /^(discuss|talk to|chat (to|with)|catch up with|meet( up)? with)\b|\bin person\b|\bnext time (i|you) see\b/,
};

function wordMatches(text: string, words: Record<string, RegExp>, contexts: readonly TodoContext[], kind: ContextKind): TodoContext[] {
  const t = norm(text);
  if (!t) return [];
  const live = contexts.filter((c) => c.kind === kind && !c.archived_at);
  const hits = live.filter((c) => {
    if (c.key && words[c.key]?.test(t)) return true;
    // The owner's own contexts match on their own name ("Gym" in "Book gym induction").
    if (!c.key) return new RegExp(`\\b${norm(c.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
    return false;
  });
  return hits;
}

// ---------- choosing ----------

export type ContextReason = "correction" | "source" | "words" | "account" | "model" | "asked";

export interface ContextSignals {
  title: string;
  notes?: string | null;
  /** The item's source ("email-digest-work", "slack", "assistant"). */
  source?: string | null;
  /** The collection's label ("Work", "Personal"), when the writer knows it. */
  label?: string | null;
  /** The model's suggestion, as names. Used only when `sure`. */
  suggestion?: { area?: string | null; where?: string | null; sure?: boolean } | null;
  /** The owner's last correction for this sender or source. */
  hint?: { area_id: string | null; where_id: string | null } | null;
}

export interface ContextChoice {
  area_id: string | null;
  where_id: string | null;
  why: { area?: ContextReason; where?: ContextReason };
}

const liveId = (id: string | null | undefined, contexts: readonly TodoContext[], kind: ContextKind) =>
  id ? (contexts.find((c) => c.id === id && c.kind === kind && !c.archived_at)?.id ?? null) : null;

const byKey = (key: string, contexts: readonly TodoContext[], kind: ContextKind) =>
  contexts.find((c) => c.kind === kind && c.key === key && !c.archived_at) ?? null;

function pick(
  kind: ContextKind,
  s: ContextSignals,
  contexts: readonly TodoContext[],
  words: Record<string, RegExp>,
  fromSource: TodoContext | null,
  fromAccount: TodoContext | null,
): { id: string | null; why?: ContextReason } {
  const hinted = liveId(kind === "area" ? s.hint?.area_id : s.hint?.where_id, contexts, kind);
  if (hinted) return { id: hinted, why: "correction" };
  if (fromSource) return { id: fromSource.id, why: "source" };
  const hits = wordMatches([s.title, s.notes ?? ""].join(" \n "), words, contexts, kind);
  if (hits.length === 1) return { id: hits[0].id, why: "words" };
  if (!hits.length && fromAccount) return { id: fromAccount.id, why: "account" };
  const suggested = s.suggestion?.sure ? contextByName(kind === "area" ? s.suggestion.area : s.suggestion.where, contexts, kind) : null;
  // The model may break a tie between the words' candidates, or fill a blank, never overrule them.
  if (suggested && (!hits.length || hits.some((h) => h.id === suggested.id))) return { id: suggested.id, why: "model" };
  return { id: null };
}

/** The context Athena gives a to-do it files itself, or blanks when it isn't clear. */
export function chooseContext(s: ContextSignals, contexts: readonly TodoContext[]): ContextChoice {
  const account = accountOf(s.source, s.label);
  const workArea = account === "work" ? byKey("work", contexts, "area") : null;
  const personalArea = account === "personal" ? byKey("personal", contexts, "area") : null;
  const area = pick("area", s, contexts, AREA_WORDS, workArea, personalArea);
  const where = pick("where", s, contexts, WHERE_WORDS, null, null);
  const why: ContextChoice["why"] = {};
  if (area.why) why.area = area.why;
  if (where.why) why.where = where.why;
  return { area_id: area.id, where_id: where.id, why };
}

/**
 * Which earlier correction a to-do follows: the person it's with, else the
 * source that filed it. Null for the owner's own to-dos.
 */
export function hintKey(t: { source?: string | null; person_id?: string | null }): string | null {
  const source = t.source ?? "manual";
  if (source === "manual") return null;
  if (t.person_id) return `person:${t.person_id}`;
  if (source === "assistant") return null;
  return `source:${source}`;
}

// ---------- filtering and grouping (To do, Ask) ----------

/** A filter on one kind: a context's id, "none" for to-dos without one, or null for any. */
export type ContextFilter = string | "none" | null;

export interface HasContext {
  area_id?: string | null;
  where_id?: string | null;
}

/** An id that points at an archived or unknown context reads as no context. */
export function liveContextId(id: string | null | undefined, contexts: readonly TodoContext[], kind: ContextKind): string | null {
  return liveId(id, contexts, kind);
}

function matchesOne(id: string | null | undefined, filter: ContextFilter, contexts: readonly TodoContext[], kind: ContextKind): boolean {
  if (!filter) return true;
  const live = liveContextId(id, contexts, kind);
  if (filter === "none") return !live;
  // "Anywhere" to-dos can be done wherever you are, so they show under every where/how.
  if (kind === "where" && live && byKey("anywhere", contexts, "where")?.id === live) return true;
  return live === filter;
}

/** To-dos matching both filters (they combine). */
export function filterByContext<T extends HasContext>(items: readonly T[], f: { area?: ContextFilter; where?: ContextFilter }, contexts: readonly TodoContext[]): T[] {
  return items.filter((c) => matchesOne(c.area_id, f.area ?? null, contexts, "area") && matchesOne(c.where_id, f.where ?? null, contexts, "where"));
}

/** To-dos grouped by one kind of context, in the owner's order, with the ones without last. Empty groups are left out. */
export function groupByContext<T extends HasContext>(
  items: readonly T[],
  kind: ContextKind,
  contexts: readonly TodoContext[],
): Array<{ context: TodoContext | null; items: T[] }> {
  const live = contexts.filter((c) => c.kind === kind && !c.archived_at).sort((a, b) => a.position - b.position);
  const groups = new Map<string | null, T[]>();
  for (const it of items) {
    const id = liveContextId(kind === "area" ? it.area_id : it.where_id, contexts, kind);
    groups.set(id, [...(groups.get(id) ?? []), it]);
  }
  const out: Array<{ context: TodoContext | null; items: T[] }> = [];
  for (const c of live) if (groups.get(c.id)?.length) out.push({ context: c, items: groups.get(c.id)! });
  if (groups.get(null)?.length) out.push({ context: null, items: groups.get(null)! });
  return out;
}

/** Live contexts of one kind in the owner's order. */
export function contextsOf(contexts: readonly TodoContext[], kind: ContextKind): TodoContext[] {
  return contexts.filter((c) => c.kind === kind && !c.archived_at).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

/** A name the owner typed, tidied, or an error message. */
export function cleanContextName(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) return { error: "Give it a name" };
  if (name.length > CONTEXT_LIMITS.name) return { error: `Keep the name under ${CONTEXT_LIMITS.name} characters` };
  return { name };
}
