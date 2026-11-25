/**
 * Templates and sending notes out, over REST, mounted by
 * netlify/functions/api.ts behind the same bearer token:
 *
 *   GET   /api/templates                     { templates }: starters (edited or not) and the owner's own
 *   POST  /api/templates                     { name, body } → template ("Save as template" too)
 *   PATCH /api/templates/:id                 { name?, body? } → template (a starter's id is "starter:<key>")
 *   POST  /api/templates/:id/archive|restore → { ok }
 *   POST  /api/templates/:id/fill            { event_id?, person_ids?, trip_id?, project_id?, week_of? } → { title, body, blanks, filled, about }
 *   POST  /api/templates/:id/share           { edits?, fine?, download? } → TemplateExport (lib/template-share.ts); with
 *                                            download, the zip, or 409 with what's still flagged
 *   GET   /api/templates/prepare             { suggestions }: Today's "Prepare notes"
 *
 *   GET   /api/documents/accounts            { accounts }: where a note can be sent
 *   GET   /api/documents?note_id=            { exports }: where this note went
 *   POST  /api/documents                     { note_id, to: "google-docs"|"notion", connector_id? } → { export, updated, account }
 *   POST  /api/documents/:id/undo            → export (trashes the doc, or clears the Notion page)
 *   GET   /api/documents/notion/:account     { enabled, parent }
 *   PUT   /api/documents/notion/:account     { parent: { id, title } | null } → { enabled, parent }
 *   GET   /api/documents/notion/:account/pages?q=   { pages }: for the parent picker
 */
import { AthenaInputError } from "../../lib/db";
import { archiveTemplate, createTemplate, exportTemplateFor, findTemplate, listTemplates, restoreTemplate, templateZip, updateTemplate } from "../../lib/templates-db";
import { fillFromAthena, prepareSuggestions } from "../../lib/template-fill";
import { documentAccounts, documentPorts, isDocumentProvider, listExports, notionWriteState, sendNote, setNotionParent, undoExport } from "../../lib/documents";

type Reply = (data: unknown, status?: number) => Response;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AthenaInputError("Send a JSON object");
}

const str = (b: Record<string, unknown>, k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
const id = (b: Record<string, unknown>, k: string) => {
  const v = str(b, k);
  if (v === undefined || v === "") return null;
  if (!UUID_RE.test(v)) throw new AthenaInputError(`${k} isn't an id`);
  return v;
};

/** /api/templates* and /api/documents*; null for anything else. */
export async function handleDocumentRoutes(req: Request, url: URL, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second, third, fourth] = segments;

  if (first === "templates") {
    if (!second) {
      if (req.method === "GET") return reply({ templates: await listTemplates() });
      if (req.method === "POST") {
        const b = await body(req);
        return reply(await createTemplate({ name: str(b, "name"), body: str(b, "body") }), 201);
      }
      return reply({ error: "Method not allowed" }, 405);
    }
    if (second === "prepare" && !third && req.method === "GET") return reply({ suggestions: await prepareSuggestions() });
    const tid = decodeURIComponent(second);
    if (!third && req.method === "PATCH") {
      const b = await body(req);
      return reply(await updateTemplate(tid, { name: str(b, "name"), body: str(b, "body") }));
    }
    if (third === "archive" && req.method === "POST") {
      await archiveTemplate(tid);
      return reply({ ok: true });
    }
    if (third === "restore" && req.method === "POST") {
      await restoreTemplate(tid);
      return reply({ ok: true });
    }
    if (third === "share" && !fourth) {
      if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
      const b = await body(req);
      const { ownHosts } = await import("../../lib/team-share-store");
      const made = await exportTemplateFor(tid, b, { hosts: ownHosts(new URL(req.url).origin) });
      if (b.download !== true) return reply(made);
      if (made.findings.length) return reply({ error: "Check what's flagged first: edit it out, or say it's fine to share.", findings: made.findings }, 409);
      return new Response(Buffer.from(await templateZip(made)), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${made.slug}.zip"`, "Cache-Control": "no-store" } });
    }
    if (third === "fill" && req.method === "POST") {
      const b = await body(req);
      const template = await findTemplate(tid);
      if (!template) throw new AthenaInputError("No such template");
      const people = Array.isArray(b.person_ids) ? b.person_ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).slice(0, 10) : [];
      const week = str(b, "week_of");
      if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new AthenaInputError("week_of is a date");
      return reply(await fillFromAthena(template, { event_id: id(b, "event_id"), person_ids: people, trip_id: id(b, "trip_id"), project_id: id(b, "project_id"), week_of: week ?? null }));
    }
    return reply({ error: "Not found" }, 404);
  }

  if (first !== "documents") return null;
  if (!second) {
    if (req.method === "GET") {
      const note = url.searchParams.get("note_id") ?? "";
      if (!UUID_RE.test(note)) throw new AthenaInputError("note_id isn't an id");
      return reply({ exports: await listExports(note) });
    }
    if (req.method === "POST") {
      const b = await body(req);
      const note = id(b, "note_id");
      const to = b.to;
      if (!note) throw new AthenaInputError("Which note?");
      if (!isDocumentProvider(to)) throw new AthenaInputError("Send it to google-docs or notion");
      return reply(await sendNote(note, to, { connectorId: id(b, "connector_id") ?? undefined }), 201);
    }
    return reply({ error: "Method not allowed" }, 405);
  }
  if (second === "accounts" && !third && req.method === "GET") return reply({ accounts: await documentAccounts() });
  if (UUID_RE.test(second) && third === "undo" && req.method === "POST") return reply(await undoExport(second));
  if (second === "notion" && third && UUID_RE.test(third)) {
    if (!fourth && req.method === "GET") return reply(await notionWriteState(third));
    if (!fourth && req.method === "PUT") {
      const b = await body(req);
      const p = b.parent as { id?: unknown; title?: unknown } | null | undefined;
      if (p !== null && (typeof p !== "object" || typeof p?.id !== "string")) throw new AthenaInputError("parent is { id, title } or null");
      return reply(await setNotionParent(third, p ? { id: p.id as string, title: typeof p.title === "string" ? p.title : "" } : null));
    }
    if (fourth === "pages" && req.method === "GET") return reply({ pages: await (await documentPorts()).notion.search(third, url.searchParams.get("q") ?? "") });
  }
  return reply({ error: "Not found" }, 404);
}
