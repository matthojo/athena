/**
 * Athena's REST API, hosted as a Netlify Function.
 *
 * Consumed by the offline-first PWA (app/) and the dashboard — same
 * bearer-token auth as the MCP server, reused from netlify/lib/mcp/bearer.ts,
 * since both are just different front doors onto lib/db.ts.
 *
 * Routing is a plain pathname/method dispatch (no router library): Netlify
 * forwards every request under /api/* here per the `config.path` below, and
 * we split `new URL(req.url).pathname` into segments ourselves.
 *
 * Unlike MCP, this API can permanently delete (DELETE /api/<kind>/:id) and
 * list archived items (GET /api/archived): both exist for the app's own
 * manual Archived page and nothing else. See SECURITY.md ("Archive vs delete").
 * Merging people (POST /api/people/:id/merge) and forgetting an identity are
 * app-only for the same reason.
 *
 * Layer 2 (lib/memory.ts): /api/{commitments|interactions|facts|assets|reading|goals}[/:id]
 * with the same archive/unarchive suffixes, /api/identities, /api/suggestions
 * (/:id/accept, /:id/reject), /api/people/resolve, /api/people/:id/brief,
 * /api/recall, /api/today and /api/review/week.
 *
 * GET /api/week-review?from&to&tz: the Days week and month in review's extras
 * (lib/week-review.ts): goals moved on, events with a person at a place, places seen before.
 *
 * GET /api/week-moments, PUT and DELETE /api/week-moments/:monday: each week's kept
 * moment, its cover in Days (lib/week-moments.ts).
 *
 * GET /api/graph is the Graph page's one read: every live node and the links
 * between them (lib/graph.ts).
 *
 * Rich links in notes (netlify/lib/rich-links/routes.ts): GET
 * /api/link-preview?url=, /api/link-preview/:id/image and /favicon,
 * /api/places/:id/map and /api/link-map?url=.
 *
 * Trips and purchases (lib/trips.ts): /api/trips[/:id], /api/bookings/:id (and
 * /live, a train's live status) and
 * /api/purchases[/:id], with the same archive/unarchive suffixes. The
 * collector writes them; the app renames a trip or marks a parcel arrived.
 * /api/custom-fields and /api/custom-values are the owner's own fields and
 * their values (netlify/lib/custom-fields-routes.ts, lib/custom-fields.ts).
 * /api/kinds and /api/records are the owner's own kinds of record and their
 * records (netlify/lib/custom-kinds-routes.ts, lib/custom-kinds.ts).
 * /api/ask-threads[/:id] are Ask's saved chats (lib/ask-threads.ts): GET
 * ?since= for what changed plus every live id, PUT /:id to save a whole chat
 * (newest wins), DELETE /:id to delete one. App only, not in MCP.
 *
 * /api/voice/* is served by this same handler, but enters through
 * netlify/functions/voice.ts so those paths can carry a per-IP rate limit
 * (every call spends AI Gateway credits) without limiting sync. /api/talk/*
 * (Talk's listening tokens and speech, spending the owner's ElevenLabs
 * credits) enters through the Netlify Server (netlify/server/), which
 * rate-limits it in code and calls this handler; /api/elevenlabs is the
 * connection itself (netlify/lib/voice/routes.ts).
 *
 * Content is encrypted at rest (SECURITY.md §11): lib/db.ts seals and opens
 * it, so responses carry plaintext over HTTPS as before. GET /api/encryption
 * reports progress; a write this deploy can't seal answers 503 (no key) and
 * one that would overwrite an undecryptable value answers 409.
 */
import { isMoodStyle, loadMoodStyle, MOOD_STYLES, saveMoodStyle } from "../../lib/day-prefs";
import { whatAthenaKnows } from "../../lib/knows";
import { loadAskMoney, saveAskMoney } from "../../lib/money";
import { getOwnerProfile, loadAskWeb, loadProfileSetup, parseProfileEdits, parseSetupChange, saveAskWeb, saveOwnerProfile, saveProfileSetup } from "../../lib/profile";
import type { Config, Context } from "@netlify/functions";
import { authorized, checkBearer } from "../lib/mcp/bearer";
import { DataBoxError } from "../../lib/data-box";
import { encryptionStatus } from "../../lib/encryption";
import { loadNotificationPrefs, pushConfigured, pushCredential, pushEndpoint, saveNotificationPrefs, sendToAll, vapidPublicKey } from "../../lib/push";
import { handleConnectorRoutes, handleOAuthCallback } from "../lib/connectors/routes";
import { handleCustomFieldRoutes } from "../lib/custom-fields-routes";
import { handleCustomKindRoutes } from "../lib/custom-kinds-routes";
import { handleTodoContextRoutes } from "../lib/todo-contexts-routes";
import { handleTodoPeopleRoutes } from "../lib/todo-people-routes";
import { handleDocumentRoutes } from "../lib/documents-routes";
import { handleRecipeRoutes } from "../lib/recipes-routes";
import { handleWeekMomentRoutes } from "../lib/week-moments-routes";
import { handleSpendRoutes } from "../lib/spend-routes";
import { BudgetReached, BudgetUnchecked, replyIfBudget, spendScope, takeRunAnyway, withSpendScope } from "../../lib/spend";
import { handleTravelRoutes } from "../lib/travel-day-routes";
import { handleCarRoutes } from "../lib/car-routes";
import { MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, VoiceError, audioMimeType } from "../../lib/voice";
import { handleElevenLabsRoutes, handleTalkRoutes, transcribeDictation } from "../lib/voice/routes";
import { applyUndo, runCapture, runPlanTool } from "../../lib/assistant";
import { goPlan, undoPlan } from "../../lib/ask-plans";
import { logChanges, undoActivity } from "../../lib/ask-activity";
import { handleAskRoutes } from "../lib/ask-routes";
import { handleTeamRoutes } from "../lib/team-routes";
import { handleFlowDraftRoutes } from "../lib/flow-draft-routes";
import { handleModelsRoutes, modelChoiceResponse } from "../lib/models-routes";
import { handleFlowSuggestRoutes } from "../lib/flow-suggest-routes";
import { dismissSuggestion, listDismissed, NO_FLOWS, readSignals } from "../../lib/flow-suggest-store";
import { messageModel } from "../../lib/models";
import { handleTeamChatRoutes, type ChatDesk } from "../lib/team-chat-routes";
import { settlePlanPosts } from "../../lib/team-posts";
import { startTeamEvent } from "../../lib/team-triggers";
import { handleSkillRoutes } from "../lib/skills-routes";
import { draftSkill } from "../../lib/skill-draft";
import { answerEvent } from "../../lib/rsvp";
import { calendarPort } from "../lib/connectors/calendar-rsvp";
import { schedulingPort } from "../lib/connectors/calendar-scheduling";
import { handleSchedulingRoutes } from "../lib/scheduling/routes";
import { handleNudgeRoutes } from "../lib/proactive/routes";
import { aiConfigured, RateLimited } from "../../lib/ai";
import { DRAFT_CHANNELS, draftMessage, saveDraft, type DraftChannel } from "../../lib/drafts";
import { API_KEY_SCOPES, createApiKey, listApiKeys, removeApiKey, removeOwnApiKey, type ApiKeyScope } from "../../lib/api-keys";
import { listNoteVersions, restoreNoteVersion } from "../../lib/note-versions";
import { handleHealthDay, handleHealthDays, handleHealthManual, handleHealthSeries, handleHealthSources, handleHealthStatus } from "../lib/health/routes";
import { handlePlacesRoutes } from "../lib/places/routes";
import { handleLifeRoutes } from "../lib/life/routes";
import { handleHabitLog, handleHabitRoutes } from "../lib/habits/routes";
import { mentionById, searchMentions } from "../../lib/mentions-db";
import { LINK_KINDS, type LinkKind } from "../../lib/links";
import { MENTION_LIMIT } from "../../lib/mentions";
import { handleSavedCapture, handleSavedRoutes, readSaveBody } from "../lib/saved/routes";
import { handleTrackerRoutes } from "../lib/trackers/routes";
import { handleCheckinRoutes } from "../lib/checkins/routes";
import { handleRichLinkRoutes } from "../lib/rich-links/routes";
import { saveItem, type SaveRequest } from "../../lib/saved";
import { captureIsLink, SaveTooBig } from "../../lib/saved-rules";
import { getLinkChoices, setLinkChoice } from "../../lib/note-link-choices";
import { handleDaysRoutes } from "../lib/days/routes";
import { handleImportRoutes } from "../lib/days/import-routes";
import { handlePatternsRoutes } from "../lib/patterns/routes";
import { handleArtRoutes } from "../lib/days-art/routes";
import { readingArt } from "../../lib/art";
import { entriesInRange } from "../../lib/days";
import { zonedToday } from "../../lib/dates";
import { daysBetween, monthDays, monthStats, screenTime, shiftDay } from "../../lib/watch-stats";
import { mailPort } from "../lib/connectors/gmail-drafts";
import { slackPort } from "../lib/connectors/slack-drafts";
import { loadDraftChannels, saveDraftChannels } from "../../lib/draft-prefs";
import { parseAnswerHistory, runAsk, type AnswerOptions, type AskReply } from "../../lib/answer";
import { runAssistantTurn } from "../../lib/team-chat";
import { answerStage, openQuestions, readAssignment, sweepAssignments } from "../../lib/assignment-run";
import "../lib/assignment-wiring";
import { asTrackerChecker } from "../../lib/trackers-store";
import { streamError, type StepSink, type StepStreamEvent } from "../../lib/steps";
import type { TextSink } from "../../lib/ask-stream";
import { runHost, type RunWork } from "../server/assistant/host";
import { answerSources } from "../lib/connectors/answer-sources";
import { importAnswerItems, parseImports } from "../lib/connectors/ask-import";
import { deleteAskThread, listAskThreads, saveAskThread } from "../../lib/ask-threads";
import { deletePictureForGood, listArchivedPictures, restorePicture } from "../../lib/images";
import { isDocumentFormat, makeDocument } from "../../lib/document-make-db";
import { attachToNote, deleteFilesForGood, detachFromNote, listNoteFiles, noteFilesInConversations, parseFileIds, readFile, saveFile, sweepFiles, unlinkThread, linkThreadFiles, MAX_FILE_BYTES, MAX_THUMB_BYTES } from "../../lib/files";
import {
  createNote,
  getNote,
  updateNote,
  listNotes,
  searchNotesByKeyword,
  capture,
  listMetricNames,
  queryMetrics,
  upsertMetric,
  listStalePeople,
  upsertPerson,
  upsertPlace,
  upsertOrganisation,
  upsertEvent,
  upsertProject,
  getRecord,
  listRecords,
  linkEntities,
  unlinkEntities,
  archiveEntity,
  unarchiveEntity,
  deleteEntityForever,
  listArchived,
  listUpcoming,
  searchEntities,
  getConnectionsDetailed,
  savePushSubscription,
  getOwnerTimeZone,
  setOwnerTimeZone,
  removePushSubscription,
  saveReminder,
  getReminder,
  listReminders,
  deleteReminder,
  AthenaInputError,
  ENTITY_TYPES,
  EVENT_KINDS,
  type Note,
  type NoteType,
  type EntityType,
  type PageType,
  type RecordKind,
  type EventKind,
  type Rsvp,
  type PersonInput,
  type EventInput,
  type Project,
  type ReminderInput,
  type ArchivableKind,
  type LogisticsKind,
  type MemoryKind,
} from "../../lib/db";
import type { ReminderRepeat } from "../../lib/reminders";
import { loadGraph } from "../../lib/graph";
import { trainStatus } from "../lib/live-travel";
import { primeTravelKeys } from "../lib/travel-key";
import { addBooking, createPurchase, createTrip, editBooking, editPurchase, getBooking, getPurchase, getTrip, listPurchases, listTrips, setPurchaseStatus, updateTrip, type BookingFields, type PurchaseFields } from "../../lib/trips";
import { PURCHASE_STATUSES, type PurchaseStatus } from "../../lib/trip-text";
import {
  acceptSuggestion,
  addFact,
  addIdentity,
  getMemoryItem,
  listAssets,
  listCommitments,
  listFacts,
  listGoals,
  listIdentities,
  listInteractions,
  listReading,
  listSuggestions,
  loadToday,
  logInteraction,
  mergePeople,
  personBrief,
  recall,
  rejectSuggestion,
  removeIdentity,
  resolvePerson,
  updateFact,
  upsertAsset,
  upsertCommitment,
  upsertGoal,
  upsertReadingItem,
  weeklyReview,
  COMMITMENT_KINDS,
  COMMITMENT_STATUSES,
  READING_STATUSES,
  SUGGESTION_STATUSES,
  type AssetInput,
  type CommitmentInput,
  type CommitmentKind,
  type CommitmentStatus,
  type Fact,
  type FactSubjectKind,
  type GoalInput,
  type IdentityKind,
  type InteractionInput,
  type ReadingInput,
  type ReadingItem,
  type ReadingStatus,
  type SuggestionStatus,
} from "../../lib/memory";
import { weekReviewExtras } from "../../lib/week-review";

const NOTE_TYPES = new Set<NoteType>(["note", "daily", "project", "area", "capture"]);
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/** URL collection name -> entity kind. (Custom records: netlify/lib/custom-kinds-routes.ts.) */
const COLLECTIONS: Record<string, Exclude<PageType, "record">> = {
  notes: "note",
  people: "person",
  places: "place",
  organisations: "organisation",
  events: "event",
  projects: "project",
};

/** URL collection name -> layer-2 kind (lib/memory.ts). */
const MEMORY_COLLECTIONS: Record<string, MemoryKind> = {
  commitments: "commitment",
  interactions: "interaction",
  facts: "fact",
  assets: "asset",
  reading: "reading",
  goals: "goal",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- small helpers ----------

function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Athena-Editor, X-Ask-Run",
    Vary: "Origin",
  };
  const origin = req.headers.get("origin");
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(req: Request, data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req), ...headers },
  });
}

function errorResponse(req: Request, status: number, message: string): Response {
  return json(req, { error: message }, status);
}

/** The gateway's minute is used up: 429, with Retry-After in seconds when the gateway said how long (the app waits that long). */
function rateLimitedResponse(req: Request, error: RateLimited): Response {
  return json(req, { error: error.message }, 429, error.retryAfter ? { "Retry-After": String(error.retryAfter), "Access-Control-Expose-Headers": "Retry-After" } : {});
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : undefined;
}

function parseDateString(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseDateParam(url: URL, key: string): Date | undefined {
  return parseDateString(url.searchParams.get(key));
}

/** A string field if present (undefined if absent or the wrong type). */
function str(body: Record<string, unknown>, key: string): string | undefined {
  return typeof body[key] === "string" ? (body[key] as string) : undefined;
}

/** A string-or-null field: undefined = leave alone, null = clear. */
function nullableStr(body: Record<string, unknown>, key: string): string | null | undefined {
  if (body[key] === null) return null;
  if (typeof body[key] === "string") return (body[key] as string) || null;
  return undefined;
}

function stringArray(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : undefined;
}

// ---------- notes ----------

async function handleNotesCollection(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body || typeof body.body !== "string") {
      return errorResponse(req, 400, "Request body must include a 'body' field");
    }
    const title = typeof body.title === "string" && body.title.length > 0 ? body.title : undefined;
    if (!title && body.body.length === 0) {
      return errorResponse(req, 400, "A note needs a 'title' or a non-empty 'body'");
    }
    const type = typeof body.type === "string" && NOTE_TYPES.has(body.type as NoteType) ? (body.type as NoteType) : undefined;
    const source = str(body, "source");
    const tags = stringArray(body.tags);

    const note = title
      ? await createNote({ title, body: body.body, type, source, tags })
      : await capture({ text: body.body, source });
    // A note made with tags is a Team event; a matching assistant starts now (lib/team-triggers.ts). Never throws.
    if (note.tags?.length) await startTeamEvent("note", note.id, "note", { title: note.title, tags: note.tags, kind: note.type }, { origin: new URL(req.url).origin });
    return json(req, note, 201);
  }

  if (req.method === "GET") {
    const since = parseDateParam(url, "since");
    const typeParam = url.searchParams.get("type");
    if (typeParam && !NOTE_TYPES.has(typeParam as NoteType)) {
      return errorResponse(req, 400, `Invalid 'type': must be one of ${[...NOTE_TYPES].join(", ")}`);
    }
    const type = typeParam ? (typeParam as NoteType) : undefined;
    const source = url.searchParams.get("source") ?? undefined;
    // `include_archived=1` lets the PWA's incremental sync learn that a note
    // it has cached was archived elsewhere (it then drops it locally).
    const includeArchived = url.searchParams.get("include_archived") === "1";
    const notes = await listNotes({ type, since, source, limit: parseLimit(url), includeArchived });
    return json(req, { notes });
  }

  return errorResponse(req, 405, "Method not allowed");
}

async function handleNoteItem(req: Request, url: URL, id: string): Promise<Response> {
  if (req.method === "GET") {
    const note = await getNote(id, { includeArchived: url.searchParams.get("include_archived") === "1" });
    return note ? json(req, note) : errorResponse(req, 404, "Note not found");
  }

  if (req.method === "PATCH") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");

    const patch: Partial<Pick<Note, "title" | "body" | "type" | "tags" | "source">> = {};
    if (typeof body.title === "string") patch.title = body.title;
    if (typeof body.body === "string") patch.body = body.body;
    if (typeof body.type === "string" && NOTE_TYPES.has(body.type as NoteType)) patch.type = body.type as NoteType;
    if (Array.isArray(body.tags)) patch.tags = stringArray(body.tags);
    if (typeof body.source === "string") patch.source = body.source;

    // Every edit keeps the earlier version (lib/note-versions.ts). The app's editor says who it is, so the owner's
    // typing is grouped (one version per 10 minutes); anything else on this route is a script with a full key.
    const note = await updateNote(id, patch, { by: req.headers.get("x-athena-editor") === "1" ? "owner" : "api" });
    return note ? json(req, note) : errorResponse(req, 404, "Note not found");
  }

  if (req.method === "DELETE") {
    // ?files=delete: the owner also chose to delete its files, even where a conversation still has them.
    const files = url.searchParams.get("files") === "delete" && UUID_RE.test(id) ? (await listNoteFiles(id)).map((f) => f.id) : [];
    const deleted = await deleteEntityForever("note", id);
    // Its files go too, unless another note or a conversation uses them.
    const removed = deleted && files.length ? await deleteFilesForGood(files) : [];
    if (deleted) await sweepFiles();
    return deleted ? json(req, { deleted: true, ...(removed.length ? { files_deleted: removed } : {}) }) : errorResponse(req, 404, "Note not found");
  }

  return errorResponse(req, 405, "Method not allowed");
}

/**
 * GET /api/notes/:id/versions: what the note held before each change, with who made it, newest first.
 * POST /api/notes/:id/versions/:version/restore: put one back (what it replaces is kept as a version too). lib/note-versions.ts.
 */
async function handleNoteVersions(req: Request, id: string, versionId: string | undefined, action: string | undefined): Promise<Response> {
  if (!versionId) {
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    return json(req, { versions: await listNoteVersions(id) });
  }
  if (action !== "restore" || !UUID_RE.test(versionId)) return errorResponse(req, 404, "Not found");
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const note = await restoreNoteVersion(id, versionId);
  return note ? json(req, note) : errorResponse(req, 404, "Version not found");
}

async function handleSearch(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const query = url.searchParams.get("q");
  if (!query) return errorResponse(req, 400, "Missing required query param 'q'");
  const results = await searchNotesByKeyword(query, parseLimit(url));
  return json(req, { results });
}

// ---------- people / places / organisations / events / projects ----------

function personInput(body: Record<string, unknown>): PersonInput {
  const input: PersonInput = {
    name: str(body, "name"),
    notes: str(body, "notes"),
    relationship: str(body, "relationship"),
    email: str(body, "email"),
    phone: str(body, "phone"),
  };
  if (body.catch_up_days === null) input.catch_up_days = null;
  else if (typeof body.catch_up_days === "number" && body.catch_up_days > 0) input.catch_up_days = Math.floor(body.catch_up_days);
  if (typeof body.keep_in_touch === "boolean") input.keep_in_touch = body.keep_in_touch;
  const contacted = nullableStr(body, "last_contacted_at");
  if (contacted === null) input.last_contacted_at = null;
  else if (contacted !== undefined) {
    const d = parseDateString(contacted);
    if (!d) throw new AthenaInputError("Invalid 'last_contacted_at': use an ISO date or timestamp");
    input.last_contacted_at = d.toISOString();
  }
  input.birthday = nullableStr(body, "birthday");
  const org = nullableStr(body, "organisation_id");
  if (org !== undefined && org !== null && !UUID_RE.test(org)) throw new AthenaInputError("Invalid 'organisation_id'");
  input.organisation_id = org;
  return input;
}

function eventInput(body: Record<string, unknown>): EventInput {
  const kind = str(body, "kind");
  if (kind !== undefined && !EVENT_KINDS.includes(kind as EventKind)) {
    throw new AthenaInputError(`Invalid 'kind': must be one of ${EVENT_KINDS.join(", ")}`);
  }
  const recurrence = str(body, "recurrence");
  if (recurrence !== undefined && recurrence !== "none" && recurrence !== "yearly") {
    throw new AthenaInputError("Invalid 'recurrence': must be none or yearly");
  }
  const remind = Array.isArray(body.remind_days_before)
    ? body.remind_days_before.filter((n): n is number => typeof n === "number")
    : undefined;
  const personId = nullableStr(body, "person_id");
  if (personId && !UUID_RE.test(personId)) throw new AthenaInputError("Invalid 'person_id'");
  const tz = str(body, "tz");
  return {
    title: str(body, "title"),
    kind: kind as EventKind | undefined,
    date: str(body, "date"),
    time: nullableStr(body, "time"),
    starts_at: nullableStr(body, "starts_at"),
    tz: tz || undefined,
    recurrence: recurrence as EventInput["recurrence"],
    year_known: typeof body.year_known === "boolean" ? body.year_known : undefined,
    remind_days_before: remind,
    notes: str(body, "notes"),
    person_id: personId,
  };
}

/** Create (no id) or update (id) one record of `kind` from a JSON body. */
async function upsertRecord(kind: RecordKind, id: string | undefined, body: Record<string, unknown>) {
  switch (kind) {
    case "person":
      return upsertPerson({ ...personInput(body), id });
    case "event":
      return upsertEvent({ ...eventInput(body), id });
    case "place":
      return upsertPlace({ id, name: str(body, "name"), address: str(body, "address"), url: str(body, "url"), notes: str(body, "notes") });
    case "organisation":
      return upsertOrganisation({ id, name: str(body, "name"), website: str(body, "website"), notes: str(body, "notes") });
    case "project": {
      const status = str(body, "status");
      if (status !== undefined && !["active", "paused", "done"].includes(status)) {
        throw new AthenaInputError("Invalid 'status': must be active, paused or done");
      }
      return upsertProject({ id, name: str(body, "name"), status: status as Project["status"] | undefined, description: str(body, "description") });
    }
  }
}

async function handleRecordCollection(req: Request, url: URL, kind: RecordKind, collection: string): Promise<Response> {
  if (req.method === "GET") {
    const items = await listRecords(kind, parseLimit(url));
    // `items` is the generic shape; the collection-named key (e.g. `people`)
    // keeps older clients of GET /api/people working.
    return json(req, { items, [collection]: items });
  }
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    // Back-compat: POST /api/people with an `id` updates that person.
    const id = typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : undefined;
    return json(req, await upsertRecord(kind, id, body), id ? 200 : 201);
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleRecordItem(req: Request, url: URL, kind: RecordKind, id: string): Promise<Response> {
  if (req.method === "GET") {
    const record = await getRecord(kind, id, { includeArchived: url.searchParams.get("include_archived") === "1" });
    return record ? json(req, record) : errorResponse(req, 404, "Not found");
  }
  if (req.method === "PATCH") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    return json(req, await upsertRecord(kind, id, body));
  }
  if (req.method === "DELETE") {
    const deleted = await deleteEntityForever(kind, id);
    return deleted ? json(req, { deleted: true }) : errorResponse(req, 404, "Not found");
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleArchiveToggle(req: Request, kind: ArchivableKind, id: string, action: string): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const done = action === "archive" ? await archiveEntity(kind, id) : await unarchiveEntity(kind, id);
  return done ? json(req, { kind, id, archived: action === "archive" }) : errorResponse(req, 404, "Not found");
}

async function handleStalePeople(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw ? Number(daysRaw) : undefined;
  const people = await listStalePeople(Number.isFinite(days) && (days as number) > 0 ? days : undefined);
  return json(req, { people });
}

// ---------- PA views ----------

async function handleUpcoming(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const days = Number(url.searchParams.get("days") ?? 6);
  // The app passes its own zone so "today" and times match the device it's on.
  const tz = url.searchParams.get("tz") ?? undefined;
  return json(req, await listUpcoming(Number.isFinite(days) && days >= 0 ? Math.min(days, 366) : 6, new Date(), tz));
}

async function handleEntitySearch(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const kinds = (url.searchParams.get("kinds") ?? "")
    .split(",")
    .filter((k): k is EntityType => ENTITY_TYPE_SET.has(k));
  const results = await searchEntities(url.searchParams.get("q") ?? "", { kinds, limit: parseLimit(url) });
  return json(req, { results });
}

async function handleConnections(req: Request, kind: string, id: string): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  if (!ENTITY_TYPE_SET.has(kind)) return errorResponse(req, 400, `Unknown kind '${kind}'`);
  return json(req, await getConnectionsDetailed(kind as EntityType, id));
}

async function handleLinks(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "DELETE") return errorResponse(req, 405, "Method not allowed");
  const body = await parseJsonBody(req);
  if (
    !body ||
    typeof body.sourceType !== "string" ||
    typeof body.sourceId !== "string" ||
    typeof body.targetType !== "string" ||
    typeof body.targetId !== "string" ||
    !ENTITY_TYPE_SET.has(body.sourceType) ||
    !ENTITY_TYPE_SET.has(body.targetType) ||
    !UUID_RE.test(body.sourceId) ||
    !UUID_RE.test(body.targetId)
  ) {
    return errorResponse(
      req,
      400,
      `Request body must include sourceType, sourceId, targetType, targetId (types one of ${ENTITY_TYPES.join("|")})`,
    );
  }
  const relation = typeof body.relation === "string" ? body.relation : undefined;
  const args = {
    sourceType: body.sourceType as EntityType,
    sourceId: body.sourceId,
    targetType: body.targetType as EntityType,
    targetId: body.targetId,
    relation,
  };
  if (req.method === "DELETE") return json(req, { removed: await unlinkEntities(args) });
  return json(req, await linkEntities(args), 201);
}

/**
 * GET /api/pictures/archived, POST /api/pictures/:thread/:file/restore, DELETE /api/pictures/:thread/:file: a picture
 * Ask made and the owner undid waits here, like anything archived (SECURITY.md §7). Delete is the app's only.
 */
async function handleArchivedPictures(req: Request, rest: string[]): Promise<Response> {
  if (rest.length === 1 && rest[0] === "archived") {
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    return json(req, { pictures: await listArchivedPictures() });
  }
  const [thread, file, action] = rest;
  if (!UUID_RE.test(thread ?? "") || !UUID_RE.test(file ?? "")) return errorResponse(req, 404, "Not found");
  if (action === "restore" && rest.length === 3) {
    if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
    return (await restorePicture(thread, file)) ? json(req, { ok: true }) : errorResponse(req, 404, "That picture isn't archived");
  }
  if (!action && rest.length === 2) {
    if (req.method !== "DELETE") return errorResponse(req, 405, "Method not allowed");
    return json(req, { ok: true, deleted: await deletePictureForGood(thread, file) });
  }
  return errorResponse(req, 404, "Not found");
}

async function handleArchived(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  return json(req, { items: await listArchived(parseLimit(url)) });
}

// ---------- custom reminders ----------

/** Body -> ReminderInput: text, at (ISO 8601) or date/time (in `tz`, else the owner's zone), repeat, about {kind,id}|null, done. */
function reminderInput(body: Record<string, unknown>): ReminderInput {
  const input: ReminderInput = {};
  if (body.text !== undefined) {
    if (typeof body.text !== "string") throw new AthenaInputError("'text' must be a string");
    input.text = body.text;
  }
  if (body.at !== undefined && body.at !== null) {
    const at = parseDateString(body.at);
    if (!at) throw new AthenaInputError("'at' must be an ISO 8601 timestamp");
    input.at = at;
  }
  if (typeof body.date === "string") input.date = body.date;
  if (typeof body.time === "string") input.time = body.time;
  // The app sends its own zone, as it does for events, so the day and time are the ones typed.
  if (typeof body.tz === "string" && body.tz) input.tz = body.tz;
  if (typeof body.repeat === "string") input.repeat = body.repeat as ReminderRepeat;
  if (body.about === null) input.about = null;
  else if (body.about && typeof body.about === "object") {
    const about = body.about as Record<string, unknown>;
    const kind = about.kind ?? about.type;
    if (typeof kind !== "string" || !ENTITY_TYPE_SET.has(kind) || typeof about.id !== "string" || !UUID_RE.test(about.id)) {
      throw new AthenaInputError("'about' must be { kind, id } with a known kind and a UUID");
    }
    input.about = { type: kind as EntityType, id: about.id };
  }
  if (typeof body.done === "boolean") input.done = body.done;
  return input;
}

async function handleRemindersCollection(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET") {
    const includeDone = url.searchParams.get("include_done") === "1";
    return json(req, { reminders: await listReminders({ includeDone, limit: parseLimit(url) }) });
  }
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Request body must be JSON");
    return json(req, await saveReminder(reminderInput(body)), 201);
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleReminderItem(req: Request, id: string): Promise<Response> {
  if (req.method === "GET") {
    const reminder = await getReminder(id);
    return reminder ? json(req, reminder) : errorResponse(req, 404, "Reminder not found");
  }
  if (req.method === "PATCH") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Request body must be JSON");
    return json(req, await saveReminder({ ...reminderInput(body), id }));
  }
  if (req.method === "DELETE") {
    return (await deleteReminder(id)) ? json(req, { deleted: true }) : errorResponse(req, 404, "Reminder not found");
  }
  return errorResponse(req, 405, "Method not allowed");
}

// ---------- layer 2: what's in motion (lib/memory.ts) ----------

function num(body: Record<string, unknown>, key: string): number | undefined {
  return typeof body[key] === "number" && Number.isFinite(body[key]) ? (body[key] as number) : undefined;
}

function numberArray(raw: unknown): number[] | undefined {
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : undefined;
}

/** Provenance fields an agent (or the app, as 'manual') may send with a write. */
function provenance(body: Record<string, unknown>) {
  const confidence = body.confidence === null ? null : num(body, "confidence");
  return {
    source: str(body, "source"),
    source_ref: str(body, "source_ref"),
    source_quote: str(body, "source_quote"),
    confidence,
  };
}

function commitmentInput(body: Record<string, unknown>): CommitmentInput {
  const personId = nullableStr(body, "person_id");
  if (personId && !UUID_RE.test(personId)) throw new AthenaInputError("Invalid 'person_id'");
  return {
    ...provenance(body),
    title: str(body, "title"),
    kind: str(body, "kind") as CommitmentKind | undefined,
    status: str(body, "status") as CommitmentStatus | undefined,
    due_on: nullableStr(body, "due_on"),
    notes: str(body, "notes"),
    person_id: personId,
    area_id: nullableStr(body, "area_id"),
    where_id: nullableStr(body, "where_id"),
  };
}

function interactionInput(body: Record<string, unknown>): InteractionInput {
  const ids = stringArray(body.person_ids);
  if (ids?.some((id) => !UUID_RE.test(id))) throw new AthenaInputError("Invalid id in 'person_ids'");
  return {
    at: str(body, "at"),
    channel: str(body, "channel") as InteractionInput["channel"],
    summary: str(body, "summary"),
    person_ids: ids,
    source: str(body, "source"),
    source_ref: str(body, "source_ref"),
  };
}

function assetInput(body: Record<string, unknown>): AssetInput {
  return {
    name: str(body, "name"),
    kind: str(body, "kind") as AssetInput["kind"],
    provider: str(body, "provider"),
    renews_on: nullableStr(body, "renews_on"),
    remind_days_before: numberArray(body.remind_days_before),
    notes: str(body, "notes"),
  };
}

function readingInput(body: Record<string, unknown>): ReadingInput {
  const by = nullableStr(body, "recommended_by");
  if (by && !UUID_RE.test(by)) throw new AthenaInputError("Invalid 'recommended_by'");
  return {
    title: str(body, "title"),
    url: str(body, "url"),
    kind: str(body, "kind") as ReadingInput["kind"],
    author: str(body, "author"),
    status: str(body, "status") as ReadingInput["status"],
    notes: str(body, "notes"),
    recommended_by: by,
    source: str(body, "source"),
    // { unit, done, total } or null; checked in upsertReadingItem (lib/watch-read.ts parseProgress).
    progress: body.progress as ReadingInput["progress"],
    // The owner's tags, the whole list; checked in upsertReadingItem.
    ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
  };
}

function goalInput(body: Record<string, unknown>): GoalInput {
  return {
    title: str(body, "title"),
    period: str(body, "period") as GoalInput["period"],
    target: str(body, "target"),
    progress: num(body, "progress"),
    status: str(body, "status") as GoalInput["status"],
    due_on: nullableStr(body, "due_on"),
    notes: str(body, "notes"),
  };
}

function optionalUuid(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  if (!UUID_RE.test(raw)) throw new AthenaInputError(`Invalid '${key}'`);
  return raw;
}

/** Create (no id) or update (id) one layer-2 item from a JSON body. Facts update in place via updateFact. */
async function upsertMemory(kind: MemoryKind, id: string | undefined, body: Record<string, unknown>) {
  switch (kind) {
    case "commitment":
      return upsertCommitment({ ...commitmentInput(body), id });
    case "interaction":
      return logInteraction({ ...interactionInput(body), id });
    case "fact":
      if (id) return updateFact(id, { key: str(body, "key"), value: str(body, "value") });
      return addFact({
        ...provenance(body),
        subject_kind: str(body, "subject_kind") as FactSubjectKind,
        subject_id: nullableStr(body, "subject_id"),
        key: str(body, "key") ?? "",
        value: str(body, "value") ?? "",
        observed_at: str(body, "observed_at"),
      });
    case "asset":
      return upsertAsset({ ...assetInput(body), id });
    case "reading":
      return upsertReadingItem({ ...readingInput(body), id });
    case "goal":
      return upsertGoal({ ...goalInput(body), id });
  }
}

async function listMemory(kind: MemoryKind, url: URL) {
  const limit = parseLimit(url);
  switch (kind) {
    case "commitment": {
      const status = url.searchParams.get("status") ?? "open";
      if (status !== "all" && !COMMITMENT_STATUSES.includes(status as CommitmentStatus)) {
        throw new AthenaInputError(`Invalid 'status': must be all or one of ${COMMITMENT_STATUSES.join(", ")}`);
      }
      const kinds = (url.searchParams.get("kind") ?? "")
        .split(",")
        .filter((k): k is CommitmentKind => COMMITMENT_KINDS.includes(k as CommitmentKind));
      return listCommitments({
        status: status as CommitmentStatus | "all",
        kinds,
        personId: optionalUuid(url, "person_id"),
        doneSince: parseDateParam(url, "done_since"),
        limit,
      });
    }
    case "interaction":
      return listInteractions({
        personId: optionalUuid(url, "person_id"),
        since: parseDateParam(url, "since"),
        until: parseDateParam(url, "until"),
        limit,
      });
    case "fact": {
      const subjectKind = (url.searchParams.get("subject_kind") ?? "me") as FactSubjectKind;
      return listFacts({ subjectKind, subjectId: optionalUuid(url, "subject_id") ?? null, history: url.searchParams.get("history") === "1" });
    }
    case "asset":
      return listAssets(limit);
    case "reading": {
      const status = url.searchParams.get("status") ?? undefined;
      if (status && !READING_STATUSES.includes(status as ReadingStatus)) throw new AthenaInputError("Invalid 'status'");
      return listReading({ status: status as ReadingStatus | undefined, limit });
    }
    case "goal":
      return listGoals(limit);
  }
}

async function handleMemoryCollection(req: Request, url: URL, kind: MemoryKind, context?: Context): Promise<Response> {
  if (req.method === "GET") {
    const items = await listMemory(kind, url);
    if (kind !== "reading") return json(req, { items });
    // What isn't known about a title yet (length, genres, playlists) is looked up after the reply (netlify/lib/watch-enrich.ts).
    if ((items as ReadingItem[]).some((r) => !r.meta?.checked)) {
      const learning = import("../lib/watch-enrich").then((m) => m.enrichReading({ budgetMs: 8000 })).catch(() => undefined);
      if (context?.waitUntil) context.waitUntil(learning);
    }
    // Watch & read carries its posters and covers (lib/art.ts); new ones are fetched for at most 1.5 s a request.
    const withArt = await readingArt(items as Parameters<typeof readingArt>[0], { budgetMs: 1500, waitUntil: context?.waitUntil?.bind(context) });
    // A long history (hundreds of liked videos) would take many loads at 1.5 s each: after the reply, carry on for up to 20 s more.
    // Covers already kept, and sources known to have none, cost one query and no request.
    if (context?.waitUntil && withArt.some((r) => !r.art)) {
      context.waitUntil(readingArt(withArt, { budgetMs: 20_000 }).then(() => undefined, () => undefined));
    }
    return json(req, { items: withArt });
  }
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    return json(req, await upsertMemory(kind, undefined, body), 201);
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleMemoryItem(req: Request, url: URL, kind: MemoryKind, id: string): Promise<Response> {
  if (req.method === "GET") {
    const item = await getMemoryItem(kind, id, url.searchParams.get("include_archived") === "1");
    return item ? json(req, item) : errorResponse(req, 404, "Not found");
  }
  if (req.method === "PATCH") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    return json(req, await upsertMemory(kind, id, body));
  }
  if (req.method === "DELETE") {
    const deleted = await deleteEntityForever(kind, id);
    return deleted ? json(req, { deleted: true }) : errorResponse(req, 404, "Not found");
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleIdentities(req: Request, url: URL, id: string | undefined): Promise<Response> {
  if (id) {
    if (req.method !== "DELETE") return errorResponse(req, 405, "Method not allowed");
    return (await removeIdentity(id)) ? json(req, { deleted: true }) : errorResponse(req, 404, "Not found");
  }
  if (req.method === "GET") {
    const personId = optionalUuid(url, "person_id");
    if (!personId) return errorResponse(req, 400, "Missing 'person_id'");
    return json(req, { items: await listIdentities(personId) });
  }
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    const identity = await addIdentity({
      person_id: str(body, "person_id") ?? "",
      kind: str(body, "kind") as IdentityKind,
      value: str(body, "value") ?? "",
    });
    return json(req, identity, 201);
  }
  return errorResponse(req, 405, "Method not allowed");
}

/** Sources that are the owner's own words: typed in the app, told to Ask, or none given. */
const OWNER_FACT_SOURCES = new Set(["manual", "assistant", "app"]);

/**
 * Facts the owner wrote or said yes to: their own, and ones accepted from
 * the Review inbox. A collection's fact that skipped the inbox isn't here,
 * so Home never shows something the owner hasn't seen.
 */
async function acceptedFacts(facts: Fact[]): Promise<Fact[]> {
  const accepted = new Set((await listSuggestions({ status: "accepted", limit: 1000 })).filter((s) => s.op === "fact" && s.result_id).map((s) => s.result_id!));
  return facts
    .filter((f) => !f.source || OWNER_FACT_SOURCES.has(f.source) || accepted.has(f.id))
    .sort((a, b) => Date.parse(String(b.observed_at)) - Date.parse(String(a.observed_at)));
}

/** The open lines on someone's gift ideas lists ("<Name> · Gift ideas", linked to them). Ticked lines were given. */
async function giftIdeasFor(personId: string): Promise<string[]> {
  const { outgoing, backlinks } = await getConnectionsDetailed("person", personId);
  const ids = [...new Set([...outgoing, ...backlinks].filter((c) => c.kind === "note" && /gift/i.test(c.title)).map((c) => c.id))];
  const notes = await Promise.all(ids.map((n) => getNote(n)));
  const out: string[] = [];
  for (const n of notes) {
    if (!n || !/gift/i.test(n.title)) continue;
    for (const line of n.body.split("\n")) {
      const m = /^\s*[-*] \[ \] (.+)$/.exec(line);
      const text = m?.[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out.slice(0, 20);
}

async function handlePersonExtras(req: Request, id: string, action: string): Promise<Response> {
  if (action === "brief") {
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    const brief = await personBrief(id);
    if (!brief) return errorResponse(req, 404, "Not found");
    // Home's "thinking of them" sheet: their gift ideas and what the owner wrote or accepted about them.
    const [gift_ideas, accepted_facts] = await Promise.all([giftIdeasFor(id), acceptedFacts(brief.facts)]);
    return json(req, { ...brief, gift_ideas, accepted_facts });
  }
  // merge: fold `duplicate_id` into this person (app only; the duplicate is archived).
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const body = await parseJsonBody(req);
  const duplicate = body ? str(body, "duplicate_id") : undefined;
  if (!duplicate || !UUID_RE.test(duplicate)) return errorResponse(req, 400, "Missing or invalid 'duplicate_id'");
  return json(req, await mergePeople(id, duplicate));
}

async function handleResolvePerson(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  return json(req, { matches: await resolvePerson({ email: get("email"), phone: get("phone"), slack: get("slack"), name: get("name") }) });
}

async function handleSuggestions(req: Request, url: URL, id: string | undefined, action: string | undefined): Promise<Response> {
  if (!id) {
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    const status = (url.searchParams.get("status") ?? "pending") as SuggestionStatus;
    if (!SUGGESTION_STATUSES.includes(status)) return errorResponse(req, 400, "Invalid 'status'");
    return json(req, { items: await listSuggestions({ status, limit: parseLimit(url) }) });
  }
  if (req.method !== "POST" || (action !== "accept" && action !== "reject")) return errorResponse(req, 404, "Not found");
  if (action === "reject") return json(req, { suggestion: await rejectSuggestion(id) });
  const body = (await parseJsonBody(req)) ?? {};
  const edits = body.edits && typeof body.edits === "object" && !Array.isArray(body.edits) ? (body.edits as Record<string, unknown>) : {};
  return json(req, await acceptSuggestion(id, edits));
}

async function handleRecall(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const query = url.searchParams.get("q");
  if (!query) return errorResponse(req, 400, "Missing required query param 'q'");
  return json(req, { results: await recall(query, parseLimit(url)) });
}

// Both take an optional ?tz= (the app's zone, like /upcoming); without it they use the owner's.
async function handleToday(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  return json(req, await loadToday(new Date(), url.searchParams.get("tz") ?? undefined));
}

async function handleWeeklyReview(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  return json(req, await weeklyReview(url.searchParams.get("start") ?? undefined, new Date(), url.searchParams.get("tz") ?? undefined));
}

// ---------- trips and purchases (lib/trips.ts) ----------

/** URL collection name -> archivable kind. */
const LOGISTICS_COLLECTIONS: Record<string, LogisticsKind> = { trips: "trip", bookings: "booking", purchases: "purchase" };

/** The booking fields a body gives: each one given replaces what's there, "" clears it. */
const BOOKING_TEXT = ["kind", "status", "title", "provider", "reference", "segment", "start_local", "start_tz", "start_place", "start_city", "end_local", "end_tz", "end_place", "end_city", "seat", "details"] as const;
function bookingBody(body: Record<string, unknown>): Partial<BookingFields> {
  const out: Record<string, string> = {};
  for (const k of BOOKING_TEXT) if (typeof body[k] === "string") out[k] = body[k] as string;
  return out as Partial<BookingFields>;
}

/** The order fields a body gives. Never a price: there's nowhere to put one. */
function purchaseBody(body: Record<string, unknown>): Partial<PurchaseFields> {
  const out: Partial<PurchaseFields> = {};
  for (const k of ["retailer", "order_number", "carrier", "tracking_number", "tracking_url"] as const) if (typeof body[k] === "string") out[k] = body[k] as string;
  for (const k of ["ordered_on", "expected_on"] as const) {
    const v = nullableStr(body, k);
    if (v !== undefined) out[k] = v || null;
  }
  const items = stringArray(body.items);
  if (items) out.items = items;
  const status = str(body, "status");
  if (status !== undefined) {
    if (!PURCHASE_STATUSES.includes(status as PurchaseStatus)) throw new AthenaInputError(`Invalid 'status': must be one of ${PURCHASE_STATUSES.join(", ")}`);
    out.status = status as PurchaseStatus;
  }
  return out;
}

/**
 * /api/trips[/:id] (GET; POST a trip you add; PATCH title, notes and, on
 * yours, dates), /api/bookings[/:id] (GET; POST one you add to a trip; PATCH
 * any of its fields), /api/purchases[/:id] (GET; POST an order you add;
 * PATCH status or any field), each with /archive and /unarchive, and DELETE
 * for the app's Archived page. What you add here is `source: "manual"`, and
 * the collector's tools never change it (lib/trips.ts).
 */
async function handleLogistics(req: Request, url: URL, kind: LogisticsKind, collection: string, id: string | undefined, action: string | undefined): Promise<Response> {
  if (id && !UUID_RE.test(id)) return errorResponse(req, 404, "Not found");
  if (id && (action === "archive" || action === "unarchive")) return handleArchiveToggle(req, kind, id, action);
  // A train's live status for the Trips card: null when it's off, too far ahead or National Rail has nothing (netlify/lib/live-travel.ts).
  if (id && action === "live" && kind === "booking") {
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    const booking = await getBooking(id);
    if (!booking) return errorResponse(req, 404, "Not found");
    return json(req, { status: await trainStatus(booking).catch(() => null) });
  }
  if (action) return errorResponse(req, 404, "Not found");
  const includeArchived = url.searchParams.get("include_archived") === "1";
  if (!id) {
    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      if (!body) return errorResponse(req, 400, "Invalid JSON body");
      if (kind === "trip") {
        return json(req, await createTrip({ title: str(body, "title") ?? "", starts_on: nullableStr(body, "starts_on"), ends_on: nullableStr(body, "ends_on"), notes: str(body, "notes") }), 201);
      }
      if (kind === "booking") {
        const tripId = str(body, "trip_id");
        if (tripId !== undefined && !UUID_RE.test(tripId)) return errorResponse(req, 400, "Invalid 'trip_id'");
        const f = bookingBody(body);
        const saved = await addBooking({ ...f, kind: f.kind ?? "other", title: f.title ?? "", start_local: f.start_local ?? "", start_tz: f.start_tz ?? "", trip_id: tripId, trip_destination: str(body, "trip_destination") } as Parameters<typeof addBooking>[0]);
        // Merged with the same booking from an email: still one booking, sent back like a new one.
        const { before: _before, ...added } = saved;
        return json(req, added, 201);
      }
      return json(req, (await createPurchase({ ...purchaseBody(body), retailer: str(body, "retailer") ?? "" })).purchase, 201);
    }
    if (req.method !== "GET" || kind === "booking") return errorResponse(req, 405, "Method not allowed");
    const items = kind === "trip" ? await listTrips({ limit: parseLimit(url) }) : await listPurchases({ limit: parseLimit(url) });
    return json(req, { items });
  }
  if (req.method === "GET") {
    const item = kind === "trip" ? await getTrip(id, { includeArchived }) : kind === "booking" ? await getBooking(id, { includeArchived }) : await getPurchase(id, { includeArchived });
    return item ? json(req, item) : errorResponse(req, 404, "Not found");
  }
  if (req.method === "PATCH") {
    const body = await parseJsonBody(req);
    if (!body) return errorResponse(req, 400, "Invalid JSON body");
    if (kind === "trip") {
      return json(req, await updateTrip(id, { title: str(body, "title"), notes: str(body, "notes"), starts_on: nullableStr(body, "starts_on"), ends_on: nullableStr(body, "ends_on") }));
    }
    if (kind === "booking") return json(req, await editBooking(id, bookingBody(body)));
    const patch = purchaseBody(body);
    // Just a status ("It arrived"): the same step the collector's updates make.
    if (Object.keys(patch).length === 1 && patch.status) return json(req, await setPurchaseStatus(id, patch.status));
    return json(req, await editPurchase(id, patch));
  }
  if (req.method === "DELETE") {
    const deleted = await deleteEntityForever(kind, id);
    return deleted ? json(req, { deleted: true }) : errorResponse(req, 404, `${collection} item not found`);
  }
  return errorResponse(req, 405, "Method not allowed");
}

// ---------- push ----------

async function handlePushKey(req: Request): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  // The public half of the VAPID pair is not a secret. Athena makes its own
  // pair when the environment has none (lib/push.ts); null means it can't.
  return json(req, { key: await vapidPublicKey() });
}

async function handlePushSubscribe(req: Request): Promise<Response> {
  const body = await parseJsonBody(req);
  const endpoint = body && typeof body.endpoint === "string" ? body.endpoint : null;
  if (!endpoint || !/^https:\/\//.test(endpoint)) return errorResponse(req, 400, "Missing or invalid 'endpoint'");
  if (req.method === "DELETE") {
    await removePushSubscription(endpoint);
    return json(req, { subscribed: false });
  }
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const keys = body?.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return errorResponse(req, 400, "Missing 'keys.p256dh' / 'keys.auth'");
  }
  // Known push services only, and the subscription is tied to the credential that registered it (security review M5).
  if (!pushEndpoint(endpoint)) return errorResponse(req, 400, "This browser's push service isn't one Athena sends to");
  const credential = pushCredential(req);
  if (!credential) return errorResponse(req, 401, "Unauthorized");
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return errorResponse(req, 400, "Missing 'keys.p256dh' / 'keys.auth'");
  await savePushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth }, credential);
  return json(req, { subscribed: true }, 201);
}

/** Send a test notification to every subscribed device (the Reminders page's "Send a test"). */
async function handlePushTest(req: Request): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  if (!(await pushConfigured())) return errorResponse(req, 503, "Notifications can't be sent from this server yet");
  const result = await sendToAll({ title: "Athena", body: "Notifications are working on this device.", url: "/#/settings/notifications", tag: "athena-test" });
  return json(req, result);
}

/** GET → the owner's notification choices; PUT { briefing?, events?, reminders?, evening?, weekly?, evening_at?, quiet? } changes them (lib/nudges.ts). */
async function handlePushSettings(req: Request): Promise<Response> {
  if (req.method === "GET") return json(req, await loadNotificationPrefs());
  if (req.method !== "PUT") return errorResponse(req, 405, "Method not allowed");
  try {
    return json(req, await saveNotificationPrefs(await parseJsonBody(req)));
  } catch (error) {
    return errorResponse(req, 400, error instanceof Error ? error.message : "Couldn't read those settings");
  }
}

// ---------- settings ----------

/**
 * GET → { timezone, mood_style, draft_channels }. PUT { timezone?, mood_style?,
 * draft_channels? }: the zone the owner's device is in, the Days mood style
 * (lib/day-prefs.ts) and the messaging apps they use for drafts
 * (lib/draft-prefs.ts), the same on every device. Send at least one.
 */
async function handleSettings(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const [timezone, mood_style, draft_channels] = await Promise.all([getOwnerTimeZone(), loadMoodStyle(), loadDraftChannels()]);
    return json(req, { timezone, mood_style, draft_channels });
  }
  if (req.method !== "PUT") return errorResponse(req, 405, "Method not allowed");
  const body = await parseJsonBody(req);
  const tz = body && typeof body.timezone === "string" ? body.timezone : null;
  const style = body?.mood_style;
  const channels = body?.draft_channels;
  if (!tz && style === undefined && channels === undefined) return errorResponse(req, 400, "Missing 'timezone', 'mood_style' or 'draft_channels'");
  if (style !== undefined && !isMoodStyle(style)) return errorResponse(req, 400, `mood_style: one of ${MOOD_STYLES.join(", ")}`);
  if (tz) await setOwnerTimeZone(tz);
  if (style !== undefined) await saveMoodStyle(style);
  const saved = channels !== undefined ? await saveDraftChannels(channels) : undefined;
  return json(req, { ...(tz ? { timezone: tz } : {}), ...(style !== undefined ? { mood_style: style } : {}), ...(saved ? { draft_channels: saved } : {}) });
}

// ---------- the owner's profile (lib/profile.ts) ----------

/**
 * GET /api/profile: the profile by section ("Other" last). PUT /api/profile
 * { values: [{ key, value }] }: the owner's own answers; an empty value
 * archives that key's current fact. GET /api/profile/setup and POST
 * /api/profile/setup { step?, skip?, complete?, restart? }: wizard progress.
 * GET /api/profile/history?key=: that key's values, current and superseded.
 * GET /api/profile/knows: what Athena keeps about the owner (lib/knows.ts).
 * GET and PUT { on } /api/profile/ask-money: "Let Ask read transactions".
 * GET and PUT { on } /api/profile/ask-web: "Let Ask search the web".
 */
async function handleProfile(req: Request, second: string | undefined): Promise<Response> {
  if (second === undefined) {
    if (req.method === "GET") return json(req, { sections: await getOwnerProfile() });
    if (req.method !== "PUT") return errorResponse(req, 405, "Method not allowed");
    return json(req, { sections: await saveOwnerProfile(parseProfileEdits(await parseJsonBody(req))) });
  }
  if (second === "history") {
    // GET /api/profile/history?key=: every value a key has had, newest first (forgotten ones aren't listed).
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    const key = (new URL(req.url).searchParams.get("key") ?? "").trim().toLowerCase();
    if (!key) return errorResponse(req, 400, "Send key: the value's name");
    const facts = await listFacts({ subjectKind: "me", history: true });
    return json(req, { facts: facts.filter((f) => f.key.trim().toLowerCase() === key) });
  }
  if (second === "ask-money") {
    // GET and PUT { on } /api/profile/ask-money: "Let Ask read transactions" (lib/money.ts), off by default.
    if (req.method === "GET") return json(req, { on: await loadAskMoney() });
    if (req.method !== "PUT") return errorResponse(req, 405, "Method not allowed");
    return json(req, await saveAskMoney(await parseJsonBody(req)));
  }
  if (second === "ask-web") {
    // GET and PUT { on } /api/profile/ask-web: "Let Ask search the web" (lib/profile.ts), on by default.
    if (req.method === "GET") return json(req, { on: await loadAskWeb() });
    if (req.method !== "PUT") return errorResponse(req, 405, "Method not allowed");
    return json(req, await saveAskWeb(await parseJsonBody(req)));
  }
  if (second === "knows") {
    // GET /api/profile/knows: what Athena keeps about the owner, for Settings → What Athena knows (lib/knows.ts).
    if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
    return json(req, await whatAthenaKnows());
  }
  if (second !== "setup") return errorResponse(req, 404, "Not found");
  if (req.method === "GET") return json(req, await loadProfileSetup());
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  return json(req, await saveProfileSetup(parseSetupChange(await parseJsonBody(req))));
}

// ---------- voice ----------

/**
 * POST /api/voice/transcribe — the raw recording as the body (Content-Type is
 * its audio type), answered with { text }. The audio is held only for the
 * length of this request; neither it nor the transcript is stored or logged.
 */
// ---------- files (lib/files.ts) ----------

/**
 * POST /api/files (multipart: file, optional thumb, id, width, height, and
 * thread or note): keep a file, sealed, linked to the Ask conversation or
 * note it was added to. GET /api/files/:id[/thumb] sends it back, opened,
 * only to the bearer token. DELETE /api/files/:id?thread= takes it out of a
 * message before it's sent. A note's files: GET/POST /api/notes/:id/files,
 * DELETE /api/notes/:id/files/:fileId.
 * POST /api/notes/:id/document { format: "md" | "docx" } makes the note into
 * a file (lib/document-make-db.ts) and answers { document }; GET
 * /api/files/:id/download sends any file as an attachment under its name.
 */
async function handleFiles(req: Request, url: URL, id: string | undefined, part: string | undefined): Promise<Response> {
  if (!id) {
    if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_FILE_BYTES + MAX_THUMB_BYTES + 64 * 1024) return errorResponse(req, 413, "That file is over 4 MB");
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !file || typeof file === "string") return errorResponse(req, 400, "Send the file as 'file'");
    const thumb = form.get("thumb");
    const thread = form.get("thread");
    const note = form.get("note");
    // A Day's photo (lib/days.ts): the date it's for.
    const day = form.get("day");
    if (typeof thread !== "string" && typeof note !== "string" && typeof day !== "string") return errorResponse(req, 400, "Say which conversation, note or day it's for");
    const meta = await saveFile({
      id: form.get("id"),
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      thumb: thumb && typeof thumb !== "string" ? new Uint8Array(await thumb.arrayBuffer()) : null,
      width: form.get("width"),
      height: form.get("height"),
      link: typeof thread === "string" ? { thread } : typeof note === "string" ? { note } : { day: day as string },
    });
    // Tidy up anything left over while we're here.
    void sweepFiles().catch(() => undefined);
    return json(req, meta, 201);
  }
  if (!UUID_RE.test(id) || (part && part !== "thumb" && part !== "download")) return errorResponse(req, 404, "Not found");
  if (req.method === "DELETE") {
    const thread = url.searchParams.get("thread");
    if (!thread || !UUID_RE.test(thread)) return errorResponse(req, 400, "Say which conversation it's leaving");
    await unlinkThread(thread, id);
    return json(req, { ok: true });
  }
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const found = await readFile(id, { thumb: part === "thumb" });
  if (!found) return errorResponse(req, 404, "File not found");
  const type = part === "thumb" ? "image/jpeg" : part === "download" && found.meta.type === "text/markdown" ? "text/markdown; charset=utf-8" : found.meta.type.startsWith("text/") ? "text/plain; charset=utf-8" : found.meta.type;
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(found.bytes.length),
      // The plain name is for clients that don't read filename*.
      "Content-Disposition":
        part === "download"
          ? `attachment; filename="${found.meta.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`
          : `inline; filename*=UTF-8''${encodeURIComponent(found.meta.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(req),
    },
  });
}

async function handleNoteDocument(req: Request, noteId: string): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const format = (await parseJsonBody(req))?.format;
  if (!isDocumentFormat(format)) return errorResponse(req, 400, "format: md or docx");
  return json(req, { document: await makeDocument(noteId, format) }, 201);
}

async function handleNoteFiles(req: Request, noteId: string, fileId: string | undefined): Promise<Response> {
  if (fileId) {
    if (!UUID_RE.test(fileId)) return errorResponse(req, 404, "Not found");
    if (req.method !== "DELETE") return errorResponse(req, 405, "Method not allowed");
    await detachFromNote(noteId, fileId);
    return json(req, { ok: true });
  }
  if (req.method === "GET") {
    // in_conversation: a conversation still has it, so deleting the note offers to delete it too.
    const [files, held] = await Promise.all([listNoteFiles(noteId), noteFilesInConversations(noteId)]);
    return json(req, { files: files.map((f) => ({ ...f, in_conversation: held.has(f.id) })) });
  }
  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    const [id] = parseFileIds([body?.file_id]);
    if (!id) return errorResponse(req, 400, "Say which file");
    if (!(await attachToNote(noteId, id))) return errorResponse(req, 404, "Note or file not found");
    return json(req, { files: await listNoteFiles(noteId) });
  }
  return errorResponse(req, 405, "Method not allowed");
}

// ---------- assistant ----------

/**
 * POST /api/assistant { question, history?, files?, earlier?, skill?, thread_id? }: Ask. Every message goes
 * to one loop (lib/answer.ts runAsk) that reads Athena, the connected accounts and the web, and makes, plans or
 * prepares whatever the owner asked to be changed. Nothing in front of it decides whether a message is a question
 * or an instruction. It answers with one reply: the text and its sources, and the receipts, choices, cards and
 * plan of anything it did. Sent with Accept: application/x-ndjson it streams its steps and then the reply's words
 * as they're written (stepStream); without it the reply is plain JSON. It enters through the Netlify Server
 * (netlify/server/routes/assistant.ts), which rate-limits it in code: every request spends AI Gateway credits.
 * POST /api/assistant/undo { undo } reverses one change from a reply; sent with the change's `activity_id` it's
 * recorded in What Ask did (lib/ask-activity.ts).
 * POST /api/assistant/import { imports } saves the account items a reply cited and Athena didn't have
 * (ask-import.ts), and answers with a receipt.
 * POST /api/assistant/plan { id, ticked? } runs a plan's ticked steps (Go, lib/ask-plans.ts) and
 * POST /api/assistant/plan-undo { id } undoes them all; here, so Go's model calls (a draft) share the rate limit.
 */
/** The app asked for live steps (Ask). Siri capture, MCP and everything else get the plain JSON reply. */
const wantsSteps = (req: Request) => (req.headers.get("accept") ?? "").includes("application/x-ndjson");

/**
 * A reply streamed as NDJSON: a {type:"step"} line for each thing Athena does
 * (lib/steps.ts), then {type:"done", reply} with the same reply the JSON
 * route sends, or {type:"error", status, message}. A blank line every 10
 * seconds keeps a quiet connection open. If the app goes away, the run stops
 * before its next step starts (the step callback throws): the step in hand
 * finishes, so nothing is left half-made, and the app can safely ask again
 * when nothing that changes anything had started.
 */
function stepStream(req: Request, run: RunWork): Response | Promise<Response> {
  // On the Netlify Server a run that names itself (X-Ask-Run) outlives the app and can be picked up again (netlify/server/assistant/runs.ts).
  const hosted = runHost.current?.(req, run, corsHeaders(req));
  if (hosted) return hosted;
  const encoder = new TextEncoder();
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StepStreamEvent | null) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(event ? `${JSON.stringify(event)}\n` : "\n"));
        } catch {
          closed = true;
        }
      };
      const beat = setInterval(() => send(null), 10_000);
      const onStep: StepSink = (step) => {
        if (closed && !step.done) throw new Error("Ask stopped listening, so Athena stopped too");
        send({ type: "step", ...step });
      };
      // The reply's words as they're written (lib/ask-stream.ts). Once the app has gone, the model's stream is cut off too.
      const onText: TextSink = (text) => {
        if (closed) throw new Error("Ask stopped listening, so Athena stopped too");
        send({ type: "text", ...text });
      };
      try {
        send({ type: "done", reply: await run(onStep, onText) });
      } catch (error) {
        if (closed) console.warn("Athena assistant (streamed): the app went away part-way", error instanceof Error ? error.message : error);
        // A 429 carries the gateway's wait in seconds when it gave one (`retry_after`): a stream has no header for it.
        else if (streamError(error)) send({ type: "error", ...streamError(error)! });
        else {
          console.error("Athena assistant (streamed) failed:", error);
          send({ type: "error", status: 500, message: "Internal server error" });
        }
      } finally {
        clearInterval(beat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // already gone
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", ...corsHeaders(req) },
  });
}

/**
 * Team chat's way to the assignments side (lib/assignment-run.ts). What's typed in a thread answers the stage
 * that asked when it has one open question; with several, the reply asks the owner to pick. A stage waiting for
 * approval or for Go isn't answered by typing: that goes to Ask, which may approve a checkpoint and never a change.
 */
const askingStage = async (assignmentId: string) => (await readAssignment(assignmentId))?.stages.find((s) => s.status === "waiting" && s.waits_for === "answer") ?? null;
const chatDesk: ChatDesk = {
  waitingStage: async (id) => (await askingStage(id))?.id ?? null,
  useSuggestions: (id, fromHere) => answerStage(id, { use: "suggested", from_here: fromHere }),
  answerStage: async (id, text) => {
    const stage = await askingStage(id);
    const open = stage ? openQuestions(stage) : [];
    if (!stage || !open.length) throw new AthenaInputError("Nothing is waiting for an answer");
    if (open.length > 1) throw new AthenaInputError(`${stage.who.name} asked ${open.length} questions. Pick an answer under each, or tap Use suggestions.`);
    // One question: the owner's words are the answer. A choice typed in another case is that choice.
    const said = text.replace(/\s+/g, " ").trim();
    await answerStage(id, [{ id: open[0].id, answer: open[0].choices.find((c) => c.toLowerCase() === said.toLowerCase()) ?? said }]);
  },
};

async function handleAssistant(req: Request, action: string | undefined): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const body = await parseJsonBody(req);
  const ports = { calendar: calendarPort, scheduling: schedulingPort };
  if (action === "undo") {
    if (!body?.undo && !body?.activity_id) return errorResponse(req, 400, "Missing 'undo'");
    try {
      // From a reply or What Ask did: the log's row says how it went.
      if (typeof body?.activity_id === "string" && UUID_RE.test(body.activity_id)) await undoActivity(body.activity_id, (op) => applyUndo(op, ports));
      else await applyUndo(body!.undo, ports);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") return errorResponse(req, 400, "That can't be undone");
      throw error;
    }
    return json(req, { ok: true });
  }
  if (action === "plan") {
    // Go: the plan's ticked steps, in order, each with its receipt (lib/ask-plans.ts). Nothing was written before this.
    const run = (tool: string, input: unknown) => runPlanTool(tool, input, { gmail: mailPort, slack: slackPort, ...ports });
    const went = await goPlan(body?.id, body?.ticked, { run, log: logChanges });
    // A stage of an assignment that waited on this plan moves on now, not at the next reminders pass (lib/assignment-run.ts).
    await sweepAssignments().catch((error) => console.warn("Athena assignments: sweep after a Go failed", error instanceof Error ? error.message : error));
    // A Go on a Team run's plan settles its post in Team chat (lib/team-posts.ts).
    await settlePlanPosts(body?.id).catch(() => 0);
    return json(req, went);
  }
  if (action === "plan-undo") {
    return json(req, await undoPlan(body?.id, (id) => undoActivity(id, (op) => applyUndo(op, ports))));
  }
  if (action === "save-draft") {
    // Into Gmail or Outlook Drafts for the owner to send; never sent from here.
    if (!body || typeof body.connector_id !== "string" || !UUID_RE.test(body.connector_id)) return errorResponse(req, 400, "Say which email account");
    const reply = body.reply as { connector_id?: unknown; message_id?: unknown } | null | undefined;
    return json(
      req,
      await saveDraft(
        {
          connector_id: body.connector_id,
          to: (stringArray(body.to) ?? []).slice(0, 20),
          subject: (str(body, "subject") ?? "").slice(0, 300),
          body: (str(body, "body") ?? "").slice(0, 20_000),
          reply: reply && typeof reply.connector_id === "string" && typeof reply.message_id === "string" ? { connector_id: reply.connector_id, message_id: reply.message_id } : null,
        },
        { mail: mailPort },
      ),
    );
  }
  if (!aiConfigured()) return errorResponse(req, 503, "Athena's assistant needs Netlify AI Gateway (or an ANTHROPIC_API_KEY) on this site");
  if (action === "skill-draft") {
    // "Make this a skill": a draft for the editor (lib/skill-draft.ts). Nothing is saved here.
    const turns = (Array.isArray(body?.messages) ? (body.messages as unknown[]) : [])
      .filter((m): m is { role: string; text: string } => !!m && typeof m === "object" && typeof (m as { text?: unknown }).text === "string")
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), text: m.text.slice(0, 4000) }));
    try {
      return json(req, await draftSkill(turns));
    } catch (error) {
      if (error instanceof RateLimited) return errorResponse(req, 429, error.message);
      if (error instanceof Error && /nothing in this conversation|couldn't draft/.test(error.message)) return errorResponse(req, 400, error.message);
      throw error;
    }
  }
  if (action === "import") {
    // What an answer cited from the accounts and Athena doesn't have, saved as its collection would (ask-import.ts).
    const imports = parseImports(body?.imports);
    if (!imports.length) return errorResponse(req, 400, "Nothing to save");
    try {
      return json(req, await importAnswerItems(imports));
    } catch (error) {
      if (error instanceof RateLimited) return errorResponse(req, 429, error.message);
      throw error;
    }
  }
  if (action === "draft") {
    if (!body) return errorResponse(req, 400, "Say what the message is for");
    const id = (k: string) => (typeof body[k] === "string" && UUID_RE.test(body[k] as string) ? (body[k] as string) : undefined);
    const channelOf = (v: unknown) => (DRAFT_CHANNELS as readonly unknown[]).includes(v) ? (v as DraftChannel) : undefined;
    const previous = body.previous as { subject?: unknown; body?: unknown; channel?: unknown } | undefined;
    try {
      return json(
        req,
        await draftMessage(
          {
            commitmentId: id("commitment_id"),
            personId: id("person_id"),
            recipientName: str(body, "recipient_name")?.slice(0, 200),
            about: str(body, "about")?.slice(0, 1_000),
            channel: channelOf(body.channel),
            instruction: str(body, "instruction")?.slice(0, 500),
            previous:
              previous && typeof previous.subject === "string" && typeof previous.body === "string"
                ? { subject: previous.subject.slice(0, 300), body: previous.body.slice(0, 20_000), channel: channelOf(previous.channel) }
                : undefined,
          },
          { mail: mailPort, slack: slackPort },
        ),
      );
    } catch (error) {
      if (error instanceof RateLimited) return errorResponse(req, 429, error.message);
      throw error;
    }
  }
  // Anything else under /api/assistant/ isn't Ask's one route (the old /route and /answer went with the merge).
  if (action) return errorResponse(req, 404, "Not found");
  // The message, in either shape: { question, history } (the app), or { messages } ending with the owner's (older callers).
  const turns = (Array.isArray(body?.messages) ? (body.messages as unknown[]) : []).filter(
    (m): m is { role?: unknown; text: string; files?: unknown; earlier?: unknown } => !!m && typeof m === "object" && typeof (m as { text?: unknown }).text === "string",
  );
  const lastTurn = turns.length && turns[turns.length - 1].role !== "assistant" ? turns[turns.length - 1] : null;
  const files = parseFileIds(body?.files ?? lastTurn?.files);
  const question = (str(body ?? {}, "question") ?? lastTurn?.text ?? "").trim().slice(0, 4_000) || (files.length ? "What's in this, and what should I know about it?" : "");
  if (!question) return errorResponse(req, 400, "Send your message as 'question'");
  const history = parseAnswerHistory(body?.history ?? (lastTurn ? turns.slice(0, -1) : []));
  const earlier = parseFileIds(body?.earlier ?? lastTurn?.earlier);
  // A skill picked with "/" (lib/skills-ask.ts), and the conversation for What Ask did and a plan's link back.
  const skill = typeof body?.skill === "string" && UUID_RE.test(body.skill) ? body.skill : null;
  const thread_id = typeof body?.thread_id === "string" && UUID_RE.test(body.thread_id) ? body.thread_id : null;
  // Ask's train_status checks for a key without waiting (live-travel.ts liveTravelConfigured): read the stored ones first.
  await primeTravelKeys();
  const deps = { sources: answerSources, gmail: mailPort, slack: slackPort, calendar: calendarPort, scheduling: schedulingPort };
  // A model for this message only (docs/ai-models.md): checked like a choice (agreement, listed, can think), never stored.
  let model: Awaited<ReturnType<typeof messageModel>>;
  try {
    model = await messageModel(body?.model);
  } catch (error) {
    const refused = modelChoiceResponse(error, (d, s) => json(req, d, s));
    if (refused) return refused;
    throw error;
  }
  const opts: AnswerOptions = { history, files, earlier, skill, thread_id, ...(model ? { model } : {}) };
  // An app left open across the deploy still sends { messages } and reads `changes` and `choices` as lists: they're always there for it.
  const shaped = async (reply: Promise<AskReply>): Promise<AskReply> => (lastTurn && !str(body ?? {}, "question") ? { changes: [], choices: [], ...(await reply) } : reply);
  // Talking to one of the Team's assistants (docs/team.md): lib/team-chat.ts runs the same loop as it, with its persona, allowlist and memory.
  const assistantId = typeof body?.assistantId === "string" && UUID_RE.test(body.assistantId) ? body.assistantId : null;
  // AI spend: a chat with an assistant counts toward its cap. At the budget the reply says so, with Allow more (lib/spend.ts).
  // When the budget can't be checked, the reply offers Run anyway: this message again with its one-time `run_anyway`.
  const runAnyway = takeRunAnyway(body?.run_anyway);
  const turn = (more: Pick<AnswerOptions, "onStep" | "onText" | "careful" | "beforeChange">): Promise<AskReply> =>
    withSpendScope({ ...spendScope(), runAnyway }, () =>
      assistantId
        ? withSpendScope({ area: "assistant", assistantId }, () => asTrackerChecker(assistantId, () => runAssistantTurn(assistantId, question, { mode: "chat", threadId: thread_id, ...deps, ...opts, ...more })).then((r) => r.reply))
        : runAsk(question, deps, { ...opts, ...more }),
    ).catch(replyIfBudget<AskReply>);
  if (wantsSteps(req)) return stepStream(req, (onStep, onText, care) => shaped(turn({ onStep, onText, ...care })));
  try {
    return json(req, await shaped(turn({})));
  } catch (error) {
    if (error instanceof RateLimited) return rateLimitedResponse(req, error);
    throw error;
  }
}

/** What a Shortcut sent: JSON or a form (`text`, and `url` from the share sheet), or plain text. */
async function captureText(req: Request): Promise<string> {
  const type = req.headers.get("content-type") ?? "";
  const pick = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "");
  if (type.includes("application/json")) {
    const body = await parseJsonBody(req);
    return [pick(body?.text ?? body?.input), pick(body?.url)].filter(Boolean).join("\n");
  }
  if (type.includes("form")) {
    const form = await req.formData().catch(() => null);
    return [pick(form?.get("text") ?? form?.get("input")), pick(form?.get("url"))].filter(Boolean).join("\n");
  }
  return await req.text();
}

/**
 * POST /api/assistant/capture: something said to Siri or shared to the
 * Athena Shortcut, filed the way Ask files it (lib/assistant.ts
 * runCapture: filing tools only, nothing read back). The reply is a fixed
 * line of plain text for the Shortcut to show or speak ("Added a to-do."),
 * or JSON with ?format=json. If Claude can't be reached, or files nothing,
 * it's still kept: saved as an inbox note to sort later.
 */
async function handleCapture(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const asJson = url.searchParams.get("format") === "json";
  const reply = (status: number, text: string, changes: unknown[] = []) =>
    asJson
      ? json(req, { reply: text, changes }, status)
      : new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(req) } });
  // An image shared to the Shortcut, or text that is (or starts with) a link, goes to Saved instead of the assistant.
  const copy = req.clone();
  if (/multipart\/form-data/i.test(req.headers.get("content-type") ?? "")) {
    const body = await readSaveBody(copy).catch(() => null);
    if (body instanceof Response) return reply(413, "That image is over 10 MB.");
    if (body && !(body instanceof Response) && body.image?.byteLength) return await captureToSaved(body, reply);
  }
  const text = (await captureText(req)).trim().slice(0, 4_000);
  if (!text) return reply(400, "There was nothing to capture.");
  if (captureIsLink(text)) return await captureToSaved({ text }, reply);
  const keep = async (why: string) => {
    const title = text.split("\n")[0].slice(0, 120);
    await createNote({ title, body: text, type: "capture", tags: ["inbox"], source: "shortcut" });
    return reply(200, why ? `${why} I've saved it to your notes to sort later.` : "Saved to your notes to sort later.");
  };
  if (!aiConfigured()) return keep("Athena's assistant isn't set up.");
  try {
    // A capture key files only (security review H1): no mail, Slack or calendar port, and the reply is a fixed line
    // built by code (lib/assistant.ts captureConfirmation), with the kind and id of what was made. Never model text.
    const answer = await runCapture(text);
    if (!answer.text) return keep("");
    return reply(200, answer.text, answer.changes.map((c) => ({ kind: c.kind, id: c.id })));
  } catch (error) {
    console.error("Athena capture: the assistant failed", error instanceof Error ? error.message : error);
    return keep(error instanceof RateLimited ? "Athena's AI is busy this minute." : error instanceof BudgetReached ? "Today's AI budget is used." : "Athena couldn't file that.");
  }
}

/** File a capture in Saved: "Saved “Title”." for the Shortcut to show or speak. */
async function captureToSaved(body: SaveRequest, reply: (status: number, text: string, changes?: unknown[]) => Response): Promise<Response> {
  try {
    const { item, created } = await saveItem({ ...body, source: "shortcut" });
    const name = item.title ? `“${item.title.length > 80 ? `${item.title.slice(0, 79)}…` : item.title}”` : item.kind === "image" ? "the image" : "it";
    return reply(200, created ? `Saved ${name}.` : `${name.charAt(0).toUpperCase()}${name.slice(1)} was already in Saved.`, [{ kind: "saved", id: item.id }]);
  } catch (error) {
    if (error instanceof SaveTooBig) return reply(413, "That's too long to save.");
    if (error instanceof AthenaInputError) return reply(400, error.message.endsWith(".") ? error.message : `${error.message}.`);
    if (error instanceof DataBoxError) return reply(503, "Athena can't save that right now: its encryption key isn't set.");
    throw error;
  }
}

/**
 * GET/POST /api/api-keys, DELETE /api/api-keys/:id: keys for Shortcuts, Claude, scripts and the app's own devices
 * (lib/api-keys.ts). Master token only: a key, whatever its scope, can't list, make or remove keys, so a leaked
 * one can't mint itself a replacement. POST takes { label (or name), scope } and answers { key, token }.
 * (A key removing itself, DELETE /api/api-keys/self, is handled before the credential gate.)
 */
async function handleApiKeys(req: Request, id: string | undefined): Promise<Response> {
  if (!checkBearer(req)) return json(req, { error: "master_required" }, 403);
  if (!id && req.method === "GET") return json(req, { keys: await listApiKeys() });
  if (!id && req.method === "POST") {
    const body = await parseJsonBody(req);
    const scope = API_KEY_SCOPES.find((s) => s === body?.scope) as ApiKeyScope | undefined;
    if (!scope) return errorResponse(req, 400, "Say whether the key is for capturing only, agent only or full access");
    const label = typeof body?.label === "string" ? body.label : typeof body?.name === "string" ? body.name : "";
    return json(req, await createApiKey(label, scope), 201);
  }
  if (id && req.method === "DELETE") {
    if (!UUID_RE.test(id)) return errorResponse(req, 404, "Not found");
    return (await removeApiKey(id)) ? json(req, { ok: true }) : errorResponse(req, 404, "Not found");
  }
  return errorResponse(req, 405, "Method not allowed");
}

async function handleVoiceTranscribe(req: Request): Promise<Response> {
  if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
  const mimeType = audioMimeType(req.headers.get("content-type"));
  if (!mimeType) return errorResponse(req, 415, "Send the recording as an audio/* body (webm, ogg, mp4, aac, mp3, wav or flac)");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return errorResponse(req, 413, "That recording is too long");
  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) return errorResponse(req, 413, "That recording is too long");
  if (audio.byteLength < MIN_AUDIO_BYTES) return errorResponse(req, 400, "That recording is too short");
  try {
    return json(req, { text: await transcribeDictation(audio, mimeType) });
  } catch (error) {
    if (error instanceof VoiceError) return errorResponse(req, error.status, error.message);
    throw error;
  }
}

// ---------- metrics ----------

async function handleMetricsCollection(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return json(req, { metrics: await listMetricNames() });
  }

  if (req.method === "POST") {
    const body = await parseJsonBody(req);
    if (!body || typeof body.metric !== "string" || typeof body.value !== "number") {
      return errorResponse(req, 400, "Request body must include 'metric' (string) and 'value' (number)");
    }
    const recordedAt = parseDateString(body.recordedAt);
    const metadata = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : undefined;
    const point = await upsertMetric({ metric: body.metric, value: body.value, recordedAt, metadata });
    return json(req, point, 201);
  }

  return errorResponse(req, 405, "Method not allowed");
}

async function handleMetricItem(req: Request, url: URL, metric: string): Promise<Response> {
  if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
  const since = parseDateParam(url, "since");
  const points = await queryMetrics(decodeURIComponent(metric), since, parseLimit(url));
  return json(req, { points });
}

// ---------- entry point ----------

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean); // e.g. ["api", "notes", "<id>"]
  const [, first, second, third] = segments;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // Health check is intentionally unauthenticated so the PWA can detect
  // connectivity before it has a token to send.
  if (first === "health" && segments.length === 2 && req.method === "GET") {
    return json(req, { ok: true });
  }

  // A provider's OAuth redirect lands here in the browser, without the bearer
  // header; the single-use `state` it carries is what authenticates it.
  if (first === "connectors" && second === "oauth" && third === "callback" && segments.length === 4) {
    return await handleOAuthCallback(req, url);
  }

  // An iPhone Shortcut sends captures with a capture-only API key (lib/api-keys.ts), which opens this path and the three below (Saved, health day, habit log).
  if (first === "assistant" && second === "capture" && segments.length === 3) {
    if (!(await authorized(req, "capture"))) return errorResponse(req, 401, "Unauthorized");
    return await withSpendScope({ area: "ask", job: "capture" }, () => handleCapture(req, url));
  }

  // Saving a link, image or quote (the extension, the Share sheet, the share target): the same capture key (netlify/lib/saved/routes.ts).
  if (first === "saved" && ((segments.length === 2 && req.method === "POST") || (second === "ping" && segments.length === 3))) {
    if (!(await authorized(req, "capture"))) return errorResponse(req, 401, "Athena didn't recognise that key. Check it in Settings → API keys.");
    const handled = await handleSavedCapture(req, url, segments, (d, s) => json(req, d, s));
    if (handled) return handled;
  }

  // The Shortcut's health day takes the same capture key (netlify/lib/health/routes.ts).
  if (first === "health" && second === "day" && segments.length === 3) {
    if (!(await authorized(req, "capture"))) return errorResponse(req, 401, "Unauthorized");
    return await handleHealthDay(req, (d, s) => json(req, d, s));
  }

  // The "Log a habit" Shortcut takes the same capture key (netlify/lib/habits/routes.ts).
  if (first === "habits" && second === "log" && segments.length === 3) {
    if (!(await authorized(req, "capture"))) return errorResponse(req, 401, "Unauthorized");
    return await handleHabitLog(req, (d, s) => json(req, d, s));
  }

  // DELETE /api/api-keys/self: a key removes itself (a device signing out). Any scope, no master token; the master
  // token isn't a key, so it gets 400. Before the gate below, which capture and MCP-only keys don't pass.
  if (first === "api-keys" && second === "self" && segments.length === 3) {
    if (req.method !== "DELETE") return errorResponse(req, 405, "Method not allowed");
    if (checkBearer(req)) return errorResponse(req, 400, "The access token isn't a key, so there's nothing to remove");
    if (!(await removeOwnApiKey(req))) return errorResponse(req, 401, "Unauthorized");
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  // Everything else: the master token or a full key. An MCP-only key (scope "mcp") is for /mcp alone and is refused here.
  if (!(await authorized(req))) {
    return errorResponse(req, 401, "Unauthorized");
  }

  try {
    // Artwork, day maps and their keys (netlify/lib/days-art/routes.ts), before the Days routes.
    if (first === "art" || first === "maps-art" || (first === "days" && segments[3] === "map")) {
      const handled = await handleArtRoutes(req, url, segments, (d, s) => json(req, d, s), corsHeaders(req));
      if (handled) return handled;
    }
    if (first === "people" && second === "stale" && segments.length === 3) {
      return await handleStalePeople(req, url);
    }
    if (first === "people" && second === "resolve" && segments.length === 3) {
      return await handleResolvePerson(req, url);
    }
    if (first === "people" && segments.length === 4 && (third === "brief" || third === "merge")) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handlePersonExtras(req, second, third);
    }

    // Rich links in notes: link previews, their pictures, and one-pin maps for a Place or a map link (netlify/lib/rich-links/routes.ts).
    if (first === "link-preview" || first === "link-map" || (first === "places" && segments[3] === "map")) {
      const handled = await handleRichLinkRoutes(req, url, segments, (d, s) => json(req, d, s), corsHeaders(req));
      if (handled) return handled;
    }

    // Visits, the Timeline import and a Place's visits (netlify/lib/places/routes.ts), before the Places records routes.
    if (first === "places" && segments.length >= 3) {
      const handled = await handlePlacesRoutes(req, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }

    // Days: entries, the line, mood, journal and photos, health and places joined (netlify/lib/days/routes.ts).
    if (first === "days") {
      // Backfill imports from other apps' files (netlify/lib/days/import-routes.ts).
      const imported = await handleImportRoutes(req, segments, (d, s) => json(req, d, s));
      if (imported) return imported;
      const handled = await handleDaysRoutes(req, url, segments, (d, s) => json(req, d, s), _context?.waitUntil?.bind(_context));
      if (handled) return handled;
    }

    // Saved: the app's list, reader and image (netlify/lib/saved/routes.ts).
    if (first === "saved") {
      const handled = await handleSavedRoutes(req, url, segments, (d, s) => json(req, d, s), corsHeaders(req));
      if (handled) return handled;
    }
    // Tracking: anything followed over time, on a saved item or on its own (netlify/lib/trackers/routes.ts).
    if (first === "trackers") {
      const handled = await handleTrackerRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // Check-ins: the morning preparation and the evening reflection (netlify/lib/checkins/routes.ts).
    if (first === "checkins") {
      const handled = await handleCheckinRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // The owner's own habits (netlify/lib/habits/routes.ts).
    if (first === "habits") {
      const handled = await handleHabitRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }

    // Habits, money and home (netlify/lib/life/routes.ts).
    if (first === "life") {
      const handled = await handleLifeRoutes(req, url, segments, (d, s) => json(req, d, s), _context?.waitUntil?.bind(_context));
      if (handled) return handled;
    }

    // Travelling today: live times for the day's legs and the owner's Tube lines (netlify/lib/travel-day-routes.ts).
    if (first === "travel") {
      const handled = await handleTravelRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }

    // The car: DVLA and DVSA lookups for the owner's vehicles, and the vehicle cards (netlify/lib/car-routes.ts).
    if (first === "car") {
      const handled = await handleCarRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }

    // Patterns across the owner's days, opened from the sealed rows (netlify/lib/patterns/routes.ts).
    if (first === "patterns") {
      const handled = await handlePatternsRoutes(req, url, segments, (d, s) => json(req, d, s));
      if (handled) return handled;
    }

    const memoryKind = first ? MEMORY_COLLECTIONS[first] : undefined;
    if (memoryKind) {
      if (second && !UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      if (segments.length === 4 && (third === "archive" || third === "unarchive")) {
        return await handleArchiveToggle(req, memoryKind, second, third);
      }
      if (segments.length === 2) return await handleMemoryCollection(req, url, memoryKind, _context);
      if (segments.length === 3) return await handleMemoryItem(req, url, memoryKind, second);
      return errorResponse(req, 404, "Not found");
    }
    const logisticsKind = first ? LOGISTICS_COLLECTIONS[first] : undefined;
    if (logisticsKind && segments.length <= 4) {
      return await handleLogistics(req, url, logisticsKind, first, second, third);
    }
    if (first === "identities" && segments.length <= 3) {
      if (second && !UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleIdentities(req, url, second);
    }
    if (first === "suggestions" && (segments.length === 2 || segments.length === 4)) {
      if (second && !UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleSuggestions(req, url, second, third);
    }
    if (first === "recall" && segments.length === 2) {
      return await handleRecall(req, url);
    }
    if (first === "today" && segments.length === 2) {
      return await handleToday(req, url);
    }
    if (first === "review" && second === "week" && segments.length === 3) {
      return await handleWeeklyReview(req, url);
    }
    if (first === "week-review" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      return json(req, await weekReviewExtras(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "", url.searchParams.get("tz")));
    }

    if (first === "files" && segments.length <= 4) {
      return await handleFiles(req, url, second, third);
    }
    // Pictures Ask made and the owner undid: archived (lib/images.ts). The Archived page lists, restores and deletes them.
    if (first === "pictures" && (segments.length === 3 || segments.length === 4 || segments.length === 5)) {
      return await handleArchivedPictures(req, segments.slice(2));
    }
    if (first === "notes" && third === "versions" && (segments.length === 4 || segments.length === 6)) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleNoteVersions(req, second, segments[4], segments[5]);
    }
    if (first === "notes" && third === "document" && segments.length === 4) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleNoteDocument(req, second);
    }
    if (first === "notes" && third === "files" && (segments.length === 4 || segments.length === 5)) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleNoteFiles(req, second, segments[4]);
    }
    // Nudges Athena starts: Home's cards, Ask opened from one, Fewer like this (netlify/lib/proactive/routes.ts).
    // Routines, What Ask did and tonight's picks (netlify/lib/ask-routes.ts).
    if (first === "routines" || first === "activity" || first === "watch-tonight") {
      const handled = await handleAskRoutes(req, url, segments, () => parseJsonBody(req), (d, s) => json(req, d, s), { undo: (op) => applyUndo(op, { calendar: calendarPort, scheduling: schedulingPort }) });
      if (handled) return handled;
    }
    // Flows drafting: POST /api/flows/draft (netlify/lib/flow-draft-routes.ts). The rest of /api/flows is the engine's.
    if (first === "flows" && second === "draft") {
      const handled = await handleFlowDraftRoutes(req, segments.slice(1), () => parseJsonBody(req), (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // Team: assistants with their own triggers, memory and character (netlify/lib/team-routes.ts, docs/team.md).
    if (first === "team") {
      // Team chat (netlify/lib/team-chat-routes.ts): what's typed goes to a waiting stage, an assistant or Ask.
      if (second === "chat" && (segments.length === 3 || (segments.length === 5 && segments[4] === "dismiss"))) {
        const ports = { gmail: mailPort, slack: slackPort, calendar: calendarPort, scheduling: schedulingPort };
        return await handleTeamChatRoutes(req, url, () => parseJsonBody(req), (d, s) => json(req, d, s), {
          desk: chatDesk,
          ask: async (text) => (await runAsk(text, { sources: answerSources, ...ports }, {})).text,
          turn: async (id, text) => {
            const threadId = crypto.randomUUID();
            const out = await asTrackerChecker(id, () => runAssistantTurn(id, text, { mode: "chat", threadId, sources: answerSources, ...ports }));
            const r = out.reply;
            // A turn that changed something or left a plan keeps its conversation, as the assistant's own; a plan's card lives there.
            if (!r.plan?.steps.length && !r.changes?.length) return { text: out.text };
            const at = new Date().toISOString();
            await saveAskThread(threadId, {
              title: text.replace(/\s+/g, " ").slice(0, 120),
              messages: [
                { role: "me", text, at },
                { role: "answer", at, question: text, text: r.text, sources: r.sources, related: r.related, searched: r.searched, skipped: r.skipped, found: r.found, flagged: r.flagged, sample: false, note: null, fallback: null, ...(r.changes?.length ? { changes: r.changes } : {}), ...(r.plan ? { plan: r.plan } : {}) },
              ],
              updated_at: at,
              created_at: at,
              assistant_id: id,
            });
            return { text: out.text, thread_id: r.plan?.steps.length ? threadId : null };
          },
        });
      }
      // Its routes read the path from "team" on, as its tests call it.
      const handled = await handleTeamRoutes(req, url, segments.slice(1), () => parseJsonBody(req), (d, s) => json(req, d, s), _context?.waitUntil?.bind(_context));
      if (handled) return handled;
    }
    // Flow suggestions: habits worth a flow, and dismissing one (netlify/lib/flow-suggest-routes.ts). Before the engine's
    // /api/flows routes, so /api/flows/suggestions isn't read as a flow id. Flows are read through a port: NO_FLOWS until the
    // engine (lib/flows.ts) is merged and gives one.
    if (first === "flows" && second === "suggestions") {
      const handled = await handleFlowSuggestRoutes(req, segments.slice(1), (d, s) => json(req, d, s), {
        signals: readSignals,
        timeZone: getOwnerTimeZone,
        dismissed: listDismissed,
        dismiss: dismissSuggestion,
        flows: NO_FLOWS,
      });
      if (handled) return handled;
    }
    // AI models: which model does each job, and the owner's agreements (netlify/lib/models-routes.ts, docs/ai-models.md).
    if (first === "models") {
      const handled = await handleModelsRoutes(req, segments.slice(1), () => parseJsonBody(req), (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // Watch & read's month in numbers: Days' watched entries with each title's running time (lib/watch-stats.ts).
    if (first === "watch-stats" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      const tz = await getOwnerTimeZone();
      // ?from=&to=: screen time over a run of days (92 at most), with the same run before it for comparison.
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (from || to) {
        const DAY = /^\d{4}-\d{2}-\d{2}$/;
        if (!from || !to || !DAY.test(from) || !DAY.test(to) || to < from) throw new AthenaInputError("from, to: YYYY-MM-DD, to on or after from");
        const span = daysBetween(from, to).length;
        if (span > 92) throw new AthenaInputError("At most 92 days at once");
        const [range, items] = await Promise.all([entriesInRange(shiftDay(from, -span), to, { kind: "watched", limit: 2000 }), listReading({ limit: 2000 })]);
        const entries = range.flatMap((d) => d.entries.map((e) => ({ ...e, date: d.date })));
        return json(req, screenTime(entries, items, from, to, { tz, today: zonedToday(new Date(), tz) }));
      }
      const month = url.searchParams.get("month") ?? zonedToday(new Date(), tz).slice(0, 7);
      const days = monthDays(month);
      if (!days.length) throw new AthenaInputError("month: YYYY-MM");
      const [range, items] = await Promise.all([entriesInRange(days[0], days[days.length - 1], { kind: "watched", limit: 2000 }), listReading({ limit: 2000 })]);
      const entries = range.flatMap((d) => d.entries.map((e) => ({ ...e, date: d.date })));
      return json(req, monthStats(entries, items, month));
    }
    // Ask's skills: the list, the editor, uploads and link imports (netlify/lib/skills-routes.ts).
    if (first === "skills") {
      const handled = await handleSkillRoutes(req, segments, () => parseJsonBody(req), (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    if (first === "nudges") {
      const handled = await handleNudgeRoutes(req, segments, () => parseJsonBody(req), (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // Finding a time and moving an event you organise (netlify/lib/scheduling/routes.ts).
    if (first === "scheduling") {
      const handled = await handleSchedulingRoutes(req, segments, () => parseJsonBody(req), (d, s) => json(req, d, s));
      if (handled) return handled;
    }
    // Your answer to an invite: Going, Maybe or Declined, sent to the calendar when its account allows it (lib/rsvp.ts).
    if (first === "events" && third === "rsvp" && segments.length === 4) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      if (req.method !== "POST") return errorResponse(req, 405, "Method not allowed");
      const body = await parseJsonBody(req);
      return json(req, await answerEvent(second, body?.answer as Rsvp, { calendar: calendarPort }, { series: body?.series === true }));
    }
    const kind = first ? COLLECTIONS[first] : undefined;
    if (kind) {
      if (second && !UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      // The owner's Card and Mention choices in a note Athena wrote (lib/note-link-choices.ts): the app's editor only.
      if (kind === "note" && segments.length === 4 && third === "link-choices") {
        if (req.method === "GET") return json(req, { choices: await getLinkChoices(second) });
        if (req.method === "PUT") return json(req, { choices: await setLinkChoice(second, await parseJsonBody(req)) });
        return errorResponse(req, 405, "Method not allowed");
      }
      if (segments.length === 4 && (third === "archive" || third === "unarchive")) {
        return await handleArchiveToggle(req, kind, second, third);
      }
      if (kind === "note") {
        if (segments.length === 2) return await handleNotesCollection(req, url);
        if (segments.length === 3) return await handleNoteItem(req, url, second);
      } else {
        if (segments.length === 2) return await handleRecordCollection(req, url, kind, first);
        if (segments.length === 3) return await handleRecordItem(req, url, kind, second);
      }
      return errorResponse(req, 404, "Not found");
    }

    if (first === "search" && segments.length === 2) {
      return await handleSearch(req, url);
    }
    if (first === "upcoming" && segments.length === 2) {
      return await handleUpcoming(req, url);
    }
    if (first === "entities" && second === "search" && segments.length === 3) {
      return await handleEntitySearch(req, url);
    }
    // Ask's @ list: everything that matches, across kinds (lib/mentions-db.ts).
    if (first === "mentions" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      // recent: "kind:id" the owner picked lately (kept on their device), newest first.
      const recent = (url.searchParams.get("recent") ?? "").split(",").filter((k) => /^[a-z]+:[0-9a-f-]{36}$/i.test(k)).slice(0, 20);
      return json(req, { results: await searchMentions(url.searchParams.get("q") ?? "", { limit: Math.min(parseLimit(url) ?? MENTION_LIMIT, 20), picked: recent }) });
    }
    // A pasted bare athena:// link: its title, so the chip reads right.
    if (first === "mentions" && segments.length === 4) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      if (!(LINK_KINDS as readonly string[]).includes(second) || !UUID_RE.test(third)) return errorResponse(req, 404, "Not found");
      const row = await mentionById(second as LinkKind, third);
      return row ? json(req, row) : errorResponse(req, 404, "That isn't in Athena any more");
    }
    if (first === "connections" && segments.length === 4) {
      if (!UUID_RE.test(third)) return errorResponse(req, 404, "Not found");
      return await handleConnections(req, second, third);
    }
    if (first === "links" && segments.length === 2) {
      return await handleLinks(req);
    }
    if (first === "graph" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      return json(req, await loadGraph());
    }
    if (first === "archived" && segments.length === 2) {
      return await handleArchived(req, url);
    }
    if (first === "reminders" && segments.length === 2) {
      return await handleRemindersCollection(req, url);
    }
    if (first === "reminders" && segments.length === 3) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      return await handleReminderItem(req, second);
    }
    if (first === "push" && second === "key" && segments.length === 3) {
      return await handlePushKey(req);
    }
    if (first === "push" && second === "test" && segments.length === 3) {
      return await handlePushTest(req);
    }
    if (first === "push" && second === "settings" && segments.length === 3) {
      return await handlePushSettings(req);
    }
    if (first === "push" && second === "subscribe" && segments.length === 3) {
      return await handlePushSubscribe(req);
    }
    if (first === "settings" && segments.length === 2) {
      return await handleSettings(req);
    }
    if (first === "profile" && segments.length <= 3) {
      return await handleProfile(req, second);
    }
    if (first === "api-keys" && segments.length <= 3) {
      return await handleApiKeys(req, second);
    }
    if (first === "assistant" && segments.length <= 3) {
      return await withSpendScope({ area: "ask" }, () => handleAssistant(req, second));
    }
    if (first === "encryption" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      return json(req, await encryptionStatus());
    }
    if (first === "voice" && second === "transcribe" && segments.length === 3) {
      return await withSpendScope({ area: "ask", job: "voice" }, () => handleVoiceTranscribe(req));
    }
    if (first === "elevenlabs") {
      const handled = await handleElevenLabsRoutes(req, url, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    if (first === "talk") {
      const handled = await handleTalkRoutes(req, segments, (data, status) => json(req, data, status), corsHeaders(req));
      if (handled) return handled;
    }
    if (first === "health" && second === "status" && segments.length === 3) {
      return await handleHealthStatus(req, (d, s) => json(req, d, s));
    }
    if (first === "health" && second === "series" && segments.length === 3) {
      return await handleHealthSeries(req, url, (d, s) => json(req, d, s));
    }
    if (first === "health" && second === "days" && segments.length === 3) {
      return await handleHealthDays(req, url, (d, s) => json(req, d, s));
    }
    if (first === "health" && second === "sources" && segments.length === 3) {
      return await handleHealthSources(req, (d, s) => json(req, d, s));
    }
    if (first === "health" && second === "manual" && segments.length === 3) {
      return await handleHealthManual(req, url, (d, s) => json(req, d, s));
    }
    if (first === "metrics" && segments.length === 2) {
      return await handleMetricsCollection(req);
    }
    if (first === "metrics" && segments.length === 3) {
      return await handleMetricItem(req, url, second);
    }
    if (first === "connectors" || first === "collections") {
      const handled = await handleConnectorRoutes(req, url, segments, (data, status) => json(req, data, status), url.origin);
      if (handled) return handled;
    }
    if (first === "ask-threads" && segments.length === 2) {
      if (req.method !== "GET") return errorResponse(req, 405, "Method not allowed");
      return json(req, await listAskThreads(url.searchParams.get("since")));
    }
    if (first === "ask-threads" && segments.length === 3) {
      if (!UUID_RE.test(second)) return errorResponse(req, 404, "Not found");
      if (req.method === "PUT") {
        const body = await parseJsonBody(req);
        if (!body) return errorResponse(req, 400, "Send a JSON object");
        const saved = await saveAskThread(second, body);
        await linkThreadFiles(second, saved.messages);
        return json(req, saved);
      }
      if (req.method === "DELETE") {
        await deleteAskThread(second);
        // Its files go too, unless a note uses them.
        await unlinkThread(second);
        return json(req, { ok: true });
      }
      return errorResponse(req, 405, "Method not allowed");
    }
    if (first === "custom-fields" || first === "custom-values") {
      const handled = await handleCustomFieldRoutes(req, url, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    if (first === "kinds" || first === "records") {
      const handled = await handleCustomKindRoutes(req, url, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    // To-do contexts (netlify/lib/todo-contexts-routes.ts).
    if (first === "todo-contexts") {
      const handled = await handleTodoContextRoutes(req, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    // The person an unlinked to-do names (netlify/lib/todo-people-routes.ts). Full access only, like everything below the gate.
    if (first === "todo-people") {
      const handled = await handleTodoPeopleRoutes(req, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    // Recipes, the week's dinners and the grocery list (netlify/lib/recipes-routes.ts).
    if (first === "recipes") {
      const handled = await handleRecipeRoutes(req, url, segments, (data, status) => json(req, data, status), { calendar: schedulingPort });
      if (handled) return handled;
    }
    // Templates and notes sent to Google Docs or Notion (netlify/lib/documents-routes.ts).
    if (first === "templates" || first === "documents") {
      const handled = await handleDocumentRoutes(req, url, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    // AI spend: today, the week, the budget and Allow more (netlify/lib/spend-routes.ts).
    if (first === "spend") {
      const handled = await handleSpendRoutes(req, segments.slice(1), () => parseJsonBody(req), (data, status) => json(req, data, status));
      if (handled) return handled;
    }
    // Each week's kept moment, the cover of its week (netlify/lib/week-moments-routes.ts).
    if (first === "week-moments") {
      const handled = await handleWeekMomentRoutes(req, segments, (data, status) => json(req, data, status));
      if (handled) return handled;
    }

    return errorResponse(req, 404, "Not found");
  } catch (error) {
    if (error instanceof AthenaInputError) return errorResponse(req, error.status, error.message);
    if (error instanceof BudgetReached) return json(req, { error: error.message, code: error.code, budget: error.notice }, 402);
    if (error instanceof BudgetUnchecked) return json(req, { error: error.message, code: error.code }, 503);
    if (error instanceof DataBoxError && error.status !== 500) {
      console.warn("Athena API: refused a write:", error.message);
      return errorResponse(req, error.status, error.message);
    }
    console.error("Athena API error:", error);
    return errorResponse(req, 500, "Internal server error");
  }
};

// /api/collect-run, /api/backfill-run and /api/team-run are background functions (collect-run.ts, backfill-run.ts, team-run.ts), not this one;
// /api/voice/* is routed through ./voice.ts (same handler, rate-limited). /api/talk/*, /api/assistant* and
// /api/live/* belong to the server (netlify/server/index.ts), which calls this handler for the first two.
// /api/team/chat is the server's too (Ask's rate limit on what's typed), and comes back here.
export const config: Config = { path: "/api/*", excludedPath: ["/api/collect-run", "/api/backfill-run", "/api/team-run", "/api/voice/*", "/api/talk/*", "/api/assistant", "/api/assistant/*", "/api/live/*", "/api/team/chat"] };
