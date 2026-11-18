// This week's moment (app/src/lib/week-moment.ts): the picker's choices, the "Kept" toast, and what's stored.
// Run: npx tsx --test app/src/lib/week-moment.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstWords, isoWeek, keptToast, momentChoices, sameMoment, toMoment } from "./week-moment";
import type { Day } from "../db/days-app";

const day = (date: string, over: Partial<Day> = {}): Day => ({ date, photos: [], places: [], entries: [], notes: [], events: [], counts: { entries: 0, by_kind: {}, minutes: {}, photos: 0, notes: 0, events: 0, heat: 0 }, ...over }) as Day;
const art = (id: string, w = 2, h = 3) => ({ id, w, h });

test("isoWeek: the week number the toast says", () => {
  assert.equal(isoWeek("2026-11-09"), 46);
  assert.equal(isoWeek("2026-11-02"), 45);
  assert.equal(isoWeek("2025-12-29"), 1);
  assert.equal(isoWeek("2026-12-28"), 53);
  assert.equal(isoWeek("2027-01-04"), 1);
});

test("choices: photos, then covers (most played first, one per show), then the days' lines", () => {
  const days = [
    day("2026-11-14", { line: "Barbican with Priya, then dinner", places: [{ name: "Home" }, { name: "The Barbican", minutes: 140 }, { name: "Dishoom", minutes: 60 }] as Day["places"], photos: [{ id: "p1", w: 4032, h: 3024, thumb: true, added_at: "" }] }),
    day("2026-11-10", {
      photos: [{ id: "p0", thumb: true, added_at: "" }],
      entries: [
        { id: "e1", kind: "watched", source: "trakt", title: "S2E1", group: "Severance", art: art("sev") },
        { id: "e2", kind: "watched", source: "trakt", title: "S2E2", group: "Severance", art: art("sev") },
        { id: "e3", kind: "listened", source: "spotify", title: "Blackstar", subtitle: "David Bowie", art: art("bs", 1, 1), count: 5 },
        { id: "e4", kind: "habit", source: "habits", title: "Walk" },
        { id: "e5", kind: "read", source: "goodreads", title: "No cover" },
      ] as Day["entries"],
    }),
    day("2026-11-16", { line: "Next week", photos: [{ id: "p9", thumb: true, added_at: "" }] }),
  ];
  const c = momentChoices(days, "2026-11-09", "2026-11-15");
  assert.deepEqual(
    c.map((x) => [x.kind, x.ref, x.date]),
    [
      ["photo", "p0", "2026-11-10"],
      ["photo", "p1", "2026-11-14"],
      ["entry", "e3", "2026-11-10"],
      ["entry", "e1", "2026-11-10"],
      ["line", "2026-11-14", "2026-11-14"],
    ]
  );
  assert.equal(c[1].label, "the Barbican one");
  assert.equal(c[1].title, "Photo from Saturday at Barbican");
  assert.equal(c[0].label, "the Tuesday one");
  assert.deepEqual(c[1].art, { id: "p1", w: 4032, h: 3024 });
  assert.equal(c[2].label, "the Blackstar one");
  assert.equal(c[4].label, "Saturday's line");
  assert.equal(c[4].text, "Barbican with Priya, then dinner");
  // Captions: the day, and what each one is.
  assert.deepEqual(c.map((x) => [x.day, x.what]), [["Tue", "Photo"], ["Sat", "Barbican"], ["Tue", "Blackstar"], ["Tue", "Severance"], ["Sat", "Barbican with Priya, then dinner"]]);
  assert.deepEqual(momentChoices([], "2026-11-09", "2026-11-15"), []);
});

test("the toast names the week and the moment", async () => {
  assert.equal(keptToast("2026-11-09", { label: "the Barbican one" }), "Kept. Week 46 is the Barbican one.");
  assert.equal(keptToast("2026-11-09", { label: "Saturday's line" }), "Kept. Week 46 is Saturday's line.");
  const { styleProblems } = await import("../../../lib/writing-style");
  for (const t of ["Kept. Week 46 is the Barbican one.", "Kept. Week 46 is Saturday's line.", "Pick this week's moment", "This week's moment", "Couldn't keep it. Try again when you're online."]) assert.deepEqual(styleProblems(t), [], t);
});

test("what's stored: where it points and the image's size, never the words", () => {
  const [photo, , line] = momentChoices([day("2026-11-14", { line: "Barbican with Priya", places: [{ name: "Barbican Centre" }] as Day["places"], photos: [{ id: "p1", w: 4, h: 3, thumb: true, added_at: "" }], entries: [{ id: "e3", kind: "listened", source: "spotify", title: "Blackstar", art: { id: "bs", w: 1, h: 1, tone: "#222" } }] as Day["entries"] })], "2026-11-09", "2026-11-15");
  assert.deepEqual(toMoment(photo), { kind: "photo", ref: "p1", date: "2026-11-14", art: { id: "p1", w: 4, h: 3 } });
  assert.deepEqual(toMoment(line), { kind: "line", ref: "2026-11-14", date: "2026-11-14" });
  assert.doesNotMatch(JSON.stringify([toMoment(photo), toMoment(line)]), /Priya|Barbican|Blackstar/);
  assert.ok(sameMoment(toMoment(photo), photo));
  assert.ok(!sameMoment(toMoment(photo), line));
  assert.ok(!sameMoment(null, line));
});

test("firstWords: a line's opening for a caption", () => {
  assert.equal(firstWords("A full Thursday: King's Cross, reading The Cartographer's Daughter"), "A full Thursday: King's Cross…");
  assert.equal(firstWords("Lunch with Priya"), "Lunch with Priya");
  assert.equal(firstWords("Yoga, an episode of The Glasshouse", 2), "Yoga, an…");
});
