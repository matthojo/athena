// Something to watch tonight (lib/watch-tonight.ts, the watch_tonight rule): picks only from the
// owner's own list, ranked against their taste, each with why; only on a clear evening.
// Run: npx tsx --test lib/watch-tonight.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eveningFree, listValues, phraseIn, rankTonight, type TasteSignals, type WatchCandidate } from "./watch-tonight";
import { watchTonight } from "./proactive/rules";
import type { ProactiveInput } from "./proactive/types";

const TZ = "Europe/London";
const c = (id: string, over: Partial<WatchCandidate> = {}): WatchCandidate => ({ id, title: id, kind: "film", maker: "", status: "queued", notes: "", recommended_by: null, source: "manual", added_at: "2026-10-01T00:00:00Z", ...over });
const taste: TasteSignals = {
  rated: [
    { title: "Arrival", by: "Denis Villeneuve", stars: 5, kind: "film" },
    { title: "Sicario", by: "Denis Villeneuve", stars: 4.5, kind: "film" },
    { title: "Cats", by: "Tom Hooper", stars: 1, kind: "film" },
  ],
  genres: ["slow-burn sci-fi"],
  likes: ["spy dramas"],
  dislikes: ["horror"],
};

test("only the owner's own items come back, at most three, best first, each with why", () => {
  const list = [
    c("Dune: Part Two", { maker: "Denis Villeneuve" }),
    c("Severance", { kind: "tv", status: "reading", progress: "Episode 14 of 19" }),
    c("Slow Horses", { kind: "tv", source: "trakt", notes: "Spy dramas, from the watchlist" }),
    c("Annihilation", { notes: "Slow-burn sci-fi" }),
    c("Hereditary", { notes: "Horror, everyone says" }),
    c("Some film"),
  ];
  const picks = rankTonight(list, taste, { now: new Date("2026-11-10T18:00:00Z") });
  assert.equal(picks.length, 3);
  const ids = new Set(list.map((x) => x.id));
  assert.ok(picks.every((p) => ids.has(p.id)), "nothing invented");
  assert.deepEqual(picks.map((p) => p.id), ["Severance", "Annihilation", "Dune: Part Two"]);
  assert.equal(picks[0].why, "You're part-way through: episode 14 of 19.");
  assert.equal(picks[1].why, "You rate slow-burn sci-fi highly.");
  const [spy] = rankTonight([list[2]], taste);
  assert.equal(spy.why, "You said you like spy dramas.");
  assert.equal(spy.from, "Trakt watchlist");
  assert.ok(!picks.some((p) => p.id === "Hereditary"), "a dislike is never picked");
});

test("the maker of something rated highly, and who recommended it", () => {
  const [dune] = rankTonight([c("Dune: Part Two", { maker: "Denis Villeneuve" })], taste);
  assert.equal(dune.why, "You gave Arrival 5 stars, and this is also Denis Villeneuve's.");
  const [rec] = rankTonight([c("Past Lives", { recommended_by: "Priya" })], taste);
  assert.equal(rec.why, "Priya recommended it.");
  const [plain] = rankTonight([c("Some film", { added_at: "2026-03-12T00:00:00Z" })], taste);
  assert.equal(plain.why, "On your list since 12 Mar.");
  assert.deepEqual(rankTonight([], taste), []);
});

test("phrases and list values", () => {
  assert.ok(phraseIn("slow-burn sci-fi", "A slow burn, very sci fi"));
  assert.ok(!phraseIn("slow-burn sci-fi", "A fast action film"));
  assert.deepEqual(listValues('["Horror films","coriander"]'), ["Horror films", "coriander"]);
  assert.deepEqual(listValues("Horror films, coriander"), ["Horror films", "coriander"]);
});

test("a free evening: nothing timed overlapping 19:00 to midnight", () => {
  const today = "2026-11-10";
  assert.equal(eveningFree([], today, TZ), true);
  assert.equal(eveningFree([{ starts_at: "2026-11-10T12:00:00Z", ends_at: "2026-11-10T13:00:00Z" }], today, TZ), true);
  assert.equal(eveningFree([{ starts_at: "2026-11-10T18:30:00Z", ends_at: "2026-11-10T19:30:00Z" }], today, TZ), false);
  assert.equal(eveningFree([{ starts_at: "2026-11-10T20:00:00Z", ends_at: null }], today, TZ), false);
  assert.equal(eveningFree([{ starts_at: "2026-11-11T20:00:00Z", ends_at: null }], today, TZ), true);
});

test("the nudge: only in its window, only when free, naming every pick's why", () => {
  const input = (now: string, free = true): ProactiveInput =>
    ({ now: new Date(now), tz: TZ, today: "2026-11-10", tonight: { free, picks: rankTonight([c("Annihilation", { notes: "slow-burn sci-fi" })], taste) } }) as unknown as ProactiveInput;
  const [n] = watchTonight(input("2026-11-10T17:30:00Z"));
  assert.equal(n.rule, "watch_tonight");
  assert.equal(n.key, "tonight:2026-11-10");
  assert.match(n.body, /Annihilation/);
  assert.ok(n.why.includes("Annihilation: You rate slow-burn sci-fi highly."));
  assert.deepEqual(watchTonight(input("2026-11-10T16:30:00Z")), []);
  assert.deepEqual(watchTonight(input("2026-11-10T20:30:00Z")), []);
  assert.deepEqual(watchTonight(input("2026-11-10T17:30:00Z", false)), []);
});
