// Run: npx tsx --test app/src/lib/file-limits.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FileTooBig, readText } from "./file-limits";

test("reads a file under the limit", async () => {
  assert.equal(await readText(new Blob(["title,date"]), 100), "title,date");
});

test("refuses a file over the limit without reading it", async () => {
  const big = new Blob(["x".repeat(101)]);
  let read = false;
  big.text = () => ((read = true), Promise.resolve(""));
  await assert.rejects(readText(big, 100), FileTooBig);
  assert.equal(read, false);
});
