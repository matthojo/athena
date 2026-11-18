import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, parseVersion, readLatestRelease } from "./version";

test("parseVersion: plain and v-prefixed versions, nothing else", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("v10.0.12"), [10, 0, 12]);
  assert.equal(parseVersion("dev"), null);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("1.2.3-beta.1"), null);
});

test("isNewer compares each part as a number", () => {
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("v2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.1"), false);
  assert.equal(isNewer("1.0.1", "dev"), false, "a development build is never told to update");
});

test("readLatestRelease takes the tag and page of a published release only", () => {
  const ok = { tag_name: "v1.1.0", html_url: "https://github.com/matthojo/athena/releases/tag/v1.1.0", draft: false, prerelease: false };
  assert.deepEqual(readLatestRelease(ok), { version: "1.1.0", url: ok.html_url });
  assert.equal(readLatestRelease({ ...ok, prerelease: true }), null);
  assert.equal(readLatestRelease({ ...ok, draft: true }), null);
  assert.equal(readLatestRelease({ ...ok, tag_name: "nightly" }), null);
  assert.equal(readLatestRelease({ ...ok, html_url: "https://evil.example/athena" }), null, "a link only ever goes to the release page");
  assert.equal(readLatestRelease({ message: "Not Found" }), null);
  assert.equal(readLatestRelease(null), null);
});
