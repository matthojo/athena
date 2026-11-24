// Community's words and list logic (app/src/community/words.ts). Made-up items only.
// Run: npx tsx --test app/src/community/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogueItem } from "../../../lib/catalogue-types";
import { communityHash, filtered, matches, ordered, readKind, tierWords, versionWords } from "./words";

const item = (over: Partial<CatalogueItem>): CatalogueItem => ({
  id: "a1b2c3d4e5f6g7h8",
  kind: "flow",
  slug: "bin-day",
  name: "Bin day",
  summary: "A reminder the evening before the bins go out.",
  author: "kerbside-kit",
  version: "1.0",
  reach: { tier: 1, model: false, web: false, lookups: [], needs: [] },
  needs: [],
  hash: `sha256-${"0".repeat(64)}`,
  min_format: 1,
  featured: false,
  added_at: "2026-11-01T00:00:00Z",
  bundle: "bundles/a.json",
  ...over,
});

test("tier words are plain and name each lookup", () => {
  assert.equal(tierWords({ tier: 1, model: false, lookups: [] }), "Stays in Athena");
  assert.equal(tierWords({ tier: 2, model: true, lookups: [] }), "Uses AI");
  assert.equal(tierWords({ tier: 2, model: false, lookups: ["weather"] }), "Checks the weather forecast");
  assert.equal(tierWords({ tier: 2, model: true, lookups: ["weather", "train_status"] }), "Uses AI, the weather forecast and live train times");
  assert.equal(tierWords({ tier: 3, model: true, lookups: [] }), "Searches the web");
});

test("the kind in the address, and back", () => {
  assert.equal(readKind("flow"), "flow");
  assert.equal(readKind("flows"), "all");
  assert.equal(readKind(null), "all");
  assert.equal(communityHash("skill"), "#/community?kind=skill");
  assert.equal(communityHash(), "#/community");
});

test("search matches every word, in any field, without accents or case", () => {
  const i = item({ name: "Café list", needs: ["gmail"] });
  assert.ok(matches(i, "cafe"));
  assert.ok(matches(i, "KERBSIDE bins"));
  assert.ok(matches(i, "gmail flow"));
  assert.ok(matches(i, "Gmail", (p) => (p === "gmail" ? "Gmail" : p)));
  assert.ok(!matches(i, "cafe slack"));
  assert.ok(matches(i, "   "));
});

test("featured first, then newest; the filter keeps counts for every kind", () => {
  const a = item({ id: "1", name: "Old", added_at: "2026-01-01T00:00:00Z" });
  const b = item({ id: "2", name: "New", added_at: "2026-11-20T00:00:00Z" });
  const c = item({ id: "3", name: "Pick", featured: true, added_at: "2025-01-01T00:00:00Z", kind: "skill" });
  assert.deepEqual(
    ordered([a, b, c]).map((i) => i.id),
    ["3", "2", "1"]
  );
  const f = filtered([a, b, c], "flow", "");
  assert.deepEqual(
    f.items.map((i) => i.id),
    ["2", "1"]
  );
  assert.deepEqual(f.counts, { all: 3, assistant: 0, skill: 1, flow: 2 });
  assert.equal(filtered([a, b, c], "all", "pick").counts.all, 1);
});

test("version words", () => {
  assert.equal(versionWords("1.3", "1.4"), "Version 1.3 → 1.4");
  assert.equal(versionWords(null, "2.0"), "Version 2.0");
  assert.equal(versionWords("1.0", null), "A newer version");
});
