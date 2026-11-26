// AI spend's pushes on the real path (lib/spend.ts recordUsage → lib/push.ts sendToAll → web-push), against
// Postgres with every migration and a fake push service on localhost that decrypts what it receives (RFC 8291).
// The harness is lib/nudges.db.test.ts's. Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/spend-push.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Needs openssl on the PATH. Empties ai_usage and push_subscriptions, and
// replaces the 'ai_budget' and 'notifications' settings rows.
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

test("the budget's pushes reach the device, encrypted, once each a day: at 80% and at the budget", { skip }, async () => {
  const { qRaw, savePushSubscription } = await import("./db");
  const { pushDeps, pushCredential } = await import("./push");
  const { recordUsage, forgetBudget } = await import("./spend");
  const { zonedToday } = await import("./dates");
  const base = await fakePushService();
  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM push_subscriptions`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'spend:%'`);
  await qRaw(`DELETE FROM settings WHERE key = 'notifications'`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('ai_budget', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ daily: 2, currency: "USD", assistants: {} })]);
  forgetBudget(true);
  pushDeps.allowed = () => true;
  process.env.MCP_BEARER_TOKEN ??= "test-master-token";
  const credential = pushCredential({ id: "master" })!;
  await savePushSubscription({ endpoint: `${base}/push/phone`, p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, credential);

  const at = new Date();
  at.setUTCHours(12, 0, 0, 0);
  const day = zonedToday(at, "Europe/London");
  const spend = (tokens: number) => recordUsage({ model: "claude-opus-5-5", usage: { input_tokens: tokens, output_tokens: 0 } }, { now: at });
  received.length = 0;
  await spend(300_000); // $1.20 of $2
  assert.equal(received.length, 0);
  await spend(125_000); // $1.70: past 80%
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/push/phone");
  assert.equal(received[0].headers["content-encoding"], "aes128gcm");
  assert.deepEqual(decrypt(received[0].body), { title: "80% of today's AI budget used", body: "$1.70 of $2. Athena stops at $2 until midnight.", url: "/#/settings/spend", tag: "spend" });
  await spend(50_000); // $1.90: nothing more
  assert.equal(received.length, 1);
  await spend(25_000); // $2.00: the budget
  assert.equal(received.length, 2);
  assert.deepEqual(decrypt(received[1].body), { title: "Today's AI budget is used", body: "$2 of $2. Athena has stopped until midnight. Open AI spend to allow more.", url: "/#/settings/spend", tag: "spend" });
  await spend(10_000);
  assert.equal(received.length, 2, "once each a day");
  const claims = (await qRaw<{ key: string }>(`SELECT key FROM reminder_log WHERE key LIKE 'spend:%' ORDER BY key`)).map((r) => r.key);
  assert.deepEqual(claims, [`spend:cap:${day}`, `spend:near:${day}`]);

  await qRaw(`TRUNCATE ai_usage`);
  await qRaw(`DELETE FROM push_subscriptions`);
  await qRaw(`DELETE FROM reminder_log WHERE key LIKE 'spend:%'`);
  await qRaw(`DELETE FROM settings WHERE key = 'ai_budget'`);
});
