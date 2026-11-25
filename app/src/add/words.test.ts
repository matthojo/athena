// The Add screen's words (app/src/add/words.ts): where an item came from, what it can reach, what happens once it's
// added. Made-up items only. Run: npx tsx --test app/src/add/words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { addedWords, basedOnWords, changesSomething, FLOW_CHANGE_TOOLS, goWords, makerWords, originWords, reachWords, toolStepFields } from "./words";
import { FLOW_SHARE_TOOLS, type SharedFlowStep } from "../../../lib/flow-share";

test("where it came from: only a catalogue item is from Community", () => {
  assert.deepEqual(originWords({ from: { catalogue: "0123456789abcdef" }, listing: { id: "0123456789abcdef", version: null, featured: true, added_at: "", author: null } }), { community: true, title: "From Community", detail: "Reviewed and featured in the catalogue" });
  assert.deepEqual(originWords({ from: { link: "https://github.com/sample-author/athena-items/tree/main/tidy" }, listing: null }), { community: false, title: "Not from Community", detail: "From github.com/sample-author/athena-items" });
  assert.equal(originWords({ from: { files: "tidy.zip" }, listing: null }).detail, "From tidy.zip");
  assert.equal(originWords({ from: { files: "" }, listing: null }).detail, "From a file");
});

test("a Community item says how often it was downloaded, rounded, and nothing when the index doesn't count", () => {
  const listing = { id: "0123456789abcdef", version: null, featured: false, added_at: "", author: null };
  const from = { catalogue: "0123456789abcdef" };
  assert.equal(originWords({ from, listing: { ...listing, downloads: 1_234 } }).detail, "Reviewed for the catalogue · 1k+ downloads");
  assert.equal(originWords({ from, listing: { ...listing, downloads: 150 } }).detail, "Reviewed for the catalogue · 100+ downloads");
  assert.equal(originWords({ from, listing }).detail, "Reviewed for the catalogue");
  assert.equal(originWords({ from, listing: { ...listing, downloads: 0 } }).detail, "Reviewed for the catalogue");
});

test("what it was based on: a GitHub folder by its address, a Community listing by name", () => {
  assert.equal(basedOnWords({ based_on: "https://github.com/sample-author/athena-items/tree/main/flows/bins" }), "Based on github.com/sample-author/athena-items/tree/main/flows/bins");
  assert.equal(basedOnWords({ based_on: "https://athena-community.netlify.app/items/k3m9p2q7r4s8t1v6/" }), "Based on a Community listing");
  assert.equal(basedOnWords({}), "");
});

test("a tool step's fields in its sheet's order: the first is its body, the rest named", () => {
  const fields = [
    { key: "text", label: "What it says" },
    { key: "date", label: "Day" },
    { key: "time", label: "Time" },
    { key: "repeat", label: "Repeat" },
  ];
  // As the file has them: out of order, one empty, one the catalogue doesn't know.
  const input = { time: ["20:00"], text: ["Bins out tonight: ", { blank: "bins" }], repeat: [], date: [{ from: "trigger", key: "date" }], lead_time: ["1"] };
  assert.deepEqual(toolStepFields(input, fields), {
    first: "text",
    rest: [
      { key: "date", label: "Day" },
      { key: "time", label: "Time" },
      { key: "lead_time", label: "Lead time" },
    ],
  });
  assert.deepEqual(toolStepFields({}, fields), { first: null, rest: [] });
  assert.deepEqual(toolStepFields({ query: ["gift ideas"] }), { first: "query", rest: [] });
});

test("who made it, as the file says", () => {
  assert.equal(makerWords({ author: "sample-author", version: "1.2.0" }), "By @sample-author · version 1.2.0");
  assert.equal(makerWords({ version: "1.2.0" }), "Version 1.2.0");
  assert.equal(makerWords({}), "");
});

test("reach in plain words, for each tier, named as Community names it", () => {
  assert.equal(reachWords({ tier: 1, model: false, web: false, lookups: [], needs: [] }, "flow").title, "Stays in Athena");
  const lookup = reachWords({ tier: 2, model: false, web: false, lookups: ["weather", "train_status"], needs: [] }, "flow");
  assert.equal(lookup.title, "Checks the weather forecast and live train times");
  assert.deepEqual(lookup.lines, ["The weather forecast, from Open-Meteo", "Live train times, from National Rail"]);
  assert.equal(reachWords({ tier: 2, model: true, web: false, lookups: [], needs: [] }, "skill").title, "Uses AI");
  assert.equal(reachWords({ tier: 2, model: true, web: false, lookups: ["weather"], needs: [] }, "flow").title, "Uses AI and the weather forecast");
  const web = reachWords({ tier: 3, model: true, web: true, lookups: [], needs: [] }, "assistant");
  assert.equal(web.title, "Searches the web");
  assert.equal(web.lines.length, 2);
});

test("a flow's change steps: only tools that change something, drafts always wait", () => {
  for (const t of FLOW_CHANGE_TOOLS) assert.ok(FLOW_SHARE_TOOLS.includes(t), t);
  assert.ok(FLOW_CHANGE_TOOLS.has("add_todo") && FLOW_CHANGE_TOOLS.has("draft_email"));
  assert.ok(!FLOW_CHANGE_TOOLS.has("weather") && !FLOW_CHANGE_TOOLS.has("find_notes"));
  const step = (tool: string, go: "ask" | "auto"): SharedFlowStep => ({ id: "s1", title: null, kind: "tool", tool, input: {}, go, gives: [] });
  assert.equal(changesSomething(step("weather", "auto")), false);
  assert.equal(changesSomething(step("add_todo", "auto")), true);
  assert.match(goWords(step("add_todo", "auto"))!, /asked to run on its own/);
  assert.equal(goWords(step("add_todo", "ask")), null);
  assert.match(goWords(step("draft_email", "ask"))!, /nothing is sent/);
});

test("once added: where it lives and that it's off", () => {
  assert.equal(addedWords("assistant", "Tidy").title, "Tidy joined your team, paused");
  assert.equal(addedWords("skill", "Packing list").title, "Packing list is in your skills, off");
  assert.equal(addedWords("flow", "Plant care").open, "Open the flow");
});

test("a template: it stays in Athena, joins under a free name, and an Update never goes over the owner's changes", async () => {
  const w = await import("./words");
  const r = { tier: 1 as const, model: false, web: false, lookups: [], needs: [] };
  assert.equal(reachWords(r, "template").title, "Stays in Athena");
  assert.match(reachWords(r, "template").lines[0], /your own records/);
  assert.match(w.templateGoesWords("Weekly review", "Weekly review")[0], /joins your templates as “Weekly review”/);
  // Nothing in the template picker marks an added one, so nothing here promises a mark.
  for (const line of [...w.templateGoesWords("Weekly review", "Weekly review"), w.landsWords("template")]) assert.doesNotMatch(line, /marked/);
  assert.match(w.templateGoesWords("Weekly review", "Weekly review (2)")[0], /already, so this one joins as “Weekly review \(2\)”. Yours stays as it is/);
  assert.deepEqual(w.templateAddedWords("Weekly review", { name: "Weekly review (2)", renamed: true }).title, "Weekly review (2) is in your templates");
  assert.match(w.templateAddedWords("Weekly review", { name: "Weekly review (2)", renamed: true }).body, /^You already had a template called “Weekly review”/);
  assert.equal(addedWords("template", "Gratitude page").open, "Open the template");
  const had = { id: "x", version: "1.0", href: "#/notes?template=x", newer: true };
  assert.match(w.haveWords("template", { ...had, changed: true }, "1.1").detail, /you've changed it since. Version 1.1 can go beside it, and yours stays as you left it/);
  assert.match(w.haveWords("template", had, "1.1").detail, /look it over, then update yours/);
  assert.match(w.updateLandsWords("template", true), /Yours stays as you left it/);
  assert.equal(w.updatedWords("template", "Gratitude page", true).title, "The new Gratitude page is beside yours");
  assert.equal(w.madePlainWords(false), null);
  assert.match(w.madePlainWords(true)!, /nothing in it loads by itself/);
  assert.equal(w.fieldLine(null), "Athena doesn't know this one, so it stays a blank for you");
});
