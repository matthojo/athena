// Connector secrets are sealed for their account and address: moved or re-pointed in the
// database they don't open; a new address re-seals them; a new host clears them.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test lib/connector-secrets.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first. No server is ever called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
}

/** A value in the format Athena wrote before v2: no key id, no context. */
function sealV1(hex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

test("Connector secrets: bound to the account and its address", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const C = await import("./connectors");
  const { qRaw } = await import("./db");
  const F = await import("./secret-format");
  await qRaw(`DELETE FROM settings WHERE key = $1`, [F.FORMAT_KEY]);
  F.resetSecretFormat();
  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);

  const media = await C.createConnector({ name: "Media", provider: "custom", url: "https://media.example.com/mcp", auth_type: "token", secrets: { token: "media-token" } });
  const other = await C.createConnector({ name: "Other", provider: "custom", url: "https://other.example.com/mcp", auth_type: "token", secrets: { token: "other-token" } });
  assert.equal((await C.getConnectorWithSecrets(media.id))!.secrets.token, "media-token");

  // Pointed elsewhere in the database: the token doesn't open for the new address.
  await qRaw(`UPDATE connectors SET url = 'https://evil.example.net/mcp' WHERE id = $1`, [media.id]);
  await assert.rejects(C.getConnectorWithSecrets(media.id));
  assert.equal((await C.getConnector(media.id))!.has_token, false);
  await qRaw(`UPDATE connectors SET url = 'https://media.example.com/mcp' WHERE id = $1`, [media.id]);

  // Copied to another account: it doesn't open there either.
  await qRaw(`UPDATE connectors SET credentials = (SELECT credentials FROM connectors WHERE id = $1) WHERE id = $2`, [media.id, other.id]);
  await assert.rejects(C.getConnectorWithSecrets(other.id));

  // Same host, new path: re-sealed for the new address, sign-in kept.
  const moved = (await C.updateConnector(media.id, { url: "https://media.example.com/v2/mcp" }))!;
  assert.equal(moved.has_token, true);
  assert.equal((await C.getConnectorWithSecrets(media.id))!.secrets.token, "media-token");

  // New host: the secrets are cleared and the account asks for its key again.
  const away = (await C.updateConnector(media.id, { url: "https://media2.example.com/mcp" }))!;
  assert.equal(away.has_token, false);
  assert.equal(away.status, "needs_auth");
  assert.deepEqual((await C.getConnectorWithSecrets(media.id))!.secrets, {});

  // ...unless the address is one Athena chose for the same sign-in.
  await C.updateConnectorSecrets(media.id, (s) => void (s.token = "again"));
  const kept = (await C.updateConnector(media.id, { url: "https://media3.example.com/mcp" }, { keepSignIn: true }))!;
  assert.equal(kept.has_token, true);

  // A v1 value (no context) still opens until v1 is retired, and is sealed again as v2 on read.
  const v1 = sealV1(process.env.CONNECTOR_ENCRYPTION_KEY!, JSON.stringify({ token: "legacy" }));
  await qRaw(`UPDATE connectors SET credentials = $2 WHERE id = $1`, [other.id, v1]);
  assert.equal((await C.getConnectorWithSecrets(other.id))!.secrets.token, "legacy");
  const [row] = await qRaw<{ credentials: string }>(`SELECT credentials FROM connectors WHERE id = $1`, [other.id]);
  assert.match(row.credentials, /^v2\./);
  assert.equal((await C.getConnectorWithSecrets(other.id))!.secrets.token, "legacy");
});

test("Retiring v1: every v1 credential sealed again, recorded once, then v1 refused", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const C = await import("./connectors");
  const F = await import("./secret-format");
  const { qRaw } = await import("./db");
  const { voiceCredentials } = await import("./voice-settings");
  const { tileCredentials, tmdbKeyForTest } = await import("./art-settings");
  const key = process.env.CONNECTOR_ENCRYPTION_KEY!;
  await qRaw(`DELETE FROM settings WHERE key = ANY($1)`, [[F.FORMAT_KEY, F.VOICE_ROW, F.ART_ROW]]);
  F.resetSecretFormat();
  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);

  const a = await C.createConnector({ name: "A", provider: "custom", url: "https://a.example.com/mcp", auth_type: "token", secrets: { token: "a" } });
  const b = await C.createConnector({ name: "B", provider: "custom", url: "https://b.example.com/mcp", auth_type: "token", secrets: { token: "b" } });
  const put = (id: string, sealed: string) => qRaw(`UPDATE connectors SET credentials = $2 WHERE id = $1`, [id, sealed]);
  const setting = (k: string, v: unknown) => qRaw(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
  const flag = async () => (await qRaw<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [F.FORMAT_KEY]))[0]?.value ?? null;
  const at = "2026-11-26T10:00:00Z";

  // Without the key: nothing done, nothing recorded.
  delete process.env.CONNECTOR_ENCRYPTION_KEY;
  try {
    assert.equal((await F.retireV1Secrets()).state, "no_key");
  } finally {
    process.env.CONNECTOR_ENCRYPTION_KEY = key;
  }
  assert.equal(await flag(), null);

  // A v1 value no key here opens keeps the pass from finishing.
  await put(a.id, sealV1(key, JSON.stringify({ token: "a-old" })));
  await put(b.id, sealV1("33".repeat(32), JSON.stringify({ token: "b-old" })));
  await setting(F.VOICE_ROW, { key: sealV1(key, "voice-key"), voice: null, status: "connected", connected_at: at, checked_at: at });
  await setting(F.ART_ROW, { tiles: { provider: "maptiler", key: sealV1(key, "tile-key"), status: "working", added_at: at, checked_at: at }, tmdb: { key: sealV1(key, "tmdb-key"), status: "working", added_at: at, checked_at: at } });
  const first = await F.retireV1Secrets();
  assert.deepEqual(first, { state: "pending", resealed: 4, unreadable: 1 });
  assert.equal(await flag(), null);

  // With the old key listed it opens; then the pass finishes and records it.
  process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS = "33".repeat(32);
  try {
    const second = await F.retireV1Secrets();
    assert.deepEqual(second, { state: "finished", resealed: 1, unreadable: 0 });
  } finally {
    delete process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS;
  }
  const recorded = (await flag()) as { v1_retired_at?: string; key_id?: string };
  assert.equal(typeof recorded.v1_retired_at, "string");
  assert.match(recorded.key_id ?? "", /^[0-9a-f]{8}$/);
  const [left] = await qRaw<{ n: number }>(`SELECT count(*)::int AS n FROM connectors WHERE credentials LIKE 'v1.%'`);
  assert.equal(left.n, 0);

  // Everything still opens, now as v2, for where it belongs.
  assert.equal((await C.getConnectorWithSecrets(a.id))!.secrets.token, "a-old");
  assert.equal((await voiceCredentials())?.key, "voice-key");
  assert.equal((await tileCredentials())?.key, "tile-key");
  assert.equal(await tmdbKeyForTest(), "tmdb-key");

  // From now on a v1 value put back into a row is refused: the account reads as signed out.
  await put(a.id, sealV1(key, JSON.stringify({ token: "replayed" })));
  assert.deepEqual((await C.getConnectorWithSecrets(a.id))!.secrets, {});
  assert.equal((await C.getConnector(a.id))!.has_token, false);
  // ...on another instance too, which learns it from the setting.
  F.resetSecretFormat();
  assert.deepEqual((await C.getConnectorWithSecrets(a.id))!.secrets, {});
  assert.equal((await F.retireV1Secrets()).state, "done");
});
