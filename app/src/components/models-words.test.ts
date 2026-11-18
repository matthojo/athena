// AI models' words (models-words.ts): search, the "same as" wording, what's offered, newer and withdrawn, and take back.
// Run: npx tsx --test app/src/components/models-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { byCompany, facts, factsPhrase, followWords, newerWords, notePieces, offeredFor, rowNote, shownRef, savedWords, searchModels, seconds, takeBackEffects, whyWords, withdrawnWords, type Target } from "./models-words";
import type { CatalogueModel, ModelRef, ResolvedModel } from "../../../lib/model-types";

const model = (provider: ModelRef["provider"], id: string, over: Partial<CatalogueModel> = {}): CatalogueModel => ({
  ref: { provider, model: id },
  name: id,
  blurb: null,
  speed: null,
  cost: null,
  abilities: { tools: "unknown", vision: "unknown", images: false, web: "handoff" },
  recommended: false,
  preview: false,
  ...over,
});
const known = (provider: ModelRef["provider"], id: string, name: string, over: Partial<CatalogueModel> = {}) =>
  model(provider, id, { name, blurb: `${name} notes`, speed: "balanced", cost: 3, abilities: { tools: true, vision: true, images: false, web: "native" }, ...over });

const sonnet = known("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", {});
const opus = known("anthropic", "claude-opus-5-5", "Claude Opus 5.5", { speed: "slow", cost: 4 });
const haiku = known("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", { speed: "quick", cost: 1, blurb: "Quick and cheap, good for summaries" });
const flash = known("gemini", "gemini-3.5-flash", "Gemini 3.5 Flash", { speed: "quick", cost: 1, blurb: "Quick and cheap, and good with photos" });
const proImage = known("gemini", "gemini-3-pro-image", "Gemini 3 Pro Image", { abilities: { tools: false, vision: true, images: true, web: "native" } });
const gptImage = known("openai", "gpt-image-2", "GPT Image 2", { abilities: { tools: false, vision: true, images: true, web: "handoff" } });
const tiny = known("meta", "llama-3.2-3b-instruct", "Llama 3.2 3B", { abilities: { tools: false, vision: false, images: false, web: "handoff" } });
const deepseek = model("openrouter", "deepseek/deepseek-v3.2");
const qwen = model("openrouter", "qwen/qwen3-coder:free");
const all = [sonnet, opus, haiku, flash, proImage, gptImage, tiny, deepseek, qwen];

// ---------- search ----------

test("search finds by name, word, company and gateway id", () => {
  assert.deepEqual(searchModels(all, "sonnet").map((m) => m.name), ["Claude Sonnet 5.5"]);
  assert.deepEqual(searchModels(all, "flash").map((m) => m.name), ["Gemini 3.5 Flash"]);
  assert.ok(searchModels(all, "google").every((m) => m.ref.provider === "gemini"));
  assert.deepEqual(searchModels(all, "deepseek-v3").map((m) => m.ref.model), ["deepseek/deepseek-v3.2"]);
  assert.deepEqual(searchModels(all, "qwen3-coder").map((m) => m.ref.model), ["qwen/qwen3-coder:free"]);
});

test("every word has to match, in any order, ignoring case", () => {
  assert.deepEqual(searchModels(all, "5.5 CLAUDE haiku").map((m) => m.name), ["Claude Haiku 5.5"]);
  assert.deepEqual(searchModels(all, "claude gemini"), []);
});

test("words like cheap, quick, photos and pictures find what models can do", () => {
  assert.deepEqual(searchModels(all, "cheap").map((m) => m.name).sort(), ["Claude Haiku 5.5", "Gemini 3.5 Flash"]);
  assert.ok(searchModels(all, "pictures").every((m) => m.abilities.images));
  assert.ok(searchModels(all, "untested").every((m) => m.blurb === null));
});

test("name matches come before word matches, and known models before unknown at the same strength", () => {
  const r = searchModels(all, "gemini");
  assert.equal(r[0].name, "Gemini 3.5 Flash");
  const ds = [model("openrouter", "deepseek/deepseek-r1"), known("openrouter", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro")];
  assert.equal(searchModels(ds, "deepseek")[0].name, "DeepSeek V4 Pro");
});

test("an empty search keeps every model in order", () => {
  assert.deepEqual(searchModels(all, "  "), all);
});

test("a model Athena knows but has no blurb for isn't untested", () => {
  const plain = known("openai", "gpt-5.1", "GPT-5.1", { blurb: null });
  assert.equal(searchModels([plain, deepseek], "untested").map((m) => m.ref.model).join(), "deepseek/deepseek-v3.2");
});

// ---------- what's offered ----------

test("models that can't think aren't offered for thinking; unknown ones are", () => {
  assert.equal(offeredFor("think", tiny), false);
  assert.equal(offeredFor("think", proImage), false);
  assert.equal(offeredFor("think", deepseek), true);
  assert.equal(offeredFor("everyday", tiny), true);
  assert.equal(offeredFor("image", proImage), true);
  assert.equal(offeredFor("image", sonnet), false);
});

test("by company, in the gateway's order, keeping the catalogue's order (newest first) within each", () => {
  const groups = byCompany([deepseek, tiny, sonnet, opus, known("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6")]);
  assert.deepEqual(groups.map((g) => g.provider), ["anthropic", "meta", "openrouter"]);
  assert.deepEqual(groups[0].models.map((m) => m.name), ["Claude Sonnet 5.5", "Claude Opus 5.5", "Claude Sonnet 4.6"]);
});

test("a newer version is offered in words, and a withdrawn choice names what runs instead", () => {
  const older = { provider: "anthropic" as const, model: "claude-sonnet-4-6" };
  assert.equal(newerWords({ ref: older, from: "owner", newer: sonnet.ref }, all), "A newer version is out: Claude Sonnet 5.5");
  assert.equal(newerWords({ ref: sonnet.ref, from: "owner" }, all), null);
  const gone = { provider: "anthropic" as const, model: "claude-3-opus-20240229" };
  assert.equal(withdrawnWords("careful", { ref: sonnet.ref, from: "tier", withdrawn: gone }, all), "No longer offered, using Claude Sonnet 5.5");
  assert.equal(withdrawnWords("image", { ref: gone, from: "owner", withdrawn: gone }, all), "No longer offered. Pictures are off until you pick another.");
  assert.equal(withdrawnWords("think", { ref: sonnet.ref, from: "owner" }, all), null);
  // A job (Recipes, on Careful work) whose own model is gone runs its tier's model.
  assert.equal(withdrawnWords("careful", { ref: opus.ref, from: "tier", withdrawn: gone }, all), "No longer offered, using Claude Opus 5.5");
  // A newer model Athena has no notes on is named by its id.
  assert.equal(newerWords({ ref: older, from: "owner", newer: { provider: "gemini", model: "gemini-3.8-flash" } }, all), "A newer version is out: gemini-3.8-flash");
});

test("a row names the model chosen, and its note has one action", () => {
  const older = { provider: "anthropic" as const, model: "claude-sonnet-4-6" };
  const gone = { provider: "anthropic" as const, model: "claude-3-opus-20240229" };
  assert.deepEqual(shownRef({ ref: sonnet.ref, from: "owner", withdrawn: gone }), gone);
  assert.deepEqual(shownRef({ ref: older, from: "owner" }), older);
  assert.deepEqual(rowNote("careful", { ref: older, from: "owner", newer: sonnet.ref }, all), { kind: "newer", text: "A newer version is out: Claude Sonnet 5.5", name: "Claude Sonnet 5.5", action: "Switch", label: "Switch to Claude Sonnet 5.5", ref: sonnet.ref });
  assert.deepEqual(rowNote("everyday", { ref: haiku.ref, from: "default", withdrawn: gone, newer: sonnet.ref }, all), { kind: "gone", text: "No longer offered, using Claude Haiku 5.5", name: "Claude Haiku 5.5", action: "Pick another" });
  assert.deepEqual(notePieces(rowNote("everyday", { ref: haiku.ref, from: "default", withdrawn: gone }, all)!), ["No longer offered, using ", "Claude Haiku 5.5"]);
  assert.deepEqual(notePieces(rowNote("image", { ref: gone, from: "owner", withdrawn: gone }, all)!), ["No longer offered. Pictures are off until you pick another.", ""]);
  assert.equal(rowNote("think", { ref: sonnet.ref, from: "default" }, all), null);
  // A job following Careful work says nothing about Careful work's model: that's the tier row's to offer.
  assert.equal(rowNote("careful", { ref: older, from: "tier", newer: sonnet.ref }, all, { follows: true }), null);
  // Gone, it's still the owner's choice, though the default runs.
  assert.equal(whyWords({ kind: "owner", role: "everyday" }, { ref: haiku.ref, from: "default", withdrawn: gone }), "Your choice");
  assert.equal(whyWords({ kind: "job", job: "recipes" }, { ref: sonnet.ref, from: "tier", withdrawn: gone }), "Its own model");
});

test("what a model can do is said in words, and unknowns say so", () => {
  assert.deepEqual(facts(haiku), ["Quick", "Lowest cost", "Uses tools", "Sees photos"]);
  assert.deepEqual(facts(deepseek), ["Speed and cost not known"]);
  assert.deepEqual(facts(tiny), ["Medium speed", "Medium cost", "Can't use tools"]);
  assert.ok(facts(proImage).includes("Makes and changes pictures"));
  assert.ok(facts(gptImage).includes("Makes pictures"));
  assert.equal(factsPhrase(facts(haiku)), "Quick, lowest cost. Uses tools, sees photos.");
  assert.equal(factsPhrase(facts(deepseek)), "Speed and cost not known.");
});

// ---------- "same as" ----------

const r = (from: ResolvedModel["from"]): ResolvedModel => ({ ref: sonnet.ref, from });
const sol: Target = { kind: "assistant", role: "think", id: "a", name: "Sol", their: "her" };

test("a job that hasn't been set is the same as its tier", () => {
  assert.equal(whyWords({ kind: "job", job: "briefing" }, r("tier")), "Same as Careful work");
  assert.equal(whyWords({ kind: "job", job: "briefing" }, r("default")), "Same as Careful work");
  assert.equal(whyWords({ kind: "job", job: "file_summary" }, r("default")), "Same as Everyday work");
  assert.equal(whyWords({ kind: "job", job: "briefing" }, r("job")), "Its own model");
  assert.equal(whyWords({ kind: "job", job: "briefing" }, r("env")), "Set for this site");
});

test("the owner's rows say default, their choice, or off", () => {
  assert.equal(whyWords({ kind: "owner", role: "think" }, r("default")), "Athena's default");
  assert.equal(whyWords({ kind: "owner", role: "everyday" }, r("owner")), "Your choice");
  assert.equal(whyWords({ kind: "owner", role: "image" }, null), "Pick a model to turn them on");
});

test("an assistant is the same as Ask until it has its own, in its own pronoun", () => {
  assert.equal(whyWords(sol, r("owner")), "Same as Ask");
  assert.equal(whyWords(sol, r("assistant")), "Her own");
  assert.equal(whyWords({ ...sol, their: "their" }, r("assistant")), "Their own");
});

test("the picker's follow option names what following means", () => {
  assert.deepEqual(followWords({ kind: "job", job: "drafts" }, "Claude Sonnet 5.5"), { label: "Same as Careful work", detail: "Claude Sonnet 5.5" });
  assert.deepEqual(followWords(sol, "Claude Sonnet 5.5"), { label: "Same as Ask", detail: "Claude Sonnet 5.5" });
  assert.equal(followWords({ kind: "owner", role: "image" }, null)?.label, "Off");
  assert.equal(followWords({ kind: "owner", role: "think" }, null), null);
});

test("saves are said in words", () => {
  assert.equal(savedWords({ kind: "job", job: "drafts" }, null), "Drafts follow Careful work again");
  assert.equal(savedWords({ kind: "owner", role: "everyday" }, "Gemini 3.5 Flash"), "Everyday work uses Gemini 3.5 Flash now");
  assert.equal(savedWords({ ...sol, role: "image" }, null, true), "Sol won't make pictures");
  assert.equal(savedWords({ kind: "owner", role: "image" }, null), "Pictures are off");
});

// ---------- take back ----------

test("taking an agreement back says which choices go back", () => {
  const out = takeBackEffects(
    "gemini",
    { everyday: flash.ref, careful: sonnet.ref, image: proImage.ref, jobs: { file_summary: flash.ref, briefing: opus.ref } },
    [
      { name: "Sol", models: { think: flash.ref } },
      { name: "Wren", models: { think: sonnet.ref } },
      { name: "Dot", models: { think: flash.ref, image: proImage.ref } },
    ],
    all
  );
  assert.deepEqual(out, [
    "Pictures turn off",
    "Everyday work goes back to Claude Haiku 5.5",
    "File summaries go back to the same as Everyday work",
    "Sol's thinking goes back to the same as Ask",
    "Dot's thinking and pictures go back to the same as Ask",
  ]);
  assert.deepEqual(takeBackEffects("openai", { everyday: flash.ref }, [], all), []);
});

test("seconds read naturally", () => {
  assert.equal(seconds(640), "0.6 seconds");
  assert.equal(seconds(1000), "1 second");
  assert.equal(seconds(1234), "1.2 seconds");
  assert.equal(seconds(12_400), "12 seconds");
});
