// Run: npx tsx --test netlify/lib/connectors/ask-work.test.ts
// Ask and other people's work: "what's on Priya's plate?" is answered live from the Linear account (list_issues by
// assignee), nothing in the prompt stands in the way, and nothing about Priya is offered for saving or saved.
// The account is an MCP client stubbed at its transport, so listAllowedTools and callTool run as they do for real.
// No database (Athena's own search fails quietly without one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQuestion } from "../../../lib/answer";
import type { Connector } from "../../../lib/connectors";
import { answerSourcesWith } from "./answer-sources";
import { importAnswerItems } from "./ask-import";
import type { OpenConnector } from "./mcp-client";
import { NOW, scripted, TZ, use } from "./ask-import.fixtures";
import * as W from "./fixtures/work-tools";

const PRIYA = "Priya Teammate";

function linearAccount(calls: Array<{ name: string; args: Record<string, unknown> }>): { c: Connector; open: OpenConnector } {
  const c = {
    id: "6f1c0000-0000-4000-8000-00000000c001",
    name: "Linear",
    provider: "linear",
    account_label: "",
    status: "connected",
    auth_type: "oauth",
    oauth: {},
    created_at: "2026-10-01T08:00:00Z",
    allowed_tools: ["list_issues", "get_issue", "list_users", "list_cycles", "list_teams"],
  } as unknown as Connector;
  const schema = { type: "object", properties: { assignee: { type: "string" }, team: { type: "string" }, cycle: { type: "string" } } };
  const tools = ["list_issues", "get_issue", "list_users", "list_cycles", "list_teams", "save_issue"].map((name) => ({ name, description: `Linear ${name}`, inputSchema: schema, annotations: { readOnlyHint: name !== "save_issue" } }));
  const theirs = [
    { ...W.linearIssue({ n: 51, title: "Migrate the invoices table", assigneeId: W.TEAMMATE_ID, status: "In Progress", created: "2026-11-02T09:00:00.000Z", started: "2026-11-03T09:00:00.000Z" }), assignee: PRIYA },
    { ...W.linearIssue({ n: 52, title: "Fix the flaky checkout test", assigneeId: W.TEAMMATE_ID, status: "Todo", created: "2026-11-05T09:00:00.000Z" }), assignee: PRIYA },
  ];
  const client = {
    async listTools() {
      return { tools };
    },
    async callTool({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: name === "list_issues" ? W.linearReply(theirs) : "{}" }], isError: false };
    },
  };
  return { c, open: { connector: c, client, close: async () => undefined } as unknown as OpenConnector };
}

test("“What's on Priya's plate?” is answered from Linear, live, and nothing about her is kept", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const linear = linearAccount(calls);
  const link = "https://linear.app/acme/issue/ENG-51/slug";
  const { client, sent } = scripted([
    (tools) => [use(tools, "list_issues", { assignee: "Priya" })],
    (tools, seen) => {
      assert.ok(seen.includes("Migrate the invoices table"), "Linear answered");
      return [use(tools, "answer", { text: "Priya has two issues open: migrating the invoices table, in progress, and the flaky checkout test, still to start [1][2].", found: true, sources: [{ ref: link, title: "Migrate the invoices table" }, { ref: "https://linear.app/acme/issue/ENG-52/slug", title: "Fix the flaky checkout test" }] })];
    },
  ]);
  const reply = await answerQuestion("What's on Priya's plate?", { sources: answerSourcesWith({ list: async () => [linear.c], open: async () => linear.open }), client }, { now: NOW, tz: TZ });

  // Asked live, by assignee, with read tools only.
  assert.deepEqual(calls, [{ name: "list_issues", args: { assignee: "Priya" } }]);
  const { system, tools } = sent[0];
  assert.ok(!tools.some((t) => t.endsWith("save_issue")), "no write offered");
  assert.ok(tools.includes("work"), "the owner's own counts are there too");
  // Nothing in the prompt stands in the way of a question about someone else's work.
  assert.match(system, /Someone else's workload \("what's on Priya's plate\?"/);
  assert.match(system, /That's fine to do; Athena keeps none of it\./);
  for (const block of [/only (?:about|answer about) the owner/i, /never (?:answer|look up|search) .*(?:other people|someone else|teammates?)/i, /refuse/i]) assert.doesNotMatch(system, block);

  assert.equal(reply.found, true);
  assert.match(reply.text, /^Priya has two issues open/);
  assert.equal(reply.sources.length, 2);
  assert.deepEqual(reply.sources.map((s) => s.account), ["Linear", "Linear"]);
  // Nothing offered for saving: a Linear item is read live only.
  assert.equal(reply.imports, undefined);
  // Kept in the chat like any other answer (owner, 12 Nov: LIVE_ANSWERS_NOT_KEPT is off).
  assert.equal(reply.live_only, undefined);
  // The scrub still works for an answer marked live_only, should the switch go back on.
  const { scrubLiveOnly } = await import("../../../lib/ask-threads");
  const { LIVE_ONLY_KEPT } = await import("../../../lib/answer-text");
  const toSave = { role: "answer", at: "2026-11-08T10:00:00Z", question: "What's on Priya's plate?", text: reply.text, sources: reply.sources, related: [], searched: reply.searched, skipped: [], found: true, flagged: false, sample: false, note: null, fallback: null, next: ["What's Priya doing next?"], live_only: true, versions: [{ role: "answer", text: "Priya has two issues", sources: reply.sources, live_only: true }] };
  const kept = scrubLiveOnly(toSave);
  assert.equal(kept.text, LIVE_ONLY_KEPT);
  assert.deepEqual(kept.sources, []);
  assert.equal(kept.next, undefined);
  assert.equal(kept.question, "What's on Priya's plate?", "the owner's own words stay");
  const rest = JSON.stringify({ ...kept, question: "" });
  for (const word of ["Priya", "invoices", "linear.app"]) assert.ok(!rest.includes(word), `kept: ${word}`);

  // And if an app sent them anyway, nothing is saved.
  const saved: string[] = [];
  const receipt = await importAnswerItems(
    reply.sources.map((s) => ({ connector_id: linear.c.id, provider: "linear", url: s.url!, kind: "page" as const, title: s.title, date: null })),
    {
      has: async () => false,
      providerOf: async () => "linear",
      collect: (async (item: { title: string }) => {
        saved.push(item.title);
        return { source: "work-activity", writes: [], review: 0, updated: 0 };
      }) as never,
    },
  );
  assert.deepEqual(saved, []);
  assert.deepEqual(receipt.saved, []);
});
