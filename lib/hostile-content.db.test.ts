// Security review, session 6, on real Postgres: a save survives a page that can't be read (M18), and push
// subscriptions are capped, tied to the credential that registered them and dropped with it (M5).
// Nothing is sent: no row here is ever pushed to. Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/hostile-content.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}
const skip = !url && "set ATHENA_TEST_DB_URL";

test("M18: the saved row is there before the page is read, and stays when the read fails", { skip }, async () => {
  const { saveItem, getSaved } = await import("./saved");
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM saved_items`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  // A read that dies (a parser crash, a hostile page): the link is kept, marked as not read.
  let rowsDuringRead = -1;
  const crashed = await saveItem(
    { url: "https://hostile.example/deep", note: "for later" },
    {
      read: async () => {
        rowsDuringRead = (await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM saved_items`))[0].n;
        throw new RangeError("Maximum call stack size exceeded");
      },
    },
  );
  assert.equal(rowsDuringRead, 1, "inserted before the read began");
  assert.equal(crashed.created, true);
  assert.equal(crashed.item.kind, "link");
  assert.equal(crashed.item.url, "https://hostile.example/deep");
  assert.equal(crashed.item.note, "for later");
  assert.equal(crashed.item.fetch_status, "failed");
  assert.equal(crashed.item.site, "hostile.example");
  assert.equal((await getSaved(crashed.item.id))?.fetch_status, "failed");

  // A read that never comes back (the function is killed first) leaves the same row behind.
  let release = () => {};
  const hung = saveItem({ url: "https://hostile.example/slow" }, { read: () => new Promise((_, reject) => (release = () => reject(new Error("killed")))) });
  for (let i = 0; i < 50 && (await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM saved_items`))[0].n < 2; i++) await new Promise((r) => setTimeout(r, 20));
  const [waiting] = await qRaw<{ fetch_status: string; fetched_at: string | null }>(`SELECT fetch_status, fetched_at FROM saved_items ORDER BY saved_at DESC LIMIT 1`);
  assert.deepEqual(waiting, { fetch_status: "failed", fetched_at: null });
  release();
  assert.equal((await hung).created, true);

  // A page that reads: everything it found lands on the row, and a title the owner typed wins.
  const ok = await saveItem(
    { url: "https://longform.example/sleep", title: "My title" },
    { read: async () => ({ status: "ok", title: "Page title", site: "Longform", author: "Dr Hannah Okafor", published_at: "2026-03-01", excerpt: "On sleep.", readable: "Text ".repeat(200), words: 200, image: null, thing: { type: "article", facts: { by: "Dr Hannah Okafor" } } }) },
  );
  assert.deepEqual(
    [ok.item.title, ok.item.site, ok.item.author, ok.item.published_at, ok.item.excerpt, ok.item.words, ok.item.fetch_status, ok.item.thing],
    ["My title", "Longform", "Dr Hannah Okafor", "2026-03-01", "On sleep.", 200, "ok", "article"],
  );
  assert.ok((await qRaw<{ fetched_at: string | null }>(`SELECT fetched_at FROM saved_items WHERE id = $1`, [ok.item.id]))[0].fetched_at);
  assert.equal((await getSaved(ok.item.id, { readable: true }))?.readable?.length, 1000);
  const untitled = await saveItem({ url: "https://longform.example/other" }, { read: async () => ({ status: "preview", title: "Page title", thing: null }) });
  assert.deepEqual([untitled.item.title, untitled.item.fetch_status, untitled.item.site], ["Page title", "preview", "longform.example"]);
  // Sealed at rest, as before.
  const [raw] = await qRaw<{ title: string; author: string }>(`SELECT title, author FROM saved_items WHERE id = $1`, [ok.item.id]);
  assert.match(raw.title, /^enc:v1:/);
  assert.match(raw.author, /^enc:v1:/);
});

test("M5: known push services only, ten at most, and gone with the credential that registered them", { skip }, async () => {
  const api = (await import("../netlify/functions/api")).default;
  const { qRaw, keepPushSubscriptionsOf, MAX_PUSH_SUBSCRIPTIONS } = await import("./db");
  const { createApiKey, removeApiKey } = await import("./api-keys");
  const { liveCredentials, sendToAll } = await import("./push");
  await qRaw(`DELETE FROM push_subscriptions`);
  await qRaw(`DELETE FROM settings WHERE key = 'api_keys'`);

  const send = (method: string, body: unknown, token = "master-token-for-tests") =>
    api(new Request("https://athena.test/api/push/subscribe", { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), {} as never);
  const keys = { p256dh: "BPubKey", auth: "authsecret" };
  const endpoints = async () => (await qRaw<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions ORDER BY endpoint`)).map((r) => r.endpoint);

  // Anything but a known push service is refused, and nothing is stored.
  for (const endpoint of ["https://attacker.example/collect", "https://10.0.0.5/internal", "https://fcm.googleapis.com:8443/x", "https://u:p@web.push.apple.com/x", "http://web.push.apple.com/x"]) {
    const res = await send("POST", { endpoint, keys });
    assert.equal(res.status, 400, endpoint);
  }
  assert.equal((await (await send("POST", { endpoint: "https://attacker.example/collect", keys })).json()).error, "This browser's push service isn't one Athena sends to");
  assert.deepEqual(await endpoints(), []);

  // A real one is kept, with a fingerprint of the token that registered it (never the token).
  assert.equal((await send("POST", { endpoint: "https://web.push.apple.com/device-master", keys })).status, 201);
  const [row] = await qRaw<{ credential: string }>(`SELECT credential FROM push_subscriptions`);
  assert.match(row.credential, /^[0-9a-f]{32}$/);
  assert.ok(!row.credential.includes("master"));

  // A full key registers one too; a capture key can't reach the route.
  const full = await createApiKey("Laptop", "full");
  const capture = await createApiKey("iPhone", "capture");
  assert.equal((await send("POST", { endpoint: "https://fcm.googleapis.com/fcm/send/device-key", keys }, full.token)).status, 201);
  assert.equal((await send("POST", { endpoint: "https://fcm.googleapis.com/fcm/send/capture", keys }, capture.token)).status, 401);
  assert.deepEqual(await endpoints(), ["https://fcm.googleapis.com/fcm/send/device-key", "https://web.push.apple.com/device-master"]);

  // Both credentials still work: nothing is dropped.
  assert.equal(await keepPushSubscriptionsOf(await liveCredentials()), 0);
  // The key is removed: its subscription goes, the master token's stays.
  await removeApiKey(full.key.id);
  assert.equal(await keepPushSubscriptionsOf(await liveCredentials()), 1);
  assert.deepEqual(await endpoints(), ["https://web.push.apple.com/device-master"]);

  // The master token is changed: what the old one registered goes, and so does a row from before credentials were recorded.
  await qRaw(`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://web.push.apple.com/legacy', 'k', 'a')`);
  process.env.MCP_BEARER_TOKEN = "a-new-master-token";
  try {
    // sendToAll does the dropping before it sends; with nothing left, nothing is sent anywhere.
    assert.deepEqual(await sendToAll({ title: "t", body: "b", url: "/" }), { sent: 0, pruned: 2, failed: 0 });
    assert.deepEqual(await endpoints(), []);

    // A row that somehow holds another host (written before this fix) is removed, not posted to.
    const live = (await liveCredentials())[0];
    await qRaw(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, credential) VALUES ('https://attacker.example/collect', 'k', 'a', $1)`, [live]);
    assert.deepEqual(await sendToAll({ title: "t", body: "b", url: "/" }), { sent: 0, pruned: 1, failed: 0 });
    assert.deepEqual(await endpoints(), []);

    // Ten at most: the eleventh and twelfth push out the two unused longest.
    for (let i = 1; i <= MAX_PUSH_SUBSCRIPTIONS + 2; i++) {
      assert.equal((await send("POST", { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/d${String(i).padStart(2, "0")}`, keys }, "a-new-master-token")).status, 201);
      await qRaw(`UPDATE push_subscriptions SET updated_at = now() - make_interval(secs => $2) WHERE endpoint LIKE $1`, [`%/d${String(i).padStart(2, "0")}`, 100 - i]);
    }
    const kept = await endpoints();
    assert.equal(kept.length, MAX_PUSH_SUBSCRIPTIONS);
    assert.ok(!kept.some((e) => /d0[12]$/.test(e)), "the two oldest went");
    // Subscribing again from a kept device changes nothing.
    assert.equal((await send("POST", { endpoint: kept[0], keys }, "a-new-master-token")).status, 201);
    assert.equal((await endpoints()).length, MAX_PUSH_SUBSCRIPTIONS);
    // Turning a device off still works.
    assert.equal((await send("DELETE", { endpoint: kept[0] }, "a-new-master-token")).status, 200);
    assert.equal((await endpoints()).length, MAX_PUSH_SUBSCRIPTIONS - 1);
  } finally {
    process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
    await qRaw(`DELETE FROM push_subscriptions`);
  }
});

test("Saved images: re-sealing walks past the first 50 and past images it can't open", { skip }, async () => {
  const { resealSavedImages, useSavedStore } = await import("./saved");
  const { sealBytes, openBytes } = await import("./data-box");
  const { qRaw } = await import("./db");
  await qRaw(`DELETE FROM saved_items`);
  const blobs = new Map<string, Uint8Array>();
  useSavedStore(() => ({ set: async (k: string, v: ArrayBuffer) => void blobs.set(k, new Uint8Array(v)), get: async (k: string) => (blobs.has(k) ? blobs.get(k)!.slice().buffer : null), delete: async (k: string) => void blobs.delete(k) }) as never);

  // 130 kept images under an old key id; the 60 with the lowest ids can't be opened (their bytes are gone).
  const rows = await qRaw<{ id: string }>(
    `INSERT INTO saved_items (kind, source, has_image, image_kid, saved_at, saved_on) SELECT 'image', 'app', true, 'old-key', now(), current_date FROM generate_series(1, 130) RETURNING id`,
  );
  const ids = rows.map((r) => r.id).sort();
  for (const id of ids.slice(60)) for (const size of ["lg", "sm"]) blobs.set(`${id}/${size}`, new Uint8Array(sealBytes(Buffer.from(`${size} of ${id}`)).sealed));
  const current = sealBytes(Buffer.from("x")).kid;

  // Before: LIMIT 50 with no order or cursor could return the same unreadable rows every time and never reach the rest.
  assert.deepEqual(await resealSavedImages(current, 30_000), { resealed: 70, failed: 60 });
  const [{ n }] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM saved_items WHERE image_kid = $1`, [current]);
  assert.equal(n, 70);
  assert.equal(openBytes(blobs.get(`${ids[129]}/lg`)!).toString(), `lg of ${ids[129]}`);
  // Again: nothing left to do but the ones that can't be opened, still counted.
  assert.deepEqual(await resealSavedImages(current, 30_000), { resealed: 0, failed: 60 });
  // No time: nothing touched.
  assert.deepEqual(await resealSavedImages("another-key", -1), { resealed: 0, failed: 0 });
  await qRaw(`DELETE FROM saved_items`);
});
