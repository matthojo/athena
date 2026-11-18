/**
 * The app's REST surface for custom fields (lib/custom-fields.ts), mounted by
 * netlify/functions/api.ts behind the same bearer token:
 *
 *   GET   /api/custom-fields[?archived=1]          every kind's fields (archived too with ?archived=1)
 *   POST  /api/custom-fields                       { kind, label, type, options?, unit? } → field
 *   PATCH /api/custom-fields/:id                   { label?, type?, options?, renames?, unit? } → field
 *   POST  /api/custom-fields/:id/archive|unarchive → field (archived, never deleted)
 *   POST  /api/custom-fields/order                 { kind, ids } → the kind's fields, in order
 *   GET   /api/custom-values?kind=person[&id=<id>] { fields, values }: a kind's live fields and their values
 *   PUT   /api/custom-values                       { field_id, entity_id, entity_kind?, value } → { field, value }
 *
 * Errors in the owner's words come back as 400s from AthenaInputError, which
 * api.ts maps like every other route.
 */
import { AthenaInputError } from "../../lib/db";
import { defineField, listFields, listValues, reorderFields, setFieldArchived, setValue, updateField } from "../../lib/custom-fields";
import { isFieldKind } from "../../lib/custom-field-rules";

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

/** Handles /api/custom-fields* and /api/custom-values; null for anything else. */
export async function handleCustomFieldRoutes(req: Request, url: URL, segments: string[], reply: Reply): Promise<Response | null> {
  const [, first, second, third] = segments;

  if (first === "custom-values" && segments.length === 2) {
    if (req.method === "GET") {
      const kind = url.searchParams.get("kind");
      if (!isFieldKind(kind)) throw new AthenaInputError("Give a known 'kind'");
      const id = url.searchParams.get("id");
      if (id && !UUID_RE.test(id)) throw new AthenaInputError("Invalid 'id'");
      const [fields, values] = await Promise.all([listFields({ kind }), listValues(kind, id ? [id] : undefined)]);
      return reply({ fields, values });
    }
    if (req.method === "PUT") {
      const b = await body(req);
      const result = await setValue({ field_id: b.field_id, entity_id: b.entity_id, entity_kind: b.entity_kind, value: b.value ?? null });
      return reply({ field: result.field, value: result.value });
    }
    return notAllowed(reply);
  }

  if (first !== "custom-fields") return null;

  if (segments.length === 2) {
    if (req.method === "GET") return reply({ fields: await listFields({ includeArchived: url.searchParams.get("archived") === "1" }) });
    if (req.method === "POST") {
      const b = await body(req);
      const { field } = await defineField({ kind: b.kind, label: b.label, type: b.type, options: b.options, unit: b.unit });
      return reply(field, 201);
    }
    return notAllowed(reply);
  }

  if (second === "order" && segments.length === 3) {
    if (req.method !== "POST") return notAllowed(reply);
    const b = await body(req);
    return reply({ fields: await reorderFields(b.kind, b.ids) });
  }

  if (!second || !UUID_RE.test(second)) return reply({ error: "Not found" }, 404);

  if (segments.length === 3) {
    if (req.method !== "PATCH") return notAllowed(reply);
    const b = await body(req);
    return reply(await updateField(second, { label: b.label, type: b.type, options: b.options, renames: b.renames, unit: b.unit }));
  }

  if (segments.length === 4 && (third === "archive" || third === "unarchive")) {
    if (req.method !== "POST") return notAllowed(reply);
    return reply(await setFieldArchived(second, third === "archive"));
  }

  return reply({ error: "Not found" }, 404);
}
