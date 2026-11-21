// Flows' effects (lib/flow-effects.ts), the pure parts: which switch a run's card follows, how What Ask did keeps a
// flow's changes, and a draft step's Go (written for the owner to read; an email with no account stops the step).
// Made-up data only. Run: npx tsx --test lib/flow-effects.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Change } from "./assistant";
import type { ConfirmCard } from "./assistant-confirm";
import { DRAFTS_OFF, NO_DRAFT_ACCOUNT, draftChanges, flowActivity, flowNudge } from "./flow-effects";

const notice = { key: "flow:run-1:tell", title: "Renewal guard", body: "Your plan renews on 4 December", until: "2026-11-21T04:00:00Z" };
const avatar = { seed: "x" } as never;

test("a plain flow's card follows the Flows switch; an assistant's follows Team's, with its avatar; both open the run", () => {
  const plain = flowNudge(notice, { id: "run-1" }, { name: "Renewal guard" }, null);
  assert.equal(plain.rule, "flow");
  assert.equal(plain.url, "/#/flows/runs/run-1");
  assert.equal(plain.assistant, undefined);
  const handed = flowNudge(notice, { id: "run-1" }, { name: "Renewal guard" }, { id: "a-1", name: "Wren", avatar });
  assert.equal(handed.rule, "team");
  assert.equal(handed.assistant?.name, "Wren");
});

test("What Ask did: a plain flow's changes are the flow's; an assistant's keep their source", () => {
  assert.deepEqual(flowActivity({ source: "team" }, { assistant: false, flowId: "f-1", runId: "r-1" }), { source: "flow", flow_id: "f-1", flow_run_id: "r-1" });
  assert.deepEqual(flowActivity({ source: "team", plan_id: "p-1" }, { assistant: true, flowId: "f-1", runId: "r-1" }), { source: "team", plan_id: "p-1" });
});

const draft = (over: Record<string, unknown> = {}) => ({ channel: "email", available: ["email"], enabled: ["email"], to: [{ name: "Sam Example", email: "sam@example.com" }], subject: "Thanks for today", body: "Hi Sam", phone: null, slack: null, reply: null, accounts: [], can_enable_drafts: false, saved: null, flagged: false, ...over }) as never;

test("a draft step's Go: an email with an account comes back as a draft to read and save, never sent", () => {
  const card: ConfirmCard = { kind: "draft", draft: draft({ accounts: [{ id: "c-1", label: "Personal", provider: "gmail" }] }), title: "Thanks for today", to: "Sam Example", drafts_in: "Gmail" };
  const [c] = draftChanges({ changes: [], confirm: [card] }, () => "d-1");
  assert.equal(c.kind, "draft");
  assert.equal(c.id, "d-1");
  assert.equal(c.title, "Thanks for today");
  assert.equal(c.detail, "Email to Sam · ready to check, then save to Gmail Drafts");
  assert.equal(c.open?.kind, "draft");
  assert.equal(c.undo, null);
});

test("a draft step's Go: a text needs no account; an email with nowhere to keep it stops the step", () => {
  const text = { kind: "draft", id: "d-2", action: "created", title: "Running late", detail: "Text to Sam · ready to send", label: "x", open: { kind: "draft", draft: draft({ channel: "text" }) }, undo: null } as unknown as Change;
  assert.deepEqual(draftChanges({ changes: [text], confirm: [] }, () => "x"), [text]);
  const email = { ...text, open: { kind: "draft", draft: draft() } } as unknown as Change;
  assert.throws(() => draftChanges({ changes: [email], confirm: [] }, () => "x"), (e: Error) => e.message === NO_DRAFT_ACCOUNT);
  const off = { ...text, open: { kind: "draft", draft: draft({ can_enable_drafts: true }) } } as unknown as Change;
  assert.throws(() => draftChanges({ changes: [off], confirm: [] }, () => "x"), (e: Error) => e.message === DRAFTS_OFF);
});
