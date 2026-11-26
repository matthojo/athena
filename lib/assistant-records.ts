/**
 * Ask's assistant and the rest of Athena: "Priya's new number is 07700
 * 900123", "set everyone with an @brightwater.co email to work at Brightwater",
 * "move the dentist to Thursday at 3", "rename the Lisbon trip", "the
 * Kindle arrived", "link this note to Priya", "archive the old Q3 goal".
 * Kept beside lib/assistant.ts, which lists these tools with its own, runs
 * them through runRecordTool() and undoes their changes through
 * applyRecordUndo().
 *
 * Every change goes through the same lib functions the app and MCP use
 * (upsertPerson, upsertPlace, upsertEvent, upsertGoal, saveReminder, …), so
 * their checks apply. In the tools that change things every property is
 * required, "" and [] stand for "leave it as it is", and a `clear` list says
 * what to empty; each call is checked against `inputs` before it runs. Every change comes back as a receipt with
 * Open and Undo; a change to many records at once is one receipt with one
 * Undo. Undo archives what was made, puts back what was there, or restores
 * what was archived. Nothing is ever deleted: archiving is as far as Ask goes.
 */
import { listContexts } from "./todo-contexts";
import { askLinks, modelLinks, MAX_LINKS, MAX_STEPS, newItemId, PRIORITY_NAMES, priorityOfName, STEPS_RULE_SHORT, todoExtras, type TodoLink, type TodoPriority, type TodoStep } from "./todo-details";
import { contextByName, contextsOf } from "./todo-context";
import { z } from "zod";
import type { Anthropic } from "./ai";
import type { Change, ChangeKind } from "./assistant";
import {
  archiveEntity,
  getConnections,
  getEvent,
  getNote,
  getPerson,
  getRecord,
  ENTITY_TYPES,
  getReminder,
  linkEntities,
  listEvents,
  listOrganisations,
  listPlaces,
  listProjects,
  listReminders,
  parseBirthday,
  saveReminder,
  unarchiveEntity,
  unlinkEntities,
  upsertEvent,
  upsertOrganisation,
  upsertPerson,
  upsertPlace,
  upsertProject,
  type ArchivableKind,
  type AthenaEvent,
  type EntityType,
  type Organisation,
  type Person,
  type PersonInput,
  type Place,
  type Project,
} from "./db";
import {
  ASSET_KINDS,
  GOAL_PERIODS,
  GOAL_STATUSES,
  findPeople,
  getAsset,
  getCommitment,
  getFact,
  getGoal,
  getInteraction,
  getReadingItem,
  listAssets,
  listGoals,
  listReading,
  upsertAsset,
  upsertCommitment,
  upsertGoal,
  type Asset,
  type Goal,
} from "./memory";
import { getBooking, getPurchase, getTrip, listPurchases, listTrips, savePurchase, setPurchaseStatus, updateTrip, type Trip } from "./trips";
import { PURCHASE_LABEL, PURCHASE_STATUSES, purchaseName, tripLabel, type PurchaseStatus } from "./trip-text";
import { getCustomRecord, getKind } from "./custom-kinds";
import { searchableValues } from "./custom-fields";
import type { FieldKind } from "./custom-field-rules";
import { KIND_WORD } from "./custom-kind-words";
import { REMINDER_REPEATS, REPEAT_LABELS, type ReminderRepeat } from "./reminders";
import { isValidDate, zonedParts, zonedToday } from "./dates";
import { isEncryptedPlaceholder } from "./encrypted";

const UUID = z.string().uuid();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most records one change touches: a bulk change is one receipt, so its Undo stays a sensible size. */
const MAX_AT_ONCE = 500;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unreadable = (...values: Array<string | null | undefined>) => values.some((v) => typeof v === "string" && isEncryptedPlaceholder(v));
const sameText = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Every object closed, every property listed as required ("" or [] for "not
 * given"), so Claude fills in each part. No assistant tool is strict: with
 * these and the custom kinds' tools strict, the grammar was too large for the
 * API (a 400, "The compiled grammar is too large", which took Ask down).
 * `inputs` below checks what comes back instead, and a call that doesn't fit
 * is answered as an error Claude can fix.
 */
const object = (properties: Record<string, unknown>) => ({
  type: "object" as const,
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Today", "Tomorrow" or "Sun 8 Nov" for a YYYY-MM-DD, as receipts show it. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const t = new Date(`${today}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  if (date === t.toISOString().slice(0, 10)) return "Tomorrow";
  return DAY.format(new Date(`${date}T12:00:00Z`));
}

const BIRTHDAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "14 Mar 1990", or "14 Mar" when the year isn't known ("--03-14"), as receipts show a birthday. */
export function birthdayLabel(birthday: string): string {
  const known = !birthday.startsWith("--");
  const day = BIRTHDAY.format(new Date(`${known ? birthday : `2000${birthday.slice(1)}`}T12:00:00Z`));
  return known ? `${day} ${birthday.slice(0, 4)}` : day;
}

/** What runRecordTool needs from lib/assistant.ts's session. */
export interface RecordContext {
  /** File a change; returns the tool result. */
  record: (change: Omit<Change, "label">) => string;
  now: Date;
  tz: string;
  /** From an iPhone Shortcut: there's no Undo to hand there, so people change one at a time. */
  capture: boolean;
}

// ---------- tools ----------

const PERSON_CLEARS = ["relationship", "email", "phone", "birthday", "organisation", "catch_up_days", "notes"] as const;
const ITEM_KINDS = ["place", "organisation", "event", "goal", "asset", "project", "trip", "purchase"] as const;
const ITEM_CLEARS = ["notes", "address", "website", "date", "time", "person", "target", "provider", "remind_days_before"] as const;
const EVENT_TYPES = ["birthday", "anniversary", "appointment", "deadline", "other"] as const;
const PROJECT_STATUSES = ["active", "paused", "done"] as const;
/** Things a link can join (the graph's kinds). */
const LINK_KINDS = ["note", "person", "place", "organisation", "event", "project", "record"] as const;
/** What a reminder can be about: a push opens it, and a record has no page a push could open yet. */
const ABOUT_KINDS = ["person", "note", "place", "organisation", "event", "project"] as const;
/** Everything archive_or_restore takes, as the owner would say it. */
const ARCHIVE_KINDS = [
  "note",
  "person",
  "place",
  "organisation",
  "event",
  "project",
  "todo",
  "reminder",
  "catch_up",
  "detail",
  "reading",
  "goal",
  "asset",
  "trip",
  "booking",
  "purchase",
  "record",
  "type",
] as const;
type ArchiveKind = (typeof ARCHIVE_KINDS)[number];
/** Where find_items looks. "asset" is life admin, "reading" is watch & read. */
const FIND_KINDS = ["place", "organisation", "event", "project", "reading", "goal", "asset", "trip", "purchase", "reminder"] as const;
type FindKind = (typeof FIND_KINDS)[number];

const str = (description: string) => ({ type: "string", description });

export const RECORD_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_items",
    description:
      "Find places, organisations, events, projects, watch & read items, goals, life admin items (asset), trips, purchases or reminders by words in their name or details " +
      "(an address, a provider, a retailer, a booking's city, a reminder's text, the owner's own fields). query \"\" lists them. Returns ids and the details you'd change. " +
      "(People: find_people. Notes: find_notes. To-dos: find_todos.)",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: [...FIND_KINDS] }, query: { type: "string" } },
      required: ["kind", "query"],
    },
  },
  {
    name: "update_people",
    description:
      'Change people already in Athena: one person, or many at once ("everyone with an @brightwater.co email works at Brightwater", "keep in touch with all my cousins"). ' +
      "Give ids from find_people, or match: the words you gave find_people, which changes everyone it finds. Look with find_people first, so you know who it will change. " +
      'For each field, "" leaves it as it is, a value replaces it, and listing it in clear empties it. name, email, phone and birthday are for one person at a time. ' +
      "Their own fields (like Shoe size) are set_field; a lasting detail no field covers is remember; someone new is add_person.",
    input_schema: object({
      ids: { type: "array", items: { type: "string" }, description: "The people to change, from find_people. [] when you give match." },
      match: str('Instead of ids: change everyone find_people finds for these words, like "@brightwater.co". "" when you give ids.'),
      name: str('Their name. "" to leave it.'),
      relationship: str('Who they are to the owner: colleague, sister, friend. "" to leave it.'),
      email: str('"" to leave it.'),
      phone: str('"" to leave it.'),
      birthday: str('YYYY-MM-DD, or --MM-DD when the year isn\'t known. "" to leave it.'),
      organisation: str('Where they work: the organisation\'s name (found, or added if it\'s new) or its id. "" to leave it.'),
      keep_in_touch: { type: "string", enum: ["", "on", "off"], description: "on: nudge the owner to catch up with them. Only when the owner asks. \"\" to leave it." },
      catch_up_days: { type: "integer", description: "How often to catch up, in days. 0 to leave it." },
      notes: str('Notes about them, Markdown. Replaces what\'s there, so keep what should stay. "" to leave them.'),
      clear: { type: "array", items: { type: "string", enum: [...PERSON_CLEARS] }, description: "Fields to empty. [] for none." },
    }),
  },
  {
    name: "save_item",
    description:
      "Add or change a place, organisation, event, goal, life admin item (asset), or project (id \"\" adds one), or change a trip (its name and notes) or a purchase (its status: \"it arrived\" is delivered). " +
      'Each field below says which kinds use it; leave the rest "", [], -1 or 0. For each field, "" leaves it as it is, a value replaces it, and listing it in clear empties it. ' +
      "Find the id first with find_items. Never put passport, policy, licence or account numbers anywhere.",
    input_schema: object({
      kind: { type: "string", enum: [...ITEM_KINDS] },
      id: str('"" to add a new one (not trips or purchases).'),
      name: str('The name, or an event\'s or goal\'s title. Needed for a new one. "" to leave it.'),
      notes: str('Notes, Markdown; a project\'s description. Replaces what\'s there. "" to leave them.'),
      address: str('place. "" to leave it.'),
      website: str('place or organisation. "" to leave it.'),
      date: str('event: YYYY-MM-DD, or --MM-DD for a yearly date without a known year. goal: its due date. asset: when it renews or expires. "" to leave it.'),
      time: str('event: HH:MM, 24-hour, in the owner\'s time zone. "" to leave it; clear time makes it all-day.'),
      yearly: { type: "string", enum: ["", "yes", "no"], description: "event: whether it comes round every year. \"\" to leave it." },
      event_type: { type: "string", enum: ["", ...EVENT_TYPES], description: "event. \"\" to leave it (other, for a new one)." },
      person_id: str('event: whose it is (find_people). "" to leave it.'),
      remind_days_before: { type: "array", items: { type: "integer" }, description: "event or asset: days before to remind the owner, like [30, 7, 0]. [] to leave it." },
      status: str(
        `goal: ${GOAL_STATUSES.join(", ")}. project: ${PROJECT_STATUSES.join(", ")}. purchase: ${PURCHASE_STATUSES.join(", ")}. "" to leave it.`,
      ),
      progress: { type: "integer", description: "goal: 0 to 100 (percent). -1 to leave it." },
      period: { type: "string", enum: ["", ...GOAL_PERIODS], description: "goal. \"\" to leave it." },
      target: str('goal: what done looks like. "" to leave it.'),
      provider: str('asset: who it\'s with, like "Direct Line". "" to leave it.'),
      asset_type: { type: "string", enum: ["", ...ASSET_KINDS], description: "asset. \"\" to leave it (other, for a new one)." },
      clear: { type: "array", items: { type: "string", enum: [...ITEM_CLEARS] }, description: "Fields to empty. [] for none." },
    }),
  },
  {
    name: "change_todo",
    description:
      "Change a to-do (id from find_todos; done ones too, with include_done): its words, its type, who it's with, its due date, its description (notes), area (Work, Health…), where/how (Phone, Errands…) or priority; tick it off (status done), reopen it (open) or drop it (dropped). " +
      "Its steps: add_steps adds to the end; done_steps, open_steps and remove_steps take step ids from find_todos. Ticking one step is done_steps, not the whole to-do. add_links adds pages or athena:// links. " +
      `New steps: ${STEPS_RULE_SHORT} ` +
      'For each field, "" or [] leaves it as it is, and listing it in clear empties it.',
    input_schema: object({
      id: str("From find_todos."),
      title: str('Short, starting with a verb. "" to leave it.'),
      type: { type: "string", enum: ["", "todo", "i_owe", "waiting_on"], description: "todo: the owner will do it. i_owe: for someone. waiting_on: someone will do it for the owner. \"\" to leave it." },
      status: { type: "string", enum: ["", "open", "done", "dropped"], description: "\"\" to leave it." },
      due_on: str('YYYY-MM-DD in the owner\'s time zone. "" to leave it.'),
      person_id: str('Who it\'s for or with (find_people). "" to leave it.'),
      notes: str('Replaces what\'s there. "" to leave them.'),
      area: str('One of the owner\'s areas, by name (Work, Health…). "" to leave it.'),
      where: str('One of the owner\'s where/how contexts, by name (Phone, Errands…). "" to leave it.'),
      priority: { type: "string", enum: ["", ...PRIORITY_NAMES], description: "\"\" to leave it." },
      add_steps: { type: "array", items: { type: "string" }, description: "New steps, in order, added after the others. [] for none." },
      done_steps: { type: "array", items: { type: "string" }, description: "Step ids to tick. [] for none." },
      open_steps: { type: "array", items: { type: "string" }, description: "Step ids to untick. [] for none." },
      remove_steps: { type: "array", items: { type: "string" }, description: "Step ids to remove. [] for none." },
      add_links: { type: "array", items: { type: "string" }, description: "https addresses or athena://<kind>/<id> links to add. [] for none." },
      clear: { type: "array", items: { type: "string", enum: ["due_on", "person", "notes", "area", "where", "steps", "links"] }, description: "Fields to empty. [] for none." },
    }),
  },
  {
    name: "change_reminder",
    description:
      "Change a reminder (id from find_items with kind reminder): its words, its day or time (in the owner's time zone), how often it repeats, or what it's about. " +
      'Moving a finished one to a new time turns it back on. For each field, "" leaves it as it is. To cancel one, archive_or_restore it.',
    input_schema: object({
      id: str("From find_items."),
      text: str('"" to leave it.'),
      date: str('YYYY-MM-DD. "" to leave it.'),
      time: str('HH:MM, 24-hour. "" to leave it.'),
      repeat: { type: "string", enum: ["", ...REMINDER_REPEATS], description: "\"\" to leave it." },
      about_kind: { type: "string", enum: ["", ...ABOUT_KINDS], description: "What tapping it opens. \"\" to leave it." },
      about_id: str('With about_kind. "" to leave it.'),
      clear: { type: "array", items: { type: "string", enum: ["about"] }, description: "[\"about\"] to unlink it from what it's about. [] for none." },
    }),
  },
  {
    name: "link_records",
    description:
      'Link two things in Athena, or unlink them (link false): "link this note to Priya", "Dishoom is near the office". relation is a short label (relates_to when ""). ' +
      "For where someone works, use update_people's organisation instead. Links written into a note's text come from the note: change the note to remove those.",
    input_schema: object({
      link: { type: "boolean", description: "true to link, false to unlink." },
      from_kind: { type: "string", enum: [...LINK_KINDS] },
      from_id: { type: "string" },
      to_kind: { type: "string", enum: [...LINK_KINDS] },
      to_id: { type: "string" },
      relation: str('Like "works_at", "lives_near", "met_at". "" for relates_to; when unlinking, "" removes every link between them.'),
    }),
  },
  {
    name: "archive_or_restore",
    description:
      `Archive one or more things of one kind (archive true), or restore archived ones (false), only when the owner asks to archive, remove, hide or cancel them. ` +
      `Archived things leave every list and search; the owner can restore them, or delete them for good, from the Archived page. A reminder is cancelled instead, and restoring turns it back on. ` +
      `type is one of the owner's own ${KIND_WORD.many} (list_kinds), which takes its records with it; record is a record in one; catch_up is a logged catch-up; detail is something remember saved. ` +
      `You can't delete anything.`,
    input_schema: object({
      kind: { type: "string", enum: [...ARCHIVE_KINDS] },
      ids: { type: "array", items: { type: "string" }, description: "One or more ids of that kind." },
      archive: { type: "boolean", description: "true to archive, false to restore." },
    }),
  },
];

export const RECORD_TOOL_NAMES: ReadonlySet<string> = new Set(RECORD_TOOLS.map((t) => t.name));

/** The system prompt's lines about changing what's already there (lib/assistant.ts puts them in "How to work"). */
export const RECORD_GUIDANCE = `- You can add, find, change, archive and restore almost anything. People: update_people for any of their details. Places, organisations, events, goals, life admin (asset) and projects: find_items, then save_item. Trips and purchases: find_items, then save_item (rename a trip, change its notes; "the Kindle arrived" is a purchase's status). To-dos: change_todo (its steps too: find_todos gives their ids). Reminders: find_items with kind reminder, then change_reminder. Links between two things: link_records.
- Many at once ("set everyone with an @brightwater.co email to work at Brightwater"): find_people with a limit to see who matches, then one update_people call with match (the same words) or their ids. Say how many changed. Don't ask first unless it's unclear who they mean.
- Archiving: archive_or_restore, only when the owner asks to archive, remove, hide or cancel something; it also restores. You can never delete anything. When they ask you to delete something, archive it and say they can delete it for good from the Archived page.`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const dateOrEmpty = z.string().refine((s) => s === "" || (DATE_RE.test(s) && isValidDate(s)), "Use YYYY-MM-DD");
const timeOrEmpty = z.string().refine((s) => s === "" || TIME_RE.test(s.trim()), "Use HH:MM, 24-hour");
const idOrEmpty = z.union([UUID, z.literal("")]);

const inputs = {
  find_items: z.object({ kind: z.enum(FIND_KINDS), query: z.string().max(200).default("") }),
  update_people: z.object({
    ids: z.array(UUID).max(MAX_AT_ONCE).default([]),
    match: z.string().max(200).default(""),
    name: z.string().max(200).default(""),
    relationship: z.string().max(80).default(""),
    email: z.string().max(300).default(""),
    phone: z.string().max(60).default(""),
    birthday: z.string().max(20).default(""),
    organisation: z.string().max(200).default(""),
    keep_in_touch: z.enum(["", "on", "off"]).default(""),
    catch_up_days: z.number().int().min(0).max(3650).default(0),
    notes: z.string().max(20_000).default(""),
    clear: z.array(z.enum(PERSON_CLEARS)).max(PERSON_CLEARS.length).default([]),
  }),
  save_item: z.object({
    kind: z.enum(ITEM_KINDS),
    id: idOrEmpty.default(""),
    name: z.string().max(300).default(""),
    notes: z.string().max(20_000).default(""),
    address: z.string().max(500).default(""),
    website: z.string().max(2000).default(""),
    date: z.string().max(20).default(""),
    time: timeOrEmpty.default(""),
    yearly: z.enum(["", "yes", "no"]).default(""),
    event_type: z.enum(["", ...EVENT_TYPES]).default(""),
    person_id: idOrEmpty.default(""),
    remind_days_before: z.array(z.number().int().min(0).max(365)).max(10).default([]),
    status: z.string().max(40).default(""),
    progress: z.number().int().min(-1).max(100).default(-1),
    period: z.enum(["", ...GOAL_PERIODS]).default(""),
    target: z.string().max(500).default(""),
    provider: z.string().max(200).default(""),
    asset_type: z.enum(["", ...ASSET_KINDS]).default(""),
    clear: z.array(z.enum(ITEM_CLEARS)).max(ITEM_CLEARS.length).default([]),
  }),
  change_todo: z.object({
    id: UUID,
    title: z.string().max(200).default(""),
    type: z.enum(["", "todo", "i_owe", "waiting_on"]).default(""),
    status: z.enum(["", "open", "done", "dropped"]).default(""),
    due_on: dateOrEmpty.default(""),
    person_id: idOrEmpty.default(""),
    notes: z.string().max(5000).default(""),
    area: z.string().max(40).default(""),
    where: z.string().max(40).default(""),
    priority: z.enum(["", ...PRIORITY_NAMES]).default(""),
    add_steps: z.array(z.string().max(300)).max(MAX_STEPS).default([]),
    done_steps: z.array(z.string().max(60)).max(MAX_STEPS).default([]),
    open_steps: z.array(z.string().max(60)).max(MAX_STEPS).default([]),
    remove_steps: z.array(z.string().max(60)).max(MAX_STEPS).default([]),
    add_links: z.array(z.string().max(2000)).max(MAX_LINKS).default([]),
    clear: z.array(z.enum(["due_on", "person", "notes", "area", "where", "steps", "links"])).max(7).default([]),
  }),
  change_reminder: z.object({
    id: UUID,
    text: z.string().max(300).default(""),
    date: dateOrEmpty.default(""),
    time: timeOrEmpty.default(""),
    repeat: z.enum(["", ...REMINDER_REPEATS]).default(""),
    about_kind: z.enum(["", ...ABOUT_KINDS]).default(""),
    about_id: idOrEmpty.default(""),
    clear: z.array(z.enum(["about"])).max(1).default([]),
  }),
  link_records: z.object({
    link: z.boolean(),
    from_kind: z.enum(LINK_KINDS),
    from_id: UUID,
    to_kind: z.enum(LINK_KINDS),
    to_id: UUID,
    relation: z.string().max(40).default(""),
  }),
  archive_or_restore: z.object({ kind: z.enum(ARCHIVE_KINDS), ids: z.array(UUID).min(1).max(MAX_AT_ONCE), archive: z.boolean() }),
};

// ---------- finding ----------

/** Every word is in one of the texts, any case. */
function fits(words: string[], texts: Array<string | null | undefined>): boolean {
  const all = texts
    .filter((t): t is string => !!t && !isEncryptedPlaceholder(t))
    .join(" ")
    .toLowerCase();
  return words.every((w) => all.includes(w));
}

/** Exact names first, then names that start with it, then names that have every word, then the rest. */
function byTitle(words: string[], query: string) {
  const term = query.trim().toLowerCase();
  const tier = (title: string) => {
    const t = title.toLowerCase();
    return t === term ? 0 : t.startsWith(term) ? 1 : words.every((w) => t.includes(w)) ? 2 : 3;
  };
  return (a: { title: string }, b: { title: string }) => tier(a.title) - tier(b.title);
}

const omitEmpty = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));

/** A yearly date without its year reads "--03-14", as save_item takes it. */
const eventDate = (e: AthenaEvent) => (e.year_known ? e.date : `--${e.date.slice(5)}`);

async function findItems(kind: FindKind, query: string, ctx: RecordContext): Promise<Array<Record<string, unknown>>> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const today = zonedToday(ctx.now, ctx.tz);
  // The owner's own fields count too, for the kinds that have them.
  const extra = kind === "trip" || kind === "purchase" || kind === "reminder" ? new Map<string, string>() : await searchableValues([kind as FieldKind]);
  type Hit = { title: string; texts: Array<string | null | undefined>; out: Record<string, unknown> };
  let hits: Hit[];
  switch (kind) {
    case "place":
      hits = (await listPlaces(2000)).map((p) => ({ title: p.name, texts: [p.name, p.address, p.notes, p.url], out: omitEmpty({ id: p.id, title: p.name, address: p.address, website: p.url }) }));
      break;
    case "organisation":
      hits = (await listOrganisations(2000)).map((o) => ({ title: o.name, texts: [o.name, o.website, o.notes], out: omitEmpty({ id: o.id, title: o.name, website: o.website }) }));
      break;
    case "event":
      hits = (await listEvents({ limit: 3000 })).map((e) => {
        const when = e.starts_at ? zonedParts(new Date(e.starts_at), ctx.tz) : { date: e.date, time: e.time };
        return {
          title: e.title,
          texts: [e.title, e.notes],
          out: omitEmpty({ id: e.id, title: e.title, type: e.kind, date: e.recurrence === "yearly" ? eventDate(e) : when.date, time: when.time, yearly: e.recurrence === "yearly" ? "yes" : "", person_id: e.person_id, answer: e.rsvp === "none" ? "" : e.rsvp }),
        };
      });
      break;
    case "project":
      hits = (await listProjects(1000)).map((p) => ({ title: p.name, texts: [p.name, p.description], out: { id: p.id, title: p.name, status: p.status } }));
      break;
    case "reading":
      // Watch & read has its own finder with more (find_watch_read); this one is for its fields.
      hits = (await listReading({ limit: 2000 })).map((r) => ({ title: r.title, texts: [r.title, r.author], out: { id: r.id, title: r.title } }));
      break;
    case "goal":
      hits = (await listGoals(1000)).map((g) => ({
        title: g.title,
        texts: [g.title, g.target, g.notes],
        out: omitEmpty({ id: g.id, title: g.title, status: g.status, progress: g.progress, period: g.period, due_on: g.due_on }),
      }));
      break;
    case "asset":
      hits = (await listAssets(1000)).map((a) => ({
        title: a.name,
        texts: [a.name, a.provider, a.notes],
        out: omitEmpty({ id: a.id, title: a.name, type: a.kind, provider: a.provider, renews_on: a.renews_on }),
      }));
      break;
    case "trip":
      hits = (await listTrips({ limit: 200, today })).map((t) => ({
        title: t.title,
        texts: [t.title, t.notes, ...t.bookings.flatMap((b) => [b.title, b.provider, b.start_city, b.end_city])],
        out: { id: t.id, title: tripLabel(t, today), bookings: t.bookings.map((b) => ({ id: b.id, title: b.title, day: b.start_date })) },
      }));
      break;
    case "purchase":
      hits = (await listPurchases({ limit: 300 })).map((p) => ({
        title: purchaseName(p),
        texts: [p.retailer, ...p.items, p.order_number],
        out: omitEmpty({ id: p.id, title: purchaseName(p), status: p.status, ordered_on: p.ordered_on }),
      }));
      break;
    case "reminder":
      hits = (await listReminders({ includeDone: true, limit: 300 })).map((r) => {
        const when = zonedParts(new Date(r.remind_at), ctx.tz);
        return {
          title: r.text,
          texts: [r.text, r.about_title],
          out: omitEmpty({ id: r.id, title: r.text, date: when.date, time: when.time, repeat: r.repeat === "none" ? "" : r.repeat, about: r.about_title, finished: r.done_at ? true : "" }),
        };
      });
      break;
  }
  const found = hits.filter((h) => !isEncryptedPlaceholder(h.title) && (!words.length || fits(words, [...h.texts, extra.get(String(h.out.id))])));
  if (words.length) found.sort(byTitle(words, query));
  return found.slice(0, words.length ? 15 : 25).map((h) => ({ ...h.out, title: h.out.title || "Untitled" }));
}

// ---------- organisations by name ----------

/**
 * The organisation someone works at, from its id or its name: an existing one
 * by name (any case), or a new one, filed as its own change so Undo can
 * archive it.
 */
export async function organisationFor(ref: string, record: RecordContext["record"]): Promise<{ id: string; name: string }> {
  const t = ref.trim();
  if (UUID_RE.test(t)) {
    const org = (await getRecord("organisation", t)) as Organisation | null;
    if (!org) throw new Error("No organisation with that id. Give its name instead.");
    return { id: org.id, name: org.name };
  }
  const existing = (await listOrganisations(5000)).find((o) => !isEncryptedPlaceholder(o.name) && sameText(o.name, t));
  if (existing) return { id: existing.id, name: existing.name };
  const org = await upsertOrganisation({ name: t });
  record({
    kind: "organisation",
    id: org.id,
    action: "created",
    title: org.name,
    detail: "New organisation",
    open: { kind: "organisation", id: org.id },
    undo: { op: "archive", kind: "organisation", id: org.id },
  });
  return { id: org.id, name: org.name };
}

// ---------- people ----------

/** One person's fields as they were, for Undo: only the ones a change touched. */
const PersonBefore = z.object({
  id: UUID,
  name: z.string().max(1000).optional(),
  relationship: z.string().max(1000).optional(),
  email: z.string().max(1000).optional(),
  phone: z.string().max(1000).optional(),
  notes: z.string().max(100_000).optional(),
  birthday: z.string().max(20).nullable().optional(),
  organisation_id: UUID.nullable().optional(),
  keep_in_touch: z.boolean().optional(),
  catch_up_days: z.number().int().positive().nullable().optional(),
});
type PersonBefore = z.infer<typeof PersonBefore>;
type PersonPatch = Omit<PersonInput, "id" | "last_contacted_at">;

/** The birthday as Person carries it ("YYYY-MM-DD" or "--MM-DD"), from what the owner gave. */
function birthdayKey(raw: string): string {
  const { date, yearKnown } = parseBirthday(raw);
  return yearKnown ? date : `--${date.slice(5)}`;
}

/** What a person has now, in the shape a patch would set it. */
function personNow(p: Person, key: keyof PersonPatch): unknown {
  if (key === "organisation_id") return p.organisation?.id ?? null;
  return p[key as keyof Person] ?? null;
}

const same = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b);

/** "Works at Brightwater · Keep in touch on": what a change to people does, as receipts show it. */
function personPatchLine(patch: PersonPatch, orgName: string | null): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push(`Name: ${patch.name}`);
  if (patch.relationship !== undefined) parts.push(patch.relationship ? capitalise(patch.relationship) : "Relationship cleared");
  if (patch.organisation_id !== undefined) parts.push(patch.organisation_id ? `Works at ${orgName}` : "Organisation cleared");
  if (patch.email !== undefined) parts.push(patch.email ? `Email: ${patch.email}` : "Email cleared");
  if (patch.phone !== undefined) parts.push(patch.phone ? `Phone: ${patch.phone}` : "Phone cleared");
  if (patch.birthday !== undefined) parts.push(patch.birthday ? `Birthday: ${birthdayLabel(patch.birthday)}` : "Birthday cleared");
  if (patch.keep_in_touch !== undefined) parts.push(patch.keep_in_touch ? "Keep in touch on" : "Keep in touch off");
  if (patch.catch_up_days !== undefined) parts.push(patch.catch_up_days ? `Catch up every ${patch.catch_up_days} days` : "Catch-up timing cleared");
  if (patch.notes !== undefined) parts.push(patch.notes ? "Notes updated" : "Notes cleared");
  return parts.join(" · ");
}

async function updatePeople(raw: unknown, ctx: RecordContext): Promise<string> {
  const input = inputs.update_people.parse(raw);
  const clear = new Set(input.clear);

  let people: Person[];
  let missing = 0;
  if (input.ids.length) {
    const ids = [...new Set(input.ids)];
    const found = await Promise.all(ids.map((id) => getPerson(id)));
    people = found.filter((p): p is Person => !!p);
    missing = ids.length - people.length;
    if (!people.length) throw new Error("None of those ids is a person in Athena. Use find_people.");
  } else if (input.match.trim()) {
    people = (await findPeople(input.match)).map((f) => f.person);
    if (!people.length) throw new Error(`Nobody in Athena matches ${JSON.stringify(input.match.trim())}.`);
  } else throw new Error("Say who: ids from find_people, or match.");
  if (people.length > MAX_AT_ONCE) throw new Error(`That's ${people.length} people; I can change up to ${MAX_AT_ONCE} at once. Narrow it down.`);
  if (ctx.capture && people.length > 1) throw new Error("From a Shortcut I change one person at a time. Say the owner can change several at once in Ask, where it can be undone.");

  const one = people.length === 1;
  for (const key of ["name", "email", "phone", "birthday"] as const) {
    if (!one && input[key].trim()) throw new Error(`${capitalise(key)} is for one person at a time.`);
  }

  // The change itself, checked before anything is written.
  const patch: PersonPatch = {};
  for (const key of ["name", "relationship", "email", "phone", "notes"] as const) {
    if (key !== "name" && clear.has(key)) patch[key] = "";
    else if (input[key].trim()) patch[key] = key === "notes" ? input[key] : input[key].trim();
  }
  if (clear.has("birthday")) patch.birthday = null;
  else if (input.birthday.trim()) patch.birthday = birthdayKey(input.birthday);
  if (clear.has("catch_up_days")) patch.catch_up_days = null;
  else if (input.catch_up_days > 0) patch.catch_up_days = input.catch_up_days;
  if (input.keep_in_touch) patch.keep_in_touch = input.keep_in_touch === "on";
  if (!clear.has("organisation") && !input.organisation.trim() && !Object.keys(patch).length) throw new Error("Say what to change.");

  let orgName: string | null = null;
  if (clear.has("organisation")) patch.organisation_id = null;
  else if (input.organisation.trim()) {
    const org = await organisationFor(input.organisation, ctx.record);
    patch.organisation_id = org.id;
    orgName = org.name;
  }

  const keys = Object.keys(patch) as Array<keyof PersonPatch>;
  const before: PersonBefore[] = [];
  const changed: Person[] = [];
  let already = 0;
  let unread = 0;
  let stopped: string | null = null;
  for (const p of people) {
    const was: Record<string, unknown> = { id: p.id };
    for (const k of keys) was[k] = personNow(p, k);
    // Undo writes these back: one that can't be decrypted here mustn't be taken for the old value.
    if (unreadable(...keys.map((k) => (typeof was[k] === "string" ? (was[k] as string) : null)))) {
      unread++;
      continue;
    }
    if (keys.every((k) => same(was[k], patch[k] ?? null))) {
      already++;
      continue;
    }
    try {
      changed.push(await upsertPerson({ id: p.id, ...patch }));
    } catch (error) {
      // Part-way: what's changed so far still gets its receipt and its Undo.
      if (!changed.length) throw error;
      stopped = error instanceof Error ? error.message : String(error);
      break;
    }
    before.push(PersonBefore.parse(was));
  }

  const line = personPatchLine(patch, orgName);
  const counts = {
    changed: changed.length,
    ...(already ? { already_so: already } : {}),
    ...(unread ? { unreadable: unread } : {}),
    ...(missing ? { not_found: missing } : {}),
    ...(stopped ? { stopped_part_way: stopped } : {}),
  };
  if (!changed.length) {
    const why = unread ? "they can't be read right now" : one ? `${people[0].name} already has that` : "they all already have that";
    return JSON.stringify({ done: `No change: ${why}`, ...counts });
  }
  const undo = { op: "restore_people" as const, people: before };
  const done = one
    ? ctx.record({ kind: "person", id: changed[0].id, action: "updated", title: changed[0].name, detail: line, open: { kind: "person", id: changed[0].id }, undo })
    : ctx.record({
        kind: "people",
        id: crypto.randomUUID(),
        action: "updated",
        title: `${changed.length} people`,
        detail: line,
        open: patch.organisation_id ? { kind: "organisation", id: patch.organisation_id } : null,
        undo,
      });
  return JSON.stringify({ ...JSON.parse(done), ...counts, people: changed.slice(0, 30).map((p) => p.name) });
}

// ---------- places, organisations, events, goals, life admin, projects, trips ----------

type SaveInput = z.infer<typeof inputs.save_item>;
type ItemKind = Exclude<(typeof ITEM_KINDS)[number], "purchase">;

/**
 * How save_item treats one kind: what it reads, what it can set (as the
 * kind's lib function takes it) and how a change reads on its receipt.
 * `before` is what Undo writes back, so it's also what's compared.
 */
interface ItemSpec<T extends { id: string }> {
  one: string;
  change: ChangeKind;
  open: "place" | "organisation" | "event" | "goal" | "asset" | "project" | "trip";
  /** Whether Ask can add one (trips come from booking emails). */
  creatable: boolean;
  get(id: string): Promise<T | null>;
  /** Live ones, so a new one with the same name isn't made twice; null when names can repeat (events). */
  list: (() => Promise<T[]>) | null;
  title(t: T): string;
  before(t: T): Record<string, unknown>;
  patch(input: SaveInput, clear: Set<string>): Promise<Record<string, unknown>>;
  save(values: Record<string, unknown>, tz: string): Promise<T>;
  /** Words for a field on a receipt; `show` words a few with their new value. */
  labels: Record<string, string>;
  show?: (key: string, value: unknown, when: { today: string; tz: string }) => string | null;
}

type AnySpec = ItemSpec<{ id: string }>;
const spec = <T extends { id: string }>(s: ItemSpec<T>): AnySpec => s as unknown as AnySpec;

/** A text field from the tool's input as a lib patch: cleared, set, or left out. */
const text = (input: SaveInput, clear: Set<string>, key: "name" | "notes" | "address" | "website" | "target" | "provider", as: string = key): Record<string, unknown> =>
  clear.has(key) ? { [as]: "" } : input[key].trim() ? { [as]: key === "notes" ? input[key] : input[key].trim() } : {};

function plainDate(raw: string, what: string): string {
  const s = raw.trim();
  if (!DATE_RE.test(s) || !isValidDate(s)) throw new Error(`${capitalise(what)} needs YYYY-MM-DD.`);
  return s;
}

function statusOf<T extends string>(raw: string, allowed: readonly T[], one: string): T | undefined {
  if (!raw.trim()) return undefined;
  const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (!(allowed as readonly string[]).includes(s)) throw new Error(`A ${one}'s status is one of ${allowed.join(", ")}.`);
  return s as T;
}

/** "Reminders: 30 days before and on the day". */
function remindLine(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  if (!v.length) return "No reminders";
  const days = [...(v as number[])].sort((a, b) => b - a).map((d) => (d === 0 ? "on the day" : d === 1 ? "the day before" : `${d} days before`));
  return `Reminders: ${days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : days[0]}`;
}

const reminderDays = (input: SaveInput, clear: Set<string>): Record<string, unknown> =>
  clear.has("remind_days_before") ? { remind_days_before: [] } : input.remind_days_before.length ? { remind_days_before: input.remind_days_before } : {};

const SPECS: Record<ItemKind, AnySpec> = {
  place: spec<Place>({
    one: "place",
    change: "place",
    open: "place",
    creatable: true,
    get: async (id) => (await getRecord("place", id)) as Place | null,
    list: () => listPlaces(5000),
    title: (p) => p.name,
    before: (p) => ({ name: p.name, address: p.address, url: p.url, notes: p.notes }),
    patch: async (i, c) => ({ ...text(i, c, "name"), ...text(i, c, "address"), ...text(i, c, "website", "url"), ...text(i, c, "notes") }),
    save: (v) => upsertPlace(v),
    labels: { name: "Name", address: "Address", url: "Website", notes: "Notes" },
    show: (k, v) => (k === "address" && v ? `Address: ${v}` : null),
  }),
  organisation: spec<Organisation>({
    one: "organisation",
    change: "organisation",
    open: "organisation",
    creatable: true,
    get: async (id) => (await getRecord("organisation", id)) as Organisation | null,
    list: () => listOrganisations(5000),
    title: (o) => o.name,
    before: (o) => ({ name: o.name, website: o.website, notes: o.notes }),
    patch: async (i, c) => ({ ...text(i, c, "name"), ...text(i, c, "website"), ...text(i, c, "notes") }),
    save: (v) => upsertOrganisation(v),
    labels: { name: "Name", website: "Website", notes: "Notes" },
    show: (k, v) => (k === "website" && v ? `Website: ${v}` : null),
  }),
  event: spec<AthenaEvent>({
    one: "event",
    change: "event",
    open: "event",
    creatable: true,
    get: (id) => getEvent(id),
    list: null,
    title: (e) => e.title,
    // What upsertEvent takes to put it back exactly: a yearly one keeps its wall-clock time, a one-off its instant.
    before: (e) => ({
      title: e.title,
      kind: e.kind,
      date: eventDate(e),
      recurrence: e.recurrence,
      // The driver can hand timestamps back as Dates; Undo carries them as text.
      ...(e.recurrence === "yearly" ? { time: e.time } : { starts_at: e.starts_at ? new Date(e.starts_at).toISOString() : null }),
      remind_days_before: e.remind_days_before,
      notes: e.notes,
      person_id: e.person_id,
    }),
    patch: async (i, c) => {
      const out: Record<string, unknown> = { ...text(i, c, "name", "title"), ...text(i, c, "notes"), ...reminderDays(i, c) };
      if (c.has("date")) throw new Error("An event needs a date: give a new one instead of clearing it.");
      if (i.date.trim()) {
        if (!/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(i.date.trim())) throw new Error("An event's date is YYYY-MM-DD, or --MM-DD for a yearly date without a known year.");
        out.date = i.date.trim();
      }
      if (c.has("time")) out.time = null;
      else if (i.time.trim()) out.time = i.time.trim();
      if (i.yearly) out.recurrence = i.yearly === "yes" ? "yearly" : "none";
      if (i.event_type) out.kind = i.event_type;
      if (c.has("person")) out.person_id = null;
      else if (i.person_id) {
        if (!(await getPerson(i.person_id))) throw new Error("No person with that person_id. Use find_people.");
        out.person_id = i.person_id;
      }
      return out;
    },
    save: (v, tz) => upsertEvent({ ...v, tz }),
    labels: { title: "Name", kind: "Type", date: "Date", time: "Time", starts_at: "Time", recurrence: "Repeat", remind_days_before: "Reminders", notes: "Notes", person_id: "Person" },
    show: (k, v, { today, tz }) => {
      if (k === "date" && typeof v === "string") return `Date: ${v.startsWith("--") ? v.slice(2) : dayLabel(v, today)}`;
      if (k === "time") return v ? `Time: ${v}` : "All day";
      if (k === "starts_at") return typeof v === "string" ? `Time: ${zonedParts(new Date(v), tz).time}` : "All day";
      if (k === "recurrence") return v === "yearly" ? "Every year" : "Once";
      if (k === "kind") return capitalise(String(v));
      if (k === "remind_days_before") return remindLine(v);
      return null;
    },
  }),
  goal: spec<Goal>({
    one: "goal",
    change: "goal",
    open: "goal",
    creatable: true,
    get: (id) => getGoal(id),
    list: () => listGoals(1000),
    title: (g) => g.title,
    before: (g) => ({ title: g.title, period: g.period, target: g.target, progress: g.progress, status: g.status, due_on: g.due_on, notes: g.notes }),
    patch: async (i, c) => {
      const out: Record<string, unknown> = { ...text(i, c, "name", "title"), ...text(i, c, "target"), ...text(i, c, "notes") };
      if (c.has("date")) out.due_on = null;
      else if (i.date.trim()) out.due_on = plainDate(i.date, "a goal's due date");
      if (i.progress >= 0) out.progress = i.progress;
      if (i.period) out.period = i.period;
      const status = statusOf(i.status, GOAL_STATUSES, "goal");
      if (status) out.status = status;
      return out;
    },
    save: (v) => upsertGoal(v),
    labels: { title: "Name", period: "Period", target: "Target", progress: "Progress", status: "Status", due_on: "Due date", notes: "Notes" },
    show: (k, v, { today }) => {
      if (k === "progress") return `${v}% there`;
      if (k === "status") return capitalise(String(v));
      if (k === "due_on" && typeof v === "string") return `Due ${dayLabel(v, today)}`;
      if (k === "period") return `This ${v}`;
      if (k === "target" && v) return `Target: ${v}`;
      return null;
    },
  }),
  asset: spec<Asset>({
    one: "life admin item",
    change: "asset",
    open: "asset",
    creatable: true,
    get: (id) => getAsset(id),
    list: () => listAssets(1000),
    title: (a) => a.name,
    before: (a) => ({ name: a.name, kind: a.kind, provider: a.provider, renews_on: a.renews_on, remind_days_before: a.remind_days_before, notes: a.notes }),
    patch: async (i, c) => {
      const out: Record<string, unknown> = { ...text(i, c, "name"), ...text(i, c, "provider"), ...text(i, c, "notes"), ...reminderDays(i, c) };
      if (c.has("date")) out.renews_on = null;
      else if (i.date.trim()) out.renews_on = plainDate(i.date, "a renewal date");
      if (i.asset_type) out.kind = i.asset_type;
      return out;
    },
    save: (v) => upsertAsset(v),
    labels: { name: "Name", kind: "Type", provider: "Provider", renews_on: "Renewal date", remind_days_before: "Reminders", notes: "Notes" },
    show: (k, v, { today }) => {
      if (k === "renews_on" && typeof v === "string") return `Renews ${dayLabel(v, today)}`;
      if (k === "provider" && v) return `With ${v}`;
      if (k === "kind") return capitalise(String(v));
      if (k === "remind_days_before") return remindLine(v);
      return null;
    },
  }),
  project: spec<Project>({
    one: "project",
    change: "project",
    open: "project",
    creatable: true,
    get: async (id) => (await getRecord("project", id)) as Project | null,
    list: () => listProjects(1000),
    title: (p) => p.name,
    before: (p) => ({ name: p.name, status: p.status, description: p.description }),
    patch: async (i, c) => {
      const out: Record<string, unknown> = { ...text(i, c, "name"), ...text(i, c, "notes", "description") };
      const status = statusOf(i.status, PROJECT_STATUSES, "project");
      if (status) out.status = status;
      return out;
    },
    save: (v) => upsertProject(v),
    labels: { name: "Name", status: "Status", description: "Description" },
    show: (k, v) => (k === "status" ? capitalise(String(v)) : null),
  }),
  trip: spec<Trip>({
    one: "trip",
    change: "trip",
    open: "trip",
    creatable: false,
    get: (id) => getTrip(id),
    list: null,
    title: (t) => t.title,
    before: (t) => ({ title: t.title, notes: t.notes }),
    patch: async (i, c) => ({ ...text(i, c, "name", "title"), ...text(i, c, "notes") }),
    save: (v) => updateTrip(String(v.id), { title: v.title as string | undefined, notes: v.notes as string | undefined }),
    labels: { title: "Name", notes: "Notes" },
  }),
};

const isEmpty = (v: unknown) => v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length);

/** "Renamed · Address: 1 High St": what changed, as a receipt says it. */
function changesLine(s: AnySpec, was: Record<string, unknown>, now: Record<string, unknown>, when: { today: string; tz: string }): string {
  const parts: string[] = [];
  for (const key of Object.keys(now)) {
    if (JSON.stringify(was[key] ?? null) === JSON.stringify(now[key] ?? null)) continue;
    const shown = s.show?.(key, now[key], when);
    const label = s.labels[key] ?? capitalise(key);
    if (shown) parts.push(shown);
    else if (key === "name" || key === "title") parts.push("Renamed");
    else parts.push(isEmpty(now[key]) ? `${label} cleared` : `${label} updated`);
  }
  return [...new Set(parts)].join(" · ");
}

async function saveItem(raw: unknown, ctx: RecordContext): Promise<string> {
  const input = inputs.save_item.parse(raw);
  if (input.kind === "purchase") return savePurchaseStatus(input, ctx);
  const s = SPECS[input.kind];
  const clear = new Set<string>(input.clear);
  const when = { today: zonedToday(ctx.now, ctx.tz), tz: ctx.tz };
  const patch = await s.patch(input, clear);

  if (!input.id) {
    if (!s.creatable) throw new Error("Trips come from booking emails, so I can't add one. I can rename one or change its notes: give its id from find_items.");
    const title = String(patch.name ?? patch.title ?? "").trim();
    if (!title) throw new Error(`A new ${s.one} needs a name.`);
    if (input.kind === "event" && !patch.date) throw new Error("A new event needs a date.");
    const twin = s.list ? (await s.list()).find((t) => !isEncryptedPlaceholder(s.title(t)) && sameText(s.title(t), title)) : undefined;
    if (twin) return JSON.stringify({ done: `There's already a ${s.one} called “${s.title(twin)}”. Change that one with its id instead.`, id: twin.id });
    const made = await s.save(patch, ctx.tz);
    // The receipt names what was given, not every default.
    const given = new Set(Object.keys(patch));
    if (given.has("time")) given.add("starts_at");
    const shown = Object.fromEntries(Object.entries(s.before(made)).filter(([k, v]) => given.has(k) && k !== "name" && k !== "title" && !isEmpty(v)));
    return ctx.record({
      kind: s.change,
      id: made.id,
      action: "created",
      title: s.title(made),
      detail: [`New ${s.one}`, changesLine(s, {}, shown, when)].filter(Boolean).join(" · "),
      open: { kind: s.open, id: made.id },
      undo: { op: "archive", kind: input.kind, id: made.id },
    });
  }

  const current = await s.get(input.id);
  if (!current) throw new Error(`No ${s.one} with that id (it may be archived). Use find_items.`);
  const was = s.before(current);
  if (unreadable(...Object.values(was).filter((v): v is string => typeof v === "string"))) throw new Error(`That ${s.one} can't be read right now, so I can't change it.`);
  if (!Object.keys(patch).length) throw new Error("Say what to change.");
  const saved = await s.save({ id: input.id, ...patch }, ctx.tz);
  const now = s.before(saved);
  const line = changesLine(s, was, now, when);
  if (!line) return JSON.stringify({ done: `No change: “${s.title(current)}” already has that`, id: input.id });
  return ctx.record({
    kind: s.change,
    id: input.id,
    action: input.kind === "goal" && now.status === "done" && was.status !== "done" ? "completed" : "updated",
    title: s.title(saved),
    detail: `${capitalise(s.one)} · ${line}`,
    open: { kind: s.open, id: input.id },
    undo: { op: "restore_item", kind: input.kind, id: input.id, before: was },
  });
}

async function savePurchaseStatus(input: SaveInput, ctx: RecordContext): Promise<string> {
  if (!input.id) throw new Error("save_item doesn't add orders: use save_purchase to add one. Give a purchase's id (find_items) to say where it's got to.");
  const status = statusOf(input.status, PURCHASE_STATUSES, "purchase");
  if (!status) throw new Error("Say where it's got to: status, like delivered.");
  const current = await getPurchase(input.id);
  if (!current) throw new Error("No purchase with that id (it may be archived). Use find_items.");
  if (current.status === status) return JSON.stringify({ done: `No change: ${purchaseName(current)} is already marked ${PURCHASE_LABEL[status].toLowerCase()}`, id: input.id });
  const saved = await setPurchaseStatus(input.id, status);
  return ctx.record({
    kind: "purchase",
    id: saved.id,
    action: "updated",
    title: purchaseName(saved),
    detail: `Purchase · ${PURCHASE_LABEL[status]}`,
    open: { kind: "purchase", id: saved.id },
    undo: { op: "restore_purchase", id: saved.id, status: current.status },
  });
}

// ---------- to-dos ----------

async function changeTodo(raw: unknown, ctx: RecordContext): Promise<string> {
  const input = inputs.change_todo.parse(raw);
  const clear = new Set<string>(input.clear);
  const c = await getCommitment(input.id);
  if (!c) throw new Error("No to-do with that id (it may be archived). Use find_todos.");
  if (c.kind === "decision") throw new Error("That's a decision, not a to-do.");
  if (unreadable(c.title, c.notes)) throw new Error("That to-do can't be read right now, so I can't change it.");

  const patch: {
    title?: string;
    kind?: "todo" | "i_owe" | "waiting_on";
    status?: "open" | "done" | "dropped";
    due_on?: string | null;
    person_id?: string | null;
    notes?: string;
    area_id?: string | null;
    where_id?: string | null;
    steps?: TodoStep[];
    links?: TodoLink[];
    priority?: TodoPriority;
  } = {};
  if (input.title.trim() && input.title.trim() !== c.title) patch.title = input.title.trim();
  if (input.type && input.type !== c.kind) patch.kind = input.type;
  if (input.status && input.status !== c.status) patch.status = input.status;
  if (clear.has("due_on")) {
    if (c.due_on) patch.due_on = null;
  } else if (input.due_on && input.due_on !== c.due_on) patch.due_on = input.due_on;
  let person: { id: string; name: string } | null = c.person;
  if (clear.has("person")) {
    if (c.person_id) patch.person_id = null;
    person = null;
  } else if (input.person_id && input.person_id !== c.person_id) {
    const p = await getPerson(input.person_id);
    if (!p) throw new Error("No person with that person_id. Use find_people.");
    patch.person_id = p.id;
    person = { id: p.id, name: p.name };
  }
  if (clear.has("notes")) {
    if (c.notes) patch.notes = "";
  } else if (input.notes.trim() && input.notes !== c.notes) patch.notes = input.notes;
  // Area and where/how, by name. Setting one here is the owner's choice, so Athena remembers it for that sender.
  const contextNames: Record<"area" | "where", string> = { area: "", where: "" };
  if (input.area.trim() || input.where.trim() || clear.has("area") || clear.has("where")) {
    const contexts = await listContexts();
    for (const k of ["area", "where"] as const) {
      const field = k === "area" ? "area_id" : "where_id";
      const current = c[field] ?? null;
      if (clear.has(k)) {
        if (current) patch[field] = null;
        continue;
      }
      const name = (k === "area" ? input.area : input.where).trim();
      if (!name) continue;
      const found = contextByName(name, contexts, k);
      if (!found) {
        const names = contextsOf(contexts, k).map((x) => x.name).join(", ");
        throw new Error(`No ${k === "area" ? "area" : "where/how"} called “${name}”. ${k === "area" ? "Areas" : "Where/how"}: ${names || "none yet"}.`);
      }
      contextNames[k] = found.name;
      if (found.id !== current || c.context_by_athena) patch[field] = found.id;
    }
  }
  if (input.priority && priorityOfName(input.priority) !== c.priority) patch.priority = priorityOfName(input.priority);
  // Steps: cleared, then ticked, unticked and removed by id, then new ones added at the end.
  const stepWords: string[] = [];
  if (clear.has("steps") || input.add_steps.length || input.done_steps.length || input.open_steps.length || input.remove_steps.length) {
    let steps = clear.has("steps") ? [] : c.steps.map((st) => ({ ...st }));
    const known = new Set(steps.map((st) => st.id));
    const unknown = [...input.done_steps, ...input.open_steps, ...input.remove_steps].filter((id) => !known.has(id));
    if (unknown.length && !clear.has("steps")) throw new Error(`No step with id ${unknown.map((x) => `“${x}”`).join(", ")} on that to-do. Step ids come from find_todos.`);
    const ticked = steps.filter((st) => input.done_steps.includes(st.id) && !st.done).length;
    const unticked = steps.filter((st) => input.open_steps.includes(st.id) && st.done).length;
    steps = steps
      .filter((st) => !input.remove_steps.includes(st.id))
      .map((st) => (input.done_steps.includes(st.id) ? { ...st, done: true } : input.open_steps.includes(st.id) ? { ...st, done: false } : st));
    const removed = clear.has("steps") ? 0 : c.steps.filter((st) => input.remove_steps.includes(st.id)).length;
    const added = input.add_steps.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (steps.length + added.length > MAX_STEPS) throw new Error(`A to-do can have at most ${MAX_STEPS} steps.`);
    steps.push(...added.map((text) => ({ id: newItemId(), text, done: false })));
    const changed = JSON.stringify(steps) !== JSON.stringify(c.steps);
    if (changed) {
      patch.steps = steps;
      if (clear.has("steps") && c.steps.length) stepWords.push("Steps cleared");
      if (added.length) stepWords.push(`${added.length} ${added.length === 1 ? "step" : "steps"} added`);
      if (ticked) stepWords.push(`${ticked} ${ticked === 1 ? "step" : "steps"} ticked`);
      if (unticked) stepWords.push(`${unticked} ${unticked === 1 ? "step" : "steps"} reopened`);
      if (removed > 0) stepWords.push(`${removed} ${removed === 1 ? "step" : "steps"} removed`);
    }
  }
  let linksAdded = 0;
  if (clear.has("links") || input.add_links.length) {
    const base = clear.has("links") ? [] : c.links;
    // A model's links are held: no preview fetch until the owner adds one themselves (lib/todo-details.ts).
    const fresh = modelLinks(askLinks(input.add_links)).filter((l) => !base.some((b) => b.url === l.url));
    if (base.length + fresh.length > MAX_LINKS) throw new Error(`A to-do can have at most ${MAX_LINKS} links.`);
    linksAdded = fresh.length;
    if (fresh.length || (clear.has("links") && c.links.length)) patch.links = [...base, ...fresh];
  }
  const kind = patch.kind ?? c.kind;
  if (kind !== "todo" && !(patch.person_id !== undefined ? patch.person_id : c.person_id)) throw new Error("i_owe and waiting_on need the person_id");
  if (!Object.keys(patch).length) return JSON.stringify({ done: `No change: “${c.title}” already has that`, id: c.id });

  const saved = await upsertCommitment({ id: c.id, ...patch });
  const today = zonedToday(ctx.now, ctx.tz);
  const parts: string[] = [];
  if (patch.status) parts.push(patch.status === "done" ? "Ticked off" : patch.status === "open" ? "Reopened" : "Dropped");
  if (patch.title) parts.push("Reworded");
  if (patch.kind || patch.person_id !== undefined) {
    parts.push(kind === "waiting_on" && person ? `Waiting on ${person.name}` : kind === "i_owe" && person ? `For ${person.name}` : person ? `With ${person.name}` : "To do");
  }
  if (patch.due_on !== undefined) parts.push(patch.due_on ? `Due ${dayLabel(patch.due_on, today)}` : "No due date");
  if (patch.notes !== undefined) parts.push(patch.notes ? "Notes updated" : "Notes cleared");
  if (patch.area_id !== undefined) parts.push(patch.area_id ? `Area: ${contextNames.area}` : "No area");
  if (patch.where_id !== undefined) parts.push(patch.where_id ? `Where: ${contextNames.where}` : "Where cleared");
  if (patch.priority !== undefined) parts.push(patch.priority ? todoExtras({ priority: patch.priority })[0] : "No priority");
  parts.push(...stepWords);
  if (patch.links !== undefined) parts.push(linksAdded ? `${linksAdded} ${linksAdded === 1 ? "link" : "links"} added` : "Links cleared");
  return ctx.record({
    kind: "commitment",
    id: saved.id,
    action: patch.status === "done" ? "completed" : "updated",
    title: saved.title,
    detail: parts.join(" · "),
    open: { kind: "commitment", id: saved.id },
    undo: {
      op: "restore_todo",
      id: c.id,
      title: c.title,
      kind: c.kind,
      status: c.status,
      due_on: c.due_on,
      person_id: c.person_id,
      notes: c.notes,
      // Only what this change touched, so Undo doesn't make an untouched context the owner's.
      ...(patch.area_id !== undefined ? { area_id: c.area_id } : {}),
      ...(patch.where_id !== undefined ? { where_id: c.where_id } : {}),
      ...(patch.steps !== undefined ? { steps: c.steps } : {}),
      ...(patch.links !== undefined ? { links: c.links } : {}),
      ...(patch.priority !== undefined ? { priority: c.priority } : {}),
    },
  });
}

// ---------- reminders ----------

async function changeReminder(raw: unknown, ctx: RecordContext): Promise<string> {
  const input = inputs.change_reminder.parse(raw);
  const r = await getReminder(input.id);
  if (!r) throw new Error("No reminder with that id. Use find_items with kind reminder.");
  if (unreadable(r.text)) throw new Error("That reminder can't be read right now, so I can't change it.");
  if (!!input.about_kind !== !!input.about_id) throw new Error("Give about_kind and about_id together.");
  const patch: { text?: string; date?: string; time?: string; repeat?: ReminderRepeat; about?: { type: EntityType; id: string } | null } = {};
  if (input.text.trim() && input.text.trim() !== r.text) patch.text = input.text.trim();
  if (input.date) patch.date = input.date;
  if (input.time) patch.time = input.time.trim().padStart(5, "0");
  if (input.repeat && input.repeat !== r.repeat) patch.repeat = input.repeat;
  if (input.clear.includes("about")) patch.about = null;
  else if (input.about_kind && input.about_id) {
    if (!(await entityTitle(input.about_kind, input.about_id))) throw new Error(`No ${input.about_kind} with that about_id.`);
    patch.about = { type: input.about_kind, id: input.about_id };
  }
  if (!Object.keys(patch).length) throw new Error("Say what to change.");
  const saved = await saveReminder({ id: r.id, ...patch, tz: ctx.tz });
  const was = zonedParts(new Date(r.remind_at), ctx.tz);
  const { date, time } = zonedParts(new Date(saved.remind_at), ctx.tz);
  if (saved.text === r.text && saved.remind_at === r.remind_at && saved.repeat === r.repeat && saved.about_id === r.about_id && !!saved.done_at === !!r.done_at) {
    return JSON.stringify({ done: `No change: the reminder is already ${dayLabel(was.date, zonedToday(ctx.now, ctx.tz))}, ${was.time}`, id: r.id });
  }
  const when = `${dayLabel(date, zonedToday(ctx.now, ctx.tz))}, ${time}`;
  return ctx.record({
    kind: "reminder",
    id: saved.id,
    action: "updated",
    title: saved.text,
    detail: `Reminder · ${when}${saved.repeat !== "none" ? ` · ${REPEAT_LABELS[saved.repeat]}` : ""}`,
    open: null,
    undo: {
      op: "restore_reminder",
      id: r.id,
      text: r.text,
      remind_at: new Date(r.remind_at).toISOString(),
      repeat: r.repeat,
      about: r.about_type && r.about_id ? { type: r.about_type as (typeof ABOUT_KINDS)[number], id: r.about_id } : null,
      done: !!r.done_at,
    },
  });
}

// ---------- links ----------

/** A live graph item's name or title; null when it isn't there (or is archived). */
async function entityTitle(kind: (typeof LINK_KINDS)[number], id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  if (kind === "note") {
    const n = await getNote(id);
    return n ? n.title || "Untitled note" : null;
  }
  if (kind === "record") return (await getCustomRecord(id))?.title ?? null;
  const r = await getRecord(kind, id);
  return r ? ("name" in r ? r.name : r.title) : null;
}

const openFor = (kind: (typeof LINK_KINDS)[number], id: string): Change["open"] => ({ kind, id });

const relationWords = (relation: string) => relation.replace(/_/g, " ");

async function linkRecords(raw: unknown, ctx: RecordContext): Promise<string> {
  const input = inputs.link_records.parse(raw);
  if (input.from_kind === input.to_kind && input.from_id === input.to_id) throw new Error("Pick two different things.");
  const [from, to] = await Promise.all([entityTitle(input.from_kind, input.from_id), entityTitle(input.to_kind, input.to_id)]);
  if (!from) throw new Error(`No ${input.from_kind} with from_id (it may be archived).`);
  if (!to) throw new Error(`No ${input.to_kind} with to_id (it may be archived).`);
  const relation = input.relation.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const title = `${from} and ${to}`;
  const edges = (await getConnections(input.from_kind, input.from_id)).filter(
    (e) =>
      e.origin === "manual" &&
      ((e.source_type === input.from_kind && e.source_id === input.from_id && e.target_type === input.to_kind && e.target_id === input.to_id) ||
        (e.source_type === input.to_kind && e.source_id === input.to_id && e.target_type === input.from_kind && e.target_id === input.from_id)),
  );

  if (input.link) {
    const rel = relation || "relates_to";
    if (edges.some((e) => e.relation === rel)) return JSON.stringify({ done: `No change: ${title} are already linked` });
    const edge = await linkEntities({ sourceType: input.from_kind, sourceId: input.from_id, targetType: input.to_kind, targetId: input.to_id, relation: rel });
    return ctx.record({
      kind: "link",
      id: edge.id,
      action: "created",
      title,
      detail: rel === "relates_to" ? "Linked" : `Linked · ${relationWords(rel)}`,
      open: openFor(input.from_kind, input.from_id),
      undo: { op: "unlink", edges: [{ source_type: edge.source_type, source_id: edge.source_id, target_type: edge.target_type, target_id: edge.target_id, relation: edge.relation }] },
    });
  }

  const going = edges.filter((e) => !relation || e.relation === relation);
  if (!going.length) return JSON.stringify({ done: `No change: there's no link between ${title} to remove. A link written in a note's text comes from the note: change the note to remove it.` });
  for (const e of going) await unlinkEntities({ sourceType: e.source_type, sourceId: e.source_id, targetType: e.target_type, targetId: e.target_id, relation: e.relation });
  return ctx.record({
    kind: "link",
    id: going[0].id,
    action: "updated",
    title,
    detail: "Unlinked",
    open: openFor(input.from_kind, input.from_id),
    undo: { op: "relink", edges: going.map((e) => ({ source_type: e.source_type, source_id: e.source_id, target_type: e.target_type, target_id: e.target_id, relation: e.relation })) },
  });
}

// ---------- archiving ----------

/** How archive_or_restore treats each kind: the table it lives in, its words, and its receipt. */
const ARCHIVING: Record<ArchiveKind, { kind: ArchivableKind | "reminder"; one: string; many: string; change: ChangeKind; open?: Exclude<NonNullable<Change["open"]>["kind"], "draft" | "doc"> }> = {
  note: { kind: "note", one: "note", many: "notes", change: "note", open: "note" },
  person: { kind: "person", one: "person", many: "people", change: "person", open: "person" },
  place: { kind: "place", one: "place", many: "places", change: "place", open: "place" },
  organisation: { kind: "organisation", one: "organisation", many: "organisations", change: "organisation", open: "organisation" },
  event: { kind: "event", one: "event", many: "events", change: "event", open: "event" },
  project: { kind: "project", one: "project", many: "projects", change: "project", open: "project" },
  todo: { kind: "commitment", one: "to-do", many: "to-dos", change: "commitment", open: "commitment" },
  reminder: { kind: "reminder", one: "reminder", many: "reminders", change: "reminder" },
  catch_up: { kind: "interaction", one: "catch-up", many: "catch-ups", change: "interaction" },
  detail: { kind: "fact", one: "detail", many: "details", change: "fact" },
  reading: { kind: "reading", one: "Watch & read item", many: "Watch & read items", change: "reading", open: "reading" },
  goal: { kind: "goal", one: "goal", many: "goals", change: "goal", open: "goal" },
  asset: { kind: "asset", one: "life admin item", many: "life admin items", change: "asset", open: "asset" },
  trip: { kind: "trip", one: "trip", many: "trips", change: "trip", open: "trip" },
  booking: { kind: "booking", one: "booking", many: "bookings", change: "booking" },
  purchase: { kind: "purchase", one: "purchase", many: "purchases", change: "purchase", open: "purchase" },
  record: { kind: "record", one: "record", many: "records", change: "record", open: "record" },
  type: { kind: "kind", one: KIND_WORD.one, many: KIND_WORD.many, change: "kind", open: "kind" },
};

/** One thing's title, whether it's archived (or a reminder finished), and its icon; null when there's no such thing. */
async function archivable(kind: ArchiveKind, id: string): Promise<{ title: string; archived: boolean; icon?: string } | null> {
  const any = { includeArchived: true };
  const state = (row: { archived_at: string | null } | null, title: (r: never) => string) => (row ? { title: title(row as never), archived: !!row.archived_at } : null);
  switch (kind) {
    case "note":
      return state(await getNote(id, any), (n: { title: string }) => n.title || "Untitled note");
    case "person":
      return state(await getPerson(id, any), (p: Person) => p.name);
    case "place":
    case "organisation":
    case "project":
      return state((await getRecord(kind, id, any)) as Place | null, (r: { name: string }) => r.name);
    case "event":
      return state(await getEvent(id, any), (e: AthenaEvent) => e.title);
    case "todo":
      return state(await getCommitment(id, any), (c: { title: string }) => c.title);
    case "reminder": {
      const r = await getReminder(id);
      return r ? { title: r.text, archived: !!r.done_at } : null;
    }
    case "catch_up":
      return state(await getInteraction(id, any), (i: { summary: string }) => i.summary || "Catch-up");
    case "detail":
      return state(await getFact(id, any), (f: { key: string; value: string }) => `${f.key}: ${f.value}`);
    case "reading":
      return state(await getReadingItem(id, any), (r: { title: string }) => r.title);
    case "goal":
      return state(await getGoal(id, any), (g: Goal) => g.title);
    case "asset":
      return state(await getAsset(id, any), (a: Asset) => a.name);
    case "trip":
      return state(await getTrip(id, any), (t: Trip) => t.title);
    case "booking":
      return state(await getBooking(id, any), (b: { title: string }) => b.title);
    case "purchase":
      return state(await getPurchase(id, any), (p: { retailer: string; items: string[] }) => purchaseName(p));
    case "record": {
      const r = await getCustomRecord(id, any);
      if (!r) return null;
      const k = await getKind(r.kind_id, any);
      return { title: r.title, archived: !!r.archived_at, icon: k?.icon };
    }
    case "type": {
      const k = await getKind(id, any);
      return k ? { title: k.name, archived: !!k.archived_at, icon: k.icon } : null;
    }
  }
}

/** Archive or restore one: a reminder is finished (cancelled) or turned back on instead. */
async function setArchived(kind: ArchiveKind, id: string, archived: boolean): Promise<boolean> {
  const target = ARCHIVING[kind].kind;
  if (target === "reminder") {
    await saveReminder({ id, done: archived });
    return true;
  }
  return archived ? archiveEntity(target, id) : unarchiveEntity(target, id);
}

async function archiveOrRestore(raw: unknown, ctx: RecordContext): Promise<string> {
  const { kind, ids, archive } = inputs.archive_or_restore.parse(raw);
  const how = ARCHIVING[kind];
  const done: Array<{ id: string; title: string; icon?: string }> = [];
  const refused: string[] = [];
  let missing = 0;
  let already = 0;
  for (const id of [...new Set(ids)]) {
    const item = await archivable(kind, id);
    if (!item) {
      missing++;
      continue;
    }
    if (item.archived === archive) {
      already++;
      continue;
    }
    // One that can't be restored (a type whose name is taken) doesn't stop the rest; what was done still gets its receipt.
    try {
      if (!(await setArchived(kind, id, archive))) {
        missing++;
        continue;
      }
    } catch (error) {
      refused.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    done.push({ id, title: item.title, icon: item.icon });
  }
  const counts = { ...(already ? { already_so: already } : {}), ...(missing ? { not_found: missing } : {}), ...(refused.length ? { refused } : {}) };
  if (!done.length) {
    if (refused.length) throw new Error(refused[0]);
    if (!already) throw new Error(`No ${how.one} with ${ids.length === 1 ? "that id" : "those ids"}.`);
    return JSON.stringify({ done: `No change: ${ids.length === 1 ? "it's" : "they're"} already ${archive ? (kind === "reminder" ? "cancelled" : "archived") : kind === "reminder" ? "on" : "restored"}`, ...counts });
  }
  const one = done.length === 1;
  const word = kind === "reminder" ? (archive ? "cancelled" : "back on") : archive ? "archived" : "restored";
  const result = ctx.record({
    kind: one ? how.change : kind === "person" ? "people" : how.change,
    id: one ? done[0].id : crypto.randomUUID(),
    icon: one ? done[0].icon : undefined,
    action: "updated",
    title: one ? done[0].title : `${done.length} ${how.many}`,
    detail: one ? `${capitalise(how.one)} ${word}` : capitalise(word),
    open: one && !archive && how.open ? { kind: how.open, id: done[0].id } : null,
    undo: { op: "set_archived", kind, ids: done.map((d) => d.id), archived: !archive },
  });
  return JSON.stringify({ ...JSON.parse(result), changed: done.length, ...counts });
}

// ---------- running them ----------

/** Run one of RECORD_TOOLS for lib/assistant.ts's session. */
export async function runRecordTool(name: string, raw: unknown, ctx: RecordContext): Promise<string> {
  switch (name) {
    case "find_items": {
      const { kind, query } = inputs.find_items.parse(raw);
      const found = await findItems(kind, query, ctx);
      return JSON.stringify(found);
    }
    case "update_people":
      return updatePeople(raw, ctx);
    case "save_item":
      return saveItem(raw, ctx);
    case "change_todo":
      return changeTodo(raw, ctx);
    case "change_reminder":
      return changeReminder(raw, ctx);
    case "link_records":
      return linkRecords(raw, ctx);
    case "archive_or_restore":
      return archiveOrRestore(raw, ctx);
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- undo ----------

const EDGE = z.object({ source_type: z.enum(ENTITY_TYPES as unknown as [EntityType, ...EntityType[]]), source_id: UUID, target_type: z.enum(ENTITY_TYPES as unknown as [EntityType, ...EntityType[]]), target_id: UUID, relation: z.string().min(1).max(80) });
const NOTES = z.string().max(100_000);
const DATE_OR_NULL = z.string().regex(DATE_RE).nullable();
const REMIND = z.array(z.number().int().min(0).max(365)).max(20);

/** What restore_item writes back, per kind: exactly what ItemSpec.before took. */
const ITEM_BEFORE = {
  place: z.object({ name: z.string().min(1).max(1000), address: z.string().max(2000), url: z.string().max(4000), notes: NOTES }),
  organisation: z.object({ name: z.string().min(1).max(1000), website: z.string().max(4000), notes: NOTES }),
  event: z.object({
    title: z.string().min(1).max(1000),
    kind: z.enum(EVENT_TYPES),
    date: z.string().regex(/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/),
    recurrence: z.enum(["none", "yearly"]),
    time: z.string().nullable().optional(),
    starts_at: z.string().nullable().optional(),
    remind_days_before: REMIND,
    notes: NOTES,
    person_id: UUID.nullable(),
  }),
  goal: z.object({
    title: z.string().min(1).max(1000),
    period: z.enum(GOAL_PERIODS as unknown as [string, ...string[]]),
    target: z.string().max(2000),
    progress: z.number().int().min(0).max(100),
    status: z.enum(GOAL_STATUSES as unknown as [string, ...string[]]),
    due_on: DATE_OR_NULL,
    notes: NOTES,
  }),
  asset: z.object({
    name: z.string().min(1).max(1000),
    kind: z.enum(ASSET_KINDS as unknown as [string, ...string[]]),
    provider: z.string().max(1000),
    renews_on: DATE_OR_NULL,
    remind_days_before: REMIND,
    notes: NOTES,
  }),
  project: z.object({ name: z.string().min(1).max(1000), status: z.enum(PROJECT_STATUSES), description: NOTES }),
  trip: z.object({ title: z.string().min(1).max(1000), notes: NOTES }),
} as const;

const RECORD_UNDO = z.discriminatedUnion("op", [
  z.object({ op: z.literal("restore_people"), people: z.array(PersonBefore).min(1).max(MAX_AT_ONCE) }),
  z.object({ op: z.literal("restore_item"), kind: z.enum(["place", "organisation", "event", "goal", "asset", "project", "trip"]), id: UUID, before: z.record(z.unknown()) }),
  z.object({ op: z.literal("restore_purchase"), id: UUID, status: z.enum(PURCHASE_STATUSES as unknown as [PurchaseStatus, ...PurchaseStatus[]]) }),
  z.object({
    op: z.literal("restore_todo"),
    id: UUID,
    title: z.string().min(1).max(1000),
    kind: z.enum(["todo", "i_owe", "waiting_on"]),
    status: z.enum(["open", "done", "dropped"]),
    due_on: DATE_OR_NULL,
    person_id: UUID.nullable(),
    notes: NOTES,
    area_id: UUID.nullable().optional(),
    where_id: UUID.nullable().optional(),
    // What the change touched of the to-do's details (0084), put back whole.
    steps: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })).max(MAX_STEPS).optional(),
    links: z.array(z.object({ id: z.string(), url: z.string(), title: z.string() })).max(MAX_LINKS).optional(),
    priority: z.number().int().min(0).max(3).optional(),
  }),
  z.object({
    op: z.literal("restore_reminder"),
    id: UUID,
    text: z.string().min(1).max(1000),
    remind_at: z.string().datetime({ offset: true }),
    repeat: z.enum(REMINDER_REPEATS as unknown as [ReminderRepeat, ...ReminderRepeat[]]),
    about: z.object({ type: z.enum(ABOUT_KINDS), id: UUID }).nullable(),
    done: z.boolean(),
  }),
  z.object({ op: z.literal("unlink"), edges: z.array(EDGE).min(1).max(20) }),
  z.object({ op: z.literal("relink"), edges: z.array(EDGE).min(1).max(20) }),
  z.object({ op: z.literal("set_archived"), kind: z.enum(ARCHIVE_KINDS), ids: z.array(UUID).min(1).max(MAX_AT_ONCE), archived: z.boolean() }),
]);

export type RecordUndo = z.infer<typeof RECORD_UNDO>;

const RECORD_UNDO_OPS = new Set(["restore_people", "restore_item", "restore_purchase", "restore_todo", "restore_reminder", "unlink", "relink", "set_archived"]);

export function isRecordUndo(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && RECORD_UNDO_OPS.has(String((raw as { op?: unknown }).op));
}

/** Put back what a change replaced, take a link away or back, or archive or restore again. Never deletes. */
export async function applyRecordUndo(raw: unknown, opts: { tz: string }): Promise<void> {
  const undo = RECORD_UNDO.parse(raw);
  switch (undo.op) {
    case "restore_people":
      for (const { id, ...before } of undo.people) await upsertPerson({ id, ...before });
      return;
    case "restore_item": {
      const before = ITEM_BEFORE[undo.kind].parse(undo.before);
      await SPECS[undo.kind].save({ id: undo.id, ...before }, opts.tz);
      return;
    }
    case "restore_purchase":
      await savePurchase({ purchase_id: undo.id, status: undo.status, detail: "Put back by you", source_ref: null }, { byOwner: true });
      return;
    case "restore_todo": {
      const { op: _op, ...before } = undo;
      await upsertCommitment(before);
      return;
    }
    case "restore_reminder":
      await saveReminder({ id: undo.id, text: undo.text, at: new Date(undo.remind_at), repeat: undo.repeat, about: undo.about, done: undo.done, tz: opts.tz });
      return;
    case "unlink":
      for (const e of undo.edges) await unlinkEntities({ sourceType: e.source_type, sourceId: e.source_id, targetType: e.target_type, targetId: e.target_id, relation: e.relation });
      return;
    case "relink":
      for (const e of undo.edges) await linkEntities({ sourceType: e.source_type, sourceId: e.source_id, targetType: e.target_type, targetId: e.target_id, relation: e.relation });
      return;
    case "set_archived":
      for (const id of undo.ids) await setArchived(undo.kind, id, undo.archived);
      return;
  }
}
