/**
 * iCloud Calendar and Contacts without MCP: a narrow, read-only adapter over
 * CalDAV and CardDAV, registered in direct.ts.
 *
 * Why not MCP: Apple has no iCloud API and no MCP server. CalDAV
 * (caldav.icloud.com) and CardDAV (contacts.icloud.com) are open standards
 * that take the owner's Apple ID and an app-specific password, which is
 * what an iCloud account stores (auth_type "token": the password as the
 * token, the Apple ID as `username`, sealed together).
 *
 * Calendar keeps Google Calendar's tool names, arguments and JSON fields
 * (icloud-calendar.ts), so Meetings, precheck and Ask treat it as they treat
 * a Google calendar. Contacts (icloud-contacts.ts) offers search_contacts,
 * get_contact and list_contacts. Read-only by construction: icloud-dav.ts
 * only sends GET, PROPFIND and REPORT, to iCloud's own hosts, plus one
 * conditional PUT of your own PARTSTAT when "Let Athena answer invites" is
 * on (respond_to_event, icloud-rsvp.ts).
 */
import { isAppleProvider, appleDirect, skippedCalendars, type AppleProvider } from "../../../lib/presets/apple";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { canMove, canRsvp, CREATE_TOOL, MOVE_TOOL, RSVP_TOOL, UNDO_CREATE_TOOL } from "../../../lib/connector-presets";
import { ledger } from "../../../lib/calendar-creates";

/** The calendar writes behind "Let Athena add and update events" (canMove). */
const EVENT_WRITES = new Set([MOVE_TOOL, CREATE_TOOL, UNDO_CREATE_TOOL]);
import { ToolInputError, mapLimit } from "./google-api";
import type { DirectAccount, DirectAdapter, DirectToolInfo } from "./direct";
import { ownerZone } from "./lifelog-b-http";
import { DavSession, IcloudError, NEW_PASSWORD, discover } from "./icloud-dav";
import { ICLOUD_CALENDAR_TOOLS, eventsIn, readCalendars, type IcloudCalendar, type IcloudCalendarContext } from "./icloud-calendar";
import { ICLOUD_CONTACTS_TOOLS, readBooks, readPeople, type Contact, type IcloudContactsContext } from "./icloud-contacts";

const WEBSITE: Record<AppleProvider, string> = { "icloud-calendar": "https://www.icloud.com/calendar/", "icloud-contacts": "https://www.icloud.com/contacts/" };

function info(t: DirectToolInfo): DirectToolInfo {
  return { name: t.name, description: t.description, summary: t.summary, inputSchema: t.inputSchema, annotations: t.annotations };
}

export function icloudTools(connector: Pick<Connector, "provider" | "scope">): DirectToolInfo[] {
  // respond_to_event only once "Let Athena answer invites" is on for it.
  // move_event, create_event and undo_create_event only with "Let Athena add and update events" on.
  if (connector.provider === "icloud-calendar") return ICLOUD_CALENDAR_TOOLS.filter((t) => (t.name !== RSVP_TOOL || canRsvp(connector)) && (!EVENT_WRITES.has(t.name) || canMove(connector))).map(info);
  if (connector.provider === "icloud-contacts") return ICLOUD_CONTACTS_TOOLS.map(info);
  return [];
}

/** Read once, the first time a tool needs it, for the length of one open. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= load().catch((e) => {
      p = undefined;
      throw e;
    });
    return p;
  };
}

/**
 * Open an account: find the owner's calendar or address book home (two
 * PROPFINDs, the first of which proves the Apple ID and password work).
 */
export async function openIcloud(connector: Connector, secrets: ConnectorSecrets, opts: { now?: () => Date; timeZone?: string } = {}): Promise<DirectAccount> {
  if (!isAppleProvider(connector.provider)) throw new IcloudError(400, "Not an iCloud account");
  const calendar = connector.provider === "icloud-calendar";
  const session = new DavSession(calendar ? "caldav" : "carddav", secrets);
  const found = await discover(session);
  const now = opts.now ?? (() => new Date());
  const run = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (calendar) {
      const tool = ICLOUD_CALENDAR_TOOLS.find((t) => t.name === name && tools.some((x) => x.name === name));
      if (!tool) return undefined;
      return tool.run(await calendarCtx(), args);
    }
    const tool = ICLOUD_CONTACTS_TOOLS.find((t) => t.name === name);
    if (!tool) return undefined;
    return tool.run(contactsCtx, args);
  };
  const timeZone = opts.timeZone ?? (await ownerZone());
  // Only the calendars the owner left on; the ones switched off are never read.
  const calendars = once<IcloudCalendar[]>(async () => pickCalendars(await readCalendars(session, found.home), skippedCalendars(connector.scope)));
  const appleId = secrets.username?.trim().toLowerCase();
  const calendarCtx = async (): Promise<IcloudCalendarContext> => ({
    session,
    home: found.home,
    emails: [...new Set([...found.emails, ...(appleId?.includes("@") ? [appleId] : [])])],
    timeZone,
    now,
    calendars,
    answering: canRsvp(connector),
    moving: canMove(connector),
    createdByAthena: canMove(connector) ? (calendarId, eventId) => ledger.has(connector.id, calendarId, eventId) : undefined,
  });
  const books = once<string[]>(() => readBooks(session, found.home));
  const contactsCtx: IcloudContactsContext = { session, home: found.home, books, people: once<Contact[]>(async () => readPeople(session, await books())) };
  const tools = icloudTools(connector);
  return {
    tools,
    async call(name, args) {
      if (!tools.some((t) => t.name === name)) return { text: `${name} isn't one of this account's tools`, isError: true };
      try {
        return { text: JSON.stringify(await run(name, args ?? {})), isError: false };
      } catch (error) {
        if (error instanceof ToolInputError) return { text: error.message, isError: true };
        // One request iCloud turned down (not found, a query it won't run): the model can try another way.
        if (error instanceof IcloudError && !error.needsOwner && !error.retryable) return { text: error.message, isError: true };
        throw error;
      }
    },
  };
}

/** The calendars left on, with the first of them primary when the usual primary is off. */
export function pickCalendars(all: IcloudCalendar[], skipped: string[]): IcloudCalendar[] {
  if (!skipped.length) return all;
  const picked = all.filter((c) => !skipped.includes(c.id)).map((c) => ({ ...c }));
  if (!picked.length) throw new ToolInputError("Every calendar is switched off for Athena. Switch one on in Sources");
  if (!picked.some((c) => c.primary)) picked[0].primary = true;
  return picked;
}

export interface CalendarChoice {
  id: string;
  name: string;
  color?: string;
  /** Someone else's calendar, shared with the owner. */
  shared: boolean;
  /** Who shared it, when iCloud says ("Rowan Thorne"). */
  owner?: string;
  /** The owner's own calendar, shared with other people. */
  sharedByYou: boolean;
  /** Events in the next 30 days, so the owner can see which calendars are busy. */
  upcoming: number;
  chosen: boolean;
}

/** Every calendar on the account, for the owner to choose from, with how busy each is. */
export async function icloudCalendarChoices(connector: Connector, secrets: ConnectorSecrets, now = new Date()): Promise<CalendarChoice[]> {
  const session = new DavSession("caldav", secrets);
  const found = await discover(session);
  const all = await readCalendars(session, found.home);
  const skipped = skippedCalendars(connector.scope);
  const ctx = { session, home: found.home, emails: found.emails, timeZone: "UTC", now: () => now, calendars: async () => all };
  const from = now.getTime();
  const counts = await mapLimit(all, 3, (c) => eventsIn(ctx, c, from, from + 30 * 86_400_000).then((e) => e.length).catch(() => 0));
  return all.map((c, i) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    shared: c.accessRole !== "owner",
    owner: c.accessRole !== "owner" ? c.sharedBy : undefined,
    sharedByYou: !!c.sharedOut,
    upcoming: counts[i],
    chosen: !skipped.includes(c.id),
  }));
}

/** A failure the owner has to fix: Apple turned down the Apple ID and password. */
export function icloudAccountProblem(error: unknown): boolean {
  return error instanceof IcloudError && error.needsOwner;
}

/** What a failure means for the account. Null when it isn't iCloud's. */
export function icloudFailure(error: unknown): { status: "needs_auth" | "error"; detail: string } | null {
  if (!(error instanceof IcloudError)) return null;
  if (error.needsOwner) return { status: "needs_auth", detail: error.status === 401 ? NEW_PASSWORD : error.message };
  return { status: "error", detail: error.message };
}

export const icloudAdapter: DirectAdapter = {
  id: "icloud",
  handles: appleDirect,
  tools: icloudTools,
  serverInfo: (c) => ({ website_url: WEBSITE[c.provider as AppleProvider] }),
  open: (connector, secrets) => openIcloud(connector, secrets),
  accountProblem: icloudAccountProblem,
  failure: icloudFailure,
};
