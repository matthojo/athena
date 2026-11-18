// Run: npx tsx --test lib/connector-presets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, RECIPES, classifyTool, presetFor } from "./connector-presets";

test("every preset has a unique id, a known category and known recipes", () => {
  const ids = CONNECTOR_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  const cats = new Set(CONNECTOR_CATEGORIES.map((c) => c.id));
  const recipes = new Set(RECIPES.map((r) => r.id));
  for (const p of CONNECTOR_PRESETS) {
    assert.ok(cats.has(p.category), `${p.id}: unknown category ${p.category}`);
    for (const r of p.recipes) assert.ok(recipes.has(r), `${p.id}: unknown recipe ${r}`);
    assert.ok(p.label && p.tagline && p.help, `${p.id}: label, tagline and help are required`);
    if (p.id !== "custom" && !p.urlHint) assert.match(p.url, /^https:\/\//, `${p.id}: url must be https`);
    // A username field (address.text) shows a word, not an address.
    if (p.urlHint && !p.address?.text) assert.match(p.urlHint, /^https:\/\//, `${p.id}: urlHint must be https`);
  }
});

test("Other MCP server is last and is the fallback", () => {
  assert.equal(CONNECTOR_PRESETS[CONNECTOR_PRESETS.length - 1].id, "custom");
  assert.equal(presetFor("no-such-service").id, "custom");
});

test("no known-read tool is named like a write", () => {
  // One exception, owner's call (7 Nov): Zapier labels execute_zapier_read_action
  // a read, so its preset allowlists it although "execute" is a write verb.
  const allowed = new Set(["zapier:execute_zapier_read_action"]);
  for (const p of CONNECTOR_PRESETS)
    for (const t of p.readTools)
      if (!allowed.has(`${p.id}:${t}`)) assert.notEqual(classifyTool("custom", t), "write", `${p.id}: ${t} looks like a write`);
});

// ---------- Work presets (lib/presets/work.ts) ----------
import { WORK_PRESETS } from "./presets/work";
import { WORK_MARKS } from "../app/src/components/brand-marks/work";

test("work presets: right categories, a mark each, and a read-only default allowlist", () => {
  assert.ok(WORK_PRESETS.length >= 10, "at least ten work services");
  for (const p of WORK_PRESETS) {
    assert.ok(["projects", "engineering", "design"].includes(p.category), `${p.id}: category ${p.category}`);
    assert.ok(WORK_MARKS[p.id], `${p.id}: no mark in brand-marks/work.ts`);
    assert.ok(p.readTools.length > 0, `${p.id}: empty allowlist`);
    assert.ok(p.recipes.length > 0, `${p.id}: no recipes`);
    for (const t of p.readTools) assert.equal(classifyTool(p.id, t), "read", `${p.id}: ${t}`);
  }
  for (const id of Object.keys(WORK_MARKS)) assert.ok(WORK_PRESETS.some((p) => p.id === id), `mark ${id} has no preset`);
});

test("work presets: issue trackers and code hosts feed work activity", () => {
  for (const id of ["atlassian", "asana", "clickup", "monday", "trello", "gitlab"]) {
    assert.ok(presetFor(id).recipes.includes("work-activity"), `${id}: work-activity`);
  }
  // Often a personal list, so it doesn't feed work activity (owner, 7 Nov); its routines feed the Life log as habits.
  assert.deepEqual(presetFor("todoist").recipes, ["life-log", "plays-watches", "custom"]);
});

test("work presets: Asana uses your own client and says where the redirect URI goes", () => {
  const asana = presetFor("asana");
  assert.equal(asana.id, "asana");
  assert.equal(asana.needsOwnClient, true);
  assert.match(asana.help, /redirect URI above/);
});

test("work presets: requested scopes are read-only and marks fetch nothing", () => {
  for (const p of WORK_PRESETS) {
    for (const s of p.scope.split(/\s+/).filter(Boolean)) assert.doesNotMatch(s, /write|delete|manage|admin/, `${p.id}: scope ${s}`);
    assert.doesNotMatch(WORK_MARKS[p.id], /https?:|href=|<image|<script/i, `${p.id}: mark must be self-contained`);
  }
});

// ---- Business services (lib/presets/business.ts) ----
import { BUSINESS_PRESETS } from "./presets/business";
import { BUSINESS_MARKS } from "../app/src/components/brand-marks/business";
import { ICON_FALLBACK } from "../app/src/components/brand-logo";

test("business: ten or more services, each with a mark, category, tagline, help and recipes", () => {
  assert.ok(BUSINESS_PRESETS.length >= 10, `only ${BUSINESS_PRESETS.length} services`);
  const allowed = new Set(["meetings", "chat", "docs", "sales-support", "automation"]);
  for (const p of BUSINESS_PRESETS) {
    assert.ok(allowed.has(p.category), `${p.id}: category ${p.category} isn't a business one`);
    // No official vector to draw: its category icon instead (connectors audit, brand-logo.test.ts).
    if (!ICON_FALLBACK.includes(p.id)) {
      assert.match(BUSINESS_MARKS[p.id] ?? "", /^<svg viewBox="[^"]+" aria-hidden="true">.*<\/svg>$/s, `${p.id}: no mark`);
      assert.doesNotMatch(BUSINESS_MARKS[p.id], /https?:|href|<image|<script/i, `${p.id}: mark must not fetch anything`);
    }
    assert.ok(p.tagline.length <= 44 && !/\n/.test(p.tagline), `${p.id}: tagline should be one short line`);
    assert.ok(!/\n/.test(p.help), `${p.id}: help should be one paragraph`);
    assert.ok(p.recipes.includes("custom") && p.recipes.length >= 1, `${p.id}: recipes`);
    if (p.category === "meetings") assert.ok(p.recipes.includes("calendar-meetings"), `${p.id}: meeting tools feed Meetings`);
    if (p.category === "chat" || p.category === "sales-support") assert.ok(p.recipes.includes("work-activity"), `${p.id}: feeds Work activity`);
  }
  for (const id of Object.keys(BUSINESS_MARKS)) assert.ok(BUSINESS_PRESETS.some((p) => p.id === id), `mark ${id} has no preset`);
});

// No published tool names (owner, 7 Nov): listed with nothing allowed by default.
const EMPTY_ALLOWLIST = ["otter", "fathom", "readai", "missive", "helpscout"];

test("business: every known-read tool classifies as read, and the allowlist is never empty", () => {
  for (const p of BUSINESS_PRESETS) {
    if (!EMPTY_ALLOWLIST.includes(p.id)) assert.ok(p.readTools.length > 0, `${p.id}: no read tools`);
    assert.equal(new Set(p.readTools).size, p.readTools.length, `${p.id}: duplicate read tools`);
    for (const t of p.readTools) assert.equal(classifyTool(p.id, t), "read", `${p.id}: ${t}`);
  }
});

test("business: known writes are never in the allowlist and never allowed by default", () => {
  const writes: Record<string, string[]> = {
    fireflies: ["fireflies_share_meeting", "fireflies_update_meeting_title", "fireflies_create_soundbite"],
    fellow: ["write_agenda", "edit_agenda", "delete_agenda_template"],
    krisp: ["update_meeting", "create_action_item", "import_recording", "get_import_status"],
    calendly: ["meetings-cancel_event", "event_types-create_event_type"],
    box: ["upload_file", "create_collaboration", "get_upload_url"],
    airtable: ["create_records_for_table", "delete_table", "get_create_automation_instructions"],
    coda: ["page_update", "table_rows_manage", "comment_add"],
    hubspot: ["manage_crm_objects", "submit_feedback"],
    attio: ["create-note", "update-record", "merge-records", "run-basic-report"],
    close: ["create_lead", "update_lead", "delete_lead", "merge_leads"],
    intercom: ["create_article", "add_internal_note", "apply_proposals"],
    front: ["send_message", "create_draft", "assign_conversation", "tag_conversation", "add_comment"],
    gorgias: ["create_ticket", "reply_and_close", "update_tickets", "apply_macro"],
    make: ["scenario_run", "scenario_patch", "scenario_delete", "connection_create", "scenario_activate", "scenario_deactivate"],
    activepieces: ["ap_run_action", "ap_delete_flow", "ap_update_step", "ap_test_flow", "ap_get_run"],
    // CamelCase, "manage" and "activate" names slip past the write-verb pattern; unannotated, they still stay off.
    dropbox: ["CreateFolder", "CreateSharedLink", "Delete", "Move"],
    circleback: ["UpdateMeeting", "ShareMeeting", "DeleteTag", "CreateActionItem"],
    zapier: ["execute_zapier_write_action", "list_enabled_zapier_actions", "add_tools", "edit_tools", "get_configuration_url"],
  };
  for (const [id, tools] of Object.entries(writes))
    for (const t of tools) {
      assert.ok(!presetFor(id).readTools.includes(t), `${id}: ${t} is in the allowlist`);
      assert.notEqual(classifyTool(id, t), "read", `${id}: ${t} must not default to allowed`);
    }
});

test("business: requested scopes are read-only, and own-client services explain the redirect", () => {
  for (const p of BUSINESS_PRESETS) {
    for (const s of p.scope.split(/\s+/).filter(Boolean)) assert.doesNotMatch(s, /write|edit|update|delete|publish|full|:all|admin/i, `${p.id}: scope ${s}`);
    if (p.needsOwnClient) assert.match(p.help, /redirect URI above/, `${p.id}: help must say where the redirect URI goes`);
    if (p.auth === "token") assert.match(p.help, /^Paste /, `${p.id}: token help starts with what to paste`);
  }
});

test("business: empty-allowlist services ask you to pick tools, and still block writes", () => {
  for (const id of EMPTY_ALLOWLIST) {
    const p = presetFor(id);
    assert.equal(p.id, id);
    assert.deepEqual(p.readTools, [], `${id}: allowlist should start empty`);
    assert.match(p.help, /go to What Athena can read and turn on the tools that only read/, `${id}: help must say to pick tools`);
    for (const t of ["create_note", "UpdateConversation", "send_reply", "delete-meeting"]) {
      assert.equal(classifyTool(id, t), "write", `${id}: ${t}`);
      assert.equal(classifyTool(id, t, { readOnlyHint: true }), "write", `${id}: ${t} with readOnlyHint`);
    }
    assert.equal(classifyTool(id, "get_transcript"), "unknown", `${id}: unlabelled reads start off`);
  }
});

test("business: Zapier allows only execute_zapier_read_action", () => {
  assert.deepEqual(presetFor("zapier").readTools, ["execute_zapier_read_action"]);
  assert.equal(classifyTool("zapier", "execute_zapier_read_action"), "read");
  assert.equal(classifyTool("custom", "execute_zapier_read_action"), "write", "only under the Zapier preset");
  assert.equal(classifyTool("zapier", "execute_zapier_write_action", { readOnlyHint: true }), "write");
});

// ---- classifyTool (owner, 7 Nov) ----
test("classifyTool: CamelCase names and manage are writes, even when a server says read-only", () => {
  for (const t of ["CreateFolder", "UpdateMeeting", "DeleteTag", "createSharedLink", "ShareMeeting", "manage_crm_objects", "table_rows_manage", "ManageUsers"]) {
    assert.equal(classifyTool("custom", t), "write", t);
    assert.equal(classifyTool("custom", t, { readOnlyHint: true }), "write", `${t} with readOnlyHint`);
  }
  for (const t of ["GetFolder", "ListMeetings", "getJiraIssue", "searchConfluence", "HTMLSummary"]) assert.notEqual(classifyTool("custom", t), "write", t);
  // A custom server's own readOnlyHint isn't trusted (security review M10): unknown, so off until the owner allows it.
  assert.equal(classifyTool("custom", "GetFolder", { readOnlyHint: true }), "unknown");
  assert.equal(classifyTool("dropbox", "GetFolder", { readOnlyHint: true }), "read");
});

test("classifyTool: merge_request is a noun; merging stays a write", () => {
  for (const t of ["list_merge_requests", "get_merge_request", "get_merge_request_diffs", "getMergeRequest", "merge-requests"])
    assert.notEqual(classifyTool("custom", t), "write", t);
  assert.equal(classifyTool("gitlab", "list_merge_requests"), "read");
  assert.equal(classifyTool("gitlab", "get_merge_request"), "read");
  for (const t of ["merge", "merge_branch", "merge_pr", "merge_pull_request", "merge-leads", "MergeRecords", "accept_merge_request", "create_merge_request", "save_merge_request", "update_merge_request"]) {
    assert.equal(classifyTool("custom", t), "write", t);
    assert.equal(classifyTool("custom", t, { readOnlyHint: true }), "write", `${t} with readOnlyHint`);
  }
});

test("classifyTool: activating or deactivating something is a write", () => {
  for (const t of ["scenario_activate", "scenario_deactivate", "activate_workflow", "DeactivateUser"]) {
    assert.equal(classifyTool("custom", t), "write", t);
    assert.equal(classifyTool("custom", t, { readOnlyHint: true }), "write", `${t} with readOnlyHint`);
  }
});

test("each group shows once in the Add an account picker", () => {
  const ids = CONNECTOR_CATEGORIES.map((c) => c.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  const labels = CONNECTOR_CATEGORIES.map((c) => c.label);
  assert.deepEqual(labels, [...new Set(labels)]);
});
