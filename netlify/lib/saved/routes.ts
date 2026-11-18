/**
 * Saved over REST (lib/saved.ts; the contract is docs/notes/saved.md).
 *
 *  - POST /api/saved: keep a link, image, quote, snippet or note. JSON, or
 *    multipart with the image in "image". A capture key opens it (the
 *    caller checks), as does a full key or the app's token. 201 with the
 *    item; 200 with the existing one for a repeated client_id or link.
 *  - GET /api/saved/ping: the extension's Test button. Stores nothing.
 *  - GET /api/saved?kind=&q=&day=&before=&limit=&archived=1, GET/PATCH/DELETE
 *    /api/saved/:id, POST /api/saved/:id/refetch, GET /api/saved/:id/image[?size=sm]:
 *    the app (full access; the caller checks). &filed=1 lists what actions filed.
 *  - GET /api/saved/:id/actions: the actions that fit (lib/saved-actions.ts), best
 *    first, with where it's filed and what it's linked to. POST
 *    /api/saved/:id/actions/:action { params } runs one; POST
 *    /api/saved/:id/actions/undo { undo? } reverses it (a filed item comes back).
 */
import { AthenaInputError } from "../../../lib/db";
import { DataBoxError } from "../../../lib/data-box";
import { MAX_SAVED_IMAGE_BYTES, MAX_SAVED_REQUEST_BYTES, SaveTooBig } from "../../../lib/saved-rules";
import { actionsFor, runSavedAction, SavedActionError, savedLinks, undoSavedAction } from "../../../lib/saved-actions";
import { takeSaveSlot, deleteSaved, getSaved, isSavedId, listSaved, readSavedImage, refetchItem, saveItem, SavedImageError, updateSaved, type SaveRequest } from "../../../lib/saved";

type Json = (data: unknown, status?: number) => Response;

/** The app's own address for an item: hash routes. */
export const itemPage = (origin: string, id: string) => `${origin}/#/saved/${id}`;

/** A data URL's bytes, or null if it isn't one. */
export function dataUrlBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^data:([a-z]+\/[a-z0-9.+-]+)?(;[a-z-]+=[^;,]+)*;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  return new Uint8Array(Buffer.from(m[3].replace(/\s+/g, ""), "base64"));
}

const tooBig = (json: Json, what = "That's too big to save") => json({ error: `${what}.` }, 413);

/** The request's fields, from JSON, a form, or plain text (a Shortcut's "Text" body). */
export async function readSaveBody(req: Request): Promise<SaveRequest | Response | null> {
  const type = req.headers.get("content-type") ?? "";
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(type)) {
    const form = await req.formData().catch(() => null);
    if (!form) return null;
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : undefined;
    };
    const file = form.get("image");
    let image: Uint8Array | null = null;
    if (file && typeof file !== "string") {
      if (file.size > MAX_SAVED_IMAGE_BYTES) return new Response(null, { status: 413 });
      image = new Uint8Array(await file.arrayBuffer());
    } else if (typeof file === "string" && /^https?:\/\//i.test(file)) {
      return { url: field("url"), text: field("text"), selection: field("selection"), title: field("title"), note: field("note"), source_url: field("source_url"), source: field("source"), client_id: field("client_id"), tags: field("tags"), image: null, image_url: file };
    } else if (typeof file === "string") image = dataUrlBytes(file);
    return { url: field("url"), text: field("text"), selection: field("selection"), title: field("title"), note: field("note"), source_url: field("source_url"), source: field("source"), client_id: field("client_id"), tags: field("tags"), image };
  }
  const raw = await req.text();
  if (/application\/json/i.test(type) || /^\s*\{/.test(raw)) {
    let body: Record<string, unknown>;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new AthenaInputError("Send JSON, or a form");
    }
    if (!body || typeof body !== "object") return null;
    // An image by address (the extension's right-click on a picture): fetched by saveItem through the guarded fetch.
    if (typeof body.image === "string" && /^https?:\/\//i.test(body.image)) return { ...(body as SaveRequest), image: null, image_url: body.image };
    const image = dataUrlBytes(body.image);
    if (typeof body.image === "string" && body.image && !image) throw new AthenaInputError("image: send a file, a base64 data URL, or an https address");
    if (image && image.byteLength > MAX_SAVED_IMAGE_BYTES) return new Response(null, { status: 413 });
    return { ...(body as SaveRequest), image };
  }
  return { text: raw };
}

function fail(error: unknown, json: Json): Response {
  if (error instanceof SaveTooBig) return tooBig(json, `The ${error.message} is over 20,000 characters`);
  if (error instanceof SavedImageError) return json({ error: error.message }, /over 10 MB/.test(error.message) ? 413 : /key isn't set/.test(error.message) ? 503 : 400);
  if (error instanceof AthenaInputError || error instanceof SavedActionError) return json({ error: error.message }, 400);
  if (error instanceof DataBoxError) return json({ error: "Athena can't open your saved things right now: its encryption key isn't set here." }, 503);
  throw error;
}

/** POST /api/saved and GET /api/saved/ping. The caller has checked the key (capture or better). */
export async function handleSavedCapture(req: Request, url: URL, segments: string[], json: Json): Promise<Response | null> {
  if (segments.length === 3 && segments[2] === "ping") {
    return req.method === "GET" ? json({ ok: true, name: "Athena" }) : json({ error: "Method not allowed" }, 405);
  }
  if (segments.length !== 2 || req.method !== "POST") return null;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_SAVED_REQUEST_BYTES) return tooBig(json);
  if (!(await takeSaveSlot(req))) return json({ error: "That's a lot of saves in one minute. Try again shortly." }, 429);
  try {
    const body = await readSaveBody(req);
    if (body instanceof Response) return tooBig(json, "That image is over 10 MB");
    if (!body) return json({ error: "There was nothing to save." }, 400);
    const { item, created } = await saveItem(body);
    return json({ id: item.id, url: itemPage(url.origin, item.id), item }, created ? 201 : 200);
  } catch (error) {
    return fail(error, json);
  }
}

/** The app's routes (full access; the caller checks). Null for anything else. */
export async function handleSavedRoutes(req: Request, url: URL, segments: string[], json: Json, cors: Record<string, string>): Promise<Response | null> {
  const [, , id, part] = segments;
  try {
    if (!id) {
      if (req.method !== "GET") return null;
      const p = url.searchParams;
      return json(await listSaved({ kind: p.get("kind"), q: p.get("q"), day: p.get("day"), before: p.get("before"), limit: p.get("limit"), archived: p.get("archived") === "1", filed: p.get("filed") === "1" }));
    }
    if (!isSavedId(id)) return json({ error: "Not found" }, 404);
    if (part === "image" && segments.length === 4 && req.method === "GET") {
      const size = url.searchParams.get("size") === "sm" ? "sm" : "lg";
      const bytes = await readSavedImage(id, size);
      if (!bytes) return json({ error: "Image not found" }, 404);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          ...cors,
        },
      });
    }
    if (part === "actions") return await handleActions(req, id, segments, json);
    if (part === "refetch" && segments.length === 4 && req.method === "POST") {
      const item = await refetchItem(id);
      return item ? json(item) : json({ error: "Not found" }, 404);
    }
    if (segments.length !== 3) return null;
    if (req.method === "GET") {
      const item = await getSaved(id, { readable: true });
      return item ? json(item) : json({ error: "Not found" }, 404);
    }
    if (req.method === "PATCH") {
      let body: unknown;
      try {
        body = JSON.parse((await req.text()) || "{}");
      } catch {
        throw new AthenaInputError("Send JSON");
      }
      const item = await updateSaved(id, (body ?? {}) as never);
      return item ? json(item) : json({ error: "Not found" }, 404);
    }
    if (req.method === "DELETE") return (await deleteSaved(id)) ? json({ deleted: true }) : json({ error: "Not found" }, 404);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return fail(error, json);
  }
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AthenaInputError("Send JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AthenaInputError("Send a JSON object");
  return body as Record<string, unknown>;
}

/** /api/saved/:id/actions[/:action|/undo]. */
async function handleActions(req: Request, id: string, segments: string[], json: Json): Promise<Response> {
  const action = segments[4];
  if (segments.length === 4) {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const item = await getSaved(id);
    if (!item) return json({ error: "Not found" }, 404);
    return json({ actions: actionsFor(item), filed: item.filed ?? null, links: await savedLinks(id) });
  }
  if (segments.length !== 5 || !action) return json({ error: "Not found" }, 404);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await bodyOf(req);
  if (action === "undo") {
    const item = await undoSavedAction(id, body.undo);
    return item ? json({ item }) : json({ error: "Not found" }, 404);
  }
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
  const { item, result } = await runSavedAction(id, action, params);
  return json({ item, result });
}
