/**
 * The graph's data, on the app's usual degrade chain: the server's one read
 * (GET /api/graph) when online, the last copy of it when not, and otherwise a
 * graph built on this device from what's cached — or, in sample mode, from
 * the sample data with this device's edits. buildGraph() follows the same
 * rules as lib/graph.ts, so the three agree.
 *
 * Notes written on this device that haven't synced yet are laid over the
 * server's copy, with the links in their bodies.
 *
 * Only the Graph page and the small graphs on profiles import this (both are
 * lazy chunks). One load is shared for a short while, and dropped whenever
 * notes, records or layer 2 change.
 */

import * as api from "./api";
import { isSampleMode } from "./api";
import { getMeta, setMeta } from "./idb";
import { notesSnapshot, onNotes, refreshNotes } from "./data";
import { loadRecords, onRecordsChange } from "./records";
import { deviceFacts, loadCommitments, loadInteractions, loadReading, onMemoryChange } from "./memory";
import { loadKindRecords, loadKinds, onKindsChange } from "./custom-kinds";
import { edgeKindOf, parseAthenaLinks, type LinkKind } from "../../../lib/links";

/** A mention's kind as the graph names it: a to-do is a commitment, a Watch & read title a reading item. */
const graphKindOf = (kind: LinkKind): GraphKind => edgeKindOf(kind) as GraphKind;
import type {
  AthenaEvent,
  Commitment,
  ConnectionState,
  CustomRecord,
  Fact,
  Graph,
  GraphKind,
  GraphLink,
  GraphNode,
  Interaction,
  Note,
  Organisation,
  Person,
  Place,
  ReadingItem,
} from "../types";

export interface GraphLoad {
  graph: Graph;
  state: ConnectionState;
  /** For an offline copy of the server's graph: when it was fetched. */
  savedAt: string | null;
}

export interface DeviceData {
  notes: Note[];
  people: Person[];
  places: Place[];
  organisations: Organisation[];
  events: AthenaEvent[];
  commitments: Commitment[];
  interactions: Interaction[];
  facts: Fact[];
  reading: ReadingItem[];
  /** The owner's own records, of live kinds, each with its kind's name for one. */
  records?: Array<CustomRecord & { one: string }>;
}

const live = <T extends { archived_at?: string | null }>(rows: T[]) => rows.filter((r) => !r.archived_at);
const host = (url: string) => url.replace(/^https?:\/\/(www\.)?|\/$/gi, "");

/** Collects links one per pair of nodes, keeping the first relation in alphabetical order (as the SQL does). */
function linkSet() {
  const byPair = new Map<string, GraphLink>();
  return {
    add(source: string, target: string, relation: string) {
      if (source === target) return;
      const key = source < target ? `${source}|${target}` : `${target}|${source}`;
      const prev = byPair.get(key);
      if (!prev || relation < prev.relation) byPair.set(key, { source, target, relation });
    },
    all: () => [...byPair.values()],
  };
}

function withDegrees(nodes: Omit<GraphNode, "degree">[], links: GraphLink[]): Graph {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return { nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })), links };
}

/** The graph from records on this device, by lib/graph.ts's rules. */
export function buildGraph(d: DeviceData): Graph {
  const nodes: Omit<GraphNode, "degree">[] = [];
  const kindOf = new Map<string, GraphKind>();
  const add = (n: Omit<GraphNode, "degree">) => {
    nodes.push(n);
    kindOf.set(n.id, n.kind);
  };
  const isLive = (kind: GraphKind, id: string | null | undefined) => !!id && kindOf.get(id) === kind;

  for (const n of live(d.notes)) add({ id: n.id, kind: "note", title: n.title, sub: n.type, at: null });
  for (const p of live(d.people)) add({ id: p.id, kind: "person", title: p.name, sub: p.relationship ?? "", at: null });
  for (const p of live(d.places)) add({ id: p.id, kind: "place", title: p.name, sub: p.address.split("\n")[0] ?? "", at: null });
  for (const o of live(d.organisations)) add({ id: o.id, kind: "organisation", title: o.name, sub: host(o.website), at: null });
  for (const e of live(d.events)) {
    if (!e.person_id || isLive("person", e.person_id)) add({ id: e.id, kind: "event", title: e.title, sub: e.kind, at: null });
  }
  for (const r of live(d.records ?? [])) add({ id: r.id, kind: "record", title: r.title, sub: r.one, at: null, kind_id: r.kind_id });
  for (const i of live(d.interactions)) {
    if (i.people.some((p) => isLive("person", p.id))) add({ id: i.id, kind: "interaction", title: i.summary, sub: i.channel, at: i.at });
  }
  // To-dos and Watch & read titles a live note or record mentions join too (lib/graph.ts's edged).
  const mentioned = new Set<string>();
  for (const n of [...live(d.notes), ...live(d.records ?? [])]) for (const l of parseAthenaLinks(n.body)) mentioned.add(`${graphKindOf(l.kind)}:${l.id}`);
  for (const c of live(d.commitments)) {
    if (c.status !== "dropped" && (isLive("person", c.person_id) || mentioned.has(`commitment:${c.id}`))) {
      add({ id: c.id, kind: "commitment", title: c.title, sub: c.status === "done" && c.kind !== "decision" ? "done" : c.kind, at: null });
    }
  }
  for (const f of live(d.facts)) {
    if (!f.superseded_at && f.subject_kind !== "me" && isLive(f.subject_kind, f.subject_id)) {
      add({ id: f.id, kind: "fact", title: `${f.key}: ${f.value}`, sub: f.subject_kind, at: null });
    }
  }
  for (const r of live(d.reading)) {
    if (isLive("person", r.recommended_by) || mentioned.has(`reading:${r.id}`)) add({ id: r.id, kind: "reading", title: r.title, sub: r.kind, at: null });
  }

  const links = linkSet();
  for (const n of [...live(d.notes), ...live(d.records ?? [])]) {
    for (const l of parseAthenaLinks(n.body)) if (isLive(graphKindOf(l.kind), l.id)) links.add(n.id, l.id, "mentions");
  }
  for (const p of live(d.people)) if (p.organisation && isLive("organisation", p.organisation.id)) links.add(p.id, p.organisation.id, "works_at");
  for (const e of d.events) if (isLive("event", e.id) && e.person_id) links.add(e.id, e.person_id, e.kind === "birthday" ? "birthday" : "about");
  for (const i of d.interactions) {
    if (isLive("interaction", i.id)) for (const p of i.people) if (isLive("person", p.id)) links.add(i.id, p.id, "catch_up");
  }
  for (const c of d.commitments) if (isLive("commitment", c.id) && isLive("person", c.person_id)) links.add(c.id, c.person_id!, "to_do");
  for (const f of d.facts) if (isLive("fact", f.id)) links.add(f.id, f.subject_id!, "fact");
  for (const r of d.reading) if (isLive("reading", r.id) && isLive("person", r.recommended_by)) links.add(r.id, r.recommended_by!, "recommended");

  return withDegrees(nodes, links.all());
}

/**
 * Notes written on this device that haven't synced yet (their ids are still
 * `local-…`), laid over the server's graph with their body links. Only those:
 * the notes store falls back to sample notes when it has nothing, and those
 * must never join a real graph.
 */
function withDeviceNotes(graph: Graph, notes: Note[]): Graph {
  const known = new Map(graph.nodes.map((n) => [n.id, n.kind]));
  const fresh = live(notes).filter((n) => n.id.startsWith("local-") && !known.has(n.id));
  if (!fresh.length) return graph;
  const nodes: Omit<GraphNode, "degree">[] = [...graph.nodes.map(({ degree: _d, ...n }) => n)];
  const links = linkSet();
  for (const l of graph.links) links.add(l.source, l.target, l.relation);
  for (const n of fresh) {
    nodes.push({ id: n.id, kind: "note", title: n.title, sub: n.type, at: null });
    known.set(n.id, "note");
  }
  for (const n of fresh) {
    for (const l of parseAthenaLinks(n.body)) if (known.get(l.id) === graphKindOf(l.kind)) links.add(n.id, l.id, "mentions");
  }
  return withDegrees(nodes, links.all());
}

/** Everything the device has, leaving out sample stand-ins unless this is sample mode. */
async function deviceGraph(): Promise<Graph> {
  if (!notesSnapshot().loaded) await refreshNotes();
  const sample = isSampleMode();
  const usable = <T>(r: { items: T[]; state: ConnectionState }) => (sample || r.state !== "sample" ? r.items : []);
  const [people, places, organisations, events, commitments, interactions, reading] = await Promise.all([
    loadRecords("person").then(usable),
    loadRecords("place").then(usable),
    loadRecords("organisation").then(usable),
    loadRecords("event").then(usable),
    loadCommitments().then(usable),
    loadInteractions().then(usable),
    loadReading().then(usable),
  ]);
  const snap = notesSnapshot();
  const notes = sample || snap.state !== "sample" ? snap.notes : [];
  const facts = await deviceFacts(people.map((p) => p.id));
  // The kinds may still be loading at start-up: ask for them rather than read the snapshot.
  const kinds = (await loadKinds()).kinds.filter((k) => !k.archived_at);
  const records = (await Promise.all(kinds.map((k) => loadKindRecords(k.id).then(usable)))).flatMap((items, i) => items.map((r) => ({ ...r, one: kinds[i].one })));
  return buildGraph({ notes, people, places, organisations, events, commitments, interactions, facts, reading, records });
}

async function loadGraph(): Promise<GraphLoad> {
  if (isSampleMode()) return { graph: await deviceGraph(), state: "sample", savedAt: null };
  try {
    const graph = await api.fetchGraph();
    void setMeta("graph", JSON.stringify({ graph, savedAt: new Date().toISOString() })).catch(() => undefined);
    return { graph: withDeviceNotes(graph, notesSnapshot().notes), state: "online", savedAt: null };
  } catch {
    const cached = await getMeta("graph").catch(() => undefined);
    if (cached) {
      const { graph, savedAt } = JSON.parse(cached) as { graph: Graph; savedAt: string };
      return { graph: withDeviceNotes(graph, notesSnapshot().notes), state: "offline", savedAt };
    }
    return { graph: await deviceGraph(), state: "offline", savedAt: null };
  }
}

// ---------- one shared load ----------

const FRESH_MS = 30_000;
let shared: { at: number; promise: Promise<GraphLoad> } | null = null;
const subs = new Set<() => void>();
let changeTimer: ReturnType<typeof setTimeout> | undefined;

/** The graph, shared by every view that asks within a short window. */
export function getGraph(): Promise<GraphLoad> {
  if (shared && Date.now() - shared.at < FRESH_MS) return shared.promise;
  const promise = loadGraph();
  shared = { at: Date.now(), promise };
  promise.catch(() => {
    if (shared?.promise === promise) shared = null;
  });
  return promise;
}

/** Something the graph is built from changed: the next getGraph() reloads. */
export function onGraphChange(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function changed() {
  shared = null;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => subs.forEach((fn) => fn()), 250);
}

let primed = false;
onNotes(() => {
  // onNotes replays the current snapshot on subscribe; that isn't a change.
  if (primed) changed();
});
primed = true;
onRecordsChange(changed);
onMemoryChange(changed);
onKindsChange(changed);
