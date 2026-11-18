// The 15-minute look at the appliances a Home collection reads, on Postgres with every migration applied: a programme followed from
// running to finished becomes one Days entry, what was seen is kept sealed for House, a 429 leaves the account alone for
// an hour, a refused sign-in marks the account, and a removed account takes its appliances with it.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/home/appliance-sync.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties connectors, Days entries and the appliances setting first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}
const skip = !url && "set ATHENA_TEST_DB_URL";

test("a programme followed from running to finished is one Days entry, and House reads what was seen", { skip }, async () => {
  const { q, qRaw } = await import("../../../lib/db");
  const C = await import("../../../lib/connectors");
  const { syncAppliances, SLOW_DOWN_MS } = await import("./appliance-sync");
  const { loadAppliances } = await import("../../../lib/appliance-store");
  const { houseAppliances } = await import("../../../lib/home-appliances");
  const { HomeConnectError } = await import("../connectors/homeconnect-direct");
  await qRaw(`DELETE FROM day_entries WHERE source = 'home_connect'`);
  await qRaw(`DELETE FROM settings WHERE key = 'appliances'`);
  await qRaw(`DELETE FROM collections WHERE recipe = 'home'`);
  await qRaw(`DELETE FROM connectors WHERE provider = 'home-connect'`);

  const account = await C.createConnector({ name: "Home Connect", provider: "home-connect", url: "https://api.home-connect.com", auth_type: "oauth", secrets: { tokens: { access_token: "a", refresh_token: "r" }, ownClient: { client_id: "id", client_secret: "secret" } } });
  // Not signed in yet (needs_auth): nothing is read.
  let reads = 0;
  const dish = { id: "BOSCH-SMV-1", name: "Dishwasher", type: "Dishwasher", brand: "Bosch", connected: true };
  const running = async () => (reads++, [{ ...dish, state: "Run", program: { key: "Dishcare.Dishwasher.Program.Eco50" }, elapsed_s: 1800 }]);
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:00:00Z"), read: running }), { accounts: 0, finished: 0 });
  assert.equal(reads, 0);

  await C.setConnectorStatus(account.id, "connected");
  // Connected but in no Home collection: not looked at.
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:00:00Z"), read: running }), { accounts: 0, finished: 0 });
  assert.equal(reads, 0);
  const home = await C.upsertCollection(undefined, { name: "Home", recipe: "home", connector_ids: [account.id], label: "", source: "home", schedule: "hourly", every_hours: 1, run_at: null });
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:00:00Z"), read: running }), { accounts: 1, finished: 0 });
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:15:00Z"), read: running }), { accounts: 1, finished: 0 });
  // Sealed at rest: the stored value doesn't say "Dishwasher".
  const [raw] = await qRaw<{ value: { sealed: string } }>(`SELECT value FROM settings WHERE key = 'appliances'`);
  assert.ok(raw.value.sealed && !raw.value.sealed.includes("Dishwasher"));
  assert.deepEqual(houseAppliances(await loadAppliances()).map((a) => [a.name, a.now, a.running]), [["Dishwasher", "Running Eco 50", true]]);

  // Home Connect says slow down: left alone for an hour, what was seen stands.
  const limited = async () => {
    reads++;
    throw new HomeConnectError(429, "slow down");
  };
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:30:00Z"), read: limited }), { accounts: 0, finished: 0 });
  const before = reads;
  assert.deepEqual(await syncAppliances({ now: new Date("2026-11-11T19:45:00Z"), read: limited }), { accounts: 0, finished: 0 });
  assert.equal(reads, before);
  assert.equal(houseAppliances(await loadAppliances())[0].running, true);

  // An hour on it has finished: one entry, on the local day it ended, the start from the appliance's own count.
  const finished = async () => [{ ...dish, state: "Finished" }];
  const later = new Date(new Date("2026-11-11T19:30:00Z").getTime() + SLOW_DOWN_MS + 60_000);
  assert.deepEqual(await syncAppliances({ now: later, read: finished }), { accounts: 1, finished: 1 });
  // The same look again finds nothing new.
  assert.deepEqual(await syncAppliances({ now: new Date(later.getTime() + 900_000), read: finished }), { accounts: 1, finished: 0 });
  const entries = await q<{ date: string; kind: string; title: string; subtitle: string; minutes: number }>(`SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, title, subtitle, minutes FROM day_entries WHERE source = 'home_connect'`);
  assert.deepEqual(entries, [{ date: "2026-11-11", kind: "other", title: "Dishwasher", subtitle: "Eco 50", minutes: 121 }]);
  const [house] = houseAppliances(await loadAppliances());
  assert.deepEqual([house.now, house.running, house.last?.program, house.last?.minutes], ["Finished", false, "Eco 50", 121]);

  // The sign-in stopped working: the account says so.
  await syncAppliances({ now: new Date(later.getTime() + 1_800_000), read: async () => Promise.reject(new HomeConnectError(401, "Home Connect didn't accept the sign-in. Sign in again", true)) });
  assert.equal((await C.getConnector(account.id))?.status, "needs_auth");

  // Removed: a look with another account connected drops what was kept about it.
  await C.deleteConnector(account.id);
  const other = await C.createConnector({ name: "Home Connect 2", provider: "home-connect", url: "https://api.home-connect.com", auth_type: "oauth", secrets: { tokens: { access_token: "a", refresh_token: "r" } } });
  await C.setConnectorStatus(other.id, "connected");
  await C.upsertCollection(home.id, { connector_ids: [other.id] });
  await syncAppliances({ now: new Date(later.getTime() + 2_700_000), read: async () => [] });
  assert.deepEqual(Object.keys((await loadAppliances()).accounts), [other.id]);

  await qRaw(`DELETE FROM day_entries WHERE source = 'home_connect'`);
  await qRaw(`DELETE FROM settings WHERE key = 'appliances'`);
  await qRaw(`DELETE FROM collections WHERE recipe = 'home'`);
  await qRaw(`DELETE FROM connectors WHERE provider = 'home-connect'`);
});
