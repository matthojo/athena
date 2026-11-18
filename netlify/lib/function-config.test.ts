// Netlify reads each function's `export const config` without running the file,
// so every path, excludedPath and schedule must be a literal. An imported
// constant registers nothing: /api/backfill-run answered 404 for a day because
// its path was `BACKFILL_PATH`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKFILL_PATH } from "./connectors/backfill";

const dir = join(import.meta.dirname, "..", "functions");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

/** The text of `export const config ... = { ... };` (to the first `};`). */
function configOf(src: string): string | null {
  const start = src.search(/export const config\b/);
  if (start < 0) return null;
  const end = src.indexOf("};", start);
  return src.slice(start, end < 0 ? undefined : end + 2);
}

test("function configs use literal paths and schedules", () => {
  for (const f of files) {
    const cfg = configOf(readFileSync(join(dir, f), "utf8"));
    if (!cfg) continue;
    for (const key of ["path", "excludedPath", "schedule"]) {
      const m = cfg.match(new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`));
      if (!m) continue;
      assert.match(m[1].trim(), /^["'`[]/, `${f}: config.${key} must be a literal, not ${m[1].trim()}`);
    }
  }
});

test("the backfill background function is at the path the trigger posts to", () => {
  const cfg = configOf(readFileSync(join(dir, "backfill-run.ts"), "utf8"))!;
  assert.ok(cfg.includes(`path: "${BACKFILL_PATH}"`), "backfill-run.ts config.path must equal BACKFILL_PATH");
});
