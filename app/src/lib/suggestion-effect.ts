/**
 * What answering a review-inbox card does, in words: the line under its
 * summary, the label on its accept button and the toast after. A card whose
 * find is already saved (`existing`, lib/suggestion-target.ts) says it
 * updates it: "Update status", not "Add to Purchases".
 */

import { BOOKING_LABEL, PURCHASE_LABEL, type BookingKind, type PurchaseStatus } from "../../../lib/trip-text";
import type { CommitmentKind, InteractionChannel, Suggestion } from "../types";
import { calendarDate } from "./format";
import { clockOfDay, clockTime } from "./clock";
import { CHANNEL_META } from "./memory-meta";
import { localToday } from "./time";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const possessive = (name: string) => `${name}’s`;
const statusWord = (status: unknown) => PURCHASE_LABEL[status as PurchaseStatus]?.toLowerCase() ?? "";

/** "12 December", with its year when that isn't this one. */
const day = (date: string) => calendarDate(date, date.slice(0, 4) !== localToday().slice(0, 4));

/** "12 December at 19:30", from a date and wall time or an instant. */
function when(p: Record<string, unknown>): string {
  const instant = str(p.starts_at);
  if (instant && !Number.isNaN(Date.parse(instant))) {
    const at = new Date(instant);
    return `${day(localToday(at))} at ${clockTime(at)}`;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str(p.date)) ? day(str(p.date)) : "";
  const time = str(p.time) ? clockOfDay(str(p.time)) : "";
  return date && time ? `${date} at ${time}` : date;
}

/** The line under a card's summary: what accepting will do. */
export function consequence(s: Pick<Suggestion, "op" | "payload" | "existing">, names: Map<string, string>): string {
  const p = s.payload ?? {};
  const had = s.existing ?? null;
  const name = (id: unknown) => (typeof id === "string" ? names.get(id) : undefined);
  switch (s.op) {
    case "commitment": {
      if (had) return `Updates “${had.name ?? str(p.title)}” in To do`;
      const kind = (p.kind as CommitmentKind) ?? "todo";
      const who = name(p.person_id);
      const what =
        kind === "waiting_on"
          ? `Adds it to To do, waiting on ${who ?? "someone else"}`
          : kind === "decision"
            ? "Records it as a decision in To do"
            : `Adds a to-do${who ? ` for ${who}` : ""}`;
      return `${what}${typeof p.due_on === "string" && p.due_on ? `, due ${calendarDate(p.due_on)}` : ""}`;
    }
    case "fact": {
      const value = str(p.value);
      if (p.subject_kind === "me") return had ? `Replaces “${had.value}” in Settings, under About you` : "Saves it in Settings, under About you";
      const who = name(p.subject_id);
      const key = str(p.key).toLowerCase();
      if (had) return `Replaces ${who ? possessive(who) : "their"} ${key}, “${had.value}”`;
      return `Adds to ${who ? possessive(who) : "their"} details · ${str(p.key)}: ${value}`;
    }
    case "interaction": {
      const ids = Array.isArray(p.person_ids) ? p.person_ids : [];
      const people = ids.map(name).filter(Boolean).join(", ");
      const channel = CHANNEL_META[(p.channel as InteractionChannel) ?? "other"]?.label ?? "Catch-up";
      return `Logs a catch-up${people ? ` with ${people}` : ""} · ${channel.toLowerCase()}`;
    }
    case "event": {
      if (had) return `Updates “${had.name ?? str(p.title)}” in Events`;
      const at = when(p);
      return `Adds it to Events${at ? ` · ${at}` : ""}`;
    }
    case "person":
      return had ? `Updates ${had.name ?? str(p.name)} in People` : `Adds ${str(p.name) || "them"} to People`;
    case "link": {
      const a = name(p.sourceId ?? p.source_id) ?? `a ${str(p.sourceType ?? p.source_type) || "record"}`;
      const b = name(p.targetId ?? p.target_id) ?? `a ${str(p.targetType ?? p.target_type) || "record"}`;
      return `Links ${a} with ${b}`;
    }
    case "booking": {
      const start = str(p.start_local);
      const date = /^\d{4}-\d{2}-\d{2}/.test(start) ? day(start.slice(0, 10)) : "";
      const time = /T(\d{2}:\d{2})/.exec(start)?.[1] ?? "";
      const at = date ? ` · ${date}${time ? ` at ${clockOfDay(time)}` : ""}` : "";
      if (had) {
        const label = BOOKING_LABEL[p.kind as BookingKind]?.label.toLowerCase() ?? "booking";
        return p.status === "cancelled" ? `Marks your ${label} booking cancelled in Trips` : `Updates your ${label} booking in Trips${at}`;
      }
      const from = str(p.start_city) ? ` from ${str(p.start_city)}` : "";
      return `Adds it to Trips${at}${from}`;
    }
    case "purchase": {
      const now = statusWord(p.status);
      if (had) {
        const was = statusWord(had.status);
        if (!now || was === now) return `Adds this email to your order in Purchases${was ? `, already marked ${was}` : ""}`;
        return `Moves your order in Purchases from ${was || "where it was"} to ${now}`;
      }
      return `Adds the order to Purchases${now ? `, marked ${now}` : ""}`;
    }
  }
}

/** The accept button: what it does, in two or three words. */
export function acceptLabel(s: Pick<Suggestion, "op" | "payload" | "existing">): string {
  const had = !!s.existing;
  switch (s.op) {
    case "commitment":
      return had ? "Update to-do" : "Add to To do";
    case "fact":
      return had ? "Replace" : "Remember";
    case "interaction":
      return "Log catch-up";
    case "event":
      return had ? "Update event" : "Add to Events";
    case "person":
      return had ? "Update person" : "Add to People";
    case "link":
      return "Link them";
    case "booking":
      return had ? "Update booking" : "Add to Trips";
    case "purchase":
      if (!had) return "Add to Purchases";
      return statusWord(s.payload?.status) && statusWord(s.payload?.status) !== statusWord(s.existing?.status) ? "Update status" : "Update order";
  }
}

/** The toast once it's accepted. */
export function acceptedToast(s: Pick<Suggestion, "op" | "existing">): string {
  const had = !!s.existing;
  switch (s.op) {
    case "commitment":
      return had ? "To-do updated" : "Added to To do";
    case "fact":
      return had ? "Replaced" : "Remembered";
    case "interaction":
      return "Catch-up logged";
    case "event":
      return had ? "Event updated" : "Added to Events";
    case "person":
      return had ? "Person updated" : "Added to People";
    case "link":
      return "Linked";
    case "booking":
      return had ? "Booking updated" : "Added to Trips";
    case "purchase":
      return had ? "Order updated" : "Added to Purchases";
  }
}
