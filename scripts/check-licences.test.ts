// The dependency licence check: which SPDX expressions pass, and which packages it reports.
// Run: npx tsx --test scripts/check-licences.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowed, problems } from "./check-licences";

test("permissive and library-level copyleft licences pass", () => {
  for (const license of ["MIT", "Apache-2.0", "ISC", "MPL-2.0", "LGPL-3.0-or-later", "(MIT OR CC0-1.0)", "Apache-2.0 AND LGPL-3.0-or-later AND MIT"]) {
    assert.equal(allowed(license), true, license);
  }
});

test("strong copyleft, source-available and unknown licences fail", () => {
  for (const license of ["GPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1", "(none)", "MIT AND GPL-2.0-only", "MIT OR GPL-2.0 AND ISC"]) {
    assert.equal(allowed(license), false, license);
  }
});

test("an OR passes when either side is allowed", () => {
  assert.equal(allowed("GPL-2.0-only OR MIT"), true);
});

test("dev dependencies and the project itself are skipped; packages with no licence field use KNOWN", () => {
  const found = problems({
    packages: {
      "": { license: "AGPL-3.0-or-later" },
      "node_modules/left": { license: "MIT" },
      "node_modules/strict": { license: "GPL-3.0-only" },
      "node_modules/tooling": { license: "GPL-3.0-only", dev: true },
      "node_modules/callsite": {},
      "node_modules/mystery": {},
      "node_modules/a/node_modules/@scope/nested": { license: "AGPL-3.0-only" },
    },
  });
  assert.deepEqual(found, [
    { name: "strict", license: "GPL-3.0-only" },
    { name: "mystery", license: "(none)" },
    { name: "@scope/nested", license: "AGPL-3.0-only" },
  ]);
});

test("every dependency Athena ships today has an allowed licence", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(problems(lock), []);
});
