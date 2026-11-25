// Sample mode's Community catalogue (app/src/db/sample-community.ts): every item is a real, readable item whose hash
// and reach are the ones its files give, so the list and the #/add preview behave as with a real catalogue.
// Run: npx tsx --test app/src/db/sample-community.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogueIndexSchema, catalogueBundleSchema, verifyBundle } from "../../../lib/catalogue-types";
import { reachOf } from "../../../lib/reach";
import { sampleBundle, sampleCatalogue, sampleUpdates } from "./sample-community";

test("the sample index passes the catalogue's own checks, with all four kinds and tiers", async () => {
  const index = await sampleCatalogue();
  assert.ok(catalogueIndexSchema.safeParse(index).success, JSON.stringify(catalogueIndexSchema.safeParse(index).error?.issues[0]));
  assert.ok(index.items.length >= 12);
  assert.deepEqual(new Set(index.items.map((i) => i.kind)), new Set(["assistant", "skill", "flow", "checkin"]));
  assert.deepEqual(new Set(index.items.map((i) => i.reach.tier)), new Set([1, 2, 3]));
  assert.ok(index.items.some((i) => i.featured));
});

test("every sample bundle matches its hash, the index, and the reach its files give", async () => {
  for (const item of (await sampleCatalogue()).items) {
    const got = await sampleBundle(item.id);
    assert.ok(got, item.id);
    assert.ok(catalogueBundleSchema.safeParse(got.bundle).success, item.slug);
    assert.equal(await verifyBundle(got.bundle, item), true, item.slug);
    assert.deepEqual(reachOf({ kind: item.kind, files: got.bundle.files }), item.reach, item.slug);
  }
  assert.equal(await sampleBundle("0000000000000000"), null);
});

test("sample updates point at a listed item with a newer hash and a withdrawn one", async () => {
  const index = await sampleCatalogue();
  const [newer, gone] = await sampleUpdates();
  assert.equal(newer.newer?.hash, index.items.find((i) => i.id === newer.catalogue_id)?.hash);
  assert.notEqual(newer.hash, newer.newer?.hash);
  assert.ok(index.withdrawn.some((w) => w.id === gone.catalogue_id));
});

test("every sample flow, listed or linked, passes the checks a flow gets when it's added", async () => {
  const { checkSharedFlowSteps, readSharedFlow } = await import("../../../lib/flow-share");
  const { SAMPLE_LINKS, sampleLinkFiles } = await import("../add/sample-items");
  const texts: Array<[string, string]> = [];
  for (const item of (await sampleCatalogue()).items) if (item.kind === "flow") texts.push([item.slug, (await sampleBundle(item.id))!.bundle.files.find((f) => f.path.endsWith("flow.json"))!.text]);
  for (const l of SAMPLE_LINKS) for (const f of sampleLinkFiles(l.link) ?? []) if (f.path.endsWith("flow.json") && !/newer/i.test(l.title)) texts.push([l.title, f.text]);
  assert.ok(texts.length >= 7);
  for (const [name, text] of texts) assert.doesNotThrow(() => checkSharedFlowSteps(readSharedFlow(JSON.parse(text))), name);
});

test("every sample listing is named as its files name it, so the list and the preview agree", async () => {
  const { buildPreview } = await import("../../../lib/community-add");
  for (const item of (await sampleCatalogue()).items) {
    const got = (await sampleBundle(item.id))!;
    const p = await buildPreview({ files: { kind: item.kind, files: got.bundle.files, skipped: [], folder: null }, from: { catalogue: item.id }, source: { kind: "link", at: "2026-11-24T00:00:00Z" }, listing: item, existing: null });
    assert.equal(p.name, item.name, item.slug);
  }
});

test("sample check-in questions: listed sets read, and Sunday reset is taken down and switched off", async () => {
  const index = await sampleCatalogue();
  const sets = index.items.filter((i) => i.kind === "checkin");
  assert.deepEqual(sets.map((s) => [s.name, s.reach.tier]), [["Small joys", 1], ["Slow mornings", 1]]);
  const { sampleSetOf, SAMPLE_SET_ID } = await import("./sample-checkins");
  assert.equal(sampleSetOf(SAMPLE_SET_ID)?.paused, true);
  const updates = await sampleUpdates();
  const sunday = updates.find((u) => u.kind === "checkin");
  assert.equal(sunday?.id, SAMPLE_SET_ID);
  assert.ok(index.withdrawn.some((w) => w.id === sunday?.catalogue_id));
});

test("sample mode adds a set as the server would: after what's there, skipping what's already here", async () => {
  const { sampleAddCheckins, sampleCheckinSettings, sampleRemoveSet } = await import("./sample-checkins");
  const { readSharedCheckins } = await import("../../../lib/checkin-share");
  const before = await sampleCheckinSettings();
  const small = (await sampleBundle("j6k1m5n9p3q8r2s7"))!;
  const got = await sampleAddCheckins(readSharedCheckins(JSON.parse(small.bundle.files[0].text)));
  assert.deepEqual(got.skipped, ["What went well today?"]);
  assert.equal(got.added, 3);
  const after = await sampleCheckinSettings();
  assert.deepEqual(after.evening.questions.slice(0, before.evening.questions.length), before.evening.questions);
  assert.equal(after.sets.at(-1)?.name, "Small joys");
  const removed = await sampleRemoveSet(got.id);
  assert.deepEqual(removed.evening.questions, before.evening.questions);
});
