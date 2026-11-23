/**
 * Runs one collection: opens each of its accounts' MCP servers, hands Claude
 * the accounts' *allowed* read tools plus Athena's own tools (about twenty:
 * notes, people, to-dos, events, bookings, purchases, day entries and more),
 * and loops until the model finishes, then records the run.
 *
 * Claude is reached through Netlify AI Gateway (`new Anthropic()` with no
 * arguments picks up the injected ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL),
 * so no separate API key is needed; setting your own ANTHROPIC_API_KEY also
 * works. The model is the owner's choice for this job or for Careful work
 * (Settings → AI models, lib/models.ts); beneath that ATHENA_COLLECTOR_MODEL,
 * else Claude Sonnet 5.5.
 *
 * What's enforced here rather than asked of the model:
 *  - only tools on the account's allowlist, re-checked as non-writes at run
 *    time, are offered, and a call to anything else is refused;
 *  - every note gets this collection's `source`; metric names get its suffix;
 *  - notes dedupe on (source, external_id);
 *  - there is no delete or source-write tool, and the one archive tool
 *    (athena_archive_collected) reaches only records this collection wrote;
 *  - caps on turns, wall-clock time and notes written per run.
 */
import { eventTwin } from "../../../lib/event-twins";
import { collectedKind, emitTeamEvent } from "../../../lib/team-events";
import { rejectedTool } from "../../../lib/ai";
import { clientFor } from "../../../lib/llm";
import { fallbackRef, resolveJobModel } from "../../../lib/models";
import { ANY_OBJECT } from "../../../lib/ask-tool-pick";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  findEntityByName,
  getCollected,
  listCollected,
  replaceDailyMetric,
  setArchivedByCollector,
  blockedRunError,
  finishRun,
  getCollection,
  getConnector,
  keptApart,
  mixedCollectionError,
  linkCollectedMeetings,
  listCollections,
  listConnectors,
  markConnectorUsed,
  recordMailSkips,
  recordCollected,
  startRun,
  windowDescription,
  type BlockedAccount,
  type Collection,
  type Connector,
} from "../../../lib/connectors";
import {
  createNote,
  getConnections,
  getPerson,
  linkEntities,
  unlinkEntities,
  searchEntities,
  searchNotesByKeyword,
  updateNote,
  upsertEvent,
  archiveEntity,
  unarchiveEntity,
  upsertOrganisation,
  upsertPerson,
  upsertProject,
  claimReminder,
  getOwnerTimeZone,
  getNote,
  q,
  PAGE_TYPES,
  type ArchivableKind,
  type PageType,
} from "../../../lib/db";
import { addFact, ASSET_KINDS, findAsset, logInteraction, propose, upsertAsset, upsertCommitment, type AssetKind } from "../../../lib/memory";
import { saveBooking, savePurchase } from "../../../lib/trips";
import { saveReceipt } from "../../../lib/receipts-save";
import { RECEIPT_TOOL, receiptInput } from "./receipt-tool";
import { BOOKING_LABEL, PURCHASE_LABEL, purchaseName, tripLabel } from "../../../lib/trip-text";
import { collectionSource, presetFor } from "../../../lib/connector-presets";
import { addDays, isValidDate, zonedParts, zonedToday } from "../../../lib/dates";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../../lib/push";
import { inQuietHours } from "../../../lib/nudges";
import { BASE_PROMPT, lifeLogPrompt, RECIPE_PROMPTS } from "./recipes";
import { metricsFor, writeActivityMetrics } from "./activity-metrics";
export { WATCH_READ_RULE } from "./recipes";
import { styleProblems } from "../../../lib/writing-style";
import { filedSteps, MAX_FILED_STEPS, STEPS_RULE } from "../../../lib/todo-details";
import { withoutPlaces } from "../../../lib/places-line";
import { syncPlaces } from "./swarm-sync";
import { syncMoneyHome } from "./money-sync";
import { runHome } from "../home/home-run";
import { homeAccounts } from "../home/home-accounts";
import { syncPlaylists } from "./playlist-sync";
import { isSealedSync } from "../../../lib/presets/life";
import { isHealthSource, readHealthDay, saveHealthDay, withoutHealth, type HealthSource } from "../../../lib/health";
import { DAY_ENTRY_KINDS, entriesWithoutArt, getDay, readEntry, setEntryArt, setRunLine, writeEntries, type EntryInput } from "../../../lib/days";
import { runWorkSync } from "./work-sync";
import { activitySources, addRatings, applyTraktRatings, checkedSources, dropRepeats, hourlyAccounts, hourlyChangedSince, hourlyNote, notFromRuns, runPlaysWatches, syncRecent } from "./media-sync";
import { artStorable, fillDayArt } from "../../../lib/art";
import { callTool, ConnectorNeedsSignIn, listAllowedTools, openConnector, type OpenConnector } from "./mcp-client";
import { contactsDirectory, type ContactsDirectory } from "./icloud-people";
import { lastGoodRun, precheck } from "./precheck";
import { fromCalendar, syncAnswerOnly, syncRsvp, type CalendarInvite } from "../../../lib/rsvp";
import { calibrated, guardText } from "../../../lib/jev";
import { SYNC_KINDS, SYNC_SOURCES, syncWatchRead } from "../../../lib/watch-read-sync";
import { copyTripItAccounts } from "./tripit-trips";
import { checkBudget, isBudgetUnchecked, recordUsage } from "../../../lib/spend";

const MAX_TURNS = 40;
/** Background functions stop at 15 minutes; leave room to record the run. */
const TIME_BUDGET_MS = 11 * 60_000;
const MAX_NOTES_PER_RUN = 60;
const MAX_METRICS_PER_RUN = 10;
/**
 * AI Gateway caps a team's spend per minute (in credits, across every site)
 * and answers past it with a bare 429. The SDK's own quick retries land in
 * the same minute, so on a 429 the run waits for the window to roll over
 * and carries on: a few times at most, and only while it has time left.
 */
const RATE_LIMIT_WAITS = 4;
const RATE_LIMIT_WAIT_MS = 65_000;

async function createMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  deadline: number,
): Promise<Anthropic.Message> {
  // AI spend (lib/spend.ts): stopped before the call once today's budget is used; what it cost is kept.
  await checkBudget();
  let mended = 0;
  for (let waits = 0; ; waits++) {
    try {
      const message = await client.messages.create(params);
      await recordUsage({ model: params.model, usage: message.usage });
      return message;
    } catch (error) {
      // A connected account's tool with a definition the provider refuses (a server with hundreds of tools has a few): it's offered as
      // "any object" instead, or left out if that's refused too, and the run carries on (lib/ask-tool-pick.ts). The list is the caller's own, so later turns keep the mend.
      const at = rejectedTool(error);
      const bad = at === null ? undefined : (params.tools?.[at] as Anthropic.Tool | undefined);
      if (bad && params.tools && mended < 60) {
        mended++;
        waits--;
        if (JSON.stringify(bad.input_schema) === JSON.stringify(ANY_OBJECT)) params.tools.splice(at!, 1);
        else params.tools[at!] = { ...bad, input_schema: { ...ANY_OBJECT } };
        console.warn(`Athena collection: the tool ${bad.name} has a definition the provider refused: mended`);
        continue;
      }
      if (!(error instanceof Anthropic.RateLimitError)) throw error;
      const retryAfter = Number(error.headers?.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
      if (waits >= RATE_LIMIT_WAITS || Date.now() + wait > deadline) {
        throw new Error(
          "Netlify AI Gateway's per-minute spending limit for your team was reached and didn't clear in time. Try again in a few minutes.",
        );
      }
      console.warn(`Athena collection: AI Gateway rate limit, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function env(name: string): string | undefined {
  return (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(name) ?? process.env[name];
}

/** Is there a way to reach Claude (AI Gateway injection or your own key)? */
export function aiConfigured(): boolean {
  return !!(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN") || env("ANTHROPIC_BASE_URL"));
}

export interface RunStats {
  turns: number;
  tool_calls: number;
  source_calls: number;
  notes_created: number;
  notes_updated: number;
  /** Items you'd archived or deleted, left alone. */
  skipped_dismissed: number;
  /** Records archived because their source item was cancelled or deleted, and ones restored when it came back. */
  archived: number;
  restored: number;
  events_created: number;
  events_updated: number;
  metrics: number;
  people: number;
  /** Layer 2: meetings logged as catch-ups, to-dos and details recorded, and finds sent to the Review inbox. */
  catch_ups: number;
  todos: number;
  details: number;
  suggestions: number;
  /** Trips and purchases from booking and order emails: new ones, and ones a later email changed. */
  bookings_created?: number;
  bookings_updated?: number;
  /** Of those, copied from TripIt before Claude (tripit-trips.ts): not counted against Claude's booking limit. */
  tripit_bookings?: number;
  purchases_created?: number;
  purchases_updated?: number;
  /** From email: life-admin renewals added and moved on, and account alerts filed as to-dos for today. */
  renewals_created?: number;
  renewals_updated?: number;
  alerts?: number;
  /** Films, shows and books put in Watch & read (athena_watch_read): new ones, and ones a source filled in or re-rated. */
  watch_read_created?: number;
  watch_read_updated?: number;
  /** Days (lib/days.ts): entries saved by athena_day_entry, new and changed, and day lines written. */
  entries_created?: number;
  entries_updated?: number;
  day_lines?: number;
  /** Jev: 1 when the pre-check found nothing new and Claude wasn't started; emails judged not worth reading; tool results flagged as trying to instruct an AI. */
  claude_skipped: number;
  triaged_out: number;
  flagged: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

// ---------- Athena's write tools ----------

const MAX_EVENTS_PER_RUN = 150;
const MAX_ARCHIVES_PER_RUN = 25;
const MAX_BOOKINGS_PER_RUN = 40;
const MAX_PURCHASES_PER_RUN = 60;
const UUID = z.string().uuid();
const RECORD_KIND = z.enum(PAGE_TYPES as unknown as [PageType, ...PageType[]]);
const DATE = z.string().refine((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && isValidDate(d), "YYYY-MM-DD");

const ATHENA_TOOLS: Anthropic.Tool[] = [
  {
    name: "athena_search_notes",
    description: "Keyword search over existing Athena notes (titles and bodies). Use to check what's already recorded.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "athena_find",
    description: "Find people, organisations, projects, places or events in Athena by name, to get ids for links.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kinds: { type: "array", items: { type: "string", enum: ["person", "organisation", "project", "place", "event"] } },
      },
      required: ["query"],
    },
  },
  {
    name: "athena_save_note",
    description:
      "Create a note, or update the one saved earlier for the same external_id. Tagged with this collection's source automatically. Body is Markdown and may contain athena:// links. Returns action created / updated / restored, or skipped when the owner archived or deleted that item's note — then leave it alone.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "Stable id of the source item: thread id, event id, issue identifier, message link." },
        title: { type: "string" },
        body: { type: "string" },
        type: { type: "string", enum: ["note", "capture"] },
        tags: { type: "array", items: { type: "string" } },
        date: { type: "string", description: "The source item's date, YYYY-MM-DD in the owner's time zone (the meeting's day, the email's day)." },
      },
      required: ["external_id", "title", "body"],
    },
  },
  {
    name: "athena_person",
    description: "Get the id of a person in Athena, creating them (name only, plus email if given) if they aren't there yet.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "athena_project",
    description: "Get the id of a project in Athena by name, creating it if needed.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "athena_organisation",
    description: "Get the id of an organisation (company, club, school) in Athena by name, creating it if needed.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "athena_link",
    description:
      "Link two Athena records with a relation, e.g. a note to a project with 'part_of', or a person to an organisation with 'works_at'. Mentions in note bodies are linked automatically; use this only for other relations.",
    input_schema: {
      type: "object",
      properties: {
        from_kind: { type: "string", enum: [...PAGE_TYPES] },
        from_id: { type: "string" },
        to_kind: { type: "string", enum: [...PAGE_TYPES] },
        to_id: { type: "string" },
        relation: { type: "string" },
      },
      required: ["from_kind", "from_id", "to_kind", "to_id", "relation"],
    },
  },
  {
    name: "athena_metric",
    description:
      "Record a daily count for this collection. One value per metric per day: recording it again the same day replaces it, so reruns are safe. lower_snake_case names; the account suffix is added automatically. Never money or health figures.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "number" },
        day: { type: "string", description: "The day this count is for, YYYY-MM-DD in the owner's time zone. Defaults to today." },
        window_start: { type: "string", description: "ISO timestamp" },
        window_end: { type: "string", description: "ISO timestamp" },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "athena_list_collected",
    description:
      "List what this collection already holds for a date range (its notes, or its synced events), with each item's external_id, title, date and state; events also say how many people are linked to them (people). Use it to find items that were cancelled or deleted at the source since they were saved, and events saved without their attendees.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "event"] },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["kind", "from", "to"],
    },
  },
  {
    name: "athena_archive_collected",
    description:
      "Archive a note or synced event this collection wrote, because its source item was cancelled or deleted (not declined: save a declined event as usual, and Athena labels it). Only after you've confirmed that by fetching the item itself (not because it's missing from a search). The owner can restore it; if the item comes back, saving it again restores it.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "event"] },
        external_id: { type: "string" },
        reason: { type: "string", description: "e.g. 'cancelled', 'deleted'" },
      },
      required: ["kind", "external_id", "reason"],
    },
  },
  // ---- layer 2: who the owner met, what they owe, what to remember (lib/memory.ts) ----
  {
    name: "athena_catch_up",
    description:
      "Log that the owner met or spoke with people (a meeting or call). This fills in \"Last spoke\" on their profiles and the weekly review. One per source item: logging the same external_id again updates it. Never include the owner. Returns created / updated, or skipped when the owner archived it.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The same id you saved the note with (the calendar event id or the notes id)." },
        at: { type: "string", description: "When it started, ISO 8601 with its offset or Z." },
        channel: { type: "string", enum: ["meeting", "call", "message", "email", "in_person", "other"] },
        summary: { type: "string", description: "One plain line on what it was about. No private details." },
        person_ids: { type: "array", items: { type: "string" }, description: "Everyone else who was there (ids from athena_person)." },
      },
      required: ["external_id", "at", "channel", "summary", "person_ids"],
    },
  },
  {
    name: "athena_todo",
    description:
      `Record a commitment from a source item. kind: i_owe = the owner said they'd do something for someone (give person_id); todo = something the owner will do, for nobody in particular; waiting_on = someone else said they'd do something for the owner (give person_id); decision = a decision that was made. Only clear commitments with an owner on the owner's side of the table, not every action item in the room. quote = the words it came from. confidence 0–1: below 0.8 it goes to the owner's Review inbox instead of the To do list. ` +
      `steps: ${STEPS_RULE} ` +
      `Recording one that's already there (reworded, or from the same meeting under another id) comes back already_recorded with its status: one the owner finished or dropped is never filed again.`,
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The id of the source item it came from (the same one as its note)." },
        title: { type: "string", description: "Short and actionable, starting with a verb: \"Send Ricardo the staging plan\"." },
        kind: { type: "string", enum: ["i_owe", "todo", "waiting_on", "decision"] },
        person_id: { type: "string" },
        due_on: { type: "string", description: "YYYY-MM-DD, only when a date was actually said." },
        quote: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        area: { type: "string", description: "Which part of the owner's life, only when it's obvious from the item: Work, Personal, Health, Money, Family or Home. Leave it out when unsure." },
        where: { type: "string", description: "Where or how it gets done, only when it's obvious: Computer, Phone, Errands, Home, Office or With someone. Leave it out when unsure." },
        steps: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FILED_STEPS,
          description: `Usually leave this out. The parts of this one to-do, in order, each starting with a verb, only when the source spells them out. At least two, or none. Never other action items from the same meeting or thread: those are to-dos of their own.`,
        },
      },
      required: ["external_id", "title", "kind", "quote", "confidence"],
    },
  },
  {
    name: "athena_remember",
    description:
      "Remember a durable detail about a person: family, where they're based, their role, a preference, a date that matters (\"Kids: Maya (7)\", \"Based in: Lisbon\"). A new value replaces the old one for the same key. Not for one-off meeting content (that goes in the note), and never money or health details. confidence below 0.8 goes to the Review inbox.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The id of the source item it came from." },
        person_id: { type: "string" },
        key: { type: "string", description: "Short and reusable, e.g. \"Role\", \"Based in\", \"Partner\"." },
        value: { type: "string" },
        quote: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "person_id", "key", "value", "quote", "confidence"],
    },
  },
];

/** Agent finds below this confidence go to the Review inbox rather than straight in. */
const REVIEW_BELOW = 0.8;

/** Only offered when the collection syncs upcoming calendar events. */
const SAVE_EVENT_TOOL: Anthropic.Tool = {
  name: "athena_save_event",
  description:
    "Add an upcoming calendar event to Athena's events (what Coming up, the morning briefing and reminders read), or update the one saved earlier for the same external_id — moved, renamed. Returns created / updated / restored, or skipped when the owner archived or deleted it.",
  input_schema: {
    type: "object",
    properties: {
      external_id: { type: "string", description: "The calendar event's id (for a recurring event, this occurrence's id)." },
      title: { type: "string" },
      start: { type: "string", description: "For a timed event: when it starts, ISO 8601 with its offset or Z, exactly as the calendar gives it (e.g. 2026-11-07T09:30:00-05:00). Athena stores it in UTC." },
      end: { type: "string", description: "For a timed event: when it ends, in the same form as start, exactly as the calendar gives it." },
      date: { type: "string", description: "For an all-day event only: its date, YYYY-MM-DD." },
      notes: { type: "string", description: "One or two lines: where, who, a link if it has one. No full descriptions." },
      my_response: { type: "string", description: "The owner's own reply as the calendar gives it (myResponse): accepted, maybe, declined or no reply yet. Leave out for their own events." },
      attendees: {
        type: "array",
        description:
          "The other people on the invite: name and email as the calendar gives them. Not the owner (marked “you”), rooms, or group and list addresses (team@, all@). Leave out anyone who declined. Athena links each to the event, adding them to People if they're new (for meetings of up to 8 others).",
        items: { type: "object", properties: { name: { type: "string" }, email: { type: "string" } } },
      },
    },
    required: ["external_id", "title", "attendees"],
  },
};

/** Past this many others on an invite (an all-hands), only people already in Athena are linked; nobody new is added. */
const MAX_NEW_ATTENDEES = 8;
const MAX_PEOPLE_PER_RUN = 60;
/** Calendar resources and group addresses aren't people. */
const NOT_A_PERSON = /@(?:resource|group)\.calendar\.google\.com$|^(?:no-?reply|do-?not-?reply|calendar-notification)@/i;

interface FiledCommitment {
  id: string;
  title: string;
  source_quote: string | null;
  kind: string;
  person_id: string | null;
  source_ref: string | null;
  status: string;
  archived: boolean;
}

const MINOR_WORDS = new Set(["a", "an", "the", "to", "for", "and", "or", "of", "on", "in", "at", "with", "about", "my", "me", "i", "you", "your", "their", "them", "it", "its", "is", "be", "will", "by", "from", "up", "this", "that"]);
const wordsOf = (s: string | null | undefined) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !MINOR_WORDS.has(w)),
  );
/** Share of the shorter text's words that the other has (1 = every word of one is in the other). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Is a to-do the collector is about to file one that's already there? From
 * the same source item: the same words, give or take ("Send Gayle the deck",
 * "Send the deck to Gayle"), or the same quote. From another item of this
 * collection (the same meeting under a different id): the same kind, for the
 * same person, quoting the same words, so a weekly "send the report" from a
 * new meeting, which quotes something new, still gets filed.
 */
export function sameCommitment(
  filed: Pick<FiledCommitment, "title" | "source_quote" | "kind" | "person_id">,
  next: { title: string; quote?: string | null; kind: string; person_id: string | null },
  sameItem: boolean,
): boolean {
  const titles = overlap(wordsOf(filed.title), wordsOf(next.title));
  const quoteWords = [wordsOf(filed.source_quote), wordsOf(next.quote)];
  const sameQuote = quoteWords.every((w) => w.size >= 4) && overlap(quoteWords[0], quoteWords[1]) >= 0.8;
  if (sameItem) return filed.title.trim().toLowerCase() === next.title.trim().toLowerCase() || titles >= 0.6 || sameQuote;
  return filed.kind === next.kind && (filed.person_id ?? null) === (next.person_id ?? null) && sameQuote && titles >= 0.5;
}

/** "priya.shah@example.com" → "Priya Shah", for an attendee the calendar gives no name for. */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]
    .split(/[._+-]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Trips and purchases (lib/trips.ts), offered to collections that read email.
 * Booking and order emails become records with a structure Athena can act on
 * (Coming up, the briefing, a push before a flight), not notes.
 */
const TRIP_TOOLS: Anthropic.Tool[] = [
  {
    name: "athena_trip_booking",
    description:
      "Save a travel booking from an email: a flight, train, hotel stay, car hire or event ticket. One call per part: each flight leg, each train journey, each hotel stay. " +
      "Athena groups bookings into trips by place and dates (\"Lisbon, 12–15 Mar\"). Saving the same reference again updates that booking instead of adding another: " +
      "a changed time is marked changed and keeps the old time; status \"cancelled\" marks it cancelled. When one reference covers several parts, give each its segment " +
      "(\"outbound\", \"return\", or the flight number) and keep it the same in later emails. Times are the local time where it happens, with that place's IANA time zone. " +
      "Never prices, totals or card details. Returns created / updated / skipped (the owner archived it), the trip it's in, and any other bookings under the same reference " +
      "(pass booking_id to update one of those). confidence below 0.8 goes to the Review inbox.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The email thread id it came from." },
        kind: { type: "string", enum: ["flight", "train", "hotel", "car", "event", "other"] },
        status: { type: "string", enum: ["confirmed", "changed", "cancelled"], description: "Default confirmed. cancelled when the email cancels it." },
        title: {
          type: "string",
          description: "Short: the flight or train number (\"BA 432\", \"Eurostar 9014\"), the hotel's name, the car hire company, or the event (\"Fado at Clube de Fado\").",
        },
        provider: { type: "string", description: "Who it's with: \"British Airways\", \"Booking.com\", \"Hertz\", \"Ticketmaster\"." },
        reference: { type: "string", description: "The booking reference or confirmation number, exactly as written." },
        segment: { type: "string", description: "Which part of a booking with several parts: \"outbound\", \"return\", or the flight number. Leave out when there's only one." },
        start_local: {
          type: "string",
          description: "Local time where it starts (departs, check-in, pick-up, doors): YYYY-MM-DDTHH:MM with no offset, or YYYY-MM-DD when the email gives no time.",
        },
        start_tz: { type: "string", description: "IANA time zone of where it starts, e.g. Europe/London." },
        start_place: { type: "string", description: "Airport and terminal, station, hotel address, pick-up desk or venue: \"London Heathrow T5\"." },
        start_city: { type: "string", description: "The city it starts in: \"London\"." },
        end_local: { type: "string", description: "Local time where it ends (arrives, check-out, drop-off), same format. Leave out when unknown." },
        end_tz: { type: "string", description: "IANA time zone of where it ends; defaults to start_tz." },
        end_place: { type: "string", description: "Arrival airport and terminal, or drop-off place." },
        end_city: { type: "string", description: "The city it ends in: \"Lisbon\"." },
        seat: { type: "string", description: "Seat, coach or row when given: \"14A\", \"Coach 7, seat 61\"." },
        details: { type: "string", description: "One short line worth having at the door: room type, car class, gate, how many people. No prices." },
        email_link: { type: "string", description: "A link to the email, if the source gives one." },
        trip_destination: { type: "string", description: "The city the trip is to. For the journey home, where you're coming back from." },
        booking_id: { type: "string", description: "Update this booking (an id from same_reference in an earlier answer)." },
        quote: { type: "string", description: "The line from the email that confirms it, e.g. \"Your booking is confirmed. Reference ABC123\"." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "kind", "title", "reference", "start_local", "start_tz", "quote", "confidence"],
    },
  },
  {
    name: "athena_purchase",
    description:
      "Save an order, or an update on one, from an email: ordered, dispatched, out for delivery, delivered, delayed, returned, refunded or cancelled. " +
      "The first email for an order creates it; later ones for the same order number (or tracking number) move it along, so call it for every update. " +
      "Item names, order number, carrier and tracking only: never prices, totals, card or payment details. Returns created / updated / restored / skipped " +
      "(the owner archived it). confidence below 0.8 goes to the Review inbox.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The email thread id it came from." },
        retailer: { type: "string", description: "The shop: \"Amazon\", \"IKEA\". For a carrier's email, the shop it's from if named." },
        order_number: { type: "string", description: "The order number, exactly as written. Leave out only for a carrier's email that doesn't give one." },
        items: { type: "array", items: { type: "string" }, description: "Item names, short (\"Kindle Paperwhite\"). No prices or quantities of money." },
        ordered_on: { type: "string", description: "YYYY-MM-DD the order was placed, when known." },
        status: { type: "string", enum: ["ordered", "dispatched", "out_for_delivery", "delivered", "delayed", "returned", "refunded", "cancelled"] },
        status_at: { type: "string", description: "When this happened: the email's time, ISO 8601 with its offset or Z." },
        expected_on: { type: "string", description: "The delivery day it's expected, YYYY-MM-DD, when the email says." },
        carrier: { type: "string", description: "\"Royal Mail\", \"DPD\", \"UPS\"." },
        tracking_number: { type: "string" },
        tracking_url: { type: "string", description: "The carrier's tracking link, if there is one." },
        detail: { type: "string", description: "One short line for the timeline, if useful: \"Left with a neighbour\", \"New delivery day Thursday\"." },
        email_link: { type: "string", description: "A link to the email, if the source gives one." },
        purchase_id: { type: "string", description: "Update this purchase (an id from an earlier answer)." },
        quote: { type: "string", description: "The line from the email that says it, e.g. \"Your order has been dispatched\"." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "retailer", "status", "quote", "confidence"],
    },
  },
];

const MAX_EMAIL_DATES_PER_RUN = 30;
const MAX_RENEWALS_PER_RUN = 20;
const MAX_ALERTS_PER_RUN = 10;
/** Email digest runs: notes are for reference mail only (recipes.ts step 9), so a handful at most. */
const MAX_EMAIL_NOTES_PER_RUN = 5;
/** Tags that say a note is something a structured tool records, refused in an email digest run with where it goes instead. */
const NOT_A_NOTE_TAGS: Record<string, string> = {
  fyi: "Nice-to-know email isn't kept: count it in emails_reviewed_day and move on.",
  receipt: "Receipts go to athena_purchase, athena_trip_booking or athena_receipt, or are skipped.",
  "action-item": "Things to do go to athena_todo (with due_on when there's a date), not a note.",
  "action-items": "Things to do go to athena_todo (with due_on when there's a date), not a note.",
};
/** Accounts that are mailboxes (lib/team-events.ts collectedKind). */
const MAIL_PROVIDER = /gmail|outlook-mail|fastmail|mail|imap/;
/** What email sets off for Team, beside a kept note ("email"): lib/team-triggers.ts lets "an email arrives" match each of them. */
const EMAIL_EVENT_KINDS = new Set(["email", "delivery", "booking", "appointment", "deadline", "renewal", "alert"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
/** A run of digits long enough to be a policy, licence, passport or account number. */
const ID_NUMBER = /\d[\d\s-]{6,}\d/;

/**
 * What else email carries that Athena acts on: appointments and deadlines
 * (events), renewals (life admin) and account alerts (a to-do for today).
 * Offered to collections that read email, beside TRIP_TOOLS.
 */
const EMAIL_TOOLS: Anthropic.Tool[] = [
  {
    name: "athena_email_date",
    description:
      "Save an appointment or a deadline an email sets, that isn't travel: the dentist, a GP or vet appointment, a haircut, an engineer's visit, a parents' evening, a form due by a date. " +
      "It goes on Athena's events, so Coming up, the briefing and reminders show it. Saving again for the same thread (and part) updates it: a moved time, a new place; cancelled: true archives it. " +
      "An appointment already on the owner's calendar with the same title and time is joined, not doubled. confidence below 0.8 goes to the Review inbox.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The email thread id it came from." },
        part: { type: "string", description: "Only when one thread sets several dates: which one (\"first visit\", \"follow-up\"). Keep it the same in later emails." },
        kind: { type: "string", enum: ["appointment", "deadline"] },
        title: { type: "string", description: "Short and plain: \"Dentist, Dr Patel\", \"Boiler service\", \"School trip form due\"." },
        start: { type: "string", description: "A timed appointment: when it starts, ISO 8601 with its offset (2026-11-20T09:30:00+00:00)." },
        end: { type: "string", description: "When it ends, same form, when the email says." },
        date: { type: "string", description: "A deadline, or an appointment with no time: YYYY-MM-DD." },
        notes: { type: "string", description: "One line: where, who with, what to bring. No prices, no reference numbers beyond a booking reference." },
        cancelled: { type: "boolean", description: "true when the email cancels it." },
        quote: { type: "string", description: "The line from the email that sets it, e.g. \"Your appointment is confirmed for Tuesday 20 November at 9:30\"." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "kind", "title", "quote", "confidence"],
    },
  },
  {
    name: "athena_renewal",
    description:
      "Record that something renews or expires, from a renewal or expiry notice: insurance, MOT, car tax, a passport, a licence, a warranty, a domain, a subscription. " +
      "It goes in Life admin, and Athena reminds the owner before the date (30, 7 and 0 days by default). The same thing again (by name, or the only one of its kind with that provider) moves its date on instead of adding another. " +
      "Never a policy, licence, passport or account number, and never a price. Returns created / updated / unchanged, or skipped when the owner archived it. Only for a clear date: below 0.8 confidence nothing is saved.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The email thread id it came from." },
        name: { type: "string", description: "What it is, the way the owner would say it: \"Car insurance\", \"Passport\", \"MOT\", \"Netflix\", \"athena.dev domain\"." },
        kind: { type: "string", enum: [...ASSET_KINDS] },
        provider: { type: "string", description: "Who it's with: \"Direct Line\", \"DVLA\", \"Namecheap\"." },
        renews_on: { type: "string", description: "The renewal or expiry date, YYYY-MM-DD." },
        quote: { type: "string", description: "The line that gives the date, e.g. \"Your policy renews on 3 January 2027\"." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "name", "kind", "renews_on", "quote", "confidence"],
    },
  },
  {
    name: "athena_alert",
    description:
      "Flag a security or account alert about the owner's own account: a new sign-in, a password or email address changed, a payment failed or a card declined, an account locked or suspended, a direct debit cancelled. " +
      "It becomes a to-do due today at the top of To do and the briefing, and any assistant watching for alerts is told. Not marketing, and not a sign-in code or reset the owner plainly asked for. " +
      "One per thread: the same thread again comes back already_recorded. confidence below 0.8 goes to the Review inbox.",
    input_schema: {
      type: "object",
      properties: {
        external_id: { type: "string", description: "The email thread id it came from." },
        service: { type: "string", description: "Whose account: \"Google\", \"Monzo\", \"PayPal\"." },
        title: { type: "string", description: "What to check, starting with a verb: \"Check the new sign-in to your Google account\", \"Update the card for Spotify\"." },
        quote: { type: "string", description: "The line that says it, e.g. \"We noticed a new sign-in to your account on a Windows device\"." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["external_id", "service", "title", "quote", "confidence"],
    },
  },
];

const MAX_WATCH_READ_PER_RUN = 300;

/** Watch & read (lib/watch-read-sync.ts), offered to the Life log and custom collections. */
const WATCH_READ_TOOL: Anthropic.Tool = {
  name: "athena_watch_read",
  description:
    "Put a film, TV show or book the owner watched, is watching, wants to watch, read, is reading or wants to read into their Watch & read list, with their rating as stars. " +
    "One call per title (a show, not each episode). Calling it again for the same title, from any source or run, updates the one item, so it's safe to repeat. " +
    "Pass the rating exactly as the source gives it (Letterboxd \"★★★★½ (4.5/5)\", Trakt \"8/10\", Goodreads \"4/5\"); Athena turns it into stars. Leave rating out when there is none. " +
    "Returns created / updated / unchanged, or skipped when the owner archived it. kept lists what the owner changed by hand, which sources never overwrite.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...SYNC_KINDS], description: "film, tv (a show, season or episode: give the show) or book." },
      title: { type: "string", description: "The film's, show's or book's title, as the source gives it." },
      maker: { type: "string", description: "The director or author, when the source says." },
      year: { type: "integer", description: "Release year, when the source says." },
      status: { type: "string", enum: ["queued", "reading", "done"], description: "done: watched or finished. reading: partway through (a show with episodes watched, a book on currently-reading, a paused film). queued: on a watchlist or to-read shelf." },
      rating: { type: "string", description: "The owner's rating as the source gives it. Leave out when unrated." },
      at: { type: "string", description: "When it was watched, finished, rated or added: YYYY-MM-DD or ISO 8601. Decides which source's rating is newer." },
      url: { type: "string", description: "The source's link for it." },
      external_id: { type: "string", description: "The source's id for the title (Trakt or Letterboxd slug, Goodreads book id)." },
      source: { type: "string", enum: [...SYNC_SOURCES] },
    },
    required: ["kind", "title", "status", "source"],
  },
};


/** Health figures: only from a health account (Strava, Oura, Withings, Whoop, Polar), and only through this tool (lib/health.ts). */
const HEALTH_DAY_TOOL: Anthropic.Tool = {
  name: "athena_health_day",
  description:
    "Save one day's health figures from a health account: sealed, never in a note or metric. One call per day per account; calling again for the same day merges, so reruns are safe. Athena writes the day's one Health line in the Life log itself. Send only the figures the source gives.",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "The day, YYYY-MM-DD in the owner's time zone." },
      source: { type: "string", enum: ["apple_health", "strava", "oura", "withings", "whoop", "polar"], description: "The account the figures come from." },
      sleep_minutes: { type: "number", description: "Minutes asleep the night that ended this morning." },
      sleep_stages: {
        type: "object",
        description: "The same night by stage, in minutes: deep, core (light), rem, awake, in_bed (the whole time in bed), asleep_unspecified (asleep with no stage). Send the ones the source gives.",
        properties: { deep: { type: "number" }, core: { type: "number" }, rem: { type: "number" }, awake: { type: "number" }, in_bed: { type: "number" }, asleep_unspecified: { type: "number" } },
      },
      steps: { type: "number" },
      active_minutes: { type: "number" },
      resting_hr: { type: "number", description: "Resting heart rate, beats per minute." },
      recovery: { type: "number", description: "Recovery score, 0–100 (Whoop), for the night ending that morning." },
      recharge: { type: "number", description: "Nightly Recharge status, 1–6 (Polar), for the night ending that morning." },
      workouts: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string", description: "run, ride, walk, swim, yoga, strength…" }, minutes: { type: "number" }, distance_m: { type: "number" }, kcal: { type: "number" } },
          required: ["type", "minutes"],
        },
      },
      weight_kg: { type: "number" },
    },
    required: ["date", "source"],
  },
};

const MAX_DAY_ENTRIES_PER_RUN = 2000;
const MAX_DAY_ENTRIES_PER_CALL = 100;

/** Days (lib/days.ts): what the Life log writes instead of day notes. Offered to the Life log and custom collections. */
const DAY_TOOLS: Anthropic.Tool[] = [
  {
    name: "athena_day_entry",
    description:
      "Save what the owner did on one day as entries: one per film, episode, album or artist session, book, game, post or saved item. Several in one call. " +
      "Saving the same source and external_id again updates that entry (and it keeps the day it was first saved on), so reruns are safe. " +
      "The same film, episode or book from two sources on one day is folded into one entry by Athena. " +
      "Entries are plain words, not Markdown: never put a link or [text](url) in title, subtitle or note; the item's link goes in url only. Returns created / updated / unchanged counts, and skipped for entries the owner hid.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "The day, YYYY-MM-DD in the owner's time zone." },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...DAY_ENTRY_KINDS] },
              source: { type: "string", description: "The service, lower case: trakt, letterboxd, plex, jellyfin, youtube, goodreads, readwise, spotify, lastfm, listenbrainz, steam, lichess, chesscom, reddit, bluesky, mastodon, raindrop, eventbrite." },
              external_id: { type: "string", description: "The source's own stable id for this item (history id, scrobble id plus time, post id, video id, book id)." },
              title: { type: "string", description: "The film, show, album, artist, book, game or post title. Plain words: no links or Markdown." },
              subtitle: { type: "string", description: "Who made it or which part: \"S2E3 · Who Is Alive?\", \"David Bowie\", \"David Grann\", the channel, the community." },
              at: { type: "string", description: "When it happened, ISO 8601 with offset, when the source says." },
              url: { type: "string", description: "The source's link for it (https://…). The only place a link goes." },
              rating: { type: "string", description: "The owner's rating exactly as the source gives it (\"★★★★½\", \"8/10\", \"4/5\"). Leave out when unrated." },
              count: { type: "integer", description: "How many: plays, episodes in a binge, highlights, games. Leave out for one." },
              minutes: { type: "integer", description: "Time spent, when the source gives durations." },
              hours: {
                type: "array",
                items: { type: "integer", minimum: 0 },
                minItems: 24,
                maxItems: 24,
                description: "Listened only: plays in each local hour 0-23 (24 numbers adding up to count), from each play's time when the source gives it (Last.fm, ListenBrainz). Leave out otherwise.",
              },
              group: { type: "string", description: "What groups entries on the day: the show for its episodes, the album for its tracks, the book for its highlights." },
              note: { type: "string", description: "A short extra in plain words: a quote from the owner's own review, \"rewatch\", \"paused at 40%\", \"3 wins, 1 loss\". Never a link." },
            },
            required: ["kind", "source", "external_id", "title"],
          },
        },
      },
      required: ["date", "entries"],
    },
  },
  {
    name: "athena_day_line",
    description:
      "Write the day's one line: a short, plain sentence on what the day had, in the owner's own terms (\"Finished Severance and started The Wager\"). Write it after the day's entries. " +
      "If the owner wrote or edited the line themselves, theirs stays and this returns owner_wrote_it. Never mention health figures or places.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD in the owner's time zone." }, line: { type: "string", description: "One sentence, at most 280 characters." } },
      required: ["date", "line"],
    },
  },
  {
    name: "athena_day_read",
    description: "Read what Athena already has for a day: its line and entries (kind, source, title, subtitle, count, minutes, note). Use it for a figure you need from an earlier day, like Steam's hours in total.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"] },
  },
];

/** The fields of each write tool that the model writes in its own words (not quotes or names from the source). */
const STYLED_FIELDS: Record<string, string[]> = {
  athena_save_note: ["title", "body"],
  athena_day_line: ["line"],
  athena_save_event: ["notes"],
  athena_catch_up: ["summary"],
  athena_todo: ["title"],
  athena_remember: ["value"],
  athena_trip_booking: ["details"],
  athena_purchase: ["detail"],
  athena_email_date: ["notes"],
  athena_alert: ["title"],
};

const inputs = {
  athena_search_notes: z.object({ query: z.string().min(1).max(200) }),
  athena_find: z.object({ query: z.string().max(200), kinds: z.array(z.enum(["person", "organisation", "project", "place", "event"])).optional() }),
  athena_save_note: z.object({
    external_id: z.string().min(1).max(500),
    title: z.string().min(1).max(300),
    body: z.string().max(20_000),
    type: z.enum(["note", "capture"]).optional(),
    tags: z.array(z.string().max(80)).max(20).optional(),
    date: DATE.optional(),
  }),
  athena_day_entry: z.object({ date: DATE, entries: z.array(z.record(z.unknown())).min(1) }),
  athena_day_line: z.object({ date: DATE, line: z.string().min(1).max(400) }),
  athena_day_read: z.object({ date: DATE }),
  athena_save_event: z
    .object({
      external_id: z.string().min(1).max(500),
      title: z.string().min(1).max(200),
      start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i, "ISO 8601 with Z or an offset")
        .optional(),
      end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i, "ISO 8601 with Z or an offset")
        .optional(),
      date: DATE.optional(),
      notes: z.string().max(1000).optional(),
      my_response: z.string().max(40).optional(),
      attendees: z
        .array(z.object({ name: z.string().max(200).optional(), email: z.string().max(320).optional() }))
        .max(100)
        .optional(),
    })
    .refine((e) => !!e.start !== !!e.date, "Give either start (timed) or date (all-day), not both"),
  athena_person: z.object({ name: z.string().min(1).max(200), email: z.string().max(320).optional() }),
  athena_project: z.object({ name: z.string().min(1).max(200) }),
  athena_organisation: z.object({ name: z.string().min(1).max(200) }),
  athena_link: z.object({ from_kind: RECORD_KIND, from_id: UUID, to_kind: RECORD_KIND, to_id: UUID, relation: z.string().regex(/^[a-z_]{2,40}$/) }),
  athena_watch_read: z.object({
    kind: z.enum(SYNC_KINDS),
    title: z.string().min(1).max(300),
    maker: z.string().max(200).optional(),
    year: z.number().int().optional(),
    status: z.enum(["queued", "reading", "done"]),
    rating: z.union([z.string().max(60), z.number()]).optional(),
    at: z.string().max(40).optional(),
    url: z.string().max(2000).optional(),
    external_id: z.string().max(300).optional(),
    source: z.enum(SYNC_SOURCES),
  }),
  athena_metric: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/, "lower_snake_case only"),
    value: z.number().finite(),
    day: DATE.optional(),
    window_start: z.string().optional(),
    window_end: z.string().optional(),
  }),
  athena_list_collected: z.object({ kind: z.enum(["note", "event"]), from: DATE, to: DATE }),
  athena_archive_collected: z.object({ kind: z.enum(["note", "event"]), external_id: z.string().min(1).max(500), reason: z.string().max(200) }),
  athena_catch_up: z.object({
    external_id: z.string().min(1).max(500),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i, "ISO 8601 with Z or an offset"),
    channel: z.enum(["meeting", "call", "message", "email", "in_person", "other"]),
    summary: z.string().min(1).max(300),
    person_ids: z.array(UUID).min(1).max(30),
  }),
  athena_todo: z
    .object({
      external_id: z.string().min(1).max(500),
      title: z.string().min(1).max(200),
      kind: z.enum(["i_owe", "todo", "waiting_on", "decision"]),
      person_id: UUID.optional(),
      due_on: DATE.optional(),
      quote: z.string().min(1).max(500),
      confidence: z.number().min(0).max(1),
      area: z.string().max(40).optional(),
      where: z.string().max(40).optional(),
      steps: z.array(z.string().max(300)).max(40).optional(),
    })
    .refine((t) => !(t.kind === "i_owe" || t.kind === "waiting_on") || !!t.person_id, "i_owe and waiting_on need the person_id"),
  athena_remember: z.object({
    external_id: z.string().min(1).max(500),
    person_id: UUID,
    key: z.string().min(1).max(60),
    value: z.string().min(1).max(300),
    quote: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }),
  athena_trip_booking: z.object({
    external_id: z.string().min(1).max(500),
    kind: z.enum(["flight", "train", "hotel", "car", "event", "other"]),
    status: z.enum(["confirmed", "changed", "cancelled"]).optional(),
    title: z.string().min(1).max(160),
    provider: z.string().max(120).optional(),
    reference: z.string().max(80),
    segment: z.string().max(60).optional(),
    start_local: z.string().min(10).max(40),
    start_tz: z.string().min(1).max(64),
    start_place: z.string().max(200).optional(),
    start_city: z.string().max(80).optional(),
    end_local: z.string().min(10).max(40).optional(),
    end_tz: z.string().max(64).optional(),
    end_place: z.string().max(200).optional(),
    end_city: z.string().max(80).optional(),
    seat: z.string().max(60).optional(),
    details: z.string().max(200).optional(),
    email_link: z.string().max(500).optional(),
    trip_destination: z.string().max(80).optional(),
    booking_id: UUID.optional(),
    quote: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }),
  athena_purchase: z
    .object({
      external_id: z.string().min(1).max(500),
      retailer: z.string().min(1).max(120),
      order_number: z.string().max(80).optional(),
      items: z.array(z.string().min(1).max(160)).max(30).optional(),
      ordered_on: DATE.optional(),
      status: z.enum(["ordered", "dispatched", "out_for_delivery", "delivered", "delayed", "returned", "refunded", "cancelled"]),
      status_at: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i, "ISO 8601 with Z or an offset")
        .optional(),
      expected_on: DATE.optional(),
      carrier: z.string().max(80).optional(),
      tracking_number: z.string().max(80).optional(),
      tracking_url: z.string().max(500).optional(),
      detail: z.string().max(200).optional(),
      email_link: z.string().max(500).optional(),
      purchase_id: UUID.optional(),
      quote: z.string().min(1).max(500),
      confidence: z.number().min(0).max(1),
    })
    .refine((p) => !!(p.purchase_id || p.order_number?.trim() || p.tracking_number?.trim()), "Give the order number (or, for a carrier's email, the tracking number)"),
  athena_email_date: z
    .object({
      external_id: z.string().min(1).max(500),
      part: z.string().max(80).optional(),
      kind: z.enum(["appointment", "deadline"]),
      title: z.string().min(1).max(200),
      start: z.string().regex(ISO_INSTANT, "ISO 8601 with Z or an offset").optional(),
      end: z.string().regex(ISO_INSTANT, "ISO 8601 with Z or an offset").optional(),
      date: DATE.optional(),
      notes: z.string().max(500).optional(),
      cancelled: z.boolean().optional(),
      quote: z.string().min(1).max(500),
      confidence: z.number().min(0).max(1),
    })
    .refine((d) => !!(d.start || d.date), "Give start (a timed appointment) or date (a deadline, or an appointment with no time)"),
  athena_renewal: z.object({
    external_id: z.string().min(1).max(500),
    name: z.string().min(1).max(120),
    kind: z.enum(ASSET_KINDS as unknown as [AssetKind, ...AssetKind[]]),
    provider: z.string().max(120).optional(),
    renews_on: DATE,
    quote: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }),
  athena_alert: z.object({
    external_id: z.string().min(1).max(500),
    service: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    quote: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  }),
};

/** Money doesn't belong in a booking or a purchase (SECURITY.md §1): refuse text that carries an amount. */
const MONEY = /(?:[£$€¥₹]\s?\d|\d[\d,.]*\s?(?:GBP|USD|EUR|JPY|CHF|AUD|CAD)\b|\b(?:GBP|USD|EUR)\s?\d)/i;

function refuseMoney(...texts: Array<string | undefined>): void {
  if (texts.some((t) => t && MONEY.test(t))) {
    throw new Error("Not saved: that includes a price or an amount of money. Leave money out (no prices, totals or card details) and save it again.");
  }
}

/** One run's write context: the collection's source and suffix are applied here, not by the model. Exported for tests. */
export class AthenaWriter {
  /** Writes already sent back once for breaking the writing style; a second try is saved as it is. */
  private readonly restyled = new Set<string>();
  /** Health accounts this run reads (their provider ids): athena_health_day is offered for these only. */
  healthSources: HealthSource[] = [];
  /** Sources the hourly check can write (media-sync.ts), on or off: this run's entries for things it or the history load already saved are left out. */
  hourlySources: ReadonlySet<string> = new Set();
  /** Sources Your activity writes whole for this Life log (activity-recent.ts): no entries from this run at all. */
  wholeSources: ReadonlySet<string> = new Set();
  /** Metrics Athena counts itself for this Life log (activity-metrics.ts): athena_metric refuses them. */
  countedMetrics: ReadonlySet<string> = new Set();
  /** A contacts account in this run (iCloud Contacts): people it links get their phone, birthday and company from it. */
  contacts?: ContactsDirectory;
  /** Calendar events seen in this run's tool results, by event id: where each lives and your answer (lib/rsvp.ts). */
  private readonly invites = new Map<string, CalendarInvite>();
  /** When each timed event seen in this run's calendar results ends, by event id: kept even if the model leaves the end out. */
  private readonly ends = new Map<string, string>();

  /** Read what a calendar tool returned (list_events, search_events, get_event) for each event's account, calendar and answer. */
  noteCalendarResult(connector: { id: string; provider: string }, args: Record<string, unknown>, text: string): void {
    if (connector.provider !== "google-calendar" && connector.provider !== "outlook-calendar" && connector.provider !== "icloud-calendar") return;
    let out: unknown;
    try {
      out = JSON.parse(text);
    } catch {
      return;
    }
    const o = out as { events?: unknown; id?: unknown };
    const events = Array.isArray(o?.events) ? o.events : o && typeof o.id === "string" ? [o] : [];
    const calendarId = typeof args.calendarId === "string" && args.calendarId ? args.calendarId : "primary";
    for (const e of events as Array<{ id?: unknown; myResponse?: unknown; calendarId?: unknown; end?: unknown; allDay?: unknown }>) {
      if (typeof e?.id === "string" && typeof e.end === "string" && e.allDay !== true && /T\d{2}:\d{2}/.test(e.end) && Number.isFinite(Date.parse(e.end))) this.ends.set(e.id, e.end);
      // A listing across several calendars says which one each event is on (calendar-choice.ts).
      const on = typeof e?.calendarId === "string" && e.calendarId ? e.calendarId : calendarId;
      if (typeof e?.id === "string") this.invites.set(e.id, { connectorId: connector.id, calendarId: on, eventId: e.id, answer: fromCalendar(e.myResponse) });
    }
  }

  constructor(
    private readonly collection: Collection,
    private readonly runId: string,
    private readonly stats: RunStats,
    private readonly now: Date,
    private readonly tz: string,
  ) {}

  /** The providers of this run's accounts ("linear", "gmail"): a Team event's connector (lib/team-events.ts). */
  providers: string[] = [];

  /**
   * A new item for Team's event triggers. The provider is the account's when there's one, else the one the item's id starts with.
   * `kind` names what email set off (a delivery, a booking, an alert…) where the provider alone can't; `email` marks anything that
   * came from mail, so a trigger on "an email arrives" still fires for it. `once`: not again for the same record and title (an
   * order's status, a booking's change), so a rerun doesn't fire it twice. Never throws.
   */
  private async teamEvent(
    stored: "note" | "event" | "todo" | "purchase" | "booking" | "asset",
    id: string,
    externalId: string,
    title: string,
    extra: { type?: string; tags?: string[]; kind?: string; once?: boolean } = {},
  ): Promise<void> {
    try {
      const unique = [...new Set(this.providers)];
      const connector = unique.length === 1 ? unique[0] : unique.find((p) => externalId.toLowerCase().startsWith(p.split("-")[0]));
      const kind = extra.kind ?? collectedKind(connector, stored === "note" || stored === "event" || stored === "todo" ? stored : "note", extra.type);
      const email = MAIL_PROVIDER.test(connector ?? "") || EMAIL_EVENT_KINDS.has(kind);
      if (extra.once) {
        const [seen] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM team_events WHERE ref_id = $1 AND facets->>'title' = $2`, [id, title.replace(/\s+/g, " ").trim().slice(0, 200)]);
        if (seen?.n) return;
      }
      await emitTeamEvent("collected", id, stored, { connector, kind, title, tags: extra.tags, account: this.collection.label, ...(email ? { email: true } : {}) });
    } catch (error) {
      console.error("Athena collect: couldn't note a Team event", (error as Error)?.message?.slice(0, 120));
    }
  }

  /** Email digest runs keep notes for reference mail only (recipes.ts step 9). Off when Ask saves one item the owner asked about. */
  notesForReferenceOnly = true;
  /** This run's appointments and deadlines, renewals and alerts from email. */
  private emailDates = 0;
  private renewals = 0;
  private alerts = 0;

  get metricSuffix(): string {
    const label = this.collection.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return label ? `_${label}` : "";
  }

  get tools(): Anthropic.Tool[] {
    return [
      // Work activity writes notes only: its counts come from the work sync (work-sync.ts), with no Claude.
      ...(this.collection.recipe === "work-activity" ? ATHENA_TOOLS.filter((t) => t.name !== "athena_metric") : ATHENA_TOOLS),
      ...(this.collection.lookahead_days > 0 ? [SAVE_EVENT_TOOL] : []),
      ...(this.readsEmail ? [...TRIP_TOOLS, RECEIPT_TOOL, ...EMAIL_TOOLS] : []),
      ...(this.healthSources.length ? [HEALTH_DAY_TOOL] : []),
      ...(this.keepsWatchRead ? [WATCH_READ_TOOL, ...DAY_TOOLS] : []),
    ];
  }

  /** Films, shows and books go into Watch & read: the Life log, and custom collections. */
  private get keepsWatchRead(): boolean {
    return this.collection.recipe === "life-log" || this.collection.recipe === "custom";
  }

  /** Booking and order emails become trips and purchases: the email digest, and custom collections (which may read anything). */
  private get readsEmail(): boolean {
    return this.collection.recipe === "email-digest" || this.collection.recipe === "custom";
  }

  private bump(key: "bookings_created" | "bookings_updated" | "purchases_created" | "purchases_updated"): void {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
  }

  /** A day a run may write: not in the future, and not more than MAX_DAYS_BACK ago. */
  private dayInWindow(date: string): void {
    const today = zonedToday(this.now, this.tz);
    if (date > today) throw new Error("That day hasn't happened yet.");
    if (date < addDays(today, -400)) throw new Error("That day is more than 400 days ago.");
  }

  /**
   * An email digest run's new note must be reference mail (recipes.ts step 9): not a receipt, an FYI or an action item, which have
   * their own tools or aren't kept, and only a few a run. Throws with where it goes instead, so the model can put it right.
   */
  private referenceNoteOnly(input: { type?: string; tags?: string[] }): void {
    if (this.collection.recipe !== "email-digest" || !this.notesForReferenceOnly) return;
    const why = (input.tags ?? []).map((t) => NOT_A_NOTE_TAGS[t.trim().toLowerCase().replace(/^#/, "")]).find(Boolean);
    if (why) throw new Error(`Not saved. ${why} A note is only for reference mail worth looking up later (tag it "reference").`);
    if (input.type === "capture") throw new Error("Not saved. A single receipt or confirmation isn't a note: use athena_purchase, athena_trip_booking, athena_receipt or athena_email_date, or skip it.");
    if (this.stats.notes_created >= MAX_EMAIL_NOTES_PER_RUN) throw new Error(`Not saved: an email digest keeps at most ${MAX_EMAIL_NOTES_PER_RUN} new notes a run, for reference mail only. Record the rest with the other tools or skip them.`);
  }

  private dismissed(): string {
    this.stats.skipped_dismissed++;
    return JSON.stringify({ action: "skipped", reason: "The owner archived or deleted what this item became. Leave it alone; don't save it again." });
  }

  /** Layer-2 records carry "<source>:<external_id>", so one collection's ids never collide with another's. */
  private ref(externalId: string): string {
    return `${this.collection.source}:${externalId}`;
  }

  /**
   * A meeting's note and its synced event are saved under the same calendar
   * event id: once both are here, link the note to the event, so the event
   * shows its notes and the note its meeting. Whichever is saved second does it.
   */
  private async linkMeeting(externalId: string): Promise<void> {
    const source = this.collection.source;
    const [note, event] = await Promise.all([getCollected(source, "note", externalId), getCollected(source, "event", externalId)]);
    if (note?.state !== "live" || event?.state !== "live") return;
    await linkEntities({ sourceType: "note", sourceId: note.record_id, targetType: "event", targetId: event.record_id, relation: "notes_for" });
  }

  /** A person's id, found by email or name (an email is added when they had none); added to People when `create`, otherwise null. */
  private async personFor(name: string, email: string | undefined, create: boolean): Promise<{ id: string; created: boolean } | null> {
    const found = await findEntityByName("person", name, email);
    if (found) {
      if (email) {
        const person = await getPerson(found);
        if (person && !person.email) await upsertPerson({ id: found, email });
      }
      await this.fromContacts(found, name, email);
      return { id: found, created: false };
    }
    if (!create) return null;
    const person = await upsertPerson({ name: name.trim(), email: email?.trim() });
    this.stats.people++;
    await this.fromContacts(person.id, name, email);
    return { id: person.id, created: true };
  }

  /** Fill a person in from the run's contacts account; a contacts problem never stops the run. */
  private async fromContacts(id: string, name: string, email: string | undefined): Promise<void> {
    await this.contacts?.fill(id, name, email).catch(() => []);
  }

  /**
   * Link the people on an invite to its event (relation "attendee"): what
   * the meeting push and the event's Linked list read. Newcomers are added
   * to People for meetings of up to MAX_NEW_ATTENDEES others; past that (an
   * all-hands) only people already in Athena are linked. Anyone since taken
   * off the invite is unlinked; other links on the event are left alone.
   * Returns how many people are linked.
   */
  private async linkAttendees(eventId: string, attendees: Array<{ name?: string; email?: string }>): Promise<number> {
    const seen = new Set<string>();
    const others = attendees.flatMap((a) => {
      const email = a.email?.trim().toLowerCase() || undefined;
      if (email && (!email.includes("@") || NOT_A_PERSON.test(email))) return [];
      const name = a.name?.trim() || (email ? nameFromEmail(email) : "");
      const key = email ?? name.toLowerCase();
      if (!name || seen.has(key)) return [];
      seen.add(key);
      return [{ name, email }];
    });
    const mayAdd = others.length <= MAX_NEW_ATTENDEES;
    const ids = new Set<string>();
    for (const a of others) {
      const person = await this.personFor(a.name, a.email, mayAdd && this.stats.people < MAX_PEOPLE_PER_RUN);
      if (person) ids.add(person.id);
    }
    const linked = (await getConnections("event", eventId)).filter(
      (e) => e.source_type === "event" && e.source_id === eventId && e.target_type === "person" && e.relation === "attendee",
    );
    for (const e of linked) {
      if (!ids.has(e.target_id)) await unlinkEntities({ sourceType: "event", sourceId: eventId, targetType: "person", targetId: e.target_id, relation: "attendee" });
    }
    for (const id of ids) await linkEntities({ sourceType: "event", sourceId: eventId, targetType: "person", targetId: id, relation: "attendee" });
    return ids.size;
  }

  /**
   * What an earlier run already recorded from this source item, so a rerun doesn't add reworded copies.
   * Titles and values are encrypted at rest (SECURITY.md §11): they come back opened and are joined here.
   */
  private async recordedFor(externalId: string): Promise<{ catch_up: boolean; todos: string[]; details: string[] }> {
    const ref = this.ref(externalId);
    const [catchUps, todos, details] = await Promise.all([
      q<{ n: number }>(`SELECT count(*)::int AS n FROM interactions WHERE source_ref = $1`, [ref]),
      q<{ title: string }>(`SELECT title FROM commitments WHERE source_ref = $1 ORDER BY created_at`, [ref]),
      q<{ key: string; value: string }>(`SELECT key, value FROM facts WHERE source_ref = $1 ORDER BY created_at`, [ref]),
    ]);
    return { catch_up: (catchUps[0]?.n ?? 0) > 0, todos: todos.map((t) => t.title), details: details.map((d) => `${d.key}: ${d.value}`) };
  }

  /** Send a find to the Review inbox; counted only when it's new (propose returns an existing match as is). */
  private async suggest(input: Parameters<typeof propose>[0]): Promise<string> {
    // Summaries are encrypted, so the ones filed for this op and source are compared here.
    const filed = await q<{ summary: string }>(`SELECT summary FROM suggestions WHERE op = $1 AND COALESCE(source_ref, '') = COALESCE($2, '')`, [
      input.op,
      input.source_ref ?? null,
    ]);
    const summary = input.summary.trim().replace(/\s+/g, " ").toLowerCase();
    const known = filed.some((f) => f.summary.toLowerCase() === summary);
    const s = await propose(input);
    if (!known) this.stats.suggestions++;
    return JSON.stringify({ suggestion_id: s.id, action: "sent_to_review_inbox" });
  }

  /**
   * How sure to be about a find. Jev reads the note saved for the same source
   * item and the quote, and gives a calibrated probability; that, not the
   * collecting model's own estimate, decides between the To do list and the
   * Review inbox. Without Jev, the model's estimate stands.
   */
  private async confidenceFor(externalId: string, quote: string, question: string, modelSays: number): Promise<number> {
    const prev = await getCollected(this.collection.source, "note", externalId);
    const note = prev ? await getNote(prev.record_id, { includeArchived: true }) : null;
    const p = await calibrated({ source_note: note ? `${note.title}\n\n${note.body}`.slice(0, 12_000) : null, quote }, question);
    return p ?? modelSays;
  }

  private async personName(id: string | undefined): Promise<string | null> {
    if (!id) return null;
    const [row] = await q<{ name: string }>(`SELECT name FROM people WHERE id = $1`, [id]);
    return row?.name ?? null;
  }

  /**
   * Send a write back once if it breaks NOTE_STYLE, so the model rewrites it.
   * Only once per item: a second attempt is saved as sent, so a false alarm
   * (or a name from the source that trips the check) never loses the record.
   */
  private checkStyle(name: string, raw: unknown): void {
    const fields = STYLED_FIELDS[name];
    if (!fields || !raw || typeof raw !== "object") return;
    const input = raw as Record<string, unknown>;
    const text = fields.map((f) => (typeof input[f] === "string" ? input[f] : "")).join("\n");
    const problems = styleProblems(text);
    if (!problems.length) return;
    const key = `${name}:${String(input.external_id ?? "")}`;
    if (this.restyled.has(key)) return;
    this.restyled.add(key);
    throw new Error(
      `Not saved yet: this breaks Athena's writing style (${problems.join(", ")}). Rewrite those parts and call ${name} again. ` +
        "Quotes and names copied from the source can stay as they are; if that's what tripped this, send it again unchanged.",
    );
  }

  async run(name: string, raw: unknown): Promise<string> {
    const source = this.collection.source;
    this.checkStyle(name, raw);
    switch (name) {
      case "athena_search_notes": {
        const { query } = inputs.athena_search_notes.parse(raw);
        const notes = await searchNotesByKeyword(query, 8);
        return JSON.stringify(
          notes.map((n) => ({ id: n.id, title: n.title, source: n.source, created_at: n.created_at, excerpt: withoutPlaces(withoutHealth(n.body)).slice(0, 240) })),
        );
      }
      case "athena_find": {
        const { query, kinds } = inputs.athena_find.parse(raw);
        return JSON.stringify(await searchEntities(query, { kinds, limit: 8 }));
      }
      case "athena_save_note": {
        const input = inputs.athena_save_note.parse(raw);
        // Days replace the Life log's day notes (lib/days.ts).
        if (/^life-log-/.test(input.external_id)) throw new Error("Life log days aren't notes any more. Save the day with athena_day_entry and its line with athena_day_line.");
        const prev = await getCollected(source, "note", input.external_id);
        if (prev && (prev.state === "deleted" || (prev.state === "archived" && !prev.archived_by_collector))) return this.dismissed();
        let id: string;
        let action: "created" | "updated" | "restored";
        if (prev) {
          if (prev.state === "archived") {
            await unarchiveEntity("note", prev.record_id);
            this.stats.restored++;
            action = "restored";
          } else action = "updated";
          await updateNote(prev.record_id, { title: input.title, body: input.body, tags: input.tags });
          this.stats.notes_updated++;
          id = prev.record_id;
        } else {
          if (this.stats.notes_created >= MAX_NOTES_PER_RUN) throw new Error(`Note limit for one run reached (${MAX_NOTES_PER_RUN}). Finish with your summary.`);
          this.referenceNoteOnly(input);
          const note = await createNote({ title: input.title, body: input.body, type: input.type ?? "note", source, tags: input.tags ?? [] });
          this.stats.notes_created++;
          id = note.id;
          action = "created";
        }
        await recordCollected({ source, kind: "note", externalId: input.external_id, recordId: id, title: input.title, itemDate: input.date, runId: this.runId });
        if (action === "created") await this.teamEvent("note", id, input.external_id, input.title, { type: input.type, tags: input.tags });
        await this.linkMeeting(input.external_id);
        // Seen before: say what's already recorded from it, so to-dos and details aren't added twice.
        if (action !== "created") return JSON.stringify({ id, action, already_recorded: await this.recordedFor(input.external_id) });
        return JSON.stringify({ id, action });
      }
      case "athena_day_entry": {
        if (!this.keepsWatchRead) throw new Error("This collection doesn't write days.");
        const { date, entries } = inputs.athena_day_entry.parse(raw);
        this.dayInWindow(date);
        if (entries.length > MAX_DAY_ENTRIES_PER_CALL) throw new Error(`At most ${MAX_DAY_ENTRIES_PER_CALL} entries per call. Send the rest in another call.`);
        if ((this.stats.entries_created ?? 0) + (this.stats.entries_updated ?? 0) + entries.length > MAX_DAY_ENTRIES_PER_RUN) throw new Error("Entry limit for one run reached. Finish with your summary.");
        const checked: Array<{ date: string; entry: EntryInput }> = [];
        const refused: string[] = [];
        entries.forEach((e, i) => {
          try {
            checked.push({ date, entry: readEntry(e) });
          } catch (error) {
            refused.push(`entry ${i + 1}: ${(error as Error).message}`);
          }
        });
        // Already in Days from the hourly check: never a second copy under this run's own ids.
        let repeats = checked.filter((c) => this.wholeSources.has(c.entry.source)).length;
        let toWrite = checked.filter((c) => !this.wholeSources.has(c.entry.source));
        if (checked.some((c) => this.hourlySources.has(c.entry.source))) {
          const d = dropRepeats(toWrite, await notFromRuns(date, this.hourlySources), this.hourlySources);
          toWrite = d.keep;
          repeats += d.dropped;
          await addRatings(d.ratings, date);
        }
        const r = await writeEntries(toWrite, { collection: source, runId: this.runId });
        this.stats.entries_created = (this.stats.entries_created ?? 0) + r.created;
        this.stats.entries_updated = (this.stats.entries_updated ?? 0) + r.updated;
        this.stats.skipped_dismissed += r.skipped;
        return JSON.stringify({ date, created: r.created, updated: r.updated, unchanged: r.unchanged + repeats, skipped: r.skipped, folded: r.folded, ...(repeats ? { already_in_days: repeats } : {}), ...(refused.length ? { refused } : {}) });
      }
      case "athena_day_line": {
        if (!this.keepsWatchRead) throw new Error("This collection doesn't write days.");
        const { date, line } = inputs.athena_day_line.parse(raw);
        this.dayInWindow(date);
        const result = await setRunLine(date, line, this.runId);
        if (result === "saved") this.stats.day_lines = (this.stats.day_lines ?? 0) + 1;
        return JSON.stringify({ date, result });
      }
      case "athena_day_read": {
        if (!this.keepsWatchRead) throw new Error("This collection doesn't write days.");
        const { date } = inputs.athena_day_read.parse(raw);
        // No health, places, mood or journal: a run never sees them.
        const day = await getDay(date, { tz: this.tz, health: false, places: false, private: false });
        if (!day) throw new Error("date: YYYY-MM-DD");
        return JSON.stringify({
          date,
          line: day.line ?? null,
          entries: day.entries.map((e) => ({ kind: e.kind, source: e.source, title: e.title, subtitle: e.subtitle, count: e.count, minutes: e.minutes, note: e.note })),
        });
      }
      case "athena_save_event": {
        if (this.collection.lookahead_days <= 0) throw new Error("This collection doesn't sync upcoming events.");
        const input = inputs.athena_save_event.parse(raw);
        const today = zonedToday(this.now, this.tz);
        const last = addDays(today, this.collection.lookahead_days);
        const day = input.start ? zonedParts(new Date(input.start), this.tz).date : input.date!;
        if (day < addDays(today, -1) || day > last) {
          throw new Error(`Only events from today to ${last} are synced. Skip this one.`);
        }
        const prev = await getCollected(source, "event", input.external_id);
        if (prev && (prev.state === "deleted" || (prev.state === "archived" && !prev.archived_by_collector))) return this.dismissed();
        // Timed: stored as the UTC instant. All-day: a plain date.
        const fields = {
          title: input.title,
          ...(input.start ? { starts_at: input.start, ends_at: input.end ?? this.ends.get(input.external_id) } : { date: input.date!, starts_at: null }),
          notes: input.notes ?? "",
          source,
          timed_push: this.collection.event_push,
          tz: this.tz,
        };
        let id: string;
        let action: "created" | "updated" | "restored";
        // The same meeting under another id (lib/event-twins.ts): on two calendars, read by two collections, or an
        // edited occurrence. It joins the event already saved instead of becoming a second one.
        const twin = await eventTwin({ title: input.title, starts_at: input.start ?? null, date: input.date ?? null, ...(prev ? { not: prev.record_id, olderThan: prev.record_id } : {}) });
        if (twin) {
          // Saved twice before this rule: the later copy goes, and this id points at the first.
          if (prev && prev.state === "live") await archiveEntity("event", prev.record_id);
          id = twin.id;
          action = "updated";
          this.stats.events_updated++;
        } else if (prev) {
          if (prev.state === "archived") {
            await unarchiveEntity("event", prev.record_id);
            this.stats.restored++;
            action = "restored";
          } else action = "updated";
          // Your own reminder settings on the event are kept; what the calendar owns is refreshed.
          await upsertEvent({ id: prev.record_id, ...fields });
          this.stats.events_updated++;
          id = prev.record_id;
        } else {
          if (this.stats.events_created >= MAX_EVENTS_PER_RUN) throw new Error("Event limit for one run reached. Finish with your summary.");
          const event = await upsertEvent({ ...fields, kind: "appointment", recurrence: "none", remind_days_before: [0] });
          this.stats.events_created++;
          id = event.id;
          action = "created";
        }
        await recordCollected({ source, kind: "event", externalId: input.external_id, recordId: id, title: input.title, itemDate: day, runId: this.runId });
        if (action === "created") await this.teamEvent("event", id, input.external_id, input.title);
        // Your answer and where to send it: from the calendar's own result when this run read it, else as the model gave it.
        // A joined event keeps the invite it was first saved with: its answer goes back to that calendar.
        const invite = twin ? undefined : this.invites.get(input.external_id);
        if (invite) await syncRsvp(id, invite);
        else if (input.my_response && !twin) await syncAnswerOnly(id, fromCalendar(input.my_response));
        await this.linkMeeting(input.external_id);
        const people = input.attendees ? await this.linkAttendees(id, input.attendees) : undefined;
        return JSON.stringify({ id, action, ...(people === undefined ? {} : { people }) });
      }
      case "athena_list_collected": {
        const { kind, from, to } = inputs.athena_list_collected.parse(raw);
        const items = await listCollected(source, kind, from, to);
        // How many people each event links, so one saved before attendees were passed shows up as 0.
        const people =
          kind === "event"
            ? new Map(
                (
                  await q<{ id: string; n: number }>(
                    `SELECT source_id AS id, count(*)::int AS n FROM edges
                     WHERE source_type = 'event' AND target_type = 'person' AND relation = 'attendee' AND source_id = ANY($1::uuid[])
                     GROUP BY source_id`,
                    [items.map((i) => i.record_id)],
                  )
                ).map((r) => [r.id, r.n]),
              )
            : null;
        return JSON.stringify(
          items.map((i) => ({ external_id: i.external_id, title: i.title, date: i.item_date, state: i.state, ...(people ? { people: people.get(i.record_id) ?? 0 } : {}) })),
        );
      }
      case "athena_archive_collected": {
        const { kind, external_id, reason } = inputs.athena_archive_collected.parse(raw);
        const prev = await getCollected(source, kind, external_id);
        if (!prev || prev.state !== "live") return JSON.stringify({ action: "nothing to archive" });
        if (this.stats.archived >= MAX_ARCHIVES_PER_RUN) throw new Error("Archive limit for one run reached; leave the rest for the next run.");
        await archiveEntity(kind, prev.record_id);
        await setArchivedByCollector(source, kind, external_id, true);
        this.stats.archived++;
        return JSON.stringify({ action: "archived", title: prev.title, reason });
      }
      case "athena_catch_up": {
        const input = inputs.athena_catch_up.parse(raw);
        const ref = this.ref(input.external_id);
        // An archived catch-up is the owner saying "not this one": leave it.
        const [prev] = await q<{ id: string; archived: boolean }>(
          `SELECT id, archived_at IS NOT NULL AS archived FROM interactions WHERE source_ref = $1 ORDER BY archived_at NULLS FIRST LIMIT 1`,
          [ref],
        );
        if (prev?.archived) return this.dismissed();
        const saved = await logInteraction({
          id: prev?.id,
          at: new Date(input.at).toISOString(),
          channel: input.channel,
          summary: input.summary,
          person_ids: [...new Set(input.person_ids)],
          source,
          source_ref: ref,
        });
        if (!prev) this.stats.catch_ups++;
        return JSON.stringify({ id: saved.id, action: prev ? "updated" : "created" });
      }
      case "athena_todo": {
        const input = inputs.athena_todo.parse(raw);
        const ref = this.ref(input.external_id);
        const title = input.title.trim();
        // Found again (this item re-read and the to-do reworded, or the same meeting under another id, a
        // Granola note's then its calendar event's): never filed twice, and one the owner finished, dropped
        // or archived never comes back. Titles and quotes are encrypted: they're compared here.
        const filed = await q<FiledCommitment>(
          `SELECT id, title, source_quote, kind, person_id, source_ref, status, archived_at IS NOT NULL AS archived FROM commitments
           WHERE source_ref = $1 OR (source = $2 AND created_at > now() - interval '21 days')
           ORDER BY created_at`,
          [ref, source],
        );
        const next = { title, quote: input.quote, kind: input.kind, person_id: input.person_id ?? null };
        const same = filed.find((c) => sameCommitment(c, next, c.source_ref === ref));
        if (same?.archived) return this.dismissed();
        if (same) return JSON.stringify({ id: same.id, action: "already_recorded", status: same.status });
        // The context follows this collection's account (Work, Personal), then the words; the model's guess only when it's sure.
        const context = { label: this.collection.label, suggestion: { area: input.area, where: input.where, sure: input.confidence >= 0.8 } };
        // Steps only for a to-do, and only a list of its own parts (lib/todo-details.ts filedSteps).
        const steps = input.kind === "decision" ? [] : filedSteps(title, input.steps);
        const fields = { title, kind: input.kind, person_id: input.person_id ?? null, due_on: input.due_on ?? null, context, ...(steps.length ? { steps } : {}) };
        const who = await this.personName(input.person_id);
        const question = {
          i_owe: `Did the owner (the person whose notes these are) clearly commit to "${title}"${who ? ` for ${who}` : ""}?`,
          todo: `Did the owner (the person whose notes these are) clearly commit to "${title}"?`,
          waiting_on: `Did ${who ?? "someone else"} clearly commit to doing "${title}" for the owner?`,
          decision: `Was "${title}" clearly decided, rather than only discussed?`,
        }[input.kind];
        const confidence = await this.confidenceFor(input.external_id, input.quote, question, input.confidence);
        const provenance = { source, source_ref: ref, source_quote: input.quote, confidence };
        if (confidence < REVIEW_BELOW) {
          const lead = { i_owe: who ? `For ${who}` : "To do", todo: "To do", waiting_on: who ? `Waiting on ${who}` : "Waiting on", decision: "Decision" }[input.kind];
          // A suggestion the owner already dismissed comes back as itself (propose dedupes), so it isn't re-asked.
          return this.suggest({ op: "commitment", summary: `${lead}: ${title}${steps.length ? ` (${steps.length} steps)` : ""}`, payload: fields, ...provenance });
        }
        const saved = await upsertCommitment({ ...fields, ...provenance });
        this.stats.todos++;
        await this.teamEvent("todo", saved.id, input.external_id, title, { kind: "todo" });
        // Say when offered steps weren't kept, so the model doesn't retry them as something else.
        const dropped = input.steps?.length && !steps.length ? { steps: "not kept: a to-do's steps are two or more of its own parts; file separate actions as their own to-dos" } : {};
        return JSON.stringify({ id: saved.id, action: "created", ...(steps.length ? { steps: steps.length } : {}), ...dropped });
      }
      case "athena_remember": {
        const input = inputs.athena_remember.parse(raw);
        const ref = this.ref(input.external_id);
        const key = input.key.trim();
        const value = input.value.trim();
        // Keys are plain, values encrypted: narrow by key in SQL, compare the value here.
        const sameKey = await q<{ id: string; value: string; archived: boolean }>(
          `SELECT id, value, archived_at IS NOT NULL AS archived FROM facts
           WHERE subject_kind = 'person' AND subject_id = $1 AND lower(key) = lower($2)
             AND (archived_at IS NOT NULL OR superseded_at IS NULL)
           ORDER BY archived_at NULLS LAST`,
          [input.person_id, key],
        );
        const known = sameKey.find((f) => f.value.toLowerCase() === value.toLowerCase());
        if (known?.archived) return this.dismissed();
        if (known) return JSON.stringify({ id: known.id, action: "already_recorded" });
        const who = (await this.personName(input.person_id)) ?? "Someone";
        const confidence = await this.confidenceFor(
          input.external_id,
          input.quote,
          `Is "${key}: ${value}" a lasting detail about ${who}, stated as fact rather than a guess, a plan or a joke?`,
          input.confidence,
        );
        const provenance = { source, source_ref: ref, source_quote: input.quote, confidence };
        const fact = { subject_kind: "person" as const, subject_id: input.person_id, key, value };
        if (confidence < REVIEW_BELOW) {
          return this.suggest({ op: "fact", summary: `${who}: ${key} — ${value}`, payload: fact, ...provenance });
        }
        const saved = await addFact({ ...fact, ...provenance });
        this.stats.details++;
        return JSON.stringify({ id: saved.id, action: "saved" });
      }
      case "athena_trip_booking": {
        if (!this.readsEmail) throw new Error("This collection doesn't save bookings.");
        const input = inputs.athena_trip_booking.parse(raw);
        refuseMoney(input.title, input.details, input.seat, input.quote);
        const { external_id, quote, confidence: modelSays, ...fields } = input;
        const ref = this.ref(external_id);
        const label = `${BOOKING_LABEL[fields.kind].label}: ${fields.title}${fields.reference ? `, ref ${fields.reference}` : ""}`;
        const confidence = await this.confidenceFor(
          external_id,
          quote,
          `Does this confirm a ${BOOKING_LABEL[fields.kind].label.toLowerCase()} booking the owner has made (not an advert, a price quote or someone else's booking)?`,
          modelSays,
        );
        if (confidence < REVIEW_BELOW) {
          return this.suggest({ op: "booking", summary: `${label} · ${fields.start_local.slice(0, 10)}`, payload: fields, source, source_ref: ref, source_quote: quote, confidence });
        }
        if ((this.stats.bookings_created ?? 0) - (this.stats.tripit_bookings ?? 0) >= MAX_BOOKINGS_PER_RUN) throw new Error("Booking limit for one run reached. Finish with your summary.");
        const saved = await saveBooking({ ...fields, source, source_ref: ref, confidence });
        if (saved.action === "skipped") {
          this.stats.skipped_dismissed++;
          return JSON.stringify({ action: "skipped", reason: `${saved.reason} Leave it alone.`, same_reference: saved.same_reference });
        }
        this.bump(saved.action === "created" ? "bookings_created" : "bookings_updated");
        const b = saved.booking!;
        const how = b.status === "cancelled" ? "cancelled" : b.status === "changed" ? "changed" : saved.action === "created" ? "booked" : "updated";
        await this.teamEvent("booking", b.id, external_id, `${BOOKING_LABEL[fields.kind].label} ${how}: ${fields.title}`, { kind: "booking", tags: [how, fields.kind], once: true });
        return JSON.stringify({
          id: saved.booking!.id,
          action: saved.action,
          status: saved.booking!.status,
          trip: saved.trip ? { id: saved.trip.id, name: tripLabel(saved.trip, zonedToday(this.now, this.tz)) } : null,
          same_reference: saved.same_reference,
        });
      }
      case "athena_purchase": {
        if (!this.readsEmail) throw new Error("This collection doesn't save purchases.");
        const input = inputs.athena_purchase.parse(raw);
        refuseMoney(...(input.items ?? []), input.detail, input.quote);
        const { external_id, quote, confidence: modelSays, ...fields } = input;
        const ref = this.ref(external_id);
        const confidence = await this.confidenceFor(
          external_id,
          quote,
          `Is this about an order the owner placed (its confirmation or a delivery update), rather than an advert?`,
          modelSays,
        );
        if (confidence < REVIEW_BELOW) {
          const summary = `${PURCHASE_LABEL[fields.status]}: ${purchaseName({ retailer: fields.retailer, items: fields.items ?? [] })}`;
          return this.suggest({ op: "purchase", summary, payload: fields, source, source_ref: ref, source_quote: quote, confidence });
        }
        if ((this.stats.purchases_created ?? 0) >= MAX_PURCHASES_PER_RUN) throw new Error("Purchase limit for one run reached. Finish with your summary.");
        const saved = await savePurchase({ ...fields, source, source_ref: ref, confidence });
        if (saved.action === "skipped") {
          this.stats.skipped_dismissed++;
          return JSON.stringify({ action: "skipped", reason: `${saved.reason} Leave it alone.` });
        }
        if (saved.action === "restored") this.stats.restored++;
        this.bump(saved.action === "created" ? "purchases_created" : "purchases_updated");
        const p = saved.purchase!;
        // Only when the order moved to what this email says: an older email that only joins the timeline sets nothing off.
        if (p.status === fields.status) {
          await this.teamEvent("purchase", p.id, external_id, `${PURCHASE_LABEL[p.status]}: ${purchaseName(p)}`, { kind: "delivery", tags: [p.status, ...(fields.retailer ? [fields.retailer] : [])], once: true });
        }
        return JSON.stringify({ id: p.id, action: saved.action, status: p.status, name: purchaseName(p) });
      }
      case "athena_receipt": {
        if (!this.readsEmail) throw new Error("This collection doesn't save receipts.");
        const input = receiptInput.parse(raw);
        const email = { id: input.external_id, from: input.from, subject: input.subject, date: input.date, text: input.text };
        const saved = await saveReceipt(email, { tz: this.tz, source, sourceRef: this.ref(input.external_id), runId: this.runId });
        if (saved.entry?.action === "created") this.stats.entries_created = (this.stats.entries_created ?? 0) + 1;
        if (saved.entry?.action === "updated") this.stats.entries_updated = (this.stats.entries_updated ?? 0) + 1;
        if (saved.purchase?.action === "created" || saved.purchase?.action === "updated") this.bump(saved.purchase.action === "created" ? "purchases_created" : "purchases_updated");
        return JSON.stringify(saved);
      }
      case "athena_email_date": {
        if (!this.readsEmail) throw new Error("This collection doesn't save dates from email.");
        const input = inputs.athena_email_date.parse(raw);
        refuseMoney(input.title, input.notes);
        const externalId = input.part ? `${input.external_id}#${input.part.trim().toLowerCase().replace(/\s+/g, "-")}` : input.external_id;
        const ref = this.ref(externalId);
        const prev = await getCollected(source, "event", externalId);
        if (prev && (prev.state === "deleted" || (prev.state === "archived" && !prev.archived_by_collector))) return this.dismissed();
        if (input.cancelled) {
          if (prev?.state !== "live") return JSON.stringify({ action: "nothing to cancel" });
          await archiveEntity("event", prev.record_id);
          await setArchivedByCollector(source, "event", externalId, true);
          this.stats.archived++;
          await this.teamEvent("event", prev.record_id, input.external_id, `Cancelled: ${input.title}`, { kind: input.kind, tags: ["cancelled"], once: true });
          return JSON.stringify({ id: prev.record_id, action: "archived", reason: "cancelled" });
        }
        const day = input.start ? zonedParts(new Date(input.start), this.tz).date : input.date!;
        if (day < zonedToday(this.now, this.tz)) return JSON.stringify({ action: "not_saved", reason: "That date has passed. Skip it." });
        const fields = {
          title: input.title,
          kind: input.kind,
          ...(input.start ? { starts_at: input.start, ends_at: input.end ?? null } : { date: input.date!, starts_at: null }),
          notes: input.notes ?? "",
          source,
          tz: this.tz,
          // A timed appointment gets its push before it starts; a deadline is a date, with a nudge a few days ahead.
          timed_push: !!input.start,
          recurrence: "none" as const,
          remind_days_before: input.kind === "deadline" ? [3, 0] : [1, 0],
        };
        const label = input.kind === "deadline" ? "Deadline" : "Appointment";
        const confidence = await this.confidenceFor(
          input.external_id,
          input.quote,
          `Does this email set a ${label.toLowerCase()} the owner has on ${day} (not an advert, an offer to book, or someone else's)?`,
          input.confidence,
        );
        if (confidence < REVIEW_BELOW) {
          return this.suggest({ op: "event", summary: `${label}: ${input.title} · ${day}`, payload: fields, source, source_ref: ref, source_quote: input.quote, confidence });
        }
        let id: string;
        let action: "created" | "updated" | "restored" | "joined";
        if (prev) {
          if (prev.state === "archived") {
            await unarchiveEntity("event", prev.record_id);
            this.stats.restored++;
            action = "restored";
          } else action = "updated";
          // The owner's own reminder settings stay; what the email says is refreshed.
          const { remind_days_before: _keep, ...changed } = fields;
          await upsertEvent({ id: prev.record_id, ...changed });
          this.stats.events_updated++;
          id = prev.record_id;
        } else {
          // Already on the calendar (the same title at the same time): this email joins it.
          const twin = await eventTwin({ title: input.title, starts_at: input.start ?? null, date: input.date ?? null });
          if (twin) {
            id = twin.id;
            action = "joined";
          } else {
            if (this.emailDates >= MAX_EMAIL_DATES_PER_RUN) throw new Error("Limit for appointments and deadlines in one run reached. Finish with your summary.");
            id = (await upsertEvent(fields)).id;
            this.emailDates++;
            this.stats.events_created++;
            action = "created";
          }
        }
        await recordCollected({ source, kind: "event", externalId, recordId: id, title: input.title, itemDate: day, runId: this.runId });
        if (action === "created" || action === "updated") {
          await this.teamEvent("event", id, input.external_id, `${label}: ${input.title} · ${day}`, { kind: input.kind, once: true });
        }
        return JSON.stringify({ id, action, date: day });
      }
      case "athena_renewal": {
        if (!this.readsEmail) throw new Error("This collection doesn't save renewals.");
        const input = inputs.athena_renewal.parse(raw);
        // The quote isn't kept, so only what's stored is checked.
        refuseMoney(input.name, input.provider);
        if (ID_NUMBER.test(input.name) || ID_NUMBER.test(input.provider ?? "")) {
          throw new Error("Not saved: that looks like a policy, licence, passport or account number. Name what it is and who it's with, without the number.");
        }
        const today = zonedToday(this.now, this.tz);
        if (input.renews_on < addDays(today, -60)) return JSON.stringify({ action: "not_saved", reason: "That date is long past. Skip it." });
        const confidence = await this.confidenceFor(
          input.external_id,
          input.quote,
          `Does this email say the owner's ${input.name} renews or expires on ${input.renews_on} (not an advert or a quote for something they don't have)?`,
          input.confidence,
        );
        if (confidence < REVIEW_BELOW) return JSON.stringify({ action: "not_saved", reason: "Not sure enough of the date. Mention it in your summary instead." });
        const found = await findAsset({ name: input.name, kind: input.kind, provider: input.provider });
        if (found?.archived_at) return this.dismissed();
        const title = `${found?.name ?? input.name} ${input.renews_on < today ? "expired" : "renews"} ${input.renews_on}`;
        if (found) {
          // A reminder about the old date, arriving after the owner moved it on, changes nothing.
          if (found.renews_on && found.renews_on >= input.renews_on) return JSON.stringify({ id: found.id, action: "unchanged", renews_on: found.renews_on });
          await upsertAsset({ id: found.id, renews_on: input.renews_on, ...(found.provider ? {} : input.provider ? { provider: input.provider } : {}) });
          this.stats.renewals_updated = (this.stats.renewals_updated ?? 0) + 1;
          await this.teamEvent("asset", found.id, input.external_id, title, { kind: "renewal", tags: [input.kind], once: true });
          return JSON.stringify({ id: found.id, action: "updated", name: found.name, renews_on: input.renews_on });
        }
        if (this.renewals >= MAX_RENEWALS_PER_RUN) throw new Error("Renewal limit for one run reached. Finish with your summary.");
        const asset = await upsertAsset({ name: input.name, kind: input.kind, provider: input.provider ?? "", renews_on: input.renews_on });
        this.renewals++;
        this.stats.renewals_created = (this.stats.renewals_created ?? 0) + 1;
        await this.teamEvent("asset", asset.id, input.external_id, title, { kind: "renewal", tags: [input.kind], once: true });
        return JSON.stringify({ id: asset.id, action: "created", name: asset.name, renews_on: asset.renews_on });
      }
      case "athena_alert": {
        if (!this.readsEmail) throw new Error("This collection doesn't save alerts.");
        const input = inputs.athena_alert.parse(raw);
        refuseMoney(input.title);
        const ref = `${this.ref(input.external_id)}#alert`;
        const [prev] = await q<{ id: string; status: string; archived: boolean }>(
          `SELECT id, status, archived_at IS NOT NULL AS archived FROM commitments WHERE source_ref = $1 ORDER BY created_at LIMIT 1`,
          [ref],
        );
        if (prev?.archived) return this.dismissed();
        if (prev) return JSON.stringify({ id: prev.id, action: "already_recorded", status: prev.status });
        const title = input.title.trim();
        const confidence = await this.confidenceFor(
          input.external_id,
          input.quote,
          `Is this a real security or account alert about the owner's own ${input.service} account (not marketing, and not a code or reset they plainly asked for)?`,
          input.confidence,
        );
        const fields = { title, kind: "todo" as const, person_id: null, due_on: zonedToday(this.now, this.tz), context: { label: this.collection.label, suggestion: { sure: false } } };
        const provenance = { source, source_ref: ref, source_quote: input.quote, confidence };
        if (confidence < REVIEW_BELOW) return this.suggest({ op: "commitment", summary: `Alert: ${title}`, payload: fields, ...provenance });
        if (this.alerts >= MAX_ALERTS_PER_RUN) throw new Error("Alert limit for one run reached. Finish with your summary.");
        const saved = await upsertCommitment({ ...fields, ...provenance });
        this.alerts++;
        this.stats.todos++;
        this.stats.alerts = (this.stats.alerts ?? 0) + 1;
        await this.teamEvent("todo", saved.id, input.external_id, `${input.service}: ${title}`, { kind: "alert", tags: [input.service] });
        await alertPush(ref, title, this.tz);
        return JSON.stringify({ id: saved.id, action: "created" });
      }
      case "athena_person": {
        const { name: personName, email } = inputs.athena_person.parse(raw);
        return JSON.stringify(await this.personFor(personName, email, true));
      }
      case "athena_project": {
        const { name: projectName } = inputs.athena_project.parse(raw);
        const found = await findEntityByName("project", projectName);
        if (found) return JSON.stringify({ id: found, created: false });
        return JSON.stringify({ id: (await upsertProject({ name: projectName.trim() })).id, created: true });
      }
      case "athena_organisation": {
        const { name: orgName } = inputs.athena_organisation.parse(raw);
        const found = await findEntityByName("organisation", orgName);
        if (found) return JSON.stringify({ id: found, created: false });
        return JSON.stringify({ id: (await upsertOrganisation({ name: orgName.trim() })).id, created: true });
      }
      case "athena_link": {
        const l = inputs.athena_link.parse(raw);
        const edge = await linkEntities({ sourceType: l.from_kind, sourceId: l.from_id, targetType: l.to_kind, targetId: l.to_id, relation: l.relation });
        return JSON.stringify({ linked: !!edge });
      }
      case "athena_watch_read": {
        if (!this.keepsWatchRead) throw new Error("This collection doesn't save to Watch & read.");
        const input = inputs.athena_watch_read.parse(raw);
        if ((this.stats.watch_read_created ?? 0) + (this.stats.watch_read_updated ?? 0) >= MAX_WATCH_READ_PER_RUN) throw new Error("Watch & read limit for one run reached. Finish with your summary.");
        const [r] = await syncWatchRead([input], { collection: source, now: this.now });
        if (r.action === "created") this.stats.watch_read_created = (this.stats.watch_read_created ?? 0) + 1;
        if (r.action === "updated") this.stats.watch_read_updated = (this.stats.watch_read_updated ?? 0) + 1;
        if (r.action === "skipped") this.stats.skipped_dismissed++;
        return JSON.stringify(r);
      }
      case "athena_metric": {
        if (this.collection.recipe === "work-activity") throw new Error("Work activity doesn't write metrics: Athena counts issues and pull requests itself.");
        const m = inputs.athena_metric.parse(raw);
        const base = m.name.endsWith(this.metricSuffix) && this.metricSuffix ? m.name.slice(0, -this.metricSuffix.length) : m.name;
        if (this.countedMetrics.has(base)) return JSON.stringify({ recorded: null, reason: `Athena counts ${base} itself from Your activity. Don't send it.` });
        if (this.stats.metrics >= MAX_METRICS_PER_RUN) throw new Error("Metric limit for one run reached.");
        const today = zonedToday(this.now, this.tz);
        const day = m.day ?? today;
        if (day > today || day < addDays(today, -14)) throw new Error("A metric's day must be within the last two weeks.");
        const metric = m.name.endsWith(this.metricSuffix) ? m.name : `${m.name}${this.metricSuffix}`;
        await replaceDailyMetric({ metric, value: m.value, day, source, tz: this.tz, metadata: { run_id: this.runId, window_start: m.window_start, window_end: m.window_end } });
        this.stats.metrics++;
        return JSON.stringify({ recorded: metric, day });
      }
      case "athena_health_day": {
        const day = readHealthDay(raw, { today: zonedToday(this.now, this.tz) });
        if (!this.healthSources.includes(day.source)) throw new Error(`This collection doesn't read ${day.source}. Only send figures from its own health accounts.`);
        const saved = await saveHealthDay(day, { now: this.now, tz: this.tz, ...(this.collection.recipe === "life-log" ? { lifeLogSource: source } : {}) });
        // No figures back: the run's summary must never carry them.
        return JSON.stringify({ saved: true, date: saved.date, source: saved.source, changed: saved.changed });
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }
}

// ---------- Source tools ----------

interface SourceTool {
  open: OpenConnector;
  mcpName: string;
}

const toolSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** "gmail_work__search_threads": account prefix + MCP tool name, within the API's 64-char name limit. */
function sourceToolName(prefix: string, mcpName: string): string {
  return `${prefix}__${mcpName.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}

function inputSchema(schema: unknown): Anthropic.Tool.InputSchema {
  const s = (schema && typeof schema === "object" ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  delete s.$schema;
  return { ...s, type: "object" } as Anthropic.Tool.InputSchema;
}

// ---------- The run ----------

function runContext(collection: Collection, opened: OpenConnector[], skipped: string[], now: Date, tz: string, triage: string | null = null): string {
  const w = windowDescription(collection.lookback_hours, now, tz);
  const today = zonedToday(now, tz);
  const accounts = opened.map((o) => {
    const preset = presetFor(o.connector.provider);
    return `- ${o.connector.name} (${preset.label}${o.connector.account_label ? `, ${o.connector.account_label}` : ""})`;
  });
  return [
    `Now: ${w.today}. The owner's time zone is ${tz}: "today", dates and days below are in it.`,
    `Collect activity from ${w.start} to ${w.end} (the last ${collection.lookback_hours} hours).`,
    `Accounts you can read:\n${accounts.join("\n")}`,
    skipped.length ? `Unavailable this run (skip them): ${skipped.join(", ")}.` : "",
    `Notes are saved with source "${collection.source}".`,
    `Dates covered by the look-back: ${zonedToday(new Date(now.getTime() - collection.lookback_hours * 3600000), tz)} to ${today}.`,
    collection.lookahead_days > 0
      ? `Upcoming-event sync is ON: keep Athena's events in step with the calendar from ${today} to ${addDays(today, collection.lookahead_days)}.`
      : "Upcoming-event sync is off for this collection.",
    collection.instructions.trim() ? `The owner's instructions for this collection:\n${collection.instructions.trim()}` : "",
    triage ?? "",
    "Start now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function notifyNeedsSignIn(connectorIds: Array<{ id: string; name: string }>) {
  if (connectorIds.length === 0 || !(await pushConfigured())) return;
  const tz = await getOwnerTimeZone();
  // In quiet hours, say nothing: a later run (still signed out) sends it, once that day.
  if (inQuietHours(new Date(), tz, (await loadNotificationPrefs()).quiet)) return;
  const today = zonedToday(new Date(), tz);
  for (const c of connectorIds) {
    if (!(await claimReminder(`connector-auth:${c.id}:${today}`))) continue;
    await sendToAll({ title: "Athena", body: `${c.name} is signed out. Sign in again in Sources so Athena can keep collecting.`, url: "/#/settings/sources", tag: `connector-${c.id}` }).catch(
      () => undefined,
    );
  }
}

/** A security or account alert from email, pushed once (not in quiet hours: the to-do is waiting either way). Never throws. */
async function alertPush(ref: string, title: string, tz: string): Promise<void> {
  try {
    if (!(await pushConfigured())) return;
    if (inQuietHours(new Date(), tz, (await loadNotificationPrefs()).quiet)) return;
    if (!(await claimReminder(`email-alert:${ref}`))) return;
    await sendToAll({ title: "Account alert", body: title, url: "/#/loops", tag: `email-alert-${ref.slice(-40)}` });
  } catch {
    // The to-do is saved; a push that fails is only a missed nudge.
  }
}

/**
 * A scheduled run stopped before it did anything, because today's AI budget couldn't be checked: it's taken back,
 * and its collection is due again, so the next collect tick runs it. No failed run is left behind.
 */
async function waitCollectionRun(runId: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `WITH due AS (UPDATE collections SET next_run_at = now() WHERE enabled AND id = (SELECT collection_id FROM collection_runs WHERE id = $1 AND status = 'running') RETURNING id)
     DELETE FROM collection_runs WHERE id = $1 AND EXISTS (SELECT 1 FROM due) RETURNING id`,
    [runId],
  );
  if (rows.length) console.warn("Athena collect: today's AI budget couldn't be checked, so a run waits for the next tick");
  return rows.length > 0;
}

/** Execute a queued run. Safe to call twice: only the first call claims it. */
export async function executeRun(runId: string, now: Date = new Date()): Promise<void> {
  const run = await startRun(runId);
  if (!run) return;
  const startedAt = Date.now();
  const stats: RunStats = {
    turns: 0,
    tool_calls: 0,
    source_calls: 0,
    notes_created: 0,
    notes_updated: 0,
    skipped_dismissed: 0,
    archived: 0,
    restored: 0,
    events_created: 0,
    events_updated: 0,
    metrics: 0,
    people: 0,
    catch_ups: 0,
    todos: 0,
    details: 0,
    suggestions: 0,
    bookings_created: 0,
    bookings_updated: 0,
    purchases_created: 0,
    purchases_updated: 0,
    claude_skipped: 0,
    triaged_out: 0,
    flagged: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
  };
  const opened: OpenConnector[] = [];
  const needsSignIn: Array<{ id: string; name: string }> = [];
  // Accounts this run couldn't open: their ids go in stats.blocked_by, so the app can say which one to fix.
  const blocked: Array<BlockedAccount & { id: string }> = [];
  // Emails the owner's mail rules kept from this run (counts only: lib/mail-rules.ts).
  const mailSkipped = () => opened.reduce((n, o) => n + (o.direct?.mail?.skipped() ?? 0), 0);
  const final = () => ({ ...stats, ...(mailSkipped() ? { mail_skipped: mailSkipped() } : {}), ...(blocked.length ? { blocked_by: blocked.map((b) => b.id) } : {}) });
  try {
    const collection = await getCollection(run.collection_id);
    const tz = await getOwnerTimeZone();
    if (!collection) throw new Error("The collection was deleted");
    // Plays and watches: read straight into Days, never Claude (media-sync.ts).
    if (collection.recipe === "plays-watches") {
      const r = await runPlaysWatches(collection, runId, { clock: () => now.getTime() });
      await finishRun(runId, { status: r.status, summary: r.summary, ...(r.error ? { error: r.error } : {}), stats: r.stats });
      return;
    }
    // Your work, counted: Linear and GitHub read straight into work_items, never Claude (work-sync.ts).
    if (collection.recipe === "work-sync") {
      const r = await runWorkSync(collection, { clock: () => now.getTime() });
      await finishRun(runId, { status: r.status, summary: r.summary, ...(r.error ? { error: r.error } : {}), stats: r.stats });
      return;
    }
    // Home: the banks, the meter and the appliances, read straight into sealed days and Days, never Claude (home-run.ts).
    if (collection.recipe === "home") {
      const r = await runHome(collection, { now });
      await finishRun(runId, { status: r.status, summary: r.summary, ...(r.error ? { error: r.error } : {}), stats: r.stats });
      return;
    }
    if (!aiConfigured()) throw new Error("No way to reach Claude: Netlify AI Gateway isn't active, and ANTHROPIC_API_KEY isn't set");
    // Meeting notes and synced events from earlier runs, linked if they weren't yet (cheap, and never fails the run).
    await linkCollectedMeetings(collection.source).catch((error) => console.error("Athena collect: linking meeting notes to events failed", error));

    // ---- open every account, gathering its allowed tools ----
    const skipped: string[] = [];
    const sourceTools = new Map<string, SourceTool>();
    const toolDefs: Anthropic.Tool[] = [];
    const allowed = new Map<OpenConnector, Set<string>>();
    const usedPrefixes = new Set<string>();
    // A custom server whose "Share collections" switch is off never shares this run's model with the other accounts (lib/connectors.ts).
    const accounts = (await Promise.all(collection.connector_ids.map((id) => getConnector(id).catch(() => null)))).filter((c) => c !== null);
    const apart = new Map(keptApart(accounts).map((c) => [c.id, c.name]));
    if (apart.size && apart.size === accounts.length) throw new Error(mixedCollectionError([...apart.values()]));
    // Life log accounts checked hourly (media-sync.ts): one last check now, then their plays and watches come from Days, not their tools.
    const hourly = await hourlyAccounts(collection).catch(() => new Map<string, never>());
    // Banks and the meter an enabled Home reads are Home's (home-run.ts): this run leaves them alone.
    const byHome = collection.recipe === "life-log" ? await homeAccounts().catch(() => new Set<string>()) : new Set<string>();
    let leftToHome = 0;
    for (const id of collection.connector_ids) {
      if (byHome.has(id) && isSealedSync(accounts.find((a) => a.id === id)?.provider ?? "")) {
        leftToHome++;
        continue;
      }
      if (apart.has(id)) {
        skipped.push(`${apart.get(id)} (left out: it's collected only on its own)`);
        continue;
      }
      let open: OpenConnector;
      try {
        open = await openConnector(id);
      } catch (error) {
        const name = error instanceof ConnectorNeedsSignIn ? error.connectorName : "An account";
        if (error instanceof ConnectorNeedsSignIn) needsSignIn.push({ id, name });
        const account = await getConnector(id).catch(() => null);
        blocked.push({ id, name: account?.name ?? "a removed account", auth_type: account?.auth_type, signedOut: error instanceof ConnectorNeedsSignIn });
        skipped.push(error instanceof ConnectorNeedsSignIn ? `${name} (needs signing in)` : `${name} (${error instanceof Error ? error.message : "unreachable"})`);
        continue;
      }
      opened.push(open);
      // Swarm, banks and the meter are read by Athena's own syncs below, never by Claude: where you've been, what you spent and when you're home stay sealed (swarm-sync.ts, money-sync.ts).
      if (open.connector.provider === "swarm" || isSealedSync(open.connector.provider)) {
        await markConnectorUsed(id);
        continue;
      }
      let prefix = toolSlug(`${open.connector.provider === "custom" ? open.connector.name : open.connector.provider}_${open.connector.account_label}`).slice(0, 24) || "account";
      while (usedPrefixes.has(prefix)) prefix = `${prefix}_${usedPrefixes.size + 1}`;
      usedPrefixes.add(prefix);
      const recent = hourly.get(id);
      // A week back for Last.fm and ListenBrainz, for scrobbles that arrived late; Trakt's ratings go on the day's entries.
      if (recent) await syncRecent(id, { budgetMs: 60_000, source: recent.collection, mates: recent.mates, clock: () => now.getTime(), lookbackMs: 7 * 86_400_000, lifeLogSource: collection.source }).catch((error) => console.error("Athena collect: the last hourly check failed", error instanceof Error ? error.message : "unknown error"));
      if (recent && open.connector.provider === "trakt") await applyTraktRatings(id, now.getTime() - 7 * 86_400_000, tz).catch(() => undefined);
      const listed = (await listAllowedTools(open)).filter((t) => !recent?.tools.includes(t.name));
      allowed.set(open, new Set(listed.map((t) => t.name)));
      for (const t of listed) {
        const name = sourceToolName(prefix, t.name);
        if (sourceTools.has(name)) continue;
        sourceTools.set(name, { open, mcpName: t.name });
        toolDefs.push({
          name,
          description: `[${open.connector.name}] ${(t.description ?? "").slice(0, 900)}`,
          input_schema: inputSchema(t.inputSchema),
        });
      }
      await markConnectorUsed(id);
    }
    // Every account here is read by Home: nothing for this run to do.
    if (opened.length === 0 && leftToHome && !blocked.length) {
      await finishRun(runId, { status: "succeeded", summary: "Home reads these accounts every hour.", stats: final() });
      return;
    }
    // In the owner's words ("Personal Gmail is signed out"); the account's own status keeps the detail.
    if (opened.length === 0) throw new Error(blockedRunError(blocked));
    // Swarm check-ins, then names and weather for waiting days (lib/places-visits.ts).
    const placesNote = collection.recipe === "life-log" ? [await syncPlaces(opened, { now, tz, lifeLogSource: collection.source }).catch(() => ""), await syncMoneyHome(opened, { now, tz }).catch(() => ""), await syncPlaylists(opened, { now }).catch(() => "")].filter(Boolean).join(" ") : "";
    if (sourceTools.size === 0 && opened.every((o) => o.connector.provider === "swarm" || isSealedSync(o.connector.provider))) {
      await finishRun(runId, { status: "succeeded", summary: placesNote || "Nothing new.", stats: final() });
      return;
    }
    // What Your activity saved, from any account: the day's line is written from it even when this Life log doesn't have the account.
    const activity = await activitySources().catch(() => [] as Array<{ source: string; whole: boolean }>);
    // Accounts checked hourly need no tools: their plays are in Days, and the run still writes the day's line.
    if (sourceTools.size === 0 && !hourly.size && !activity.length) throw new Error("None of the accounts has any allowed tools. Choose what Athena can read in Settings → Sources.");

    // ---- before Claude: TripIt's trips go straight into Trips (tripit-trips.ts) ----
    const tripitLine = await copyTripItAccounts(opened, allowed, collection.source, stats, now);

    // ---- before Claude: anything new? which emails matter? (precheck.ts, Jev) ----
    const check = await precheck({ collection, run, opened: opened.filter((o) => o.connector.provider !== "swarm" && !isSealedSync(o.connector.provider)), allowed, unreachable: skipped.length, tz });
    stats.triaged_out = check.triagedOut;
    const hourlySources = [...new Set([...[...hourly.values()].map((r) => r.source), ...activity.map((a) => a.source)])];
    // New plays from the hourly check still want the day's line.
    if (check.skip && (await hourlyChangedSince(hourlySources, await lastGoodRun(collection.id, run.id)).catch(() => false))) check.skip = false;
    if (check.skip) {
      stats.claude_skipped = 1;
      if (hourly.size) await recountActivity(hourly, accounts, collection, now, tz, runId);
      await finishRun(runId, { status: "succeeded", summary: [check.reason, tripitLine].filter(Boolean).join("\n\n"), stats: final() });
      return;
    }

    // ---- the loop ----
    const writer = new AthenaWriter(collection, runId, stats, now, tz);
    writer.providers = accounts.map((a) => a.provider);
    // A health account Your activity reads has its days saved already: no athena_health_day for it.
    writer.healthSources = [...new Set(opened.filter((o) => !hourly.get(o.connector.id)?.health).map((o) => o.connector.provider).filter(isHealthSource))];
    writer.hourlySources = new Set(checkedSources(await listConnectors().catch(() => accounts)));
    const whole = wholeCovered(opened, hourly);
    // Entries for a source Your activity writes whole are dropped whichever Life log sends them; the prompt trims only for this one's accounts.
    writer.wholeSources = new Set([...whole, ...activity.filter((a) => a.whole).map((a) => a.source)]);
    writer.countedMetrics = new Set(metricsFor([...hourly.values()].map((r) => r.provider)));
    const inDays = await hourlyNote(hourlySources, zonedToday(new Date(now.getTime() - collection.lookback_hours * 3600000), tz), zonedToday(now, tz)).catch(() => "");
    writer.contacts = contactsDirectory(opened, allowed);
    const client = new Anthropic();
    // The owner's model for collecting (lib/models.ts); one that fails on the first call is tried once on the default.
    let job = await resolveJobModel("collector");
    const system = `${BASE_PROMPT}\n\n${collection.recipe === "life-log" ? lifeLogPrompt(whole, writer.countedMetrics, new Set(opened.map((o) => o.connector.provider))) : RECIPE_PROMPTS[collection.recipe]}`;
    // Deterministic order (sorted source tools, then Athena's) keeps the cached prefix stable.
    const tools = [...toolDefs.sort((a, b) => a.name.localeCompare(b.name)), ...writer.tools];
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: runContext(collection, opened, skipped, now, tz, [check.note, inDays].filter(Boolean).join("\n\n") || null) }];
    let summary = "";
    let finished = false;

    while (stats.turns < MAX_TURNS) {
      stats.turns++;
      const call = () => createMessage(clientFor(job.ref, client) as Anthropic, { model: job.ref.model, max_tokens: 16000, system, tools, messages, output_config: { effort: "medium" }, cache_control: { type: "ephemeral" } }, startedAt + TIME_BUDGET_MS);
      const response = await call().catch((error) => {
        const back = stats.turns === 1 ? fallbackRef(job, "collector", error) : null;
        if (!back) throw error;
        job = { ref: back, from: "default" };
        return call();
      });
      stats.input_tokens += response.usage.input_tokens;
      stats.output_tokens += response.usage.output_tokens;
      stats.cache_read_tokens += response.usage.cache_read_input_tokens ?? 0;
      // Append the whole content (thinking blocks included), never an edited copy.
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        throw new Error(`Claude declined to continue${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`);
      }
      const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) summary = text;
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason === "max_tokens") throw new Error("A reply was cut off at the token limit");
      if (calls.length === 0) {
        finished = response.stop_reason === "end_turn";
        break;
      }

      const results: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [];
      for (const call of calls) {
        stats.tool_calls++;
        try {
          if (call.name.startsWith("athena_")) {
            results.push({ type: "tool_result", tool_use_id: call.id, content: await writer.run(call.name, call.input) });
            continue;
          }
          const source = sourceTools.get(call.name);
          if (!source) {
            results.push({ type: "tool_result", tool_use_id: call.id, content: `Tool ${call.name} isn't available.`, is_error: true });
            continue;
          }
          stats.source_calls++;
          const r = await callTool(source.open, source.mcpName, (call.input ?? {}) as Record<string, unknown>);
          if (!r.isError) writer.noteCalendarResult(source.open.connector, (call.input ?? {}) as Record<string, unknown>, r.text);
          // Someone else wrote this: Jev checks it isn't trying to instruct Claude, and flags it if so.
          const guarded = await guardText(r.text);
          if (guarded.flagged) stats.flagged++;
          results.push({ type: "tool_result", tool_use_id: call.id, content: guarded.text, ...(r.isError ? { is_error: true as const } : {}) });
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? `Invalid input: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
              : error instanceof Error
                ? error.message
                : String(error);
          results.push({ type: "tool_result", tool_use_id: call.id, content: message.slice(0, 2000), is_error: true });
        }
      }
      const elapsed = Date.now() - startedAt;
      if (stats.turns >= MAX_TURNS - 2 || elapsed > TIME_BUDGET_MS - 120_000) {
        results.push({
          type: "text",
          text: "You're nearly out of time for this run. Don't read anything more: save what you have, record the metric, and finish with your summary.",
        });
      }
      if (elapsed > TIME_BUDGET_MS) {
        messages.push({ role: "user", content: results });
        summary = summary || "Stopped at the time limit.";
        break;
      }
      messages.push({ role: "user", content: results });
    }

    const notes = [
      finished ? "" : "Stopped before the model finished (step or time limit).",
      placesNote,
      skipped.length ? `Skipped: ${skipped.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    // Your activity's daily counts for the window, now that Claude's entries are in too (a posts count can mix covered and uncovered accounts).
    if (hourly.size) await recountActivity(hourly, accounts, collection, now, tz, runId);
    // Days: art for what this run wrote (and older entries still without), within a short budget; the collect tick's backfill carries on (lib/day-art-backfill.ts).
    if (collection.recipe === "life-log" && artStorable()) await fillDayArt({ entriesWithoutArt, setEntryArt }, { budgetMs: 3000, limit: 60 });
    await finishRun(runId, { status: "succeeded", summary: [summary, notes, tripitLine].filter(Boolean).join("\n\n"), stats: final() });
  } catch (error) {
    // Today's AI budget couldn't be checked (lib/spend.ts): a scheduled run that saved nothing waits for the next tick.
    if (isBudgetUnchecked(error) && run.trigger === "schedule" && !stats.tool_calls && (await waitCollectionRun(runId).catch(() => false))) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Athena collection run ${runId} failed:`, message);
    await finishRun(runId, { status: "failed", error: message, stats: final() });
  } finally {
    const day = zonedToday(now, await getOwnerTimeZone().catch(() => "UTC"));
    await Promise.all(opened.map((o) => (o.direct?.mail ? recordMailSkips(o.connector.id, o.direct.mail.skipped(), day).catch(() => undefined) : undefined)));
    await Promise.all(opened.map((o) => o.close()));
    await notifyNeedsSignIn(needsSignIn).catch(() => undefined);
  }
}

/** Sources Your activity writes whole for this run: every account of that provider in the Life log is read by it. */
function wholeCovered(opened: OpenConnector[], hourly: Map<string, { whole?: boolean; source: string }>): Set<string> {
  const out = new Set<string>();
  for (const [id, r] of hourly) {
    if (!r.whole) continue;
    const provider = opened.find((o) => o.connector.id === id)?.connector.provider;
    if (provider && opened.filter((o) => o.connector.provider === provider).every((o) => hourly.get(o.connector.id)?.whole)) out.add(r.source);
  }
  return out;
}

/** The window's daily counts for the accounts Your activity reads, from Days (activity-metrics.ts). Never fails the run. */
async function recountActivity(hourly: Map<string, unknown>, accounts: Connector[], collection: Collection, now: Date, tz: string, runId: string): Promise<void> {
  const from = zonedToday(new Date(now.getTime() - collection.lookback_hours * 3600000), tz);
  const days: string[] = [];
  for (let d = from; d <= zonedToday(now, tz); d = addDays(d, 1)) days.push(d);
  const read = accounts.filter((a) => hourly.has(a.id)).map((connector) => ({ connector, days }));
  await writeActivityMetrics(read, { tz, runId, lifeLogs: [collection] }).catch((error) => console.error("Athena collect: daily counts failed", error instanceof Error ? error.message : "unknown error"));
}

// ---------- One item, from Ask (ask-import.ts) ----------

/** A record saving one item made that's new to Athena: Ask lists it under the answer, and Undo archives it. */
export interface OneItemWrite {
  kind: ArchivableKind | "day";
  id: string;
  title: string;
  /** The person a detail or catch-up is about. */
  person?: string;
  /** A booking's trip, and whether this item started it (so Undo archives the trip too). */
  trip?: { id: string; name: string; created: boolean };
}

export interface OneItemResult {
  /** The collection whose recipe and source it was saved under. */
  source: string;
  writes: OneItemWrite[];
  /** Finds that went to the Review inbox (confidence under 0.8). */
  review: number;
  /** Writes that changed something Athena already had. */
  updated: number;
}

/** A single item writes no metric (it would replace a whole day's count), archives nothing and leaves the day's line alone. */
const ONE_ITEM_LEAVES_OUT = new Set(["athena_metric", "athena_archive_collected", "athena_list_collected", "athena_day_line"]);
const ONE_ITEM_TURNS = 6;

/** The collection a cited item is saved under: one that reads its account (the recipe made for it first), else the one the app would make for it. */
export async function collectionForItem(connector: { id: string; provider: string; name: string; account_label: string }, all?: Collection[]): Promise<Collection> {
  const recipe = presetFor(connector.provider).recipes?.[0] ?? "custom";
  const reading = (all ?? (await listCollections())).filter((c) => c.connector_ids.includes(connector.id));
  const found = reading.find((c) => c.recipe === recipe) ?? reading.find((c) => c.recipe !== "custom") ?? reading[0];
  if (found) return found;
  // Nothing reads this account yet: the source a collection for it would get, so one made later updates what's saved now.
  const source = collectionSource(recipe, connector.name, connector.account_label);
  return {
    id: "", name: connector.name, recipe, connector_ids: [connector.id], label: connector.account_label, source,
    instructions: recipe === "custom" ? "Save what matters from this item as a note." : "", schedule: "manual", run_at: null, every_hours: null,
    lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: false, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "",
  } as unknown as Collection;
}

/**
 * Save one item from a connected account the way its collection would
 * (the same recipe, BASE_PROMPT and NOTE_STYLE, the same write tools, source,
 * provenance and Review-inbox rule), for Ask: an item an answer cited from
 * before Athena started collecting. Dedupe is the collection's own: notes and
 * events on (source, external_id), bookings on their reference, orders on
 * their number, to-dos on source_ref, so saving it again, or a later run
 * meeting it, updates rather than adds. `importId` stands in for a run id.
 */
export async function collectOneItem(
  item: { connectorId: string; url: string; externalId: string | null; title: string; date: string | null },
  opts: { importId: string; now?: Date; deadline?: number; client?: Anthropic; open?: (id: string) => Promise<OpenConnector>; collections?: Collection[] },
): Promise<OneItemResult> {
  const now = opts.now ?? new Date();
  const started = Date.now() - 5_000;
  const deadline = opts.deadline ?? Date.now() + 40_000;
  const open = await (opts.open ?? openConnector)(item.connectorId);
  try {
    const connector = open.connector;
    if (connector.provider === "swarm" || isSealedSync(connector.provider)) throw new Error(`${connector.name} is read by Athena itself, not saved from Ask.`);
    const collection = await collectionForItem(connector, opts.collections);
    const tz = await getOwnerTimeZone();
    const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0,
      metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0, bookings_created: 0, bookings_updated: 0, purchases_created: 0, purchases_updated: 0,
      claude_skipped: 0, triaged_out: 0, flagged: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } as RunStats;
    const writer = new AthenaWriter(collection, opts.importId, stats, now, tz);
    writer.providers = [connector.provider];
    // The owner's answer rested on this item: it may be kept as a note whatever it is.
    writer.notesForReferenceOnly = false;
    if (isHealthSource(connector.provider)) writer.healthSources = [connector.provider as HealthSource];

    const prefix = toolSlug(`${connector.provider === "custom" ? connector.name : connector.provider}_${connector.account_label}`).slice(0, 24) || "account";
    const listed = await listAllowedTools(open);
    const sourceTools = new Map(listed.map((t) => [sourceToolName(prefix, t.name), t.name]));
    const tools = [
      ...listed.map((t) => ({ name: sourceToolName(prefix, t.name), description: `[${connector.name}] ${(t.description ?? "").slice(0, 900)}`, input_schema: inputSchema(t.inputSchema) })).sort((a, b) => a.name.localeCompare(b.name)),
      ...writer.tools.filter((t) => !ONE_ITEM_LEAVES_OUT.has(t.name)),
    ];
    const context = [
      `Now: ${zonedToday(now, tz)}. The owner's time zone is ${tz}.`,
      `This isn't a scheduled run. The owner asked Athena a question and the answer rests on one item in ${connector.name} that Athena doesn't have yet, from before it started collecting. Save that one item now, exactly as a run would.`,
      `The item: ${JSON.stringify(item.title)}${item.date ? ` (${item.date})` : ""}, at ${item.url}${item.externalId ? `. Its id is ${item.externalId}: use it as external_id.` : "."}`,
      "Read it with the account's tools (fetch it by its id), then save what the recipe above says to save from it. Its date is in the past: that's expected, save it anyway. Don't search for or save any other item, write no metric and archive nothing. Finish with one line saying what you saved.",
      `Notes are saved with source "${collection.source}".`,
    ].join("\n\n");
    const client = opts.client ?? new Anthropic();
    let job = await resolveJobModel("collector");
    const system = `${BASE_PROMPT}\n\n${RECIPE_PROMPTS[collection.recipe]}`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: context }];
    const result: OneItemResult = { source: collection.source, writes: [], review: 0, updated: 0 };
    const trips = new Map<string, { name: string }>();

    for (let turn = 0; turn < ONE_ITEM_TURNS; turn++) {
      const call = () => createMessage(clientFor(job.ref, client) as Anthropic, { model: job.ref.model, max_tokens: 8000, system, tools, messages, output_config: { effort: "low" }, cache_control: { type: "ephemeral" } }, deadline);
      const response = await call().catch((error) => {
        const back = turn === 0 ? fallbackRef(job, "collector", error) : null;
        if (!back) throw error;
        job = { ref: back, from: "default" };
        return call();
      });
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "refusal") break;
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!calls.length) break;
      const results: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [];
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        try {
          if (call.name.startsWith("athena_")) {
            if (ONE_ITEM_LEAVES_OUT.has(call.name)) throw new Error("Not for a single item.");
            const out = await writer.run(call.name, input);
            noteWrite(result, trips, call.name, input, out);
            results.push({ type: "tool_result", tool_use_id: call.id, content: out });
            continue;
          }
          const mcpName = sourceTools.get(call.name);
          if (!mcpName) {
            results.push({ type: "tool_result", tool_use_id: call.id, content: `Tool ${call.name} isn't available.`, is_error: true });
            continue;
          }
          const r = await callTool(open, mcpName, input);
          if (!r.isError) writer.noteCalendarResult(connector, input, r.text);
          const guarded = await guardText(r.text);
          results.push({ type: "tool_result", tool_use_id: call.id, content: guarded.text, ...(r.isError ? { is_error: true as const } : {}) });
        } catch (error) {
          const message = error instanceof z.ZodError ? `Invalid input: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : error instanceof Error ? error.message : String(error);
          results.push({ type: "tool_result", tool_use_id: call.id, content: message.slice(0, 2000), is_error: true });
        }
      }
      if (turn >= ONE_ITEM_TURNS - 2 || Date.now() > deadline - 10_000) results.push({ type: "text", text: "Time's nearly up: save what you have and finish." });
      messages.push({ role: "user", content: results });
    }

    // A booking's trip: new when this item started it, so Undo takes it too.
    if (trips.size) {
      const fresh = new Set(
        (await q<{ id: string }>(`SELECT id FROM trips WHERE id = ANY($1::uuid[]) AND created_at >= $2::timestamptz`, [[...trips.keys()], new Date(started).toISOString()])).map((r) => r.id),
      );
      for (const w of result.writes) if (w.trip) w.trip.created = fresh.has(w.trip.id);
    }
    return result;
  } finally {
    await open.close().catch(() => undefined);
  }
}

/** What one write tool's answer says was saved. Only what's new counts as a write; a change to something Athena had is counted, not listed. */
function noteWrite(result: OneItemResult, trips: Map<string, { name: string }>, tool: string, input: Record<string, unknown>, out: string): void {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return;
  }
  if (o.action === "sent_to_review_inbox") {
    result.review++;
    return;
  }
  const id = typeof o.id === "string" ? o.id : null;
  const fresh = o.action === "created" || o.action === "restored" || o.action === "saved";
  if (o.action === "updated" || o.action === "already_recorded") result.updated++;
  const title = String(input.title ?? input.summary ?? input.name ?? "");
  switch (tool) {
    case "athena_save_note":
      if (id && fresh) result.writes.push({ kind: "note", id, title });
      break;
    case "athena_save_event":
      if (id && fresh) result.writes.push({ kind: "event", id, title });
      break;
    case "athena_trip_booking": {
      const trip = o.trip as { id: string; name: string } | null;
      if (trip) trips.set(trip.id, { name: trip.name });
      if (id && fresh) result.writes.push({ kind: "booking", id, title, ...(trip ? { trip: { id: trip.id, name: trip.name, created: false } } : {}) });
      break;
    }
    case "athena_purchase":
      if (id && fresh) result.writes.push({ kind: "purchase", id, title: String(o.name ?? input.retailer ?? "") });
      break;
    case "athena_receipt": {
      const entry = o.entry as { title?: string; action?: string } | undefined;
      if (typeof o.day === "string" && entry?.action === "created") result.writes.push({ kind: "day", id: o.day, title: String(entry.title ?? "") });
      break;
    }
    case "athena_todo":
    case "athena_alert":
      if (id && fresh) result.writes.push({ kind: "commitment", id, title });
      break;
    case "athena_email_date":
      if (id && fresh) result.writes.push({ kind: "event", id, title });
      break;
    case "athena_renewal":
      if (id && fresh) result.writes.push({ kind: "asset", id, title: String(o.name ?? input.name ?? "") });
      break;
    case "athena_catch_up":
      if (id && fresh) result.writes.push({ kind: "interaction", id, title, person: (input.person_ids as string[] | undefined)?.[0] });
      break;
    case "athena_remember":
      if (id && fresh) result.writes.push({ kind: "fact", id, title: `${String(input.key ?? "")}: ${String(input.value ?? "")}`, person: String(input.person_id ?? "") || undefined });
      break;
    case "athena_watch_read":
      if (id && o.action === "created") result.writes.push({ kind: "reading", id, title: String(o.title ?? input.title ?? "") });
      break;
    case "athena_day_entry":
      if (typeof o.date === "string" && Number(o.created) > 0) result.writes.push({ kind: "day", id: o.date, title: String((input.entries as Array<{ title?: string }> | undefined)?.[0]?.title ?? "") });
      break;
  }
}
