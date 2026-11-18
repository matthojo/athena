// The "changed elsewhere" reload paths the live channel calls for Days, habits and recipes.
// Run: npx tsx --test app/src/db/changed-elsewhere.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayMark, daysChanged, idleReload, nothingNew, onDaysChange, type Day } from "./days-app";
import { habitsChanged, onHabitsChange } from "./habits";
import { onRecipesChange, onRecipesElsewhere, recipesChanged } from "./recipes";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("daysChanged tells each listener the dates, until it is taken off", () => {
  const heard: string[][] = [];
  const off = onDaysChange((dates) => heard.push(dates));
  daysChanged(["2026-11-11"]);
  daysChanged();
  off();
  daysChanged(["2026-11-10"]);
  assert.deepEqual(heard, [["2026-11-11"], []]);
});

test("habitsChanged repaints every habits listener", () => {
  let n = 0;
  const off = onHabitsChange(() => n++);
  habitsChanged();
  off();
  habitsChanged();
  assert.equal(n, 1);
});

test("recipesChanged reloads the grid and tells the plan and the list which ids moved", () => {
  let grid = 0;
  const heard: string[][] = [];
  const offGrid = onRecipesChange(() => grid++);
  const off = onRecipesElsewhere((ids) => heard.push(ids));
  recipesChanged(["r1", "2026-11-11"]);
  recipesChanged();
  offGrid();
  off();
  recipesChanged(["r2"]);
  assert.equal(grid, 2);
  assert.deepEqual(heard, [["r1", "2026-11-11"], []]);
});

test("dayMark is the same for a day saved here and loaded again, and moves when anything on it changes", () => {
  const day = { date: "2026-11-11", updated_at: "2026-11-11T10:00:00.000Z", photos: [], entries: [{ id: "a", source: "trakt" }, { id: "p", source: "places" }] } as unknown as Day;
  const shown = { ...day, entries: day.entries.filter((e) => e.source !== "places") };
  assert.equal(dayMark(day), dayMark(shown));
  assert.notEqual(dayMark(day), dayMark({ ...day, updated_at: "2026-11-11T10:00:05.000Z" }));
  assert.notEqual(dayMark(day), dayMark({ ...day, entries: [] }));
  assert.notEqual(dayMark(day), dayMark({ ...day, photos: [{ id: "f" }] } as unknown as Day));
});

test("idleReload waits while the owner is busy, drops a load they interrupted, and applies once they stop", async () => {
  let busy = true;
  let loads = 0;
  const applied: number[] = [];
  const r = idleReload(() => busy, async () => ++loads, (v) => applied.push(v));

  await r.ask();
  assert.equal(loads, 0, "nothing is loaded under the caret");
  r.settle();
  await tick();
  assert.equal(loads, 0, "still busy: still waiting");

  busy = false;
  r.settle();
  await tick();
  assert.deepEqual(applied, [1]);
  r.settle();
  await tick();
  assert.equal(loads, 1, "nothing was waiting");

  // They start typing while the reload is in the air: it is not applied, and runs again later.
  let interrupt = true;
  const slow = idleReload(() => busy, async () => (await tick(), (busy = interrupt), (interrupt = false), 7), (v) => applied.push(v));
  await slow.ask();
  assert.deepEqual(applied, [1]);
  busy = false;
  slow.settle();
  await tick();
  await tick();
  assert.deepEqual(applied.slice(1), [7]);

  // A failed load changes nothing.
  const failing = idleReload(() => false, async () => Promise.reject(new Error("offline")), () => assert.fail("applied"));
  await failing.ask();
});

test("nothingNew is true for the day a view painted and false once it moved", () => {
  const day = { date: "2026-11-11", updated_at: "2026-11-11T10:00:00.000Z", photos: [], entries: [] } as unknown as Day;
  const painted = dayMark(day);
  assert.equal(nothingNew(day, painted), true);
  assert.equal(nothingNew({ ...day, updated_at: "2026-11-11T10:00:09.000Z" }, painted), false);
});
