// Run: npx tsx --test lib/secret-box.test.ts
// Connector credentials: sealed for one place, openable after a key rotation, and v1 values still read.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { needsReseal, open, openJson, seal, sealJson, secretBoxConfigured, SecretBoxUnavailable } from "./secret-box";
import { sameOrigin, secretsContext } from "./connectors";

const OLD = "11".repeat(32);
const NEW = "22".repeat(32);
const saved = { key: process.env.CONNECTOR_ENCRYPTION_KEY, previous: process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS };

function keys(current?: string, previous?: string) {
  if (current === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
  else process.env.CONNECTOR_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS;
  else process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS = previous;
}

afterEach(() => keys(saved.key, saved.previous));

/** A value in the format Athena wrote before v2: no key id, no context. */
function sealV1(hex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

test("v2 values carry a key id and open only for the context they were sealed for", () => {
  keys(NEW);
  const a = secretsContext({ id: "0b7f3c1e-0000-4000-8000-000000000001", provider: "custom", url: "https://mcp.example.com/mcp" });
  const sealed = sealJson({ token: "t" }, a);
  assert.match(sealed, /^v2\.[0-9a-f]{8}\./);
  assert.deepEqual(openJson(sealed, a), { token: "t" });
  // Another address, another account or another provider: the tag doesn't verify.
  for (const other of [
    secretsContext({ id: "0b7f3c1e-0000-4000-8000-000000000001", provider: "custom", url: "https://evil.example.net/mcp" }),
    secretsContext({ id: "0b7f3c1e-0000-4000-8000-000000000002", provider: "custom", url: "https://mcp.example.com/mcp" }),
    secretsContext({ id: "0b7f3c1e-0000-4000-8000-000000000001", provider: "github", url: "https://mcp.example.com/mcp" }),
    "",
  ]) {
    assert.throws(() => openJson(sealed, other));
  }
  assert.equal(needsReseal(sealed), false);
});

test("v1 values still open, for any context, and are marked for sealing again", () => {
  keys(NEW);
  const v1 = sealV1(NEW, JSON.stringify({ token: "old" }));
  assert.deepEqual(openJson(v1, "connector\nany"), { token: "old" });
  assert.equal(needsReseal(v1), true);
});

test("rotation: values under a previous key open, new ones use the current key", () => {
  keys(OLD);
  const before = seal("secret", "ctx");
  const v1 = sealV1(OLD, "older");
  keys(NEW, `  ${"33".repeat(32)}, ${OLD} `);
  assert.equal(open(before, "ctx"), "secret");
  assert.equal(open(v1), "older");
  assert.equal(needsReseal(before), true);
  const after = seal("secret", "ctx");
  assert.equal(needsReseal(after), false);
  assert.notEqual(after.split(".")[1], before.split(".")[1]);
  // Once the previous key is gone, what was sealed under it is gone too.
  keys(NEW);
  assert.throws(() => open(before, "ctx"), /key id/);
  assert.throws(() => open(v1));
});

test("without a key nothing seals or opens, and the box says so", () => {
  keys(NEW);
  const sealed = seal("x");
  keys(undefined);
  assert.equal(secretBoxConfigured(), false);
  assert.throws(() => seal("x"), SecretBoxUnavailable);
  assert.throws(() => open(sealed), SecretBoxUnavailable);
  keys("not-hex");
  assert.equal(secretBoxConfigured(), false);
});

test("a changed ciphertext or an unknown format is refused", () => {
  keys(NEW);
  const parts = seal("hello").split(".");
  const ct = Buffer.from(parts[4], "base64url");
  ct[0] ^= 1;
  assert.throws(() => open([...parts.slice(0, 4), ct.toString("base64url")].join(".")));
  assert.throws(() => open("v3.a.b.c"), /Unrecognised/);
  assert.equal(openJson(null), null);
});

test("sameOrigin: scheme, host and port", () => {
  assert.equal(sameOrigin("https://media.example.com/a", "https://media.example.com/b?x=1"), true);
  assert.equal(sameOrigin("https://media.example.com/", "https://other.example.com/"), false);
  assert.equal(sameOrigin("https://media.example.com/", "https://media.example.com:8443/"), false);
  assert.equal(sameOrigin("not a url", "https://media.example.com/"), false);
});
