// Run: npx tsx --test scripts/sign-catalogue.test.ts
// Signing the catalogue's index.json, and checking it as Athena's server does, with a key pair made for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listedPublicKey, privateKeyFrom, publicKeyFrom, signIndex, verifyIndexSignature } from "../lib/catalogue-signature";
import { signFile } from "./sign-catalogue";

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const body = new TextEncoder().encode('{"format":1,"items":[],"withdrawn":[]}\n');

test("a signature verifies for its key and its exact bytes only", () => {
  const sig = signIndex(body, pair.privateKey);
  const listed = listedPublicKey(pair.publicKey);
  assert.equal(verifyIndexSignature(body, sig, [listed]), true);
  assert.equal(verifyIndexSignature(body, ` ${sig}\r\n`, [listed]), true);
  assert.equal(verifyIndexSignature(new TextEncoder().encode('{"format":1,"items":[],"withdrawn":[]}'), sig, [listed]), false);
  assert.equal(verifyIndexSignature(body, sig, [listedPublicKey(other.publicKey)]), false);
  assert.equal(verifyIndexSignature(body, sig, []), false);
  assert.equal(verifyIndexSignature(body, "", [listed]), false);
});

test("two keys listed, as during a rotation: either verifies; a malformed entry is skipped", () => {
  const listed = ["not-a-key", listedPublicKey(other.publicKey), listedPublicKey(pair.publicKey)];
  assert.equal(verifyIndexSignature(body, signIndex(body, pair.privateKey), listed), true);
  assert.equal(verifyIndexSignature(body, signIndex(body, other.privateKey), listed), true);
  assert.equal(publicKeyFrom("not-a-key"), null);
});

test("the private key reads as PEM or as one line of base64 DER, and its public half is listed from it", () => {
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const der = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.equal(listedPublicKey(privateKeyFrom(pem)), listedPublicKey(pair.publicKey));
  assert.equal(listedPublicKey(privateKeyFrom(der)), listedPublicKey(pair.publicKey));
  assert.match(listedPublicKey(pair.publicKey), /^[A-Za-z0-9+/]{43}=$/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.throws(() => privateKeyFrom(rsa), /Ed25519/);
});

test("signFile writes index.json.sig beside the index", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "athena-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "index.json");
  writeFileSync(path, body);
  const { sigPath, publicKey } = signFile(path, pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  assert.equal(sigPath, `${path}.sig`);
  assert.equal(verifyIndexSignature(body, readFileSync(sigPath, "utf8"), [publicKey]), true);
});
