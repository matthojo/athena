// The profile learner against Postgres: the guards it loads and a full weekly run.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/profile-learner.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties the owner's facts, suggestions, events and people first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

async function reset() {
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM facts WHERE subject_kind = 'me'`);
  await qRaw(`DELETE FROM suggestions`);
  await qRaw(`DELETE FROM edges WHERE source_type = 'event'`);
  await qRaw(`DELETE FROM events`);
}

/** Meetings with someone, Monday to Friday at 10:00 and 15:00 London time, for the 8 weeks before `today`. */
async function seedMeetings(today: string) {
  const { upsertPerson, upsertEvent, linkEntities } = await import("./db");
  const person = await upsertPerson({ name: "Learner Test Colleague" });
  for (let i = 1; i <= 56; i++) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
    const wd = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    if (wd > 4) continue;
    for (const time of ["10:00", "15:00"]) {
      const ev = await upsertEvent({ title: "Sync", kind: "appointment", date, time, tz: "Europe/London" });
      await linkEntities({ sourceType: "event", sourceId: ev.id, targetType: "person", targetId: person.id });
    }
  }
}

test("ownerTypedKeys: the owner's own words in the last 90 days, not learned ones or old ones", { skip }, async () => {
  await reset();
  const { addFact } = await import("./memory");
  const { ownerTypedKeys } = await import("./profile");
  const { qRaw } = await import("./db");
  await addFact({ subject_kind: "me", key: "Sleep routine", value: "Bed by 11" }, { byOwner: true });
  const old = await addFact({ subject_kind: "me", key: "Tone", value: "Direct" }, { byOwner: true });
  await qRaw(`UPDATE facts SET created_at = now() - interval '120 days', observed_at = now() - interval '120 days' WHERE id = $1`, [old.id]);
  // An accepted suggestion keeps its confidence: learned, not typed.
  await addFact({ subject_kind: "me", key: "Working days", value: "Monday to Friday", source: "profile-learner", confidence: 0.6 }, { byOwner: true });
  assert.deepEqual([...(await ownerTypedKeys(90))].sort(), ["sleep routine"]);
});

test("a weekly run files suggestions with evidence, then respects the guards on a rerun", { skip }, async () => {
  await reset();
  const today = "2026-11-08";
  const now = new Date(`${today}T09:00:00Z`);
  await seedMeetings(today);
  const { runProfileLearner, loadGuard, LEARNER_SOURCE } = await import("./profile-learner");
  const { listSuggestions, rejectSuggestion, addFact } = await import("./memory");
  const { qRaw } = await import("./db");

  const first = await runProfileLearner({ now });
  assert.deepEqual(first.filed.map((f) => [f.key, f.value]), [["Working days", "Monday to Friday"], ["Working hours", "10 to 4"]]);
  // No liked titles to sum up: no genre call.
  assert.deepEqual(first.genres, { called: false, why: "nothing_new" });
  const filed = await listSuggestions({ status: "pending" });
  assert.equal(filed.length, 2);
  for (const s of filed) {
    assert.equal(s.source, LEARNER_SOURCE);
    assert.equal(s.source_ref, "week:2026-11-02");
    assert.ok(s.source_quote && s.source_quote.length > 20, "evidence on the suggestion");
    assert.ok(s.confidence !== null && s.confidence > 0);
    assert.match(s.summary, /^About you · Working (days|hours): /);
  }

  // Rerun: both keys are waiting in the inbox, nothing new.
  assert.deepEqual((await runProfileLearner({ now })).filed, []);
  assert.equal((await loadGuard()).filedThisWeek, 2);

  // The owner rejects one and types the other (its suggestion still waiting): neither comes back the next week.
  const days = filed.find((s) => (s.payload.key as string) === "Working days")!;
  await rejectSuggestion(days.id);
  await addFact({ subject_kind: "me", key: "Working hours", value: "8 to 4" }, { byOwner: true });
  await qRaw(`UPDATE suggestions SET created_at = now() - interval '8 days'`);
  const guard = await loadGuard();
  assert.ok(guard.rejected.has("working days"));
  assert.ok(guard.typedRecently.has("working hours"));
  assert.equal(guard.filedThisWeek, 0);
  const next = await runProfileLearner({ now: new Date(now.getTime() + 7 * 86_400_000) });
  assert.deepEqual(next.filed, []);
  assert.deepEqual(next.skipped.map((s) => s.why).sort(), ["rejected", "typed"]);

  // Over 3 months after the rejection, Athena may ask about working days again.
  const weekAfter = new Date(now.getTime() + 7 * 86_400_000);
  await qRaw(`UPDATE suggestions SET resolved_at = $1::timestamptz - interval '3 months 1 day', created_at = now() - interval '8 days' WHERE id = $2`, [weekAfter.toISOString(), days.id]);
  const later = await runProfileLearner({ now: weekAfter });
  assert.deepEqual(later.filed.map((f) => f.key), ["Working days"]);
  const asked = (await listSuggestions({ status: "pending" })).filter((s) => s.payload.key === "Working days");
  assert.deepEqual(asked.map((s) => s.source_ref), ["week:2026-11-09"]);
});

test("the value already saved is not suggested again", { skip }, async () => {
  await reset();
  const today = "2026-11-08";
  await seedMeetings(today);
  const { addFact } = await import("./memory");
  const { qRaw } = await import("./db");
  const { runProfileLearner } = await import("./profile-learner");
  // Typed long ago, so only the equal-value guard applies.
  const f = await addFact({ subject_kind: "me", key: "Working days", value: "monday to friday" }, { byOwner: true });
  await qRaw(`UPDATE facts SET created_at = now() - interval '200 days', observed_at = now() - interval '200 days' WHERE id = $1`, [f.id]);
  const report = await runProfileLearner({ now: new Date(`${today}T09:00:00Z`) });
  assert.deepEqual(report.filed.map((x) => x.key), ["Working hours"]);
  assert.deepEqual(report.skipped, [{ key: "Working days", why: "same" }]);
});
