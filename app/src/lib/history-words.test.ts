// Run: npx tsx --test app/src/lib/history-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyWords } from "./history-words";

test("the history row: loading with a count, then loaded back to a month", () => {
  assert.equal(historyWords({ state: "running", items: 1240, added: 1240 }, "Trakt").title, "Loading your history… 1,240 items so far");
  assert.equal(historyWords({ state: "running", items: 0, added: 0 }, "Trakt").title, "Loading your history…");
  const done = historyWords({ state: "done", items: 2318, added: 12, oldest: "2019-03-02" }, "Trakt");
  assert.equal(done.title, "History loaded back to March 2019");
  assert.equal(done.meta, "2,318 items · 12 new to Athena");
  assert.equal(done.busy, false);
  assert.match(historyWords({ state: "done", items: 20000, added: 0, oldest: "2012-01-01", capped: true }, "Last.fm").meta, /the most recent ones/);
  assert.match(historyWords({ state: "waiting", items: 50, added: 50, error: "Athena has used today's YouTube allowance." }, "YouTube").meta, /carries on after that/);
  assert.equal(historyWords({ state: "blocked", items: 0, added: 0 }, "Trakt").title, "Choose what Athena can read to load your history");
  assert.equal(historyWords({ state: "failed", items: 0, added: 0, error: "Sign in again" }, "Trakt").meta, "Sign in again");
});

test("Octopus counts days of readings, not items", () => {
  assert.equal(historyWords({ state: "running", items: 120, added: 120, unit: "day" }, "Octopus Energy").title, "Loading your history… 120 days so far");
  const done = historyWords({ state: "done", items: 731, added: 731, oldest: "2024-11-10", unit: "day" }, "Octopus Energy");
  assert.equal(done.title, "History loaded back to November 2024");
  assert.equal(done.meta, "731 days");
  assert.equal(historyWords({ state: "running", items: 1, added: 1, unit: "day" }, "Octopus Energy").title, "Loading your history… 1 day so far");
});
