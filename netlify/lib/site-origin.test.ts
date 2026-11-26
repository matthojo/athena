// Run: npx tsx --test netlify/lib/site-origin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { corsOrigin, siteOrigin, siteOrigins } from "./site-origin";

const own = { request: "https://athena.example.com", site: ["https://athena.example.com", "https://main--athena-example.netlify.app"] };

test("CORS names the site's own addresses and a browser extension, and nothing else", () => {
  assert.equal(corsOrigin("https://athena.example.com", own), "https://athena.example.com");
  assert.equal(corsOrigin("https://main--athena-example.netlify.app", own), "https://main--athena-example.netlify.app");
  assert.equal(corsOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop", own), "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  assert.equal(corsOrigin("moz-extension://3b1f2c4d-1111-4222-8333-444455556666", own), "moz-extension://3b1f2c4d-1111-4222-8333-444455556666");
  assert.equal(corsOrigin("safari-web-extension://3b1f2c4d-1111-4222-8333-444455556666", own), "safari-web-extension://3b1f2c4d-1111-4222-8333-444455556666");
  assert.equal(corsOrigin("https://elsewhere.example.org", own), null);
  assert.equal(corsOrigin("https://athena.example.com.elsewhere.example.org", own), null);
  assert.equal(corsOrigin("null", own), null);
  assert.equal(corsOrigin(null, own), null);
  // A request is always allowed its own origin (the site under an address Netlify's variables don't name).
  assert.equal(corsOrigin("https://athena.test", { request: "https://athena.test", site: [] }), "https://athena.test");
});

test("the site's own address comes from Netlify's URL, and the request's only when URL isn't set", () => {
  const was = { url: process.env.URL, prime: process.env.DEPLOY_PRIME_URL, deploy: process.env.DEPLOY_URL };
  try {
    process.env.URL = "https://athena.example.com/";
    delete process.env.DEPLOY_PRIME_URL;
    process.env.DEPLOY_URL = "https://abc123--athena-example.netlify.app";
    assert.equal(siteOrigin("https://other.example.org"), "https://athena.example.com");
    assert.deepEqual(siteOrigins(), ["https://athena.example.com", "https://abc123--athena-example.netlify.app"]);
    delete process.env.URL;
    assert.equal(siteOrigin("http://localhost:8888"), "http://localhost:8888");
  } finally {
    for (const [k, v] of [["URL", was.url], ["DEPLOY_PRIME_URL", was.prime], ["DEPLOY_URL", was.deploy]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
