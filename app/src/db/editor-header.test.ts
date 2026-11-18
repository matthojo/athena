/**
 * Note versions: the queued note edits (typed in the editor) are the one place
 * the app says `editor: true`, which api.ts turns into X-Athena-Editor: 1.
 * Run: npx tsx --test app/src/db/editor-header.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.endsWith(".test.ts") ? [join(dir, f)] : []));

test("only sync.ts's queued note edit asks for the editor header", () => {
  const users = files(SRC).filter((f) => /editor:\s*true/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
  assert.deepEqual(users, ["db/sync.ts"]);
  const sync = readFileSync(join(SRC, "db/sync.ts"), "utf8");
  assert.equal(sync.match(/editor:\s*true/g)!.length, 1);
  assert.match(sync, /op === "update"\) \{[^}]*api\.updateNote\(id, entry\.payload, \{ editor: true \}\)/s);
});

test("the header is set in one place, on note PATCH requests", () => {
  const users = files(SRC).filter((f) => readFileSync(f, "utf8").includes("X-Athena-Editor")).map((f) => f.slice(SRC.length));
  assert.deepEqual(users, ["db/api.ts"]);
  const api = readFileSync(join(SRC, "db/api.ts"), "utf8");
  assert.equal(api.match(/"X-Athena-Editor"/g)!.length, 1);
});
