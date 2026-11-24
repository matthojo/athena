// Community's kinds (lib/share-kinds.ts): which file names an item, telling a folder's kind from its paths, and the
// header every shared file may carry. Made-up names only. Nothing needs a database.
// Run: npx tsx --test lib/share-kinds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectKind, isShareKind, KIND_FILES, kindOfFile, readHeader, SHARE_KINDS } from "./share-kinds";
import { ASSISTANT_FILE } from "./team-share";
import { FLOW_FILE } from "./flow-share";

test("each kind has its own file, matching the readers' names", () => {
  assert.deepEqual([...SHARE_KINDS], ["assistant", "skill", "flow"]);
  assert.equal(KIND_FILES.assistant, ASSISTANT_FILE);
  assert.equal(KIND_FILES.flow, FLOW_FILE);
  assert.equal(KIND_FILES.skill, "SKILL.md");
  assert.ok(isShareKind("flow"));
  assert.ok(!isShareKind("routine"));
  assert.ok(!isShareKind(undefined));
});

test("kindOfFile reads the file name at any depth, in any case", () => {
  assert.equal(kindOfFile("gift-watcher/assistant.json"), "assistant");
  assert.equal(kindOfFile("weekly-review/skill.md"), "skill");
  assert.equal(kindOfFile("FLOW.JSON"), "flow");
  assert.equal(kindOfFile("notes/flow.json.bak"), null);
  assert.equal(kindOfFile("README.md"), null);
});

test("detectKind: one identifying file decides", () => {
  assert.equal(detectKind(["flow.json"]), "flow");
  assert.equal(detectKind(["weekly-review/SKILL.md", "weekly-review/references/checklist.md"]), "skill");
  assert.equal(detectKind(["gift-watcher/assistant.json"]), "assistant");
  assert.equal(detectKind([]), null);
  assert.equal(detectKind(["README.md", "notes.txt"]), null);
});

test("detectKind: an assistant's own SKILL.md beside it doesn't make it a skill", () => {
  assert.equal(detectKind(["gift-watcher/assistant.json", "gift-watcher/SKILL.md", "gift-watcher/prices.csv"]), "assistant");
});

test("detectKind: the shallowest identifying file decides", () => {
  assert.equal(detectKind(["pack/flow.json", "pack/extras/helper/SKILL.md"]), "flow");
  assert.equal(detectKind(["pack/inner/assistant.json", "pack/SKILL.md"]), "skill");
});

test("detectKind: a flow beside a skill at the same level can't be told apart", () => {
  assert.equal(detectKind(["mixed/flow.json", "mixed/SKILL.md"]), null);
});

test("detectKind ignores hidden files and macOS's __MACOSX, and cleans backslashes", () => {
  assert.equal(detectKind(["__MACOSX/pack/._flow.json", "__MACOSX/flow.json", "pack/SKILL.md"]), "skill");
  assert.equal(detectKind([".hidden/flow.json"]), null);
  assert.equal(detectKind(["pack\\flow.json"]), "flow");
});

test("readHeader keeps a version, a GitHub username and a github.com link, and drops what doesn't fit", () => {
  assert.deepEqual(readHeader({ version: " 1.2.0 ", author: "@sam-example", based_on: "https://github.com/example/athena-items/tree/main/flows/renewals/" }), {
    version: "1.2.0",
    author: "sam-example",
    based_on: "https://github.com/example/athena-items/tree/main/flows/renewals",
  });
  assert.deepEqual(readHeader({ version: "one point two, the best one", author: "not a user!", based_on: "https://example.com/flows/renewals" }), {});
  assert.deepEqual(readHeader({ version: 3, author: null }), {});
});
