// Run: npx tsx --test lib/overcast-opml.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dayIn, parseOvercast } from "./overcast-opml";
import { ImportFileError } from "./loop-csv";
import { overcastEntries } from "./day-imports";

const opml = readFileSync(join(import.meta.dirname, "fixtures/backfill/overcast.opml"), "utf8");

test("played and part-played episodes, on the owner's day, under their show", () => {
  const p = parseOvercast(opml, { tz: "Europe/London", today: "2026-11-07" });
  assert.equal(p.episodes, 3);
  assert.deepEqual(p.shows, ["Desert Island Discs", "The Rest Is History"]);
  assert.deepEqual(p.days.map((d) => [d.day, d.episodes.map((e) => e.title)]), [
    ["2026-11-02", ["The Fall of Rome & After"]],
    ["2026-11-03", ["Napoleon, part 2", "A guest - with a dot"]],
  ]);
  const part = p.days[1].episodes[0];
  assert.deepEqual(part, { show: "The Rest Is History", title: "Napoleon, part 2", id: "9002", url: "https://overcast.fm/+AAAA2", minutes: 25, partial: true });
  assert.equal(p.minutes, 25);
});

test("the day follows the owner's zone", () => {
  assert.equal(dayIn("2026-11-02T23:30:00+00:00", "Asia/Tokyo"), "2026-11-03");
  assert.equal(dayIn("2026-11-02T23:30:00+00:00", "America/New_York"), "2026-11-02");
  assert.equal(dayIn("2026-11-02T23:30:00-05:00"), "2026-11-02");
  assert.equal(dayIn("nope", "Europe/London"), null);
  const tokyo = parseOvercast(opml, { tz: "Asia/Tokyo" });
  assert.equal(tokyo.days[0].day, "2026-11-03");
});

test("a subscriptions-only OPML says there's nothing; other XML is refused", () => {
  assert.throws(() => parseOvercast('<opml><body><outline type="rss" title="A" xmlUrl="https://x"/></body></opml>'), (e: unknown) => e instanceof ImportFileError && e.reason === "empty");
  assert.throws(() => parseOvercast("<rss><channel/></rss>"), (e: unknown) => e instanceof ImportFileError && e.reason === "unreadable");
});

test("entries: listened, source overcast, grouped by show, stable ids", () => {
  const p = parseOvercast(opml, { tz: "Europe/London" });
  const e = overcastEntries(p.days[1]);
  assert.deepEqual(e[0], { kind: "listened", source: "overcast", external_id: "ep:9002", title: "Napoleon, part 2", subtitle: "The Rest Is History", group: "The Rest Is History", url: "https://overcast.fm/+AAAA2", minutes: 25, note: "part played" });
  assert.equal(e[1].external_id, "ep:9101");
});
