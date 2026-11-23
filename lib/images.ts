/**
 * Pictures in Ask and assistant chats (docs/ai-models.md, "Pictures"; owner, 17 Nov 2026): a picture model
 * makes a picture, or changes one from the conversation, and it's kept as a file like a photo the owner added
 * (lib/files.ts saveFile), linked to the conversation, so it can go on a note.
 *
 * - Gemini image models through `generateContent`: a prompt makes one; a prompt with pictures changes them.
 * - OpenAI `gpt-image-*` through `/v1/images/generations`: making only. Its edit endpoint takes multipart
 *   uploads and the gateway refuses multipart, so changing a picture needs a Gemini model. Asked to, it says so.
 *
 * Each call uses the gateway's injected variables (GEMINI_API_KEY with GOOGLE_GEMINI_BASE_URL, OPENAI_API_KEY with
 * OPENAI_BASE_URL), or the owner's own key with the provider's own address (lib/llm/shared.ts credentials), with a
 * JSON body. One picture per call, at most MAX_FROM pictures in,
 * the prompt capped, and the result kept under the file store's 4 MB. Neither the prompt nor the provider's
 * reply is logged: only the status.
 *
 * The `make_image` tool (lib/answer.ts runs it) is a change: logged in What Ask did, and Undo archives the picture
 * (owner, 17 Nov 2026): it leaves the conversation and waits on the Archived page, to be restored or deleted for good.
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { AthenaInputError, q, sealer } from "./db";
import { MAX_FILE_BYTES, MAX_THUMB_BYTES, deleteFilesForGood, getFileMeta, isUuid, readFile, saveFile, type FileMeta } from "./files";
import { credentials } from "./llm/shared";
import { companyOf, modelLabel } from "./model-label";
import type { ModelRef } from "./model-types";
import { CANT_CHANGE, PICTURE_SETTING, PICTURES_OFF_TEXT } from "./picture-words";
import { checkBudget, recordUsage, spendScope, withSpendScope } from "./spend";

export { CANT_CHANGE, PICTURE_SETTING, PICTURES_OFF_TEXT };

// ---------- Limits ----------

/** Words in a prompt: more than any picture needs, well under both providers' limits. */
export const MAX_PROMPT_CHARS = 2_000;
/** Pictures sent in to be changed or combined. */
export const MAX_FROM = 3;
/** One picture per call: a reply that wants two calls twice. */
export const PICTURES_PER_CALL = 1;
/** The longest edge kept, as for a photo the owner adds (app/src/components/attachments.ts). */
export const MAX_EDGE = 2576;
/** The small preview's longest edge. */
export const THUMB_EDGE = 480;
/** How long one provider call may take. */
export const IMAGE_TIMEOUT_MS = 90_000;

export const SHAPES = ["square", "portrait", "landscape"] as const;
export type Shape = (typeof SHAPES)[number];

const GEMINI_RATIO: Record<Shape, string> = { square: "1:1", portrait: "3:4", landscape: "4:3" };
const OPENAI_SIZE: Record<Shape, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };

// ---------- Errors, in the owner's words ----------

/** A picture that couldn't be made. `message` is what the owner reads; `status` what the API answers with. */
export class PictureError extends Error {
  constructor(
    message: string,
    public status = 502,
    /** Why, for the logs and tests: never shown. */
    public code: "unavailable" | "cant_change" | "refused" | "busy" | "slow" | "failed" | "not_found" | "not_a_picture" | "unsupported" | "archived" = "failed",
  ) {
    super(message);
  }
}


const unavailable = (ref: ModelRef) => new PictureError(`Pictures from ${companyOf(ref)} aren't set up on this copy of Athena.`, 503, "unavailable");

// ---------- Seams for tests ----------

let fetchImpl: typeof fetch = (...args) => fetch(...args);
/** Replace the network for tests: every provider call goes through this. */
export function useImageFetch(f: typeof fetch): void {
  fetchImpl = f;
}

// ---------- Making one ----------

export interface MakeImageInput {
  prompt: string;
  /** Files to change, from this conversation (lib/files.ts ids). */
  from?: string[];
  ref: ModelRef;
  /** The conversation it's kept in. */
  threadId?: string;
  shape?: Shape;
  /** The file's id, chosen ahead so the app can show the picture by it as soon as it's made. */
  id?: string;
  /** When the turn has to have answered by. */
  deadline?: number;
}

export interface MadeImage {
  file: FileMeta;
  ref: ModelRef;
}

/** Can this model make pictures here, as far as the code knows? Gemini's image models and OpenAI's gpt-image. */
export function makesPictures(ref: ModelRef): boolean {
  return (ref.provider === "gemini" && /image/i.test(ref.model)) || (ref.provider === "openai" && /^gpt-image/i.test(ref.model));
}

/** Can it change a picture (pictures in)? Only through generateContent. */
export const changesPictures = (ref: ModelRef): boolean => ref.provider === "gemini";

/** Make a picture (or change `from`), keep it as a file in the conversation, and say which model made it. */
export async function makeImage(input: MakeImageInput): Promise<MadeImage> {
  const prompt = input.prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) throw new PictureError("Say what the picture should show.", 400, "failed");
  const from = [...new Set(input.from ?? [])];
  if (from.length > MAX_FROM) throw new PictureError(`I can change up to ${MAX_FROM} pictures at once.`, 400, "failed");
  if (from.length && !changesPictures(input.ref)) throw new PictureError(CANT_CHANGE, 400, "cant_change");
  if (!makesPictures(input.ref) && input.ref.provider !== "gemini") throw new PictureError(`${modelLabel(input.ref)} doesn't make pictures. Choose a picture model in Settings, AI models.`, 400, "unsupported");
  const shape: Shape = input.shape && SHAPES.includes(input.shape) ? input.shape : "square";
  const timeout = Math.max(5_000, Math.min(IMAGE_TIMEOUT_MS, (input.deadline ?? Infinity) - Date.now() - 5_000));

  if (!input.threadId || !isUuid(input.threadId)) throw new AthenaInputError("A picture is kept in a conversation");
  if ((await archivedInThread(input.threadId, from)).size) throw new PictureError("That picture is archived. Restore it from Archived to change it.", 400, "archived");
  const sources = await Promise.all(from.map(readSource));
  // AI spend (lib/spend.ts): nothing is made once today's budget is used, and each picture counts as one at the
  // model's published per-picture price, under Pictures (the assistant's id is kept, so its cap counts it too).
  await checkBudget();
  const kept = await fetchPicture(input.ref, prompt, sources, shape, timeout);
  await withSpendScope({ ...spendScope(), area: "pictures" }, () => recordUsage({ provider: input.ref.provider, model: input.ref.model, images: 1 }));
  const id = input.id && isUuid(input.id) ? input.id : randomUUID();
  const file = await saveFile({ id, name: pictureName(prompt, kept.type), type: kept.type, bytes: kept.bytes, thumb: kept.thumb, width: kept.width, height: kept.height, link: { thread: input.threadId } });
  // What it shows, for follow-ups: the prompt stands in for the summary a photo gets, so no model call reads it back.
  const summary = `A picture made with ${modelLabel(input.ref)}${from.length ? `, changed from ${from.length === 1 ? "an earlier picture" : `${from.length} earlier pictures`}` : ""}. Asked for: ${prompt}`.slice(0, 1_200);
  const s = await sealer();
  await q(`UPDATE files SET summary = $2 WHERE id = $1 AND summary IS NULL`, [file.id, s.text(summary)]);
  return { file: { ...file, summary }, ref: input.ref };
}

/** One provider call, and what came back fitted for the file store. Exported for tests (the request as it's sent). */
export async function fetchPicture(ref: ModelRef, prompt: string, sources: Array<{ type: string; data: string }>, shape: Shape, timeout = IMAGE_TIMEOUT_MS): Promise<Fitted> {
  const out = ref.provider === "gemini" ? await gemini(ref, prompt, sources, shape, timeout) : await openai(ref, prompt, shape, timeout);
  return fitForFiles(out);
}

/** A picture to change: one the conversation has, and a picture. */
async function readSource(id: string): Promise<{ type: string; data: string }> {
  if (!isUuid(id)) throw new PictureError("That picture isn't in this conversation.", 404, "not_found");
  const meta = await getFileMeta(id);
  if (!meta) throw new PictureError("That picture isn't in this conversation.", 404, "not_found");
  if (!meta.type.startsWith("image/")) throw new PictureError(`Only pictures can be changed, and ${meta.name} isn't one.`, 400, "not_a_picture");
  const file = await readFile(id);
  if (!file) throw new PictureError("That picture couldn't be opened.", 404, "not_found");
  return { type: meta.type, data: file.bytes.toString("base64") };
}

const SMALL = new Set(["a", "an", "the", "at", "on", "in", "of", "with", "and", "or", "for", "to", "by", "from", "into", "over", "under"]);

/** "Lighthouse at dusk in watercolour.png": the prompt's first words, as the file's name. */
export function pictureName(prompt: string, type: string): string {
  // The first clause, up to eight words, never ending on a small word ("…on a cliff at").
  const clause = prompt.split(/[,.;:!?(\n]/)[0];
  const list = clause.replace(/[^\p{L}\p{N}' -]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 8);
  while (list.length > 1 && SMALL.has(list[list.length - 1].toLowerCase())) list.pop();
  const words = list.join(" ").slice(0, 60).trim();
  const base = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Picture";
  return `${base}.${type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png"}`;
}

interface Raw {
  bytes: Buffer;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

async function gemini(ref: ModelRef, prompt: string, sources: Array<{ type: string; data: string }>, shape: Shape, timeout: number): Promise<Raw> {
  const c = credentials("gemini");
  if (!c) throw unavailable(ref);
  const { key, base } = c;
  const res = await call(ref, `${base.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(ref.model)}:generateContent`, { "x-goog-api-key": key }, {
    contents: [{ role: "user", parts: [...sources.map((s) => ({ inline_data: { mime_type: s.type, data: s.data } })), { text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"], candidateCount: PICTURES_PER_CALL, imageConfig: { aspectRatio: GEMINI_RATIO[shape] } },
  }, timeout);
  const json = (await res.json().catch(() => ({}))) as GeminiResponse;
  if (json.promptFeedback?.blockReason) throw refused(ref);
  const candidate = json.candidates?.[0];
  const part = candidate?.content?.parts?.find((p) => p.inlineData?.data || p.inline_data?.data);
  const data = part?.inlineData?.data ?? part?.inline_data?.data;
  if (!data) {
    console.warn(`Athena pictures: ${ref.model} sent no picture (finishReason ${candidate?.finishReason ?? "none"})`);
    if (candidate?.finishReason && /SAFETY|PROHIBITED|BLOCK|RECITATION|IMAGE_OTHER/i.test(candidate.finishReason)) throw refused(ref);
    throw new PictureError(`${modelLabel(ref)} didn't send a picture back. Try asking again, or describe it differently.`, 502, "failed");
  }
  return { bytes: Buffer.from(data, "base64") };
}

async function openai(ref: ModelRef, prompt: string, shape: Shape, timeout: number): Promise<Raw> {
  const c = credentials("openai");
  if (!c) throw unavailable(ref);
  const { key, base } = c;
  const root = base.replace(/\/$/, "");
  const url = `${/\/v1$/.test(root) ? root : `${root}/v1`}/images/generations`;
  const res = await call(ref, url, { Authorization: `Bearer ${key}` }, { model: ref.model, prompt, n: PICTURES_PER_CALL, size: OPENAI_SIZE[shape] }, timeout);
  const json = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }> };
  const data = json.data?.[0]?.b64_json;
  if (!data) throw new PictureError(`${modelLabel(ref)} didn't send a picture back. Try asking again.`, 502, "failed");
  return { bytes: Buffer.from(data, "base64") };
}

const refused = (ref: ModelRef) => new PictureError(`${companyOf(ref)} wouldn't make that picture. Try describing it differently.`, 422, "refused");

/** One JSON POST. A failure is said in the owner's words; only the status is logged (the body can echo the prompt). */
async function call(ref: ModelRef, url: string, auth: Record<string, string>, body: unknown, timeout: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new PictureError("That picture took too long. Try again, or ask for something simpler.", 504, "slow");
    throw new PictureError(`${companyOf(ref)} couldn't be reached. Try again in a moment.`, 502, "failed");
  }
  if (res.ok) return res;
  console.error(`Athena pictures: ${ref.provider}/${ref.model} returned ${res.status}`);
  if (res.status === 429) throw new PictureError(`${companyOf(ref)} is busy. Try again in a minute.`, 429, "busy");
  // A refusal on content comes back as a 400 with a safety code; anything else 4xx is ours to say plainly.
  const text = await res.text().catch(() => "");
  if (res.status === 400 && /safety|moderation|content[_ ]policy|blocked/i.test(text)) throw refused(ref);
  if (res.status === 404) throw new PictureError(`${modelLabel(ref)} isn't available any more. Choose another picture model in Settings, AI models.`, 502, "unavailable");
  if (res.status === 401 || res.status === 403) throw unavailable(ref);
  throw new PictureError(`${modelLabel(ref)} couldn't make that picture just now. Try again.`, 502, "failed");
}

/** Within the file store's limits: the longest edge at most MAX_EDGE, under 4 MB (PNG kept when it fits, else JPEG), and a small preview. */
export interface Fitted {
  bytes: Buffer;
  type: "image/png" | "image/jpeg" | "image/webp";
  thumb: Buffer | null;
  width: number;
  height: number;
}

async function fitForFiles(raw: Raw): Promise<Fitted> {
  let img;
  try {
    img = sharp(raw.bytes, { limitInputPixels: 64_000_000 });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format ?? "")) throw new Error("not a picture");
    const big = Math.max(meta.width, meta.height) > MAX_EDGE;
    let bytes = raw.bytes;
    let type: "image/png" | "image/jpeg" | "image/webp" = meta.format === "jpeg" ? "image/jpeg" : meta.format === "webp" ? "image/webp" : "image/png";
    if (big || bytes.byteLength > MAX_FILE_BYTES) {
      const resized = sharp(raw.bytes).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true });
      bytes = type === "image/png" ? await resized.clone().png({ compressionLevel: 9 }).toBuffer() : await resized.clone().jpeg({ quality: 90 }).toBuffer();
      if (bytes.byteLength > MAX_FILE_BYTES) {
        bytes = await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        type = "image/jpeg";
      }
    }
    const out = await sharp(bytes).metadata();
    let thumb: Buffer | null = await sharp(bytes).resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    if (thumb.byteLength > MAX_THUMB_BYTES) thumb = null;
    return { bytes, type, thumb, width: out.width ?? meta.width, height: out.height ?? meta.height };
  } catch {
    throw new PictureError("The picture that came back couldn't be opened. Try again.", 502, "failed");
  }
}

// ---------- The tool ----------

export const MAKE_IMAGE_TOOL_NAME = "make_image";

/** Offered only when this turn has a picture model (lib/models.ts resolveImageModel). `canChange`: the model takes pictures in. */
export function makeImageTool(opts: { canChange: boolean }): Anthropic.Tool {
  return {
    name: MAKE_IMAGE_TOOL_NAME,
    description: opts.canChange
      ? "Make a picture for the owner, or change one: a photo they shared here or a picture you made earlier in this conversation (give its file_id in from). Use it only when they ask for a picture, drawing, illustration or a change to one. Write the prompt as a full description of the picture: subject, setting, style, light, colours, and what to keep the same when changing one. The picture is kept in the conversation and shown with your reply; say in a short sentence what you made. Don't describe it at length: they can see it."
      : "Make a new picture for the owner. Use it only when they ask for a picture, drawing or illustration. Write the prompt as a full description: subject, setting, style, light and colours. This model can't change an existing picture: if they ask you to change one, don't call this; tell them that changing pictures needs a Gemini picture model, chosen in Settings, AI models. The picture is kept in the conversation and shown with your reply; say in a short sentence what you made.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: { type: "string", description: "What the picture shows, in full." },
        alt: { type: "string", description: "One short sentence describing the finished picture for someone who can't see it, e.g. “A red lighthouse on a cliff at dusk, in soft watercolour.”" },
        shape: { type: "string", enum: [...SHAPES], description: "square unless the owner asks for tall (portrait) or wide (landscape)." },
        ...(opts.canChange ? { from: { type: "array", items: { type: "string" }, description: "file_ids of pictures to change or combine, from this conversation. Leave out to make a new one." } } : {}),
      },
      required: ["prompt", "alt"],
    },
  };
}

/** A picture in a reply: the file, what it shows, and which model made it. The app shows it in the reply's bubble. */
export interface MadePicture {
  file: FileMeta;
  /** For screen readers: what the picture shows. */
  alt: string;
  prompt: string;
  ref: ModelRef;
  /** Changed from these pictures. */
  from?: string[];
}

/** The tool's input, checked: what the model may ask for. */
export function parseMakeImage(raw: unknown): { prompt: string; alt: string; shape: Shape; from: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (!prompt) throw new PictureError("Give the prompt: what the picture shows.", 400);
  const alt = (typeof r.alt === "string" && r.alt.trim() ? r.alt : prompt).replace(/\s+/g, " ").trim().slice(0, 300);
  const shape = SHAPES.includes(r.shape as Shape) ? (r.shape as Shape) : "square";
  const from = Array.isArray(r.from) ? r.from.filter((x): x is string => typeof x === "string").slice(0, MAX_FROM + 1) : [];
  return { prompt: prompt.slice(0, MAX_PROMPT_CHARS), alt, shape, from };
}

/** Undo of a made picture: archived, like everything else (owner, 17 Nov 2026). It leaves the conversation and waits on the Archived page. */
export interface PictureUndo {
  op: "remove_picture";
  file_id: string;
  thread_id: string;
}

export const isPictureUndo = (raw: unknown): raw is PictureUndo => (raw as PictureUndo | null)?.op === "remove_picture";

/** Undo: the conversation's link to the picture is archived. Nothing is deleted; a note that has it keeps it. */
export async function applyPictureUndo(raw: PictureUndo): Promise<void> {
  if (!isUuid(raw.file_id) || !isUuid(raw.thread_id)) throw new AthenaInputError("Invalid undo");
  const rows = await q<{ file_id: string }>(
    `UPDATE thread_files SET archived_at = COALESCE(archived_at, now()) WHERE thread_id = $1 AND file_id = $2 RETURNING file_id`,
    [raw.thread_id, raw.file_id],
  );
  if (!rows.length) throw new AthenaInputError("That picture isn't in this conversation any more", 404);
}

/** An archived picture, for the Archived page: the file, the conversation it was in, and how many notes have it. */
export interface ArchivedPicture {
  file: FileMeta;
  thread_id: string;
  archived_at: string;
  on_notes: number;
}

/** Archived pictures, most recently archived first. */
export async function listArchivedPictures(limit = 100): Promise<ArchivedPicture[]> {
  const rows = await q<{ file_id: string; thread_id: string; archived_at: Date | string; on_notes: number }>(
    `SELECT tf.file_id, tf.thread_id, tf.archived_at, (SELECT count(*)::int FROM note_files nf WHERE nf.file_id = tf.file_id) AS on_notes
       FROM thread_files tf WHERE tf.archived_at IS NOT NULL ORDER BY tf.archived_at DESC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  const out: ArchivedPicture[] = [];
  for (const r of rows) {
    const file = await getFileMeta(r.file_id);
    if (file) out.push({ file, thread_id: r.thread_id, archived_at: new Date(r.archived_at).toISOString(), on_notes: r.on_notes });
  }
  return out;
}

/** Restore: back in the conversation. False if it isn't archived there. */
export async function restorePicture(rawThreadId: unknown, rawFileId: unknown): Promise<boolean> {
  if (!isUuid(rawThreadId) || !isUuid(rawFileId)) throw new AthenaInputError("Invalid picture");
  const rows = await q<{ file_id: string }>(`UPDATE thread_files SET archived_at = NULL WHERE thread_id = $1 AND file_id = $2 AND archived_at IS NOT NULL RETURNING file_id`, [rawThreadId, rawFileId]);
  return rows.length > 0;
}

/**
 * Delete for good, from the Archived page (the app only, SECURITY.md §7): out of the conversation, and the file
 * and its bytes go unless a note or another conversation still has it. True when the file itself was deleted.
 */
export async function deletePictureForGood(rawThreadId: unknown, rawFileId: unknown): Promise<boolean> {
  if (!isUuid(rawThreadId) || !isUuid(rawFileId)) throw new AthenaInputError("Invalid picture");
  const gone = await q<{ file_id: string }>(`DELETE FROM thread_files WHERE thread_id = $1 AND file_id = $2 AND archived_at IS NOT NULL RETURNING file_id`, [rawThreadId, rawFileId]);
  if (!gone.length) return false;
  const [held] = await q<{ n: number }>(
    `SELECT ((SELECT count(*) FROM note_files WHERE file_id = $1) + (SELECT count(*) FROM thread_files WHERE file_id = $1) + (SELECT count(*) FROM day_files WHERE file_id = $1))::int AS n`,
    [rawFileId],
  );
  if (held?.n) return false;
  return (await deleteFilesForGood([rawFileId])).length > 0;
}

/** Is this picture archived in this conversation? An archived one can't be changed until it's restored. */
export async function archivedInThread(threadId: string, fileIds: string[]): Promise<Set<string>> {
  if (!fileIds.length || !isUuid(threadId)) return new Set();
  const rows = await q<{ file_id: string }>(`SELECT file_id FROM thread_files WHERE thread_id = $1 AND file_id = ANY($2::uuid[]) AND archived_at IS NOT NULL`, [threadId, fileIds.filter(isUuid)]);
  return new Set(rows.map((r) => r.file_id));
}
