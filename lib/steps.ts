/**
 * Ask's live steps: one short line per thing Athena does while it works on a
 * request ("Looking for Rowan", then "Found Rowan Hart"), streamed to the
 * app as NDJSON when it asks for them (netlify/functions/api.ts) and saved
 * with the conversation.
 *
 * Every line is written here from the tool's name, its input and what it
 * returned: no extra model calls, so steps cost nothing on AI Gateway. Names
 * and titles come from the owner's own data or the owner's own words; they're
 * shown as plain text, never as markup.
 */
import { RateLimited } from "./ai";
import type { Change } from "./assistant";
import { KIND_WORD } from "./custom-kind-words";
import { AthenaInputError } from "./db";

/** One step. A step with the same id replaces the one before it: the running line, then how it ended. */
export interface Step {
  id: string;
  text: string;
  /** false while it runs. */
  done: boolean;
  /** It may change something (not just look): if the reply is cut off after this started, it isn't asked again. */
  acts?: boolean;
  /** It failed or didn't matter (the model retries with another input): take it away. */
  dropped?: boolean;
  /** What it changed, so a reply cut off part-way can still show (and undo) it. */
  changes?: Change[];
}

export type StepSink = (step: Step) => void;

/** The NDJSON events of a streamed reply. Blank lines are keep-alives. */
export type StepStreamEvent =
  | ({ type: "step" } & Step)
  /** The reply's words as they're written (lib/ask-stream.ts): new characters, or take back what came so far. */
  | ({ type: "text" } & import("./ask-stream").TextEvent)
  | { type: "done"; reply: unknown }
  /** `retry_after`: with a 429, the seconds until the gateway takes requests again, when it said (lib/ai.ts RateLimited). A streamed reply has no header to carry it. */
  | { type: "error"; status: number; message: string; retry_after?: number };

/**
 * How a run that threw ends for the app: a 429 carries the gateway's wait when it gave one, an input error its
 * own status and words. Null: not one of ours, so the caller logs it and sends a plain 500.
 */
export function streamError(error: unknown): { status: number; message: string; retry_after?: number } | null {
  if (error instanceof RateLimited) return { status: 429, message: error.message, ...(error.retryAfter ? { retry_after: error.retryAfter } : {}) };
  if (error instanceof AthenaInputError) return { status: error.status, message: error.message };
  // Today's AI budget is used (lib/spend.ts BudgetReached): its message is the owner's.
  if ((error as { code?: unknown } | null)?.code === "budget_reached" && error instanceof Error) return { status: 402, message: error.message };
  if ((error as { code?: unknown } | null)?.code === "budget_unchecked" && error instanceof Error) return { status: 503, message: error.message };
  return null;
}

const clip = (s: unknown, n = 44): string => {
  const t = String(s ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const str = (input: unknown, key: string): string => {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v.trim() : "";
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function parsed(result: string): unknown {
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

const listOf = (result: string): Array<Record<string, unknown>> | null => {
  // A result Jev flagged starts with a warning before its JSON.
  const v = parsed(result) ?? (result.indexOf("[") > 0 ? parsed(result.slice(result.indexOf("["))) : null);
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : null;
};

/** How many find_people found: a list, or { people, total } when there were more than it showed. */
const peopleFound = (result: string): Array<Record<string, unknown>> & { total?: number } => {
  const list = listOf(result);
  if (list) return list;
  const v = parsed(result) as { people?: unknown; total?: unknown } | null;
  return Array.isArray(v?.people) ? Object.assign(v.people as Array<Record<string, unknown>>, { total: Number(v.total) || undefined }) : [];
};

/** The number of things a change touched, from its result ({ changed: n }). */
const changedCount = (result: string): number => Number((parsed(result) as { changed?: unknown } | null)?.changed) || 0;

/** What find_items and archive_or_restore call each kind, in a step. */
const KIND_STEP: Record<string, [string, string]> = {
  place: ["place", "places"],
  organisation: ["organisation", "organisations"],
  event: ["event", "events"],
  project: ["project", "projects"],
  reading: ["Watch & read item", "Watch & read items"],
  goal: ["goal", "goals"],
  asset: ["life admin item", "life admin items"],
  trip: ["trip", "trips"],
  booking: ["booking", "bookings"],
  purchase: ["purchase", "purchases"],
  reminder: ["reminder", "reminders"],
  note: ["note", "notes"],
  person: ["person", "people"],
  todo: ["to-do", "to-dos"],
  catch_up: ["catch-up", "catch-ups"],
  detail: ["detail", "details"],
  record: ["record", "records"],
  type: ["type", "types"],
};
const kindWord = (input: unknown, many = false) => (KIND_STEP[str(input, "kind")] ?? ["item", "items"])[many ? 1 : 0];

/** "Already on the list" and other no-change results: { done: "…" } without a change. */
const noChange = (result: string): boolean => {
  const v = parsed(result) as { done?: unknown } | null;
  return !!v && typeof v.done === "string" && /^No change|already/i.test(v.done);
};

/** A booking's kind in a step: "Adding the flight". */
const BOOKING_WORD: Record<string, string> = { flight: "flight", train: "train", hotel: "hotel stay", car: "car hire", event: "ticket", other: "booking" };

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- The assistant (lib/assistant.ts) ----------

/** The assistant's tools that only look. Everything else may change something. */
const LOOKS = new Set(["find_people", "find_notes", "read_note", "find_todos", "find_watch_read", "train_status", "flight_status", "car_details", "find_items", "find_records", "list_fields", "list_kinds", "ask_owner"]);

export const stepActs = (name: string): boolean => !LOOKS.has(name) && !READ_STEPS[name];

/** The running line for one of the assistant's tools, or null for one that isn't a step (ask_owner). */
export function assistantStepStart(name: string, input: unknown): string | null {
  const q = clip(str(input, "query"), 32);
  switch (name) {
    case "find_people":
      return q ? `Looking for ${q}` : "Looking through your people";
    case "add_person":
      return `Adding ${clip(str(input, "name"), 32)} to People`;
    case "find_notes":
      return q ? `Searching notes for ${q}` : "Looking through their notes";
    case "read_note":
      return "Reading a note";
    case "add_to_list":
      return `Adding ${clip(str(input, "item"), 32)}`;
    case "save_note":
      return str(input, "note_id") ? "Updating a note" : "Saving a note";
    case "find_todos":
      return "Checking your to-dos";
    case "add_todo":
      return "Adding a to-do";
    case "draft_email":
      return "Writing an email";
    case "draft_message": {
      const ch = str(input, "channel");
      return ch === "text" ? "Writing a text" : ch === "whatsapp" ? "Writing a WhatsApp" : ch === "telegram" ? "Writing a Telegram message" : ch === "slack" ? "Writing a Slack message" : ch === "email" ? "Writing an email" : "Writing a message";
    }
    case "complete_todo":
      return "Ticking it off";
    case "add_reminder":
      return "Setting a reminder";
    case "remember":
      return "Saving a detail";
    case "log_catch_up":
      return "Logging a catch-up";
    case "find_watch_read":
      return "Checking Watch & read";
    case "train_status":
      return "Checking live train times";
    case "flight_status":
      return "Checking live flight times";
    case "car_details":
      return "Checking your car";
    case "add_to_watch_read":
      return `Adding ${clip(str(input, "title"), 32)} to Watch & read`;
    case "update_watch_read":
      return "Updating Watch & read";
    case "attach_file":
      return "Attaching a file";
    case "save_trip":
      return str(input, "trip_id") ? "Updating a trip" : `Adding a trip${str(input, "title") ? ` to ${clip(str(input, "title"), 28)}` : ""}`;
    case "save_booking": {
      if (str(input, "booking_id")) return str(input, "status") === "cancelled" ? "Cancelling a booking" : "Changing a booking";
      const what = BOOKING_WORD[str(input, "kind")] ?? "booking";
      const to = str(input, "kind") === "flight" || str(input, "kind") === "train" ? clip(str(input, "end_city"), 24) : "";
      return `Adding the ${what}${to ? ` to ${to}` : ""}`;
    }
    case "save_purchase":
      if (!str(input, "purchase_id")) return `Adding an order${str(input, "retailer") ? ` from ${clip(str(input, "retailer"), 28)}` : ""}`;
      return str(input, "tracking_number") || str(input, "tracking_url") ? "Adding tracking" : "Updating an order";
    case "track": {
      const preset = str(input, "preset");
      const label = clip(str(input, "label"), 24);
      return preset === "price" ? "Tracking the price" : preset === "stock" ? "Tracking stock" : label ? `Tracking ${label.toLowerCase()}` : "Starting to track it";
    }
    case "record_value":
      return (str(input, "preset") || str(input, "label") || "price") === "price" ? "Keeping the price" : "Keeping the check";
    case "set_tracker_target":
      return input && typeof input === "object" && (input as { clear?: unknown }).clear ? "Clearing the target" : "Setting a target";
    case "ask_owner":
      return null;
    case "find_items":
      return q ? `Looking for ${q}` : `Looking through your ${kindWord(input, true)}`;
    case "find_records":
    case "list_fields":
    case "list_kinds":
      return "Looking it up";
    case "update_people": {
      const ids = input && typeof input === "object" && Array.isArray((input as { ids?: unknown }).ids) ? (input as { ids: unknown[] }).ids.length : 0;
      const match = clip(str(input, "match"), 32);
      return ids > 1 ? `Updating ${ids} people` : match ? `Updating everyone matching ${match}` : "Updating a person";
    }
    case "save_item":
      return str(input, "id") ? `Updating a ${kindWord(input)}` : `Adding a ${kindWord(input)}`;
    case "change_todo":
      return "Changing a to-do";
    case "change_reminder":
      return "Changing a reminder";
    case "link_records":
      return (input as { link?: unknown } | null)?.link === false ? "Unlinking them" : "Linking them";
    case "archive_or_restore": {
      const n = input && typeof input === "object" && Array.isArray((input as { ids?: unknown }).ids) ? (input as { ids: unknown[] }).ids.length : 1;
      const what = n > 1 ? `${n} ${kindWord(input, true)}` : `a ${kindWord(input)}`;
      return (input as { archive?: unknown } | null)?.archive === false ? `Restoring ${what}` : `Archiving ${what}`;
    }
    case "answer_invite":
      return "Answering the invite";
    case "update_kind":
      return `Changing a ${KIND_WORD.one}`;
    case "change_field":
      return `Changing ${clip(str(input, "field"), 32) || "a field"}`;
    case "save_routine":
      return str(input, "routine_id") ? "Changing a routine" : "Setting up a routine";
    case "save_recipe":
      return "Saving a recipe";
    // Assignments and documents (lib/assignment-tools.ts, lib/assistant-documents.ts).
    case "start_assignment":
      return "Picking a lineup";
    // Flows (lib/flow-draft-ask.ts).
    case "propose_flow":
      return "Drawing a flow";
    case "continue_assignment":
      return "Carrying on with the assignment";
    case "hand_off":
      return "Handing off";
    case "make_document":
      return str(input, "format") === "docx" ? "Making a Word document" : "Making a Markdown file";
    default:
      if (READ_STEPS[name]) return READ_STEPS[name][0];
      return "Making a change";
  }
}

/** How a step ended, from what the tool returned and what it changed. */
export function assistantStepDone(name: string, input: unknown, result: string, changes: Change[]): string {
  const change = changes[changes.length - 1];
  if (!change && READ_STEPS[name]) return READ_STEPS[name][1];
  if (!change && noChange(result)) {
    if (name === "add_to_list") return `${clip(str(input, "item"), 32)} was already on the list`;
    if (name === "add_to_watch_read") return `${clip(str(input, "title"), 32)} was already on Watch & read`;
    return "Nothing needed changing";
  }
  switch (name) {
    case "find_people": {
      const found = peopleFound(result);
      const total = found.total ?? found.length;
      const q = clip(str(input, "query"), 32);
      const aName = /^[\p{L}' .-]+$/u.test(q);
      if (!total) return q ? (aName ? `No one called ${q} yet` : `No one matches ${q}`) : "No one found";
      if (total === 1) return `Found ${clip(found[0].name, 40)}`;
      const byName = found.every((p) => p.matched_on === "name" || p.matched_on === "alias" || p.matched_on === "partial_name");
      return q ? `Found ${total} people ${byName ? "called" : "matching"} ${q}` : `Found ${count(total, "person", "people")}`;
    }
    case "find_notes": {
      const n = listOf(result)?.length ?? 0;
      return n ? `Found ${count(n, "note")}` : "No notes match";
    }
    case "save_recipe":
      return change ? `Saved ${clip(change.title, 40)} to Recipes` : "Saved a recipe";
    case "read_note": {
      const v = parsed(result) as { title?: unknown } | null;
      return v?.title ? `Read ${clip(v.title)}` : "Read a note";
    }
    case "find_todos": {
      const n = listOf(result)?.length ?? 0;
      return n ? `Found ${count(n, (input as { include_done?: unknown } | null)?.include_done ? "to-do" : "open to-do")}` : "No matching to-dos";
    }
    case "find_watch_read": {
      const n = listOf(result)?.length ?? 0;
      return n ? `Found ${count(n, "item")} on Watch & read` : "Nothing like it on Watch & read";
    }
    case "find_items": {
      const n = listOf(result)?.length ?? 0;
      return n ? `Found ${count(n, kindWord(input), kindWord(input, true))}` : `No ${kindWord(input, true)} match`;
    }
    case "find_records":
    case "list_fields":
    case "list_kinds":
      return "Looked it up";
    case "train_status":
      return "Checked live train times";
    case "flight_status":
      return "Checked live flight times";
    case "car_details":
      return "Checked your car";
    case "start_assignment":
      return "Picked a lineup";
    case "propose_flow":
      return "Drew a flow";
    case "continue_assignment":
      return (parsed(result) as { done?: unknown } | null)?.done ? "Carried on with the assignment" : "Nothing moved on";
    case "hand_off":
      return "Handed off";
  }
  if (!change) return assistantStepStart(name, input) ?? "Done";
  const title = clip(change.title);
  switch (name) {
    case "add_person":
      return `Added ${title} to People`;
    case "add_to_list": {
      const item = clip(str(input, "item"), 32);
      const list = clip(str(input, "list_title") ? capital(str(input, "list_title")) : change.title, 36);
      return change.action === "created" ? `Added ${item} to a new list, ${list}` : `Added ${item} to ${list}`;
    }
    case "save_note":
      return change.action === "created" ? `Saved ${title}` : `Updated ${title}`;
    case "attach_file":
      return `${clip(change.detail, 40)} to ${title}`;
    case "add_todo":
      return `Added ${title} to your to-dos`;
    case "draft_email":
    case "draft_message": {
      const drafts = change.detail.match(/in (Gmail|Outlook) Drafts/);
      if (drafts) return `Put an email in your ${drafts[1]} Drafts`;
      const what = change.detail.match(/^(Email|Text|WhatsApp|Telegram message|Slack message) to/)?.[1] ?? "Message";
      return what === "Email" ? "Wrote an email for you to send" : `Wrote a ${what === "Text" ? "text" : what} for you to send`;
    }
    case "complete_todo":
      return `Ticked off ${title}`;
    case "add_reminder":
      return `Set a reminder: ${clip(change.detail.replace(/^Reminder · /, ""), 30)}`;
    case "remember":
      return `Noted a detail about ${title}`;
    case "log_catch_up":
      return `Logged a catch-up with ${title}`;
    case "add_to_watch_read":
      return `Added ${title} to Watch & read`;
    case "update_watch_read":
      return `${title}: ${clip(change.detail.split(" · ").pop() ?? "updated", 24).toLowerCase()}`;
    case "update_people": {
      const n = changedCount(result);
      return n > 1 ? `Updated ${n} people` : `Updated ${title}`;
    }
    case "save_item":
      return change.action === "created" ? `Added ${title}` : `Updated ${title}`;
    case "save_trip":
      return change.action === "created" ? `Added a trip: ${title}` : `Updated ${title}`;
    case "save_booking":
      if (change.action === "created") return change.kind === "trip" ? `Added it to a new trip, ${title}` : `Added ${title}`;
      return /Cancelled$/.test(change.detail) ? `Cancelled ${title}` : `Changed ${title}`;
    case "save_purchase":
      if (change.action === "created") return `Added ${title}`;
      return /^Tracking added/.test(change.detail) ? `Added tracking to ${title}` : `Updated ${title}`;
    case "change_todo":
      return change.action === "completed" ? `Ticked off ${title}` : `Updated ${title}`;
    case "change_reminder":
      return `Changed a reminder: ${clip(change.detail.replace(/^Reminder · /, ""), 30)}`;
    case "answer_invite":
      return `${title}: ${clip(change.detail, 40).replace(/^\w/, (c) => c.toLowerCase())}`;
    case "link_records":
      return `${change.detail.split(" · ")[0]} ${title}`;
    case "archive_or_restore": {
      const n = changedCount(result);
      const word = str(input, "kind") === "reminder" ? ((input as { archive?: unknown }).archive === false ? "Turned back on" : "Cancelled") : (input as { archive?: unknown }).archive === false ? "Restored" : "Archived";
      return n > 1 ? `${word} ${n} ${kindWord(input, true)}` : `${word} ${title}`;
    }
    default:
      return clip(change.label, 64);
  }
}

/** "Checking your goals" while it runs, "Checked your goals" after: the working lines both back ends show (lib/ask-tools.ts has the tools). */
export const READ_STEPS: Record<string, [start: string, done: string]> = {
  goals: ["Checking your goals", "Checked your goals"],
  trips: ["Checking your trips", "Checked your trips"],
  purchases: ["Checking your orders", "Checked your orders"],
  habits: ["Checking your habits", "Checked your habits"],
  days: ["Looking through your days", "Looked through your days"],
  health: ["Checking your health figures", "Checked your health figures"],
  places: ["Checking where you went", "Checked where you went"],
  patterns: ["Looking for patterns in your days", "Looked for patterns in your days"],
  taste: ["Looking at your films, shows and music", "Looked at your films, shows and music"],
  money: ["Checking your payments", "Checked your payments"],
  regular_payments: ["Checking your regular payments", "Checked your regular payments"],
  energy: ["Checking your energy use", "Checked your energy use"],
  appliances: ["Checking your appliances", "Checked your appliances"],
  weather: ["Checking the forecast", "Checked the forecast"],
  work: ["Checking your work", "Checked your work"],
  tracker_history: ["Checking what you track", "Checked what you track"],
};

// ---------- Written answers (lib/answer.ts) ----------

/** Plural nouns for a connected account's items, by its kind. */
const ITEM: Record<string, [string, string]> = {
  meeting: ["call", "calls"],
  email: ["email", "emails"],
  event: ["event", "events"],
  message: ["message", "messages"],
  page: ["page", "pages"],
};

/** Opening one thing (a thread, a transcript) rather than searching many. */
export const readsOne = (tool: string): boolean => /(^|_)(get|read|fetch|open|view)(_|$)/i.test(tool) && !/(^|_)(search|list|find|query)(_|$)/i.test(tool);

/** One lookup in a round: Athena's own tool (with its input), or a connected account's. */
export interface AnswerLookup {
  athena: string | null;
  input?: unknown;
  account?: { name: string; kind: string };
  tool?: string;
}

/** One line for a round's lookups of a kind: "Searching Gmail (work)", "Reading 2 emails". */
export interface StepGroup {
  key: string;
  start: string;
  /** How it ended, from what the lookups returned (text, in member order). */
  done: (results: string[]) => string;
  /** When every lookup in it couldn't reach its account. */
  failed: string;
  /** Indexes into the lookups it covers. */
  members: number[];
}

/** "an email", "2 emails". */
const some = (n: number, [one, many]: [string, string]) => (n === 1 ? `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}` : `${n} ${many}`);

/** "pricing OR price OR quote" → "pricing, price or quote". */
function terms(query: string): string {
  const words = query
    .replace(/["()]/g, " ")
    .split(/\s+OR\s+|\s+/)
    .filter((w) => w && w !== "OR" && !w.startsWith("-"))
    .slice(0, 3)
    .map((w) => clip(w, 18));
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : (words[0] ?? "");
}

const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? ""));

export function answerStepGroups(lookups: AnswerLookup[]): StepGroup[] {
  const groups = new Map<string, { make: (inputs: unknown[]) => Omit<StepGroup, "key" | "members">; inputs: unknown[]; members: number[] }>();
  const add = (key: string, i: number, input: unknown, make: (inputs: unknown[]) => Omit<StepGroup, "key" | "members">) => {
    const g = groups.get(key);
    if (g) {
      g.inputs.push(input);
      g.members.push(i);
    } else groups.set(key, { make, inputs: [input], members: [i] });
  };
  const found = (results: string[]) => results.reduce((n, r) => n + (listOf(r)?.length ?? 0), 0);
  lookups.forEach((l, i) => {
    if (l.athena === "search_athena")
      add("athena:search", i, l.input, (inputs) => {
        const about = inputs.length === 1 ? terms(str(inputs[0], "query")) : "";
        return {
          start: about ? `Searching notes for ${about}` : "Searching your notes again",
          done: (results) => {
            const n = found(results);
            return n ? `Found ${count(n, "match", "matches")}${about ? ` for ${about}` : ""}` : `Nothing for ${about || "those words"}`;
          },
          failed: "Couldn't search your notes",
        };
      });
    else if (l.athena === "person_details")
      add("athena:person", i, l.input, (inputs) => ({ start: "Reading what you've saved about them", done: () => "Read what you've saved about them", failed: "" }));
    else if (l.athena === "records_of")
      add("athena:records", i, l.input, (inputs) => {
        const name = and(inputs.map((x) => clip(str(x, "name"), 24)).filter(Boolean));
        return { start: `Checking your ${name || "records"}`, done: () => `Checked your ${name || "records"}`, failed: "" };
      });
    else if (l.athena === "read_note")
      add("athena:read", i, l.input, (inputs) => ({
        start: `Reading ${some(inputs.length, ["note", "notes"])}`,
        done: (results) => {
          const title = results.length === 1 ? (parsed(results[0]) as { title?: unknown } | null)?.title : null;
          return title ? `Read ${clip(title)}` : `Read ${some(inputs.length, ["note", "notes"])}`;
        },
        failed: "",
      }));
    else if (l.athena && READ_STEPS[l.athena]) {
      const [start, done] = READ_STEPS[l.athena];
      add(`athena:${l.athena}`, i, l.input, () => ({ start, done: () => done, failed: "" }));
    }
    else if (l.athena) add(`athena:${l.athena}`, i, l.input, () => ({ start: "Looking it up", done: () => "Looked it up", failed: "" }));
    else if (l.account) {
      const noun = ITEM[l.account.kind] ?? ["item", "items"];
      const name = l.account.name;
      if (l.tool && readsOne(l.tool))
        add(`read:${l.account.kind}`, i, null, (inputs) => ({ start: `Reading ${some(inputs.length, noun)}`, done: () => `Read ${some(inputs.length, noun)}`, failed: `Couldn't open the ${noun[1]}` }));
      else add(`search:${name}`, i, null, () => ({ start: `Searching ${name}`, done: () => `Searched ${name}`, failed: `Couldn't reach ${name}` }));
    }
  });
  return [...groups.entries()].map(([key, g]) => ({ key, members: g.members, ...g.make(g.inputs) }));
}
