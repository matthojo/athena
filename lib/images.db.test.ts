// Pictures in Ask on the real path (lib/images.ts, make_image in lib/answer.ts): Postgres with every migration,
// the real file store code on an in-memory blob store, a scripted model, and a stand-in for the gateway.
//  1. Gemini makes a picture: offered, its step carries the file id, kept sealed in the conversation, in the
//     reply, logged in What Ask did with Undo; a follow-up changes it (the picture goes to Gemini).
//  2. OpenAI makes one; asked to change one, it says plainly it can't, and nothing is sent.
//  3. Undo archives the picture (owner, 17 Nov 2026): restored it's back in the conversation; deleted for good it
//     goes, unless a note has it; an archived one can't be changed.
//  4. Pictures off: no tool, and asking for one says where to turn them on.
//  5. Only in chats: an assistant's chat has it; a check, a routine and a careful retry don't.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/images.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Anthropic } from "./ai";
import type { AnswerDeps } from "./answer";
import type { Step } from "./steps";
import type { ModelRef } from "./model-types";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const NOW = new Date("2026-11-17T10:00:00Z");
const opts = { now: NOW, tz: "Europe/London" };
const GEMINI: ModelRef = { provider: "gemini", model: "gemini-3-pro-image-preview" };
const OPENAI: ModelRef = { provider: "openai", model: "gpt-image-2" };

type Block = Record<string, unknown>;
type Params = Anthropic.MessageCreateParamsNonStreaming;
const NO_ASK = { question: "", options: [], more: [] };
const answer = (input: Record<string, unknown>): Block => ({ type: "tool_use", id: "done", name: "answer", input: { found: true, general: false, from_today: false, sources: [], next: [], ask: NO_ASK, ...input } });
const call = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });

function scripted(replies: Block[][]) {
  const sent: Params[] = [];
  const client = {
    messages: {
      async create(params: Params): Promise<Anthropic.Message> {
        sent.push(JSON.parse(JSON.stringify(params)) as Params);
        const content = replies[Math.min(sent.length - 1, replies.length - 1)];
        return { id: `m${sent.length}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  const tools = (i: number) => (sent[i].tools ?? []) as unknown as Array<{ name: string; input_schema: { properties: Record<string, unknown> } }>;
  const results = (i: number) =>
    sent[i].messages.flatMap((m) => (typeof m.content === "string" ? [] : (m.content as unknown as Block[]).filter((b) => b.type === "tool_result").map((b) => ({ text: String(b.content), is_error: b.is_error === true }))));
  return { client, sent, tools, results };
}

const noAccounts: AnswerDeps["sources"] = { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) };
const deps = (client: Anthropic): AnswerDeps => ({ client, sources: noAccounts, web: async () => false, mentions: async () => ({ found: [], missing: [] }) });

/** What the gateway was sent, and a picture back. */
let gateway: Array<{ url: string; body: Record<string, unknown> }> = [];
const blobs = new Map<string, unknown>();

async function png(): Promise<string> {
  return (await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 30, g: 80, b: 160 } } }).png().toBuffer()).toString("base64");
}

async function pictures(on: ModelRef | null) {
  const { DEFAULT_MODELS } = await import("./model-types");
  DEFAULT_MODELS.image = on;
}

before(async () => {
  if (!url) return;
  process.env.GEMINI_API_KEY = "k";
  process.env.GOOGLE_GEMINI_BASE_URL = "https://gateway.test/gemini";
  process.env.OPENAI_API_KEY = "k";
  process.env.OPENAI_BASE_URL = "https://gateway.test/openai";
  const { useFileStore } = await import("./files");
  useFileStore(() => ({ set: async (k: string, v: unknown) => void blobs.set(k, v), get: async (k: string) => blobs.get(k) ?? null, delete: async (k: string) => void blobs.delete(k) }) as never);
  const { useImageFetch } = await import("./images");
  const data = await png();
  useImageFetch((async (u: string, init: RequestInit) => {
    gateway.push({ url: String(u), body: JSON.parse(String(init.body)) });
    const body = String(u).includes("generateContent") ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data } }] }, finishReason: "STOP" }] } : { data: [{ b64_json: data }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
});
beforeEach(() => {
  gateway = [];
});
after(async () => {
  await pictures(null);
});

test("Gemini makes a picture: shown in the reply, kept sealed in the conversation, logged with Undo; a follow-up changes it", { skip }, async () => {
  await pictures(GEMINI);
  const { runAsk } = await import("./answer");
  const { qRaw } = await import("./db");
  const { readFile } = await import("./files");
  const thread = randomUUID();
  const steps: Step[] = [];
  const m = scripted([
    [call("p1", "make_image", { prompt: "A red lighthouse on a cliff at dusk, soft watercolour", alt: "A red lighthouse on a cliff at dusk, in watercolour." })],
    [answer({ text: "Here's your lighthouse." })],
  ]);
  const reply = await runAsk("Draw me a lighthouse at dusk in watercolour", deps(m.client), { ...opts, thread_id: thread, onStep: (s) => steps.push(s) });
  const tool = m.tools(0).find((t) => t.name === "make_image");
  assert.ok(tool, "offered while there's a picture model");
  assert.ok("from" in tool.input_schema.properties, "a Gemini model can change pictures");
  assert.match(String(m.sent[0].system), /you can make a picture with make_image/);

  assert.equal(gateway.length, 1);
  assert.match(gateway[0].url, /gemini-3-pro-image-preview:generateContent$/);
  assert.equal(reply.pictures?.length, 1);
  const pic = reply.pictures![0];
  assert.equal(pic.alt, "A red lighthouse on a cliff at dusk, in watercolour.");
  assert.deepEqual(pic.ref, GEMINI);
  assert.equal(pic.file.type, "image/png");
  assert.equal(pic.file.has_thumb, true);
  assert.equal(pic.file.name, "A red lighthouse on a cliff at dusk.png");
  assert.equal(reply.text, "Here's your lighthouse.");
  assert.deepEqual(reply.model, { provider: "anthropic", model: "claude-sonnet-5-5" }, "the reply says which model wrote it");

  // Its step carries the file's id, from "Making a picture" to "Made a picture".
  const mine = steps.filter((s) => s.id === `picture:${pic.file.id}`);
  assert.deepEqual(mine.map((s) => [s.text, s.done]), [["Making a picture", false], ["Made a picture", true]]);

  // Kept like a photo the owner added: in the conversation, sealed, with the prompt as its summary.
  const [link] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM thread_files WHERE thread_id = $1 AND file_id = $2`, [thread, pic.file.id]);
  assert.equal(link.n, 1);
  const [row] = await qRaw<{ name: string; summary: string }>(`SELECT name, summary FROM files WHERE id = $1`, [pic.file.id]);
  assert.doesNotMatch(row.name, /lighthouse/, "the name is sealed");
  assert.doesNotMatch(row.summary, /lighthouse/, "the summary is sealed");
  assert.match(pic.file.summary ?? "", /^A picture made with Gemini 3 Pro Image\. Asked for: A red lighthouse/);
  assert.equal((await readFile(pic.file.id))?.bytes.subarray(1, 4).toString(), "PNG");

  // A change, in What Ask did, with Undo.
  assert.equal(reply.changes?.length, 1);
  const change = reply.changes![0];
  assert.equal(change.kind, "picture");
  assert.equal(change.detail, "Made with Gemini 3 Pro Image");
  assert.deepEqual(change.undo, { op: "remove_picture", file_id: pic.file.id, thread_id: thread });
  assert.ok(change.activity_id, "logged");

  // A follow-up: the picture comes as its summary, and changing it sends it to Gemini.
  gateway = [];
  const m2 = scripted([[call("p2", "make_image", { prompt: "The same lighthouse, at night with stars", alt: "The lighthouse at night.", from: [pic.file.id] })], [answer({ text: "Now at night." })]]);
  const two = await runAsk("Make it night time", deps(m2.client), { ...opts, thread_id: thread, earlier: [pic.file.id], history: [{ role: "user", text: "Draw me a lighthouse" }, { role: "assistant", text: "Here's your lighthouse." }] });
  const first = JSON.stringify(m2.sent[0].messages);
  assert.match(first, /A picture made with Gemini 3 Pro Image/, "the earlier picture is there as its summary");
  assert.equal(gateway.length, 1);
  const parts = (gateway[0].body as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal((parts[0].inline_data as { mime_type: string }).mime_type, "image/png");
  assert.deepEqual(parts[1], { text: "The same lighthouse, at night with stars" });
  assert.equal(two.pictures?.[0].from?.[0], pic.file.id);
  assert.equal(two.changes?.[0].detail, "Changed with Gemini 3 Pro Image");

  // A picture not in this conversation can't be changed.
  const m3 = scripted([[call("p3", "make_image", { prompt: "x", alt: "x", from: [randomUUID()] })], [answer({ text: "I couldn't." })]]);
  await runAsk("Change that one", deps(m3.client), { ...opts, thread_id: thread });
  assert.match(m3.results(1)[0].text, /isn't in this conversation/);
  assert.equal(gateway.length, 1, "nothing more sent");
});

test("OpenAI makes a picture; asked to change one, it says plainly it can't and sends nothing", { skip }, async () => {
  await pictures(OPENAI);
  const { runAsk } = await import("./answer");
  const thread = randomUUID();
  const m = scripted([[call("p1", "make_image", { prompt: "A fox in the snow", alt: "A fox in snow.", shape: "landscape" })], [answer({ text: "A fox for you." })]]);
  const reply = await runAsk("Make a picture of a fox in the snow", deps(m.client), { ...opts, thread_id: thread });
  const tool = m.tools(0).find((t) => t.name === "make_image")!;
  assert.ok(!("from" in tool.input_schema.properties), "no pictures in for OpenAI");
  assert.equal(gateway[0].url, "https://gateway.test/openai/v1/images/generations");
  assert.deepEqual(gateway[0].body, { model: "gpt-image-2", prompt: "A fox in the snow", n: 1, size: "1536x1024" });
  assert.equal(reply.pictures?.[0].ref.provider, "openai");
  assert.equal(reply.changes?.[0].detail, "Made with GPT Image 2");

  gateway = [];
  const id = reply.pictures![0].file.id;
  const m2 = scripted([[call("p2", "make_image", { prompt: "Make the fox red", alt: "x", from: [id] })], [answer({ text: "I can't change pictures with this model." })]]);
  const two = await runAsk("Make the fox red", deps(m2.client), { ...opts, thread_id: thread, earlier: [id] });
  assert.match(m2.results(1)[0].text, /^Not made: OpenAI's picture models can only make new pictures, not change one\./);
  assert.equal(gateway.length, 0);
  assert.equal(two.pictures, undefined);
});

test("Undo archives the picture: out of the conversation, on Archived; restored it's back; deleted for good it goes, unless a note has it", { skip }, async () => {
  await pictures(GEMINI);
  const { runAsk } = await import("./answer");
  const { applyUndo } = await import("./assistant");
  const { createNote, qRaw } = await import("./db");
  const { archivedInThread, deletePictureForGood, listArchivedPictures, makeImage, restorePicture } = await import("./images");
  const { attachToNote, getFileMeta, listNoteFiles } = await import("./files");
  const thread = randomUUID();
  const make = async () => {
    const m = scripted([[call("p", "make_image", { prompt: "A teapot", alt: "A teapot." })], [answer({ text: "Here." })]]);
    return runAsk("Draw a teapot", deps(m.client), { ...opts, thread_id: thread });
  };
  const link = async (id: string) => (await qRaw<{ archived_at: Date | null }>(`SELECT archived_at FROM thread_files WHERE thread_id = $1 AND file_id = $2`, [thread, id]))[0];

  // Undo: archived, nothing deleted.
  const one = await make();
  const id = one.pictures![0].file.id;
  await applyUndo(one.changes![0].undo);
  assert.ok(await getFileMeta(id), "kept");
  assert.ok(blobs.has(id) && blobs.has(`${id}-thumb`), "with its bytes");
  assert.ok((await link(id))?.archived_at, "out of the conversation");
  const listed = (await listArchivedPictures()).find((p) => p.file.id === id);
  assert.ok(listed, "on the Archived page");
  assert.equal(listed.thread_id, thread);
  assert.equal(listed.on_notes, 0);
  assert.equal(listed.file.name, one.pictures![0].file.name);
  // Undo again is the same: still archived, no error.
  await applyUndo(one.changes![0].undo);
  // Archived, it can't be changed.
  await assert.rejects(makeImage({ prompt: "Make it blue", from: [id], ref: GEMINI, threadId: thread }), /archived/i);
  assert.deepEqual([...(await archivedInThread(thread, [id]))], [id]);

  // Restored: back in the conversation, off the Archived page.
  assert.equal(await restorePicture(thread, id), true);
  assert.equal((await link(id))?.archived_at, null);
  assert.equal((await listArchivedPictures()).some((p) => p.file.id === id), false);
  assert.equal(await restorePicture(thread, id), false, "only an archived one restores");
  assert.equal(await deletePictureForGood(thread, id), false, "only an archived one is deleted for good");
  assert.ok(await getFileMeta(id));

  // Deleted for good: the file and its bytes go.
  await applyUndo(one.changes![0].undo);
  assert.equal(await deletePictureForGood(thread, id), true);
  assert.equal(await getFileMeta(id), null, "gone");
  assert.equal(blobs.has(id), false, "and its bytes");
  assert.equal(blobs.has(`${id}-thumb`), false);
  assert.equal(await link(id), undefined);
  // Undo on a picture that's gone is refused (the app hides Undo).
  await assert.rejects(applyUndo(one.changes![0].undo), (e: Error & { status?: number }) => e.status === 404);

  // One on a note: archived out of the conversation, the note keeps it; deleted for good, the note still does.
  const two = await make();
  const kept = two.pictures![0].file.id;
  const note = await createNote({ title: "Teapots", body: "", type: "note", tags: [], source: "manual" });
  assert.equal(await attachToNote(note.id, kept), true);
  await applyUndo(two.changes![0].undo);
  assert.equal((await listArchivedPictures()).find((p) => p.file.id === kept)?.on_notes, 1);
  assert.equal(await deletePictureForGood(thread, kept), false, "the file stays");
  assert.ok(await getFileMeta(kept), "the note keeps it");
  assert.deepEqual((await listNoteFiles(note.id)).map((f) => f.id), [kept]);
  assert.equal(await link(kept), undefined, "out of the conversation for good");
});

test("pictures off: no tool, and asking for one says where to turn them on", { skip }, async () => {
  await pictures(null);
  const { runAsk } = await import("./answer");
  const { PICTURE_SETTING, PICTURES_OFF_TEXT } = await import("./images");
  const m = scripted([[answer({ text: "I'd love to draw that.", found: false, needs_picture: true })]]);
  const reply = await runAsk("Draw me a lighthouse", deps(m.client), { ...opts, thread_id: randomUUID() });
  assert.ok(!m.tools(0).some((t) => t.name === "make_image"));
  const answerTool = m.tools(0).find((t) => t.name === "answer")!;
  assert.ok("needs_picture" in answerTool.input_schema.properties);
  assert.match(String(m.sent[0].system), /Pictures are off/);
  assert.equal(reply.text, PICTURES_OFF_TEXT);
  assert.deepEqual(reply.setting, PICTURE_SETTING);
  assert.equal(gateway.length, 0);

  // A message that isn't about pictures is answered as ever.
  const m2 = scripted([[answer({ text: "It's 4pm.", found: false, general: true })]]);
  const plain = await runAsk("What time is tea?", deps(m2.client), { ...opts, thread_id: randomUUID() });
  assert.equal(plain.setting, undefined);
  assert.equal(plain.text, "It's 4pm.");
  // Every reply says which model wrote it: the deploy's override is named too.
  process.env.ATHENA_ANSWER_MODEL = "claude-opus-5-5";
  try {
    const m3 = scripted([[answer({ text: "Tea at four.", found: false, general: true })]]);
    const named = await runAsk("When is tea?", deps(m3.client), { ...opts, thread_id: randomUUID() });
    assert.deepEqual(named.model, { provider: "anthropic", model: "claude-opus-5-5" });
  } finally {
    delete process.env.ATHENA_ANSWER_MODEL;
  }
});

test("only in chats: an assistant's chat has it; a check, a routine and a careful retry don't", { skip }, async () => {
  await pictures(GEMINI);
  const { runAsk } = await import("./answer");
  const offered = async (more: Record<string, unknown>) => {
    const m = scripted([[answer({ text: "ok", found: false, general: true })]]);
    await runAsk("Draw a cat", deps(m.client), { ...opts, thread_id: randomUUID(), ...more });
    return m.tools(0).some((t) => t.name === "make_image");
  };
  const persona = { id: randomUUID(), name: "Penny", prompt: "You are Penny.", allow: [], readOnly: false, planRule: "" };
  assert.equal(await offered({}), true, "Ask");
  assert.equal(await offered({ persona }), true, "an assistant's chat");
  assert.equal(await offered({ persona: { ...persona, readOnly: true } }), false, "a check");
  assert.equal(await offered({ plan: "propose" }), false, "a routine or a run");
  assert.equal(await offered({ careful: true }), false, "a careful retry");
  assert.equal(await offered({ thread_id: null }), false, "no conversation to keep it in");
});
