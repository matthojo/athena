// Run: npx tsx --test netlify/lib/connectors/sign-in-address.test.ts
// The sign-in address a server's OAuth metadata names is handed to the app only when it's https.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { isSignInAddress } from "./mcp-client";

const dev = process.env.NETLIFY_DEV;
afterEach(() => {
  if (dev === undefined) delete process.env.NETLIFY_DEV;
  else process.env.NETLIFY_DEV = dev;
});

test("https only, never a script or data URL", () => {
  delete process.env.NETLIFY_DEV;
  assert.equal(isSignInAddress("https://auth.example.com/authorize"), true);
  for (const u of ["javascript:alert(1)", "data:text/html,x", "http://auth.example.com/authorize", "http://localhost:8788/authorize", "nonsense"]) {
    assert.equal(isSignInAddress(u), false, u);
  }
});

test("a local server's plain http address under netlify dev", () => {
  process.env.NETLIFY_DEV = "true";
  assert.equal(isSignInAddress("http://localhost:8788/authorize"), true);
  assert.equal(isSignInAddress("http://auth.example.com/authorize"), false);
});
