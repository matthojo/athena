// Community reach (lib/reach.ts): what an item can reach, worked out from its files. Tier 1 stays inside Athena,
// tier 2 uses a model or an outside lookup, tier 3 asks for the web. Made-up items only. Nothing needs a database.
// Run: npx tsx --test lib/reach.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLookupTool, LOOKUP_TOOLS, reachOf, reachOfAssistant, reachOfFlow, reachOfSkill, tierOf } from "./reach";
import { FLOW_SHARE_TOOLS, readSharedFlow } from "./flow-share";
import { ShareFormatError } from "./team-share";

const flowFile = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ format: 1, name: "Test flow", trigger: { kind: "manual" }, steps, ...extra });
const flowReach = (steps: unknown[], extra: Record<string, unknown> = {}) => reachOfFlow(readSharedFlow(flowFile(steps, extra)));
const tool = (id: string, name: string, input: Record<string, unknown> = {}) => ({ id, kind: "tool", tool: name, input, gives: [] });

test("tierOf: web beats a model or a lookup, which beat nothing", () => {
  assert.equal(tierOf({ model: false, web: false, lookups: [] }), 1);
  assert.equal(tierOf({ model: true, web: false, lookups: [] }), 2);
  assert.equal(tierOf({ model: false, web: false, lookups: ["weather"] }), 2);
  assert.equal(tierOf({ model: false, web: true, lookups: [] }), 3);
  assert.equal(tierOf({ model: true, web: true, lookups: ["weather"] }), 3);
});

test("every outside lookup is a tool a flow can use", () => {
  for (const name of Object.keys(LOOKUP_TOOLS)) assert.ok(FLOW_SHARE_TOOLS.includes(name), name);
  assert.ok(isLookupTool("train_status"));
  assert.ok(!isLookupTool("find_notes"));
  assert.ok(!isLookupTool("toString"));
});

test("tier 1: a flow that only finds, adds, checks, asks, waits and tells", () => {
  const r = flowReach([
    tool("s1", "find_todos", { query: ["passport"] }),
    tool("s2", "add_reminder", { text: ["Renew the passport"] }),
    { id: "s3", kind: "check", condition: { left: { from: "trigger", key: "title" }, op: "exists" }, yes: [{ id: "s4", kind: "notify", text: ["Done"] }], no: [] },
    { id: "s5", kind: "ask", question: ["Again next year?"], choices: [{ label: "Yes", steps: [] }, { label: "No", steps: [] }] },
    { id: "s6", kind: "wait", days: 2, at: "09:00" },
  ]);
  assert.deepEqual(r, { tier: 1, model: false, web: false, lookups: [], needs: [] });
});

test("tier 2: a flow that thinks, drafts or starts an assignment uses a model", () => {
  assert.equal(flowReach([{ id: "s1", kind: "think", task: ["Sum it up"], web: false, gives: [] }]).model, true);
  assert.equal(flowReach([tool("s1", "draft_message", { about: ["The delivery"] })]).model, true);
  assert.equal(flowReach([{ id: "s1", kind: "assignment", brief: ["Plan the trip"] }]).tier, 2);
});

test("tier 2: outside lookups, each named once, in the order the steps use them", () => {
  const r = flowReach([
    tool("s1", "flight_status", { flight: ["EX123"] }),
    { id: "s2", kind: "check", condition: { left: { from: "trigger", key: "title" }, op: "exists" }, yes: [tool("s3", "weather", { place: ["Exampleton"] })], no: [tool("s4", "flight_status")] },
  ]);
  assert.deepEqual(r, { tier: 2, model: false, web: false, lookups: ["flight_status", "weather"], needs: [] });
});

test("tier 3: a flow that asks for the web, in the file or a thinking step", () => {
  assert.equal(flowReach([{ id: "s1", kind: "notify", text: ["Hi"] }], { web: true }).tier, 3);
  assert.deepEqual(flowReach([{ id: "s1", kind: "think", task: ["Find deals"], web: true, gives: [] }]), { tier: 3, model: true, web: true, lookups: [], needs: [] });
});

test("needs come from the file: the event trigger's account first", () => {
  const r = flowReach([{ id: "s1", kind: "notify", text: ["A new issue"] }], { trigger: { kind: "event", event: { source: "collected", connector: "linear" } }, needs: ["gmail", "linear"] });
  assert.deepEqual(r.needs, ["linear", "gmail"]);
  assert.equal(r.tier, 1);
});

test("assistants and skills always use a model; an assistant can ask for the web", () => {
  assert.deepEqual(reachOfAssistant({ web: false, needs: ["linear"] }), { tier: 2, model: true, web: false, lookups: [], needs: ["linear"] });
  assert.equal(reachOfAssistant({ web: true, needs: [] }).tier, 3);
  assert.deepEqual(reachOfSkill(), { tier: 2, model: true, web: false, lookups: [], needs: [] });
});

test("reachOf reads the files, not what anyone says about them", () => {
  const flow = { path: "flow.json", text: JSON.stringify(flowFile([tool("s1", "train_status", {})], { reach: { tier: 1 } })) };
  assert.deepEqual(reachOf({ files: [flow] }), { tier: 2, model: false, web: false, lookups: ["train_status"], needs: [] });
  assert.equal(reachOf({ kind: "flow", files: [flow] }).tier, 2);

  const assistant = { path: "gift-watcher/assistant.json", text: JSON.stringify({ format: 1, name: "Pip", job: "Watches gift prices", web: true, needs: ["gmail"] }) };
  const skill = { path: "gift-watcher/SKILL.md", text: "---\nname: gift-watcher\ndescription: Prices.\n---\nWatch prices.\n" };
  assert.deepEqual(reachOf({ files: [assistant, skill] }), { tier: 3, model: true, web: true, lookups: [], needs: ["gmail"] });
  assert.equal(reachOf({ files: [skill] }).tier, 2);
});

test("reachOf refuses what it can't read, and a kind that doesn't match the files", () => {
  const isShareError = (re: RegExp) => (e: unknown) => e instanceof ShareFormatError && re.test(e.message);
  assert.throws(() => reachOf({ files: [{ path: "README.md", text: "Hello" }] }), isShareError(/no assistant.json, SKILL.md, flow.json, checkin.json, template.json or theme.json/));
  assert.throws(() => reachOf({ files: [{ path: "flow.json", text: "{not json" }] }), isShareError(/isn't valid JSON/));
  assert.throws(() => reachOf({ kind: "skill", files: [{ path: "flow.json", text: "{}" }] }), isShareError(/listed as a skill, but its files are a flow/));
  assert.throws(() => reachOf({ files: [{ path: "flow.json", text: JSON.stringify(flowFile([tool("s1", "send_note")])) }] }), isShareError(/can't use “send_note”/));
});
