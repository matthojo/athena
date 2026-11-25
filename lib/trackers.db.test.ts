// Tracking on a real database (migration 0073, lib/trackers-store.ts), end to end for three kinds of thing:
//  - a price (a preset on a saved product): its save-time price as the first check, the back-fill, record_value
//    through Ask's real Session with its receipt and What Ask did's Undo, unchanged prices kept, honest refusals,
//    another currency refused, a target set and undone, reached and told, the best price now on Saved's list and
//    in find_saved, tracker_history;
//  - stock (a preset state): started by the track tool, a change of state is news, "tell me when it's in stock",
//    Undo stops it;
//  - followers (a number on its own, higher is better), started by a Team assistant: the assistant's id from the
//    turn, its link in a scheduled run's message, a new high told first, the same count again a quiet run.
// Then the /api/trackers routes, the limits, sealing at rest and a saved item's trackers going with it.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/trackers.db.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { Anthropic } from "./ai";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";
const TZ = "Europe/London";
const KIT = "https://shop.example.com/en-gb/product/racing-car-kit";
const TOY_BARN = "https://toys.example.co.uk/kits/racing-car-kit";
const CHANNEL = "https://video.example.com/@sample-channel";

before(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM trackers`);
  await qRaw(`DELETE FROM ask_activity`);
  await qRaw(`DELETE FROM saved_items`);
  await qRaw(`TRUNCATE team_runs, team_events, team_triggers, ask_skills, team_assistants, ask_plans CASCADE`);
  // A copy from before assistants' triggers moved to flows (lib/team-flows.ts): Team's own trigger path.
  await qRaw(`DELETE FROM settings WHERE key = 'team.triggers_moved'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const { useSavedStore } = await import("./saved");
  const blobs = new Map<string, Uint8Array>();
  useSavedStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, new Uint8Array(v)), get: async (k: string) => (blobs.has(k) ? blobs.get(k)!.buffer : null), delete: async (k: string) => void blobs.delete(k) }) as never);
});

/** Save a product page as the app does, the page read by a stand-in (no network). */
async function saveProduct(link: string, facts: Record<string, string>) {
  const { saveItem } = await import("./saved");
  const read = async () => ({ status: "preview" as const, title: facts.name, site: facts.shop, thing: { type: "product" as const, facts } });
  return (await saveItem({ url: link, source: "app" }, { read })).item;
}

/** Ask's real write side, with no model: each tool is run as a turn would run it. */
async function session() {
  const { Session } = await import("./assistant");
  return new Session(new Date(), TZ, { client: {} as never, capture: false });
}

const run = async (s: Awaited<ReturnType<typeof session>>, name: string, input: unknown) => JSON.parse(await s.run(name, input));

// ---------- a price ----------

test("price: a save keeps the price as its price tracker's first check, once; the back-fill does the same for older items", { skip }, async () => {
  const { listTrackers, keepSavePoint, backfillSavePoints } = await import("./trackers-store");
  const { qRaw } = await import("./db");
  const item = await saveProduct(KIT, { name: "Racing car kit", price: "42", currency: "GBP", shop: "Brick & Co" });
  const [t] = await listTrackers({ saved_id: item.id });
  assert.deepEqual([t.preset, t.label, t.prefix, t.currency, t.direction, t.name, t.url], ["price", "price", "£", "GBP", "lower", "Racing car kit", KIT]);
  assert.deepEqual(
    t.points.map((p) => [p.value, p.source, p.url, p.checked_by, p.checked_at]),
    [["42", "Brick & Co", KIT, "save", item.saved_at]],
  );
  assert.equal(await keepSavePoint(item), false, "once");
  // A page with no price has nothing tracked.
  const plain = await saveProduct("https://shop.example/scarf", { name: "Scarf" });
  assert.deepEqual(await listTrackers({ saved_id: plain.id }), []);

  // As if saved before 0073: no tracker at all. The back-fill makes it, and a rerun adds none.
  const mug = await saveProduct("https://homeware.example.com/stoneware-mug", { name: "Stoneware mug", price: "16", currency: "GBP", shop: "Hollis & Hart" });
  await qRaw(`DELETE FROM trackers WHERE saved_id = $1`, [mug.id]);
  assert.ok((await backfillSavePoints()) >= 1);
  assert.equal(await backfillSavePoints(), 0);
  // Reading one item's trackers back-fills that item on its own.
  await qRaw(`DELETE FROM trackers WHERE saved_id = $1`, [mug.id]);
  assert.equal((await listTrackers({ saved_id: mug.id }))[0].points[0].value, "16");
});

test("price: record_value through Ask, kept with its link, the same price too; a new low is news; Undo in What Ask did", { skip }, async () => {
  const { listTrackers } = await import("./trackers-store");
  const { logChanges, undoActivity, getActivity } = await import("./ask-activity");
  const { applyUndo } = await import("./assistant");
  const { listSaved } = await import("./saved");
  const item = (await listSaved({ q: "Racing car" })).items[0];
  const s = await session();
  const out = await run(s, "record_value", { saved_id: item.id, value: "34", currency: "GBP", url: TOY_BARN, source: "Toy Barn" });
  assert.ok(out.done, JSON.stringify(out));
  assert.deepEqual(out.news, { best: true, changed: true, target_reached: false });
  assert.equal(out.tell, true);
  assert.equal(out.say, "£34 at Toy Barn, the lowest since you saved it. Say this first.");
  const [change] = s.changes;
  assert.equal(change.kind, "tracker");
  assert.equal(change.title, "Racing car kit");
  assert.equal(change.detail, "Price checked · £34 at Toy Barn · Lowest yet");
  assert.deepEqual(change.open, { kind: "saved", id: item.id });
  assert.equal(change.news?.tell, true);
  // The same price again is a check too, and isn't news.
  const again = await run(s, "record_value", { tracker_id: out.tracker_id, value: "34", currency: "GBP", url: TOY_BARN, source: "Toy Barn" });
  assert.equal(again.tell, false);
  assert.equal(again.say, undefined);
  assert.equal(s.changes[1].detail, "Price checked · £34 at Toy Barn");
  let [t] = await listTrackers({ saved_id: item.id });
  assert.deepEqual(t.points.map((p) => [p.value, p.checked_by]), [["42", "save"], ["34", "ask"], ["34", "ask"]]);

  // What Ask did keeps the receipt; its Undo hides that one check.
  const [logged] = await logChanges([s.changes[1]], { source: "ask", thread_id: null });
  await undoActivity(logged.activity_id!, (op) => applyUndo(op));
  assert.equal((await getActivity(logged.activity_id!))!.state, "undone");
  [t] = await listTrackers({ saved_id: item.id });
  assert.deepEqual(t.points.map((p) => p.value), ["42", "34"]);
  await applyUndo(s.changes[1].undo);
  assert.equal((await listTrackers({ saved_id: item.id }))[0].points.length, 2, "Undo twice is harmless");
});

test("price: a guess, a range, a symbol, another currency or no link keeps nothing", { skip }, async () => {
  const { listTrackers } = await import("./trackers-store");
  const { listSaved } = await import("./saved");
  const item = (await listSaved({ q: "Racing car" })).items[0];
  const before = (await listTrackers({ saved_id: item.id }))[0].points.length;
  const s = await session();
  for (const bad of [
    { value: "about 35", currency: "GBP", url: TOY_BARN },
    { value: "30-40", currency: "GBP", url: TOY_BARN },
    { value: "£34", currency: "GBP", url: TOY_BARN },
    { value: "34", currency: "pounds", url: TOY_BARN },
    { value: "29", currency: "EUR", url: "https://shop.example.com/de-de/product/racing-car-kit" },
    { value: "34", currency: "GBP", url: "toys.example.co.uk" },
    { value: "34", currency: "GBP", url: "javascript:alert(1)" },
  ]) {
    const out = await run(s, "record_value", { saved_id: item.id, ...bad });
    assert.ok(out.error, JSON.stringify(bad));
  }
  assert.match((await run(s, "record_value", { saved_id: item.id, value: "29", currency: "EUR", url: TOY_BARN })).error, /in GBP; a price in EUR isn't kept here and is never converted/);
  assert.equal(s.changes.length, 0);
  assert.equal((await listTrackers({ saved_id: item.id }))[0].points.length, before);
  assert.match((await run(s, "record_value", { tracker_id: "00000000-0000-4000-8000-000000000000", value: "1", url: TOY_BARN })).error, /isn't there/);
  const scarf = (await listSaved({ q: "Scarf" })).items[0];
  assert.match((await run(s, "record_value", { saved_id: scarf.id, value: "12", url: TOY_BARN })).error, /has no price tracker\. Use track/);
});

test("price: a target set with Undo, reached by a check and told; tracker_history reads it; the list shows the best price now", { skip }, async () => {
  const { trackerOn } = await import("./trackers-store");
  const { applyUndo } = await import("./assistant");
  const { ReadTools } = await import("./ask-tools");
  const { listSaved, getSaved } = await import("./saved");
  const item = await saveProduct("https://toys.example.co.uk/kits/supercar-kit", { name: "Supercar kit", price: "35", currency: "GBP", shop: "Toy Barn" });
  const s = await session();
  // Set £30 (none before), then replace with £33: Undo of the second puts £30 back, Undo of the first clears it.
  const first = await run(s, "set_tracker_target", { saved_id: item.id, value: "30" });
  assert.ok(first.done, JSON.stringify(first));
  assert.equal(s.changes[0].detail, "Target · £30 or less");
  await run(s, "set_tracker_target", { saved_id: item.id, value: "33" });
  let t = (await trackerOn(item.id, { preset: "price" }))!;
  assert.deepEqual([t.target!.op, t.target!.value, t.target!.set_by], ["lte", "33", "ask"]);
  await applyUndo(s.changes[1].undo);
  assert.equal((await trackerOn(item.id, { preset: "price" }))!.target!.value, "30");
  await applyUndo(s.changes[0].undo);
  assert.equal((await trackerOn(item.id, { preset: "price" }))!.target, null);
  assert.ok((await run(s, "set_tracker_target", { saved_id: item.id, value: "about 30" })).error, "a guess is refused");

  // With a £33 target, a £34 check isn't told; £32.50 is, plainly, first.
  await run(s, "set_tracker_target", { saved_id: item.id, value: "33" });
  const above = await run(s, "record_value", { saved_id: item.id, value: "34", currency: "GBP", url: TOY_BARN, source: "Toy Barn" });
  assert.equal(above.target_reached, undefined);
  assert.equal(above.tell, true, "still the lowest since it was saved");
  const under = await run(s, "record_value", { saved_id: item.id, value: "32.50", currency: "GBP", url: TOY_BARN, source: "Toy Barn" });
  assert.equal(under.target_reached, true);
  assert.equal(under.say, "£32.50 at Toy Barn, under the £33 you asked for. Say this first.");
  assert.match(s.changes.at(-1)!.detail, /^Price checked · £32\.50 at Toy Barn · Lowest yet · At your target$/);

  const tools = new ReadTools({ tz: TZ, cite: (kind, id) => `${kind}:${id}` });
  const [h] = JSON.parse(await tools.run("tracker_history", { saved_id: item.id }));
  assert.equal(h.ref, `saved:${item.id}`);
  assert.deepEqual(h.target, { wants: "£33 or less", op: "lte", value: "33", reached: true });
  assert.equal(h.says, "£32.50 at Toy Barn, under the £33 you asked for.");
  assert.equal(h.first.value, "£35");
  assert.equal(h.checks, 3);
  // Clearing is one call, with Undo.
  const n = s.changes.length;
  await run(s, "set_tracker_target", { saved_id: item.id, clear: true });
  assert.equal(s.changes[n].detail, "Target cleared · was £33 or less");
  await applyUndo(s.changes[n].undo);
  t = (await trackerOn(item.id, { preset: "price" }))!;
  assert.equal(t.target!.value, "33");

  // Saved's list and find_saved say the best price now; the item's own page keeps the saved price.
  const listed = (await listSaved({ q: "Supercar" })).items[0];
  assert.deepEqual(listed.price_now, { amount: "32.50", currency: "GBP", shop: "Toy Barn" });
  assert.equal((await getSaved(item.id))!.price_now, undefined);
  const found = await run(s, "find_saved", { query: "Supercar" });
  assert.equal(found[0].what, "Product · £32.50 · Toy Barn");
  const mug = (await listSaved({ q: "Stoneware" })).items[0];
  assert.equal(mug.price_now, undefined, "only its saved price: nothing replaces it");
});

// ---------- stock ----------

test("stock: track starts it; a change of state is news; 'tell me when it's in stock'; Undo stops it", { skip }, async () => {
  const { listTrackers, getTracker } = await import("./trackers-store");
  const { applyUndo } = await import("./assistant");
  const { listSaved } = await import("./saved");
  const item = (await listSaved({ q: "Racing car" })).items[0];
  const s = await session();
  const started = await run(s, "track", { saved_id: item.id, preset: "stock", target: {} });
  assert.ok(started.tracker_id, JSON.stringify(started));
  assert.equal(s.changes[0].detail, "Tracking stock · Tell me when it's in stock");
  const t = (await getTracker(started.tracker_id))!;
  assert.deepEqual([t.kind, t.states, t.direction, t.target!.op, t.target!.value, t.url], ["state", ["in stock", "sold out"], "change", "eq", "in stock", KIT]);
  // The same preset twice is the one already there; a price and stock side by side.
  assert.match((await run(s, "track", { saved_id: item.id, preset: "stock" })).done, /^Already tracking stock/);
  assert.deepEqual((await listTrackers({ saved_id: item.id })).map((x) => x.preset).sort(), ["price", "stock"]);

  const sold = await run(s, "record_value", { tracker_id: t.id, value: "Sold out", url: TOY_BARN, source: "Toy Barn" });
  assert.equal(sold.tell, false, "the first check: nothing to compare");
  assert.equal((await run(s, "record_value", { tracker_id: t.id, value: "sold out", url: TOY_BARN, source: "Toy Barn" })).tell, false, "the same state again is only kept");
  assert.ok((await run(s, "record_value", { tracker_id: t.id, value: "available", url: TOY_BARN })).error, "only its states");
  const back = await run(s, "record_value", { saved_id: item.id, preset: "stock", value: "in stock", url: TOY_BARN, source: "Toy Barn" });
  assert.deepEqual(back.news, { best: false, changed: true, target_reached: true });
  assert.equal(back.tell, true);
  assert.equal(s.changes.at(-1)!.detail, "Stock checked · In stock at Toy Barn · Was sold out · At your target");
  assert.equal(back.say, "In stock at Toy Barn. You asked to hear when it was. Say this first.");

  // Undo of track stops it, checks and all; the price tracker stays.
  await applyUndo(s.changes[0].undo);
  assert.equal(await getTracker(t.id), null);
  assert.deepEqual((await listTrackers({ saved_id: item.id })).map((x) => x.preset), ["price"]);
});

// ---------- followers, on their own ----------

type Block = Record<string, unknown>;
type Params = Anthropic.MessageCreateParamsNonStreaming;

/** A model that gives each reply in turn (the last again after that), and keeps what it was sent. */
function scripted(replies: Array<Block[] | ((p: Params) => Block[])>) {
  const sent: Params[] = [];
  const client = {
    messages: {
      async create(params: Params): Promise<Anthropic.Message> {
        sent.push(JSON.parse(JSON.stringify(params)) as Params);
        const r = replies[Math.min(sent.length - 1, replies.length - 1)];
        const content = typeof r === "function" ? r(params) : r;
        const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
        return { id: `m${sent.length}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: stop, content } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}
const NO_ASK = { question: "", options: [], more: [] };
const answer = (input: Record<string, unknown>): Block => ({ type: "tool_use", id: "done", name: "answer", input: { found: true, general: false, from_today: false, sources: [], next: [], ask: NO_ASK, ...input } });
const opened = (id: string, link: string, title: string, text: string): Block[] => [
  { type: "server_tool_use", id, name: "web_fetch", input: { url: link } },
  { type: "web_fetch_tool_result", tool_use_id: id, content: { type: "web_fetch_result", url: link, retrieved_at: "2026-11-20T17:00:05Z", content: { type: "document", title, source: { type: "text", media_type: "text/plain", data: text } } } },
];
const keep = (id: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name: "record_value", input });

test("followers: an assistant tracks them on their own; its link waits for the owner, then its run opens it, a new high is told first, the same count again is quiet", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { runWords } = await import("./team-run");
  const { asTrackerChecker, getTracker, listTrackers, updateTracker } = await import("./trackers-store");
  const { applyUndo } = await import("./assistant");
  const wren = await createAssistant({ name: "Wren", job: "Keeps an eye on my channel", web: true, triggers: [{ kind: "schedule", days: [1], time: "09:00" }] });
  const s = await session();
  const started = await asTrackerChecker(wren.id, () => run(s, "track", { name: "My channel", url: CHANNEL, label: "Followers", kind: "number", direction: "higher" }));
  const t = (await getTracker(started.tracker_id))!;
  assert.deepEqual([t.saved_id, t.name, t.label, t.direction, t.url, t.assistant_id], [null, "My channel", "followers", "higher", CHANNEL, wren.id], "the assistant that started it checks it");
  assert.equal(s.changes[0].detail, "Tracking followers");
  assert.equal(s.changes[0].open, null);
  await asTrackerChecker(wren.id, () => run(s, "record_value", { tracker_id: t.id, value: "12,400", url: CHANNEL, source: "Video" }));
  assert.deepEqual([(await getTracker(t.id))!.points[0].checked_by, (await getTracker(t.id))!.points[0].who], ["assistant", "Wren"]);
  assert.equal((await listTrackers({ standalone: true })).length, 1);
  assert.equal((await listTrackers({ assistant_id: wren.id }))[0].id, t.id);
  // A target, at or over by default for higher-is-better.
  assert.equal((await run(s, "set_tracker_target", { tracker_id: t.id, value: "13000" })).done !== undefined, true);
  assert.equal((await getTracker(t.id))!.target!.op, "gte");

  // The link is the assistant's choice, not the owner's: kept as hers, and a run isn't given it to open.
  assert.deepEqual([t.url_set_by, t.run_url], ["assistant", null]);
  const m0 = scripted([[answer({ text: "Nothing to check yet.", sources: [] })]]);
  await runAssistantTurn(wren.id, "Every Monday at 09:00: do your job.", { mode: "run", client: m0.client, now: new Date("2026-11-16T09:00:00Z"), shown: "Every Monday at 09:00", noMemory: true });
  const before0 = JSON.stringify(m0.sent[0].messages);
  assert.ok(before0.includes(`Tracker ${t.id}: My channel`), "the tracker is in the run's message");
  assert.ok(!before0.includes(CHANNEL) && !before0.includes("Link:"), "with no link it may open: it looks it up by name");
  // The owner saves the link as theirs (the app's tracker sheet): from now on a run may open it.
  await updateTracker(t.id, { url: CHANNEL }, { by: "owner" });
  assert.deepEqual([(await getTracker(t.id))!.url_set_by, (await getTracker(t.id))!.run_url], ["owner", CHANNEL]);

  // A scheduled run: the tracker's link is in its message (so it may open it), and record_value runs alone.
  const m = scripted([
    [...opened("wf1", CHANNEL, "sample-channel - Video", "sample-channel. 12.6K subscribers. 12,612 followers."), keep("k1", { tracker_id: t.id, value: "12612", url: CHANNEL, source: "Video" })],
    [answer({ text: "I checked your channel this morning.", sources: [] })],
  ]);
  const out = await runAssistantTurn(wren.id, "Every Monday at 09:00: do your job.", { mode: "run", client: m.client, now: new Date("2026-11-23T09:00:00Z"), shown: "Every Monday at 09:00" });
  const message = JSON.stringify(m.sent[0].messages);
  assert.ok(message.includes(`Tracker ${t.id}: My channel`), "the tracker is in the run's message");
  assert.ok(message.includes(`Link: ${CHANNEL}`), "with its link, as the owner's own");
  assert.match(message, /Followers: last 12,400 followers at Video/);
  const fetch = (m.sent[0].tools ?? []).find((x) => (x as { name?: string }).name === "web_fetch") as unknown as { url_sources: { user_input: unknown } };
  assert.deepEqual(fetch.url_sources.user_input, { type: "all" });
  const kept = (out.reply.changes ?? []).find((c) => c.kind === "tracker")!;
  assert.equal(kept.detail, "Checked · 12,612 followers at Video · Highest yet");
  assert.equal((await getTracker(t.id))!.points.at(-1)!.checked_by, "assistant", "kept as Wren's, alone, with no Go");
  // News first, in the kept words and on the card.
  assert.match(out.text, /^12,612 followers at Video, the highest so far\. I checked your channel this morning\./);
  const words = runWords(wren, { text: out.text, found: out.reply.found, changes: out.reply.changes ?? [], planned: 0 });
  assert.equal(words.quiet, false);

  // The same count next week: kept, and quiet.
  const m2 = scripted([[keep("k2", { tracker_id: t.id, value: "12612", url: CHANNEL, source: "Video" })], [answer({ text: "Still 12,612 followers.", sources: [] })]]);
  const out2 = await runAssistantTurn(wren.id, "Every Monday at 09:00: do your job.", { mode: "run", client: m2.client, now: new Date("2026-11-30T09:00:00Z"), shown: "Every Monday at 09:00" });
  assert.equal(runWords(wren, { text: out2.text, found: out2.reply.found, changes: out2.reply.changes ?? [], planned: 0 }).quiet, true);
  assert.equal((await getTracker(t.id))!.points.length, 3, "every check is kept");

  // A dip is only kept; reaching the target is told.
  const dip = await run(s, "record_value", { tracker_id: t.id, value: "12500", url: CHANNEL });
  assert.equal(dip.tell, false);
  const goal = await run(s, "record_value", { tracker_id: t.id, value: "13,050", url: CHANNEL, source: "Video" });
  assert.equal(goal.target_reached, true);
  assert.equal(goal.say, "13,050 followers at Video, over the 13,000 followers you asked for. Say this first.");
  // Undo of the check.
  await applyUndo(s.changes.at(-1)!.undo);
  assert.equal((await getTracker(t.id))!.points.at(-1)!.value, "12500");
});

test("a link a model chose for a tracker waits for the owner's Go, even on an assistant's allowlist; after Go a run may open it", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { runAssistantTurn } = await import("./team-chat");
  const { getTracker, listTrackers } = await import("./trackers-store");
  const { goPlan } = await import("./ask-plans");
  const { runPlanTool } = await import("./assistant");
  const PAGE = "https://shop.example.com/kettle?colour=blue#reviews";
  const KEPT = "https://shop.example.com/kettle?colour=blue";
  // track is on her allowlist: what she may do alone.
  const fern = await createAssistant({ name: "Fern", job: "Keeps an eye on a kettle", web: true, allow: ["track"], triggers: [{ kind: "schedule", days: [2], time: "08:00" }] });
  const before = (await listTrackers({ standalone: true })).length;
  const call: Block = { type: "tool_use", id: "t1", name: "track", input: { name: "Blue kettle", url: PAGE, label: "price", kind: "number", direction: "lower", currency: "GBP", step: "Tracking the kettle" } };
  const m = scripted([[call], [answer({ text: "I'll keep an eye on the kettle.", sources: [] })]]);
  const out = await runAssistantTurn(fern.id, "Every Tuesday at 08:00: do your job.", { mode: "run", client: m.client, now: new Date("2026-11-24T08:00:00Z"), shown: "Every Tuesday at 08:00", noMemory: true });
  assert.equal((await listTrackers({ standalone: true })).length, before, "nothing was tracked alone");
  assert.equal((out.reply.changes ?? []).length, 0);
  const plan = out.reply.plan!;
  assert.ok(plan, "it waits as a plan");
  assert.equal(plan.why, "link");
  // The Go card shows the whole link and its host, in Athena's words, not the model's step line.
  assert.equal(plan.steps[0].label, `Tracking price on shop.example.com, checking ${KEPT}`);
  // The owner's Go: the tracker is made, its link theirs, and a run may open it.
  const went = await goPlan(plan.id, [0], { run: (tool, input) => runPlanTool(tool, input), log: async (changes) => changes });
  const made = went.changes.find((c) => c.kind === "tracker")!;
  const t = (await getTracker(made.id))!;
  assert.deepEqual([t.url, t.url_set_by, t.run_url], [KEPT, "owner", KEPT], "kept without its fragment, as the card showed it");
  assert.ok(went.plan.ran, "the plan ran once");
  // Main Ask too: the owner asking to track something doesn't approve a link the model picked.
  const m2 = scripted([[{ ...call, id: "t2", input: { ...(call.input as object), name: "Red kettle", url: "https://shop.example.com/red-kettle" } }], [answer({ text: "Ready for you to confirm.", sources: [] })]]);
  const { runAsk } = await import("./answer");
  const reply = await runAsk("Track the price of the red kettle", { sources: { open: async () => ({ accounts: [], skipped: [], close: async () => undefined }) }, client: m2.client, web: async () => false }, { now: new Date("2026-11-24T09:00:00Z") });
  assert.equal(reply.plan?.why, "link", "one change the owner asked for still waits, because of its link");
  assert.equal((await listTrackers({ standalone: true })).some((x) => x.name === "Red kettle"), false);
  const { removeTracker } = await import("./trackers-store");
  await removeTracker(t.id);
});

test("who checks: Ask's track goes to the one assistant that fits, else nobody yet; the app's choice is taken as given", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { getTracker, createTracker } = await import("./trackers-store");
  const moss = await createAssistant({ name: "Moss", job: "Finds good prices for gift ideas", web: true });
  const mug = await saveProduct("https://homeware.example.com/spotted-mug", { name: "Spotted mug" });
  const s = await session();
  const one = await run(s, "track", { saved_id: mug.id, preset: "price", currency: "GBP" });
  assert.deepEqual(one.checker, { id: moss.id, name: "Moss" });
  assert.equal(one.checks, "Moss will check it.");
  assert.equal(s.changes[0].detail, "Tracking the price · Moss checks it");
  assert.equal((await getTracker(one.tracker_id))!.assistant_id, moss.id);
  // Two fit: nobody is picked.
  const nell = await createAssistant({ name: "Nell", job: "Watches prices at my favourite shops", web: true });
  const jug = await saveProduct("https://homeware.example.com/spotted-jug", { name: "Spotted jug" });
  const two = await run(s, "track", { saved_id: jug.id, preset: "price", currency: "GBP" });
  assert.equal(two.checker, null);
  assert.equal(two.checks, "Nobody is checking it yet.");
  assert.equal((await getTracker(two.tracker_id))!.assistant_id, null);
  // The app's choice is taken as given, and the owner's own tracker isn't assigned for them.
  const chosen = await createTracker({ name: "Kettle", label: "price", kind: "number", direction: "lower", currency: "GBP", assistant_id: nell.id }, { by: "owner" });
  assert.equal(chosen.tracker.assistant_id, nell.id);
  const mine = await createTracker({ name: "Toaster", label: "price", kind: "number", direction: "lower", currency: "GBP" }, { by: "owner" });
  assert.equal(mine.tracker.assistant_id, null);
});

test("taking it on: an assistant's check on a tracker nobody checks makes it the checker; the owner's choice is never overwritten", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { asTrackerChecker, createTracker, getTracker, listTrackers, trackerOn, updateTracker, recordPoint } = await import("./trackers-store");
  const juno = await createAssistant({ name: "Juno", job: "Finds good prices for gift ideas", web: true, triggers: [{ kind: "schedule", days: [5], time: "17:00" }] });
  const otto = await createAssistant({ name: "Otto", job: "Watches prices at my favourite shops", web: true });
  const PAGE = "https://homeware.example.com/cast-iron-pot";

  // The save-time tracker: nobody checks it and nobody chose (keepSavePoint is unchanged).
  const pot = await saveProduct(PAGE, { name: "Cast iron pot", price: "250", currency: "GBP", shop: "Hollis & Hart" });
  const saved = (await trackerOn(pot.id, { preset: "price" }))!;
  assert.deepEqual([saved.assistant_id, saved.assistant_set_by], [null, null]);

  // Ask's own check takes nothing on: only an assistant becomes a checker.
  const s = await session();
  const byAsk = await run(s, "record_value", { saved_id: pot.id, value: "245", url: PAGE, source: "Hollis & Hart", currency: "GBP" });
  assert.equal(byAsk.took_on, undefined);
  assert.equal((await getTracker(saved.id))!.assistant_id, null);

  // Juno's first check takes it on, in the same statement, and says so.
  const first = await asTrackerChecker(juno.id, () => run(s, "record_value", { saved_id: pot.id, value: "240", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.equal(first.took_on, true);
  assert.match(first.checks, /yours now/);
  assert.match(s.changes.at(-1)!.detail, / · Juno checks it now$/);
  const after = (await getTracker(saved.id))!;
  assert.deepEqual([after.assistant_id, after.assistant_set_by], [juno.id, "assistant"]);
  assert.ok((await listTrackers({ assistant_id: juno.id })).some((t) => t.id === saved.id), "her page lists it, and her runs check it");

  // Otto's check on it is kept, and Juno stays the checker.
  const second = await asTrackerChecker(otto.id, () => run(s, "record_value", { saved_id: pot.id, value: "239", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.equal(second.took_on, undefined);
  assert.doesNotMatch(s.changes.at(-1)!.detail, /checks it now/);
  assert.equal((await getTracker(saved.id))!.assistant_id, juno.id);

  // The owner's "Just me" (assistant_id null, sent) is never taken on.
  const mine = await createTracker({ name: "Allotment waiting list", label: "place", kind: "number", direction: "lower", url: "https://example.org/allotments", assistant_id: null }, { by: "owner" });
  assert.deepEqual([mine.tracker.assistant_id, mine.tracker.assistant_set_by], [null, "owner"]);
  const tried = await asTrackerChecker(juno.id, () => recordPoint(mine.tracker.id, { value: "14", url: "https://example.org/allotments" }, { by: "assistant", assistantId: juno.id }));
  assert.equal(tried.took_on, false);
  assert.equal((await getTracker(mine.tracker.id))!.assistant_id, null, "still just the owner");

  // The owner's choice of another assistant stays.
  const given = await createTracker({ name: "Bike", label: "price", kind: "number", direction: "lower", currency: "GBP", assistant_id: otto.id }, { by: "owner" });
  const juno2 = await recordPoint(given.tracker.id, { value: "900", url: "https://example.org/bike" }, { by: "assistant", assistantId: juno.id });
  assert.equal(juno2.took_on, false);
  assert.equal((await getTracker(given.tracker.id))!.assistant_id, otto.id);

  // "Just me" chosen later from the block's menu: the next assistant's check doesn't take it back.
  await updateTracker(saved.id, { assistant_id: null }, { by: "owner" });
  assert.deepEqual([(await getTracker(saved.id))!.assistant_id, (await getTracker(saved.id))!.assistant_set_by], [null, "owner"]);
  const third = await asTrackerChecker(juno.id, () => run(s, "record_value", { saved_id: pot.id, value: "238", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.equal(third.took_on, undefined);
  assert.equal((await getTracker(saved.id))!.assistant_id, null);

  // A tracker nobody chose for, stopped: nothing is taken on (it isn't there to check).
  const stock = await createTracker({ saved_id: pot.id, preset: "stock" }, { by: "owner" });
  assert.equal(stock.tracker.assistant_set_by, null, "started with no choice sent");
  const { removeTracker } = await import("./trackers-store");
  await removeTracker(stock.tracker.id);
  await assert.rejects(recordPoint(stock.tracker.id, { value: "in stock", url: PAGE }, { by: "assistant", assistantId: juno.id }));
});

test("0074 marks every tracker made before it as the owner's choice, so no assistant takes one on", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { readFileSync } = await import("node:fs");
  const { getTracker, recordPoint } = await import("./trackers-store");
  const { createAssistant } = await import("./team");
  const ivy = await createAssistant({ name: "Ivy", job: "Finds good prices for gift ideas", web: true });
  // A tracker as it was before 0074: no checker, and no record of who chose.
  const [old] = await qRaw<{ id: string }>(`INSERT INTO trackers (name, label, kind, direction) VALUES ('Old thing', 'count', 'number', 'change') RETURNING id`);
  await qRaw(`UPDATE trackers SET assistant_set_by = NULL WHERE id = $1::uuid`, [old.id]);
  const sql = readFileSync(new URL("../netlify/database/migrations/0074_tracker-checker/migration.sql", import.meta.url), "utf8");
  const update = sql.match(/^UPDATE trackers[^;]*;/m)![0];
  await qRaw(update);
  assert.equal((await getTracker(old.id))!.assistant_set_by, "owner", "it reads as Just me");
  const r = await recordPoint(old.id, { value: "3", url: "https://example.org/old" }, { by: "assistant", assistantId: ivy.id });
  assert.equal(r.took_on, false);
  assert.equal((await getTracker(old.id))!.assistant_id, null);
});

test("record_value starts tracking a saved product nothing tracks: hers, the check kept; again reuses it; full, refused, stopped and bad values keep nothing", { skip }, async () => {
  const { createAssistant } = await import("./team");
  const { asTrackerChecker, createTracker, getTracker, listTrackers, removeTracker } = await import("./trackers-store");
  const { applyUndo } = await import("./assistant");
  const ada = await createAssistant({ name: "Ada", job: "Finds good prices for gift ideas", web: true });
  const PAGE = "https://homeware.example.com/retro-toaster";
  // A product page saved without a price read: nothing is tracked on it.
  const toaster = await saveProduct(PAGE, { name: "Retro toaster", shop: "Hollis & Hart" });
  assert.equal((await listTrackers({ saved_id: toaster.id })).length, 0);
  const s = await session();

  // Ask keeps today's behaviour: it needs track first.
  const byAsk = await run(s, "record_value", { saved_id: toaster.id, value: "149.99", url: PAGE, currency: "GBP" });
  assert.match(byAsk.error, /no price tracker/);
  assert.equal((await listTrackers({ saved_id: toaster.id })).length, 0);

  // A value that isn't the page's own: nothing kept, and nothing left started.
  const bad = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: toaster.id, value: "about 150", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.ok(bad.error);
  assert.equal((await listTrackers({ saved_id: toaster.id })).length, 0, "the tracker it started went with the refused check");

  // Ada reads it: tracking starts, hers, with the check.
  const first = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: toaster.id, value: "149.99", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.equal(first.started, true);
  assert.match(first.checks, /You started tracking this/);
  assert.match(s.changes.at(-1)!.detail, / · Ada started tracking it$/);
  const t = (await getTracker(first.tracker_id))!;
  assert.deepEqual([t.saved_id, t.preset, t.currency, t.assistant_id, t.assistant_set_by, t.points.length], [toaster.id, "price", "GBP", ada.id, "assistant", 1]);
  assert.ok((await listTrackers({ assistant_id: ada.id })).some((x) => x.id === t.id), "her page lists it");

  // Her next check reuses it.
  const second = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: toaster.id, value: "139.99", url: PAGE, source: "Hollis & Hart", currency: "GBP" }));
  assert.equal(second.started, undefined);
  assert.equal(second.tracker_id, t.id);
  assert.equal((await listTrackers({ saved_id: toaster.id })).length, 1);
  assert.equal((await getTracker(t.id))!.points.length, 2);
  // Stock, with its preset, is a second tracker of hers.
  const stock = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: toaster.id, preset: "stock", value: "in stock", url: PAGE, source: "Hollis & Hart" }));
  assert.equal(stock.started, true);

  // Undo of the check that started it stops the tracker; stopped, it isn't started again.
  await applyUndo(s.changes.at(-1)!.undo);
  assert.equal(await getTracker(stock.tracker_id), null);
  const again = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: toaster.id, preset: "stock", value: "in stock", url: PAGE }));
  assert.match(again.error, /stopped tracking its stock/);

  // A saved item with as many trackers as it can have: refused, with why, and nothing kept.
  const kettle = await saveProduct("https://homeware.example.com/retro-kettle", { name: "Retro kettle", shop: "Hollis & Hart" });
  for (const label of ["a", "b", "c", "d", "e", "f"]) await createTracker({ saved_id: kettle.id, label: `count ${label}`, kind: "number", direction: "change" }, { by: "owner" });
  const full = await asTrackerChecker(ada.id, () => run(s, "record_value", { saved_id: kettle.id, value: "99", url: "https://homeware.example.com/retro-kettle", currency: "GBP" }));
  assert.equal(full.error, "Couldn't start tracking it, so nothing was kept. A saved item can have 6 trackers. Remove one first.");
  assert.equal((await listTrackers({ saved_id: kettle.id })).length, 6);
  void removeTracker;
});

test("several sources on a real tracker: reached while any shop's current price meets it, named in the summary", { skip }, async () => {
  const { recordPoint, setTarget, getTracker } = await import("./trackers-store");
  const item = await saveProduct("https://shop.example.com/en-gb/product/sports-car-kit", { name: "Sports car kit", price: "349.99", currency: "GBP", shop: "Brick & Co" });
  const t = (await (await import("./trackers-store")).trackerOn(item.id, { preset: "price" }))!;
  await setTarget(t.id, { value: "300" }, { by: "owner" });
  const deals = await recordPoint(t.id, { value: "299", url: "https://deals.example.co.uk/sports-car-kit", source: "Deal Depot" }, { by: "ask" });
  assert.equal(deals.news.target_reached, true);
  const toyBarn = await recordPoint(t.id, { value: "329.99", url: "https://toys.example.co.uk/sports-car-kit", source: "Toy Barn" }, { by: "ask" });
  assert.equal(toyBarn.news.target_reached, false, "the dearer check isn't news");
  const after = (await getTracker(t.id))!;
  assert.equal(after.summary!.target_reached, true, "Deal Depot still meets it");
  assert.equal(after.summary!.reached_by!.id, deals.point.id);
  assert.equal(after.summary!.now!.id, deals.point.id);
});

// ---------- routes, limits, sealing ----------

test("GET, POST, PATCH and DELETE /api/trackers, its points, and Undo", { skip }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { listSaved } = await import("./saved");
  const mug = (await listSaved({ q: "Stoneware" })).items[0];
  const send = async (method: string, path: string, json?: unknown) => {
    const res = await api(new Request(`https://athena.test/api${path}`, { method, headers: { Authorization: "Bearer master-token-for-tests", ...(json !== undefined ? { "Content-Type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined }), {} as never);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const item = await send("GET", `/trackers?saved_id=${mug.id}`);
  assert.equal(item.status, 200);
  const price = item.body.trackers[0];
  assert.equal(price.preset, "price");
  assert.equal(price.summary.first.checked_by, "save");
  assert.equal(price.summary.fresh, true, "saved today");
  // The owner's own check by hand, without a link.
  const added = await send("POST", `/trackers/${price.id}/points`, { value: "14", source: "Hollis & Hart" });
  assert.equal(added.status, 201);
  assert.equal(added.body.point.checked_by, "owner");
  assert.equal(added.body.news.best, true);
  assert.equal((await send("POST", `/trackers/${price.id}/points`, { value: "about 14" })).status, 400);
  assert.equal((await send("DELETE", `/trackers/${price.id}/points/${price.points[0].id}`)).status, 409, "never the save point");
  assert.equal((await send("DELETE", `/trackers/${price.id}/points/${added.body.point.id}`)).status, 200);
  assert.equal((await send("GET", `/trackers/${price.id}`)).body.tracker.points.length, 1);
  assert.equal((await send("POST", `/trackers/${price.id}/points/${added.body.point.id}/restore`)).status, 200);
  assert.equal((await send("GET", `/trackers/${price.id}`)).body.tracker.points.length, 2);
  // A target by PATCH, cleared with null.
  const set = await send("PATCH", `/trackers/${price.id}`, { target: { value: "12" } });
  assert.equal(set.status, 200);
  assert.deepEqual([set.body.tracker.target.op, set.body.tracker.target.value, set.body.tracker.target.set_by, set.body.was.target], ["lte", "12", "owner", null]);
  assert.equal((await send("PATCH", `/trackers/${price.id}`, { target: { value: "under 12" } })).status, 400);
  assert.equal((await send("PATCH", `/trackers/${price.id}`, { target: null })).body.tracker.target, null);

  // One on its own, described by the owner; the same again is the one there.
  const made = await send("POST", `/trackers`, { name: "Octopus tariff", url: "https://octopus.energy/tariffs", label: "rate", kind: "number", direction: "change", suffix: "p a kWh" });
  assert.equal(made.status, 201);
  assert.equal(made.body.tracker.saved_id, null);
  assert.equal((await send("POST", `/trackers`, { name: "Octopus tariff", label: "rate", kind: "number", direction: "change" })).status, 200);
  assert.equal((await send("POST", `/trackers`, { label: "rate", kind: "number", direction: "change" })).status, 400, "on its own it needs a name");
  assert.equal((await send("POST", `/trackers`, { saved_id: "00000000-0000-4000-8000-000000000000", preset: "price" })).status, 404);
  const renamed = await send("PATCH", `/trackers/${made.body.tracker.id}`, { name: "Octopus Agile", suffix: "p/kWh" });
  assert.deepEqual([renamed.body.tracker.name, renamed.body.tracker.suffix], ["Octopus Agile", "p/kWh"]);
  assert.ok((await send("GET", `/trackers?standalone=1`)).body.trackers.some((x: { id: string }) => x.id === made.body.tracker.id));
  // Stop and Undo.
  assert.equal((await send("DELETE", `/trackers/${made.body.tracker.id}`)).status, 200);
  assert.equal((await send("GET", `/trackers/${made.body.tracker.id}`)).status, 404);
  assert.equal((await send("POST", `/trackers/${made.body.tracker.id}/restore`)).body.tracker.name, "Octopus Agile");
  assert.equal((await send("GET", `/trackers/not-an-id`)).status, 404);
  // A check on one tracker can't be removed through another.
  assert.equal((await send("DELETE", `/trackers/${made.body.tracker.id}/points/${added.body.point.id}`)).status, 404);
});

test("limits: six trackers on a saved item", { skip }, async () => {
  const { createTracker } = await import("./trackers-store");
  const item = await saveProduct("https://shop.example/limits", { name: "Limits" });
  for (const label of ["one", "two", "three", "four", "five", "six"]) await createTracker({ saved_id: item.id, label, kind: "number", direction: "higher" }, { by: "owner" });
  await assert.rejects(createTracker({ saved_id: item.id, label: "seven", kind: "number", direction: "higher" }, { by: "owner" }), /can have 6 trackers/);
});

test("sealed at rest: names, links, labels, states, targets and values are ciphertext; kinds and who checked stay readable", { skip }, async () => {
  const { qRaw } = await import("./db");
  const trackers = await qRaw<{ label: string; url: string | null; name: string; states: string[]; target_value: string | null; kind: string }>(`SELECT label, url, name, states, target_value, kind FROM trackers`);
  assert.ok(trackers.length >= 4);
  for (const r of trackers) {
    assert.doesNotMatch(r.label, /^(price|stock|followers|rate)$/);
    if (r.url) assert.doesNotMatch(r.url, /^https?:/);
    if (r.name) assert.notEqual(r.name, "My channel");
    for (const st of r.states) assert.notEqual(st, "in stock");
    if (r.target_value) assert.doesNotMatch(r.target_value, /^\d/);
    assert.match(r.kind, /^(number|state)$/);
  }
  const points = await qRaw<{ value: string; source: string | null; url: string | null; checked_by: string }>(`SELECT value, source, url, checked_by FROM tracker_points`);
  assert.ok(points.length >= 8);
  for (const p of points) {
    assert.doesNotMatch(p.value, /^\d|^in stock|^sold out/);
    if (p.url) assert.doesNotMatch(p.url, /^https?:/);
    if (p.source) assert.notEqual(p.source, "Toy Barn");
    assert.match(p.checked_by, /^(save|owner|ask|assistant)$/);
  }
  const { ENCRYPTED } = await import("./encryption");
  assert.deepEqual(ENCRYPTED.find((t) => t.table === "trackers")?.text, ["name", "url", "label", "prefix", "suffix", "target_value"]);
  assert.deepEqual(ENCRYPTED.find((t) => t.table === "tracker_points")?.text, ["value", "source", "url"]);
});

test("a saved item's trackers go with it", { skip }, async () => {
  const { deleteSaved, listSaved } = await import("./saved");
  const { listTrackers } = await import("./trackers-store");
  const { qRaw } = await import("./db");
  const item = (await listSaved({ q: "Racing car" })).items[0];
  assert.ok((await listTrackers({ saved_id: item.id })).length > 0);
  await deleteSaved(item.id);
  assert.equal((await qRaw(`SELECT 1 FROM trackers WHERE saved_id = $1`, [item.id])).length, 0);
});

test("migration 0088: a tracker link from before 0085 is approved once as the owner's; one a model chose since is not", { skip }, async () => {
  const { readFile } = await import("node:fs/promises");
  const { createTracker, getTracker } = await import("./trackers-store");
  const { qRaw } = await import("./db");
  const OLD = "https://shop.example.com/garden-hose";
  const NEW = "https://shop.example.com/desk-lamp";
  const old = (await createTracker({ name: "Garden hose", url: OLD, label: "price", kind: "number", direction: "lower" }, { by: "owner" })).tracker.id;
  const fresh = (await createTracker({ name: "Desk lamp", url: NEW, label: "price", kind: "number", direction: "lower" }, { by: "owner" })).tracker.id;
  // As a copy from before 0085 kept it: no record of who set the link, so no run opens it.
  await qRaw(`UPDATE trackers SET url_set_by = NULL WHERE id = $1::uuid`, [old]);
  // And one since 0085 whose link a model chose, not yet approved.
  await qRaw(`UPDATE trackers SET url_set_by = 'ask' WHERE id = $1::uuid`, [fresh]);
  assert.equal((await getTracker(old))!.run_url, null);
  assert.equal((await getTracker(fresh))!.run_url, null);

  const sql = await readFile(new URL("../netlify/database/migrations/0088_tracker-links-approved/migration.sql", import.meta.url), "utf8");
  await qRaw(sql);
  await qRaw(sql); // safe to run twice
  assert.deepEqual([(await getTracker(old))!.url_set_by, (await getTracker(old))!.run_url], ["owner", OLD], "the old link keeps working");
  assert.deepEqual([(await getTracker(fresh))!.url_set_by, (await getTracker(fresh))!.run_url], ["ask", null], "a model's link set since still waits for Go");
});
