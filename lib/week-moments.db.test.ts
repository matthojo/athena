// Each week's kept moment through the real /api function, kept in Postgres's settings table.
// Run: ATHENA_TEST_DB_URL=postgres://… npm run -s test:db (or npx tsx --test lib/week-moments.db.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readMoment, readMoments } from "./week-moments";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

test("readMoment: a photo, a cover or a line from that week; nothing the owner wrote is kept", () => {
  const photo = readMoment("2026-11-09", { kind: "photo", ref: "file-1", date: "2026-11-14", art: { id: "file-1", w: 4032, h: 3024, tone: "oklch(0.62 0.09 40)" }, title: "Barbican" });
  assert.deepEqual(photo, { kind: "photo", ref: "file-1", date: "2026-11-14", art: { id: "file-1", w: 4032, h: 3024, tone: "oklch(0.62 0.09 40)" } });
  assert.deepEqual(readMoment("2026-11-09", { kind: "line", ref: "2026-11-10", date: "2026-11-10", text: "Lunch with Priya" }), { kind: "line", ref: "2026-11-10", date: "2026-11-10" });
  assert.throws(() => readMoment("2026-11-10", { kind: "photo", ref: "f", date: "2026-11-10" }), /Monday/);
  assert.throws(() => readMoment("2026-11-09", { kind: "song", ref: "f", date: "2026-11-10" }), /kind/);
  assert.throws(() => readMoment("2026-11-09", { kind: "photo", ref: "f", date: "2026-11-16" }), /that week/);
  assert.throws(() => readMoment("2026-11-09", { kind: "line", ref: "2026-11-11", date: "2026-11-10" }), /its day/);
  assert.throws(() => readMoment("2026-11-09", { kind: "entry", ref: "../etc", date: "2026-11-10" }), /ref/);
  // Malformed art is dropped, the moment kept.
  assert.deepEqual(readMoment("2026-11-09", { kind: "entry", ref: "e1", date: "2026-11-10", art: { id: "a", w: -1, h: 3 } }), { kind: "entry", ref: "e1", date: "2026-11-10" });
  assert.deepEqual(readMoments({ "2026-11-09": { kind: "line", ref: "2026-11-09", date: "2026-11-09" }, nope: { kind: "photo" } }), { "2026-11-09": { kind: "line", ref: "2026-11-09", date: "2026-11-09" } });
  assert.deepEqual(readMoments("junk"), {});
});

test("week moments: kept on one device, read on another, changed, undone, and one week never touches another", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM settings WHERE key = 'week_moments'`);
  const call = async (method: string, path = "", body?: unknown, token = "master-token-for-tests") => {
    const res = await api(new Request(`https://athena.test/api/week-moments${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), {} as never);
    return { status: res.status, json: (await res.json()) as any };
  };

  // Behind the key, and empty to start.
  assert.equal((await call("GET", "", undefined, "wrong")).status, 401);
  let r = await call("GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { moments: {} });

  // The phone keeps week 46's Barbican photo; the laptop reads it.
  const barbican = { kind: "photo", ref: "photo-2026-11-14-0", date: "2026-11-14", art: { id: "photo-2026-11-14-0", w: 4, h: 3, tone: "#a77b52" } };
  r = await call("PUT", "/2026-11-09", barbican);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { monday: "2026-11-09", moment: barbican });
  assert.deepEqual((await call("GET")).json.moments, { "2026-11-09": barbican });

  // Another week's line sits beside it; the words aren't stored, only the day.
  const line = { kind: "line", ref: "2026-11-03", date: "2026-11-03" };
  assert.equal((await call("PUT", "/2026-11-02", { ...line, text: "Dinner at Priya's" })).status, 200);
  const [row] = await qRaw<{ value: Record<string, unknown> }>(`SELECT value FROM settings WHERE key = 'week_moments'`);
  assert.deepEqual(row.value, { "2026-11-09": barbican, "2026-11-02": line });
  assert.doesNotMatch(JSON.stringify(row.value), /Priya/);

  // Changing week 46 leaves week 45 alone.
  const cover = { kind: "entry", ref: "0c9b1f8e-0000-4000-8000-000000000001", date: "2026-11-12", art: { id: "art-severance", w: 2, h: 3 } };
  assert.equal((await call("PUT", "/2026-11-09", cover)).status, 200);
  assert.deepEqual((await call("GET")).json.moments, { "2026-11-09": cover, "2026-11-02": line });

  // Bad input is refused and changes nothing.
  for (const [path, body] of [
    ["/2026-11-10", cover],
    ["/2026-11-09", { ...cover, date: "2026-11-20" }],
    ["/2026-11-09", { ...cover, kind: "badge" }],
    ["/2026-11-09", []],
  ] as const) assert.equal((await call("PUT", path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
  assert.equal((await call("POST", "/2026-11-09", cover)).status, 405);
  assert.deepEqual((await call("GET")).json.moments, { "2026-11-09": cover, "2026-11-02": line });

  // Undo: week 46 goes back to no moment, and looks complete without one.
  r = await call("DELETE", "/2026-11-09");
  assert.deepEqual(r.json, { monday: "2026-11-09", moment: null });
  assert.deepEqual((await call("GET")).json.moments, { "2026-11-02": line });
  // Clearing a week with nothing kept is fine too.
  assert.equal((await call("DELETE", "/2026-10-26")).status, 200);
  await qRaw(`DELETE FROM settings WHERE key = 'week_moments'`);
});
