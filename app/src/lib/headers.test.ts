// The site's headers (netlify.toml) against what the app needs: the inlined appearance script's hash, Talk's
// worklet as a file of Athena's own, and the rich-link players' hosts. Run: npx tsx --test app/src/lib/headers.test.ts
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

const policy = directives(header("Content-Security-Policy"));
const bootHash = `'sha256-${createHash("sha256").update(BOOT_SCRIPT, "utf8").digest("base64")}'`;

test("the policy allows the inlined appearance script by its hash", () => {
  assert.ok(policy.get("script-src")?.includes(bootHash), `script-src needs ${bootHash} (app/src/lib/appearance-boot.ts changed)`);
});

test("script runs only from Athena's own files: no inline script, no eval, no blob:", () => {
  const scripts = policy.get("script-src") ?? [];
  assert.ok(scripts.includes("'self'"));
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "https:", "*", "data:", "blob:"]) assert.ok(!scripts.includes(bad), `script-src allows ${bad}`);
  assert.deepEqual(policy.get("worker-src"), ["'self'"]);
  assert.deepEqual(policy.get("default-src"), ["'self'"]);
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("base-uri"), ["'none'"]);
  assert.deepEqual(policy.get("form-action"), ["'self'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'self'"]);
});

test("the policy is enforced, not only reported", () => {
  assert.ok(!/^\s*Content-Security-Policy-Report-Only\s*=/m.test(toml), "a Report-Only policy is left over");
});

test("Talk's worklet is a file of Athena's own, not a blob: script", () => {
  const mic = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../talk/mic.ts"), "utf8");
  const path = /addModule\(WORKLET_URL\)/.test(mic) && /const WORKLET_URL = "(\/[\w.-]+\.js)"/.exec(mic)?.[1];
  assert.ok(path, "mic.ts loads the worklet from WORKLET_URL");
  assert.ok(!/createObjectURL/.test(mic), "mic.ts makes no blob: URL for script");
  const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public", path), "utf8");
  assert.match(file, /registerProcessor\("athena-tap"/);
});

test("frame-src lists exactly the rich-link players' hosts", () => {
  assert.deepEqual(policy.get("frame-src"), ["'self'", "blob:", ...EMBED_FRAME_HOSTS]);
});

test("the other security headers are set", () => {
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(header("Referrer-Policy"), "same-origin");
  assert.match(header("Permissions-Policy"), /camera=\(\)/);
});
