// Run: npx tsx --test scripts/check-preview-secrets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { message, previewSecrets, PRODUCTION_ONLY } from "./check-preview-secrets";

const script = fileURLToPath(new URL("./check-preview-secrets.ts", import.meta.url));

test("a preview or branch deploy that can see a production secret is named, by name only", () => {
  const env = { CONTEXT: "deploy-preview", MCP_BEARER_TOKEN: "x".repeat(64), SITE_PASSWORD: "hunter2", SESSION_SECRET: " " };
  assert.deepEqual(previewSecrets(env), ["MCP_BEARER_TOKEN", "SITE_PASSWORD"]);
  assert.deepEqual(previewSecrets({ ...env, CONTEXT: "branch-deploy" }), ["MCP_BEARER_TOKEN", "SITE_PASSWORD"]);
  assert.ok(!message("deploy-preview", ["SITE_PASSWORD"]).includes("hunter2"));
});

test("production, local and CI builds aren't checked", () => {
  const all = Object.fromEntries(PRODUCTION_ONLY.map((n) => [n, "set"]));
  assert.deepEqual(previewSecrets({ ...all, CONTEXT: "production" }), []);
  assert.deepEqual(previewSecrets({ ...all, CONTEXT: "dev" }), []);
  assert.deepEqual(previewSecrets(all), []);
});

test("the build stops, unless told to carry on", () => {
  const run = (extra: Record<string, string>) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", CONTEXT: "deploy-preview", MCP_BEARER_TOKEN: "t", ...extra };
    try {
      execFileSync(process.execPath, ["--import", "tsx", script], { env, stdio: "pipe" });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  assert.equal(run({}), 1);
  assert.equal(run({ ATHENA_ALLOW_PREVIEW_SECRETS: "1" }), 0);
  assert.equal(run({ CONTEXT: "production" }), 0);
});
