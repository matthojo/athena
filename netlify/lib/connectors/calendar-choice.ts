/**
 * Which calendars Athena reads. Google Calendar and Outlook keep the ids
 * switched on in `connectors.calendars` (no secrets, never in `scope`, which
 * holds their OAuth scopes); NULL means only the main calendar, so nothing
 * changes until the owner switches more on, and calendars found later stay
 * off. iCloud keeps the ids switched off in `scope` (icloud-direct.ts), so
 * its new calendars are on.
 */
import { AthenaInputError } from "../../../lib/db";

/** One calendar on the account, for the picker (GET /api/connectors/:id/calendars). */
export interface CalendarChoice {
  id: string;
  name: string;
  color?: string;
  /** The account's main calendar (Google's primary, Outlook's default). */
  primary?: boolean;
  /** Someone else's calendar, shared with the owner. */
  shared: boolean;
  /** Who shared it, when the calendar says ("Rowan Thorne"). */
  owner?: string;
  /** The owner's own calendar, shared with other people. */
  sharedByYou: boolean;
  /** A public calendar the owner subscribes to (holidays, sports). */
  subscribed?: boolean;
  /** Events in the next 30 days, so the busy ones are easy to spot. */
  upcoming: number;
  chosen: boolean;
}

/** A calendar a tool reads: its id and, for labelling events, its name. */
export interface ChosenCalendar {
  id: string;
  name: string;
  primary: boolean;
}

/** The main calendar alone: what Google and Outlook read until the owner chooses. */
export const MAIN_ONLY: ChosenCalendar[] = [{ id: "primary", name: "", primary: true }];

/** The calendars switched on, main first; the main one alone when none of the chosen ones is there any more. */
export function pickChosen<T extends { id: string; primary?: boolean }>(all: T[], chosen: readonly string[] | null | undefined): T[] {
  const main = all.find((c) => c.primary) ?? all[0];
  const on = chosen ? all.filter((c) => chosen.includes(c.id)) : [];
  if (!on.length) return main ? [main] : [];
  return [...on.filter((c) => c.primary), ...on.filter((c) => !c.primary)];
}

/** Is this calendar id one of the chosen ones? `primaryId` is the main calendar's real id, for the main-only default. */
export function isChosen(chosen: ChosenCalendar[], id: string, primaryId?: string): boolean {
  return chosen.some((c) => c.id === id || (c.id === "primary" && !!primaryId && id === primaryId));
}

/** The body's `calendars` for PATCH /api/connectors/:id: ids only. */
export function readCalendarIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 200) throw new AthenaInputError("Those aren't calendar ids");
  const ids = v.map((x) => (typeof x === "string" ? x.trim() : ""));
  if (!ids.length) throw new AthenaInputError("Keep at least one calendar on");
  if (ids.some((id) => !id || id.length > 600 || /[\s\u0000-\u001f]/.test(id))) throw new AthenaInputError("Those aren't calendar ids");
  return [...new Set(ids)];
}

/** One read per open, the first time a tool needs it. A failure isn't kept, so the next call tries again. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => {
    p ??= load().catch((e) => {
      p = undefined;
      throw e;
    });
    return p;
  };
}
