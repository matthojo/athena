/**
 * Templates and sending notes out, on the device (lib/templates-db.ts,
 * lib/template-fill.ts and lib/documents.ts on the server). Every call needs
 * a connection: the server fills templates from records the device doesn't
 * hold all of, and only it can reach Google or Notion.
 *
 * Sample mode keeps its own: the six starters (and any edits) on the device,
 * templates added from someone else (as the server keeps them: marked as
 * shared, never over one of the owner's), a fill made from the sample people,
 * catch-ups and to-dos, and a pretend Google Docs and Notion account whose
 * sends are kept here.
 */
import { request, isSampleMode } from "./api";
import { getMeta, setMeta } from "./idb";
import { STARTERS, fillTemplate, parseTemplate, splitTitle, templateNeeds, type Cite, type FieldValues } from "../../../lib/templates";
import { SAMPLE_IDS, samplePeople, sampleEvents } from "./sample-data";
import { sampleCommitments, sampleFacts, sampleInteractions } from "./sample-memory";
import { addDays } from "../../../lib/dates";
import { localToday } from "../lib/time";
import { freeTemplateName, readSharedTemplate, type SharedTemplate } from "../../../lib/template-share";

export type FieldContext = "meeting" | "person" | "trip" | "project" | "week" | "none";

export interface NoteTemplate {
  id: string;
  starter: string | null;
  name: string;
  blurb: string;
  body: string;
  fields: string[];
  needs: FieldContext[];
  edited: boolean;
  updated_at: string | null;
  /** Added from someone else (lib/templates-db.ts SharedInfo): who made it, their summary, the listing. Null for Athena's and the owner's own. */
  shared?: SharedInfo | null;
}

export interface SharedInfo {
  author: string | null;
  version: string | null;
  summary: string;
  catalogue_id: string | null;
  /** The owner has changed it since adding it. */
  changed: boolean;
}

/** Lists that show templates (the picker, a day's "Start from a template") hear when one is added, changed or removed. */
const listeners = new Set<() => void>();
export function onTemplatesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function templatesChanged(): void {
  for (const fn of listeners) fn();
}

export interface FillInput {
  event_id?: string | null;
  person_ids?: string[];
  trip_id?: string | null;
  project_id?: string | null;
  week_of?: string | null;
}

export interface Filled {
  title: string;
  body: string;
  blanks: string[];
  filled: Array<{ name: string; sources: Cite[] }>;
}

export interface PrepareSuggestion {
  event_id: string;
  title: string;
  starts_at: string;
  people: Array<{ id: string; name: string }>;
}

export type DocumentProvider = "google-docs" | "notion";

export interface DocumentAccount {
  id: string;
  provider: DocumentProvider;
  name: string;
  label: string;
  parent_title?: string;
}

export interface DocumentExport {
  id: string;
  note_id: string | null;
  provider: DocumentProvider;
  connector_id: string;
  external_id: string;
  url: string;
  title: string;
  created_at: string;
  updated_at: string;
  undone_at: string | null;
}

export interface SendResult {
  export: DocumentExport;
  updated: boolean;
  account: DocumentAccount;
}

export const PROVIDER_NAME: Record<DocumentProvider, string> = { "google-docs": "Google Docs", notion: "Notion" };
/** "Open in Docs", "Open in Notion". */
export const OPEN_IN: Record<DocumentProvider, string> = { "google-docs": "Open in Docs", notion: "Open in Notion" };

// ---------- sample mode's own ----------

const SAMPLE_TEMPLATES = "sample.templates";
const SAMPLE_EXPORTS = "sample.exports";
const SAMPLE_NOTION = "sample.notion-parent";
export const SAMPLE_DOCS_ACCOUNT = "5a3e0000-0000-4000-8000-000000000901";
export const SAMPLE_NOTION_ACCOUNT = "5a3e0000-0000-4000-8000-000000000902";

async function sampleJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getMeta(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const saveSample = (key: string, value: unknown) => setMeta(key, JSON.stringify(value));

type SampleRow = {
  id: string;
  starter: string | null;
  name: string;
  body: string;
  updated_at: string;
  archived?: boolean;
  /** Added from someone else, with the listing's hash as the catalogue_* columns keep it. */
  shared?: SharedInfo & { catalogue_hash: string | null };
};

function shape(t: Omit<NoteTemplate, "blurb" | "fields" | "needs">): NoteTemplate {
  const starter = STARTERS.find((s) => s.key === t.starter);
  const fields = parseTemplate(t.body).map((f) => f.name);
  const shared = t.shared ? { author: t.shared.author, version: t.shared.version, summary: t.shared.summary, catalogue_id: t.shared.catalogue_id, changed: t.shared.changed } : null;
  return { ...t, shared, blurb: starter?.blurb ?? (shared?.summary || (fields.length ? `Fills ${fields.slice(0, 3).join(", ")}${fields.length > 3 ? "…" : ""}` : "Your own")), fields, needs: templateNeeds(t.body) };
}

/**
 * Sample mode's templates, as the server lists them. Until the sample's own list is first saved, it holds two
 * templates added from Community (db/sample-community.ts): one with a newer version listed, one taken down since.
 */
async function sampleRows(): Promise<SampleRow[]> {
  const { SAMPLE_ADDED_TEMPLATE_ROWS } = await import("./sample-community");
  return sampleJson<SampleRow[]>(SAMPLE_TEMPLATES, structuredClone(SAMPLE_ADDED_TEMPLATE_ROWS));
}

async function sampleTemplates(): Promise<NoteTemplate[]> {
  const rows = (await sampleRows()).filter((r) => !r.archived);
  const starters = STARTERS.map((s) => {
    const e = rows.find((r) => r.starter === s.key && !r.shared);
    return shape(e ? { ...e, edited: true } : { id: `starter:${s.key}`, starter: s.key, name: s.name, body: s.body, edited: false, updated_at: null });
  });
  return [...starters, ...rows.filter((r) => !r.starter || r.shared).map((r) => shape({ ...r, edited: true }))];
}

/** Sample mode's Add for a template, as the server's: a new one marked as someone else's, never over one of the owner's. */
export async function sampleAddTemplate(raw: SharedTemplate, listing?: { id: string; hash: string; version: string | null }): Promise<{ id: string; name: string; renamed: boolean; beside: boolean }> {
  const shared = readSharedTemplate(raw);
  const rows = await sampleRows();
  const name = freeTemplateName(shared.name, (await sampleTemplates()).map((t) => t.name));
  const row: SampleRow = {
    id: crypto.randomUUID(),
    starter: null,
    name,
    body: shared.body,
    updated_at: new Date().toISOString(),
    shared: { author: shared.author ?? null, version: shared.version ?? null, summary: shared.summary, catalogue_id: listing?.id ?? null, catalogue_hash: listing?.hash ?? null, changed: false },
  };
  await saveSample(SAMPLE_TEMPLATES, [...rows, row]);
  templatesChanged();
  return { id: row.id, name, renamed: name !== shared.name, beside: false };
}

/** Sample mode's Update for a template, as the server's: over it while unchanged, beside it once the owner changed it. */
export async function sampleReplaceTemplate(id: string, raw: SharedTemplate, listing: { id: string; hash: string; version: string | null }): Promise<{ id: string; name: string; renamed: boolean; beside: boolean }> {
  const shared = readSharedTemplate(raw);
  const rows = await sampleRows();
  const row = rows.find((r) => r.id === id && r.shared && !r.archived);
  if (!row?.shared) throw new Error("That template isn't there any more");
  if (row.shared.changed) {
    row.shared = { ...row.shared, catalogue_id: null, catalogue_hash: null };
    await saveSample(SAMPLE_TEMPLATES, rows);
    return { ...(await sampleAddTemplate(shared, listing)), beside: true };
  }
  Object.assign(row, { body: shared.body, updated_at: new Date().toISOString(), shared: { ...row.shared, author: shared.author ?? null, version: shared.version ?? null, summary: shared.summary, catalogue_id: listing.id, catalogue_hash: listing.hash } });
  await saveSample(SAMPLE_TEMPLATES, rows);
  templatesChanged();
  return { id, name: row.name, renamed: false, beside: false };
}

/** Sample templates that came from a listing, as the catalogue_* columns would say: for "You already have this" and updates. */
export async function sampleTemplateListings(): Promise<Array<{ id: string; catalogue_id: string; hash: string; version: string | null; changed: boolean }>> {
  return (await sampleRows()).flatMap((r) => (r.shared?.catalogue_id && r.shared.catalogue_hash && !r.archived ? [{ id: r.id, catalogue_id: r.shared.catalogue_id, hash: r.shared.catalogue_hash, version: r.shared.version, changed: r.shared.changed }] : []));
}

const short = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(d));
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(",", "");

/** The same fill the server makes, from sample mode's own people, catch-ups, details and to-dos. Nothing else is made up. */
function sampleFill(body: string, input: FillInput): Filled {
  const people = samplePeople();
  const event = sampleEvents().find((e) => e.id === input.event_id) ?? null;
  const who = [...new Set([...(event?.person_id ? [event.person_id] : []), ...(input.person_ids ?? [])])].map((id) => people.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const eventCite: Cite[] = event ? [{ label: event.title, kind: "event", id: event.id, detail: event.starts_at ? when(event.starts_at) : short(event.date) }] : [];
  const values: FieldValues = {};
  const today = localToday();
  for (const f of parseTemplate(body)) {
    const k = f.key;
    if (k === "meeting") values[k] = event ? { lines: [event.title], sources: eventCite } : null;
    else if (k === "date") values[k] = event?.starts_at ? { lines: [when(event.starts_at)], sources: eventCite } : { lines: [short(today)], sources: [{ label: "Today" }] };
    else if (k === "today") values[k] = { lines: [new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date())], sources: [{ label: "Today" }] };
    else if (k === "attendees") values[k] = event && who.length ? { lines: who.map((p) => p.name), sources: eventCite } : null;
    else if (k === "person") values[k] = who.length ? { lines: [who.map((p) => p.name).join(", ")], sources: who.map((p) => ({ label: p.name, kind: "person" as const, id: p.id })) } : null;
    else if (k === "last time we spoke") {
      const lines: string[] = [];
      const sources: Cite[] = [];
      for (const p of who) {
        const last = sampleInteractions().find((i) => i.people.some((x) => x.id === p.id));
        if (!last) continue;
        lines.push(`${who.length > 1 ? `${p.name}, ` : ""}${short(last.at)}: ${last.summary}`);
        sources.push({ label: p.name, kind: "person", id: p.id, detail: `catch-up on ${short(last.at)}` });
      }
      values[k] = lines.length ? { lines, sources } : null;
    } else if (k === "about them") {
      const solo = who.length === 1 ? who[0] : null;
      const facts = solo ? sampleFacts().filter((x) => x.subject_kind === "person" && x.subject_id === solo.id).slice(0, 5) : [];
      values[k] = solo && facts.length ? { lines: facts.map((x) => `${x.key.replace(/_/g, " ")}: ${x.value}`), sources: [{ label: solo.name, kind: "person", id: solo.id, detail: "saved details" }] } : null;
    } else if (k === "open loops") {
      const open = sampleCommitments().filter((c) => c.status === "open" && c.kind !== "decision" && who.some((p) => p.id === c.person_id));
      const words = (c: (typeof open)[number]) => (c.kind === "i_owe" ? `You owe ${c.person?.name}: ` : c.kind === "waiting_on" ? `Waiting on ${c.person?.name}: ` : "");
      values[k] = open.length ? { lines: open.map((c) => `[ ] ${words(c)}${c.title}`), sources: open.slice(0, 4).map((c) => ({ label: c.title, kind: "todo" as const, id: c.id })) } : null;
    } else if (k === "open to-dos") {
      const open = sampleCommitments().filter((c) => c.status === "open" && (c.kind === "todo" || c.kind === "i_owe") && (!c.due_on || c.due_on <= addDays(today, 7)));
      values[k] = open.length ? { lines: open.map((c) => `[ ] ${c.title}`), sources: [{ label: "To-dos", detail: `${open.length} due in the next week` }] } : null;
    } else values[k] = null;
  }
  const out = fillTemplate(body, values);
  return { ...out, ...splitTitle(out.body, event?.title ?? "Untitled") };
}

// ---------- templates ----------

export async function loadTemplates(): Promise<NoteTemplate[]> {
  if (isSampleMode()) return sampleTemplates();
  return (await request<{ templates: NoteTemplate[] }>("/templates")).templates;
}

export async function createTemplate(input: { name: string; body: string }): Promise<NoteTemplate> {
  if (isSampleMode()) {
    const rows = await sampleRows();
    const row: SampleRow = { id: crypto.randomUUID(), starter: null, name: input.name.trim() || "Untitled", body: input.body, updated_at: new Date().toISOString() };
    await saveSample(SAMPLE_TEMPLATES, [...rows, row]);
    templatesChanged();
    return shape({ ...row, edited: true });
  }
  const made = await request<NoteTemplate>("/templates", { method: "POST", body: JSON.stringify(input) });
  templatesChanged();
  return made;
}

export async function updateTemplate(id: string, input: { name?: string; body?: string }): Promise<NoteTemplate> {
  if (isSampleMode()) {
    const rows = await sampleRows();
    const key = id.startsWith("starter:") ? id.slice(8) : null;
    const starter = STARTERS.find((s) => s.key === key);
    let row = rows.find((r) => r.id === id || (key && r.starter === key && !r.shared && !r.archived));
    if (!row) {
      row = { id: crypto.randomUUID(), starter: key, name: starter?.name ?? "Untitled", body: starter?.body ?? "", updated_at: "" };
      rows.push(row);
    }
    // An added template the owner changes is theirs from then on (lib/templates-db.ts updateTemplate).
    if (row.shared && ((input.name !== undefined && input.name.trim() !== row.name) || (input.body !== undefined && input.body !== row.body))) row.shared = { ...row.shared, changed: true };
    Object.assign(row, { ...input, updated_at: new Date().toISOString() });
    await saveSample(SAMPLE_TEMPLATES, rows);
    templatesChanged();
    return shape({ ...row, edited: true });
  }
  const saved = await request<NoteTemplate>(`/templates/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  templatesChanged();
  return saved;
}

/** Remove one of the owner's own, or put a starter back as it was. */
export async function archiveTemplate(id: string, archived = true): Promise<void> {
  if (isSampleMode()) {
    const rows = await sampleRows();
    const row = rows.find((r) => r.id === id);
    if (row) row.archived = archived;
    await saveSample(SAMPLE_TEMPLATES, rows);
    templatesChanged();
    return;
  }
  await request(`/templates/${encodeURIComponent(id)}/${archived ? "archive" : "restore"}`, { method: "POST", body: "{}" });
  templatesChanged();
}

export async function fillFromTemplate(t: NoteTemplate, input: FillInput): Promise<Filled> {
  if (isSampleMode()) return sampleFill(t.body, input);
  return request(`/templates/${encodeURIComponent(t.id)}/fill`, { method: "POST", body: JSON.stringify(input) });
}

export async function loadPrepare(): Promise<PrepareSuggestion[]> {
  if (isSampleMode()) {
    const e = sampleEvents().find((x) => x.id === SAMPLE_IDS.mentoring)!;
    const notes = await sampleJson<string[]>("sample.prepared", []);
    if (notes.includes(e.id)) return [];
    return [{ event_id: e.id, title: e.title, starts_at: e.starts_at!, people: [{ id: SAMPLE_IDS.priya, name: "Priya Shah" }] }];
  }
  return (await request<{ suggestions: PrepareSuggestion[] }>("/templates/prepare")).suggestions;
}

/** Sample mode: a meeting that has notes now stops being offered. */
export async function markPrepared(eventId: string): Promise<void> {
  if (!isSampleMode()) return;
  const notes = await sampleJson<string[]>("sample.prepared", []);
  await saveSample("sample.prepared", [...new Set([...notes, eventId])]);
}

/** Projects, for "Which project?" (none in sample mode). */
export async function loadProjects(): Promise<Array<{ id: string; name: string }>> {
  if (isSampleMode()) return [];
  const got = await request<Array<{ id: string; name: string }> | { items?: Array<{ id: string; name: string }> }>("/projects");
  return Array.isArray(got) ? got : (got.items ?? []);
}

// ---------- sending ----------

export async function loadDocumentAccounts(): Promise<DocumentAccount[]> {
  if (isSampleMode()) {
    const parent = await sampleJson<{ id: string; title: string } | null>(SAMPLE_NOTION, null);
    return [
      { id: SAMPLE_DOCS_ACCOUNT, provider: "google-docs", name: "Google Docs", label: "personal" },
      ...(parent ? [{ id: SAMPLE_NOTION_ACCOUNT, provider: "notion" as const, name: "Notion", label: "", parent_title: parent.title }] : []),
    ];
  }
  return (await request<{ accounts: DocumentAccount[] }>("/documents/accounts")).accounts;
}

export async function loadExports(noteId: string): Promise<DocumentExport[]> {
  if (isSampleMode()) return (await sampleJson<DocumentExport[]>(SAMPLE_EXPORTS, [])).filter((e) => e.note_id === noteId);
  return (await request<{ exports: DocumentExport[] }>(`/documents?note_id=${encodeURIComponent(noteId)}`)).exports;
}

export async function sendToDocuments(noteId: string, title: string, to: DocumentProvider, connectorId?: string): Promise<SendResult> {
  if (isSampleMode()) {
    const accounts = await loadDocumentAccounts();
    const account = accounts.find((a) => a.provider === to && (!connectorId || a.id === connectorId));
    if (!account) throw new Error(to === "notion" ? "Turn on “Let Athena create pages” for Notion in Sources first" : "Add a Google Docs account in Sources first");
    const all = await sampleJson<DocumentExport[]>(SAMPLE_EXPORTS, []);
    const prev = all.find((e) => e.note_id === noteId && e.connector_id === account.id && !e.undone_at);
    const now = new Date().toISOString();
    if (prev) {
      Object.assign(prev, { title, updated_at: now });
      await saveSample(SAMPLE_EXPORTS, all);
      return { export: prev, updated: true, account };
    }
    const ext = crypto.randomUUID().replace(/-/g, "");
    const made: DocumentExport = {
      id: crypto.randomUUID(),
      note_id: noteId,
      provider: to,
      connector_id: account.id,
      external_id: ext,
      url: to === "notion" ? `https://www.notion.so/${ext}` : `https://docs.google.com/document/d/${ext}/edit`,
      title,
      created_at: now,
      updated_at: now,
      undone_at: null,
    };
    await saveSample(SAMPLE_EXPORTS, [made, ...all]);
    return { export: made, updated: false, account };
  }
  return request("/documents", { method: "POST", body: JSON.stringify({ note_id: noteId, to, connector_id: connectorId }) });
}

export async function undoDocument(id: string): Promise<DocumentExport> {
  if (isSampleMode()) {
    const all = await sampleJson<DocumentExport[]>(SAMPLE_EXPORTS, []);
    const row = all.find((e) => e.id === id);
    if (!row) throw new Error("Athena didn't make that");
    row.undone_at = new Date().toISOString();
    await saveSample(SAMPLE_EXPORTS, all);
    return row;
  }
  return request(`/documents/${id}/undo`, { method: "POST", body: "{}" });
}

// ---------- Notion: "Let Athena create pages" ----------

export interface NotionWrite {
  enabled: boolean;
  parent: { id: string; title: string } | null;
}

export async function loadNotionWrite(connectorId: string): Promise<NotionWrite> {
  if (isSampleMode()) {
    const parent = await sampleJson<{ id: string; title: string } | null>(SAMPLE_NOTION, null);
    return { enabled: !!parent, parent };
  }
  return request(`/documents/notion/${connectorId}`);
}

export async function saveNotionParent(connectorId: string, parent: { id: string; title: string } | null): Promise<NotionWrite> {
  if (isSampleMode()) {
    await saveSample(SAMPLE_NOTION, parent);
    return { enabled: !!parent, parent };
  }
  return request(`/documents/notion/${connectorId}`, { method: "PUT", body: JSON.stringify({ parent }) });
}

const SAMPLE_PAGES = [
  { id: "1a2b3c4d5e6f40718293a4b5c6d7e8f9", title: "Projects", url: "https://www.notion.so/1a2b3c4d5e6f40718293a4b5c6d7e8f9" },
  { id: "2b3c4d5e6f7a40819203b4c5d6e7f8a9", title: "Meeting notes", url: "https://www.notion.so/2b3c4d5e6f7a40819203b4c5d6e7f8a9" },
  { id: "3c4d5e6f7a8b40919304c5d6e7f8a9b0", title: "Reading list", url: "https://www.notion.so/3c4d5e6f7a8b40919304c5d6e7f8a9b0" },
  { id: "4d5e6f7a8b9c40a29405d6e7f8a9b0c1", title: "Home", url: "https://www.notion.so/4d5e6f7a8b9c40a29405d6e7f8a9b0c1" },
];

export async function searchNotionPages(connectorId: string, q: string): Promise<Array<{ id: string; title: string; url: string }>> {
  if (isSampleMode()) return SAMPLE_PAGES.filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (await request<{ pages: Array<{ id: string; title: string; url: string }> }>(`/documents/notion/${connectorId}/pages?q=${encodeURIComponent(q)}`)).pages;
}
