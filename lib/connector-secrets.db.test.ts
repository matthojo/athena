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

test("Connector secrets: bound to the account and its address", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const C = await import("./connectors");
  const { qRaw } = await import("./db");
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

  // A v1 value (no context) still opens, and is sealed again as v2 on read.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(process.env.CONNECTOR_ENCRYPTION_KEY!, "hex"), iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(JSON.stringify({ token: "legacy" }), "utf8"), cipher.final()]);
  const v1 = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  await qRaw(`UPDATE connectors SET credentials = $2 WHERE id = $1`, [other.id, v1]);
  assert.equal((await C.getConnectorWithSecrets(other.id))!.secrets.token, "legacy");
  const [row] = await qRaw<{ credentials: string }>(`SELECT credentials FROM connectors WHERE id = $1`, [other.id]);
  assert.match(row.credentials, /^v2\./);
  assert.equal((await C.getConnectorWithSecrets(other.id))!.secrets.token, "legacy");
});
