import { test } from "node:test";
import assert from "node:assert/strict";
import * as server from "../../../lib/profile";
import * as app from "./profile-catalogue";
import type { Fact } from "../types";

test("the app's catalogue matches lib/profile.ts", () => {
  assert.deepEqual(app.PROFILE_STEPS, server.PROFILE_STEPS);
  assert.deepEqual(app.PROFILE_FIELDS, server.PROFILE_FIELDS);
  assert.equal(app.PROFILE_SETUP_VERSION, server.PROFILE_SETUP_VERSION);
  assert.deepEqual(app.EMPTY_SETUP, server.EMPTY_SETUP);
});

const fact = (key: string, value: string, extra: Partial<Fact> = {}): Fact => ({
  id: key,
  subject_kind: "me",
  subject_id: null,
  key,
  value,
  source: "manual",
  confidence: null,
  observed_at: "2026-11-01T10:00:00Z",
  superseded_at: null,
  archived_at: null,
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  ...extra,
});

test("groupProfile and applySetupChange agree with the server", () => {
  const facts = [fact("Name", "Sam"), fact("Coffee order", "Flat white"), fact("Tone", "Direct", { confidence: 0.8, source: "habits" }), fact("Name", "Old", { superseded_at: "2026-11-02T00:00:00Z" })];
  assert.deepEqual(app.groupProfile(facts), server.groupProfile(facts as never));
  const now = new Date("2026-11-08T09:00:00Z");
  for (const change of [{ step: "work" as const }, { start: true }, { skip: "routines" as const, step: "help" as const }, { complete: true }, { restart: true, step: "about" as const }]) {
    const was = { version: 1, step: "about" as const, completed_at: null, skipped: [], started_at: null };
    assert.deepEqual(app.applySetupChange(was, change, now), server.applySetupChange(was, change, now));
  }
});

test("setup is due until it's finished, and again after a new version", () => {
  assert.equal(app.setupDue(app.EMPTY_SETUP), true);
  assert.equal(app.setupDue({ ...app.EMPTY_SETUP, completed_at: "2026-11-08T09:00:00Z" }), false);
  assert.equal(app.setupDue({ ...app.EMPTY_SETUP, version: 0, completed_at: "2026-11-08T09:00:00Z" }), true);
});

test("people values keep links and plain names", () => {
  const id = "0b9c5c34-58a1-4b7e-9a5e-1f2a3b4c5d6e";
  const value = app.formatPeople([{ id, name: "Rowan [work]" }, { id: "", name: "Gran" }]);
  assert.equal(value, `[@Rowan \\[work\\]](athena://person/${id}), Gran`);
  assert.deepEqual(app.parsePeople(value), [
    { id, name: "Rowan [work]", linked: true },
    { id: "", name: "Gran", linked: false },
  ]);
  assert.equal(app.displayValue(value, "people"), "Rowan [work], Gran");
});

test("lists and goals split the way they're stored", () => {
  assert.deepEqual(app.splitList("Dune, The Wire,\nJazz"), ["Dune", "The Wire", "Jazz"]);
  assert.equal(app.joinList([" a ", "", "b"]), "a, b");
  assert.deepEqual(app.splitLines("- Run a 10k\n\nRead 20 books"), ["Run a 10k", "Read 20 books"]);
  assert.equal(app.displayValue("Run a 10k\nRead 20 books", "goals"), "Run a 10k · Read 20 books");
});
