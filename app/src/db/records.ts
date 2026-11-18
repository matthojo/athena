/**
 * People, places, organisations and events — the Library's data, on the same
 * degrade chain as notes: live API -> device cache -> bundled sample data.
 *
 * Unlike notes, edits to these records need a connection (they're small,
 * rarely edited on the go, and several are linked server-side: a birthday
 * field writes an event, an organisation writes an edge). Offline, profiles
 * are readable from the cache and saving says so plainly. Sample mode keeps
 * its edits on this device, layered over the sample data.
 */

import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import { getAll, getMeta, setMeta } from "./idb";
import { sampleEvents, sampleOrganisations, samplePeople, samplePlaces } from "./sample-data";
import { refreshNotes } from "./data";
import { DEFAULT_CATCH_UP } from "../lib/format";
import { upcomingOccurrences } from "../../../lib/dates";
import { deviceZone, localToday } from "../lib/time";
import type {
  AnyRecord,
  ArchivedItem,
  AthenaEvent,
  ConnectionState,
  EntityKind,
  Note,
  Person,
  RecordByKind,
  RecordKind,
  Rsvp,
  RsvpResult,
  Upcoming,
} from "../types";

export class OfflineError extends Error {
  constructor() {
    super("You're offline. Changes to people, places and events need a connection.");
  }
}

// ---------- change notifications ----------

const subs = new Set<(kind: RecordKind | "all") => void>();

export function onRecordsChange(fn: (kind: RecordKind | "all") => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(kind: RecordKind | "all") {
  subs.forEach((fn) => fn(kind));
}

/** Something outside this module (Ask's assistant) changed records: everyone reload. */
export const recordsChanged = () => emit("all");

// ---------- sample-mode overlay ----------

type Overlay = Record<string, AnyRecord & { archived_at?: string | null }>;

async function overlay(): Promise<Overlay> {
  return JSON.parse((await getMeta("sampleRecords")) ?? "{}") as Overlay;
}

async function setOverlay(o: Overlay): Promise<void> {
  await setMeta("sampleRecords", JSON.stringify(o));
}

async function sampleDeleted(): Promise<Set<string>> {
  return new Set(JSON.parse((await getMeta("sampleRecordsDeleted")) ?? "[]") as string[]);
}

function sampleBase(kind: RecordKind): AnyRecord[] {
  switch (kind) {
    case "person":
      return samplePeople();
    case "place":
      return samplePlaces();
    case "organisation":
      return sampleOrganisations();
    case "event":
      return sampleEvents();
  }
}

/** Sample records with this device's sample-mode edits applied (archived included). */
async function sampleAll<K extends RecordKind>(kind: K): Promise<RecordByKind[K][]> {
  const [o, deleted] = await Promise.all([overlay(), sampleDeleted()]);
  const byId = new Map(sampleBase(kind).map((r) => [r.id, r]));
  for (const [key, rec] of Object.entries(o)) if (key.startsWith(`${kind}:`)) byId.set(rec.id, rec);
  return [...byId.values()].filter((r) => !deleted.has(`${kind}:${r.id}`)) as RecordByKind[K][];
}

/** Sample mode's stand-in for the server's birthday -> event shortcut. */
async function syncSampleBirthday(o: Overlay, person: Person): Promise<void> {
  const events = await sampleAll("event");
  const existing = events.find((e) => e.person_id === person.id && e.kind === "birthday");
  const nowIso = new Date().toISOString();
  if (!person.birthday) {
    if (existing) o[`event:${existing.id}`] = { ...existing, archived_at: nowIso };
    person.birthday_event_id = null;
    return;
  }
  const yearKnown = !person.birthday.startsWith("--");
  const date = yearKnown ? person.birthday : `2000-${person.birthday.slice(2)}`;
  const ev: AthenaEvent = {
    ...(existing ?? { id: crypto.randomUUID(), created_at: nowIso, notes: "", remind_days_before: [0], time: null }),
    title: `${person.name}'s birthday`,
    kind: "birthday",
    date,
    year_known: yearKnown,
    recurrence: "yearly",
    person_id: person.id,
    archived_at: null,
    updated_at: nowIso,
  };
  o[`event:${ev.id}`] = ev;
  person.birthday_event_id = ev.id;
}

// ---------- reads ----------

const live = <T extends { archived_at?: string | null }>(items: T[]) => items.filter((r) => !r.archived_at);

function sortRecords<K extends RecordKind>(kind: K, items: RecordByKind[K][]): RecordByKind[K][] {
  if (kind === "event") return [...items].sort((a, b) => (a as AthenaEvent).date.localeCompare((b as AthenaEvent).date));
  return [...items].sort((a, b) => ("name" in a ? a.name : "").localeCompare("name" in b ? b.name : "", "en-GB", { sensitivity: "base" }));
}

export async function loadRecords<K extends RecordKind>(kind: K): Promise<{ items: RecordByKind[K][]; state: ConnectionState }> {
  if (isSampleMode()) return { items: sortRecords(kind, live(await sampleAll(kind))), state: "sample" };
  try {
    const items = (await api.listRecords(kind)) as RecordByKind[K][];
    await setMeta(`records:${kind}`, JSON.stringify(items));
    return { items, state: "online" };
  } catch {
    const cached = await getMeta(`records:${kind}`);
    if (cached) return { items: JSON.parse(cached) as RecordByKind[K][], state: "offline" };
    return { items: sortRecords(kind, live(await sampleAll(kind))), state: "sample" };
  }
}

export async function findRecord<K extends RecordKind>(kind: K, id: string): Promise<RecordByKind[K] | null> {
  if (isSampleMode()) return ((await sampleAll(kind)).find((r) => r.id === id) as RecordByKind[K]) ?? null;
  try {
    return (await api.getRecord(kind, id)) as RecordByKind[K];
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    const cached = await getMeta(`records:${kind}`);
    return ((cached ? (JSON.parse(cached) as RecordByKind[K][]) : []).find((r) => r.id === id) as RecordByKind[K]) ?? null;
  }
}

// ---------- writes ----------

/** Create (no id) or update a record. Returns the saved record. */
export async function saveRecord<K extends RecordKind>(kind: K, input: Record<string, unknown>, id?: string): Promise<RecordByKind[K]> {
  if (isSampleMode()) {
    const o = await overlay();
    const existing = id ? ((await sampleAll(kind)).find((r) => r.id === id) as AnyRecord | undefined) : undefined;
    const nowIso = new Date().toISOString();
    const rec = { ...(existing ?? { id: crypto.randomUUID(), created_at: nowIso, archived_at: null }), ...input, updated_at: nowIso } as AnyRecord;
    if (kind === "person" && "organisation_id" in input) {
      const orgs = await sampleAll("organisation");
      const org = orgs.find((x) => x.id === input.organisation_id);
      (rec as Person).organisation = org ? { id: org.id, name: org.name } : null;
    }
    o[`${kind}:${rec.id}`] = rec;
    if (kind === "person" && "birthday" in input) await syncSampleBirthday(o, rec as Person);
    await setOverlay(o);
    emit(kind);
    if (kind === "person") emit("event");
    return rec as RecordByKind[K];
  }
  if (!navigator.onLine) throw new OfflineError();
  try {
    const saved = (await api.saveRecord(kind, input, id)) as RecordByKind[K];
    emit(kind);
    // A birthday edit changes an event too.
    if (kind === "person" && "birthday" in input) emit("event");
    return saved;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

export async function setArchived(kind: EntityKind, id: string, archived: boolean, snapshot?: { title: string }): Promise<void> {
  if (isSampleMode()) {
    if (kind === "note") return; // handled by db/sync.ts (setNoteArchivedLocal)
    const o = await overlay();
    const rec = o[`${kind}:${id}`] ?? (await sampleAll(kind as RecordKind)).find((r) => r.id === id);
    if (rec) o[`${kind}:${id}`] = { ...rec, archived_at: archived ? new Date().toISOString() : null, ...(snapshot ? {} : {}) };
    await setOverlay(o);
    emit(kind as RecordKind);
    return;
  }
  if (!navigator.onLine) throw new OfflineError();
  await api.setArchived(kind, id, archived);
  if (kind === "note") await refreshNotes();
  else emit(kind as RecordKind);
}

/** Going, Maybe or Declined on an event: kept in Athena, and sent to the calendar when its account allows it. */
export async function answerEvent(ev: AthenaEvent, answer: Rsvp, opts: { series?: boolean } = {}): Promise<RsvpResult> {
  if (isSampleMode()) {
    const event = await saveRecord("event", { rsvp: answer, rsvp_mine: true }, ev.id);
    return { event, outcome: "saved", message: "", before: ev.rsvp ?? "none" };
  }
  if (!navigator.onLine) throw new OfflineError();
  try {
    const result = await api.answerEvent(ev.id, answer, opts);
    emit("event");
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

/** Permanent delete (manual, confirmed, app-only). */
export async function deleteForever(kind: EntityKind, id: string): Promise<void> {
  if (isSampleMode()) {
    if (kind === "note") return;
    const deleted = await sampleDeleted();
    deleted.add(`${kind}:${id}`);
    await setMeta("sampleRecordsDeleted", JSON.stringify([...deleted]));
    emit(kind as RecordKind);
    return;
  }
  if (!navigator.onLine) throw new OfflineError();
  await api.deleteEntity(kind, id);
  if (kind === "note") await refreshNotes();
  else emit("all");
}

// ---------- PA views ----------

/** Coming up: next `days` days of birthdays/events plus overdue catch-ups. */
export async function loadUpcoming(days = 6): Promise<{ upcoming: Upcoming; state: ConnectionState }> {
  const compute = async (state: ConnectionState) => {
    const [{ items: events }, { items: people }] = await Promise.all([loadRecords("event"), loadRecords("person")]);
    const today = localToday();
    const livePeople = new Set(people.map((p) => p.id));
    // Invites you declined stay under Events, off Home.
    const evs = events.filter((e) => (!e.person_id || livePeople.has(e.person_id)) && e.rsvp !== "declined");
    const catchUps = people.filter((p) => {
      if (!p.keep_in_touch) return false;
      if (!p.last_contacted_at) return true;
      const cadence = p.catch_up_days ?? DEFAULT_CATCH_UP;
      return Date.now() - Date.parse(p.last_contacted_at) > cadence * 86_400_000;
    });
    return { upcoming: { today, tz: deviceZone(), events: upcomingOccurrences(evs, today, days, deviceZone()), catch_ups: catchUps }, state };
  };
  if (isSampleMode()) return compute("sample");
  try {
    return { upcoming: await api.fetchUpcoming(days, deviceZone()), state: "online" };
  } catch {
    return compute("offline");
  }
}

/** Everything archived, newest first (the Archived page only). */
export async function loadArchived(): Promise<{ items: ArchivedItem[]; state: ConnectionState }> {
  if (isSampleMode()) {
    const items: ArchivedItem[] = [];
    for (const kind of ["person", "place", "organisation", "event"] as RecordKind[]) {
      for (const r of await sampleAll(kind)) {
        if (r.archived_at) items.push({ kind, id: r.id, title: "name" in r ? r.name : r.title, archived_at: r.archived_at });
      }
    }
    for (const n of await getAll<Note>("notes")) {
      if (n.archived_at) items.push({ kind: "note", id: n.id, title: n.title || "Untitled", archived_at: n.archived_at });
    }
    return { items: items.sort((a, b) => b.archived_at.localeCompare(a.archived_at)), state: "sample" };
  }
  try {
    return { items: await api.fetchArchived(), state: "online" };
  } catch {
    return { items: [], state: "offline" };
  }
}
