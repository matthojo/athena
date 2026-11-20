// Run: npx tsx --test app/src/db/sample-flows.test.ts
// Sample mode's flows must follow the contract's rules, use only made-up data,
// and walk the way the run page expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_LIMITS, VALUE_KINDS } from "../../../lib/flow-types";
import { SAMPLE_FLOW_IDS, sampleCatalog, sampleFlows, sampleGives, sampleRunFrom, sampleSuggestions } from "./sample-flows";
import { brokenSteps, countSteps, depthOf, walk } from "../flows/tree";

test("every sample flow keeps within the limits and uses only values it can reach", () => {
  const s = sampleFlows();
  assert.deepEqual(
    s.flows.map((f) => f.name),
    ["Renewal guard", "Before you meet", "Delivery day", "Gift price watch", "Friday review"]
  );
  for (const f of s.flows) {
    assert.ok(countSteps(f.steps) <= FLOW_LIMITS.steps, f.name);
    assert.ok(depthOf(f.steps) <= FLOW_LIMITS.depth, f.name);
    assert.deepEqual([...brokenSteps(f)], [], f.name);
    const ids = new Set<string>();
    walk(f.steps, (st) => {
      assert.ok(!ids.has(st.id), `${f.name}: ${st.id} twice`);
      ids.add(st.id);
      if (st.kind === "think") assert.ok(f.assistant_id, `${f.name}: thinking needs an assistant`);
      if (st.kind === "ask") assert.ok(st.choices.length <= FLOW_LIMITS.choices);
    });
  }
});

test("every step kind shows up in sample mode", () => {
  const kinds = new Set<string>();
  for (const f of sampleFlows().flows) walk(f.steps, (st) => kinds.add(st.kind));
  assert.deepEqual([...kinds].sort(), ["ask", "assignment", "check", "notify", "think", "tool", "wait"]);
});

test("suggested flows use only what their trigger gives", () => {
  for (const sug of sampleSuggestions()) {
    const f = { trigger_gives: sampleGives(sug.flow.trigger), steps: sug.flow.steps };
    assert.deepEqual([...brokenSteps(f)], [], sug.title);
  }
});

test("the catalogue covers each group, with valid value kinds", () => {
  const cat = sampleCatalog();
  assert.deepEqual([...new Set(cat.map((e) => e.group))].sort(), ["add", "decide", "find", "team", "tell"]);
  for (const e of cat) {
    for (const v of [...e.gives, ...e.fields]) assert.ok((VALUE_KINDS as readonly string[]).includes(v.kind), `${e.label}: ${v.kind}`);
    if (e.kind === "tool") assert.ok(e.tool);
  }
  assert.ok(cat.find((e) => e.kind === "think")?.needsAssistant);
});

test("Renewal guard waits for Go today, and Go carries it on", () => {
  const s = sampleFlows();
  const renewal = s.flows.find((f) => f.id === SAMPLE_FLOW_IDS.renewal)!;
  const latest = s.runs.filter((r) => r.run.flow_id === renewal.id).sort((a, b) => b.run.started_at.localeCompare(a.run.started_at))[0];
  assert.equal(latest.run.status, "waiting");
  assert.equal(latest.run.waits_for, "go");
  assert.ok(latest.run.steps.find((x) => x.status === "waiting")?.pending?.text.includes("Northwind Broadband"));
  const after = sampleRunFrom(s, renewal, { id: latest.run.id, label: latest.run.label, at: Date.parse(latest.run.started_at), decisions: { decide: "go" }, dry: false });
  assert.equal(after.run.status, "done");
  assert.equal(after.run.steps.find((x) => x.step_id === "decide")?.status, "done");
  assert.equal(after.run.steps.find((x) => x.step_id === "remind")?.status, "skipped");
});

test("a try changes nothing and doesn't stop at a Go", () => {
  const s = sampleFlows();
  const renewal = s.flows.find((f) => f.id === SAMPLE_FLOW_IDS.renewal)!;
  const dry = sampleRunFrom(s, renewal, { label: "A try", at: Date.now(), decisions: {}, dry: true });
  assert.equal(dry.run.dry, true);
  assert.equal(dry.run.status, "done");
  assert.match(dry.run.steps.find((x) => x.step_id === "decide")!.line, /^Would add/);
});

test("Delivery day waits for the morning; an Ask me waits for an answer", () => {
  const s = sampleFlows();
  const d = s.flows.find((f) => f.id === SAMPLE_FLOW_IDS.delivery)!;
  const latest = s.runs.find((r) => r.run.flow_id === d.id)!;
  assert.equal(latest.run.waits_for, "time");
  assert.ok(latest.run.steps.find((x) => x.status === "waiting")?.resumes_at);
  const fresh = sampleRunFrom(s, d, { label: "Run now", at: Date.now(), decisions: {}, dry: false });
  assert.equal(fresh.run.waits_for, "answer");
  assert.deepEqual(fresh.run.steps[0].question?.choices, ["I'll be in", "I'm out"]);
});

test("sample data is made up", () => {
  const text = JSON.stringify([sampleFlows(), sampleSuggestions(), sampleCatalog()]);
  // Addresses in sample mode are example.com only, and no real shops or brands.
  for (const m of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) assert.match(m, /@example\.com$/);
  for (const real of ["Smyths", "Lego", "Amazon", "Argos", "Virgin", "BT ", "Sky "]) assert.ok(!text.includes(real), real);
});
