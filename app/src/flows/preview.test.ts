// Run: npx tsx --test app/src/flows/preview.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowRun } from "../../../lib/flow-types";
import { flatValues, nestValues, previewRun } from "./preview";

const run = (id: string, started_at: string, values?: FlowRun["values"]): FlowRun => ({ id, flow_id: "f1", status: "done", waits_for: null, label: `Run ${id}`, assistant_id: null, summary: null, steps: [], values, dry: false, error: null, started_at, finished_at: started_at });

test("values flatten to the keys chips use, and back", () => {
  const nested = { trigger: { company: "Northwind Broadband" }, s2: { last_price: "£32.00", empty: " " } };
  assert.deepEqual(flatValues(nested), { "trigger.company": "Northwind Broadband", "s2.last_price": "£32.00" });
  assert.deepEqual(nestValues({ "trigger.company": "Northwind Broadband", "s2.last_price": "£32.00" }), { trigger: { company: "Northwind Broadband" }, s2: { last_price: "£32.00" } });
  assert.deepEqual(flatValues(undefined), {});
});

test("the preview reads the newest run that kept values", () => {
  assert.equal(previewRun([]), null);
  // Runs from before values were kept: chip labels.
  assert.equal(previewRun([run("a", "2026-11-20T08:00:00Z")]), null);
  const p = previewRun([run("old", "2026-11-01T08:00:00Z", { trigger: { company: "Pageturn Books" } }), run("new", "2026-11-20T08:00:00Z", { trigger: { company: "Northwind Broadband" } }), run("bare", "2026-11-21T08:00:00Z")]);
  assert.equal(p?.run.id, "new");
  assert.deepEqual(p?.values, { "trigger.company": "Northwind Broadband" });
});
