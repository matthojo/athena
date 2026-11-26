// Community's words and list logic (app/src/community/words.ts). Made-up items only.
// Run: npx tsx --test app/src/community/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogueItem } from "../../../lib/catalogue-types";
import { checkWords, emptyKindWords, lastReadWords, readWhen, communityHash, downloadCount, submitSteps, downloadWords, filtered, hasDownloads, matches, ordered, readKind, readSort, tierWords, versionWords } from "./words";

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
  assert.equal(communityHash("all", "downloads"), "#/community?sort=downloads");
  assert.equal(communityHash("flow", "downloads"), "#/community?kind=flow&sort=downloads");
  assert.equal(readSort("downloads"), "downloads");
  assert.equal(readSort("popular"), "featured");
  assert.equal(readSort(null), "featured");
});

test("download counts round down to a figure that reads at a glance", () => {
  assert.equal(downloadCount(undefined), null);
  assert.equal(downloadCount(0), null, "a new item isn't marked down for having none yet");
  assert.equal(downloadCount(1), "1");
  assert.equal(downloadCount(9), "9");
  assert.equal(downloadCount(10), "10+");
  assert.equal(downloadCount(47), "40+");
  assert.equal(downloadCount(100), "100+");
  assert.equal(downloadCount(999), "900+");
  assert.equal(downloadCount(1000), "1k+");
  assert.equal(downloadCount(1999), "1k+");
  assert.equal(downloadCount(12_345), "12k+");
  assert.equal(downloadCount(999_999), "999k+");
  assert.equal(downloadCount(1_000_000), "1m+");
  assert.equal(downloadCount(1_250_000), "1.2m+");
  assert.equal(downloadWords(1), "1 download");
  assert.equal(downloadWords(150), "100+ downloads");
  assert.equal(downloadWords(undefined), null);
});

test("most downloaded first, with no count as none, then newest", () => {
  const a = item({ id: "1", name: "Quiet", downloads: 12, added_at: "2026-01-01T00:00:00Z" });
  const b = item({ id: "2", name: "Busy", downloads: 4_000, added_at: "2025-06-01T00:00:00Z" });
  const c = item({ id: "3", name: "Uncounted", featured: true, added_at: "2026-11-20T00:00:00Z" });
  const d = item({ id: "4", name: "New", downloads: 0, added_at: "2026-11-21T00:00:00Z" });
  assert.deepEqual(
    ordered([a, b, c, d], "downloads").map((i) => i.id),
    ["2", "1", "4", "3"]
  );
  assert.deepEqual(
    filtered([a, b, c, d], "all", "", undefined, "downloads").items.map((i) => i.id),
    ["2", "1", "4", "3"]
  );
  assert.equal(hasDownloads([a, c]), true);
  assert.equal(hasDownloads([c]), false);
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
  assert.deepEqual(f.counts, { all: 3, assistant: 0, skill: 1, flow: 2, checkin: 0, template: 0, theme: 0 });
  assert.equal(filtered([a, b, c], "all", "pick").counts.all, 1);
});

test("version words", () => {
  assert.equal(versionWords("1.3", "1.4"), "Version 1.3 → 1.4");
  assert.equal(versionWords(null, "2.0"), "Version 2.0");
  assert.equal(versionWords("1.0", null), "A newer version");
});

test("Submit to Community names the kind and its file, and says Athena publishes nothing", () => {
  const w = submitSteps("flow", "flow.json");
  assert.equal(w.steps.length, 2);
  assert.match(w.hint, /flow/);
  assert.match(w.steps[0].title, /public GitHub repository/);
  assert.match(w.steps[0].detail, /flow\.json/);
  assert.match(w.steps[1].title, /Community site/);
  assert.match(w.lede, /won't publish/);
  assert.match(submitSteps("skill", "SKILL.md").steps[0].detail, /SKILL\.md/);
});

const NOW = new Date("2026-11-26T15:00:00Z");

test("when the list was read: today, yesterday, or the date, with the time", () => {
  assert.equal(readWhen("2026-11-26T09:14:00Z", NOW, "UTC"), "today at 09:14");
  assert.equal(readWhen("2026-11-25T21:03:00Z", NOW, "UTC"), "yesterday at 21:03");
  assert.equal(readWhen("2026-11-24T09:14:00Z", NOW, "UTC"), "24 Nov at 09:14");
  assert.equal(lastReadWords("2026-11-26T09:14:00Z", NOW, "UTC"), "Last read today at 09:14.");
  assert.equal(lastReadWords(null, NOW, "UTC"), null);
});

test("a check says it's up to date, what's new, or why it failed", () => {
  const before = new Set(["a"]);
  const at = "2026-11-26T09:14:00Z";
  assert.equal(checkWords({ checked: "recent", error: null, fetched_at: at, items: [{ id: "a" }] }, before, NOW, "UTC"), "Up to date as of today at 09:14.");
  assert.equal(checkWords({ checked: "read", error: null, fetched_at: NOW.toISOString(), items: [{ id: "a" }, { id: "b" }] }, before, NOW, "UTC"), "Read just now. 1 new item.");
  assert.equal(checkWords({ checked: "read", error: null, fetched_at: NOW.toISOString(), items: [{ id: "a" }, { id: "b" }, { id: "c" }] }, before, NOW, "UTC"), "Read just now. 2 new items.");
  assert.equal(checkWords({ checked: "read", error: null, fetched_at: NOW.toISOString(), items: [{ id: "a" }] }, before, NOW, "UTC"), "Read just now. Nothing new.");
  assert.equal(checkWords({ checked: "read", error: "Athena couldn't reach the Community catalogue.", fetched_at: at, items: [{ id: "a" }] }, before, NOW, "UTC"), "Athena couldn't reach the Community catalogue. Showing the list from today at 09:14.");
  assert.equal(checkWords({ checked: "read", error: "Athena couldn't reach the Community catalogue.", fetched_at: null, items: [] }, before, NOW, "UTC"), "Athena couldn't reach the Community catalogue.");
});

test("an empty kind says when the list was read, not \"Try another kind\"", () => {
  assert.deepEqual(emptyKindWords("theme", "2026-11-26T09:14:00Z", NOW, "UTC"), { title: "No themes yet", sub: "Last read today at 09:14." });
  assert.deepEqual(emptyKindWords("checkin", null, NOW, "UTC"), { title: "No check-ins yet", sub: "" });
});
