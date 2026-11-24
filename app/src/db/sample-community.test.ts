// Sample mode's Community catalogue (app/src/db/sample-community.ts): every item is a real, readable item whose hash
// and reach are the ones its files give, so the list and the #/add preview behave as with a real catalogue.
// Run: npx tsx --test app/src/db/sample-community.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogueIndexSchema, catalogueBundleSchema, verifyBundle } from "../../../lib/catalogue-types";
import { reachOf } from "../../../lib/reach";
import { sampleBundle, sampleCatalogue, sampleUpdates } from "./sample-community";

test("the sample index passes the catalogue's own checks, with all three kinds and tiers", async () => {
  const index = await sampleCatalogue();
  assert.ok(catalogueIndexSchema.safeParse(index).success, JSON.stringify(catalogueIndexSchema.safeParse(index).error?.issues[0]));
  assert.ok(index.items.length >= 12);
  assert.deepEqual(new Set(index.items.map((i) => i.kind)), new Set(["assistant", "skill", "flow"]));
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
