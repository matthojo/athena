// Run: npx tsx --test netlify/lib/mcp/metric-names.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { metricNameProblem, sensitiveMetric } from "./metric-names";

test("health and money figures are refused by name, with the tool to use instead", () => {
  for (const name of ["weight_kg", "bodyweight", "resting_hr", "heartRate", "blood-pressure", "bp_systolic", "sleep_minutes", "glucose", "calories_in", "daily_steps"]) {
    assert.equal(sensitiveMetric(name), "health", name);
  }
  for (const name of ["monthly_spend", "bank_balance", "salary", "net_worth", "savings_rate", "rent_gbp", "coffee_cost", "income"]) {
    assert.equal(sensitiveMetric(name), "money", name);
  }
  assert.match(metricNameProblem("weight_kg")!, /log_health/);
  assert.match(metricNameProblem("monthly_spend")!, /log_spending/);
});

test("ordinary metrics go through, including ones that only contain a short word's letters", () => {
  for (const name of ["focus_minutes", "prs_reviewed", "meeting_hours", "subproject_count", "issues_closed", "pages_read", "deep_work_blocks", "backpressure_events"]) {
    assert.equal(sensitiveMetric(name), null, name);
    assert.equal(metricNameProblem(name), null, name);
  }
});
