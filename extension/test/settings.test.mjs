import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress, validateKey, validateSettings, originPattern } from "../src/lib/settings.js";

const KEY = "athc_" + "a".repeat(43);

test("address: adds https and keeps only the origin", () => {
  assert.deepEqual(normalizeAddress(" athena.example.com "), { ok: true, origin: "https://athena.example.com" });
  assert.equal(normalizeAddress("https://athena.example.com/settings?x=1").origin, "https://athena.example.com");
  assert.equal(normalizeAddress("HTTPS://Athena.Example.Com/").origin, "https://athena.example.com");
  assert.equal(normalizeAddress("https://athena.example.com:8443").origin, "https://athena.example.com:8443");
});

test("address: plain http only for localhost", () => {
  assert.equal(normalizeAddress("http://localhost:8888").origin, "http://localhost:8888");
  assert.equal(normalizeAddress("http://127.0.0.1:9000").origin, "http://127.0.0.1:9000");
  assert.match(normalizeAddress("http://athena.example.com").error, /https/);
});

test("address: refuses junk, other schemes and credentials", () => {
  assert.equal(normalizeAddress("").ok, false);
  assert.equal(normalizeAddress("not a url").ok, false);
  assert.equal(normalizeAddress("athena").ok, false);
  assert.equal(normalizeAddress("ftp://athena.example.com").ok, false);
  assert.match(normalizeAddress("https://me:pw@athena.example.com").error, /password/);
});

test("key: capture keys only", () => {
  assert.deepEqual(validateKey(` ${KEY} `), { ok: true, key: KEY });
  assert.equal(validateKey(`Bearer ${KEY}`).key, KEY);
  assert.match(validateKey("athk_" + "a".repeat(43)).error, /full-access/);
  assert.match(validateKey("athc_short").error, /athc_/);
  assert.match(validateKey("sk-123").error, /athc_/);
  assert.equal(validateKey("").ok, false);
});

test("settings: reports each field's error", () => {
  const bad = validateSettings({ address: "", key: "x" });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.address && bad.errors.key);
  const good = validateSettings({ address: "athena.example.com", key: KEY });
  assert.deepEqual(good, { ok: true, settings: { origin: "https://athena.example.com", key: KEY } });
  assert.equal(originPattern("https://athena.example.com"), "https://athena.example.com/*");
});
