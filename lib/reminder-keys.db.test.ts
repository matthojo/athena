// reminder_log keys for payment nudges hold a blind index of the merchant, never its name: rows
// written under the old readable format are moved, and a nudge that was sent stays
// sent, across the move and across a data key rotation.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/reminder-keys.db.test.ts
// Skipped without ATHENA_TEST_DB_URL.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
const KEY = process.env.ATHENA_DATA_KEY ?? "22".repeat(32);
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY = KEY;
}
const skip = !url && "set ATHENA_TEST_DB_URL";

test("payment nudge keys: old readable rows are moved to the merchant's index, and nothing fires twice", { skip }, async () => {
  const { q, claimReminder, claimIndexedReminder } = await import("./db");
  const { blindIndexes } = await import("./data-box");
  const { paymentNudges } = await import("./nudges");
  const { sealLegacyPaymentKeys } = await import("../netlify/functions/reminders");
  const index = (merchant: string) => blindIndexes("other", `regular\u0000${merchant}`);
  const mine = () => q<{ key: string; sent_at: Date }>(`SELECT key, sent_at FROM reminder_log WHERE key LIKE 'regular-%' OR key LIKE 'pay-%' ORDER BY key`);
  const clear = () => q(`DELETE FROM reminder_log WHERE key LIKE 'regular-%' OR key LIKE 'pay-%'`);
  await clear();
  try {
    const TODAY = "2026-11-08";
    const list = [
      { key: "zzrotationflix", name: "Zzrotationflix", cadence: "monthly" as const, rise: { on: "2026-11-03" } },
      { key: "zz gym: east", name: "Zz Gym", cadence: "monthly" as const, missed: { due_on: "2026-11-01" } },
    ];
    // Sent before the change: the merchant is in the key.
    await q(`INSERT INTO reminder_log (key, sent_at) VALUES ('regular-up:zzrotationflix:2026-11-03', '2026-11-04T08:00:00Z'), ('regular-missed:zz gym: east:2026-11-01', '2026-11-05T08:00:00Z')`);

    await sealLegacyPaymentKeys();
    let rows = await mine();
    assert.equal(rows.length, 2);
    assert.doesNotMatch(rows.map((r) => r.key).join(" "), /regular-|zzrotationflix|gym/, "no merchant left in the table");
    assert.deepEqual(rows.map((r) => new Date(r.sent_at).toISOString()).sort(), ["2026-11-04T08:00:00.000Z", "2026-11-05T08:00:00.000Z"], "when each was sent is kept");

    // The same nudges come up again: both were sent, neither is claimed.
    const nudges = paymentNudges(list, TODAY, index);
    assert.equal(nudges.length, 2);
    for (const n of nudges) assert.equal(await claimIndexedReminder(n.tag, n.older), false, `${n.kind} isn't sent again`);
    // One that wasn't sent is claimed once.
    const [fresh] = paymentNudges([{ key: "zznewthing", name: "Zznewthing", cadence: "monthly", rise: { on: "2026-11-06" } }], TODAY, index);
    assert.equal(await claimIndexedReminder(fresh.tag, fresh.older), true);
    assert.equal(await claimIndexedReminder(fresh.tag, fresh.older), false);
    await sealLegacyPaymentKeys(); // nothing left to move
    assert.equal((await mine()).length, 3);

    // ---- a data key rotation: the index changes, the old key is still held ----
    process.env.ATHENA_DATA_KEY = "7c".repeat(32);
    process.env.ATHENA_DATA_KEY_PREVIOUS = KEY;
    const after = paymentNudges(list, TODAY, index);
    assert.notEqual(after[0].tag, nudges[0].tag);
    assert.deepEqual(after[0].older, [nudges[0].tag]);
    for (const n of after) assert.equal(await claimIndexedReminder(n.tag, n.older), false, "sent under the old key: not sent again");
    rows = await mine();
    assert.ok(after.every((n) => rows.some((r) => r.key === n.tag)), "and its row now sits under the new key's index");
    // …so once the old key is gone it still isn't sent again.
    delete process.env.ATHENA_DATA_KEY_PREVIOUS;
    for (const n of paymentNudges(list, TODAY, index)) assert.equal(await claimIndexedReminder(n.tag, n.older), false);

    // Other reminder keys are untouched by any of this.
    assert.equal(await claimReminder("pay-test-other"), true);
  } finally {
    process.env.ATHENA_DATA_KEY = KEY;
    delete process.env.ATHENA_DATA_KEY_PREVIOUS;
    await clear();
  }
});
