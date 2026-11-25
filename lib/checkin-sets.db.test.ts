// Sets of check-in questions on real Postgres with every migration (0090 included): a shared set added through the
// store, joining the owner's own after what's there, skipping words already here, leaving a switched-off routine
// off; switched off so its questions aren't planned, back on, and removed whole; Community's withdrawal switching it
// off; and sharing the owner's own questions through the route, flagged until settled.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/checkin-sets.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the check-in tables and settings first. Made-up data only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}
const skip = !url && "set ATHENA_TEST_DB_URL";

beforeEach(async () => {
  if (!url) return;
  const { qRaw } = await import("./db");
  await qRaw(`TRUNCATE checkins, checkin_sets, people CASCADE`);
  await qRaw(`DELETE FROM days WHERE date = $1::date`, [new Date().toISOString().slice(0, 10)]);
  await qRaw(`DELETE FROM settings WHERE key IN ('checkins', 'community_paused')`);
});

const FILE = {
  format: 1 as const,
  name: "Small joys",
  summary: "Gentle questions for the end of the day.",
  questions: [
    { prompt: "What made you smile today?", kinds: ["evening" as const], type: "text" as const, deeper: false },
    { prompt: "What went well today?", kinds: ["evening" as const], type: "text" as const },
    { prompt: "What's one slow thing you'll do today?", kinds: ["morning" as const], type: "text" as const },
  ],
};
const HASH = `sha256-${"ab".repeat(32)}`;

test("add: the set joins after what's there, skips words already here, and leaves a routine off", { skip }, async () => {
  const { loadSettingsView, saveCheckinSettings, getCheckin } = await import("./checkins");
  const { addSharedCheckins } = await import("./checkin-sets");
  const { DEFAULT_CHECKIN_SETTINGS } = await import("./checkin-types");
  const start = structuredClone(DEFAULT_CHECKIN_SETTINGS);
  start.morning.enabled = true;
  await saveCheckinSettings(start);

  const got = await addSharedCheckins(FILE, { id: "0123456789abcdef", hash: HASH, version: "1.0" });
  // "What went well today?" is one of Athena's own.
  assert.deepEqual(got.skipped, ["What went well today?"]);
  assert.equal(got.added, 2);
  assert.deepEqual(got.off, ["evening"]);

  const v = await loadSettingsView();
  assert.equal(v.evening.enabled, false);
  assert.deepEqual(v.evening.questions.slice(0, start.evening.questions.length), start.evening.questions);
  assert.deepEqual(v.morning.questions.slice(0, start.morning.questions.length), start.morning.questions);
  assert.deepEqual(v.sets.map((x) => [x.name, x.catalogue_id, x.paused]), [["Small joys", "0123456789abcdef", false]]);
  assert.deepEqual(v.own.map((q) => [q.prompt, q.set]), [["What made you smile today?", got.id], ["What's one slow thing you'll do today?", got.id]]);

  // Today's morning plan can pick the new morning question.
  const today = new Date().toISOString().slice(0, 10);
  const c = await getCheckin(today, "morning", { tz: "UTC" });
  assert.ok(c.plan.length > 0);
});

test("add switched off: \"Add them switched off\" adds the set paused", { skip }, async () => {
  const { loadSettingsView } = await import("./checkins");
  const { addSharedCheckins } = await import("./checkin-sets");
  await addSharedCheckins(FILE, undefined, { start: false });
  assert.equal((await loadSettingsView()).sets[0].paused, true);
});

test("switch off, on, and remove: a paused set's questions aren't planned; removed, they're gone", { skip }, async () => {
  const { loadSettingsView, saveCheckinSettings, getCheckin } = await import("./checkins");
  const { addSharedCheckins, setCheckinSetPaused, removeCheckinSet } = await import("./checkin-sets");
  const { DEFAULT_CHECKIN_SETTINGS } = await import("./checkin-types");
  const start = structuredClone(DEFAULT_CHECKIN_SETTINGS);
  start.evening = { enabled: true, per_day: 10, questions: [{ id: "mood", pinned: true }] };
  await saveCheckinSettings(start);
  const got = await addSharedCheckins(FILE);
  const smile = (await loadSettingsView()).own.find((q) => q.prompt === "What made you smile today?")!;

  let v = await setCheckinSetPaused(got.id, true);
  assert.equal(v.sets[0].paused, true);
  const today = new Date().toISOString().slice(0, 10);
  const planned = await getCheckin(today, "evening", { tz: "UTC" });
  assert.deepEqual(planned.plan.map((q) => q.id), ["mood"]);

  v = await setCheckinSetPaused(got.id, false);
  assert.equal(v.sets[0].paused, false);

  v = await removeCheckinSet(got.id);
  assert.deepEqual(v.sets, []);
  assert.ok(!v.own.some((q) => q.id === smile.id));
  assert.deepEqual(v.evening.questions, [{ id: "mood", pinned: true }]);
});

test("start: both choices leave a routine that's off, off", { skip }, async () => {
  const { loadSettingsView, saveCheckinSettings } = await import("./checkins");
  const { addSharedCheckins, removeCheckinSet } = await import("./checkin-sets");
  const { DEFAULT_CHECKIN_SETTINGS } = await import("./checkin-types");
  await saveCheckinSettings(structuredClone(DEFAULT_CHECKIN_SETTINGS));
  for (const start of [true, false]) {
    const got = await addSharedCheckins(FILE, undefined, { start });
    const v = await loadSettingsView();
    assert.deepEqual([v.morning.enabled, v.evening.enabled], [false, false]);
    assert.deepEqual(got.off, ["morning", "evening"]);
    assert.equal(v.sets.find((x) => x.id === got.id)?.paused, !start);
    await removeCheckinSet(got.id);
  }
});

test("journal: a shared written answer goes to that day's journal, changes and undoes with it, and stays when the set is removed", { skip }, async () => {
  const { loadSettingsView, saveCheckinSettings, getCheckin, answerCheckin, clearAnswer } = await import("./checkins");
  const { addSharedCheckins, removeCheckinSet } = await import("./checkin-sets");
  const { getDay, patchDay } = await import("./days");
  const scaled = { ...FILE, questions: [...FILE.questions, { prompt: "How slow was today?", kinds: ["evening" as const], type: "scale" as const }] };
  const got = await addSharedCheckins(scaled);
  const v = await loadSettingsView();
  const smile = v.own.find((q) => q.prompt === "What made you smile today?")!;
  const slow = v.own.find((q) => q.prompt === "How slow was today?")!;
  // Athena's rule, whatever the file said: written to the journal, scale nowhere.
  assert.deepEqual([smile.mirror, slow.mirror], ["day_journal", null]);
  // The settings can't point a shared question elsewhere either.
  const tried = await saveCheckinSettings({ morning: v.morning, evening: v.evening, own: v.own.map((q) => (q.id === slow.id ? { ...q, mirror: "day_mood" } : q.id === smile.id ? { ...q, mirror: "briefing" } : q)) });
  assert.deepEqual([tried.own.find((q) => q.id === smile.id)!.mirror, tried.own.find((q) => q.id === slow.id)!.mirror], ["day_journal", null]);
  await saveCheckinSettings({ ...v, evening: { enabled: true, per_day: 10, questions: [{ id: smile.id, pinned: true }, { id: slow.id, pinned: true }] } });

  const today = new Date().toISOString().slice(0, 10);
  await patchDay(today, { journal: "My own words." }, { tz: "UTC" });
  const c = await getCheckin(today, "evening", { tz: "UTC" });
  assert.deepEqual(c.plan.map((q) => q.id), [smile.id, slow.id]);

  await answerCheckin(today, "evening", smile.id, { text: "A robin on the fence." }, { tz: "UTC" });
  await answerCheckin(today, "evening", slow.id, { scale: 4 }, { tz: "UTC" });
  assert.equal((await getDay(today, { tz: "UTC" }))?.journal, "My own words.\n\nEvening reflection\nWhat made you smile today?\nA robin on the fence.");
  assert.equal((await getDay(today, { tz: "UTC" }))?.mood, undefined);

  await answerCheckin(today, "evening", smile.id, { text: "Two robins." }, { tz: "UTC" });
  assert.equal((await getDay(today, { tz: "UTC" }))?.journal, "My own words.\n\nEvening reflection\nWhat made you smile today?\nTwo robins.");

  await clearAnswer(today, "evening", smile.id, { tz: "UTC" });
  assert.equal((await getDay(today, { tz: "UTC" }))?.journal, "My own words.");

  await answerCheckin(today, "evening", smile.id, { text: "Tea in the garden." }, { tz: "UTC" });
  const kept = (await getDay(today, { tz: "UTC" }))?.journal;
  await removeCheckinSet(got.id);
  assert.equal((await getDay(today, { tz: "UTC" }))?.journal, kept);
  assert.deepEqual((await getCheckin(today, "evening", { tz: "UTC" })).plan.map((q) => q.id), [smile.id, slow.id]);
});

test("Community: a set added from a listing is checked, and a withdrawal switches it off once", { skip }, async () => {
  const { addSharedCheckins } = await import("./checkin-sets");
  const { dbCommunityStore } = await import("../netlify/lib/community-routes");
  const got = await addSharedCheckins(FILE, { id: "0123456789abcdef", hash: HASH });
  const rows = await dbCommunityStore.installed();
  const row = rows.find((r) => r.kind === "checkin")!;
  assert.deepEqual([row.id, row.catalogue_id, row.on], [got.id, "0123456789abcdef", true]);
  await dbCommunityStore.pause([row]);
  assert.equal((await dbCommunityStore.installed()).find((r) => r.kind === "checkin")!.on, false);
  assert.equal(await dbCommunityStore.tierHere(row), 1);
});

test("share route: the owner's own questions as a file, flagged until settled, then a zip", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { saveCheckinSettings } = await import("./checkins");
  const { handleCheckinRoutes } = await import("../netlify/lib/checkins/routes");
  const { DEFAULT_CHECKIN_SETTINGS } = await import("./checkin-types");
  await qRaw(`INSERT INTO people (name) VALUES ('Robin Example')`);
  const s = structuredClone(DEFAULT_CHECKIN_SETTINGS);
  s.own = [{ id: "own_robin", type: "text", prompt: "Did you ring Robin Example?", kinds: ["evening"], deeper: false, mirror: null, preset: false }];
  await saveCheckinSettings(s);
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
  const call = (body: unknown) => handleCheckinRoutes(new Request("https://athena.example.com/api/checkins/share", { method: "POST", body: JSON.stringify(body) }), new URL("https://athena.example.com/api/checkins/share"), ["api", "checkins", "share"], json);

  const looked = await (await call({ question_ids: ["own_robin"], edits: { name: "Keeping in touch" } }))!.json();
  assert.equal(looked.shared.name, "Keeping in touch");
  assert.deepEqual(looked.findings.map((f: { term: string }) => f.term), ["Robin Example"]);
  const refused = await call({ question_ids: ["own_robin"], edits: { name: "Keeping in touch" }, download: true });
  assert.equal(refused!.status, 409);
  const zip = await call({ question_ids: ["own_robin"], edits: { name: "Keeping in touch" }, fine: looked.findings.map((f: { id: string }) => f.id), download: true });
  assert.equal(zip!.status, 200);
  assert.equal(zip!.headers.get("content-type"), "application/zip");
  // Athena's own questions can't be shared as if they were the owner's.
  const preset = await call({ question_ids: ["mood"], edits: { name: "x" } }).catch((e: Error) => e);
  assert.ok(preset instanceof Error && /Only questions you wrote/.test(preset.message));
});
