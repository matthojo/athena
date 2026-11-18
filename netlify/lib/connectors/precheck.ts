/**
 * Before a collection starts Claude, look at what's new, cheaply.
 *
 *  1. Glance: Athena calls each account's own "what's new" listing itself,
 *     with no model: Granola's list_meetings (updated since the last good
 *     run), Gmail's and Outlook's search_threads (threads since then),
 *     iCloud Calendar's list_events (events since then), and the Life log's
 *     Trakt, YouTube, Letterboxd, Goodreads, Readwise, Bluesky and Mastodon listings.
 *  2. Nothing new on any account: the run ends there and Claude isn't started.
 *  3. Email: Jev sorts the new threads by where they belong (an action, a
 *     receipt, a date, a renewal, an alert, reference, or noise) in one
 *     batched call, and Claude is told which to read and which tool each
 *     goes to, instead of opening newsletters and notifications.
 *
 * Anything uncertain (an account without a known listing, a listing Athena
 * can't read, Jev unavailable, upcoming events that no longer match what was
 * synced, a custom recipe, a first run, Run now) and the run goes ahead
 * exactly as before. A collection with "Skip days with nothing new" off
 * (skip_quiet) always runs.
 */
import { q } from "../../../lib/db";
import { askJev, choice, noul } from "../../../lib/jev";
import { addDays, zonedParts } from "../../../lib/dates";
import { listCollected, type Collection, type CollectionRun } from "../../../lib/connectors";
import { callTool, type OpenConnector } from "./mcp-client";

export interface Precheck {
  /** End the run here: nothing worth Claude's time. */
  skip: boolean;
  /** For the run log when skipping. */
  reason: string;
  /** Added to Claude's run context when not skipping (which emails to read). */
  note: string | null;
  /** Email threads Jev judged not worth reading. */
  triagedOut: number;
}

const GO: Precheck = { skip: false, reason: "", note: null, triagedOut: 0 };

/** When the collection last ran successfully (excluding this run), or null. */
export async function lastGoodRun(collectionId: string, runId: string): Promise<Date | null> {
  const [row] = await q<{ at: string | null }>(
    `SELECT max(started_at) AS at FROM collection_runs WHERE collection_id = $1 AND id <> $2 AND status = 'succeeded'`,
    [collectionId, runId],
  );
  return row?.at ? new Date(row.at) : null;
}

// ---------- reading the listings ----------

export interface EmailThread {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: string;
  labels: string[];
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.name ?? o.displayName ?? o.email ?? o.address ?? "");
  }
  return v == null ? "" : String(v);
}

/** Gmail's search_threads JSON as threads; null when it isn't readable. `{}` means none. */
export function parseGmailThreads(text: string): EmailThread[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const threads = (data as { threads?: unknown }).threads;
  if (threads === undefined) return Object.keys(data).length === 0 ? [] : null;
  if (!Array.isArray(threads)) return null;
  return threads.flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const thread = t as Record<string, unknown>;
    const messages = Array.isArray(thread.messages) ? (thread.messages as Array<Record<string, unknown>>) : [];
    const last = messages[messages.length - 1] ?? {};
    const id = str(thread.id);
    if (!id) return [];
    return [
      {
        id,
        subject: str(last.subject ?? thread.subject).slice(0, 200),
        from: str(last.sender ?? last.from).slice(0, 120),
        snippet: str(last.snippet ?? thread.snippet).slice(0, 300),
        date: str(last.date ?? thread.date),
        labels: (Array.isArray(last.labelIds) ? last.labelIds : Array.isArray(last.label_ids) ? last.label_ids : []).map(String),
      },
    ];
  });
}

/** A listing's own count of what it holds ("total_count": 0, total_count="3"), if it says. */
export function statedCount(text: string): number | null {
  const m = /total_count["'\s]*[:=]\s*"?(\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

// ---------- the glance ----------

/** Gmail's after: is a whole day; threads older than `since` are dropped below. Outlook's search_threads takes the same query. */
const emailGlance = {
  tool: "search_threads",
  args: (since: Date, tz: string) => ({ query: `after:${zonedParts(since, tz).date.replaceAll("-", "/")} -in:sent -in:chats`, pageSize: 50, view: "THREAD_VIEW_SUMMARY" }),
};

/** Accounts whose search_threads gives Gmail-shaped threads. */
const EMAIL_PROVIDERS = new Set(["gmail", "outlook-mail", "fastmail"]);

/** How to ask each kind of account "what's new since…". */
const GLANCES: Record<string, { tool: string; args: (since: Date, tz: string) => Record<string, unknown> }> = {
  granola: {
    tool: "list_meetings",
    args: (since) => ({ updated_after: since.toISOString(), limit: 50, max_participants: 5 }),
  },
  gmail: emailGlance,
  "outlook-mail": emailGlance,
  fastmail: emailGlance,
  // Meetings that took place since the last good run (iCloud: on every chosen calendar).
  "google-calendar": calendarGlance(),
  "outlook-calendar": calendarGlance(),
  "icloud-calendar": calendarGlance(),
};

/** Calendar accounts: list_events since the last good run, the same tool and JSON for Google, Outlook and iCloud. */
function calendarGlance() {
  return { tool: "list_events", args: (since: Date) => ({ startTime: since.toISOString(), endTime: new Date().toISOString(), pageSize: 250 }) };
}
const CALENDAR_PROVIDERS = new Set(["google-calendar", "outlook-calendar", "icloud-calendar"]);

/** One event in a list_events reply, as the upcoming check reads it. */
interface ListedEvent {
  id?: string;
  summary?: string;
  start?: string;
  allDay?: boolean;
  myResponse?: string;
  eventType?: string;
}
/** What a collection saved for one synced event: its title, its day, and for a timed one the instant it starts. */
export interface SavedEvent {
  external_id: string;
  title: string;
  date: string | null;
  starts_at: string | null;
}

/** Events the Meetings agent doesn't save (recipes.ts step 5b): declined, and markers rather than meetings. */
const NOT_SAVED_TYPES = new Set(["workingLocation", "outOfOffice", "focusTime"]);

/**
 * Do the calendars' upcoming events match what the collection saved, one for
 * one: same ids, titles and start times? Then syncing them again would change
 * nothing. Anything moved, renamed, new or gone means no.
 */
export function sameUpcoming(listed: ListedEvent[], saved: SavedEvent[]): boolean {
  const norm = (t: string | undefined) => (t ?? "").trim().toLowerCase();
  const wanted = listed.filter((e) => e.myResponse !== "declined" && !NOT_SAVED_TYPES.has(e.eventType ?? ""));
  const byId = new Map(saved.map((s) => [s.external_id, s]));
  if (wanted.length !== saved.length) return false;
  return wanted.every((e) => {
    const s = e.id ? byId.get(e.id) : undefined;
    if (!s || norm(s.title) !== norm(e.summary)) return false;
    if (e.allDay) return s.date === e.start;
    return !!s.starts_at && !!e.start && Date.parse(s.starts_at) === Date.parse(e.start);
  });
}

/** The live events this collection synced between two days (inclusive), with their start instants. */
async function savedUpcoming(source: string, from: string, to: string): Promise<SavedEvent[]> {
  const items = (await listCollected(source, "event", from, to, 500)).filter((i) => i.state === "live");
  if (!items.length) return [];
  const starts = await q<{ id: string; starts_at: string | null }>(`SELECT id, starts_at FROM events WHERE id = ANY($1::uuid[])`, [items.map((i) => i.record_id)]);
  const at = new Map(starts.map((r) => [r.id, r.starts_at ? new Date(r.starts_at).toISOString() : null]));
  return items.map((i) => ({ external_id: i.external_id, title: i.title, date: i.item_date, starts_at: at.get(i.record_id) ?? null }));
}

/**
 * For a collection that syncs upcoming events: does every calendar's next
 * `days` days still match what was saved? Null when it can't tell (a listing
 * that failed or ran to a second page), which counts as no.
 */
async function upcomingUnchanged(collection: Collection, opened: OpenConnector[], allowed: Map<OpenConnector, Set<string>>, tz: string): Promise<boolean> {
  const today = zonedParts(new Date(), tz).date;
  const last = addDays(today, collection.lookahead_days);
  const listed: ListedEvent[] = [];
  for (const o of opened) {
    if (!CALENDAR_PROVIDERS.has(o.connector.provider) || !allowed.get(o)?.has("list_events")) continue;
    try {
      const r = await callTool(o, "list_events", { startTime: today, endTime: addDays(last, 1), timeZone: tz, pageSize: 250 });
      if (r.isError) return false;
      const body = JSON.parse(r.text) as { events?: ListedEvent[]; nextPageToken?: string };
      if (body.nextPageToken) return false;
      listed.push(...(body.events ?? []));
    } catch {
      return false;
    }
  }
  return sameUpcoming(listed, await savedUpcoming(collection.source, today, last));
}

/**
 * How many events in a list_events reply started since `since` (an all-day
 * event: on or after that day in `tz`), so a trip that was already on doesn't
 * count as new every run. Null when it isn't a reply Athena can read. With
 * more pages, at least one new event is enough to say so.
 */
export function eventCount(text: string, since?: Date, tz = "UTC"): number | null {
  try {
    const data = JSON.parse(text) as { events?: Array<{ start?: unknown; allDay?: unknown }>; nextPageToken?: unknown };
    if (data.events === undefined) return typeof data === "object" && data !== null && !data.nextPageToken ? 0 : null;
    if (!Array.isArray(data.events)) return null;
    const day = since ? zonedParts(since, tz).date : "";
    const fresh = data.events.filter((e) => {
      if (!since || typeof e.start !== "string") return true;
      return e.allDay === true ? e.start >= day : !(Date.parse(e.start) < since.getTime());
    }).length;
    if (data.nextPageToken) return fresh || null;
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Life log accounts: each tool takes `after` and answers with a `count`
 * (feeds-shared.ts). The glance asks every allowed one for one item since
 * the last good run; a tool the owner turned off isn't asked, since Claude
 * couldn't read it either. Letterboxd dates a film by
 * day, not time, so it's asked from the start of that day: an entry
 * logged late that evening still counts. Goodreads dates a book by when
 * Athena first saw it, so a book is new only if this look is the first to
 * see it (just_noticed).
 */
const LIFE_GLANCES: Record<string, { tools: string[]; byDay?: boolean; justNoticed?: boolean; args?: Record<string, unknown>; copied?: boolean }> = {
  trakt: { tools: ["list_history", "list_ratings", "list_watchlist", "list_in_progress"] },
  youtube: { tools: ["list_liked_videos", "list_subscriptions"] },
  letterboxd: { tools: ["list_diary"], byDay: true },
  goodreads: { tools: ["list_books"], justNoticed: true },
  plex: { tools: ["watch_history"] },
  jellyfin: { tools: ["watch_history"] },
  lichess: { tools: ["list_games"] },
  chesscom: { tools: ["list_games"] },
  // Copied into Trips before the glance (tripit-trips.ts): nothing left for Claude.
  tripit: { tools: [], copied: true },
  // What reached Readwise since the last run, whichever day it was highlighted (a late Kindle sync counts).
  readwise: { tools: ["list_highlights"], args: { by: "added", text: false } },
  bluesky: { tools: ["my_posts"] },
  mastodon: { tools: ["my_posts"] },
  listenbrainz: { tools: ["list_listens"] },
  raindrop: { tools: ["list_bookmarks"] },
  // Events that happened since: an order bought today for next month is not a day's activity.
  eventbrite: { tools: ["list_orders"], args: { when: "past" } },
};

/** A Life log tool's `count` (or another field it names), or null when the answer isn't one. */
export function lifeCount(text: string, field = "count"): number | null {
  try {
    const n = (JSON.parse(text) as Record<string, unknown>)[field];
    if (typeof n === "number" && Number.isFinite(n)) return n;
    // compact() drops an empty list but keeps count 0; a reply with neither isn't readable.
    return null;
  } catch {
    return null;
  }
}

async function lifeGlance(open: OpenConnector, allowed: Set<string>, since: Date, tz: string): Promise<number | null> {
  const spec = LIFE_GLANCES[open.connector.provider];
  if (spec.copied) return 0;
  const tools = spec.tools.filter((t) => allowed.has(t));
  if (!tools.length) return null;
  const after = spec.byDay ? zonedParts(since, tz).date : since.toISOString();
  // Goodreads has no dates: what's new is what this look is the first to see, on the shelves the Life log reads.
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = spec.justNoticed
    ? tools.flatMap((tool) => ["read", "currently-reading", "to-read"].map((shelf) => ({ tool, args: { shelf, limit: 1 } })))
    : tools.map((tool) => ({ tool, args: { after, limit: 1, ...spec.args } }));
  const counts = await Promise.all(
    calls.map(async ({ tool, args }) => {
      try {
        const r = await callTool(open, tool, args);
        return r.isError ? null : lifeCount(r.text, spec.justNoticed ? "just_noticed" : "count");
      } catch {
        return null;
      }
    }),
  );
  return counts.some((c) => c === null) ? null : (counts as number[]).reduce((a, b) => a + b, 0);
}

interface Glance {
  open: OpenConnector;
  /** How many new items, or null when it couldn't be told. */
  count: number | null;
  threads?: EmailThread[];
}

export async function glance(open: OpenConnector, allowed: Set<string>, since: Date, tz: string): Promise<Glance> {
  if (LIFE_GLANCES[open.connector.provider]) return { open, count: await lifeGlance(open, allowed, since, tz) };
  const spec = GLANCES[open.connector.provider];
  if (!spec || !allowed.has(spec.tool)) return { open, count: null };
  let text: string;
  try {
    const r = await callTool(open, spec.tool, spec.args(since, tz));
    if (r.isError) return { open, count: null };
    text = r.text;
  } catch {
    return { open, count: null };
  }

  if (EMAIL_PROVIDERS.has(open.connector.provider)) {
    const threads = parseGmailThreads(text);
    if (!threads) return { open, count: null };
    // Keep threads whose latest message is newer than the last good run (undated ones stay).
    const fresh = threads.filter((t) => {
      const at = Date.parse(t.date);
      return Number.isNaN(at) || at > since.getTime();
    });
    return { open, count: fresh.length, threads: fresh };
  }

  if (CALENDAR_PROVIDERS.has(open.connector.provider)) return { open, count: eventCount(text, since, tz) };

  const stated = statedCount(text);
  if (stated !== null) return { open, count: stated };
  // A format Athena doesn't parse: let Jev read it.
  const answers = await askJev({ listing: text }, { any: noul("Does this listing include at least one meeting or item?") }, { timeoutMs: 4000 });
  if (!answers) return { open, count: null };
  if (answers.any.noul < 0.15) return { open, count: 0 };
  if (answers.any.noul > 0.85) return { open, count: 1 };
  return { open, count: null };
}

// ---------- email triage ----------

/**
 * Where each new thread should go, not how important it seems: most mail
 * Athena keeps becomes a structured record (an order, a booking, an event, a
 * renewal, a to-do), and only "reference" mail becomes a note. Anything with
 * nothing to do, no date and nothing to look up later is noise, however
 * friendly.
 */
export const KINDS = {
  action: "Asks the owner to do, decide, pay or reply to something, or a real person wrote to them and expects an answer",
  receipt:
    "About something the owner booked or bought: an order or booking confirmation, a ticket, an itinerary, a ride or takeaway receipt, or an update on one (dispatched, out for delivery, delivered, delayed, a changed or cancelled booking)",
  date: "Sets a date the owner needs to keep: an appointment (doctor, dentist, vet, haircut, a repair visit), a deadline, a parents' evening, a confirmed reservation that isn't travel",
  renewal: "Says something renews or expires: insurance, MOT, car tax, passport, a licence, a warranty, a domain, a subscription's renewal or price change",
  alert: "A security or account alert about the owner's own account: a new sign-in, a password or email changed, a failed or declined payment, an account locked or suspended, a direct debit cancelled",
  reference: "Information the owner would want to look up later and can't easily get again: a letter, a quote or estimate, terms they agreed to, a reply from a real person with facts or decisions",
  noise:
    "A newsletter, marketing, a social or app notification, a digest, or anything that's only nice to know: nothing to do, no date and nothing to look up later",
} as const;

export type Kind = keyof typeof KINDS;

/**
 * The wording of transactional email about the owner's own orders and
 * bookings. Shipping updates are automated notifications, so a classifier
 * can file them as noise; anything that reads like one of these is kept
 * as a receipt instead, so it reaches Claude and becomes a trip or purchase.
 */
const TRANSACTIONAL =
  /\b(order (?:confirm|number|no\.?|#|has|is|was|update)|your (?:order|booking|reservation|itinerary|trip|flight|tickets?|e-?tickets?|parcel|package|delivery|refund|return)|has (?:been )?(?:dispatched|shipped|delivered)|out for delivery|delivery (?:update|attempt|scheduled|day|date)|arriving (?:today|tomorrow)|tracking (?:number|link)|booking (?:confirm|reference|ref)|reservation (?:confirm|number)|confirmation (?:number|code)|e-?tickets?|boarding pass|check-?in (?:is )?(?:now )?open|schedule change|flight (?:change|cancel|update)|refund (?:issued|processed|confirm)|(?:trip|ride|order) with (?:uber|bolt)|ride receipt|thanks for riding)/i;

/** Security and account alerts, which read like automated notifications. */
const ALERT =
  /\b(security alert|new (?:sign-?in|login|device)|sign-?in (?:attempt|from)|unusual (?:activity|sign-?in)|suspicious (?:activity|sign-?in)|password (?:was |has been )?(?:changed|reset)|email address (?:was |has been )?changed|payment (?:failed|declined|unsuccessful|problem)|card (?:was |has been )?declined|couldn't (?:take|process) (?:your )?payment|account (?:is )?(?:locked|suspended|on hold|compromised)|direct debit (?:cancelled|failed)|two-?(?:step|factor) (?:verification )?(?:turned off|disabled))/i;

/** Renewal and expiry notices, which read like marketing ("Don't miss out, renew now"). */
const RENEWAL =
  /\b(renews? (?:on|soon|automatically)|(?:auto-?)?renewal (?:notice|reminder|date|invitation|quote)|due for renewal|time to renew|(?:will |is )?expir(?:es|ing|y) (?:on|soon|date|in)|has expired|(?:mot|car tax|road tax|vehicle tax) (?:is )?(?:due|reminder|expires)|passport (?:expires|renewal)|policy (?:renewal|documents))/i;

/** Appointments and deadlines, which often come from a booking system's no-reply address. */
const DATE =
  /\b(appointment (?:confirm|reminder|booked|is|on|for|has been)|your (?:appointment|visit|consultation)|reminder: (?:your )?(?:appointment|visit)|engineer (?:visit|will)|parents'? evening|(?:due|deadline) (?:by|on|date)|submit (?:by|before))/i;

const RESCUES: Array<[RegExp, Kind]> = [
  [TRANSACTIONAL, "receipt"],
  [ALERT, "alert"],
  [RENEWAL, "renewal"],
  [DATE, "date"],
];

export function looksTransactional(t: Pick<EmailThread, "subject" | "snippet">): boolean {
  return TRANSACTIONAL.test(`${t.subject}\n${t.snippet}`);
}

/** What the wording alone says a thread is (a receipt, an alert, a renewal or a date), for mail a classifier would drop. Pure. */
export function rescueKind(t: Pick<EmailThread, "subject" | "snippet">): Kind | null {
  const text = `${t.subject}\n${t.snippet}`;
  return RESCUES.find(([re]) => re.test(text))?.[1] ?? null;
}

/**
 * One thread's kind from Jev's answer. Clear noise is dropped; noise Jev
 * isn't sure of becomes the likeliest other kind, so it's still read. Noise
 * or reference whose wording says it's an order, a booking, an alert, a
 * renewal or a date is read as that instead. Pure.
 */
export function sortThread(t: Pick<EmailThread, "subject" | "snippet">, answer: { choice: Kind; probabilities: Partial<Record<Kind, number>> }): Kind {
  let kind: Kind = answer.choice;
  if (kind === "noise" && (answer.probabilities.noise ?? 1) < 0.6) {
    const others = (Object.keys(KINDS) as Kind[]).filter((k) => k !== "noise");
    kind = others.reduce<Kind>((best, k) => ((answer.probabilities[k] ?? 0) > (answer.probabilities[best] ?? 0) ? k : best), "reference");
  }
  if (kind === "noise" || kind === "reference") kind = rescueKind(t) ?? kind;
  return kind;
}

/** Sort new threads with one Jev call; null when Jev isn't there to ask. */
export async function triageThreads(threads: EmailThread[]): Promise<Array<EmailThread & { kind: Kind }> | null> {
  if (!threads.length) return [];
  const batch = threads.slice(0, 40);
  const questions = Object.fromEntries(batch.map((_, i) => [`t${i}`, choice(`Where does email thread ${i + 1} in the list belong?`, KINDS)]));
  const answers = await askJev(
    {
      about:
        "New email threads in the owner's inbox. Athena keeps only what matters: orders, bookings, dates, renewals, account alerts, things to act on, and the odd email worth looking up later. Everything else is noise.",
      threads: batch.map((t, i) => ({ n: i + 1, from: t.from, subject: t.subject, snippet: t.snippet, labels: t.labels })),
    },
    questions,
    { timeoutMs: 8000 },
  );
  if (!answers) return null;
  return batch.map((t, i) => ({ ...t, kind: sortThread(t, answers[`t${i}`] as unknown as { choice: Kind; probabilities: Record<Kind, number> }) }));
}

/** Where Claude is told each kind of thread goes. */
export const KIND_TOOLS: Record<Exclude<Kind, "noise">, string> = {
  receipt: "travel bookings with athena_trip_booking, ride and takeaway receipts with athena_receipt, other orders and delivery updates with athena_purchase",
  date: "athena_email_date (an appointment or a deadline)",
  renewal: "athena_renewal",
  alert: "athena_alert",
  action: "athena_todo (with due_on when a date is given)",
  reference: "a note with athena_save_note, only if it really is worth looking up later",
};

/** Claude's run context for the threads Jev sorted: which to read, and where each goes. Pure. */
export function triageNote(all: Array<EmailThread & { kind: Kind }>): string {
  const keep = all.filter((t) => t.kind !== "noise");
  const triagedOut = all.length - keep.length;
  const lines = keep.map((t) => `- ${t.id} · ${t.subject || "(no subject)"} · from ${t.from || "unknown"} (${t.kind})`);
  const kinds = (Object.keys(KIND_TOOLS) as Array<keyof typeof KIND_TOOLS>).filter((k) => keep.some((t) => t.kind === k));
  return [
    `Athena's quick classifier has already looked at the ${all.length} email ${all.length === 1 ? "thread" : "threads"} that arrived since the last run.`,
    keep.length ? `Read only these ${keep.length}, which look worth recording (thread id · subject · sender (where it goes)):\n${lines.join("\n")}` : "None of them look worth recording.",
    kinds.length
      ? `Where each goes, if those tools are offered:\n${kinds.map((k) => `- (${k}): ${KIND_TOOLS[k]}`).join("\n")}\nThe classifier only saw the subject and a snippet. If a thread turns out to be something else once you read it, record it where it really belongs, or skip it.`
      : "",
    triagedOut
      ? `The other ${triagedOut} looked like newsletters, marketing, notifications or nice-to-know mail: don't search for or open them unless the owner's instructions ask for that kind of mail.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------- the decision ----------

export async function precheck(input: {
  collection: Collection;
  run: Pick<CollectionRun, "id" | "trigger">;
  opened: OpenConnector[];
  /** Each opened account's allowed tool names. */
  allowed: Map<OpenConnector, Set<string>>;
  /** Accounts that couldn't be opened this run. */
  unreachable: number;
  tz: string;
}): Promise<Precheck> {
  const { collection, run, opened, allowed, unreachable, tz } = input;
  // Custom instructions need Claude to look, whatever's new.
  if (collection.recipe === "custom") return GO;
  const since = await lastGoodRun(collection.id, run.id);
  if (!since) return GO;

  const glances = await Promise.all(opened.map((o) => glance(o, allowed.get(o) ?? new Set(), since, tz)));
  // Skipping is the owner's choice per collection ("Skip days with nothing new", on by default).
  const mayskip = collection.skip_quiet !== false && run.trigger !== "manual";
  let quietEverywhere = mayskip && unreachable === 0 && glances.length > 0 && glances.every((g) => g.count === 0);
  // Upcoming events synced into Athena: quiet only if they still match what was saved.
  if (quietEverywhere && collection.lookahead_days > 0) quietEverywhere = await upcomingUnchanged(collection, opened, allowed, tz);
  // Run now means "look now": never skip it.
  if (quietEverywhere) {
    return { skip: true, reason: "Nothing new since the last run, so Claude wasn't needed.", note: null, triagedOut: 0 };
  }

  const email = glances.filter((g) => g.threads && g.threads.length);
  if (!email.length) return GO;
  const sorted = await Promise.all(email.map((g) => triageThreads(g.threads!)));
  if (sorted.some((s) => s === null)) return GO;
  const all = (sorted as Array<Array<EmailThread & { kind: Kind }>>).flat();
  const keep = all.filter((t) => t.kind !== "noise");
  const triagedOut = all.length - keep.length;
  const emailOnly = unreachable === 0 && glances.every((g) => g.threads !== undefined);
  if (!keep.length && emailOnly && mayskip) {
    return { skip: true, reason: `Only newsletters and notifications since the last run (${all.length}), so Claude wasn't needed.`, note: null, triagedOut };
  }
  const note = triageNote(all);
  return { skip: false, reason: "", note, triagedOut };
}
