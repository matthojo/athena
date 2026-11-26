// Community: reading the catalogue (netlify/lib/community-catalogue.ts) and its routes (community-routes.ts), with a
// fake fetch, a cache in memory and a store in memory. Made-up items and an example.com catalogue only.
// Run: npx tsx --test netlify/lib/community-catalogue.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundleHash, CatalogueError, type CatalogueBundle, type CatalogueIndex, type CatalogueItem } from "../../lib/catalogue-types";
import { catalogueDeps, checkIndex, compareInstalled, flowTier, getIndex, INDEX_TTL_MS, knowsAllKinds, loadBundle, RECHECK_MS, RETRY_MS, pauseKey, readableItems, toPause, type CachedIndex, type InstalledItem } from "./community-catalogue";
import { catalogueView, communityUpdates, handleCommunityRoutes, type CommunityStore } from "./community-routes";
import type { FlowStep } from "../../lib/flow-types";
import { SHARE_KINDS } from "../../lib/share-kinds";

const ROOT = "https://catalogue.example.com/v1";
const T0 = new Date("2026-11-24T09:00:00Z");
const SKILL_MD = "---\nname: packing-list\ndescription: Use when packing for a trip.\n---\nList what to pack.\n";
const ID_A = "a1b2c3d4e5f6g7h8";
const ID_B = "b2c3d4e5f6g7h8j9";
const ID_GONE = "c3d4e5f6g7h8j9k0";

async function skillBundle(id: string, text = SKILL_MD): Promise<CatalogueBundle> {
  const files = [{ path: "SKILL.md", text }];
  return { id, kind: "skill", hash: await bundleHash(files), files };
}

function item(id: string, hash: string, over: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    id,
    kind: "skill",
    slug: `item-${id.slice(0, 4)}`,
    name: "Packing list",
    summary: "Builds a packing list from the trip and the forecast.",
    author: "sample-author",
    version: "1.0",
    reach: { tier: 2, model: true, web: false, lookups: [], needs: [] },
    needs: [],
    hash,
    min_format: 1,
    featured: false,
    added_at: "2026-11-01T10:00:00Z",
    bundle: `bundles/${id}.json`,
    ...over,
  };
}

function index(items: CatalogueItem[], withdrawn: CatalogueIndex["withdrawn"] = []): CatalogueIndex {
  return { format: 1, generated_at: "2026-11-23T00:00:00Z", items, withdrawn };
}

/** A fake catalogue: paths to bodies (or a status), and every request it saw. */
function fakeCatalogue(files: Record<string, unknown>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    const path = url.slice(ROOT.length + 1);
    const body = files[path];
    if (body instanceof Error) throw body;
    if (typeof body === "number") return new Response("nope", { status: body });
    if (body && typeof body === "object" && "redirect" in body) return new Response(null, { status: 302, headers: { location: String((body as { redirect: string }).redirect) } });
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

let kept: CachedIndex | null = null;
let now = T0;
let on = true;
const saved = { ...catalogueDeps };

beforeEach(() => {
  kept = null;
  now = T0;
  on = true;
  Object.assign(catalogueDeps, saved, {
    root: () => ROOT,
    on: async () => on,
    now: () => now,
    cache: { get: async () => kept, set: async (c: CachedIndex) => void (kept = c) },
  });
});

function use(files: Record<string, unknown>) {
  const cat = fakeCatalogue(files);
  catalogueDeps.fetch = cat.fetch;
  return cat;
}

// ---------- fetching and the cache ----------

test("the index is fetched from the catalogue's root with nothing about this Athena in the request", async () => {
  const b = await skillBundle(ID_A);
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  const read = await getIndex();
  assert.equal(read.index.items.length, 1);
  assert.equal(read.cached, false);
  assert.equal(cat.seen.length, 1);
  const { url, init } = cat.seen[0];
  assert.equal(url, `${ROOT}/index.json`);
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.body, undefined);
  assert.deepEqual(Object.keys(init.headers as Record<string, string>), ["Accept"]);
});

test("the index is kept for a day, then read again", async () => {
  const b = await skillBundle(ID_A);
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  await getIndex();
  now = new Date(T0.getTime() + INDEX_TTL_MS - 1000);
  assert.equal((await getIndex()).cached, true);
  assert.equal(cat.seen.length, 1);
  now = new Date(T0.getTime() + INDEX_TTL_MS + 1000);
  assert.equal((await getIndex()).cached, false);
  assert.equal(cat.seen.length, 2);
});

test("a copy kept for another catalogue isn't used", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: "https://other.example.com", fetched_at: T0.toISOString(), index: index([]) };
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  assert.equal((await getIndex()).index.items.length, 1);
  assert.equal(cat.seen.length, 1);
});

test("when the catalogue can't be reached, the last copy is used and the reason given", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: ROOT, fetched_at: new Date(T0.getTime() - 2 * INDEX_TTL_MS).toISOString(), index: index([item(ID_A, b.hash)]) };
  use({ "index.json": new TypeError("fetch failed") });
  const read = await getIndex();
  assert.equal(read.index.items.length, 1);
  assert.match(read.error ?? "", /couldn't reach/);
});

test("with no copy and no answer, it throws words for the owner", async () => {
  use({ "index.json": 500 });
  await assert.rejects(getIndex(), (e: Error) => e instanceof CatalogueError && /didn't send its list/.test(e.message));
  use({ "index.json": "{ not json" });
  await assert.rejects(getIndex(), /couldn't read/);
});

test("an index that breaks the schema is refused whole", async () => {
  use({ "index.json": { format: 1, generated_at: "2026-11-23T00:00:00Z", items: [{ id: "x" }], withdrawn: [] } });
  await assert.rejects(getIndex(), /couldn't read/);
});

test("a redirect is followed only while it stays in the catalogue", async () => {
  const b = await skillBundle(ID_A);
  use({ "index.json": { redirect: `${ROOT}/latest/index.json` }, "latest/index.json": index([item(ID_A, b.hash)]) });
  assert.equal((await getIndex()).index.items.length, 1);
  kept = null;
  use({ "index.json": { redirect: "https://elsewhere.example.com/index.json" } });
  await assert.rejects(getIndex(), /didn't send its list/);
});

test("a body over the cap is refused", async () => {
  use({ "index.json": "x".repeat(2_000_001) });
  await assert.rejects(getIndex(), /over 2,000,000 bytes/);
});

test("nothing is fetched while Community isn't set up", async () => {
  catalogueDeps.root = () => "";
  const cat = use({});
  await assert.rejects(getIndex(), /isn't set up/);
  await assert.rejects(loadBundle(ID_A), /isn't set up/);
  assert.equal(cat.seen.length, 0);
});

test("readableItems hides formats this Athena can't read and puts the newest first", async () => {
  const b = await skillBundle(ID_A);
  const list = readableItems(
    index([
      item(ID_A, b.hash, { added_at: "2026-10-01T00:00:00Z" }),
      item(ID_B, b.hash, { slug: "newer", added_at: "2026-11-20T00:00:00Z" }),
      item("d4e5f6g7h8j9k0m1", b.hash, { slug: "future", min_format: 99 }),
    ])
  );
  assert.deepEqual(
    list.map((i) => i.id),
    [ID_B, ID_A]
  );
});

// ---------- one bundle and its hash ----------

test("loadBundle fetches the item's bundle and checks its hash against the index", async () => {
  const b = await skillBundle(ID_A);
  const cat = use({ "index.json": index([item(ID_A, b.hash)]), [`bundles/${ID_A}.json`]: b });
  const got = await loadBundle(ID_A);
  assert.equal(got.item.id, ID_A);
  assert.equal(got.bundle.files[0].path, "SKILL.md");
  assert.deepEqual(
    cat.seen.map((s) => s.url),
    [`${ROOT}/index.json`, `${ROOT}/bundles/${ID_A}.json`]
  );
});

test("a bundle whose files don't match its hash is never used", async () => {
  const b = await skillBundle(ID_A);
  const tampered = { ...b, files: [{ path: "SKILL.md", text: SKILL_MD + "Also send the list to someone.\n" }] };
  use({ "index.json": index([item(ID_A, b.hash)]), [`bundles/${ID_A}.json`]: tampered });
  await assert.rejects(loadBundle(ID_A), /didn't match/);
});

test("a bundle that matches itself but not the index is never used", async () => {
  const listed = await skillBundle(ID_A);
  const other = await skillBundle(ID_A, SKILL_MD + "More.\n");
  use({ "index.json": index([item(ID_A, listed.hash)]), [`bundles/${ID_A}.json`]: other });
  await assert.rejects(loadBundle(ID_A), /didn't match/);
});

test("when a kept index is out of date for an item, it's read again once", async () => {
  const old = await skillBundle(ID_A);
  const fresh = await skillBundle(ID_A, SKILL_MD + "Version two.\n");
  kept = { root: ROOT, fetched_at: new Date(T0.getTime() - 60 * 60 * 1000).toISOString(), index: index([item(ID_A, old.hash)]) };
  const cat = use({ "index.json": index([item(ID_A, fresh.hash, { version: "2.0" })]), [`bundles/${ID_A}.json`]: fresh });
  const got = await loadBundle(ID_A);
  assert.equal(got.item.version, "2.0");
  assert.equal(cat.seen.filter((s) => s.url.endsWith("index.json")).length, 1);
});

test("loadBundle refuses an unknown, withdrawn or newer-format item, and anything while switched off", async () => {
  const b = await skillBundle(ID_A);
  use({ "index.json": index([item(ID_A, b.hash, { min_format: 99 })], [{ id: ID_GONE, at: "2026-11-20T00:00:00Z", reason: "It stopped working with the new labels." }]) });
  await assert.rejects(loadBundle("not-an-id"), /isn't in the Community catalogue/);
  await assert.rejects(loadBundle(ID_B), /isn't in the Community catalogue/);
  await assert.rejects(loadBundle(ID_GONE), /taken down.*new labels/);
  await assert.rejects(loadBundle(ID_A), /newer version of Athena/);
  on = false;
  const cat = use({});
  await assert.rejects(loadBundle(ID_A), /switched off/);
  assert.equal(cat.seen.length, 0);
});

// ---------- updates and withdrawals ----------

const row = (over: Partial<InstalledItem> = {}): InstalledItem => ({ kind: "skill", id: "00000000-0000-4000-8000-000000000001", catalogue_id: ID_A, catalogue_hash: "sha256-" + "0".repeat(64), catalogue_version: "1.0", on: true, ...over });

test("compareInstalled says when the listing's hash changed, and nothing when it didn't", async () => {
  const b = await skillBundle(ID_A);
  const idx = index([item(ID_A, b.hash, { version: "1.1", summary: "Now with the forecast." })]);
  const [check] = compareInstalled([row()], idx);
  assert.deepEqual(check.newer, { version: "1.1", hash: b.hash, summary: "Now with the forecast.", reach: idx.items[0].reach });
  assert.equal(check.withdrawn, null);
  assert.deepEqual(compareInstalled([row({ catalogue_hash: b.hash })], idx), []);
  // Not listed and not withdrawn: nothing to say.
  assert.deepEqual(compareInstalled([row({ catalogue_id: ID_B })], idx), []);
});

test("compareInstalled carries the catalogue's reason for a withdrawal", () => {
  const idx = index([], [{ id: ID_A, at: "2026-11-20T00:00:00Z", reason: "It stopped working with the new labels." }]);
  const [check] = compareInstalled([row()], idx);
  assert.equal(check.newer, null);
  assert.deepEqual(check.withdrawn, { at: "2026-11-20T00:00:00Z", reason: "It stopped working with the new labels." });
});

test("toPause pauses a withdrawn item once, and never one already off", () => {
  const idx = index([], [{ id: ID_A, at: "2026-11-20T00:00:00Z", reason: "Broken." }]);
  const r = row();
  assert.deepEqual(toPause([r], idx, new Set()), [r]);
  assert.deepEqual(toPause([r], idx, new Set([pauseKey(r)])), []);
  assert.deepEqual(toPause([row({ on: false })], idx, new Set()), []);
  assert.deepEqual(toPause([row({ catalogue_id: ID_B })], idx, new Set()), []);
});

test("flowTier works a flow's tier out from its steps, branches included", () => {
  const tool = (t: string) => ({ kind: "tool", tool: t, input: {}, go: "auto", gives: [] }) as unknown as FlowStep;
  assert.equal(flowTier([tool("add_todo")]), 1);
  assert.equal(flowTier([tool("weather")]), 2);
  assert.equal(flowTier([{ kind: "check", condition: {}, yes: [tool("draft_email")], no: [] } as unknown as FlowStep]), 2);
  assert.equal(flowTier([{ kind: "think", task: [], web: true, gives: [] } as unknown as FlowStep]), 3);
});

// ---------- the routes ----------

function memoryStore(rows: InstalledItem[] = [], ...rest: [unknown?]) {
  // memoryStore(rows, undefined): the owner has never set the switch.
  const switchRow = rest.length ? rest[0] : { on: true };
  const state = { switchRow, paused: new Set<string>(), pausedRows: [] as InstalledItem[], saves: [] as boolean[] };
  const store: CommunityStore = {
    switchRow: async () => state.switchRow,
    saveSwitch: async (v) => {
      state.saves.push(v);
      state.switchRow = { on: v };
      return { on: v };
    },
    installed: async () => rows,
    pausedBefore: async () => new Set(state.paused),
    rememberPaused: async (keys) => keys.forEach((k) => state.paused.add(k)),
    pause: async (r) => void state.pausedRows.push(...r),
    tierHere: async () => 2,
  };
  return { store, state };
}

test("opening Community the first time switches the check on; after that the owner's choice stands", async () => {
  const b = await skillBundle(ID_A);
  use({ "index.json": index([item(ID_A, b.hash)]) });
  const first = memoryStore([], undefined);
  const view = await catalogueView(first.store);
  assert.equal(view.on, true);
  assert.deepEqual(first.state.saves, [true]);
  assert.equal(view.items.length, 1);

  const off = memoryStore([], { on: false });
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  const offView = await catalogueView(off.store);
  assert.equal(offView.on, false);
  assert.deepEqual(offView.items, []);
  assert.deepEqual(off.state.saves, []);
  assert.equal(cat.seen.length, 0);
});

test("with no catalogue set, the view says so, fetches nothing and leaves the switch alone", async () => {
  catalogueDeps.root = () => "";
  const cat = use({});
  const { store, state } = memoryStore([], undefined);
  const view = await catalogueView(store);
  assert.deepEqual(view, { configured: false, on: false, host: null, generated_at: null, fetched_at: null, items: [], added: [], error: null });
  assert.deepEqual(state.saves, []);
  assert.equal(cat.seen.length, 0);
});

test("the view lists what was added here, and an unreachable catalogue as words", async () => {
  use({ "index.json": new TypeError("fetch failed") });
  const view = await catalogueView(memoryStore([row()]).store);
  assert.deepEqual(view.added, [ID_A]);
  assert.match(view.error ?? "", /couldn't reach/);
});

test("updates: nothing is fetched while switched off or with nothing added", async () => {
  const cat = use({});
  assert.deepEqual(await communityUpdates(memoryStore([row()], { on: false }).store), []);
  assert.deepEqual(await communityUpdates(memoryStore([]).store), []);
  assert.equal(cat.seen.length, 0);
});

test("updates: a withdrawn item is paused once, and a newer listing carries the tier here", async () => {
  const b = await skillBundle(ID_B);
  use({ "index.json": index([item(ID_B, b.hash, { version: "2.0" })], [{ id: ID_A, at: "2026-11-20T00:00:00Z", reason: "Broken by a change to labels." }]) });
  const gone = row();
  const newer = row({ id: "00000000-0000-4000-8000-000000000002", catalogue_id: ID_B });
  const { store, state } = memoryStore([gone, newer]);
  const checks = await communityUpdates(store);
  assert.equal(checks.length, 2);
  assert.deepEqual(state.pausedRows, [gone]);
  assert.equal(checks.find((c) => c.catalogue_id === ID_B)?.tier_here, 2);
  // The owner switched it back on: the next check doesn't pause it again.
  await communityUpdates(store);
  assert.deepEqual(state.pausedRows, [gone]);
});

test("the routes answer GET /api/community, /updates and PUT /settings", async () => {
  const b = await skillBundle(ID_A);
  use({ "index.json": index([item(ID_A, b.hash)]) });
  const { store, state } = memoryStore([]);
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s });
  const req = (method: string) => new Request("https://athena.example.com/api/community", { method });
  const view = await handleCommunityRoutes(req("GET"), ["api", "community"], async () => null, json, store);
  assert.equal(((await view!.json()) as { items: unknown[] }).items.length, 1);
  const updates = await handleCommunityRoutes(req("GET"), ["api", "community", "updates"], async () => null, json, store);
  assert.deepEqual(await updates!.json(), { updates: [] });
  const settings = await handleCommunityRoutes(req("GET"), ["api", "community", "settings"], async () => null, json, store);
  assert.deepEqual(await settings!.json(), { on: true, configured: true, submit: "https://catalogue.example.com/submit/" });
  const put = await handleCommunityRoutes(req("PUT"), ["api", "community", "settings"], async () => ({ on: false }), json, store);
  assert.deepEqual(await put!.json(), { on: false });
  assert.deepEqual(state.saves, [false]);
  const bad = await handleCommunityRoutes(req("PUT"), ["api", "community", "settings"], async () => ({ on: "yes" }), json, store);
  assert.equal(bad!.status, 400);
  assert.equal(await handleCommunityRoutes(req("POST"), ["api", "community", "preview"], async () => null, json, store), null);
});

// ---------- a copy kept by an Athena that knew fewer kinds, and "Check for new items" ----------

/** A theme listing, for the kind an older Athena didn't know. */
const themeItem = (id: string, hash: string) => item(id, hash, { kind: "theme", slug: `theme-${id.slice(0, 4)}`, name: "Harbour" });
const KINDS_BEFORE_THEMES = SHARE_KINDS.filter((k) => k !== "theme");

test("a copy is stamped with the kinds this Athena knows", async () => {
  const b = await skillBundle(ID_A);
  use({ "index.json": index([item(ID_A, b.hash)]) });
  await getIndex();
  assert.deepEqual(kept?.kinds, [...SHARE_KINDS]);
  assert.equal(knowsAllKinds(kept!), true);
  assert.equal(knowsAllKinds({ kinds: KINDS_BEFORE_THEMES }), false);
  assert.equal(knowsAllKinds({}), false);
});

test("a copy kept by an Athena that didn't know themes is read again, however fresh", async () => {
  const b = await skillBundle(ID_A);
  // An hour old, kept by the Athena before themes: it dropped the catalogue's themes as it read.
  kept = { root: ROOT, fetched_at: new Date(T0.getTime() - 60 * 60 * 1000).toISOString(), index: index([item(ID_A, b.hash)]), kinds: KINDS_BEFORE_THEMES };
  const cat = use({ "index.json": index([item(ID_A, b.hash), themeItem(ID_B, b.hash)]) });
  const read = await getIndex();
  assert.equal(cat.seen.length, 1);
  assert.equal(read.cached, false);
  assert.deepEqual(read.index.items.map((i) => i.kind).sort(), ["skill", "theme"]);
  assert.deepEqual(kept?.kinds, [...SHARE_KINDS]);
  // And now it's kept as usual.
  assert.equal((await getIndex()).cached, true);
  assert.equal(cat.seen.length, 1);
});

test("a copy with no stamp (kept before stamping) counts as stale, and still stands in when the catalogue is down", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: ROOT, fetched_at: T0.toISOString(), index: index([item(ID_A, b.hash)]) };
  let cat = use({ "index.json": index([item(ID_A, b.hash), themeItem(ID_B, b.hash)]) });
  assert.equal((await getIndex()).index.items.length, 2);
  assert.equal(cat.seen.length, 1);

  kept = { root: ROOT, fetched_at: T0.toISOString(), index: index([item(ID_A, b.hash)]) };
  cat = use({ "index.json": new TypeError("fetch failed") });
  const read = await getIndex();
  assert.equal(read.index.items.length, 1);
  assert.match(read.error ?? "", /couldn't reach/);
});

test("check: the copy is used while it's under RECHECK_MS old, then read again", async () => {
  const b = await skillBundle(ID_A);
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  await getIndex();
  now = new Date(T0.getTime() + RECHECK_MS - 1000);
  const recent = await checkIndex();
  assert.equal(recent.cached, true);
  assert.equal(recent.fetched_at, T0.toISOString());
  assert.equal(cat.seen.length, 1);
  now = new Date(T0.getTime() + RECHECK_MS + 1000);
  const fresh = await checkIndex();
  assert.equal(fresh.cached, false);
  assert.equal(fresh.fetched_at, now.toISOString());
  assert.equal(cat.seen.length, 2);
});

test("check: a failed read keeps the copy, says why, and fetches nothing more for RETRY_MS", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: ROOT, fetched_at: new Date(T0.getTime() - 2 * RECHECK_MS).toISOString(), index: index([item(ID_A, b.hash)]), kinds: [...SHARE_KINDS] };
  const cat = use({ "index.json": new TypeError("fetch failed") });
  for (let i = 0; i < 5; i++) {
    const read = await checkIndex();
    assert.equal(read.index.items.length, 1);
    assert.match(read.error ?? "", /couldn't reach/);
  }
  assert.equal(cat.seen.length, 1, "pressed five times, read once");
  now = new Date(T0.getTime() + RETRY_MS + 1000);
  await checkIndex();
  assert.equal(cat.seen.length, 2);
});

test("check: with no copy and no answer, it throws words for the owner", async () => {
  use({ "index.json": new TypeError("fetch failed") });
  await assert.rejects(checkIndex(), /couldn't reach/);
});

test("check route: reads again only past RECHECK_MS, says which, and lists what's new", async () => {
  const b = await skillBundle(ID_A);
  const cat = use({ "index.json": index([item(ID_A, b.hash)]) });
  const { store } = memoryStore([], { on: true });
  const first = await catalogueView(store);
  assert.equal(first.fetched_at, T0.toISOString());
  assert.equal(first.checked, undefined);

  now = new Date(T0.getTime() + 60 * 1000);
  const recent = await catalogueView(store, { check: true });
  assert.equal(recent.checked, "recent");
  assert.equal(recent.fetched_at, T0.toISOString());
  assert.equal(cat.seen.length, 1);

  use({ "index.json": index([item(ID_A, b.hash), themeItem(ID_B, b.hash)]) });
  now = new Date(T0.getTime() + RECHECK_MS + 1000);
  const read = await catalogueView(store, { check: true });
  assert.equal(read.checked, "read");
  assert.equal(read.items.length, 2);
  assert.equal(read.fetched_at, now.toISOString());
});

test("check route: off means nothing is fetched, and the switch isn't turned on", async () => {
  const cat = use({ "index.json": index([]) });
  const off = memoryStore([], { on: false });
  const res = await handleCommunityRoutes(new Request("https://athena.example.com/api/community/check", { method: "POST" }), ["api", "community", "check"], async () => null, (d, s) => Response.json(d, { status: s ?? 200 }), off.store);
  const view = (await res!.json()) as { on: boolean; items: unknown[]; checked?: string };
  assert.equal(view.on, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.checked, undefined);
  const never = memoryStore([], undefined);
  assert.equal((await catalogueView(never.store, { check: true })).on, false);
  assert.deepEqual(never.state.saves, []);
  assert.equal(cat.seen.length, 0);
});

test("check route: an unreachable catalogue answers in words with the copy kept", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: ROOT, fetched_at: new Date(T0.getTime() - 2 * RECHECK_MS).toISOString(), index: index([item(ID_A, b.hash)]), kinds: [...SHARE_KINDS] };
  use({ "index.json": 503 });
  const view = await catalogueView(memoryStore([], { on: true }).store, { check: true });
  assert.equal(view.checked, "read");
  assert.equal(view.items.length, 1);
  assert.equal(view.fetched_at, kept.fetched_at);
  assert.match(view.error ?? "", /didn't send its list/);
});

test("check route: only POST", async () => {
  const res = await handleCommunityRoutes(new Request("https://athena.example.com/api/community/check"), ["api", "community", "check"], async () => null, (d, s) => Response.json(d, { status: s ?? 200 }), memoryStore().store);
  assert.equal(res!.status, 405);
});

// ---------- the index's signature ----------
import { generateKeyPairSync } from "node:crypto";
import { listedPublicKey, signIndex } from "../../lib/catalogue-signature";
import { CATALOGUE_SIGNING_KEYS } from "../../lib/catalogue-types";

/** A throwaway key pair, made for this test run only. */
const signer = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

test("Athena ships with no catalogue key listed, so the index is read unsigned", async () => {
  assert.deepEqual([...CATALOGUE_SIGNING_KEYS], []);
  const cat = use({ "index.json": index([]) });
  await getIndex();
  assert.deepEqual(cat.seen.map((s) => s.url), [`${ROOT}/index.json`]);
});

test("with a key listed, an index signed by it is read, over the exact bytes sent", async () => {
  const b = await skillBundle(ID_A);
  const body = JSON.stringify(index([item(ID_A, b.hash)]), null, 2);
  catalogueDeps.signingKeys = () => [listedPublicKey(stranger.publicKey), listedPublicKey(signer.publicKey)];
  const cat = use({ "index.json": body, "index.json.sig": `${signIndex(new TextEncoder().encode(body), signer.privateKey)}\n` });
  const read = await getIndex();
  assert.equal(read.index.items.length, 1);
  assert.equal(kept?.signed, true);
  assert.deepEqual(cat.seen.map((s) => s.url), [`${ROOT}/index.json`, `${ROOT}/index.json.sig`]);
});

test("with a key listed, a missing, altered or stranger's signature means the list isn't read", async () => {
  const b = await skillBundle(ID_A);
  const body = JSON.stringify(index([item(ID_A, b.hash)]));
  const bytes = new TextEncoder().encode(body);
  catalogueDeps.signingKeys = () => [listedPublicKey(signer.publicKey)];
  use({ "index.json": body });
  await assert.rejects(getIndex(), (e: Error) => e instanceof CatalogueError && /wasn't signed/.test(e.message));
  // The same signature over a list with one more item.
  const more = JSON.stringify(index([item(ID_A, b.hash), item(ID_B, b.hash)]));
  use({ "index.json": more, "index.json.sig": signIndex(bytes, signer.privateKey) });
  await assert.rejects(getIndex(), (e: Error) => e instanceof CatalogueError && /didn't match its signature/.test(e.message));
  use({ "index.json": body, "index.json.sig": signIndex(bytes, stranger.privateKey) });
  await assert.rejects(getIndex(), /didn't match its signature/);
  use({ "index.json": body, "index.json.sig": "not a signature" });
  await assert.rejects(getIndex(), /didn't match its signature/);
  assert.equal(kept, null);
});

test("once a key is listed, a copy kept unsigned is neither used nor fallen back on", async () => {
  const b = await skillBundle(ID_A);
  kept = { root: ROOT, fetched_at: T0.toISOString(), index: index([item(ID_A, b.hash)]), kinds: [...SHARE_KINDS] };
  catalogueDeps.signingKeys = () => [listedPublicKey(signer.publicKey)];
  use({ "index.json": JSON.stringify(index([])) });
  await assert.rejects(getIndex(), /wasn't signed/);
  await assert.rejects(checkIndex(), /wasn't signed/);
});
