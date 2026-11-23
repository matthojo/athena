/**
 * What an item someone else shared may reach (SECURITY.md §10, "Items someone else shared"). Pure and shared with
 * the app: the import sheet, an imported assistant's page and an imported skill's page read the same lists the
 * server enforces.
 *
 * - Tools: a shared assistant's `would_like` is a request. Only changes inside Athena that keep an Undo (the
 *   flows catalogue's "add" group, lib/flow-catalog.ts) and `track` can be granted on import; anything else it
 *   asks for always waits for the owner's Go. lib/shared-limits.test.ts checks this list against the catalogue.
 * - Accounts: an imported assistant (its runs and chats) and an imported skill (while it's in use) open only the
 *   connected accounts the owner ticked for that item. Nothing is ticked to start.
 */
import type { SkillSourceKind } from "./skills";

export interface SharedToolLabel {
  /** The tick's label: "Add to-dos". */
  label: string;
  /** One quiet line under it. */
  detail: string;
}

/** The tools a shared assistant may be allowed to run alone, in the order the import sheet shows them, with plain labels. */
export const SHARED_TOOLS: Readonly<Record<string, SharedToolLabel>> = {
  add_todo: { label: "Add to-dos", detail: "Puts new to-dos on your list" },
  complete_todo: { label: "Tick off to-dos", detail: "Marks to-dos as done" },
  change_todo: { label: "Change to-dos", detail: "Their words, due day, person or steps" },
  add_reminder: { label: "Set reminders", detail: "Adds reminders with a time" },
  save_note: { label: "Write notes", detail: "Writes a new note, or adds to one" },
  add_to_list: { label: "Add to your lists", detail: "Gift ideas, shopping, packing and other lists" },
  add_to_watch_read: { label: "Add to Watch & read", detail: "Books, films, shows and podcasts" },
  update_watch_read: { label: "Update Watch & read", detail: "Marks things started or finished" },
  add_person: { label: "Add people", detail: "New people in your contacts" },
  remember: { label: "Remember things", detail: "Keeps facts about the people you know" },
  log_catch_up: { label: "Log catch-ups", detail: "Records when you last spoke to someone" },
  save_item: { label: "Add or change items", detail: "Places, events, goals and life admin" },
  set_field: { label: "Set your fields", detail: "Shoe size, rating and the like" },
  save_record: { label: "Add to your own types", detail: "Records in a type you keep" },
  link_records: { label: "Link things", detail: "A note to a person, a place to an event" },
  save_trip: { label: "Add trips", detail: "A place and its dates" },
  save_purchase: { label: "Log orders", detail: "Something you ordered" },
  file_saved_item: { label: "File saved things", detail: "Onto Watch & read, Places, a list or a to-do" },
  track: { label: "Track a price or a page", detail: "Checks it now and then, and tells you when it changes" },
};

/** Can an import grant this tool? Pure. */
export const sharedToolAllowed = (name: string): boolean => Object.prototype.hasOwnProperty.call(SHARED_TOOLS, name);

/** A tool name someone else wrote, as words: "archive_or_restore" → "Archive or restore". Pure. */
export const toolWords = (name: string): string => {
  const s = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
};

/** A shared assistant's requests split: what the owner may tick, and what always asks first. Pure. */
export function splitWouldLike(wouldLike: readonly string[]): { offered: string[]; asksFirst: string[] } {
  const offered: string[] = [];
  const asksFirst: string[] = [];
  for (const t of wouldLike) {
    const into = sharedToolAllowed(t) ? offered : asksFirst;
    if (!into.includes(t)) into.push(t);
  }
  return { offered, asksFirst };
}

// ---------- accounts ----------

/** Skills from a file or a link: someone else's words. Pure. */
export const SHARED_SKILL_SOURCES: ReadonlySet<SkillSourceKind> = new Set(["upload", "link"]);

/** Is this skill someone else's (imported from a file or a link)? Pure. */
export const skillImported = (source: { kind?: string } | null | undefined): boolean => !!source && SHARED_SKILL_SOURCES.has(source.kind as SkillSourceKind);

/**
 * Is this assistant someone else's? Recorded, never guessed: its row says it was imported (`origin`, migration
 * 0085), or its own skill came from a file or a link (only an import writes one so). Pure.
 */
export const assistantImported = (origin: string | null | undefined, ownSkillSource?: { kind?: string } | null): boolean => origin === "shared" || skillImported(ownSkillSource);

/** Most accounts an item can have ticked. */
export const MAX_ITEM_ACCOUNTS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ticked account ids as sent, checked: ids only, each once, and only ones in `known` when it's given. Pure. */
export function cleanAccountIds(raw: unknown, known?: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !UUID.test(v)) continue;
    const id = v.toLowerCase();
    if (known && !known.has(id)) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= MAX_ITEM_ACCOUNTS) break;
  }
  return out;
}

/** A connected account as the tick rows show it. */
export interface AccountRow {
  id: string;
  provider: string;
  name: string;
  /** "sam@example.com", when the account has one. */
  label?: string | null;
}

/** The rows in order: the accounts the file says it needs first (in its order), then the rest by name. Pure. */
export function orderAccounts<T extends Pick<AccountRow, "provider" | "name">>(accounts: readonly T[], needs: readonly string[] = []): T[] {
  const rank = (a: T) => {
    const i = needs.indexOf(a.provider);
    return i === -1 ? needs.length : i;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
