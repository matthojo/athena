// Run: npx tsx --test app/src/lib/library-layout.test.ts
// The Library's grouping: every section lives in exactly one small group, and
// a phone's segmented row only ever offers the sections of the group you're in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIBRARY_LAYOUT, groupOf, segmentItems, withKinds, type LibraryItem } from "./library-layout";

const ALL_SECTIONS = ["notes", "saved", "reading", "music", "recipes", "people", "places", "organisations", "events", "trips", "house", "money", "purchases", "admin", "health", "habits", "goals", "work", "community", "graph", "archived", "settings"];

test("every section appears exactly once", () => {
  const views = LIBRARY_LAYOUT.flatMap((g) => g.items.map((i) => i.view));
  assert.deepEqual([...views].sort(), [...ALL_SECTIONS].sort());
  assert.equal(new Set(views).size, views.length);
});

test("groups are small enough for one segmented row on a phone", () => {
  for (const g of LIBRARY_LAYOUT) assert.ok(g.items.length <= 5, `${g.id} has ${g.items.length}`);
});

test("House leads Home and money", () => {
  assert.deepEqual(
    LIBRARY_LAYOUT.find((g) => g.id === "home")?.items.map((i) => i.view),
    ["house", "money", "purchases", "admin"]
  );
});

test("the groups, in order", () => {
  assert.deepEqual(
    LIBRARY_LAYOUT.map((g) => g.id),
    ["notes", "people", "home", "you", "kinds", "more"]
  );
  assert.equal(groupOf(LIBRARY_LAYOUT, "trips")?.id, "people");
  assert.equal(groupOf(LIBRARY_LAYOUT, "reading")?.id, "notes");
  assert.equal(groupOf(LIBRARY_LAYOUT, "admin")?.id, "home");
  assert.equal(groupOf(LIBRARY_LAYOUT, "house")?.id, "home");
  assert.equal(groupOf(LIBRARY_LAYOUT, "goals")?.id, "you");
});

test("no two sections share an icon", () => {
  const icons = LIBRARY_LAYOUT.flatMap((g) => g.items.map((i) => i.icon));
  assert.equal(new Set(icons).size, icons.length);
});

test("segments: the section's own group, never More, never a group of one", () => {
  assert.deepEqual(
    segmentItems(LIBRARY_LAYOUT, "purchases").map((i) => i.view),
    ["house", "money", "purchases", "admin"]
  );
  assert.deepEqual(segmentItems(LIBRARY_LAYOUT, "graph"), []);
  assert.deepEqual(segmentItems(LIBRARY_LAYOUT, "community"), []);
  assert.equal(groupOf(LIBRARY_LAYOUT, "community")?.id, "more");
  assert.deepEqual(segmentItems(LIBRARY_LAYOUT, "home"), []);
  assert.deepEqual(segmentItems(LIBRARY_LAYOUT, "days"), []);
  const one: LibraryItem[] = [{ view: "kind:wine", label: "Wines", icon: "wine" }];
  assert.deepEqual(segmentItems(withKinds("Your types", one), "kind:wine"), []);
});

test("the owner's kinds fill their own group without touching the layout", () => {
  const kinds: LibraryItem[] = [
    { view: "kind:wine", label: "Wines", icon: "wine" },
    { view: "kind:plant", label: "Plants", icon: "leaf" },
  ];
  const groups = withKinds("Your types", kinds);
  const g = groups.find((x) => x.id === "kinds");
  assert.equal(g?.label, "Your types");
  assert.deepEqual(segmentItems(groups, "kind:plant").map((i) => i.label), ["Wines", "Plants"]);
  assert.equal(LIBRARY_LAYOUT.find((x) => x.id === "kinds")?.items.length, 0);
});

test("every Library section still opens at its own address", async () => {
  const { parseRoute, routeHash } = await import("./routes");
  for (const g of LIBRARY_LAYOUT) {
    for (const i of g.items) {
      const hash = routeHash({ view: i.view, source: null, noteId: null });
      assert.equal(parseRoute(hash, "2026-11-10").view, i.view, `${i.view} via ${hash}`);
    }
  }
});

test("Music sits after Watch & read in Notes and collections, with its own icon", () => {
  assert.deepEqual(
    LIBRARY_LAYOUT.find((g) => g.id === "notes")?.items.map((i) => i.view),
    ["notes", "saved", "reading", "music", "recipes"]
  );
  const music = LIBRARY_LAYOUT.flatMap((g) => g.items).find((i) => i.view === "music");
  assert.equal(music?.icon, "music");
  assert.equal(LIBRARY_LAYOUT.flatMap((g) => g.items).filter((i) => i.icon === "music").length, 1);
});
