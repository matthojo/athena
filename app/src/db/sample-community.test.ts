// Sample mode's Community catalogue (app/src/db/sample-community.ts): every item is a real, readable item whose hash
// and reach are the ones its files give, so the list and the #/add preview behave as with a real catalogue.
// Run: npx tsx --test app/src/db/sample-community.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogueIndexSchema, catalogueBundleSchema, verifyBundle } from "../../../lib/catalogue-types";
import { reachOf } from "../../../lib/reach";
import { sampleBundle, sampleCatalogue, sampleUpdates } from "./sample-community";

test("the sample index passes the catalogue's own checks, with all six kinds and tiers", async () => {
  const index = await sampleCatalogue();
  assert.ok(catalogueIndexSchema.safeParse(index).success, JSON.stringify(catalogueIndexSchema.safeParse(index).error?.issues[0]));
  assert.ok(index.items.length >= 12);
  assert.deepEqual(new Set(index.items.map((i) => i.kind)), new Set(["assistant", "skill", "flow", "checkin", "template", "theme"]));
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
  // Slow mornings offers Go deeper and is tier 1 all the same: the listing says what Athena works out from its files.
  for (const s of sets) assert.equal(reachOf({ kind: "checkin", files: (await sampleBundle(s.id))!.bundle.files }).tier, s.reach.tier, s.name);
  const slow = JSON.parse((await sampleBundle(sets[1].id))!.bundle.files[0].text) as { questions: Array<{ deeper?: boolean }> };
  assert.ok(slow.questions.some((q) => q.deeper === true));
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

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** The number a summary opens with ("Four questions…", "Three quiet questions…"), or null. */
const countIn = (summary: string): number | null => COUNT_WORDS[summary.split(/\s+/)[0].toLowerCase()] ?? null;

test("every sample set of check-in questions says as many questions as it holds", async () => {
  const index = await sampleCatalogue();
  for (const item of index.items.filter((i) => i.kind === "checkin")) {
    const got = (await sampleBundle(item.id))!;
    const file = JSON.parse(got.bundle.files.find((f) => f.path.endsWith("checkin.json"))!.text) as { summary: string; questions: unknown[] };
    for (const summary of [item.summary, file.summary]) {
      const n = countIn(summary);
      if (n !== null) assert.equal(n, file.questions.length, `${item.name}: “${summary}”`);
    }
  }
  // The Add screen's sample links, and the set sample check-ins already has.
  const { SAMPLE_LINKS, sampleLinkFiles } = await import("../add/sample-items");
  let links = 0;
  for (const { link } of SAMPLE_LINKS) {
    const f = sampleLinkFiles(link)?.find((x) => x.path.endsWith("checkin.json"));
    if (!f) continue;
    const file = JSON.parse(f.text) as { summary: string; questions: unknown[] };
    const n = countIn(file.summary);
    if (n !== null) (links++, assert.equal(n, file.questions.length, `“${file.summary}”`));
  }
  assert.ok(links > 0);
  const { sampleCheckinSettings } = await import("./sample-checkins");
  const view = await sampleCheckinSettings();
  for (const set of view.sets) {
    const n = countIn(set.summary);
    if (n !== null) assert.equal(n, view.own.filter((q) => q.set === set.id).length, `${set.name}: “${set.summary}”`);
  }
});

test("sample templates: a weekly review, a gratitude page and a year-end reflection, each tier 1 and readable", async () => {
  const { readSharedTemplate } = await import("../../../lib/template-share");
  const index = await sampleCatalogue();
  const templates = index.items.filter((i) => i.kind === "template");
  assert.deepEqual(templates.map((t) => [t.name, t.reach.tier]), [["Gentle weekly review", 1], ["Gratitude page", 1], ["Year-end reflection", 1]]);
  for (const t of templates) {
    const got = (await sampleBundle(t.id))!;
    const read = readSharedTemplate(JSON.parse(got.bundle.files[0].text));
    assert.equal(read.author, t.author, t.slug);
    assert.ok(read.body.length > 40, t.slug);
  }
});

test("sample templates already added: Gratitude page has a newer version listed, and Morning pages was taken down", async () => {
  const { SAMPLE_ADDED_TEMPLATE_ROWS, SAMPLE_TEMPLATE_IDS } = await import("./sample-community");
  const { readSharedTemplate } = await import("../../../lib/template-share");
  // As db/documents.ts keeps them: each reads as a shared template would.
  for (const r of SAMPLE_ADDED_TEMPLATE_ROWS) assert.doesNotThrow(() => readSharedTemplate({ format: 1, name: r.name, summary: r.shared.summary, body: r.body }), r.name);
  const index = await sampleCatalogue();
  const checks = (await sampleUpdates()).filter((u) => u.kind === "template");
  const gratitude = checks.find((c) => c.id === SAMPLE_TEMPLATE_IDS.gratitude)!;
  assert.equal(gratitude.newer?.version, "1.1");
  assert.equal(gratitude.newer?.hash, index.items.find((i) => i.id === gratitude.catalogue_id)?.hash);
  assert.equal(gratitude.withdrawn, null);
  const morning = checks.find((c) => c.id === SAMPLE_TEMPLATE_IDS.morning)!;
  assert.equal(morning.newer, null);
  assert.ok(index.withdrawn.some((w) => w.id === morning.catalogue_id && w.reason === morning.withdrawn?.reason));
  // Updated to the listed version, the template has nothing more to hear.
  const listed = index.items.find((i) => i.id === gratitude.catalogue_id)!;
  const after = await sampleUpdates([{ id: SAMPLE_TEMPLATE_IDS.gratitude, catalogue_id: listed.id, hash: listed.hash, version: "1.1", changed: false }]);
  assert.equal(after.filter((u) => u.kind === "template").length, 0);
});

test("sample themes: three with their own look, one with a single mode, each read whole; Paper lantern added at 1.0 shows an update", async () => {
  const { readSharedTheme, themeSchemes } = await import("../../../lib/theme-share");
  const { SAMPLE_ADDED_THEME } = await import("./sample-themes");
  const { readOwnThemes } = await import("../../../lib/theme");
  const index = await sampleCatalogue();
  const themes = index.items.filter((i) => i.kind === "theme");
  assert.deepEqual(themes.map((t) => t.name), ["Paper lantern", "Night garden", "Risograph"]);
  const modes: string[][] = [];
  for (const t of themes) {
    const file = (await sampleBundle(t.id))!.bundle.files.find((f) => f.path === "theme.json")!;
    const s = readSharedTheme(JSON.parse(file.text));
    assert.deepEqual(s.problems, [], `${t.name} reads with nothing left out`);
    assert.ok(s.theme.chart, `${t.name} keeps its own chart colours`);
    assert.equal(s.author, t.author);
    modes.push(themeSchemes(s.theme));
  }
  assert.deepEqual(modes, [["light", "dark"], ["dark"], ["light"]]);
  const here = readOwnThemes([SAMPLE_ADDED_THEME]);
  const updates = await sampleUpdates(undefined, here);
  const lantern = updates.find((u) => u.kind === "theme");
  assert.equal(lantern?.id, SAMPLE_ADDED_THEME.id);
  assert.equal(lantern?.version, "1.0");
  assert.equal(lantern?.newer?.version, "1.1");
});
