import { test } from "node:test";
import assert from "node:assert/strict";
import { folderCounts, hasTag, tagTree } from "./note-tree";
import type { NoteFolder } from "../../../lib/note-folder-rules";

const at = "2026-01-01T00:00:00.000Z";
const f = (id: string, parent_id: string | null = null): NoteFolder => ({ id, name: id, parent_id, created_at: at, updated_at: at });
const n = (folder_id: string | null, tags: string[] = []) => ({ folder_id, tags });

test("a folder counts its own notes, and those in every folder inside it", () => {
  const folders = [f("work"), f("clients", "work"), f("acme", "clients"), f("reading")];
  const counts = folderCounts(folders, [n("work"), n("work"), n("clients"), n("acme"), n("acme"), n(null)]);
  assert.deepEqual(counts.get("work"), { own: 2, total: 5 });
  assert.deepEqual(counts.get("clients"), { own: 1, total: 3 });
  assert.deepEqual(counts.get("acme"), { own: 2, total: 2 });
  assert.deepEqual(counts.get("reading"), { own: 0, total: 0 });
});

test("tags nest on /, sort by name, and a note counts once however many of its tags sit under one", () => {
  const tree = tagTree([n(null, ["ai/openai", "ai/anthropic"]), n(null, ["AI/openai"]), n(null, ["photo/50mm"]), n(null, ["meetings"])]);
  assert.deepEqual(
    tree.map((t) => `${t.path}:${t.count}`),
    ["ai:2", "meetings:1", "photo:1"]
  );
  assert.deepEqual(
    tree[0].children.map((t) => `${t.name}:${t.count}`),
    ["anthropic:1", "openai:2"]
  );
});

test("a tag matches itself and the tags under it, ignoring case", () => {
  const note = n(null, ["AI/OpenAI"]);
  assert.ok(hasTag(note, "ai"));
  assert.ok(hasTag(note, "ai/openai"));
  assert.ok(!hasTag(note, "ai/anthropic"));
  assert.ok(!hasTag(n(null, ["airline"]), "ai"), "a tag that only starts the same isn't under it");
});
