/**
 * Layer 2 on the device: open loops, interactions, facts, the review inbox,
 * life admin, reading and goals — on the same degrade chain as db/records.ts
 * (live API -> device cache -> bundled sample data). Like records, writes need
 * a connection; sample mode keeps its edits on this device, layered over the
 * sample data, and imitates the server's rules (done_at, fact supersession,
 * catch-ups clearing when you log an interaction).
 */

import * as api from "./api";
import { ApiError, isSampleMode } from "./api";
import { getMeta, setMeta } from "./idb";
import { findRecord, loadRecords, OfflineError, saveRecord } from "./records";
import { notesSnapshot } from "./data";
import {
  sampleAssets,
  sampleCommitments,
  sampleFacts,
  sampleGoals,
  sampleIdentities,
  sampleInteractions,
  sampleReading,
  sampleSuggestions,
} from "./sample-memory";
import { DEFAULT_CATCH_UP } from "../lib/format";
import { learnedAboutOwner } from "../lib/owner-rule";
import { markdownToText } from "../lib/markdown-text";
import { addDays, daysBetween, upcomingOccurrences } from "../../../lib/dates";
import { cleanLinks, cleanPriority, cleanSteps } from "../../../lib/todo-details";
import { caughtBy, sameKey } from "../../../lib/suggestion-similar";

/** A mail rule from the Inbox: skip a sender (an address or a domain) or a subject phrase. */
export type IgnoreRule = { kind: "sender" | "subject"; value: string };
import { deviceZone, localToday } from "../lib/time";
import type {
  Asset,
  Commitment,
  CommitmentStatus,
  ConnectionState,
  Fact,
  Goal,
  Identity,
  IdentityKind,
  Interaction,
  MemoryKind,
  MetricPoint,
  Person,
  PersonBrief,
  PersonRef,
  ReadingItem,
  RecallHit,
  Renewal,
  Suggestion,
  WeeklyReview,
} from "../types";

// ---------- change notifications ----------

type Topic = MemoryKind | "suggestion" | "all";
const subs = new Set<(topic: Topic) => void>();

export function onMemoryChange(fn: (topic: Topic) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(topic: Topic) {
  subs.forEach((fn) => fn(topic));
}

/** Something outside this module (Ask's assistant) changed what's in motion: everyone reload. */
export const memoryChanged = () => emit("all");

// ---------- sample-mode overlay ----------

interface ByKind {
  commitment: Commitment;
  interaction: Interaction;
  fact: Fact;
  asset: Asset;
  reading: ReadingItem;
  goal: Goal;
}

type Row = { id: string; archived_at?: string | null };
type Overlay = Record<string, Row>;

const SAMPLE_BASE: Record<MemoryKind | "suggestion" | "identity", () => Row[]> = {
  commitment: sampleCommitments,
  interaction: sampleInteractions,
  fact: sampleFacts,
  asset: sampleAssets,
  reading: sampleReading,
  goal: sampleGoals,
  suggestion: sampleSuggestions,
  identity: sampleIdentities,
};

async function overlay(): Promise<Overlay> {
  return JSON.parse((await getMeta("sampleMemory")) ?? "{}") as Overlay;
}

async function deletedSet(): Promise<Set<string>> {
  return new Set(JSON.parse((await getMeta("sampleMemoryDeleted")) ?? "[]") as string[]);
}

async function sampleAll<T extends Row>(kind: keyof typeof SAMPLE_BASE): Promise<T[]> {
  const [o, deleted] = await Promise.all([overlay(), deletedSet()]);
  const byId = new Map(SAMPLE_BASE[kind]().map((r) => [r.id, r]));
  for (const [key, row] of Object.entries(o)) if (key.startsWith(`${kind}:`)) byId.set(row.id, row);
  return [...byId.values()].filter((r) => !deleted.has(`${kind}:${r.id}`)) as T[];
}

async function sampleWrite(kind: keyof typeof SAMPLE_BASE, row: Row): Promise<void> {
  const o = await overlay();
  o[`${kind}:${row.id}`] = row;
  await setMeta("sampleMemory", JSON.stringify(o));
}

const live = <T extends Row>(rows: T[]) => rows.filter((r) => !r.archived_at);
const nowIso = () => new Date().toISOString();

/** Run an API write, turning network failures (not API errors) into OfflineError. */
async function online<T>(run: () => Promise<T>): Promise<T> {
  if (!navigator.onLine) throw new OfflineError();
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new OfflineError();
  }
}

// ---------- lists ----------

const LIST_PARAMS: Partial<Record<MemoryKind, Record<string, string>>> = {
  commitment: { status: "all" },
  // A Goodreads library can be hundreds of books: the API's most, not its default 200.
  reading: { limit: "1000" },
};

/** One layer-2 list: live from the API (and cached), the cache offline, sample data last. */
async function loadList<K extends MemoryKind>(kind: K): Promise<{ items: ByKind[K][]; state: ConnectionState }> {
  if (isSampleMode()) return { items: live(await sampleAll<ByKind[K]>(kind)), state: "sample" };
  try {
    const items = await api.listMemory<ByKind[K]>(kind, LIST_PARAMS[kind]);
    await setMeta(`memory:${kind}`, JSON.stringify(items));
    return { items, state: "online" };
  } catch {
    const cached = await getMeta(`memory:${kind}`);
    if (cached) return { items: JSON.parse(cached) as ByKind[K][], state: "offline" };
    return { items: live(await sampleAll<ByKind[K]>(kind)), state: "sample" };
  }
}

export const loadCommitments = () => loadList("commitment");
export const loadInteractions = () => loadList("interaction");
export const loadAssets = () => loadList("asset");
export const loadReading = () => loadList("reading");
export const loadGoals = () => loadList("goal");

// ---------- commitments ----------

async function personRef(id: string | null | undefined): Promise<PersonRef | null> {
  if (!id) return null;
  const p = await findRecord("person", id);
  return p && !p.archived_at ? { id: p.id, name: p.name } : null;
}

/** Create (no id) or update a commitment. */
export async function saveCommitment(input: Partial<Commitment>, id?: string): Promise<Commitment> {
  if (isSampleMode()) {
    const existing = id ? (await sampleAll<Commitment>("commitment")).find((c) => c.id === id) : undefined;
    const base: Commitment = existing ?? {
      id: crypto.randomUUID(),
      title: "",
      kind: "todo",
      status: input.kind === "decision" ? "done" : "open",
      due_on: null,
      notes: "",
      person_id: null,
      person: null,
      source: "manual",
      source_ref: null,
      source_quote: null,
      confidence: null,
      done_at: input.kind === "decision" ? nowIso() : null,
      steps: [],
      links: [],
      priority: 0,
      archived_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const next: Commitment = { ...base, ...input, updated_at: nowIso() };
    // The server's rules for the details (lib/todo-details.ts), so sample mode keeps what a real copy would.
    if (input.steps !== undefined) next.steps = cleanSteps(input.steps);
    if (input.links !== undefined) next.links = cleanLinks(input.links);
    if (input.priority !== undefined) next.priority = cleanPriority(input.priority) ?? 0;
    if (input.status && input.status !== base.status) next.done_at = input.status === "done" ? nowIso() : null;
    if ("person_id" in input) next.person = await personRef(input.person_id);
    // Like the server: the owner picking a context makes it theirs.
    if ("area_id" in input || "where_id" in input) next.context_by_athena = false;
    await sampleWrite("commitment", next);
    emit("commitment");
    return next;
  }
  const saved = await online(() => api.saveMemory<Commitment>("commitment", input as Record<string, unknown>, id));
  emit("commitment");
  return saved;
}

export const setCommitmentStatus = (c: Commitment, status: CommitmentStatus) => saveCommitment({ status }, c.id);

export interface LoopGroups {
  overdue: Commitment[];
  today: Commitment[];
  week: Commitment[];
  later: Commitment[];
  someday: Commitment[];
}

/** Open loops by when they're due, as of today on this device. */
export function groupLoops(loops: Commitment[], today = localToday()): LoopGroups {
  const weekEnd = addDays(today, 7);
  const g: LoopGroups = { overdue: [], today: [], week: [], later: [], someday: [] };
  for (const c of loops) {
    if (!c.due_on) g.someday.push(c);
    else if (c.due_on < today) g.overdue.push(c);
    else if (c.due_on === today) g.today.push(c);
    else if (c.due_on <= weekEnd) g.week.push(c);
    else g.later.push(c);
  }
  return g;
}

export const isLoop = (c: Commitment) => c.kind !== "decision";

/**
 * To-dos ticked off per week, oldest first, for Home's chart. Weeks are
 * rolling 7-day windows ending now, so "vs last week" compares two whole
 * weeks rather than a half-finished one. Counts what the weekly review
 * counts as done. Empty when nothing has ever been ticked off.
 */
export function doneByWeek(items: Commitment[], weeks = 10, now = new Date()): MetricPoint[] {
  const done = items.filter((c) => c.status === "done" && isLoop(c) && c.done_at).map((c) => Date.parse(c.done_at!));
  if (!done.length) return [];
  const week = 7 * 86_400_000;
  return Array.from({ length: weeks }, (_, i) => {
    const to = now.getTime() - (weeks - 1 - i) * week;
    return { recorded_at: new Date(to).toISOString(), value: done.filter((t) => t > to - week && t <= to).length };
  });
}

/** Open loops, soonest due first; on the same day (or undated) the higher priority first, then newest first. */
export function openLoops(items: Commitment[]): Commitment[] {
  return items
    .filter((c) => c.status === "open" && isLoop(c) && !c.archived_at)
    .sort(
      (a, b) =>
        (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || (b.priority ?? 0) - (a.priority ?? 0) || b.created_at.localeCompare(a.created_at),
    );
}

// ---------- life admin, reading, goals ----------

/** Life-admin items renewing within `days`, or lapsed in the last 30. */
export function renewals(assets: Asset[], days = 60, today = localToday()): Renewal[] {
  return assets
    .filter((a) => a.renews_on && !a.archived_at)
    .map((asset) => ({ asset, days_until: daysBetween(today, asset.renews_on!) }))
    .filter((r) => r.days_until <= days && r.days_until >= -30)
    .sort((a, b) => a.days_until - b.days_until);
}

export async function saveAsset(input: Partial<Asset>, id?: string): Promise<Asset> {
  return saveSimple("asset", input, id, () => ({
    id: crypto.randomUUID(),
    name: "",
    kind: "other",
    provider: "",
    renews_on: null,
    remind_days_before: [30, 7, 0],
    notes: "",
    archived_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }));
}

/** `tags` is your tags, the whole list: the server keeps them inside the item's meta. */
export async function saveReading(input: Partial<ReadingItem> & { tags?: string[] }, id?: string): Promise<ReadingItem> {
  return saveSimple(
    "reading",
    input,
    id,
    () => ({
      id: crypto.randomUUID(),
      title: "",
      url: "",
      kind: "article",
      author: "",
      status: "queued",
      notes: "",
      recommended_by: null,
      recommender: null,
      finished_at: null,
      source: "manual",
      archived_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }),
    async (prev, next) => {
      // Sample mode has no server to fold the tags into the meta.
      const tagged = next as ReadingItem & { tags?: string[] };
      if (tagged.tags) {
        const { tags: _old, ...rest } = prev.meta ?? {};
        next.meta = tagged.tags.length ? { ...rest, tags: tagged.tags } : rest;
        delete tagged.tags;
      }
      if (next.status !== prev.status) next.finished_at = next.status === "done" ? nowIso() : null;
      if (next.recommended_by !== prev.recommended_by) next.recommender = await personRef(next.recommended_by);
    }
  );
}

export async function saveGoal(input: Partial<Goal>, id?: string): Promise<Goal> {
  return saveSimple("goal", input, id, () => ({
    id: crypto.randomUUID(),
    title: "",
    period: "quarter",
    target: "",
    progress: 0,
    status: "active",
    due_on: null,
    notes: "",
    archived_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }));
}

async function saveSimple<K extends "asset" | "reading" | "goal">(
  kind: K,
  input: Partial<ByKind[K]>,
  id: string | undefined,
  blank: () => ByKind[K],
  derive?: (prev: ByKind[K], next: ByKind[K]) => Promise<void>
): Promise<ByKind[K]> {
  if (isSampleMode()) {
    const prev = (id ? (await sampleAll<ByKind[K]>(kind)).find((r) => r.id === id) : undefined) ?? blank();
    const next = { ...prev, ...input, updated_at: nowIso() } as ByKind[K];
    await derive?.(prev, next);
    await sampleWrite(kind, next);
    emit(kind);
    return next;
  }
  const saved = await online(() => api.saveMemory<ByKind[K]>(kind, input as Record<string, unknown>, id));
  emit(kind);
  return saved;
}

// ---------- archive / delete (menus and the Archived page) ----------

export async function setMemoryArchived(kind: MemoryKind, id: string, archived: boolean): Promise<void> {
  if (isSampleMode()) {
    const row = (await sampleAll<Row>(kind)).find((r) => r.id === id);
    if (row) await sampleWrite(kind, { ...row, archived_at: archived ? nowIso() : null });
    emit(kind);
    return;
  }
  await online(() => api.setArchived(kind, id, archived));
  emit(kind);
}

export async function deleteMemoryForever(kind: MemoryKind, id: string): Promise<void> {
  if (isSampleMode()) {
    const deleted = await deletedSet();
    deleted.add(`${kind}:${id}`);
    await setMeta("sampleMemoryDeleted", JSON.stringify([...deleted]));
    emit(kind);
    return;
  }
  await online(() => api.deleteEntity(kind, id));
  emit(kind);
}

const MEMORY_TITLE: { [K in MemoryKind]: (r: ByKind[K]) => string } = {
  commitment: (r) => r.title,
  interaction: (r) => r.summary || "Catch-up",
  fact: (r) => `${r.key}: ${r.value}`,
  asset: (r) => r.name,
  reading: (r) => r.title,
  goal: (r) => r.title,
};

/** Archived layer-2 items in sample mode (the server's Archived list already includes them). */
export async function sampleArchivedMemory(): Promise<Array<{ kind: MemoryKind; id: string; title: string; archived_at: string }>> {
  const out: Array<{ kind: MemoryKind; id: string; title: string; archived_at: string }> = [];
  for (const kind of Object.keys(MEMORY_TITLE) as MemoryKind[]) {
    for (const r of await sampleAll<ByKind[typeof kind]>(kind)) {
      if (r.archived_at) out.push({ kind, id: r.id, title: (MEMORY_TITLE[kind] as (r: Row) => string)(r), archived_at: r.archived_at });
    }
  }
  return out;
}

// ---------- interactions, facts, identities ----------

export interface InteractionInput {
  person_ids: string[];
  channel: Interaction["channel"];
  summary: string;
  at?: string;
}

/** Log that you spoke; each person's last-contacted date moves forward (never back). */
export async function logInteraction(input: InteractionInput, id?: string): Promise<Interaction> {
  if (isSampleMode()) {
    const at = input.at ?? nowIso();
    const people = (await Promise.all(input.person_ids.map((p) => personRef(p)))).filter((p): p is PersonRef => !!p);
    const existing = id ? (await sampleAll<Interaction>("interaction")).find((i) => i.id === id) : undefined;
    const row: Interaction = {
      id: existing?.id ?? crypto.randomUUID(),
      source: existing?.source ?? "manual",
      source_ref: existing?.source_ref ?? null,
      archived_at: null,
      created_at: existing?.created_at ?? nowIso(),
      at,
      channel: input.channel,
      summary: input.summary,
      people,
      updated_at: nowIso(),
    };
    await sampleWrite("interaction", row);
    for (const p of people) {
      const person = await findRecord("person", p.id);
      if (person && (!person.last_contacted_at || person.last_contacted_at < at)) await saveRecord("person", { last_contacted_at: at }, p.id);
    }
    emit("interaction");
    return row;
  }
  const saved = await online(() => api.saveMemory<Interaction>("interaction", { ...input }, id));
  emit("interaction");
  return saved;
}

type FactInput = { subject_kind: Fact["subject_kind"]; subject_id: string | null; key: string; value: string };
type Provenance = Pick<Fact, "source" | "source_ref" | "source_quote" | "confidence">;

/**
 * Remember a fact; the same key again supersedes the old value (kept as history).
 * With provenance (accepting a suggestion passes it, with `byOwner`), the fact keeps
 * its source and confidence. Sample mode files a learned owner fact as a suggestion.
 */
export async function addFact(input: FactInput): Promise<Fact>;
export async function addFact(input: FactInput & Partial<Provenance>, writer: { byOwner: true }): Promise<Fact>;
export async function addFact(input: FactInput & Partial<Provenance>, writer?: { byOwner?: boolean }): Promise<Fact | Suggestion>;
export async function addFact(input: FactInput & Partial<Provenance>, writer: { byOwner?: boolean } = {}): Promise<Fact | Suggestion> {
  if (isSampleMode()) {
    const key = input.key.trim();
    const all = await sampleAll<Fact>("fact");
    const current = all.find(
      (f) => f.subject_kind === input.subject_kind && f.subject_id === input.subject_id && !f.superseded_at && !f.archived_at && f.key.toLowerCase() === key.toLowerCase()
    );
    if (current && current.value.trim().toLowerCase() === input.value.trim().toLowerCase()) return current;
    if (learnedAboutOwner(input, writer)) {
      const suggestion: Suggestion = {
        id: crypto.randomUUID(),
        op: "fact",
        summary: `About you · ${current?.key ?? key}: ${input.value.trim()}`,
        payload: { subject_kind: "me", key: current?.key ?? key, value: input.value.trim() },
        status: "pending",
        result_id: null,
        resolved_at: null,
        created_at: nowIso(),
        source: input.source ?? null,
        source_ref: input.source_ref ?? null,
        source_quote: input.source_quote ?? null,
        confidence: input.confidence ?? null,
      };
      await sampleWrite("suggestion", suggestion);
      emit("suggestion");
      return suggestion;
    }
    const fact: Fact = {
      id: crypto.randomUUID(),
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      key: current?.key ?? key,
      value: input.value.trim(),
      source: input.source ?? "manual",
      source_ref: input.source_ref ?? null,
      source_quote: input.source_quote ?? null,
      confidence: input.confidence ?? null,
      observed_at: nowIso(),
      superseded_at: null,
      archived_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (current) await sampleWrite("fact", { ...current, superseded_at: nowIso() } as Fact);
    await sampleWrite("fact", fact);
    emit("fact");
    return fact;
  }
  const saved = await online(() => api.saveMemory<Fact>("fact", input));
  emit("fact");
  return saved;
}

/** Sample mode: every fact about the owner, current and superseded (not forgotten ones). */
export async function sampleOwnerFacts(): Promise<Fact[]> {
  return live(await sampleAll<Fact>("fact")).filter((f) => f.subject_kind === "me");
}

/** Sample mode: forget the owner's current value for a key (archived, as on the server). */
export async function sampleForgetOwner(key: string): Promise<void> {
  const k = key.trim().toLowerCase();
  for (const f of await sampleOwnerFacts()) {
    if (!f.superseded_at && f.key.trim().toLowerCase() === k) await sampleWrite("fact", { ...f, archived_at: nowIso() } as Fact);
  }
  emit("fact");
}

export async function updateFact(id: string, patch: { key?: string; value?: string }): Promise<Fact> {
  if (isSampleMode()) {
    const fact = (await sampleAll<Fact>("fact")).find((f) => f.id === id);
    if (!fact) throw new Error("That fact has gone");
    const next = { ...fact, ...patch, updated_at: nowIso() };
    await sampleWrite("fact", next);
    emit("fact");
    return next;
  }
  const saved = await online(() => api.saveMemory<Fact>("fact", patch, id));
  emit("fact");
  return saved;
}

export async function addIdentity(input: { person_id: string; kind: IdentityKind; value: string }): Promise<Identity> {
  if (isSampleMode()) {
    const row: Identity = { id: crypto.randomUUID(), ...input, value: input.value.trim().toLowerCase(), created_at: nowIso() };
    await sampleWrite("identity", row);
    emit("fact");
    return row;
  }
  const saved = await online(() => api.addIdentity(input));
  emit("fact");
  return saved;
}

export async function removeIdentity(id: string): Promise<void> {
  if (isSampleMode()) {
    const deleted = await deletedSet();
    deleted.add(`identity:${id}`);
    await setMeta("sampleMemoryDeleted", JSON.stringify([...deleted]));
    emit("fact");
    return;
  }
  await online(() => api.removeIdentity(id));
  emit("fact");
}

/** Fold a duplicate into the person you keep (the duplicate is archived). Needs the server. */
export async function mergePeople(keepId: string, duplicateId: string): Promise<Person> {
  if (isSampleMode()) throw new Error("Merging needs your own Athena, not sample data");
  const merged = await online(() => api.mergePeople(keepId, duplicateId));
  emit("all");
  return merged;
}

// ---------- person brief ----------

async function sampleBrief(id: string): Promise<PersonBrief | null> {
  const person = await findRecord("person", id);
  if (!person) return null;
  const [commitments, interactions, facts, identities, reading] = await Promise.all([
    sampleAll<Commitment>("commitment"),
    sampleAll<Interaction>("interaction"),
    sampleAll<Fact>("fact"),
    sampleAll<Identity>("identity"),
    sampleAll<ReadingItem>("reading"),
  ]);
  const theirs = live(commitments).filter((c) => c.person_id === id);
  return {
    person,
    facts: live(facts)
      .filter((f) => f.subject_kind === "person" && f.subject_id === id && !f.superseded_at)
      .sort((a, b) => a.key.localeCompare(b.key)),
    identities: identities.filter((i) => i.person_id === id),
    interactions: live(interactions)
      .filter((i) => i.people.some((p) => p.id === id))
      .sort((a, b) => b.at.localeCompare(a.at)),
    open_loops: openLoops(theirs),
    decisions: theirs.filter((c) => c.kind === "decision").sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5),
    reading: live(reading).filter((r) => r.recommended_by === id && r.status !== "done"),
  };
}

/**
 * Current facts this device knows without the server, for the graph's
 * device-side build: sample mode's (with its edits), else whatever the
 * people's briefs cached when their profiles were last opened.
 */
export async function deviceFacts(personIds: string[]): Promise<Fact[]> {
  if (isSampleMode()) return live(await sampleAll<Fact>("fact")).filter((f) => !f.superseded_at);
  const cached = await Promise.all(personIds.map((id) => getMeta(`brief:${id}`).catch(() => undefined)));
  return cached.flatMap((c) => (c ? (JSON.parse(c) as PersonBrief).facts : []));
}

/** Everything known about a person: facts, timeline, open loops both ways. */
export async function loadBrief(id: string): Promise<{ brief: PersonBrief | null; state: ConnectionState }> {
  if (isSampleMode()) return { brief: await sampleBrief(id), state: "sample" };
  try {
    const brief = await api.fetchPersonBrief(id);
    await setMeta(`brief:${id}`, JSON.stringify(brief));
    return { brief, state: "online" };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { brief: null, state: "online" };
    const cached = await getMeta(`brief:${id}`);
    return { brief: cached ? (JSON.parse(cached) as PersonBrief) : null, state: "offline" };
  }
}

// ---------- the review inbox ----------

export async function loadSuggestions(): Promise<{ items: Suggestion[]; state: ConnectionState }> {
  if (isSampleMode()) {
    const items = (await sampleAll<Suggestion>("suggestion"))
      .filter((s) => s.status === "pending")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items, state: "sample" };
  }
  try {
    const items = await api.fetchSuggestions();
    await setMeta("memory:suggestion", JSON.stringify(items));
    return { items, state: "online" };
  } catch {
    const cached = await getMeta("memory:suggestion");
    return { items: cached ? (JSON.parse(cached) as Suggestion[]) : [], state: "offline" };
  }
}

/**
 * Accept (applying it, with any edits) or reject a suggestion, or mark it
 * done: dealt with another way (Add to calendar), so it leaves with nothing applied.
 */
export async function resolveSuggestion(s: Suggestion, action: "accept" | "reject" | "done", edits: Record<string, unknown> = {}): Promise<void> {
  if (isSampleMode()) {
    if (action === "accept") {
      const p = { ...s.payload, ...edits };
      const provenance = { source: s.source, source_ref: s.source_ref, source_quote: s.source_quote, confidence: s.confidence };
      if (s.op === "commitment") await saveCommitment({ ...(p as Partial<Commitment>), ...provenance });
      // Accepting is the owner's say: the fact saves, keeping where it was learned.
      else if (s.op === "fact") await addFact({ ...(p as FactInput), subject_id: (p.subject_id as string | undefined) ?? null, ...provenance }, { byOwner: true });
      else if (s.op === "interaction") await logInteraction(p as unknown as InteractionInput);
      else if (s.op === "event") await saveRecord("event", p);
      else if (s.op === "person") await saveRecord("person", p, typeof p.id === "string" ? p.id : undefined);
    }
    await sampleWrite("suggestion", { ...s, status: action === "reject" ? "rejected" : "accepted", resolved_at: nowIso() } as Suggestion);
    emit("suggestion");
    return;
  }
  await online(() => api.resolveSuggestion(s.id, action, action === "accept" && Object.keys(edits).length ? edits : undefined));
  emit("suggestion");
  if (action === "accept") emit("all");
}

export interface IgnoreOutcome {
  rule: IgnoreRule;
  /** The accounts the rule went on, by name. */
  accounts: string[];
  /** The ids that left the Inbox with it. */
  dismissed: string[];
}

/**
 * Ignore emails like this one: a mail rule on the account it came from, so
 * the next sync skips mail like it, and the finds it catches (and this one
 * again, from other emails) leave the Inbox. Sample mode changes no account.
 */
export async function ignoreLikeSuggestion(s: Suggestion, rule: IgnoreRule): Promise<IgnoreOutcome> {
  if (isSampleMode()) {
    const pending = (await sampleAll<Suggestion>("suggestion")).filter((p) => p.status === "pending");
    const key = sameKey(s);
    const leaving = pending.filter((p) => p.id === s.id || (p.source === s.source && caughtBy(p.email, rule)) || (!p.email && sameKey(p) === key));
    for (const p of leaving) await sampleWrite("suggestion", { ...p, status: "rejected", resolved_at: nowIso() } as Suggestion);
    emit("suggestion");
    return { rule, accounts: ["Sample email"], dismissed: leaving.map((p) => p.id) };
  }
  const out = await online(() => api.ignoreSuggestion(s.id, rule));
  emit("suggestion");
  return out;
}

// ---------- the weekly review ----------

/** The Monday of the week containing calendar date `date`. */
export function weekStartOf(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

async function computeWeek(start: string): Promise<WeeklyReview> {
  const end = addDays(start, 6);
  const next = addDays(start, 7);
  const [{ items: commitments }, { items: interactions }, { items: goals }, { items: reading }, { items: people }, { items: events }, { items: assets }] =
    await Promise.all([loadCommitments(), loadInteractions(), loadGoals(), loadReading(), loadRecords("person"), loadRecords("event"), loadAssets()]);
  const inWeek = (iso: string | null) => {
    if (!iso) return false;
    const day = localToday(new Date(iso));
    return day >= start && day <= end;
  };
  const weekInteractions = interactions.filter((i) => inWeek(i.at)).sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Map<string, PersonRef>();
  for (const i of weekInteractions) for (const p of i.people) seen.set(p.id, p);
  const loops = openLoops(commitments);
  const livePeople = new Set(people.map((p) => p.id));
  return {
    week_start: start,
    week_end: end,
    done: commitments.filter((c) => c.status === "done" && isLoop(c) && inWeek(c.done_at)).sort((a, b) => (b.done_at ?? "").localeCompare(a.done_at ?? "")),
    decisions: commitments.filter((c) => c.kind === "decision" && inWeek(c.created_at)),
    interactions: weekInteractions,
    people_seen: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    open_loops: loops,
    catch_ups: people
      .filter((p) => p.keep_in_touch && (!p.last_contacted_at || Date.now() - Date.parse(p.last_contacted_at) > (p.catch_up_days ?? DEFAULT_CATCH_UP) * 86_400_000))
      .sort((a, b) => (a.last_contacted_at ?? "").localeCompare(b.last_contacted_at ?? ""))
      .slice(0, 6),
    next_week: {
      events: upcomingOccurrences(
        events.filter((e) => (!e.person_id || livePeople.has(e.person_id)) && e.rsvp !== "declined"),
        next,
        7,
        deviceZone()
      ),
      due: loops.filter((c) => c.due_on !== null && c.due_on >= next && c.due_on <= addDays(next, 6)),
    },
    goals: goals.filter((g) => g.status === "active"),
    reading_done: reading.filter((r) => r.status === "done" && inWeek(r.finished_at)),
    renewals: renewals(assets, 13, next).filter((r) => r.days_until >= 0),
    notes_written: notesSnapshot().notes.filter((n) => inWeek(n.created_at)).length,
  };
}

export async function loadWeek(start = weekStartOf(localToday())): Promise<{ week: WeeklyReview; state: ConnectionState }> {
  if (isSampleMode()) return { week: await computeWeek(start), state: "sample" };
  try {
    return { week: await api.fetchWeeklyReview(start, deviceZone()), state: "online" };
  } catch {
    return { week: await computeWeek(start), state: "offline" };
  }
}

// ---------- recall ----------

/** Search across everything: the server's ranked recall, or a plain match on this device. */
export async function recall(q: string): Promise<{ hits: RecallHit[]; state: ConnectionState }> {
  if (!isSampleMode()) {
    try {
      return { hits: await api.recall(q), state: "online" };
    } catch {
      // fall through to what's on the device
    }
  }
  const state: ConnectionState = isSampleMode() ? "sample" : "offline";
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return { hits: [], state };
  const score = (text: string) => terms.reduce((n, t) => n + (text.toLowerCase().includes(t) ? 1 : 0), 0) / terms.length;
  const hits: RecallHit[] = [];
  const push = (hit: Omit<RecallHit, "rank">, text: string, weight = 1) => {
    const s = score(text);
    if (s > 0) hits.push({ ...hit, rank: s * weight });
  };
  for (const n of notesSnapshot().notes) {
    const body = markdownToText(n.body);
    push({ kind: "note", id: n.id, title: n.title, snippet: body.slice(0, 160), at: n.updated_at, person: null }, `${n.title} ${body}`);
  }
  const [{ items: commitments }, { items: interactions }, { items: reading }, { items: people }] = await Promise.all([
    loadCommitments(),
    loadInteractions(),
    loadReading(),
    loadRecords("person"),
  ]);
  for (const c of commitments) push({ kind: "commitment", id: c.id, title: c.title, snippet: c.notes, at: c.updated_at, person: c.person }, `${c.title} ${c.notes} ${(c.steps ?? []).map((st) => st.text).join(" ")}`, 1.2);
  for (const i of interactions) push({ kind: "interaction", id: i.id, title: i.summary.slice(0, 80), snippet: i.summary, at: i.at, person: i.people[0] ?? null }, i.summary);
  for (const r of reading) push({ kind: "reading", id: r.id, title: r.title, snippet: r.author, at: r.updated_at, person: null }, `${r.title} ${r.author} ${r.notes}`);
  for (const p of people) push({ kind: "person", id: p.id, title: p.name, snippet: p.relationship ?? "", at: p.updated_at, person: null }, `${p.name} ${p.relationship ?? ""}`, 1.5);
  if (isSampleMode()) {
    const names = new Map(people.map((p) => [p.id, p.name]));
    for (const f of live(await sampleAll<Fact>("fact")).filter((f) => !f.superseded_at)) {
      const person = f.subject_kind === "person" && f.subject_id ? { id: f.subject_id, name: names.get(f.subject_id) ?? "" } : null;
      push({ kind: "fact", id: f.id, title: `${f.key}: ${f.value}`, snippet: f.value, at: f.observed_at, person }, `${f.key} ${f.value} ${person?.name ?? ""}`, 1.3);
    }
  }
  hits.sort((a, b) => b.rank - a.rank || b.at.localeCompare(a.at));
  return { hits: hits.slice(0, 20), state };
}
