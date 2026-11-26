/**
 * The app's REST surface for the owner's own kinds of record and their
 * records (lib/custom-kinds.ts), mounted by netlify/functions/api.ts behind
 * the same bearer token:
 *
 *   GET    /api/kinds[?archived=1]               the kinds, in order (archived ones too with ?archived=1)
 *   POST   /api/kinds                            { name, one?, icon?, fields? } → { kind, fields }
 *   PATCH  /api/kinds/:id                        { name?, one?, icon? } → kind
 *   POST   /api/kinds/order                      { ids } → { kinds }
 *   POST   /api/kinds/:id/duplicate              → { kind, fields }: its fields, none of its records
 *   POST   /api/kinds/:id/archive|unarchive      → { kind, id, archived }
 *   DELETE /api/kinds/:id                        → { deleted }: the kind, its records (their links and values) and its fields
 *   GET    /api/records?kind=<id>                { items }: a kind's live records, by title
 *   GET    /api/records/:id                      one record
 *   POST   /api/records                          { kind, title, body?, values? } → record
 *   PATCH  /api/records/:id                      { title?, body?, values? } → record
 *   POST   /api/records/:id/duplicate            → record: its body and values, "<Title> copy"
 *   POST   /api/records/:id/archive|unarchive    → { kind, id, archived }
 *   DELETE /api/records/:id                      → { deleted }: with its links and values
 *
 * Permanent delete is the owner's, from the app (docs: security/sign-in-and-keys); MCP has no
 * way to it. Errors in the owner's words come back as 400s from
 * AthenaInputError, which api.ts maps like every other route.
 */
import { AthenaInputError, archiveEntity, deleteEntityForever, unarchiveEntity } from "../../lib/db";
import {
  createCustomRecord,
  createKind,
  duplicateCustomRecord,
  duplicateKind,
  getCustomRecord,
  getKind,
  listCustomRecords,
  listKinds,
  reorderKinds,
  updateCustomRecord,
  updateKind,
} from "../../lib/custom-kinds";

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

const notAllowed = (reply: Reply) => reply({ error: "Method not allowed" }, 405);
const notFound = (reply: Reply) => reply({ error: "Not found" }, 404);

/** Handles /api/kinds* and /api/records*; null for anything else. */
export async function handleCustomKindRoutes(req: Request, url: URL, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second, third] = segments;
  if (first !== "kinds" && first !== "records") return null;
  if (segments.length > 4) return notFound(reply);

  if (first === "kinds") {
    if (segments.length === 2) {
      if (req.method === "GET") return reply({ kinds: await listKinds({ includeArchived: url.searchParams.get("archived") === "1" }) });
      if (req.method === "POST") {
        const b = await body(req);
        const { kind, fields } = await createKind({ name: b.name, one: b.one, icon: b.icon, fields: b.fields });
        return reply({ kind, fields }, 201);
      }
      return notAllowed(reply);
    }
    if (second === "order" && segments.length === 3) {
      if (req.method !== "POST") return notAllowed(reply);
      return reply({ kinds: await reorderKinds((await body(req)).ids) });
    }
    if (!UUID_RE.test(second)) return notFound(reply);
    if (segments.length === 3) {
      if (req.method === "GET") {
        const kind = await getKind(second, { includeArchived: url.searchParams.get("include_archived") === "1" });
        return kind ? reply(kind) : notFound(reply);
      }
      if (req.method === "PATCH") {
        const b = await body(req);
        return reply(await updateKind(second, { name: b.name, one: b.one, icon: b.icon }));
      }
      if (req.method === "DELETE") {
        const deleted = await deleteEntityForever("kind", second);
        return deleted ? reply({ deleted: true }) : notFound(reply);
      }
      return notAllowed(reply);
    }
    if (req.method !== "POST") return notAllowed(reply);
    if (third === "duplicate") return reply(await duplicateKind(second), 201);
    if (third === "archive" || third === "unarchive") {
      const done = third === "archive" ? await archiveEntity("kind", second) : await unarchiveEntity("kind", second);
      return done ? reply({ kind: "kind", id: second, archived: third === "archive" }) : notFound(reply);
    }
    return notFound(reply);
  }

  // ---------- records ----------
  if (segments.length === 2) {
    if (req.method === "GET") {
      const kind = url.searchParams.get("kind");
      if (!kind || !UUID_RE.test(kind)) throw new AthenaInputError("Give the 'kind' (its id)");
      return reply({ items: await listCustomRecords(kind) });
    }
    if (req.method === "POST") {
      const b = await body(req);
      const { record } = await createCustomRecord({ kind: b.kind ?? b.kind_id, title: b.title, body: b.body, values: b.values });
      return reply(record, 201);
    }
    return notAllowed(reply);
  }
  if (!UUID_RE.test(second)) return notFound(reply);
  if (segments.length === 3) {
    if (req.method === "GET") {
      const record = await getCustomRecord(second, { includeArchived: url.searchParams.get("include_archived") === "1" });
      return record ? reply(record) : notFound(reply);
    }
    if (req.method === "PATCH") {
      const b = await body(req);
      return reply((await updateCustomRecord(second, { title: b.title, body: b.body, values: b.values })).record);
    }
    if (req.method === "DELETE") {
      const deleted = await deleteEntityForever("record", second);
      return deleted ? reply({ deleted: true }) : notFound(reply);
    }
    return notAllowed(reply);
  }
  if (req.method !== "POST") return notAllowed(reply);
  if (third === "duplicate") return reply((await duplicateCustomRecord(second)).record, 201);
  if (third === "archive" || third === "unarchive") {
    const done = third === "archive" ? await archiveEntity("record", second) : await unarchiveEntity("record", second);
    return done ? reply({ kind: "record", id: second, archived: third === "archive" }) : notFound(reply);
  }
  return notFound(reply);
}
