/**
 * Shared types for the Athena PWA frontend. Mirrors the backend contract in
 * lib/db.ts / the API spec exactly (Note, MetricPoint, Person shapes) so the
 * IndexedDB cache and the UI never drift from what `/api/*` actually returns.
 *
 * Referenced by: idb.ts (cache schema), api.ts (fetch typings), sync.ts,
 * sample-data.ts, and every view/component under src/views and src/components.
 */

import type { ConnectorOAuthSettings } from "../../lib/connector-presets";
import type { FieldValue } from "../../lib/custom-field-rules";
import type { MailRules } from "../../lib/mail-rules";
import type { TodoLink, TodoPriority, TodoStep } from "../../lib/todo-details";

export type NoteType = "note" | "daily" | "project" | "area" | "capture";

export interface Note {
  id: string;
  title: string;
  body: string;
  type: NoteType;
  source: string | null;
  tags: string[];
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Person {
  id: string;
  name: string;
  notes: string;
  last_contacted_at: string | null;
  relationship?: string;
  email?: string;
  phone?: string;
  /** null = the default 60-day cadence. */
  catch_up_days?: number | null;
  /** Nudge me to catch up with them. Off by default. */
  keep_in_touch?: boolean;
  /** "YYYY-MM-DD", or "--MM-DD" when the year isn't known. */
  birthday?: string | null;
  birthday_event_id?: string | null;
  organisation?: { id: string; name: string } | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "done";
  description: string;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Place {
  id: string;
  name: string;
  address: string;
  url: string;
  notes: string;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organisation {
  id: string;
  name: string;
  website: string;
  notes: string;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type EventKind = "birthday" | "anniversary" | "appointment" | "deadline" | "other";

export interface AthenaEvent {
  id: string;
  title: string;
  kind: EventKind;
  /** A calendar date "YYYY-MM-DD" (year 2000 placeholder when !year_known). For a timed one-off, `starts_at` is the truth. */
  date: string;
  /** Wall-clock "HH:MM" for a yearly event; null otherwise. */
  time: string | null;
  /** UTC instant a timed one-off starts; shown in the device's time zone. */
  starts_at?: string | null;
  recurrence: "none" | "yearly";
  year_known: boolean;
  remind_days_before: number[];
  notes: string;
  person_id: string | null;
  /** The collection that synced it from a calendar; null if added by hand. */
  source?: string | null;
  timed_push?: boolean;
  /** Your answer to an invite; "none" (or missing) for no answer. */
  rsvp?: Rsvp;
  /** The calendar's own last answer; null when it isn't a calendar invite. */
  rsvp_calendar?: Rsvp | null;
  rsvp_mine?: boolean;
  /** Why the last send to the calendar failed; "" when it didn't. */
  rsvp_error?: string;
  calendar_event_id?: string | null;
  /** The calendar account the invite came from; can_send when "Let Athena answer invites" is on for it. */
  rsvp_account?: { id: string; name: string; label: string; provider: string; can_send: boolean } | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type Rsvp = "going" | "maybe" | "declined" | "none";

/** What POST /api/events/:id/rsvp says happened (lib/rsvp.ts). */
export interface RsvpResult {
  event: AthenaEvent;
  outcome: "sent" | "unchanged" | "saved" | "failed";
  message: string;
  before: Rsvp;
}

/** The kinds with a profile page in the Library. */
export type RecordKind = "person" | "place" | "organisation" | "event";

export interface RecordByKind {
  person: Person;
  place: Place;
  organisation: Organisation;
  event: AthenaEvent;
}

export type AnyRecord = Person | Place | Organisation | AthenaEvent;

export interface UpcomingItem {
  event: AthenaEvent;
  occurs_on: string;
  days_until: number;
  /** "HH:MM" in the zone the list was made for, or null for all-day. */
  time: string | null;
  starts_at: string | null;
  years: number | null;
}

export interface Upcoming {
  today: string;
  /** The zone `today`, days and times are in. */
  tz?: string;
  events: UpcomingItem[];
  catch_ups: Person[];
}

export interface ArchivedItem {
  kind: ArchivableKind;
  id: string;
  title: string;
  archived_at: string;
  /** A custom record's kind, for one ("Wine"); a custom kind's name for one ("wine"). */
  detail?: string;
  /** A custom record's kind id. */
  kind_id?: string;
  /** A custom kind's (or a record's kind's) icon. */
  icon?: string;
  /** A custom kind: how many records it has, archived ones too (what deleting it removes). */
  count?: number;
}

export interface MetricPoint {
  value: number;
  recorded_at: string;
  metadata?: Record<string, unknown>;
}

export type NotePatch = Partial<Pick<Note, "title" | "body" | "type" | "source" | "tags">>;

/**
 * A note write made while offline (or that failed to reach the server),
 * queued for replay in order. `noteId` may be a `local-…` temp id until the
 * create it belongs to has synced. Older builds queued only creates and
 * stored `tempId` with no `op` — those still replay as creates.
 */
export interface OutboxEntry {
  key?: number; // IndexedDB autoIncrement key
  /** "field": one of the owner's own fields on the note (db/custom-fields.ts); see `field`. */
  op?: "create" | "update" | "delete" | "archive" | "unarchive" | "field";
  noteId?: string;
  tempId?: string; // legacy (create-only builds)
  payload: NotePatch & { body?: string };
  /** op "field": which field, and its new value (null clears it). */
  field?: { id: string; value: FieldValue | null };
  /** op "delete": also delete the note's files where a conversation still has them. */
  deleteFiles?: boolean;
  queued_at: string;
  attempts: number;
}

/**
 * Every kind with a page the graph links between (mirrors lib/db.ts PageType). "record"
 * is a record in one of the owner's own kinds (a wine, a plant), whatever the kind.
 */
export type EntityKind = "note" | "person" | "place" | "organisation" | "event" | "project" | "record";
/**
 * What a link can join (lib/db.ts EntityType): the pages, plus what a note
 * @-mentions from its own list: "saved", "commitment" (a to-do) and
 * "reading" (Watch & read), whose link kinds are saved, todo and watch.
 */
export type LinkedKind = EntityKind | "saved" | "commitment" | "reading";

/** A search hit / reference to anything, with a display title (lib/db.ts EntityRef). */
export interface EntityRef {
  kind: EntityKind;
  id: string;
  title: string;
  /** A record's is its kind's name for one: "Wine". */
  subtitle: string;
  updated_at: string;
  /** A record's kind; absent for everything else. */
  kind_id?: string;
}

export interface Connection extends Omit<EntityRef, "kind"> {
  kind: LinkedKind;
  edge_id: string;
  relation: string;
  origin: "manual" | "content";
}

export interface Connections {
  outgoing: Connection[];
  backlinks: Connection[];
  /** On a page: saved items, to-dos and Watch & read titles in the notes linked to it, each with its newest such note. */
  through_notes?: Array<Omit<EntityRef, "kind"> & { kind: LinkedKind; note: { id: string; title: string } }>;
}

export type ConnectionState = "online" | "offline" | "sample" | "syncing";

export type ReminderRepeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

/** A custom reminder (lib/db.ts Reminder). `remind_at` is when it next fires. */
export interface Reminder {
  id: string;
  text: string;
  remind_at: string;
  repeat: ReminderRepeat;
  anchor_day: number;
  about_type: EntityKind | null;
  about_id: string | null;
  about_title: string | null;
  done_at: string | null;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  text?: string;
  /** Local date + time in `tz`. */
  date?: string;
  time?: string;
  /** The zone `date` + `time` are in: this device's (the server falls back to the owner's). */
  tz?: string;
  repeat?: ReminderRepeat;
  about?: { kind: EntityKind; id: string } | null;
  done?: boolean;
}


// ---------- Layer 2: what's in motion (mirrors lib/memory.ts) ----------

/** Archivable like everything else, but not graph nodes. */
export type MemoryKind = "commitment" | "interaction" | "fact" | "asset" | "reading" | "goal";
/** Trips, their bookings and purchases (lib/trips.ts). */
export type LogisticsKind = "trip" | "booking" | "purchase";
/** "kind": one of the owner's own kinds of record, with everything in it. */
export type ArchivableKind = EntityKind | MemoryKind | LogisticsKind | "kind";

export interface PersonRef {
  id: string;
  name: string;
}

/** Where an agent-written item came from. */
export interface Provenance {
  source?: string | null;
  source_ref?: string | null;
  source_quote?: string | null;
  confidence?: number | null;
}

export type CommitmentKind = "todo" | "i_owe" | "waiting_on" | "decision";
export type CommitmentStatus = "open" | "done" | "dropped";

export interface Commitment extends Provenance {
  id: string;
  title: string;
  kind: CommitmentKind;
  status: CommitmentStatus;
  /** "YYYY-MM-DD", a calendar date (due and overdue are judged in this device's zone), or null. */
  due_on: string | null;
  notes: string;
  person_id: string | null;
  person: PersonRef | null;
  /** Its area and where/how (lib/todo-context.ts); null when none or removed. */
  area_id?: string | null;
  where_id?: string | null;
  /** Athena set the context itself; the owner picking one clears it. */
  context_by_athena?: boolean;
  /** Its checklist, in order (lib/todo-details.ts). Missing on copies cached before 0084. */
  steps?: TodoStep[];
  /** Web pages and things in Athena it points at. */
  links?: TodoLink[];
  /** 0 none, 1 low, 2 medium, 3 high. */
  priority?: TodoPriority;
  done_at: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type InteractionChannel = "meeting" | "call" | "message" | "email" | "in_person" | "other";

export interface Interaction {
  id: string;
  at: string;
  channel: InteractionChannel;
  summary: string;
  source: string | null;
  source_ref: string | null;
  people: PersonRef[];
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FactSubjectKind = "me" | "person" | "place" | "organisation";

export interface Fact extends Provenance {
  id: string;
  subject_kind: FactSubjectKind;
  subject_id: string | null;
  key: string;
  value: string;
  observed_at: string;
  superseded_at: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type IdentityKind = "email" | "phone" | "slack" | "alias" | "other";

export interface Identity {
  id: string;
  person_id: string;
  kind: IdentityKind;
  value: string;
  created_at: string;
}

export type SuggestionOp = "commitment" | "fact" | "interaction" | "event" | "person" | "link" | "booking" | "purchase";

export interface Suggestion extends Provenance {
  id: string;
  op: SuggestionOp;
  summary: string;
  payload: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected";
  result_id: string | null;
  resolved_at: string | null;
  created_at: string;
  /** The email it came from: sender, subject and account (lib/suggestion-similar.ts). Absent for older finds. */
  email?: SuggestionEmail | null;
}

export type { SuggestionEmail } from "../../lib/suggestion-similar";
import type { SuggestionEmail } from "../../lib/suggestion-similar";

export type AssetKind = "passport" | "licence" | "insurance" | "vehicle" | "warranty" | "subscription" | "home" | "pet" | "health" | "other";

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  provider: string;
  renews_on: string | null;
  remind_days_before: number[];
  notes: string;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Renewal {
  asset: Asset;
  /** Negative once it has lapsed. */
  days_until: number;
}

/** Watch & read (lib/watch-read.ts): book, film, tv, article, … and queued / reading / done. */
export type { ReadingKind, ReadingProgress, ReadingStatus } from "../../lib/watch-read";
import type { ReadingKind, ReadingProgress, ReadingStatus } from "../../lib/watch-read";
export type { WatchMeta } from "../../lib/watch-meta";
import type { WatchMeta } from "../../lib/watch-meta";

export interface ReadingItem {
  id: string;
  title: string;
  url: string;
  kind: ReadingKind;
  author: string;
  status: ReadingStatus;
  notes: string;
  recommended_by: string | null;
  recommender: PersonRef | null;
  finished_at: string | null;
  source: string | null;
  /** How far through it you are (0042): pages, episodes or a percent; null when only the status is known. Older copies lack it. */
  progress?: ReadingProgress | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  /** Its poster or cover, kept by Athena (lib/art.ts); the server adds it. */
  art?: { id: string; w: number; h: number; tone?: string };
  /** Year, running time, genres, playlists and your tags (lib/watch-meta.ts). Older copies lack it. */
  meta?: WatchMeta;
}

export type GoalPeriod = "week" | "month" | "quarter" | "year";

export interface Goal {
  id: string;
  title: string;
  period: GoalPeriod;
  target: string;
  progress: number;
  status: "active" | "done" | "dropped";
  due_on: string | null;
  notes: string;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonBrief {
  person: Person;
  facts: Fact[];
  identities: Identity[];
  interactions: Interaction[];
  open_loops: Commitment[];
  decisions: Commitment[];
  reading: ReadingItem[];
  /** Open lines on their gift ideas lists (servers from night F5 on). */
  gift_ideas?: string[];
  /** Facts the owner wrote or accepted from the Review inbox, newest first (servers from night F5 on). */
  accepted_facts?: Fact[];
}

export type RecallKind = "note" | "commitment" | "interaction" | "fact" | "person" | "reading" | "record" | "day";

export interface RecallHit {
  kind: RecallKind;
  id: string;
  title: string;
  snippet: string;
  at: string;
  rank: number;
  person: PersonRef | null;
  /** A custom record's kind: its id and its name for one ("wine"). */
  custom_kind?: { id: string; one: string };
}

export interface WeeklyReview {
  week_start: string;
  week_end: string;
  done: Commitment[];
  decisions: Commitment[];
  interactions: Interaction[];
  people_seen: PersonRef[];
  open_loops: Commitment[];
  catch_ups: Person[];
  next_week: { events: UpcomingItem[]; due: Commitment[] };
  goals: Goal[];
  reading_done: ReadingItem[];
  renewals: Renewal[];
  notes_written: number;
}

// ---------- Trips and purchases (mirrors lib/trips.ts) ----------

export type { BookingKind, BookingStatus, PurchaseStatus } from "../../lib/trip-text";
import type { BookingKind, BookingStatus, PurchaseStatus } from "../../lib/trip-text";

/** A flight, train, hotel stay, car hire or ticket. Instants are UTC; each end keeps its place's IANA zone. */
export interface Booking {
  id: string;
  trip_id: string;
  kind: BookingKind;
  status: BookingStatus;
  title: string;
  provider: string;
  reference: string;
  segment: string;
  start_date: string;
  starts_at: string | null;
  start_tz: string;
  start_place: string;
  start_city: string;
  end_date: string | null;
  ends_at: string | null;
  end_tz: string;
  end_place: string;
  end_city: string;
  seat: string;
  details: string;
  email_link: string;
  previous_starts_at: string | null;
  /** When an email cancelled it, and that email (even on a booking you added). */
  cancelled_at: string | null;
  cancel_email_link: string;
  source: string | null;
  source_ref: string | null;
  confidence: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Trip {
  id: string;
  /** Where it's to: "Lisbon". */
  title: string;
  starts_on: string | null;
  ends_on: string | null;
  notes: string;
  source: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  /** Live bookings, in the order they happen. */
  bookings: Booking[];
}

export interface PurchaseUpdate {
  id: string;
  status: PurchaseStatus;
  at: string;
  detail: string;
  email_link: string;
}

/** A booking as you add or edit it: local times where it happens ("2026-11-12T09:40", or just the day), "" for none. */
export interface BookingFields {
  kind: BookingKind;
  status: BookingStatus;
  title: string;
  provider: string;
  reference: string;
  segment: string;
  start_local: string;
  start_tz: string;
  start_place: string;
  start_city: string;
  end_local: string;
  end_tz: string;
  end_place: string;
  end_city: string;
  seat: string;
  details: string;
}

/** An order as you add or edit it. Never a price. */
export interface PurchaseFields {
  retailer: string;
  items: string[];
  order_number: string;
  ordered_on: string | null;
  expected_on: string | null;
  status: PurchaseStatus;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
}

/** An order and where its delivery has got to. Never a price. */
export interface Purchase {
  id: string;
  retailer: string;
  items: string[];
  order_number: string;
  ordered_on: string | null;
  status: PurchaseStatus;
  status_at: string;
  expected_on: string | null;
  delivered_at: string | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  email_link: string;
  source: string | null;
  source_ref: string | null;
  confidence: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  updates: PurchaseUpdate[];
}

// ---------- The graph (mirrors lib/graph.ts) ----------

/** Pages (notes, people, places, organisations, events, the owner's own records) plus the layer-2 details that hang off them. */
export type GraphKind = "note" | "person" | "place" | "organisation" | "event" | "record" | "saved" | "interaction" | "commitment" | "fact" | "reading";

export interface GraphNode {
  id: string;
  kind: GraphKind;
  title: string;
  /** One short line of context: a note's type, a person's relationship, a catch-up's channel, a record's kind ("wine")… */
  sub: string;
  /** When a catch-up happened; null for everything else. */
  at: string | null;
  degree: number;
  /** A custom record's kind (the Graph filters by it). */
  kind_id?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ---------- Connectors and collections (netlify/lib/connectors/routes.ts) ----------

export type ConnectorStatus = "pending" | "connected" | "needs_auth" | "error";
export type ConnectorAuthType = "oauth" | "token" | "none";
export type { ConnectorOAuthSettings };

export interface ConnectorTool {
  name: string;
  description: string;
  access: "read" | "write" | "unknown";
}

/** One signed-in account. Never carries a credential, only whether one is stored. */
export interface Connector {
  id: string;
  name: string;
  provider: string;
  account_label: string;
  url: string;
  auth_type: ConnectorAuthType;
  scope: string;
  status: ConnectorStatus;
  status_detail: string;
  tools: ConnectorTool[];
  allowed_tools: string[];
  tools_checked_at: string | null;
  last_used_at: string | null;
  /** What the server says about itself; `icon` holds data: URIs fetched by the server. */
  server_info: {
    name?: string;
    title?: string;
    version?: string;
    description?: string;
    website_url?: string;
    icon?: { light?: string; dark?: string; source: "server" | "website" };
  };
  /** OAuth settings entered by hand (endpoints, grant, audience); empty = discovered. */
  oauth: ConnectorOAuthSettings;
  /** Google Calendar and Outlook: the calendar ids Athena reads; null = only the main one. */
  calendars?: string[] | null;
  /** Gmail and Outlook: which emails Athena reads; null = no rules. */
  mail_rules?: MailRules | null;
  has_token: boolean;
  has_own_client: boolean;
  has_client_secret: boolean;
  created_at: string;
  updated_at: string;
}

export type RecipeId = "calendar-meetings" | "email-digest" | "work-activity" | "life-log" | "plays-watches" | "work-sync" | "home" | "custom";

export interface Collection {
  id: string;
  name: string;
  recipe: RecipeId;
  connector_ids: string[];
  label: string;
  source: string;
  instructions: string;
  schedule: "daily" | "hourly" | "manual";
  run_at: string | null;
  every_hours: number | null;
  lookback_hours: number;
  lookahead_days: number;
  event_push: boolean;
  /** Skip a run when the precheck finds nothing new (default), or always run. */
  skip_quiet: boolean;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
  /** The run in flight, if any. Optional: absent from older servers. */
  current_run?: { id: string; status: "queued" | "running"; started_at: string | null } | null;
  /** The newest finished run. `saved`: new things it wrote; `blocked_by`: ids of accounts it couldn't read. */
  last_run?: { id: string; status: "succeeded" | "failed"; finished_at: string | null; error: string; saved: number; blocked_by: string[] } | null;
}

/** One thing a run saved (GET /api/collections/:id/runs/:run/items). Names and dates only. */
export interface RunItem {
  /** "day": a day it wrote entries for; record_id is the date and title the day's line. */
  kind: "note" | "event" | "day";
  record_id: string;
  title: string;
  item_date: string | null;
  archived: boolean;
  /** Made by this run; false when it updated something an earlier run saved. */
  new: boolean;
}

export interface CollectionRun {
  id: string;
  collection_id: string;
  trigger: "schedule" | "manual";
  status: "queued" | "running" | "succeeded" | "failed";
  started_at: string | null;
  finished_at: string | null;
  summary: string;
  error: string;
  stats: Partial<
    Record<
      | "turns"
      | "tool_calls"
      | "source_calls"
      | "notes_created"
      | "notes_updated"
      | "skipped_dismissed"
      | "archived"
      | "restored"
      | "events_created"
      | "events_updated"
      | "metrics"
      | "people"
      | "catch_ups"
      | "todos"
      | "details"
      | "suggestions"
      | "bookings_created"
      | "bookings_updated"
      | "purchases_created"
      | "purchases_updated"
      | "renewals_created"
      | "renewals_updated"
      | "alerts"
      | "entries_created"
      | "entries_updated"
      | "day_lines"
      | "claude_skipped"
      | "triaged_out"
      | "flagged"
      | "input_tokens"
      | "output_tokens"
      | "plays_new"
      | "watches_new"
      | "likes_new"
      | "issues_new"
      | "prs_new"
      | "work_updated"
      | "accounts_checked"
      | "days_updated"
      | "programmes_finished"
      | "waiting",
      number
    >
  > & { /** Ids of the accounts this run couldn't read. */ blocked_by?: string[] };
  created_at: string;
}

/**
 * An API key (lib/api-keys.ts): "capture" for an iPhone Shortcut (sends things
 * in, reads nothing back), "mcp" for Claude as a connector (Athena's tools at
 * /mcp only), "full" for a device or scripts. Shown once, when made.
 */
export interface ApiKey {
  id: string;
  label: string;
  scope: "capture" | "mcp" | "full";
  created_at: string;
  last_used_at: string | null;
}

export interface ConnectorsState {
  connectors: Connector[];
  collections: Collection[];
  setup: {
    encryption: boolean;
    ai: boolean;
    callback_url: string;
    /** Own sign-in setups a new account can reuse via `client_from`, by family ("Google", "Microsoft"). Names only. */
    own_clients?: Partial<Record<string, { from: string; name: string }>>;
  };
}

// ---------- Ask's assistant (lib/assistant.ts) ----------

export interface AssistantTurn {
  role: "user" | "assistant";
  text: string;
  /** File ids sent with this message (lib/files.ts). */
  files?: string[];
  /** On the newest message: earlier files in the conversation, sent as their summaries. */
  earlier?: string[];
}

/** One thing the assistant changed, with how to open it and how to undo it. */
/** Where a draft goes out: the owner sends it themselves (lib/drafts.ts). */
export type DraftChannel = "email" | "text" | "whatsapp" | "telegram" | "slack";

/** A Gmail or Outlook account drafts can be saved to (one with drafts turned on). */
export interface DraftAccount {
  id: string;
  label: string;
  provider: "gmail" | "outlook-mail" | "fastmail";
}

/** A message Athena wrote for you to send (lib/drafts.ts): an email, a text, a WhatsApp or a Slack DM. */
export interface MessageDraft {
  channel: DraftChannel;
  /** The channels Athena can reach them on, among the apps the owner uses, the usual one first. */
  available: DraftChannel[];
  /** The messaging apps the owner uses (Settings → Drafts). */
  enabled?: DraftChannel[];
  to: Array<{ name: string; email: string }>;
  /** Email only. */
  subject: string;
  body: string;
  phone: string | null;
  /** Their Slack member ID or handle. */
  slack: string | null;
  /** A reply inside the email thread the to-do came from. */
  reply: { connector_id: string; message_id: string } | null;
  accounts: DraftAccount[];
  /** A Gmail or Outlook account is connected without drafts turned on. */
  can_enable_drafts: boolean;
  saved: { connector_id: string; account: string; url: string | null; provider?: DraftAccount["provider"] } | null;
  /** The email it answers looked like it was trying to instruct Athena. */
  flagged: boolean;
}
/** The old name. */
export type EmailDraft = MessageDraft;

export interface AssistantChange {
  /**
   * "field": one of the owner's own fields, or a value in one. "kind"/"record": one of the owner's own kinds of record, or a record in one.
   * "people": one change to many people at once ("100 people"). "link": a link between two things.
   */
  kind:
    | "note"
    | "person"
    | "people"
    | "commitment"
    | "reminder"
    | "fact"
    | "interaction"
    | "draft"
    | "reading"
    | "field"
    | "kind"
    | "record"
    | "place"
    | "organisation"
    | "event"
    | "goal"
    | "asset"
    | "project"
    | "trip"
    | "booking"
    | "purchase"
    | "link"
    | "document"
    | "recipe"
    | "routine"
    /** One of Ask's skills, used: kept in What Ask did, with Open and no Undo. */
    | "skill"
    /** A price kept in a saved thing's history (record_price, before Tracking): opens the saved item. */
    | "price"
    /** A tracker started, a value kept or a target set (track, record_value, set_tracker_target): opens where it lives. */
    | "tracker"
    /** A picture made in a chat (make_image): shown in the reply, with its own Undo. */
    | "picture";
  id: string;
  action: "created" | "updated" | "completed";
  /** What it is ("Rowan · Christmas gift ideas") and what happened ("New list · Lego Technic Ferrari"). */
  title: string;
  detail: string;
  /** Both as one sentence, for screen readers. */
  label: string;
  /** A record's or kind's icon (its kind's own), when it has one. */
  icon?: string;
  /** Where Open goes. "fields": Settings, on this kind's fields (id is the kind). "kind": that kind's Library section (id is its id). */
  open:
    | { kind: "note" | "person" | "commitment" | "place" | "organisation" | "event" | "project" | "reading" | "goal" | "asset" | "trip" | "purchase" | "fields" | "kind" | "record" | "recipe" | "routine" | "skill" | "saved"; id: string }
    | { kind: "draft"; draft: EmailDraft }
    /** A Google Doc or Notion page Athena made: opens outside Athena. */
    | { kind: "doc"; provider: "google-docs" | "notion"; url: string }
    | null;
  /** Opaque to the app: sent back as is to undo the change. null = nothing to undo (an email draft). */
  undo: Record<string, unknown> | null;
  /** Its row in What Ask did (lib/ask-activity.ts): sent with Undo so the log agrees. */
  activity_id?: string;
}

/** A plan: two or more changes Ask worked out and made none of yet (mirrors lib/ask-plans.ts PlanCard). */
export interface AskPlan {
  id: string;
  source: "ask" | "routine";
  steps: Array<{ label: string; tool: string }>;
  /** From a routine, which only ever suggests. */
  proposed?: boolean;
  /** After Go: each step's outcome, in order. */
  ran?: { at: string; results: Array<{ status: "done" | "skipped" | "failed"; error?: string; changes: AssistantChange[] }> };
  /**
   * Go stopped before a step that needs an account the imported assistant that proposed it isn't allowed: nothing
   * reached it, and the card asks (Just this once, Always for <assistant>, Skip it). Mirrors lib/ask-plans.ts PlanAccountAsk.
   */
  needs_account?: { step: number; account: string; label: string | null; provider: string; assistant: string; skill?: { id: string | null; title: string }; results: Array<{ status: "done" | "skipped" | "failed"; error?: string; changes: AssistantChange[] }> };
}

/** Ask's start_assignment card (docs/team.md "Assignments"): the proposed lineup, and the assignment's id once Go started it. */
export interface AskLineupCard {
  lineup: import("../../lib/assignment-types").Lineup;
  /** The draft the server keeps it as (start_assignment): Go replaces that draft's lineup and starts it. */
  id?: string;
  /** The plain lineup, when the model's didn't check out. */
  fallback?: boolean;
  started?: string;
}

/** One of tonight's picks, from the owner's own list (mirrors lib/watch-tonight.ts WatchPick). */
export interface WatchPick {
  id: string;
  title: string;
  kind: "film" | "tv";
  why: string;
  from: string;
  score: number;
}

/** A confirm card as the app holds it: the draft is the app's MessageDraft. */
export type AskConfirmCard = import("../../lib/assistant-confirm").ConfirmCard<MessageDraft>;

export interface AssistantReply {
  text: string;
  changes: AssistantChange[];
  /** The assistant needs a pick; each becomes a button that answers it. */
  choices: string[];
  /** find_times' three times, or a move waiting for the owner to confirm (components/slot-card.ts). */
  scheduling?: import("./db/scheduling").SchedulingCard;
  /** An invite answer, a draft for Gmail or Outlook, or a note for Docs or Notion, each waiting for a tap (components/ask-confirm.ts). */
  confirm?: AskConfirmCard[];
  /** Summaries Athena wrote for the files it read, by file id. */
  file_summaries?: Record<string, string>;
  /** Two or three short follow-ups written with the reply; tapping one sends it. */
  next?: string[];
  /** Changes waiting for the owner to tick and Go; nothing in it has happened until then. */
  plan?: AskPlan;
  /** Something to watch tonight: picks from the owner's own list, each with why. */
  picks?: WatchPick[];
  /** The owner's skills this reply used: the "Used" line under it. */
  skills?: Array<{ id: string; name: string }>;
}

// ---------- Ask's saved chats (app/src/db/ask-threads.ts, lib/ask-threads.ts) ----------

/** One message as saved. Search answers are references only: never copies of note text. */
/** One live step of an Ask request (mirrors lib/steps.ts): the same id replaces the line before it. */
export interface AskStep {
  id: string;
  text: string;
  done: boolean;
  /** It may change something (the assistant's own tools that don't just look). */
  acts?: boolean;
  dropped?: boolean;
  changes?: AssistantChange[];
}

/** A file the owner added (mirrors lib/files.ts FileMeta): kept with the conversation by id, never as bytes. */
export interface AskFile {
  id: string;
  name: string;
  type: string;
  size: number;
  width?: number | null;
  height?: number | null;
  pages?: number | null;
  has_thumb?: boolean;
  /** Athena's short summary, written the first time it read the file (kept for Conversations search). */
  summary?: string | null;
  /** Deleted for good (with a note); the conversation shows it as removed. */
  removed?: boolean;
  /** On a note's file: a conversation still has it (deleting the note offers to delete it too). */
  in_conversation?: boolean;
}

export type SavedAskMessage =
  | {
      role: "me";
      text: string;
      at: string;
      files?: AskFile[];
      /** The run answering it (lib/ask-run.ts), until its reply lands. */
      run?: { id: string; kind: "act" | "answer" };
      /** What set off a Team run ("New gift idea: “…”", "Run now"), not the owner's words: a quiet line with no Edit (lib/team-chat.ts). */
      run_line?: boolean;
      /** This message only: the thinking model the owner picked when the chosen one couldn't see its photo (lib/vision-warning.ts). */
      model?: import("../../lib/model-types").ModelRef;
    }
  | {
      role: "athena";
      at: string;
      question: string;
      terms: string[];
      /** Note ids, best first. */
      notes: string[];
      /** Everything else that matched, by kind and id. */
      others: Array<{ kind: RecallKind; id: string }>;
    }
  | ({
      /** A written answer with sources (lib/answer.ts). Athena's own sources and related items are kept by id and loaded as they are now; a connected account's source (an email, a call) keeps its title, since it can't be loaded again. */
      role: "answer";
      at: string;
      question: string;
      text: string;
      /** Read live from the work accounts: text is LIVE_ONLY_KEPT and nothing else of it was kept. */
      live_only?: true;
      /** art and detail: a cover Athena holds and a Watch & read title's state, kept so a reopened answer still shows its cards. */
      sources: Array<{ n: number; kind: string; id: string | null; url: string | null; date: string | null; account: string | null; title?: string; art?: { id: string; w: number; h: number; tone?: string }; detail?: string }>;
      related: Array<{ kind: "note" | "person" | "todo" | "record"; id: string }>;
      searched: string;
      skipped: string[];
      found: boolean;
      flagged: boolean;
      sample: boolean;
      /** It fell back to a keyword search: why, and what it found, by reference. */
      note: string | null;
      fallback: { terms: string[]; notes: string[]; others: Array<{ kind: RecallKind; id: string }> } | null;
      /** What Athena did on the way, as it showed them ("Searched your notes"). Older answers have none. */
      steps?: string[];
      /** Follow-ups written with it (lib/ask-stream.ts). */
      next?: string[];
      /** The answer was a question back; `next` holds its choices. */
      clarify?: boolean;
      /** Several questions asked at once, each with its choices. */
      asks?: Array<{ question: string; options: string[] }>;
      /** The owner's skills it used: its "Used" line. */
      skills?: Array<{ id: string; name: string }>;
    } & AskReplyKept)
  | ({
      role: "assistant";
      at: string;
      /** The turns that were sent, so the assistant keeps context when the chat is resumed. */
      request: AssistantTurn[];
      reply: AssistantReply | null;
      error: string | null;
      /** Change keys undone here, and ones whose undo no longer works (hidden). */
      undone: string[];
      gone?: string[];
      answered: boolean;
      /** Saved while still working: its run (lib/ask-run.ts), so the reopened app follows it. */
      run?: string;
      /** What Athena did on the way, as it showed them ("Found Rowan Hart"). Older replies have none. */
      steps?: string[];
    } & AskReplyKept);

/** Kept on a reply (app/src/lib/ask-pins.ts, ask-versions.ts): no schema change, it rides in the conversation's messages. */
export interface AskReplyKept {
  /** Pinned to the top of Ask's history. */
  pinned_at?: string;
  /** Stopped by the owner part-way. */
  stopped?: boolean;
  /** Every version when it was written again, oldest first, and which one shows. */
  versions?: SavedAskMessage[];
  version?: number;
}

export interface AskThread {
  id: string;
  /** The owner's own name; "" = named from the first message. */
  title: string;
  messages: SavedAskMessage[];
  /** Archived from Ask: hidden there, listed on the Archived page. */
  archived_at?: string | null;
  /** One of the Team's assistants this conversation is with (docs/team.md); null or missing: Athena. */
  assistant_id?: string | null;
  created_at: string;
  updated_at: string;
  /** Couldn't be decrypted where it was read: shown, never saved back. */
  locked?: boolean;
}

// ---------- The owner's own kinds of record (mirrors lib/custom-kinds.ts) ----------

/** One of the owner's own kinds of record: "Wines", with its own fields (kind "custom:<id>"). */
export interface CustomKind {
  id: string;
  /** Its fields' kind: "custom:<id>". */
  kind: `custom:${string}`;
  /** "Wines": as the Library shows it. */
  name: string;
  /** "wine": one record, mid-sentence ("New wine"). */
  one: string;
  /** One of KIND_ICONS (lib/custom-field-rules.ts). */
  icon: string;
  position: number;
  /** Live records. */
  record_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A record in one of the owner's own kinds: a title, Markdown notes, and its fields' values (db/custom-fields.ts). */
export interface CustomRecord {
  id: string;
  kind_id: string;
  title: string;
  body: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
