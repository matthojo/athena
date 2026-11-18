import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultProgressUnit, parseProgress, progressFraction, progressFromColumns, progressWords } from "./watch-read";

test("progress: pages, episodes or a percent, checked", () => {
  assert.equal(parseProgress(undefined), undefined, "not given: keep it");
  assert.equal(parseProgress(null), null, "null: clear it");
  assert.deepEqual(parseProgress({ unit: "page", done: 120, total: 300 }), { unit: "page", done: 120, total: 300 });
  assert.deepEqual(parseProgress({ unit: "episode", done: "4" }), { unit: "episode", done: 4, total: null }, "a total is optional; digits from a form are fine");
  assert.deepEqual(parseProgress({ unit: "percent", done: 45, total: null }), { unit: "percent", done: 45, total: null });
  assert.deepEqual(parseProgress({ unit: "page", done: 0, total: "" }), { unit: "page", done: 0, total: null });
  for (const bad of [
    { unit: "chapter", done: 1 },
    { unit: "page", done: -1 },
    { unit: "page", done: 1.5 },
    { unit: "page", done: 310, total: 300 },
    { unit: "page", done: 1, total: 0 },
    { unit: "percent", done: 101 },
    { unit: "percent", done: 40, total: 100 },
    "45%",
    [1, 2],
  ])
    assert.ok(parseProgress(bad) && "problem" in (parseProgress(bad) as object), JSON.stringify(bad));
});

test("progress: from the stored columns, as a share and in words", () => {
  // The round trip: what parseProgress keeps comes back from the columns unchanged.
  for (const p of [
    { unit: "page", done: 120, total: 300 },
    { unit: "episode", done: 4, total: null },
    { unit: "percent", done: 45, total: null },
  ] as const) {
    const kept = parseProgress(p) as { unit: string; done: number; total: number | null };
    assert.deepEqual(progressFromColumns(kept.unit, kept.done, kept.total), p);
  }
  assert.equal(progressFromColumns(null, null, null), null);
  assert.equal(progressFromColumns("page", 5, 2), null, "a row that makes no sense reads as none");

  assert.equal(progressFraction({ unit: "page", done: 120, total: 300 }, "reading"), 0.4);
  assert.equal(progressFraction({ unit: "percent", done: 45, total: null }), 0.45);
  assert.equal(progressFraction({ unit: "episode", done: 4, total: null }, "reading"), null, "no total: unknown share");
  assert.equal(progressFraction(null, "queued"), 0);
  assert.equal(progressFraction(null, "reading"), null);
  assert.equal(progressFraction({ unit: "page", done: 1, total: 300 }, "done"), 1);

  assert.equal(progressWords({ unit: "page", done: 120, total: 300 }), "Page 120 of 300");
  assert.equal(progressWords({ unit: "episode", done: 4, total: 8 }), "Episode 4 of 8");
  assert.equal(progressWords({ unit: "page", done: 120, total: null }), "Page 120");
  assert.equal(progressWords({ unit: "percent", done: 45, total: null }), "45%");

  assert.equal(defaultProgressUnit("book"), "page");
  assert.equal(defaultProgressUnit("paper"), "page");
  assert.equal(defaultProgressUnit("tv"), "episode");
  assert.equal(defaultProgressUnit("podcast"), "episode");
  assert.equal(defaultProgressUnit("film"), "percent");
  assert.equal(defaultProgressUnit("game"), "percent");
});
