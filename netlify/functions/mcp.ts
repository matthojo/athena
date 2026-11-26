/**
 * Athena's MCP server, hosted as a Netlify Function.
 *
 * Any MCP-compatible client (Claude Desktop, etc.) can point at this
 * function's `/mcp` path with `Authorization: Bearer <MCP_BEARER_TOKEN>` and
 * get tool access to the whole second-brain: notes, people, metrics, and the
 * entity graph. Every tool below is a thin wrapper around lib/db.ts — no SQL
 * lives here.
 *
 * Transport: Netlify's documented pattern for hosting an MCP server as a
 * Function — the SDK's Web Standard Streamable HTTP transport, which speaks
 * Request/Response directly instead of needing Node's http module.
 */
import { STEPS_RULE_SHORT } from "../../lib/todo-details";
import { startTeamEvent } from "../../lib/team-triggers";
// Plugs flows into the owner's own events, so a tagged note or a save starts its flows at once (lib/flow-engine.ts).
import "../../lib/flow-engine";
import type { Config, Context } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { authorized } from "../lib/mcp/bearer";
import { CONTENT_INSTRUCTIONS, fail, ok, safe, stored, type ToolResult } from "../lib/mcp/results";
import { registerCustomFieldTools, withCustomFields, withCustomFieldsList } from "../lib/mcp/custom-fields";
import { registerCustomKindTools } from "../lib/mcp/custom-kinds";
import { registerSavedActionTools } from "../lib/mcp/saved-actions";
import { registerLoggingTools } from "../lib/mcp/logging";
import { registerCheckinTools } from "../lib/mcp/checkins";
import {
  createNote,
  getNote,
  updateNote,
  listNotes,
  searchNotesByKeyword,
  capture,
  linkEntities,
  unlinkEntities,
  upsertPerson,
  upsertPlace,
  upsertOrganisation,
  upsertEvent,
  upsertProject,
  getRecord,
  listRecords,
  archiveEntity,
  unarchiveEntity,
  listUpcoming,
  searchEntities,
  getConnectionsDetailed,
  upsertMetric,
  queryMetrics,
  saveReminder,
  listReminders,
  type RecordKind,
} from "../../lib/db";
import { REMINDER_REPEATS } from "../../lib/reminders";
import {
  addFact,
  addIdentity,
  listAssets,
  listFacts,
  listGoals,
  listOpenLoops,
  listReading,
  logInteraction,
  personBrief,
  propose,
  recall,
  resolvePerson,
  upsertAsset,
  upsertCommitment,
  upsertGoal,
  upsertReadingItem,
  weeklyReview,
} from "../../lib/memory";
import { NOTE_STYLE, NOTE_STYLE_SHORT, styleProblems } from "../../lib/writing-style";
import { modelWroteInto } from "../../lib/links";
import { getPurchase, getTrip, listPurchases, listTrips, ownerToday, type Trip } from "../../lib/trips";
import { bookingLine, deliveryState, purchaseName, tripLabel } from "../../lib/trip-text";
import { PROGRESS_UNITS, READING_KINDS } from "../../lib/watch-read";
import { withSpendScope } from "../../lib/spend";

const NOTE_TYPES = ["note", "daily", "project", "area", "capture"] as const;
/** "record": a record in one of the owner's own kinds (list_kinds, list_records). */
const ENTITY_TYPES = ["note", "person", "project", "place", "organisation", "event", "record"] as const;
/** Kinds a reminder can be about (a custom record has no page a push could open yet). */
const REMINDER_ABOUT = ["note", "person", "project", "place", "organisation", "event"] as const;
/**
 * Everything archive/unarchive accepts: graph entities (custom records too),
 * the layer-2 kinds, trips, bookings and purchases, and "kind": one of the
 * owner's own kinds, with everything in it.
 */
const ARCHIVABLE_KINDS = [...ENTITY_TYPES, "commitment", "interaction", "fact", "asset", "reading", "goal", "trip", "booking", "purchase", "kind"] as const;
const EVENT_KINDS = ["birthday", "anniversary", "appointment", "deadline", "other"] as const;
const COMMITMENT_KINDS = ["todo", "i_owe", "waiting_on", "decision"] as const;
const CHANNELS = ["meeting", "call", "message", "email", "in_person", "other"] as const;
const ASSET_KINDS = ["passport", "licence", "insurance", "vehicle", "warranty", "subscription", "home", "pet", "health", "other"] as const;
/**
 * How agents should write what they extract: provenance on everything, and
 * only confident items written directly. Appended to every layer-2 write tool.
 */
const EXTRACTION_RULES =
  "Always resolve people with resolve_person first (create them with upsert_person only when there's no match). " +
  "Attach provenance: source (your agent name), source_ref (URL or note:<uuid>) and source_quote (the exact words). " +
  "Write directly only when confidence >= 0.8; otherwise call propose so the owner can review it. " +
  NOTE_STYLE_SHORT;

const provenanceSchema = {
  source: z.string().optional().describe("Who is writing: your agent name, e.g. 'calendar-meetings'; the app uses 'manual'"),
  source_ref: z
    .string()
    .optional()
    .describe("Where it came from: a URL or note:<uuid>. Writing the same item again with the same source_ref is idempotent"),
  source_quote: z.string().optional().describe("The exact words it was taken from"),
  confidence: z.number().min(0).max(1).optional().describe("0..1; write directly only at >= 0.8, otherwise use propose"),
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, a local date in the owner's time zone");

/**
 * Shared guidance on Athena's link syntax, appended to every tool that reads
 * or writes note bodies so agents link entities the same way the app does.
 */
const LINK_SYNTAX =
  "Note bodies are Markdown. Link to people, places, organisations, events and other notes with " +
  "athena:// links: [@Priya Shah](athena://person/<uuid>), [@Dishoom](athena://place/<uuid>), " +
  "[@Netlify](athena://organisation/<uuid>), [@Mum's birthday](athena://event/<uuid>), " +
  "[Q3 planning](athena://note/<uuid>), and a record in one of the owner's own kinds as [@Château Musar](athena://record/<uuid>). " +
  "Entity labels start with '@'; note labels don't. " +
  "Use search_entities to find ids (create the entity first with upsert_* if it doesn't exist). " +
  "Saving a body re-derives that note's 'mentions' links automatically, which is what powers backlinks.";

/** Deliberately absent: any delete tool and any way to list archived items (see SECURITY.md). */
const ARCHIVE_NOTE =
  "Archived items disappear from every list, search, backlink and reminder; the owner can restore " +
  "or permanently delete them from the app. There is no delete tool: archive instead.";

/**
 * A saved note, plus what in its title or body breaks NOTE_STYLE. The note is
 * saved either way (this server keeps no state to send a write back once, as
 * the collection runner does); the agent is asked to fix it with update_note.
 * It comes back in the stored-content envelope: an update can return a body
 * the caller didn't write.
 */
function okNote(note: unknown, written: { title?: string; body?: string }): ToolResult {
  const problems = styleProblems([written.title ?? "", written.body ?? ""].join("\n"));
  if (!problems.length) return stored("notes", note);
  return stored("notes", {
    ...(note as object),
    style_issues: problems,
    style_fix: "Saved, but this breaks Athena's writing style. Rewrite those parts with update_note, unless they're quotes or names copied from the source.",
  });
}

const RECORD_TOOLS: Array<{ kind: RecordKind; singular: string; plural: string; order: string }> = [
  { kind: "person", singular: "person", plural: "people", order: "alphabetically by name" },
  { kind: "place", singular: "place", plural: "places", order: "alphabetically by name" },
  { kind: "organisation", singular: "organisation", plural: "organisations", order: "alphabetically by name" },
  { kind: "event", singular: "event", plural: "events", order: "by stored date (use list_upcoming for what's next)" },
  { kind: "project", singular: "project", plural: "projects", order: "most recently updated first" },
];

const dateSchema = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/)
  .describe("YYYY-MM-DD, or --MM-DD when the year isn't known (yearly dates only)");

function buildServer(): McpServer {
  const server = new McpServer({ name: "athena", version: "0.3.0" }, { instructions: `${NOTE_STYLE}\n\n${CONTENT_INSTRUCTIONS}` });

  // ---------- notes ----------

  server.tool(
    "create_note",
    `Create a new note (or daily/project/area/capture entry) in Athena. ${LINK_SYNTAX} ${NOTE_STYLE_SHORT}`,
    {
      title: z.string().describe("Note title"),
      body: z.string().optional().describe("Markdown body; defaults to empty string. May contain athena:// links."),
      type: z.enum(NOTE_TYPES).optional().describe("Note category; defaults to 'note'"),
      source: z.string().optional().describe("Where this came from, e.g. 'manual', 'calendar-meetings'"),
      tags: z.array(z.string()).optional().describe("Freeform tags for filtering/search"),
    },
    safe(async (args) => {
      const note = await createNote(args);
      // A note made with tags is a Team event; a matching assistant starts now (lib/team-triggers.ts). Never throws.
      if (note.tags?.length) await startTeamEvent("note", note.id, "note", { title: note.title, tags: note.tags, kind: note.type });
      return okNote(note, args);
    }),
  );

  server.tool(
    "get_note",
    "Fetch a single note by its ID (archived notes are not returned).",
    { id: z.string().uuid().describe("Note UUID") },
    safe(async ({ id }) => {
      const note = await getNote(id);
      return note ? stored("notes", await withCustomFields("note", note)) : fail(`Note ${id} not found`);
    }),
  );

  server.tool(
    "update_note",
    `Update a note's title, body, type, source and/or tags. Omitted fields are left as they are. ${LINK_SYNTAX} ${NOTE_STYLE_SHORT}`,
    {
      id: z.string().uuid().describe("Note UUID"),
      title: z.string().optional(),
      body: z.string().optional().describe("Replaces the whole Markdown body"),
      type: z.enum(NOTE_TYPES).optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Replaces the note's full tag list"),
    },
    safe(async ({ id, ...patch }) => {
      // An agent is a model: in a note the owner wrote, links it adds are plain (lib/links.ts modelWroteInto). On
      // purpose for every MCP key, a Claude only one included (SECURITY.md §10).
      const was = patch.body !== undefined ? await getNote(id) : null;
      const body = was && patch.body !== undefined ? modelWroteInto(was, patch.body) : patch.body;
      const note = await updateNote(id, { ...patch, ...(body !== undefined ? { body } : {}) }, { by: "mcp" });
      return note ? okNote(note, patch) : fail(`Note ${id} not found`);
    }),
  );

  server.tool(
    "list_notes",
    "List notes, most recently updated first, optionally filtered by type, source or update time.",
    {
      type: z.enum(NOTE_TYPES).optional(),
      source: z.string().optional().describe("e.g. 'manual', 'calendar-meetings', 'briefing'"),
      since: z.coerce.date().optional().describe("Only notes updated at/after this ISO 8601 timestamp"),
      limit: z.number().int().positive().max(200).optional().describe("Max results; defaults to 50"),
    },
    safe(async (args) => stored("notes", await listNotes(args))),
  );

  server.tool(
    "search_notes",
    "Keyword search over note titles and bodies (case-insensitive substring match).",
    {
      query: z.string().describe("Search text"),
      limit: z.number().int().positive().max(100).optional().describe("Max results; defaults to 20"),
    },
    safe(async ({ query, limit }) => stored("notes", await searchNotesByKeyword(query, limit))),
  );

  server.tool(
    "capture",
    "Quick inbox-style capture of raw text — the one-tap/voice/Shortcut entry point. Auto-titles from the text.",
    {
      text: z.string().describe("Raw captured text (Markdown; athena:// links allowed)"),
      source: z.string().optional().describe("Capture origin, e.g. 'manual', 'siri-shortcut'; defaults to 'manual'"),
    },
    safe(async (args) => ok(await capture(args))),
  );

  // ---------- archive (never delete) ----------

  server.tool(
    "archive",
    `Archive any item by kind and id — including commitments, interactions, facts, life-admin items, watch & read items (kind 'reading'), goals, trips, single bookings, purchases, ` +
      `a record in one of the owner's own kinds ('record') and one of those kinds itself ('kind', which hides every record in it too). ${ARCHIVE_NOTE}`,
    {
      kind: z.enum(ARCHIVABLE_KINDS),
      id: z.string().uuid(),
    },
    safe(async ({ kind, id }) =>
      (await archiveEntity(kind, id)) ? ok({ kind, id, archived: true }) : fail(`${kind} ${id} not found`),
    ),
  );

  server.tool(
    "unarchive",
    "Restore an archived item by kind and id, so it shows up again everywhere.",
    {
      kind: z.enum(ARCHIVABLE_KINDS),
      id: z.string().uuid(),
    },
    safe(async ({ kind, id }) =>
      (await unarchiveEntity(kind, id)) ? ok({ kind, id, archived: false }) : fail(`${kind} ${id} not found`),
    ),
  );

  // ---------- people, places, organisations, events, projects ----------

  server.tool(
    "upsert_person",
    "Create a person (omit id) or update one (pass id; omitted fields are left as they are) in the personal CRM. " +
      "Setting birthday creates/updates their yearly birthday event, which drives Coming up, reminders and the morning briefing.",
    {
      id: z.string().uuid().optional().describe("Existing person ID to update; omit to create"),
      name: z.string().optional().describe("Required when creating"),
      relationship: z.string().optional().describe("e.g. 'friend', 'sister', 'manager'"),
      email: z.string().optional(),
      phone: z.string().optional(),
      birthday: dateSchema.nullable().optional().describe("YYYY-MM-DD, or --MM-DD if the year isn't known; null clears"),
      organisation_id: z.string().uuid().nullable().optional().describe("Organisation they work at; null clears"),
      catch_up_days: z.number().int().positive().nullable().optional().describe("Catch-up cadence in days; null = default 60"),
      keep_in_touch: z
        .boolean()
        .optional()
        .describe(
          "true = remind the owner to catch up with this person (Coming up, briefing, reminders). Off by default; only turn it on when the owner asks",
        ),
      last_contacted_at: z.coerce.date().nullable().optional().describe("When you last spoke; ISO 8601"),
      notes: z.string().optional().describe("Freeform notes about this person"),
    },
    safe(async ({ last_contacted_at, ...rest }) =>
      ok(
        await upsertPerson({
          ...rest,
          last_contacted_at: last_contacted_at === undefined ? undefined : last_contacted_at?.toISOString() ?? null,
        }),
      ),
    ),
  );

  server.tool(
    "upsert_place",
    "Create a place (omit id) or update one (pass id) — restaurants, venues, homes, offices.",
    {
      id: z.string().uuid().optional(),
      name: z.string().optional().describe("Required when creating"),
      address: z.string().optional(),
      url: z.string().optional().describe("Website or maps link"),
      notes: z.string().optional(),
    },
    safe(async (args) => ok(await upsertPlace(args))),
  );

  server.tool(
    "upsert_organisation",
    "Create an organisation (omit id) or update one (pass id) — companies, clubs, schools, teams.",
    {
      id: z.string().uuid().optional(),
      name: z.string().optional().describe("Required when creating"),
      website: z.string().optional(),
      notes: z.string().optional(),
    },
    safe(async (args) => ok(await upsertOrganisation(args))),
  );

  server.tool(
    "upsert_event",
    "Create a dated event (omit id) or update one (pass id): appointments, deadlines, anniversaries. " +
      "A timed one-off event is stored as a UTC instant: pass starts_at (ISO 8601 with Z or an offset), or date + time " +
      "in the owner's time zone. All-day events and birthdays are plain dates. Returned events carry starts_at (UTC) " +
      "for timed one-offs. For a person's birthday prefer upsert_person's birthday field.",
    {
      id: z.string().uuid().optional(),
      title: z.string().optional().describe("Required when creating"),
      kind: z.enum(EVENT_KINDS).optional().describe("Defaults to 'other'"),
      date: dateSchema.optional().describe("Required when creating. YYYY-MM-DD, or --MM-DD for a yearly date without a known year"),
      time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional().describe("HH:MM 24h in the owner's time zone; null = all-day. Timed events get a push 30 minutes before"),
      starts_at: z.string().nullable().optional().describe("Timed one-off: ISO 8601 instant with Z or an offset, e.g. 2026-11-07T09:30:00Z. null = all-day"),
      recurrence: z.enum(["none", "yearly"]).optional().describe("Defaults to 'none'"),
      remind_days_before: z.array(z.number().int().min(0).max(365)).optional().describe("Days before to include it in the morning briefing push; default [0]"),
      notes: z.string().optional(),
      person_id: z.string().uuid().nullable().optional().describe("Person this event belongs to, if any"),
    },
    safe(async (args) => ok(await upsertEvent(args))),
  );

  server.tool(
    "upsert_project",
    "Create a new project (omit id), or update an existing one by ID.",
    {
      id: z.string().uuid().optional().describe("Existing project ID to update; omit to create a new project"),
      name: z.string().optional().describe("Required when creating"),
      status: z.enum(["active", "paused", "done"]).optional().describe("Defaults to 'active' on create"),
      description: z.string().optional(),
    },
    safe(async (args) => ok(await upsertProject(args))),
  );

  for (const { kind, singular, plural, order } of RECORD_TOOLS) {
    server.tool(
      `get_${singular}`,
      `Fetch one ${singular} by ID (archived items are not returned).`,
      { id: z.string().uuid() },
      safe(async ({ id }) => {
        const record = await getRecord(kind, id);
        return record ? stored(plural, await withCustomFields(kind, record)) : fail(`${singular} ${id} not found`);
      }),
    );
    server.tool(
      `list_${plural}`,
      `List ${plural}, ${order}.`,
      { limit: z.number().int().positive().max(500).optional().describe("Max results") },
      safe(async ({ limit }) => stored(plural, await listRecords(kind, limit))),
    );
  }

  // ---------- PA views + the graph ----------

  server.tool(
    "list_upcoming",
    "What's coming up: birthdays and events from today through the next N days (days and times in the owner's time zone, " +
      "starts_at in UTC; age turned when known) plus people overdue a catch-up.",
    { days: z.number().int().positive().max(366).optional().describe("Days after today to include; defaults to 6 (this week)") },
    safe(async ({ days }) => stored("events and people", await listUpcoming(days))),
  );

  server.tool(
    "search_entities",
    "Find people, places, organisations, events, projects, notes and records in the owner's own kinds (kind 'record'; the subtitle says which, e.g. 'Wine') by name/title — use it to get ids for athena:// links.",
    {
      query: z.string().describe("Name or title text; empty returns the most recent"),
      kinds: z.array(z.enum(ENTITY_TYPES)).optional().describe("Restrict to these kinds"),
      limit: z.number().int().positive().max(50).optional().describe("Defaults to 12"),
    },
    safe(async ({ query, kinds, limit }) => stored("search results", await searchEntities(query, { kinds, limit }))),
  );

  server.tool(
    "get_connections",
    "An item's links with titles: `outgoing` (what it links to) and `backlinks` (what links to it, e.g. notes mentioning a person).",
    {
      kind: z.enum(ENTITY_TYPES),
      id: z.string().uuid(),
    },
    safe(async ({ kind, id }) => stored("links", await getConnectionsDetailed(kind, id))),
  );

  server.tool(
    "link",
    "Create a typed relationship edge between two items, e.g. person works_at organisation. " +
      "(Links inside note bodies are derived from athena:// links automatically — no need to call this for those.)",
    {
      sourceType: z.enum(ENTITY_TYPES).describe("Type of the source entity"),
      sourceId: z.string().uuid().describe("ID of the source entity"),
      targetType: z.enum(ENTITY_TYPES).describe("Type of the target entity"),
      targetId: z.string().uuid().describe("ID of the target entity"),
      relation: z.string().optional().describe("Relationship label; defaults to 'relates_to'"),
    },
    safe(async (args) => ok(await linkEntities(args))),
  );

  server.tool(
    "unlink",
    "Remove a manual relationship edge created with link (all relations between the pair unless one is given). " +
      "To remove a link that comes from a note body, edit the note instead.",
    {
      sourceType: z.enum(ENTITY_TYPES),
      sourceId: z.string().uuid(),
      targetType: z.enum(ENTITY_TYPES),
      targetId: z.string().uuid(),
      relation: z.string().optional(),
    },
    safe(async (args) => ok({ removed: await unlinkEntities(args) })),
  );

  // ---------- custom reminders ----------

  server.tool(
    "create_reminder",
    "Ask Athena to remind the owner of something at a given time (\"remind me to call the plumber at 5pm\"). " +
      "It arrives as a push notification on their devices (within ~5 minutes of the time) and is listed in that " +
      "morning's briefing. Give either `at` (an exact ISO 8601 instant with offset) or `date` and/or `time` " +
      "(the owner's time zone, as list_upcoming reports it; `time` alone means today, `date` alone means 09:00). " +
      "Resolve relative phrases like 'tomorrow evening' yourself before calling. A repeating reminder keeps its time " +
      "of day in the owner's zone, even when they travel. Optionally repeat it, and optionally attach what it's " +
      "about (get the id from search_entities) so tapping the notification opens it.",
    {
      text: z.string().min(1).describe("What to remind them of, written as the notification title, e.g. 'Call the plumber'"),
      at: z.string().datetime({ offset: true }).optional().describe("Exact instant, e.g. 2026-11-06T17:00:00Z"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local date YYYY-MM-DD in the owner's time zone"),
      time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Local time HH:MM (24h) in the owner's time zone"),
      repeat: z.enum(REMINDER_REPEATS as [string, ...string[]]).optional().describe("Defaults to 'none' (once)"),
      about: z.object({ kind: z.enum(REMINDER_ABOUT), id: z.string().uuid() }).optional().describe("The item it's about, if any"),
    },
    safe(async ({ text, at, date, time, repeat, about }) => {
      if (!at && !date && !time) return fail("Give 'at', or 'date' and/or 'time'");
      return ok(
        await saveReminder({
          text,
          at: at ? new Date(at) : undefined,
          date,
          time,
          repeat: repeat as (typeof REMINDER_REPEATS)[number] | undefined,
          about: about ? { type: about.kind, id: about.id } : undefined,
        }),
      );
    }),
  );

  server.tool(
    "list_reminders",
    "The owner's custom reminders: pending ones soonest first (remind_at is when each next fires), " +
      "plus recently finished ones when include_done is true.",
    {
      include_done: z.boolean().optional().describe("Also return finished reminders; defaults to false"),
      limit: z.number().int().positive().max(500).optional(),
    },
    safe(async ({ include_done, limit }) => stored("reminders", await listReminders({ includeDone: include_done, limit }))),
  );

  server.tool(
    "update_reminder",
    "Change a custom reminder's text, time or repeat, or mark it done (done: true cancels a pending reminder; " +
      "there is no delete tool). Moving a finished reminder to a new time reopens it.",
    {
      id: z.string().uuid(),
      text: z.string().min(1).optional(),
      at: z.string().datetime({ offset: true }).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local date in the owner's time zone"),
      time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe("Local time HH:MM in the owner's time zone"),
      repeat: z.enum(REMINDER_REPEATS as [string, ...string[]]).optional(),
      about: z.object({ kind: z.enum(REMINDER_ABOUT), id: z.string().uuid() }).nullable().optional().describe("null detaches it"),
      done: z.boolean().optional(),
    },
    safe(async ({ id, at, about, repeat, ...rest }) =>
      ok(
        await saveReminder({
          ...rest,
          id,
          at: at ? new Date(at) : undefined,
          repeat: repeat as (typeof REMINDER_REPEATS)[number] | undefined,
          about: about === undefined ? undefined : about && { type: about.kind, id: about.id },
        }),
      ),
    ),
  );

  // ---------- what's in motion: commitments, interactions, facts ----------

  server.tool(
    "upsert_commitment",
    "Record a commitment (omit id) or update one (pass id; omitted fields are left as they are). Kinds: " +
      "'todo' (something the owner must do), 'i_owe' (the owner promised someone), 'waiting_on' (someone promised the owner), " +
      "'decision' (a decision made, recorded as done; put the rationale in notes). Set status 'done' or 'dropped' to close a loop. " +
      "A to-do can carry steps (a checklist), links (web pages, or athena://<kind>/<id> for things in Athena) and a priority. " +
      "steps and links each replace the whole list: to change one step, pass the list back with that step changed, keeping each step's id. " +
      EXTRACTION_RULES,
    {
      id: z.string().uuid().optional(),
      title: z.string().optional().describe("Required when creating. Short and actionable: 'Send Priya the intro deck'"),
      kind: z.enum(COMMITMENT_KINDS).optional().describe("Defaults to 'todo'"),
      status: z.enum(["open", "done", "dropped"]).optional(),
      due_on: isoDate.nullable().optional().describe("When it's due; null clears"),
      notes: z.string().optional().describe("Context, or a decision's rationale"),
      person_id: z.string().uuid().nullable().optional().describe("Counterparty: owed to / waiting on / decided with"),
      area: z.string().max(40).optional().describe("Which part of the owner's life, only when it's obvious: Work, Personal, Health, Money, Family, Home. Leave out when unsure; Athena sets it from the source and the words when it's clear"),
      where: z.string().max(40).optional().describe("Where or how it gets done, only when it's obvious: Computer, Phone, Errands, Home, Office, With someone. Leave out when unsure"),
      steps: z
        .array(z.union([z.string().max(300), z.object({ id: z.string().max(40).optional(), text: z.string().max(300), done: z.boolean().optional() })]))
        .max(100)
        .optional()
        .describe(`The checklist, in order; replaces the existing one. Plain strings for new steps: ['Call the surgery', 'Ask about the repeat']. ${STEPS_RULE_SHORT}`),
      links: z
        .array(z.union([z.string().max(2000), z.object({ id: z.string().max(40).optional(), url: z.string().max(2000), title: z.string().max(200).optional() })]))
        .max(30)
        .optional()
        .describe("Pages and things in Athena it needs, replacing the existing list: https addresses, or athena://person/<id> and the like"),
      priority: z.number().int().min(0).max(3).optional().describe("0 none (default), 1 low, 2 medium, 3 high. Only when the source says how urgent it is"),
      ...provenanceSchema,
    },
    safe(async ({ area, where, ...args }) =>
      ok(await upsertCommitment({ ...args, ...(area || where ? { context: { suggestion: { area, where, sure: (args.confidence ?? 1) >= 0.8 } } } : {}) })),
    ),
  );

  server.tool(
    "list_open_loops",
    "Open commitments — todos, what the owner owes people, what they're waiting on — soonest due first. Optionally just one person's.",
    { person_id: z.string().uuid().optional() },
    safe(async ({ person_id }) => stored("commitments", await listOpenLoops({ personId: person_id }))),
  );

  server.tool(
    "log_interaction",
    "Log that the owner spoke with one or more people (a meeting, call, message thread, email exchange or in person). " +
      "Each person's last-contacted date moves forward, which clears them from catch-up reminders. Re-logging the same " +
      "source_ref updates the earlier entry. " +
      EXTRACTION_RULES,
    {
      person_ids: z.array(z.string().uuid()).min(1).describe("Who it was with"),
      at: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
      channel: z.enum(CHANNELS).optional().describe("Defaults to 'other'"),
      summary: z.string().optional().describe("One or two sentences: what was discussed"),
      source: z.string().optional(),
      source_ref: z.string().optional(),
    },
    safe(async (args) => ok(await logInteraction(args))),
  );

  server.tool(
    "add_fact",
    "Remember a small, durable fact about a person, place, organisation or the owner ('me'): e.g. key 'Kids', value " +
      "'Maya (7) and Leo (4)'; 'Coffee order' → 'Oat flat white'; 'Dietary' → 'Vegetarian'. One current value per key: " +
      "a new value supersedes the old one (kept as history). Never store finance, health or ID numbers here. " +
      "A fact about the owner ('me') isn't saved straight away: it goes to the owner's Inbox, whatever the confidence, " +
      "and the result is that suggestion. " +
      EXTRACTION_RULES,
    {
      subject_kind: z.enum(["me", "person", "place", "organisation"]),
      subject_id: z.string().uuid().optional().describe("Required unless subject_kind is 'me'"),
      key: z.string().describe("Short label, sentence case: 'Partner', 'Kids', 'Allergies', 'Favourite restaurant'"),
      value: z.string(),
      observed_at: z.string().optional().describe("When this was true/said; ISO 8601, defaults to now"),
      ...provenanceSchema,
    },
    safe(async (args) => ok(await addFact(args))),
  );

  server.tool(
    "list_facts",
    "Current facts about a person, place, organisation or the owner ('me'); history=true includes superseded values.",
    {
      subject_kind: z.enum(["me", "person", "place", "organisation"]),
      subject_id: z.string().uuid().optional(),
      history: z.boolean().optional(),
    },
    safe(async ({ subject_kind, subject_id, history }) =>
      stored("facts", await listFacts({ subjectKind: subject_kind, subjectId: subject_id ?? null, history })),
    ),
  );

  server.tool(
    "resolve_person",
    "Who is this? Match an email, phone number, Slack handle and/or name to existing people, strongest match first " +
      "(matched_on tells you how). Call this before creating anyone, so the same person isn't added twice.",
    {
      email: z.string().optional(),
      phone: z.string().optional(),
      slack: z.string().optional(),
      name: z.string().optional(),
    },
    safe(async (args) => stored("people", await resolvePerson(args))),
  );

  server.tool(
    "add_identity",
    "Teach Athena another way to recognise a person: an extra email, phone, Slack handle or alias/nickname. " +
      "Fails if it already belongs to someone else (then the two may be duplicates — tell the owner, don't merge).",
    {
      person_id: z.string().uuid(),
      kind: z.enum(["email", "phone", "slack", "alias", "other"]),
      value: z.string(),
    },
    safe(async (args) => ok(await addIdentity(args))),
  );

  server.tool(
    "propose",
    "File a suggestion in the owner's review inbox instead of writing directly — use it whenever confidence < 0.8. " +
      "op says what accepting will do; payload holds the same fields as the matching tool: 'commitment' → upsert_commitment, " +
      "'fact' → add_fact, 'interaction' → log_interaction, 'event' → upsert_event, 'person' → upsert_person, 'link' → link. " +
      "The same op + summary + source_ref is never filed twice, even after the owner rejects it.",
    {
      op: z.enum(["commitment", "fact", "interaction", "event", "person", "link"]),
      summary: z.string().describe("One plain sentence the owner will read: 'You owe Priya the intro deck by Friday'"),
      payload: z.record(z.unknown()),
      ...provenanceSchema,
    },
    safe(async (args) => ok(await propose(args))),
  );

  server.tool(
    "person_brief",
    "Everything to know before speaking to someone: their profile, current facts, identities, recent interactions, " +
      "open loops both ways, recent decisions with them, and things they recommended.",
    { id: z.string().uuid().describe("Person ID") },
    safe(async ({ id }) => {
      const brief = await personBrief(id);
      return brief ? stored("person brief", brief) : fail(`Person ${id} not found`);
    }),
  );

  server.tool(
    "recall",
    "Ranked full-text search across notes, commitments, interactions, facts, people and the watch & read list " +
      "(English stemming; supports \"quoted phrases\", OR and -exclusions). Prefer this over search_notes for questions.",
    {
      query: z.string(),
      limit: z.number().int().positive().max(50).optional().describe("Defaults to 20"),
    },
    safe(async ({ query, limit }) => stored("recall", await recall(query, limit))),
  );

  server.tool(
    "weekly_review",
    "The weekly review: what got done, decisions, who the owner saw, what's still open, who's overdue a catch-up, " +
      "goals, and next week's dates and deadlines.",
    { week_start: isoDate.optional().describe("Any date in the week; defaults to this week") },
    safe(async ({ week_start }) => stored("weekly review", await weeklyReview(week_start))),
  );

  // ---------- life admin, watch & read, goals ----------

  server.tool(
    "upsert_asset",
    "Track something that renews or expires (omit id to create, pass id to update): passport, driving licence, insurance, " +
      "car MOT/tax, warranty, subscription, home, pet, health. renews_on drives reminders (default 30, 7 and 0 days before). " +
      "NEVER put passport, policy, licence or account numbers here.",
    {
      id: z.string().uuid().optional(),
      name: z.string().optional().describe("Required when creating: 'Passport', 'Car insurance', 'Netflix'"),
      kind: z.enum(ASSET_KINDS).optional(),
      provider: z.string().optional().describe("e.g. 'Direct Line', 'HM Passport Office'"),
      renews_on: isoDate.nullable().optional().describe("Renewal or expiry date"),
      remind_days_before: z.array(z.number().int().min(0).max(365)).optional(),
      notes: z.string().optional(),
    },
    safe(async (args) => ok(await upsertAsset(args))),
  );

  server.tool("list_assets", "Life-admin items, soonest renewal first.", {}, safe(async () => stored("life admin", await withCustomFieldsList("asset", await listAssets()))));

  server.tool(
    "upsert_reading_item",
    "Add something to the watch & read list (books, films, TV shows, articles, videos, podcasts, music, games, papers, …) " +
      "with no id, or update an item by id. Set kind from what it is: 'film', 'tv' for a TV series, 'music' for an album or " +
      "song; 'Dune (the film)' is a film, 'Dune' the novel a book. status works the same for every kind: 'queued' = not " +
      "started yet, 'reading' = in progress (reading, watching, listening or playing), 'done' = finished. For \"I've " +
      "finished The Bear\", find it with list_reading or recall and set status 'done' on its id. Saving the same URL twice " +
      "returns the existing item. progress is how far through it they are: pages or episodes (with a total if known) or " +
      "a percent; null clears it.",
    {
      id: z.string().uuid().optional(),
      title: z.string().optional().describe("Required when creating. Its name only: 'Dune', not 'Dune (film)'"),
      url: z.string().optional(),
      kind: z.enum(READING_KINDS).optional().describe("Defaults to 'article' when creating"),
      author: z.string().optional().describe("Who made it: author, director, artist, the podcast's show, the game's studio"),
      status: z.enum(["queued", "reading", "done"]).optional(),
      notes: z.string().optional().describe("Highlights and takeaways, Markdown; where they're up to in a TV show ('Up to S2')"),
      recommended_by: z.string().uuid().nullable().optional().describe("Person who recommended it"),
      source: z.string().optional(),
      progress: z
        .object({
          unit: z.enum(PROGRESS_UNITS).describe("'page' for a book or paper, 'episode' for a show or podcast, 'percent' for anything"),
          done: z.number().int().min(0).describe("Pages read, episodes seen, or the percent (0–100)"),
          total: z.number().int().min(1).nullable().optional().describe("Out of how many pages or episodes, if known; leave out for a percent"),
        })
        .nullable()
        .optional()
        .describe("How far through it they are; null clears it"),
    },
    safe(async (args) => ok(await upsertReadingItem({ ...args, progress: args.progress === undefined ? undefined : args.progress && { ...args.progress, total: args.progress.total ?? null } }))),
  );

  server.tool(
    "list_reading",
    "The watch & read list (books, films, TV shows, podcasts, music, games, …): in progress first, then queued, then finished. Each item has its progress (pages, episodes or a percent) or null.",
    { status: z.enum(["queued", "reading", "done"]).optional() },
    safe(async ({ status }) => stored("watch & read", await withCustomFieldsList("reading", await listReading({ status })))),
  );

  server.tool(
    "upsert_goal",
    "Create a goal (omit id) or update one (progress 0–100, status 'done'/'dropped').",
    {
      id: z.string().uuid().optional(),
      title: z.string().optional().describe("Required when creating"),
      period: z.enum(["week", "month", "quarter", "year"]).optional(),
      target: z.string().optional().describe("What done looks like"),
      progress: z.number().int().min(0).max(100).optional(),
      status: z.enum(["active", "done", "dropped"]).optional(),
      due_on: isoDate.nullable().optional(),
      notes: z.string().optional(),
    },
    safe(async (args) => ok(await upsertGoal(args))),
  );

  server.tool("list_goals", "Goals: active first (soonest due), then finished.", {}, safe(async () => stored("goals", await withCustomFieldsList("goal", await listGoals()))));

  // ---------- trips and purchases (read only: the email collection writes them) ----------

  /** A trip as Claude reads it: its name and dates, and each booking as one line in the place's own time. */
  const describeTrip = (t: Trip, today: string, tz: string) => ({
    ...t,
    name: tripLabel(t, today),
    bookings: t.bookings.map((b) => ({ ...b, line: bookingLine(b, today, tz) })),
  });

  server.tool(
    "list_trips",
    "The owner's trips, from booking emails: upcoming and in progress first (soonest first), then past ones if asked. Each trip has a name " +
      "(\"Lisbon, 12–15 Mar\") and its bookings (flights, trains, hotels, car hire, tickets), each with a one-line summary in the local time of " +
      "where it happens, its reference, seat and places. Times: starts_at/ends_at are UTC; start_tz/end_tz are the places' zones.",
    {
      include_past: z.boolean().optional().describe("Also list trips that have ended; defaults to false"),
      limit: z.number().int().positive().max(100).optional(),
    },
    safe(async ({ include_past, limit }) => {
      const { today, tz } = await ownerToday();
      const trips = await listTrips({ upcomingOnly: !include_past, limit, today });
      return stored("trips, from booking emails", trips.map((t) => describeTrip(t, today, tz)));
    }),
  );

  server.tool(
    "get_trip",
    "One trip by id, with all its bookings (archived trips are not returned).",
    { id: z.string().uuid() },
    safe(async ({ id }) => {
      const trip = await getTrip(id);
      if (!trip) return fail(`Trip ${id} not found`);
      const { today, tz } = await ownerToday();
      return stored("trips, from booking emails", describeTrip(trip, today, tz));
    }),
  );

  server.tool(
    "list_purchases",
    "The owner's orders, from order and delivery emails: what's still on its way (soonest expected first), with where each has got to " +
      "(\"Arriving today\", \"Out for delivery\"), carrier, tracking and a short timeline. Never holds prices. include_delivered adds ones " +
      "that have arrived, been returned or refunded in the last 30 days.",
    { include_delivered: z.boolean().optional().describe("Also list delivered, returned, refunded and cancelled orders; defaults to false") },
    safe(async ({ include_delivered }) => {
      const { today, tz } = await ownerToday();
      const purchases = await listPurchases({ inProgressOnly: !include_delivered });
      return stored("purchases, from order emails", purchases.map((p) => ({ ...p, name: purchaseName(p), where: deliveryState(p, today, tz).label })));
    }),
  );

  server.tool(
    "get_purchase",
    "One purchase by id, with its delivery timeline (archived ones are not returned).",
    { id: z.string().uuid() },
    safe(async ({ id }) => {
      const p = await getPurchase(id);
      if (!p) return fail(`Purchase ${id} not found`);
      const { today, tz } = await ownerToday();
      return stored("purchases, from order emails", { ...p, name: purchaseName(p), where: deliveryState(p, today, tz).label });
    }),
  );

  // ---------- metrics ----------

  server.tool(
    "upsert_metric",
    "Record a non-sensitive metric data point (habit count, meeting hours, issue throughput, etc). " +
      "Never put real finance or health figures here: Athena's own health, money and home paths " +
      "seal those (see SECURITY.md §1); this tool's value/metadata are stored in plaintext.",
    {
      metric: z.string().describe("Metric name, e.g. 'weight_kg' or 'focus_minutes'"),
      value: z.number().describe("Numeric value for this data point"),
      recordedAt: z.coerce.date().optional().describe("ISO 8601 timestamp; defaults to now"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary JSON metadata for this point"),
    },
    async (args) => {
      try {
        return ok(await upsertMetric(args));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "query_metrics",
    "Query time-series points for a metric, optionally since a given timestamp.",
    {
      metric: z.string().describe("Metric name to query"),
      since: z.coerce.date().optional().describe("Only return points recorded at/after this ISO 8601 timestamp"),
      limit: z.number().int().positive().max(1000).optional().describe("Max results; defaults to 200"),
    },
    safe(async ({ metric, since, limit }) => stored("metrics", await queryMetrics(metric, since, limit))),
  );

  // ---------- the owner's own fields (netlify/lib/mcp/custom-fields.ts) ----------

  registerCustomFieldTools(server, { ok, stored, fail, safe });

  // ---------- the owner's own kinds of record (netlify/lib/mcp/custom-kinds.ts) ----------

  registerCustomKindTools(server, { ok, stored, fail, safe });

  // ---------- Saved actions (netlify/lib/mcp/saved-actions.ts) ----------

  registerSavedActionTools(server, { ok, stored, fail, safe });

  // ---------- Logging: spending, health, a day's entry, a meter reading (netlify/lib/mcp/logging.ts) ----------

  registerLoggingTools(server, { ok, stored, fail, safe });

  // ---------- Check-ins, read only (netlify/lib/mcp/checkins.ts) ----------

  registerCheckinTools(server, { ok, stored, fail, safe });

  return server;
}

const unscoped = async (req: Request, _context: Context) => {
  // The master token, a full key or an MCP-only key (lib/api-keys.ts).
  if (!(await authorized(req, "mcp"))) return new Response("Unauthorized", { status: 401 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
};

// AI spend: every model call in this function counts as background work for "mcp" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "mcp" }, () => unscoped(...args));

export const config: Config = { path: "/mcp" };
