// Run: npx tsx --test app/src/db/ask-pictures.test.ts
// Pictures Ask made (owner, 17 Nov 2026): Undo archives one; restoring it puts it back in the conversation, and
// deleting it for good shows it was deleted. Sample mode's pictures follow the sample AI models settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pictureKey, pictureModelFor, showPicture } from "./ask-pictures";
import { sampleGet, samplePatch, sampleSaveAssistantModels } from "./sample-models";
import type { AskThread } from "../types";

const pic = (id: string) => ({ file: { id, name: `${id}.png`, type: "image/png", size: 10, has_thumb: true }, alt: "A teapot.", prompt: "A teapot", ref: { provider: "gemini", model: "gemini-3-pro-image" } });
const thread = (messages: unknown[]): AskThread => ({ id: "t1", title: "", created_at: "2026-11-17T10:00:00Z", updated_at: "2026-11-17T10:00:00Z", messages } as unknown as AskThread);

test("restored: Undo is taken back, so the picture shows in its conversation again", () => {
  const t = thread([
    { role: "me", text: "Draw a teapot", at: "x" },
    { role: "answer", at: "x", text: "Here.", pictures: [pic("a")], undone: [pictureKey("a"), "note:n1:created"] },
    { role: "assistant", at: "x", reply: { text: "And another.", pictures: [pic("b")] }, undone: [pictureKey("b")] },
  ]);
  const a = showPicture(t, "a", "restore")!;
  assert.deepEqual((a.messages[1] as unknown as { undone: string[] }).undone, ["note:n1:created"], "only that picture's Undo");
  assert.deepEqual((a.messages[2] as unknown as { undone: string[] }).undone, [pictureKey("b")]);
  const b = showPicture(a, "b", "restore")!;
  assert.deepEqual((b.messages[2] as unknown as { undone: string[] }).undone, []);
  assert.equal(showPicture(b, "b", "restore"), null, "nothing to change");
  assert.equal(showPicture(b, "zzz", "restore"), null);
});

test("restored in every version of a reply written more than once", () => {
  const t = thread([{ role: "answer", at: "x", text: "", pictures: [], versions: [{ role: "answer", text: "One", pictures: [pic("a")], undone: [pictureKey("a")] }, { role: "answer", text: "Two", pictures: [] }] }]);
  const v = (showPicture(t, "a", "restore")!.messages[0] as unknown as { versions: Array<{ undone?: string[] }> }).versions;
  assert.deepEqual(v[0].undone, []);
});

test("deleted for good: the conversation shows it was deleted", () => {
  const t = thread([
    { role: "answer", at: "x", text: "Here.", pictures: [pic("a"), pic("c")], undone: [pictureKey("a")] },
    { role: "assistant", at: "x", reply: { text: "And another.", pictures: [pic("b")] }, undone: [pictureKey("b")] },
  ]);
  const a = showPicture(t, "a", "delete")!;
  const shown = (a.messages[0] as unknown as { pictures: Array<{ file: { id: string; removed?: boolean; has_thumb?: boolean } }> }).pictures;
  assert.deepEqual(shown.map((p) => [p.file.id, !!p.file.removed, p.file.has_thumb]), [["a", true, false], ["c", false, true]]);
  const b = showPicture(a, "b", "delete")!;
  assert.equal((b.messages[1] as unknown as { reply: { pictures: Array<{ file: { removed?: boolean } }> } }).reply.pictures[0].file.removed, true);
});

test("sample mode follows the sample AI models settings: off to start, the chosen model once set, an assistant's own", async () => {
  const start = await sampleGet();
  assert.equal(pictureModelFor(start.effective, null), null, "the sample starts with pictures off");
  const gemini = { provider: "gemini" as const, model: "gemini-3-pro-image" };
  const on = await samplePatch({ image: gemini });
  assert.deepEqual(pictureModelFor(on.effective, null), gemini);
  assert.deepEqual(pictureModelFor(on.effective, "someone-without-models"), gemini, "an assistant without its own follows Ask");
  await sampleSaveAssistantModels("moss", { image: null });
  assert.equal(pictureModelFor((await sampleGet()).effective, "moss"), null, "No pictures for Moss");
  const gpt = { provider: "openai" as const, model: "gpt-image-2" };
  // OpenAI needs agreeing to first (sample-models answers as the server would).
  await assert.rejects(sampleSaveAssistantModels("wren", { image: gpt }));
  const off = await samplePatch({ image: null });
  assert.equal(pictureModelFor(off.effective, null), null, "turned off again");
  assert.equal(pictureModelFor(null, null), null);
});
