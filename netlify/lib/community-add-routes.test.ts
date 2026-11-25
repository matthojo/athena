// Community's #/add routes (netlify/lib/community-add-routes.ts, lib/community-add.ts): every way in ends at one
// preview, and Add hands each kind to its own import with only the owner's choices. Fakes stand in for the stores,
// the catalogue and GitHub. Made-up items only; nothing needs a database.
// Run: npx tsx --test netlify/lib/community-add-routes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addFrom, handleCommunityAddRoutes, parseAddLink, previewOf, readChoices, type CommunityAddDeps } from "./community-add-routes";
import { bundleHash, type CatalogueBundle, type CatalogueItem } from "../../lib/catalogue-types";
import { itemFiles, NEWER_FORMAT_STATUS } from "../../lib/community-add";
import { ShareFormatError } from "../../lib/team-share";
import type { AddPreview } from "../../lib/community-api";

const utf8 = new TextEncoder();
const entries = (files: Record<string, string>) => Object.entries(files).map(([path, text]) => ({ path, bytes: utf8.encode(text) }));

const FLOW = {
  format: 1,
  name: "Plant care",
  author: "sample-author",
  version: "1.0.0",
  summary: "Adds a watering to-do every Saturday.",
  trigger: { kind: "schedule", days: [6], time: "09:00" },
  steps: [{ id: "s1", kind: "tool", tool: "add_todo", input: { title: ["Water the plants"], area: [{ blank: "context" }] }, go: "auto", gives: [] }],
  asks: [{ key: "context", question: "Which context?", choices: [], fills: "text", pick: "area" }],
};
const ASSISTANT = {
  format: 1,
  name: "Tidy",
  job: "Turns issues into to-dos",
  instructions: "Add a to-do for each issue assigned to me.",
  triggers: [{ kind: "event", event: { source: "collected", connector: "linear", kind: "issue" } }],
  asks: [{ question: "Which context?", choices: ["Work", "None"] }],
  needs: ["linear"],
  would_like: ["add_todo", "archive_or_restore"],
  web: true,
};
const SKILL = "---\nname: packing-list\ndescription: Use when I ask what to pack.\n---\n\n1. Look at the trip.\n2. List what to pack.\n";

interface Calls {
  assistant: unknown[];
  skill: unknown[];
  flow: unknown[];
  marked: unknown[];
  replaced: unknown[];
  checkin: unknown[];
  template: unknown[];
}

function fakes(over: Partial<CommunityAddDeps> = {}): { deps: CommunityAddDeps; calls: Calls } {
  const calls: Calls = { assistant: [], skill: [], flow: [], marked: [], replaced: [], checkin: [], template: [] };
  const deps: CommunityAddDeps = {
    loadBundle: async () => {
      throw new Error("no catalogue in this test");
    },
    fetchLink: async () => entries({ "plant-care/flow.json": JSON.stringify(FLOW) }),
    catalogueAddress: () => "https://catalogue.example.com",
    existing: async () => null,
    addAssistant: async (input) => (calls.assistant.push(input), { id: "11111111-1111-4111-8111-111111111111", writing: null }),
    addSkill: async (input) => (calls.skill.push(input), { id: "22222222-2222-4222-8222-222222222222" }),
    addFlow: async (shared, answers, catalogue) => (calls.flow.push({ shared, answers, catalogue }), { id: "33333333-3333-4333-8333-333333333333" }),
    replaceAssistant: async (id, input) => (calls.replaced.push({ kind: "assistant", id, input }), { writing: null }),
    replaceSkill: async (id, input) => void calls.replaced.push({ kind: "skill", id, input }),
    replaceFlow: async (id, shared, answers, catalogue) => void calls.replaced.push({ kind: "flow", id, shared, answers, catalogue }),
    addCheckins: async (shared, catalogue, opts) => (calls.checkin.push({ shared, catalogue, opts }), { id: "44444444-4444-4444-8444-444444444444", added: 2, skipped: ["What went well today?"], off: ["evening"], full: [] }),
    replaceCheckins: async (id, shared, catalogue) => (calls.replaced.push({ kind: "checkin", id, shared, catalogue }), { id, added: 3, skipped: [], off: [], full: [] }),
    addTemplate: async (shared, catalogue) => (calls.template.push({ shared, catalogue }), { id: "55555555-5555-4555-8555-555555555555", name: `${shared.name} (2)`, renamed: true, beside: false }),
    replaceTemplate: async (id, shared, catalogue) => (calls.replaced.push({ kind: "template", id, shared, catalogue }), { id, name: shared.name, renamed: false, beside: false }),
    markCatalogue: async (kind, id, listing) => void calls.marked.push({ kind, id, listing }),
    now: () => new Date("2026-11-24T10:00:00Z"),
    ...over,
  };
  return { deps, calls };
}

async function catalogue(files: Array<{ path: string; text: string }>, kind: CatalogueItem["kind"] = "flow"): Promise<{ item: CatalogueItem; bundle: CatalogueBundle }> {
  const hash = await bundleHash(files);
  const id = "0123456789abcdef";
  const item: CatalogueItem = { id, kind, slug: "plant-care", name: "Plant care", summary: "x", author: "sample-author", version: "1.0.0", reach: { tier: 1, model: false, web: false, lookups: [], needs: [] }, needs: [], hash, min_format: 1, featured: true, added_at: "2026-11-01T00:00:00Z", bundle: `bundles/${id}.json` };
  return { item, bundle: { id, hash, kind, files } };
}

// ---------- the files ----------

test("itemFiles: the item's own folder, text files only, the rest listed as not used", () => {
  const f = itemFiles([
    ...entries({ "repo/plant-care/flow.json": JSON.stringify(FLOW), "repo/plant-care/notes.md": "# Notes", "repo/README.md": "outside the folder", "repo/plant-care/.hidden.md": "x" }),
    { path: "repo/plant-care/run.sh", bytes: utf8.encode("echo") },
    { path: "repo/plant-care/photo.md", bytes: new Uint8Array([0, 1, 2]) },
  ]);
  assert.equal(f.kind, "flow");
  assert.equal(f.folder, "plant-care");
  assert.deepEqual(f.files.map((x) => x.path), ["flow.json", "notes.md"]);
  assert.deepEqual(f.skipped.map((x) => x.path), ["photo.md", "run.sh"]);
});

test("itemFiles: nothing to read, two side by side, or a flow beside a skill are refused in words", () => {
  assert.throws(() => itemFiles(entries({ "a.md": "x" })), /no assistant\.json, SKILL\.md, flow\.json, checkin\.json or template\.json/);
  assert.throws(() => itemFiles(entries({ "a/flow.json": "{}", "b/flow.json": "{}" })), /more than one flow/);
  assert.throws(() => itemFiles(entries({ "flow.json": "{}", "SKILL.md": SKILL })), /side by side/);
});

// ---------- previews, by kind ----------

test("a flow from files: read, its reach worked out here, its hash over its own files", async () => {
  const { deps } = fakes();
  const p = await previewOf({ files: entries({ "plant-care/flow.json": JSON.stringify(FLOW) }), name: "plant-care" }, deps);
  assert.equal(p.kind, "flow");
  assert.equal(p.name, "Plant care");
  assert.deepEqual(p.header, { version: "1.0.0", author: "sample-author" });
  assert.equal(p.reach.tier, 1);
  assert.deepEqual(p.from, { files: "plant-care" });
  assert.equal(p.listing, null);
  assert.equal(p.hash, await bundleHash(p.files));
});

test("an assistant from a GitHub link: its skill beside it, a model and the web in its reach", async () => {
  const { deps } = fakes({ fetchLink: async () => entries({ "tidy/assistant.json": JSON.stringify(ASSISTANT), "tidy/SKILL.md": SKILL }) });
  const p = await previewOf({ link: "https://github.com/sample-author/athena-items/tree/main/tidy" }, deps);
  assert.equal(p.kind, "assistant");
  assert.equal(p.name, "Tidy");
  assert.equal(p.item.kind === "assistant" && p.item.skill?.body.includes("List what to pack"), true);
  assert.deepEqual([p.reach.tier, p.reach.model, p.reach.web, p.reach.needs], [3, true, true, ["linear"]]);
});

test("a skill from files: tier 2, named by its title", async () => {
  const { deps } = fakes();
  const p = await previewOf({ files: entries({ "SKILL.md": SKILL, "reference/forgotten.md": "- Charger" }) }, deps);
  assert.equal(p.kind, "skill");
  assert.equal(p.name, "Packing list");
  assert.equal(p.reach.tier, 2);
  assert.deepEqual(p.files.map((f) => f.path), ["SKILL.md", "reference/forgotten.md"]);
});

test("a catalogue listing: checked against its hash, and refused when its files don't match", async () => {
  const files = [{ path: "flow.json", text: JSON.stringify(FLOW) }];
  const good = await catalogue(files);
  const p = await previewOf({ catalogue: good.item.id }, fakes({ loadBundle: async () => good, existing: async () => ({ id: "x", version: "0.9.0", hash: "sha256-old" }) }).deps);
  assert.deepEqual(p.from, { catalogue: good.item.id });
  assert.equal(p.listing?.featured, true);
  assert.deepEqual(p.existing, { id: "x", version: "0.9.0", href: "#/flows/x", newer: true });
  const same = await previewOf({ catalogue: good.item.id }, fakes({ loadBundle: async () => good, existing: async () => ({ id: "x", version: "1.0.0", hash: good.item.hash }) }).deps);
  assert.equal(same.existing?.newer, false);
  const tampered = { item: good.item, bundle: { ...good.bundle, files: [{ path: "flow.json", text: JSON.stringify({ ...FLOW, name: "Changed" }) }] } };
  await assert.rejects(previewOf({ catalogue: good.item.id }, fakes({ loadBundle: async () => tampered }).deps), /don't match/);
});

test("a listing whose files are another kind is refused", async () => {
  const got = await catalogue([{ path: "flow.json", text: JSON.stringify(FLOW) }]);
  const wrong = { item: { ...got.item, kind: "skill" as const }, bundle: { ...got.bundle, kind: "skill" as const } };
  // verifyBundle checks the kind against the index too, so this never reaches the reader.
  await assert.rejects(previewOf({ catalogue: got.item.id }, fakes({ loadBundle: async () => wrong }).deps));
});

test("links: GitHub only, a flow.json read as its folder", () => {
  assert.deepEqual(parseAddLink("https://github.com/sample-author/athena-items/blob/main/plant-care/flow.json"), { kind: "github", owner: "sample-author", repo: "athena-items", ref: "main", path: "plant-care" });
  assert.equal(parseAddLink("https://raw.githubusercontent.com/sample-author/athena-items/main/plant-care/flow.json").path, "plant-care");
  assert.throws(() => parseAddLink("https://athena.example.com/flow.json"), /GitHub links only/);
  assert.throws(() => parseAddLink("http://github.com/a/b"), ShareFormatError);
  assert.throws(() => parseAddLink("not a link"), ShareFormatError);
});

// ---------- adding: each kind to its own import ----------

const asSent = (p: AddPreview) => JSON.parse(JSON.stringify(p)) as AddPreview;

test("adding an assistant: paused import, only the owner's choices, answers by question", async () => {
  const { deps, calls } = fakes({ fetchLink: async () => entries({ "assistant.json": JSON.stringify(ASSISTANT) }) });
  const p = await previewOf({ link: "https://github.com/sample-author/athena-items/tree/main/tidy" }, deps);
  const { result } = await addFrom({ preview: asSent(p), choices: { answers: { "Which context?": "Work", "Not its question": "x" }, accounts: ["44444444-4444-4444-8444-444444444444"], allow: ["add_todo"], web: true } }, deps);
  assert.deepEqual(result, { kind: "assistant", id: "11111111-1111-4111-8111-111111111111", href: "#/team/11111111-1111-4111-8111-111111111111" });
  const input = calls.assistant[0] as { answers: unknown; allow: string[]; web: boolean; accounts: string[]; source: { kind: string } };
  assert.deepEqual(input.answers, [{ question: "Which context?", answer: "Work" }]);
  assert.deepEqual(input.allow, ["add_todo"]);
  assert.equal(input.web, true);
  assert.deepEqual(input.accounts, ["44444444-4444-4444-8444-444444444444"]);
  assert.equal(input.source.kind, "link");
  assert.equal(calls.marked.length, 0, "not from the catalogue: nothing to record");
});

test("adding a skill: off, whatever was sent, with the ticked accounts", async () => {
  const { deps, calls } = fakes();
  const p = await previewOf({ files: entries({ "SKILL.md": SKILL }), name: "packing-list" }, deps);
  const { result } = await addFrom({ preview: asSent(p), choices: { accounts: [], enabled: true } }, deps);
  assert.equal(result.href, "#/settings/skills/22222222-2222-4222-8222-222222222222");
  const input = calls.skill[0] as { enabled: boolean; name: string; source: { kind: string; file?: string } };
  assert.equal(input.enabled, false);
  assert.equal(input.name, "packing-list");
  assert.deepEqual([input.source.kind, input.source.file], ["upload", "packing-list"]);
});

test("adding a flow: every question answered first, then its answers by key", async () => {
  const { deps, calls } = fakes();
  const p = await previewOf({ files: entries({ "flow.json": JSON.stringify(FLOW) }) }, deps);
  await assert.rejects(addFrom({ preview: asSent(p), choices: { answers: {} } }, deps), /Answer “Which context\?” first/);
  const { result } = await addFrom({ preview: asSent(p), choices: { answers: { context: " Home " } } }, deps);
  assert.equal(result.href, "#/flows/33333333-3333-4333-8333-333333333333");
  const call = calls.flow[0] as { answers: Record<string, string>; catalogue?: unknown };
  assert.deepEqual(call.answers, { context: "Home" });
  assert.equal(call.catalogue, undefined);
});

test("adding reads the files again: a preview changed on the way back is refused", async () => {
  const { deps, calls } = fakes();
  const p = asSent(await previewOf({ files: entries({ "flow.json": JSON.stringify(FLOW) }) }, deps));
  const changed = { ...p, files: [{ path: "flow.json", text: JSON.stringify({ ...FLOW, name: "Something else" }) }] };
  await assert.rejects(addFrom({ preview: changed, choices: { answers: { context: "Home" } } }, deps), /didn't arrive whole/);
  // A preview that says it's a skill but sends a flow's files is added as what its files are.
  const relabelled = { ...p, kind: "skill", item: { kind: "skill" } };
  const { result } = await addFrom({ preview: relabelled, choices: { answers: { context: "Home" } } }, deps);
  assert.equal(result.kind, "flow");
  assert.equal(calls.skill.length, 0);
});

test("adding from the catalogue: the bundle fetched again, refused if it changed, the listing recorded", async () => {
  const skillFiles = [{ path: "SKILL.md", text: SKILL }];
  const first = await catalogue(skillFiles, "skill");
  const { deps, calls } = fakes({ loadBundle: async () => first });
  const p = asSent(await previewOf({ catalogue: first.item.id }, deps));
  const { result } = await addFrom({ preview: p, choices: {} }, deps);
  assert.equal(result.kind, "skill");
  assert.deepEqual(calls.marked, [{ kind: "skill", id: "22222222-2222-4222-8222-222222222222", listing: { id: first.item.id, hash: first.bundle.hash, version: "1.0.0" } }]);
  const newer = await catalogue([{ path: "SKILL.md", text: `${SKILL}3. Check the weather.\n` }], "skill");
  await assert.rejects(addFrom({ preview: p, choices: {} }, fakes({ loadBundle: async () => newer }).deps), /changed in the catalogue/);
});

test("a flow from the catalogue passes its listing to the flow's own import", async () => {
  const got = await catalogue([{ path: "flow.json", text: JSON.stringify(FLOW) }]);
  const { deps, calls } = fakes({ loadBundle: async () => got });
  const p = asSent(await previewOf({ catalogue: got.item.id }, deps));
  await addFrom({ preview: p, choices: { answers: { context: "Home" } } }, deps);
  assert.deepEqual((calls.flow[0] as { catalogue: unknown }).catalogue, { id: got.item.id, hash: got.bundle.hash, version: "1.0.0" });
});

test("readChoices: only the shapes, nothing else", () => {
  const c = readChoices({ answers: { a: "b", n: 3 }, accounts: ["not an id", "44444444-4444-4444-8444-444444444444"], allow: ["add_todo", 7], web: "yes", money: true, assistant_id: 9 });
  assert.deepEqual(c, { answers: { a: "b" }, accounts: ["44444444-4444-4444-8444-444444444444"], allow: ["add_todo"], web: false, money: true, assistant_id: null, replace: null, start: true });
  // Only an explicit false adds check-in questions switched off.
  assert.equal(readChoices({ start: false }).start, false);
  assert.equal(readChoices({ start: "no" }).start, true);
});

// ---------- the routes ----------

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const post = (path: string, body: BodyInit, type?: string) => new Request(`https://athena.example.com${path}`, { method: "POST", body, headers: type ? { "Content-Type": type } : {} });
const segs = (path: string) => path.split("/").filter(Boolean);

test("POST /api/community/preview: a link as JSON, files as multipart", async () => {
  const { deps } = fakes();
  const a = await handleCommunityAddRoutes(post("/api/community/preview", JSON.stringify({ link: "https://github.com/sample-author/athena-items/tree/main/plant-care" }), "application/json"), segs("/api/community/preview"), json, { deps });
  assert.equal(a!.status, 200);
  assert.equal(((await a!.json()) as { preview: AddPreview }).preview.kind, "flow");

  const form = new FormData();
  form.append("files", new Blob([SKILL]), "SKILL.md");
  form.append("path", "packing-list/SKILL.md");
  const req = new Request("https://athena.example.com/api/community/preview", { method: "POST", body: form });
  const b = await handleCommunityAddRoutes(req, segs("/api/community/preview"), json, { deps });
  assert.equal(b!.status, 200);
  const preview = ((await b!.json()) as { preview: AddPreview }).preview;
  assert.equal(preview.kind, "skill");
  assert.deepEqual(preview.from, { files: "packing-list" });
});

test("a file made for a newer Athena answers 426, so the screen can say so", async () => {
  const { deps } = fakes({ fetchLink: async () => entries({ "flow.json": JSON.stringify({ ...FLOW, format: 2 }) }) });
  const res = await handleCommunityAddRoutes(post("/api/community/preview", JSON.stringify({ link: "https://github.com/a/b/tree/main/c" }), "application/json"), segs("/api/community/preview"), json, { deps });
  assert.equal(res!.status, NEWER_FORMAT_STATUS);
  assert.match(((await res!.json()) as { error: string }).error, /newer Athena/);
});

test("POST /api/community/add: 201 with where it lives; bad input is a 400 in words", async () => {
  const { deps } = fakes();
  const p = await previewOf({ files: entries({ "flow.json": JSON.stringify(FLOW) }) }, deps);
  const ok = await handleCommunityAddRoutes(post("/api/community/add", JSON.stringify({ preview: p, choices: { answers: { context: "Home" } } }), "application/json"), segs("/api/community/add"), json, { deps });
  assert.equal(ok!.status, 201);
  assert.equal(((await ok!.json()) as { href: string }).href, "#/flows/33333333-3333-4333-8333-333333333333");
  const bad = await handleCommunityAddRoutes(post("/api/community/add", JSON.stringify({ preview: {} }), "application/json"), segs("/api/community/add"), json, { deps });
  assert.equal(bad!.status, 400);
});

test("only POST, and only its own two paths", async () => {
  const { deps } = fakes();
  const get = await handleCommunityAddRoutes(new Request("https://athena.example.com/api/community/preview"), segs("/api/community/preview"), json, { deps });
  assert.equal(get!.status, 405);
  assert.equal(await handleCommunityAddRoutes(post("/api/community/updates", "{}"), segs("/api/community/updates"), json, { deps }), null);
  assert.equal(await handleCommunityAddRoutes(post("/api/community", "{}"), segs("/api/community"), json, { deps }), null);
});

test("Update replaces only the one added from that listing, found again here; otherwise Add adds a copy", async () => {
  const files = [{ path: "flow.json", text: JSON.stringify(FLOW) }];
  const got = await catalogue(files);
  const mine = "44444444-4444-4444-8444-444444444444";
  const { deps, calls } = fakes({ loadBundle: async () => got, existing: async () => ({ id: mine, version: "0.9.0", hash: "sha256-old" }) });
  const p = await previewOf({ catalogue: got.item.id }, deps);
  const res = await handleCommunityAddRoutes(post("/api/community/add", JSON.stringify({ preview: p, choices: { answers: { context: "Home" }, replace: mine } }), "application/json"), segs("/api/community/add"), json, { deps });
  assert.equal(res!.status, 200);
  assert.deepEqual(await res!.json(), { kind: "flow", id: mine, href: `#/flows/${mine}`, updated: true });
  assert.equal(calls.flow.length, 0, "no copy");
  assert.deepEqual((calls.replaced[0] as { id: string; answers: unknown; catalogue: unknown }).answers, { context: "Home" });
  assert.deepEqual((calls.replaced[0] as { catalogue: unknown }).catalogue, { id: got.item.id, hash: got.item.hash, version: "1.0.0" });
  // Some other id, or one that isn't from the catalogue, is refused; nothing changes.
  await assert.rejects(addFrom({ preview: p, choices: { answers: { context: "Home" }, replace: "55555555-5555-4555-8555-555555555555" } }, deps), /isn't the one you added/);
  const fromFiles = await previewOf({ files: entries({ "flow.json": JSON.stringify(FLOW) }) }, deps);
  await assert.rejects(addFrom({ preview: fromFiles, choices: { answers: { context: "Home" }, replace: mine } }, deps), /Only something added from Community/);
  // Without replace, Add adds a second copy beside it.
  const copy = await addFrom({ preview: p, choices: { answers: { context: "Home" } } }, deps);
  assert.equal(copy.result.updated, undefined);
  assert.equal(calls.flow.length, 1);
  assert.equal(calls.replaced.length, 1);
});

test("a lone file renamed on the way is read by what it holds", async () => {
  const { deps } = fakes();
  assert.equal((await previewOf({ files: entries({ "flow (1).json": JSON.stringify(FLOW) }) }, deps)).kind, "flow");
  assert.equal((await previewOf({ files: entries({ "tidy.json": JSON.stringify(ASSISTANT) }) }, deps)).kind, "assistant");
  assert.equal((await previewOf({ files: entries({ "packing.md": SKILL }) }, deps)).kind, "skill");
  await assert.rejects(previewOf({ files: entries({ "notes.md": "Just some notes" }) }, deps), /no assistant\.json, SKILL\.md, flow\.json, checkin\.json or template\.json/);
});

// ---------- check-in questions ----------

const CHECKINS = {
  format: 1,
  name: "Small joys",
  summary: "Three gentle questions for the end of the day.",
  author: "sample-author",
  questions: [
    { prompt: "What made you smile today?", kinds: ["evening"], type: "text", placeholder: "Something small counts.", deeper: false },
    { prompt: "What went well today?", kinds: ["evening"], type: "text" },
    { prompt: "How calm do you feel?", kinds: ["evening"], type: "scale", lead: "Right now I feel", levels: ["tense", "a bit tense", "steady", "calm", "very calm"], id: "own_x", mirror: "health_stress", pinned: true },
  ],
};

test("check-in questions: a link to checkin.json previews as its folder, read by its own reader, always tier 1", async () => {
  assert.deepEqual(parseAddLink("https://github.com/sample-author/athena-items/blob/main/small-joys/checkin.json").path, "small-joys");
  const { deps } = fakes({ fetchLink: async () => entries({ "small-joys/checkin.json": JSON.stringify(CHECKINS) }) });
  const p = await previewOf({ link: "https://github.com/sample-author/athena-items/tree/main/small-joys" }, deps);
  assert.equal(p.kind, "checkin");
  assert.equal(p.name, "Small joys");
  assert.equal(p.reach.tier, 1);
  assert.ok(p.item.kind === "checkin");
  if (p.item.kind === "checkin") {
    // The owner's own fields in the file (an id, a mirror, a pin) are dropped.
    assert.deepEqual(Object.keys(p.item.checkins.questions[2]).sort(), ["kinds", "lead", "levels", "prompt", "type"]);
  }
});

test("check-in questions: Add hands them to their own import and says what joined, what was skipped and what's off", async () => {
  const { deps, calls } = fakes();
  const preview = await previewOf({ files: entries({ "small-joys/checkin.json": JSON.stringify(CHECKINS) }) }, deps);
  const { result } = await addFrom({ preview, choices: {} }, deps);
  assert.equal(result.kind, "checkin");
  assert.equal(result.href, "#/settings/checkins");
  assert.deepEqual(result.checkins, { added: 2, skipped: ["What went well today?"], off: ["evening"], full: [] });
  assert.equal(calls.checkin.length, 1);
  assert.equal(calls.marked.length, 0);
  // "Start asking them" is the default; "Add them switched off" sends start: false.
  assert.deepEqual((calls.checkin[0] as { opts: unknown }).opts, { start: true });
  await addFrom({ preview, choices: { start: false } }, deps);
  assert.deepEqual((calls.checkin[1] as { opts: unknown }).opts, { start: false });
});

test("check-in questions from the catalogue: the listing goes with them, and Update replaces only that set", async () => {
  const files = [{ path: "checkin.json", text: JSON.stringify(CHECKINS) }];
  const got = await catalogue(files, "checkin");
  const setId = "44444444-4444-4444-8444-444444444444";
  const { deps, calls } = fakes({ loadBundle: async () => got, existing: async () => ({ id: setId, version: "0.9", hash: `sha256-${"0".repeat(64)}` }) });
  const preview = await previewOf({ catalogue: got.item.id }, deps);
  assert.equal(preview.existing?.newer, true);
  assert.equal(preview.existing?.href, "#/settings/checkins");
  const added = await addFrom({ preview, choices: {} }, deps);
  assert.deepEqual((calls.checkin[0] as { catalogue: unknown }).catalogue, { id: got.item.id, hash: got.item.hash, version: "1.0.0" });
  assert.equal(added.result.updated, undefined);
  const updated = await addFrom({ preview, choices: { replace: setId } }, deps);
  assert.equal(updated.result.updated, true);
  assert.deepEqual(updated.result.checkins, { added: 3, skipped: [], off: [], full: [] });
  assert.equal((calls.replaced[0] as { kind: string }).kind, "checkin");
});

test("check-in questions: an unknown kind of answer is refused with words, and nothing is added", async () => {
  const bad = { ...CHECKINS, questions: [{ prompt: "Draw your day", kinds: ["evening"], type: "sketch" }] };
  const { deps, calls } = fakes();
  await assert.rejects(previewOf({ files: entries({ "checkin.json": JSON.stringify(bad) }) }, deps), (e: Error) => e instanceof ShareFormatError && /“sketch”, which this Athena doesn't know/.test(e.message));
  assert.equal(calls.checkin.length, 0);
});

// ---------- note templates ----------

const TEMPLATE = {
  format: 1,
  name: "Weekly review",
  summary: "A soft look back at the week.",
  author: "slow-sundays",
  version: "1.2",
  body: '# A gentle look back at {{week}}\n\n## What I\'m glad happened\n\n[A song](https://music.example.com/x "embed")\n\n## One kind thing for next week',
};

test("templates: a link to template.json previews as its folder, read by its own reader and made plain, always tier 1", async () => {
  assert.deepEqual(parseAddLink("https://github.com/sample-author/athena-items/blob/main/weekly-review/template.json"), parseAddLink("https://github.com/sample-author/athena-items/tree/main/weekly-review"));
  const { deps } = fakes({ fetchLink: async () => entries({ "weekly-review/template.json": JSON.stringify({ ...TEMPLATE, reach: { tier: 3 }, extra: "dropped" }) }) });
  const p = await previewOf({ link: "https://github.com/sample-author/athena-items/tree/main/weekly-review" }, deps);
  assert.equal(p.kind, "template");
  assert.equal(p.reach.tier, 1);
  assert.ok(p.item.kind === "template" && !p.item.template.body.includes('"embed"'));
  assert.ok(p.item.kind === "template" && !("extra" in p.item.template));
});

test("templates: Add hands them to their own import, which says the name it took", async () => {
  const { deps, calls } = fakes();
  const preview = await previewOf({ files: entries({ "weekly-review/template.json": JSON.stringify(TEMPLATE) }) }, deps);
  const { result } = await addFrom({ preview, choices: {} }, deps);
  assert.deepEqual(result, { kind: "template", id: "55555555-5555-4555-8555-555555555555", href: "#/notes?template=55555555-5555-4555-8555-555555555555", template: { name: "Weekly review (2)", renamed: true, beside: false } });
  assert.equal(calls.template.length, 1);
  // A file or a link records no listing.
  assert.equal((calls.template[0] as { catalogue?: unknown }).catalogue, undefined);
});

test("templates from the catalogue: the listing goes with them; Update replaces only that one, and says when it went beside a changed copy", async () => {
  const listed = await catalogue([{ path: "template.json", text: JSON.stringify(TEMPLATE) }], "template");
  const mine = "66666666-6666-4666-8666-666666666666";
  const { deps, calls } = fakes({ loadBundle: async () => listed, existing: async () => ({ id: mine, version: "1.0", hash: `sha256-${"0".repeat(64)}`, changed: true }) });
  const preview = await previewOf({ catalogue: listed.item.id }, deps);
  assert.deepEqual(preview.existing, { id: mine, version: "1.0", href: `#/notes?template=${mine}`, newer: true, changed: true });
  await addFrom({ preview, choices: { replace: null } }, deps);
  assert.deepEqual((calls.template[0] as { catalogue: unknown }).catalogue, { id: listed.item.id, hash: listed.item.hash, version: "1.0.0" });
  const beside = "77777777-7777-4777-8777-777777777777";
  const { deps: d2, calls: c2 } = fakes({ loadBundle: async () => listed, existing: async () => ({ id: mine, version: "1.0", hash: "x", changed: true }), replaceTemplate: async () => ({ id: beside, name: "Weekly review (2)", renamed: true, beside: true }) });
  const { result } = await addFrom({ preview, choices: { replace: mine } }, d2);
  assert.deepEqual(result, { kind: "template", id: beside, href: `#/notes?template=${beside}`, updated: true, template: { name: "Weekly review (2)", renamed: true, beside: true } });
  assert.equal(c2.template.length, 0);
  // Not the one from this listing: refused.
  await assert.rejects(addFrom({ preview, choices: { replace: "88888888-8888-4888-8888-888888888888" } }, d2), (e: Error) => e instanceof ShareFormatError);
});

test("templates: a body that isn't text is refused with words, and nothing is added", async () => {
  const { deps, calls } = fakes();
  await assert.rejects(previewOf({ files: entries({ "template.json": JSON.stringify({ ...TEMPLATE, body: { html: "<p>" } }) }) }, deps), (e: Error) => e instanceof ShareFormatError && /body: should be text/.test(e.message));
  assert.equal(calls.template.length, 0);
});
