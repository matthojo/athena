// Sharing a flow in words (flows/share-words.ts): each reach tier, where a finding is, which steps a question fills,
// and the lines over what can't go yet and what's flagged.
// Run: npx tsx --test app/src/flows/share-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksHint, blockedLede, flowFindingsLede, flowWhereWords, reachWords, usedByWords } from "./share-words";

const names: Record<string, string> = { s1: "Add a to-do", s2: "Draft an email", s3: "Tell me" };
const name = (id: string) => names[id] ?? "a step";

test("each tier in a line, with what puts it there", () => {
  assert.deepEqual(reachWords({ tier: 1, model: false, lookups: [], web: false }), { title: "Nothing leaves your site", detail: "Every step stays inside Athena: it finds, adds, checks, asks and tells you.", icon: "shield" });
  const looks = reachWords({ tier: 2, model: false, lookups: ["weather", "train_status"], web: false });
  assert.equal(looks.title, "Uses a model or a lookup");
  assert.equal(looks.detail, "It looks up the weather forecast from Open-Meteo and live train times from National Rail.");
  assert.equal(reachWords({ tier: 2, model: true, lookups: [], web: false }).detail, "Some of its steps use a model.");
  const web = reachWords({ tier: 3, model: true, lookups: [], web: true });
  assert.equal(web.title, "Can search the web");
  assert.match(web.detail, /^Some of its steps use a model\. It asks to search the web\./);
  assert.equal(web.icon, "globe");
});

test("where a finding is: fields, then steps by name", () => {
  assert.equal(flowWhereWords(["name"], name), "In the name");
  assert.equal(flowWhereWords(["step:s1"], name), "In the step “Add a to-do”");
  assert.equal(flowWhereWords(["step:s1", "name"], name), "In the step “Add a to-do” and the name");
  assert.equal(flowWhereWords(["step:s1", "step:s2", "asks"], name), "In the steps “Add a to-do” and “Draft an email”, and the questions");
});

test("which steps a question fills, each once", () => {
  assert.equal(usedByWords(["s1"], name), "Used by Add a to-do");
  assert.equal(usedByWords(["s1", "s2", "s3"], name), "Used by Add a to-do, Draft an email and Tell me");
});

test("the ledes count", () => {
  assert.match(blockedLede(1), /^This step can't go/);
  assert.match(blockedLede(3), /^These 3 steps can't go/);
  assert.match(asksHint(0), /^None\./);
  assert.match(asksHint(2), /picks one of theirs/);
  assert.match(flowFindingsLede(0), /^Nothing is flagged/);
  assert.match(flowFindingsLede(1), /mark it fine/);
  assert.match(flowFindingsLede(4), /mark each one fine/);
});
