// Run: npx tsx --test app/src/flows/activity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowRunHref, flowRunOf, flowSourceWords, isFlowActivity } from "./activity";
import { settingsRuleIds, RULES } from "../lib/nudge-rules";
import { RULE_IDS, type RuleId } from "../../../lib/proactive/types";

test("What Ask did names a plain flow's change and links to its run", () => {
  assert.equal(isFlowActivity({ source: "flow" }), true);
  assert.equal(isFlowActivity({ source: "team" }), false);
  assert.equal(flowSourceWords("Delivery day"), "Flow: Delivery day");
  assert.equal(flowSourceWords(""), "A flow");
  assert.equal(flowRunOf({ source: "flow", flow_run_id: "r1" }), "r1");
  assert.equal(flowRunOf({ source: "flow", run_id: "r2" }), "r2");
  assert.equal(flowRunOf({ source: "flow" }), null);
  assert.equal(flowRunHref("r 1"), "#/flows/runs/r%201");
});

test("Settings → Notifications lists Flows right after Team, once", () => {
  const ids = settingsRuleIds(RULE_IDS);
  assert.equal(ids[ids.indexOf("team") + 1], "flow");
  assert.equal(ids.filter((x) => x === "flow").length, 1);
  // Once the engine adds it to RULE_IDS, it still shows once, beside Team.
  const later = settingsRuleIds([...RULE_IDS, "flow" as RuleId]);
  assert.equal(later.filter((x) => x === "flow").length, 1);
  assert.equal(later[later.indexOf("team") + 1], "flow");
  assert.equal(RULES.flow.name, "Flows");
});
