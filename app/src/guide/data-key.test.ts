// The guide's data key (app/src/guide/data-key.ts) gets the same key id the server does (lib/data-box.ts).
// Run: npx tsx --test app/src/guide/data-key.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataKeyId, makeDataKey } from "./data-key";
import { currentKeyId } from "../../../lib/data-box";

test("a made key is 64 hex characters, and a new one each time", () => {
  const a = makeDataKey();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, makeDataKey());
});

test("the browser works out the key id the server stores", async () => {
  const key = "2222222222222222222222222222222222222222222222222222222222222222";
  const was = process.env.ATHENA_DATA_KEY;
  process.env.ATHENA_DATA_KEY = key;
  try {
    assert.equal(await dataKeyId(key), currentKeyId());
  } finally {
    if (was === undefined) delete process.env.ATHENA_DATA_KEY;
    else process.env.ATHENA_DATA_KEY = was;
  }
});
