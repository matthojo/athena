// Run: npx tsx --test app/src/flows/activity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowRunHref, flowRunOf, flowSourceWords, isFlowActivity } from "./activity";
import { RULES } from "../lib/nudge-rules";
import { RULE_IDS } from "../../../lib/proactive/types";

test("What Ask did names a plain flow's change and links to its run", () => {
  assert.equal(isFlowActivity({ source: "flow" }), true);
  assert.equal(isFlowActivity({ source: "team" }), false);
  assert.equal(flowSourceWords("Delivery day"), "Flow: Delivery day");
  assert.equal(flowSourceWords(""), "A flow");
  assert.equal(flowRunOf({ source: "flow", flow_run_id: "r1" }), "r1");
  assert.equal(flowRunOf({ source: "flow" }), null);
  assert.equal(flowRunHref("r 1"), "#/flows/runs/r%201");
});

test("Settings → Notifications lists Flows right after Team, once", () => {
  assert.equal(RULE_IDS[RULE_IDS.indexOf("team") + 1], "flow");
  assert.equal(RULE_IDS.filter((x) => x === "flow").length, 1);
  assert.equal(RULES.flow.name, "Flows");
});
