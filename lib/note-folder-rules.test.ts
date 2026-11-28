import { test } from "node:test";
import assert from "node:assert/strict";
import {
  childFolders,
  cleanFolderName,
  findFolder,
  folderPath,
  folderTree,
  moveFolderProblem,
  nameTaken,
  newFolderProblem,
  parentOnDelete,
  MAX_FOLDER_NAME,
  type NoteFolder,
} from "./note-folder-rules";

const at = "2026-01-01T00:00:00.000Z";
const f = (id: string, name: string, parent_id: string | null = null): NoteFolder => ({ id, name, parent_id, created_at: at, updated_at: at });

// Work › Clients › Acme, Work › Week 10, Work › Week 2, Recipes
const folders = [f("w", "Work"), f("c", "Clients", "w"), f("a", "Acme", "c"), f("w10", "Week 10", "w"), f("w2", "Week 2", "w"), f("r", "Recipes")];

test("names are tidied, and can't be empty, too long or hold a path mark", () => {
  assert.deepEqual(cleanFolderName("  Book   club \n"), { name: "Book club" });
  assert.ok("error" in cleanFolderName("   "));
  assert.ok("error" in cleanFolderName(42));
  assert.ok("error" in cleanFolderName("x".repeat(MAX_FOLDER_NAME + 1)));
  assert.ok("error" in cleanFolderName("Work/Clients"));
  assert.ok("error" in cleanFolderName("Work › Clients"));
});

test("folders sort by name with numbers in order", () => {
  assert.deepEqual(childFolders(folders, "w").map((x) => x.name), ["Clients", "Week 2", "Week 10"]);
  assert.deepEqual(childFolders(folders, null).map((x) => x.name), ["Recipes", "Work"]);
});

test("a path reads outermost first", () => {
  assert.equal(folderPath(folders, "a"), "Work › Clients › Acme");
  assert.equal(folderPath(folders, null), "");
  assert.equal(folderPath(folders, "gone"), "");
});

test("three deep at most, for a new folder and for a move", () => {
  assert.equal(newFolderProblem(folders, "c"), null, "inside Clients is the third level");
  assert.match(newFolderProblem(folders, "a") ?? "", /3 deep/);
  // Clients holds Acme: two levels. Inside Recipes makes three: fine. Inside Week 2 makes four: no.
  assert.equal(moveFolderProblem(folders, "c", "r"), null);
  assert.match(moveFolderProblem(folders, "c", "w2") ?? "", /3 deep/);
  assert.equal(moveFolderProblem(folders, "a", null), null, "to the top");
});

test("a folder can't go inside itself or what it holds", () => {
  assert.match(moveFolderProblem(folders, "w", "w") ?? "", /itself/);
  assert.match(moveFolderProblem(folders, "w", "a") ?? "", /its own/);
});

test("names are unique among siblings, ignoring case", () => {
  assert.equal(nameTaken(folders, "clients", "w")?.id, "c");
  assert.equal(nameTaken(folders, "Clients", null), null, "another place is fine");
  assert.equal(nameTaken(folders, "Clients", "w", "c"), null, "its own name");
});

test("a folder is found by its name, when only one has it, or by its path", () => {
  assert.equal(findFolder(folders, "recipes")?.id, "r");
  assert.equal(findFolder(folders, "Work/Clients")?.id, "c");
  assert.equal(findFolder(folders, "Work › Clients › Acme")?.id, "a");
  assert.equal(findFolder(folders, "Work > Week 2")?.id, "w2");
  assert.equal(findFolder(folders, "Clients/Acme"), null, "a path starts at the top");
  const twice = [...folders, f("c2", "Clients", "r")];
  assert.equal(findFolder(twice, "Clients"), null, "two folders called that: say which");
  assert.equal(findFolder(twice, "Recipes/Clients")?.id, "c2");
});

test("the tree lists each folder before what's inside it", () => {
  assert.deepEqual(
    folderTree(folders).map((x) => `${x.depth}:${x.folder.name}`),
    ["1:Recipes", "1:Work", "2:Clients", "3:Acme", "2:Week 2", "2:Week 10"]
  );
});

test("deleting a folder hands what it held to its own parent", () => {
  assert.equal(parentOnDelete(folders, "c"), "w");
  assert.equal(parentOnDelete(folders, "w"), null);
});
