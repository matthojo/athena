// Real path: the reminders function against Postgres with every migration applied, pushing to a
// fake push service on localhost that decrypts what it receives (RFC 8291, aes128gcm).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/nudges.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Needs openssl on the PATH for the fake service's certificate.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  // The fake push service's certificate is self-signed.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const skip = !url && "set ATHENA_TEST_DB_URL";

// ---------- a fake push service ----------

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
const received: Received[] = [];
let server: Server | null = null;

async function fakePushService(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "athena-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `https://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
after(() => server?.close());

/** The browser's half: a P-256 key pair and an auth secret, as a real subscription has. */
const device = createECDH("prime256v1");
device.generateKeys();
const auth = randomBytes(16);

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** Open an aes128gcm push body with the device's private key (RFC 8291 §3.4, RFC 8188). */
function decrypt(body: Buffer): unknown {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverKey = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = device.computeSecret(serverKey);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), serverKey, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  // Padding: the last record ends with 0x02 then zeros.
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}

// ---------- the tests ----------

test("VAPID: Athena makes its own pair once, private half sealed under the data key; env keys win", { skip }, async () => {
  const { qRaw } = await import("./db");
  const { vapidKeys, vapidPublicKey } = await import("./push");
  const { isSealed, openStrict } = await import("./data-box");
  await qRaw(`DELETE FROM settings WHERE key = 'vapid'`);

  const first = await vapidKeys();
  assert.ok(first);
  assert.equal(first.from, "stored");
  const [row] = await qRaw<{ value: { public: string; private: string } }>(`SELECT value FROM settings WHERE key = 'vapid'`);
  assert.equal(row.value.public, first.publicKey);
  assert.ok(isSealed(row.value.private), "the private key is stored sealed");
  assert.ok(!JSON.stringify(row.value).includes(first.privateKey), "and never in the clear");
  assert.equal(openStrict(row.value.private), first.privateKey);
  // Made once: every later call (and every device) gets the same key.
  assert.equal(await vapidPublicKey(), first.publicKey);

  // Set on Netlify, the environment's keys win.
  process.env.VAPID_PUBLIC_KEY = "env-public";
  process.env.VAPID_PRIVATE_KEY = "env-private";
  try {
    assert.deepEqual(await vapidKeys(), { publicKey: "env-public", privateKey: "env-private", subject: "https://athena.example.com", from: "env" });
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
  assert.equal(await vapidPublicKey(), first.publicKey);
});

test("reminders: the evening prompt reaches the device once, and not on a kept day or in quiet hours", { skip }, async () => {
  const { qRaw, savePushSubscription, claimReminder } = await import("./db");
  const { saveNotificationPrefs, vapidPublicKey, pushDeps, pushCredential } = await import("./push");
  const { patchDay } = await import("./days");
  const { runReminders } = await import("../netlify/functions/reminders");

  const base = await fakePushService();
  await qRaw(`DELETE FROM push_subscriptions`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'evening:%' OR key LIKE 'briefing:%' OR key LIKE 'week:%'`);
  await qRaw(`DELETE FROM days WHERE date BETWEEN '2026-11-04' AND '2026-11-06'`);
  await qRaw(`DELETE FROM settings WHERE key = 'notifications'`);
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  // The fake service is on localhost, and the subscription is the master token's.
  pushDeps.allowed = () => true;
  process.env.MCP_BEARER_TOKEN ??= "test-master-token";
  const credential = pushCredential({ id: "master" })!;
  await savePushSubscription({ endpoint: `${base}/push/device-1`, p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, credential);
  // The morning briefing has its own tests; keep it out of these runs.
  for (const d of ["2026-11-04", "2026-11-05", "2026-11-06"]) await claimReminder(`briefing:${d}`);

  // Switched off in Settings: nothing.
  received.length = 0;
  await saveNotificationPrefs({ evening: false, weekly: false });
  await runReminders(new Date("2026-11-04T21:05:00Z"));
  assert.equal(received.length, 0);

  // On (the default once a device has notifications on).
  await saveNotificationPrefs({ evening: true });
  const report = await runReminders(new Date("2026-11-04T21:05:00Z"));
  assert.deepEqual(report.evening, { sent: 1, pruned: 0, failed: 0 });
  assert.equal(received.length, 1);
  const push = received[0];
  assert.equal(push.path, "/push/device-1");
  assert.equal(push.headers["content-encoding"], "aes128gcm");
  assert.match(String(push.headers.authorization), new RegExp(`^vapid t=.+, k=${await vapidPublicKey()}$`));
  assert.deepEqual(decrypt(push.body), { title: "How was today?", body: "Add a mood or a line before the day ends.", url: "/#/days/2026-11-04?mood", tag: "evening-2026-11-04" });

  // Once a day: the next run (and a retried one) sends nothing.
  await runReminders(new Date("2026-11-04T21:10:00Z"));
  await runReminders(new Date("2026-11-04T23:55:00Z"));
  assert.equal(received.length, 1);

  // A day the owner has already kept gets no prompt.
  await patchDay("2026-11-05", { mood: 4 }, { tz: "Europe/London" });
  const kept = await runReminders(new Date("2026-11-05T21:05:00Z"));
  assert.equal(kept.evening, "kept");
  assert.equal(received.length, 1);

  // Quiet hours from 21:00: nothing is sent, and nothing is used up.
  await saveNotificationPrefs({ quiet: { from: "21:00", to: "07:00" } });
  const quiet = await runReminders(new Date("2026-11-06T21:05:00Z"));
  assert.equal(quiet.quiet, true);
  assert.equal(received.length, 1);
  const [claimed] = await qRaw(`SELECT key FROM reminder_log WHERE key = 'evening:2026-11-06'`);
  assert.equal(claimed, undefined);
});

test("reminders: with check-ins on, the morning push and the evening reflection, each skipped once done (the real store)", { skip }, async () => {
  const { qRaw, claimReminder } = await import("./db");
  const { saveNotificationPrefs } = await import("./push");
  const { runReminders } = await import("../netlify/functions/reminders");
  const { DEFAULT_CHECKIN_SETTINGS } = await import("./checkin-types");
  const { getCheckin, finishCheckin } = await import("./checkins");

  // The device and its subscription come from the test above.
  const days = ["2026-11-10", "2026-11-11", "2026-11-12"];
  const clear = () => qRaw(`DELETE FROM checkins WHERE date = ANY($1::date[])`, [days]);
  await qRaw(`DELETE FROM reminder_log WHERE key = ANY($1)`, [days.flatMap((d) => [`morning:${d}`, `evening:${d}`])]);
  for (const d of days) await claimReminder(`briefing:${d}`);
  await saveNotificationPrefs({ morning: true, morning_at: "07:00", evening: true, weekly: false, quiet: null });
  const settings = { ...DEFAULT_CHECKIN_SETTINGS, morning: { ...DEFAULT_CHECKIN_SETTINGS.morning, enabled: true }, evening: { ...DEFAULT_CHECKIN_SETTINGS.evening, enabled: true } };
  await qRaw(`INSERT INTO settings (key, value) VALUES ('checkins', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(settings)]);
  await clear();

  // Planned and finished through lib/checkins.ts, as the app does on that day.
  const finish = async (date: string, kind: "morning" | "evening") => {
    const now = new Date(`${date}T12:00:00Z`);
    await getCheckin(date, kind, { now });
    await finishCheckin(date, kind, { now });
  };
  try {
    received.length = 0;
    // Before 07:00, nothing; from 07:00, once. A morning opened but not finished still gets it.
    await runReminders(new Date("2026-11-10T06:55:00Z"));
    assert.equal(received.length, 0);
    await getCheckin("2026-11-10", "morning", { now: new Date("2026-11-10T06:56:00Z") });
    const morning = await runReminders(new Date("2026-11-10T07:05:00Z"));
    assert.deepEqual(morning.morning, { sent: 1, pruned: 0, failed: 0 });
    assert.deepEqual(decrypt(received[0].body), { title: "Morning check-in", body: "How are you starting the day?", url: "/#/checkin/morning", tag: "morning-2026-11-10" });
    await runReminders(new Date("2026-11-10T07:10:00Z"));
    await runReminders(new Date("2026-11-10T15:00:00Z"));
    assert.equal(received.length, 1, "once a day");

    // The evening opens the reflection.
    const evening = await runReminders(new Date("2026-11-10T21:05:00Z"));
    assert.deepEqual(evening.evening, { sent: 1, pruned: 0, failed: 0 });
    const reflection = decrypt(received[1].body) as { title: string; url: string };
    assert.equal(reflection.title, "Evening reflection");
    assert.equal(reflection.url, "/#/checkin/evening");

    // Done already: neither push.
    await finish("2026-11-11", "morning");
    await finish("2026-11-11", "evening");
    await runReminders(new Date("2026-11-11T07:05:00Z"));
    assert.equal((await runReminders(new Date("2026-11-11T21:05:00Z"))).evening, "done");
    assert.equal(received.length, 2);

    // The first run of the day comes in the afternoon: the morning push still goes, once.
    const late = await runReminders(new Date("2026-11-12T15:30:00Z"));
    assert.deepEqual(late.morning, { sent: 1, pruned: 0, failed: 0 });
    await runReminders(new Date("2026-11-12T16:30:00Z"));
    assert.equal(received.length, 3);
  } finally {
    await clear();
    await qRaw(`DELETE FROM settings WHERE key = 'checkins'`);
  }
});
