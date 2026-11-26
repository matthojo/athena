// The site's headers (netlify.toml) against what the app needs: the inlined appearance script's hash, and the
// rich-link players' hosts. Run: npx tsx --test app/src/lib/headers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOT_SCRIPT } from "./appearance-boot";
import { EMBED_FRAME_HOSTS } from "../../../lib/embeds";

const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../netlify.toml"), "utf8");

function header(name: string): string {
  const m = new RegExp(`^\\s*${name.replace(/-/g, "\\-")}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  assert.ok(m, `netlify.toml sets ${name}`);
  return m[1];
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );
}

const enforced = directives(header("Content-Security-Policy"));
const trial = directives(header("Content-Security-Policy-Report-Only"));
const bootHash = `'sha256-${createHash("sha256").update(BOOT_SCRIPT, "utf8").digest("base64")}'`;

test("both policies allow the inlined appearance script by its hash", () => {
  for (const policy of [enforced, trial]) {
    assert.ok(policy.get("script-src")?.includes(bootHash), `script-src needs ${bootHash} (app/src/lib/appearance-boot.ts changed)`);
  }
});

test("script runs only from Athena's own files: no inline script, no eval", () => {
  for (const policy of [enforced, trial]) {
    const scripts = policy.get("script-src") ?? [];
    assert.ok(scripts.includes("'self'"));
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "https:", "*", "data:"]) assert.ok(!scripts.includes(bad), `script-src allows ${bad}`);
    assert.deepEqual(policy.get("object-src"), ["'none'"]);
    assert.deepEqual(policy.get("base-uri"), ["'none'"]);
    assert.deepEqual(policy.get("frame-ancestors"), ["'self'"]);
  }
});

test("frame-src lists exactly the rich-link players' hosts", () => {
  for (const policy of [enforced, trial]) {
    assert.deepEqual(policy.get("frame-src"), ["'self'", "blob:", ...EMBED_FRAME_HOSTS]);
  }
});

test("the other security headers are set", () => {
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(header("Referrer-Policy"), "same-origin");
  assert.match(header("Permissions-Policy"), /camera=\(\)/);
});
