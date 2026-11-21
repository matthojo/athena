// Run: npx tsx --test app/src/lib/vision-warning.test.ts
// Before a photo goes to a thinking model that can't see it (owner, 17 Nov 2026): warn only when the catalogue says
// vision: false; "unknown" and true send as usual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingModel, visionWarning, visionWords } from "./vision-warning";
import type { CatalogueModel, ModelRef } from "../../../lib/model-types";

const model = (ref: ModelRef, name: string, vision: boolean | "unknown", blurb: string | null = "A model."): CatalogueModel => ({
  ref,
  name,
  blurb,
  speed: null,
  cost: null,
  abilities: { tools: true, vision, images: false, web: "handoff" },
  recommended: false,
  preview: false,
});
const NANO: ModelRef = { provider: "openai", model: "gpt-5.5-nano" };
const ODD: ModelRef = { provider: "openrouter", model: "qwen/qwen3-32b" };
const FLASH: ModelRef = { provider: "gemini", model: "gemini-3.5-flash" };
const catalogue = [model(NANO, "GPT-5.5 nano", false), model(ODD, "qwen/qwen3-32b", "unknown", null), model(FLASH, "Gemini 3.5 Flash", true)];
const photo = { name: "receipt.jpg", type: "image/jpeg" };
const pdf = { name: "lease.pdf", type: "application/pdf" };
const text = { name: "notes.md", type: "text/markdown" };

test("vision: false and a photo: warn, naming the model, the file and the default instead", () => {
  const w = visionWarning(NANO, catalogue, [photo]);
  assert.ok(w);
  assert.deepEqual(w.model, NANO);
  assert.deepEqual(w.instead, { provider: "anthropic", model: "claude-sonnet-5-5" });
  assert.deepEqual(visionWords(w), {
    title: "GPT-5.5 nano can't see photos.",
    body: "It would answer without seeing receipt.jpg.",
    anyway: "Send anyway",
    use: "Use Claude Sonnet 5.5 for this message",
  });
});

test("vision: \"unknown\": no warning", () => {
  assert.equal(visionWarning(ODD, catalogue, [photo]), null);
  assert.equal(visionWarning(ODD, catalogue, [pdf]), null);
});

test("vision: true: no warning", () => {
  assert.equal(visionWarning(FLASH, catalogue, [photo, pdf]), null);
});

test("a PDF counts, text doesn't; several files are counted", () => {
  assert.equal(visionWords(visionWarning(NANO, catalogue, [pdf])!).title, "GPT-5.5 nano can't see PDF pages.");
  const both = visionWords(visionWarning(NANO, catalogue, [photo, pdf, text])!);
  assert.equal(both.title, "GPT-5.5 nano can't see photos or PDF pages.");
  assert.equal(both.body, "It would answer without seeing these 2 files.");
  assert.equal(visionWarning(NANO, catalogue, [text]), null);
  assert.equal(visionWarning(NANO, catalogue, []), null);
});

test("no model, a model not in the catalogue, or the default: no warning", () => {
  assert.equal(visionWarning(null, catalogue, [photo]), null);
  assert.equal(visionWarning({ provider: "meta", model: "llama-9" }, catalogue, [photo]), null);
  assert.equal(visionWarning({ provider: "anthropic", model: "claude-sonnet-5-5" }, [model({ provider: "anthropic", model: "claude-sonnet-5-5" }, "Claude Sonnet 5.5", false)], [photo]), null);
});

test("the turn's thinking model: an assistant's own, else the owner's", () => {
  const effective = { think: { ref: FLASH }, assistants: { penny: { think: { ref: NANO } } } };
  assert.deepEqual(thinkingModel(effective, "penny"), NANO);
  assert.deepEqual(thinkingModel(effective, "wren"), FLASH);
  assert.deepEqual(thinkingModel(effective, null), FLASH);
  assert.equal(thinkingModel(null, "penny"), null);
});
