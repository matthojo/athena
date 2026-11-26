// Real path: the reminders function makes nudges Athena starts from seeded data (Postgres with every
// migration applied, 0051 included), pushes each to a fake push service on localhost that decrypts it,
// and leaves the bare 30-minute push out for a meeting that gets meeting prep.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/proactive.db.test.ts
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

// ---------- the test ----------

test("reminders: meeting prep, then how it went, from seeded data; deduped, muted, capped and kept sealed", { skip }, async () => {
  const { qRaw, q, savePushSubscription, claimReminder, upsertPerson, upsertEvent, linkEntities } = await import("./db");
  const { logInteraction, upsertCommitment } = await import("./memory");
  const { saveNotificationPrefs, pushDeps, pushCredential } = await import("./push");
  const { saveProactivePrefs, muteRule, unmuteRule, listLiveNudges, openNudge, dismissNudge } = await import("./proactive/store");
  const { isSealed } = await import("./data-box");
  const { runReminders } = await import("../netlify/functions/reminders");

  const base = await fakePushService();
  await qRaw(`DELETE FROM push_subscriptions`);
  await qRaw(`DELETE FROM nudges`);
  await qRaw(`DELETE FROM nudge_mutes`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'event:%' OR key LIKE 'briefing%' OR key LIKE 'reply-scan:%'`);
  await qRaw(`DELETE FROM settings WHERE key IN ('notifications', 'proactive', 'days_working_hours')`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  // The fake service is on localhost, and the subscription is the master token's.
  pushDeps.allowed = () => true;
  process.env.MCP_BEARER_TOKEN ??= "test-master-token";
  const credential = pushCredential(new Request("https://athena.test/", { headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` } }))!;
  await savePushSubscription({ endpoint: `${base}/push/device-1`, p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, credential);
  await saveNotificationPrefs({ evening: false, weekly: false, briefing: false, reminders: false });
  await claimReminder("briefing:2026-12-07");

  // Priya, a meeting with her on Monday 7 December at 14:00, what was said and what's open.
  const priya = await upsertPerson({ name: "Priya Shah", email: "priya@example.com" });
  const meeting = await upsertEvent({ title: "Q3 review", kind: "appointment", date: "2026-12-07", starts_at: "2026-12-07T14:00:00Z", person_id: priya.id });
  await qRaw(`UPDATE events SET created_at = '2026-12-01T09:00:00Z' WHERE id = $1`, [meeting.id]);
  await logInteraction({ at: "2026-12-02T15:00:00Z", channel: "meeting", summary: "Agreed to send the Q3 deck by Friday", person_ids: [priya.id] });
  await logInteraction({ at: "2026-12-04T10:00:00Z", channel: "email", summary: "Priya sent comments on the deck", person_ids: [priya.id] });
  await upsertCommitment({ title: "Send Priya the Q3 deck", kind: "i_owe", person_id: priya.id, due_on: "2026-12-11" });
  // A meeting added after it happened (a backfill of history) never gets a nudge.
  const old = await upsertEvent({ title: "Old sync", kind: "appointment", date: "2026-12-07", starts_at: "2026-12-07T13:55:00Z" });
  await linkEntities({ sourceType: "event", sourceId: old.id, targetType: "person", targetId: priya.id });
  await qRaw(`UPDATE events SET created_at = '2026-12-08T09:00:00Z' WHERE id = $1`, [old.id]);

  // 13:31: the 30-minute window. Meeting prep speaks for this meeting, so there's no bare push.
  received.length = 0;
  const early = await runReminders(new Date("2026-12-07T13:31:00Z"));
  assert.ok(!(early.timed as string[]).some((k) => k.includes(meeting.id)));
  await qRaw(`UPDATE events SET timed_push = false WHERE id = $1`, [old.id]);
  received.length = 0;

  // 13:46: meeting prep, pushed, opening Ask on it.
  const prep = await runReminders(new Date("2026-12-07T13:46:00Z"));
  assert.deepEqual(prep.proactive, { made: [{ rule: "meeting_prep", pushed: true }], held: {} });
  assert.equal(received.length, 1);
  const push = decrypt(received[0].body) as { title: string; body: string; url: string; tag: string };
  assert.equal(push.title, "14:00 with Priya");
  assert.equal(push.body, "1 open to-do, 1 recent email. Tap for the notes from last time.");
  const [row] = await qRaw<{ id: string; payload: string }>(`SELECT id, payload FROM nudges WHERE rule = 'meeting_prep'`);
  assert.equal(push.url, `/#/ask/nudge/${row.id}`);
  // Names, what was said and the suggested reply are sealed at rest.
  assert.ok(isSealed(row.payload));
  assert.ok(!row.payload.includes("Priya"));
  const opened = await openNudge(row.id);
  assert.equal(opened?.prompt, "What should I know before my 14:00 with Priya?");
  assert.ok(opened?.why.some((w) => w.includes("Agreed to send the Q3 deck by Friday")));
  assert.ok(opened?.why.some((w) => w === "Open to-do: Send Priya the Q3 deck."));
  assert.ok(opened?.opened_at);

  // Dedupe: later runs in the window, and a retried one, make nothing new.
  await runReminders(new Date("2026-12-07T13:51:00Z"));
  await runReminders(new Date("2026-12-07T13:51:00Z"));
  assert.equal(received.length, 1);

  // After the meeting (off by default): nothing until it's switched on; muted, held; then it asks.
  assert.equal((await runReminders(new Date("2026-12-07T15:05:00Z"))).proactive, undefined);
  await saveProactivePrefs({ rules: { after_meeting: true } });
  await muteRule("after_meeting", new Date("2026-12-07T15:00:00Z"));
  const muted = await runReminders(new Date("2026-12-07T15:06:00Z"));
  assert.equal(muted.proactive, undefined, "a muted rule isn't even loaded for");
  await unmuteRule("after_meeting");
  // The daily cap: one a day is already used.
  await saveProactivePrefs({ cap: 1 });
  assert.deepEqual((await runReminders(new Date("2026-12-07T15:07:00Z"))).proactive, { made: [], held: { cap: 1 } });
  await saveProactivePrefs({ cap: 4 });
  const after = await runReminders(new Date("2026-12-07T15:08:00Z"));
  assert.deepEqual(after.proactive, { made: [{ rule: "after_meeting", pushed: true }], held: {} });
  assert.equal((decrypt(received[1].body) as { title: string }).title, "How did your meeting with Priya go?");

  // Home's cards: both, newest first; a dismissed one leaves.
  const live = await listLiveNudges(new Date("2026-12-07T15:09:00Z"));
  assert.deepEqual(live.map((n) => n.rule), ["after_meeting"], "meeting prep expired when the meeting started");
  await dismissNudge(live[0].id);
  assert.equal((await listLiveNudges(new Date("2026-12-07T15:09:00Z"))).length, 0);
  // Working hours (Settings → Days, 09:00 to 18:00 by default) are the quiet hours: a call at 18:15 gets no prep.
  const late = await upsertEvent({ title: "Late call", kind: "appointment", date: "2026-12-07", starts_at: "2026-12-07T18:15:00Z", person_id: priya.id });
  await qRaw(`UPDATE events SET created_at = '2026-12-01T09:00:00Z' WHERE id = $1`, [late.id]);
  // So its prep won't come, and it keeps the bare 30-minute push.
  const keeps = await runReminders(new Date("2026-12-07T17:46:00Z"));
  assert.ok((keeps.timed as string[]).some((k) => k.includes(late.id)));
  assert.equal(received.length, 3);
  assert.deepEqual((await runReminders(new Date("2026-12-07T18:02:00Z"))).proactive, { made: [], held: { quiet: 1 } });
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM nudges`);
  assert.equal(n, 2);
  assert.equal(received.length, 3);
});
