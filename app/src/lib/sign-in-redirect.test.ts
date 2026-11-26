// Run: npx tsx --test app/src/lib/sign-in-redirect.test.ts
// A sign-in address chosen by a server's metadata is opened only when it's https.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSignInAddress } from "./sign-in-redirect";

const site = { protocol: "https:", hostname: "athena.example.com" };
const dev = { protocol: "http:", hostname: "localhost" };

test("https sign-in pages open", () => {
  assert.equal(isSignInAddress("https://auth.example.com/authorize?client_id=x", site), true);
});

test("script, data and other schemes never open", () => {
  for (const u of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<p>x</p>", "vbscript:x", "file:///etc/passwd", "ftp://auth.example.com/", "http://auth.example.com/authorize", "not a url", ""]) {
    assert.equal(isSignInAddress(u, site), false, u);
  }
});

test("plain http only to this machine, and only while Athena runs on it", () => {
  assert.equal(isSignInAddress("http://localhost:8788/authorize", dev), true);
  assert.equal(isSignInAddress("http://127.0.0.1:8788/authorize", dev), true);
  assert.equal(isSignInAddress("http://localhost:8788/authorize", site), false);
  assert.equal(isSignInAddress("http://auth.example.com/authorize", dev), false);
});
