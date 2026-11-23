// Pictures (lib/images.ts): each provider's request as it goes to the gateway (JSON only, one picture, the shape,
// the pictures in), what comes back read and fitted, and every failure said in the owner's words. A stand-in for
// the network; no database (a made picture's saving is in lib/images.db.test.ts).
// Run: npx tsx --test lib/images.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { CANT_CHANGE, fetchPicture, MAX_FROM, MAX_PROMPT_CHARS, PictureError, changesPictures, makeImage, makeImageTool, makesPictures, parseMakeImage, pictureName, useImageFetch } from "./images";
import { familyOf, modelLabel } from "./model-label";

const GEMINI = { provider: "gemini" as const, model: "gemini-3-pro-image-preview" };
const OPENAI = { provider: "openai" as const, model: "gpt-image-2" };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];

async function png(w = 64, h = 64): Promise<string> {
  return (await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 90, b: 40 } } }).png().toBuffer()).toString("base64");
}

function answer(status: number, body: unknown) {
  useImageFetch((async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
}

beforeEach(() => {
  sent = [];
  process.env.GEMINI_API_KEY = "gw-gemini";
  process.env.GOOGLE_GEMINI_BASE_URL = "https://gateway.test/gemini/";
  process.env.OPENAI_API_KEY = "gw-openai";
  process.env.OPENAI_BASE_URL = "https://gateway.test/openai/v1";
});

const T = "7e000000-0000-4000-8000-000000000001";
/** The provider call alone (makeImage then saves it, in lib/images.db.test.ts). */
const upToSaving = (input: { prompt: string; ref: typeof GEMINI | typeof OPENAI; shape?: "square" | "portrait" | "landscape" }) =>
  fetchPicture(input.ref, input.prompt.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS), [], input.shape ?? "square");

test("Gemini: generateContent with the prompt, image out, the shape, the gateway's key, JSON", async () => {
  answer(200, { candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: await png() } }] }, finishReason: "STOP" }] });
  const got = await upToSaving({ prompt: "  A red   lighthouse at dusk ", ref: GEMINI, shape: "landscape" });
  assert.equal(got.type, "image/png");
  assert.ok(got.thumb, "with a preview");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://gateway.test/gemini/v1beta/models/gemini-3-pro-image-preview:generateContent");
  assert.equal(sent[0].headers["x-goog-api-key"], "gw-gemini");
  assert.equal(sent[0].headers["Content-Type"], "application/json");
  const body = sent[0].body as { contents: Array<{ parts: Array<{ text?: string }> }>; generationConfig: Record<string, unknown> };
  assert.deepEqual(body.contents[0].parts, [{ text: "A red lighthouse at dusk" }]);
  assert.deepEqual(body.generationConfig, { responseModalities: ["IMAGE", "TEXT"], candidateCount: 1, imageConfig: { aspectRatio: "4:3" } });
});

test("OpenAI: /v1/images/generations once (base with or without /v1), one picture, the size, a bearer key", async () => {
  answer(200, { data: [{ b64_json: await png() }] });
  await upToSaving({ prompt: "A fox in snow", ref: OPENAI, shape: "portrait" });
  assert.equal(sent[0].url, "https://gateway.test/openai/v1/images/generations");
  assert.equal(sent[0].headers.Authorization, "Bearer gw-openai");
  assert.deepEqual(sent[0].body, { model: "gpt-image-2", prompt: "A fox in snow", n: 1, size: "1024x1536" });
  process.env.OPENAI_BASE_URL = "https://gateway.test/openai";
  await upToSaving({ prompt: "A fox", ref: OPENAI });
  assert.equal(sent[1].url, "https://gateway.test/openai/v1/images/generations");
  assert.equal((sent[1].body as { size: string }).size, "1024x1024");
});

test("your own key with no gateway: the provider's own address", async () => {
  delete process.env.GOOGLE_GEMINI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  process.env.GEMINI_API_KEY = "own-gemini";
  process.env.OPENAI_API_KEY = "own-openai";
  answer(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: await png() } }] }, finishReason: "STOP" }] });
  await upToSaving({ prompt: "A red lighthouse", ref: GEMINI });
  assert.equal(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent");
  assert.equal(sent[0].headers["x-goog-api-key"], "own-gemini");
  answer(200, { data: [{ b64_json: await png() }] });
  await upToSaving({ prompt: "A fox", ref: OPENAI });
  assert.equal(sent[1].url, "https://api.openai.com/v1/images/generations");
  assert.equal(sent[1].headers.Authorization, "Bearer own-openai");
});

test("OpenAI can't change a picture: said plainly, and nothing is sent", async () => {
  answer(200, {});
  const e = await makeImage({ prompt: "Make it blue", from: ["0b0c0000-0000-4000-8000-000000000001"], ref: OPENAI, threadId: T }).catch((x: PictureError) => x);
  assert.ok(e instanceof PictureError);
  assert.equal(e.code, "cant_change");
  assert.equal(e.message, CANT_CHANGE);
  assert.match(e.message, /Gemini picture model in Settings, AI models/);
  assert.equal(sent.length, 0);
  assert.equal(changesPictures(OPENAI), false);
  assert.equal(changesPictures(GEMINI), true);
});

test("caps: the prompt, the pictures in, one per call", async () => {
  answer(200, { data: [{ b64_json: await png() }] });
  await upToSaving({ prompt: "x".repeat(MAX_PROMPT_CHARS + 500), ref: OPENAI });
  assert.equal((sent[0].body as { prompt: string }).prompt.length, MAX_PROMPT_CHARS);
  const ids = Array.from({ length: MAX_FROM + 1 }, (_, i) => `0b0c0000-0000-4000-8000-00000000000${i}`);
  const e = (await makeImage({ prompt: "Combine", from: ids, ref: GEMINI, threadId: T }).catch((x: Error) => x)) as Error;
  assert.match(e.message, /up to 3 pictures at once/);
  const parsed = parseMakeImage({ prompt: " A cat ", from: ids, shape: "tall", alt: "" });
  assert.equal(parsed.shape, "square", "an unknown shape is square");
  assert.equal(parsed.alt, "A cat", "no alt: the prompt stands in");
  assert.throws(() => parseMakeImage({ alt: "x" }), /Give the prompt/);
});

test("a big picture comes back fitted: under the long edge, with a preview", async () => {
  answer(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: await png(3000, 1500) } }] } }] });
  const got = await upToSaving({ prompt: "Wide", ref: GEMINI });
  assert.equal(got.width, 2576);
  assert.equal(got.height, 1288);
  assert.ok(got.bytes.byteLength <= 4 * 1024 * 1024);
  assert.ok(got.thumb && got.thumb.byteLength < 200 * 1024);
  // No conversation: refused before anything is sent.
  sent = [];
  const e = (await makeImage({ prompt: "x", ref: GEMINI }).catch((x) => x)) as Error;
  assert.equal(e.message, "A picture is kept in a conversation");
  assert.equal(sent.length, 0);
});

test("failures in the owner's words: not set up, busy, refused, gone, slow, nothing back", async () => {
  delete process.env.GEMINI_API_KEY;
  let e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "Pictures from Google aren't set up on this copy of Athena.");
  process.env.GEMINI_API_KEY = "k";

  answer(429, { error: "rate" });
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "Google is busy. Try again in a minute.");
  assert.equal(e.status, 429);

  answer(200, { promptFeedback: { blockReason: "SAFETY" } });
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "Google wouldn't make that picture. Try describing it differently.");

  answer(200, { candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] });
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.code, "refused");

  answer(400, { error: { code: "moderation_blocked", message: "Your request was rejected by the safety system" } });
  e = (await makeImage({ prompt: "x", ref: OPENAI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "OpenAI wouldn't make that picture. Try describing it differently.");

  answer(404, {});
  e = (await makeImage({ prompt: "x", ref: OPENAI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "GPT Image 2 isn't available any more. Choose another picture model in Settings, AI models.");

  answer(200, { candidates: [{ content: { parts: [{ text: "I can't draw" }] }, finishReason: "STOP" }] });
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "Gemini 3 Pro Image didn't send a picture back. Try asking again, or describe it differently.");

  answer(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from("not a png").toString("base64") } }] } }] });
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "The picture that came back couldn't be opened. Try again.");

  useImageFetch((async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    throw err;
  }) as typeof fetch);
  e = (await makeImage({ prompt: "x", ref: GEMINI, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "That picture took too long. Try again, or ask for something simpler.");
});

test("a model that doesn't make pictures is refused before anything is sent", async () => {
  answer(200, {});
  const e = (await makeImage({ prompt: "x", ref: { provider: "openai", model: "gpt-5.5" }, threadId: T }).catch((x) => x)) as PictureError;
  assert.equal(e.message, "GPT-5.5 doesn't make pictures. Choose a picture model in Settings, AI models.");
  assert.equal(sent.length, 0);
  assert.equal(makesPictures(GEMINI), true);
  assert.equal(makesPictures(OPENAI), true);
});

test("the tool: a change-from list only for a model that changes pictures; alt and prompt required", () => {
  const g = makeImageTool({ canChange: true });
  const o = makeImageTool({ canChange: false });
  const props = (t: typeof g) => Object.keys((t.input_schema as { properties: object }).properties);
  assert.deepEqual(props(g), ["prompt", "alt", "shape", "from"]);
  assert.deepEqual(props(o), ["prompt", "alt", "shape"]);
  assert.deepEqual(g.input_schema.required, ["prompt", "alt"]);
  assert.match(o.description!, /can't change an existing picture/);
});

test("names: the file from the prompt, the model from its id", () => {
  assert.equal(pictureName("a red lighthouse at dusk, in watercolour!", "image/png"), "A red lighthouse at dusk.png");
  assert.equal(pictureName("???", "image/jpeg"), "Picture.jpg");
  assert.equal(pictureName("A lighthouse on a cliff at night with stars and a moon", "image/png"), "A lighthouse on a cliff at night.png");
  assert.equal(modelLabel({ provider: "gemini", model: "gemini-3.5-flash" }), "Gemini 3.5 Flash");
  assert.equal(modelLabel({ provider: "anthropic", model: "claude-sonnet-5-5" }), "Claude Sonnet 5.5");
  assert.equal(modelLabel({ provider: "gemini", model: "gemini-3-pro-image-preview" }), "Gemini 3 Pro Image");
  assert.equal(modelLabel({ provider: "openai", model: "gpt-5.5" }), "GPT-5.5");
  assert.equal(modelLabel({ provider: "openrouter", model: "deepseek/deepseek-v4-pro" }), "Deepseek V4 Pro");
  assert.equal(familyOf({ provider: "gemini", model: "gemini-3.5-flash" }), "Gemini");
  assert.equal(familyOf({ provider: "openrouter", model: "deepseek/deepseek-v4-pro" }), "OpenRouter");
});

test("the fall-back line names the model that didn't answer when the reply carries `tried`", async () => {
  const { fellBackLine } = await import("./model-label");
  const sonnet = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  assert.equal(fellBackLine(sonnet, { provider: "gemini", model: "gemini-3.5-flash" }), "Gemini 3.5 Flash didn't answer, so Claude Sonnet 5.5 did.");
  assert.equal(fellBackLine(sonnet), "Your chosen model didn't answer, so Claude Sonnet 5.5 did.");
  assert.equal(fellBackLine(sonnet, null), "Your chosen model didn't answer, so Claude Sonnet 5.5 did.");
  // A server that names the same model it answered with says nothing useful: the line without a name.
  assert.equal(fellBackLine(sonnet, sonnet), "Your chosen model didn't answer, so Claude Sonnet 5.5 did.");
});
