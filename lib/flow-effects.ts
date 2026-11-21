/**
 * Flows: what a run reaches outside itself, for real (lib/flow-run.ts FlowEffects), the hand-off to the
 * background function, and sending the cards runs keep (a Notify step's, one saying a run waits for the owner,
 * an assistant's "From <Name>"). Cards go through the same gate as every nudge (lib/proactive/gate.ts): the Flows
 * switch for a plain flow, Team's for an assistant's, "Fewer like this", quiet hours and the daily cap. One held for
 * quiet hours is tried again each pass until it would have expired.
 *
 * A draft step's Go writes the draft with Ask's own code and accounts (lib/assistant.ts runAssistantTool, the same
 * mail and Slack ports Ask gets) and keeps it as a change to read and save from What Ask did and the run. Nothing is
 * sent, and nothing is saved to Gmail or Outlook Drafts until the owner taps Save there.
 */
import type { Change } from "./assistant";
import type { ConfirmCard } from "./assistant-confirm";
import { AthenaInputError, qRaw } from "./db";
import { zonedToday } from "./dates";
import { gate } from "./proactive/gate";
import type { Nudge } from "./proactive/types";
import type { QuietHours } from "./nudges";
import type { PushPayload } from "./push";
import type { GmailPort, SlackPort } from "./drafts";
import type { CalendarPort } from "./rsvp";
import type { SchedulingPort } from "./scheduling";
import { getFlow, noteMade, runsWhere, saveRun } from "./flows";
import { flowRunUrl, type FlowAssistant, type FlowEffects, type LogContext } from "./flow-run";

const env = (k: string) => (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get(k) ?? process.env[k];

/** The accounts Go may need for an assistant's plan (a move needs the calendar). Flows' own tools need none. */
export interface FlowPorts {
  gmail?: GmailPort;
  slack?: SlackPort;
  calendar?: CalendarPort;
  scheduling?: SchedulingPort;
}

/** What What Ask did keeps a run's changes as: a plain flow's as `flow`, with the flow and run; an assistant's as given. */
export function flowActivity<C extends { source: string }>(given: C, ctx: LogContext): C & { flow_id?: string; flow_run_id?: string } {
  return ctx.assistant ? given : { ...given, source: "flow", flow_id: ctx.flowId, flow_run_id: ctx.runId };
}

/** A draft step with no account to write it in. */
export const NO_DRAFT_ACCOUNT = "No email account is connected, so there's nowhere to write this draft. Connect Gmail or Outlook in Sources, then try again.";
/** An email account is connected, but drafts aren't on for it. */
export const DRAFTS_OFF = "Drafts aren't turned on for your email account. Turn them on in Sources, then try again.";

/**
 * A draft step's Go, as changes: the draft Ask wrote, kept for the owner to read (and, for an email, save to their
 * Drafts from the app). An email with no account to keep it in stops the step with a clear line. Pure.
 */
export function draftChanges(out: { changes: Change[]; confirm: ConfirmCard[] }, newId: () => string): Change[] {
  const card = out.confirm.find((c): c is Extract<ConfirmCard, { kind: "draft" }> => c.kind === "draft");
  if (card) {
    const first = card.to.split(/\s+/)[0] || card.to;
    const detail = `Email to ${first} · ready to check, then save to ${card.drafts_in} Drafts`;
    return [{ kind: "draft", id: newId(), action: "created", title: card.title, detail, label: `${card.title}: ${detail}`, open: { kind: "draft", draft: card.draft }, undo: null }];
  }
  for (const c of out.changes) {
    const d = c.open && c.open.kind === "draft" ? c.open.draft : null;
    if (d && d.channel === "email" && !d.accounts.length) throw new AthenaInputError(d.can_enable_drafts ? DRAFTS_OFF : NO_DRAFT_ACCOUNT);
  }
  return out.changes;
}

/** The real effects: Ask's tools and plans, the flow's assistant, assignments and the record. */
export async function flowEffects(opts: { now?: () => Date; ports?: FlowPorts } = {}): Promise<FlowEffects> {
  const { getOwnerTimeZone } = await import("./db");
  const tz = await getOwnerTimeZone();
  const now = opts.now ?? (() => new Date());
  const ports = opts.ports ?? {};
  const changesOf = (results: Array<{ status: string; error?: string; changes: Change[] }> | null) => {
    const list = results ?? [];
    const changes = list.flatMap((r) => r.changes);
    const failed = list.find((r) => r.status === "failed");
    return { changes, ...(failed && !changes.length ? { error: failed.error ?? "That change didn't work." } : {}) };
  };
  return {
    now,
    tz,
    askMoney: async () => (await import("./money")).loadAskMoney(),
    async runTool(name, input, o) {
      const { isReadTool } = await import("./flow-catalog");
      if (isReadTool(name)) {
        const [{ ReadTools }, { guardText }] = await Promise.all([import("./ask-tools"), import("./jev")]);
        const reads = new ReadTools({ cite: (kind, id) => `${kind}:${id}`, tz, now: now(), money: o.money, guard: async (t) => (await guardText(t)).text });
        return { result: await reads.run(name, input), changes: [] };
      }
      const { runAssistantTool } = await import("./assistant");
      const out = await runAssistantTool(name, input, { now: now(), tz });
      return { result: out.result, changes: out.changes };
    },
    async log(changes, ctx) {
      const { logChanges } = await import("./ask-activity");
      // A plain flow's changes are "Flow: <name>"; an assistant's stay the team's, as its runs' do.
      return logChanges(changes, flowActivity({ source: "team" as const }, ctx));
    },
    async savePlan(step) {
      const { savePlan } = await import("./ask-plans");
      const { randomUUID } = await import("node:crypto");
      // A plan with no routine and no conversation: What Ask did shows its changes as the team's once Go runs it.
      return (await savePlan([{ label: step.label, tool: step.tool, input: step.input, stands_for: randomUUID() }], { source: "routine" })).id;
    },
    async goPlan(planId, ctx) {
      const [{ goPlan }, { runPlanTool, runAssistantTool }, { logChanges }, { isDraftTool }, { randomUUID }] = await Promise.all([
        import("./ask-plans"),
        import("./assistant"),
        import("./ask-activity"),
        import("./flow-catalog"),
        import("node:crypto"),
      ]);
      const run = async (tool: string, input: unknown): Promise<Change[]> => {
        if (!isDraftTool(tool)) return runPlanTool(tool, input, { ...ports, now: now(), tz });
        // A draft: Ask's own code and accounts, written for the owner to read. Never sent, never saved to Drafts here.
        if (!ports.gmail) throw new AthenaInputError(NO_DRAFT_ACCOUNT);
        return draftChanges(await runAssistantTool(tool, input, { ...ports, now: now(), tz }), randomUUID);
      };
      const went = await goPlan(planId, undefined, { run, log: (changes, c) => logChanges(changes, flowActivity(c, ctx)) });
      return changesOf(went.plan.ran?.results ?? null);
    },
    async dropPlan(planId) {
      await qRaw(`UPDATE ask_plans SET ran_at = now() WHERE id = $1::uuid AND ran_at IS NULL`, [planId]);
    },
    async planRan(planId, ctx) {
      const { getPlan } = await import("./ask-plans");
      const plan = await getPlan(planId);
      if (!plan) return { changes: [], error: "The change isn't there any more." };
      if (!plan.ran_at) return null;
      // Ran with no results: Skip or Stop dropped it, or a Go is still running it.
      if (!plan.results) return null;
      // Go'd from Ask: What Ask did shows a plain flow's change as the flow's all the same.
      if (!ctx.assistant) {
        await qRaw(`UPDATE ask_activity SET source = 'flow', flow_id = $2::uuid, flow_run_id = $3::uuid WHERE plan_id = $1::uuid AND source <> 'flow'`, [planId, ctx.flowId, ctx.runId]).catch(() => undefined);
      }
      return changesOf(plan.results);
    },
    async assistant(id): Promise<FlowAssistant | null> {
      const { getAssistant } = await import("./team");
      const a = await getAssistant(id);
      return a ? { id: a.id, name: a.name, avatar: a.avatar, personality: a.personality } : null;
    },
    async think(assistantId, prompt, o) {
      const [{ runAssistantTurn }, { withSpendScope }, { randomUUID }] = await Promise.all([import("./team-chat"), import("./spend"), import("node:crypto")]);
      const threadId = o.dry ? null : randomUUID();
      // AI spend: the step counts toward this assistant's own cap, as its runs do (lib/spend.ts).
      const out = await withSpendScope({ area: "assistant", assistantId }, () => runAssistantTurn(assistantId, prompt, { mode: "run", readOnly: o.dry, threadId, shown: o.label, ...ports }));
      // What Ask did shows a flow step's changes as the team's, like a run's (lib/team-run.ts).
      if (out.thread_id) await qRaw(`UPDATE ask_activity SET source = 'team' WHERE thread_id = $1::uuid AND source = 'routine' AND plan_id IS NULL`, [out.thread_id]).catch(() => undefined);
      const plan = out.reply.plan?.steps.length ? { id: out.reply.plan.id, steps: out.reply.plan.steps.map((s) => s.label) } : null;
      return { text: out.text, changes: out.reply.changes ?? [], plan };
    },
    async draftAssignment(brief) {
      const { draftAssignment } = await import("./assignment-run");
      const d = await draftAssignment(brief);
      return { id: d.assignment_id, lineup: d.lineup };
    },
    async assignment(id) {
      const { headOf } = await import("./assignments");
      const h = await headOf(id);
      return h ? { status: h.status, title: h.title, note_id: h.note_id } : null;
    },
    async teamActivity(assistantId, run) {
      const { enqueueTeamRun, finishTeamRun } = await import("./team-run");
      // Kept as a finished, quiet run of the assistant's: on Team activity with its summary, with no card of its own
      // (the flow sends its own), and never picked up by the team-run function (it's finished at once).
      const made = await enqueueTeamRun(assistantId, { label: run.label });
      await finishTeamRun(made.id, run.failed ? { status: "failed", error: run.summary, quiet: true } : { status: "done", summary: run.summary, quiet: true });
    },
    noteMade,
  };
}

// ---------- handing off ----------

/** Under /api/ on purpose, as /api/team-run is: the login gate lets /api/* through to the bearer check. */
export const FLOW_RUN_PATH = "/api/flow-run";
/** A hand-off waits this long for the background function to answer (it answers 202 at once). */
export const HAND_OFF_MS = 5_000;

/** The site's own address, for handing a run off from outside a request. */
export const flowOrigin = (): string | undefined => env("URL") || undefined;

/** Hand one queued run to the background function. Throws when it can't be reached or doesn't answer in time. */
export async function handOffFlowRun(origin: string, runId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = env("MCP_BEARER_TOKEN");
  if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
  const res = await fetchImpl(new URL(FLOW_RUN_PATH, origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_id: runId }),
    signal: AbortSignal.timeout(HAND_OFF_MS),
    // A redirect is never the background function: followed, the login page's 200 would read as "handed off".
    redirect: "manual",
  });
  if (res.status !== 202) throw new Error(`background function answered ${res.status}`);
}

// ---------- cards ----------

export interface DeliverDeps {
  canPush: boolean;
  send: (p: PushPayload) => Promise<unknown>;
  quiet: QuietHours | null;
}

/**
 * A run's card as a nudge, keyed `flow:<run>:…` so it's sent once, opening the run. A plain flow's follows the Flows
 * switch (rule "flow"); an assistant's follows Team's (rule "team") and carries its avatar. Pure.
 */
export function flowNudge(n: { key: string; title: string; body: string; until: string }, run: { id: string }, flow: { name: string }, assistant: Pick<FlowAssistant, "id" | "name" | "avatar"> | null): Nudge {
  return {
    rule: assistant ? "team" : "flow",
    key: n.key,
    title: n.title,
    body: n.body,
    why: [assistant ? `${assistant.name} runs your flow “${flow.name}”.` : `From your flow “${flow.name}”.`],
    context: assistant ? `${assistant.name}, from your team.` : `Your flow “${flow.name}”.`,
    prompt: "",
    about: [],
    actions: [],
    url: flowRunUrl(run.id),
    ...(assistant ? { assistant: { id: assistant.id, name: assistant.name, avatar: assistant.avatar } } : {}),
    expires_at: n.until,
  };
}

/**
 * Send the cards runs keep, through the shared gate. Sent, or not to be sent (switched off, muted, past the cap,
 * expired): done. Held for quiet hours: tried again next pass. A run another write moved on is left for the next
 * pass; the nudge key keeps a card from going twice.
 */
export async function deliverFlowNotices(now: Date, tz: string, deps: DeliverDeps): Promise<{ sent: number; held: number }> {
  const runs = await runsWhere(`notices_pending AND started_at > $1`, [new Date(now.getTime() - 3 * 86_400_000).toISOString()], 100);
  if (!runs.length) return { sent: 0, held: 0 };
  const [{ loadProactivePrefs, loadMutes, madeOn, seenKeys, recordNudge, markPushed }, { loadWorkingHours }, { getAssistant }] = await Promise.all([import("./proactive/store"), import("./scheduling"), import("./team")]);
  const [prefs, mutes, hours] = await Promise.all([loadProactivePrefs(), loadMutes(), loadWorkingHours()]);
  const today = zonedToday(now, tz);
  let madeToday = await madeOn(today);
  let sent = 0;
  let held = 0;
  for (const stored of runs) {
    const flow = await getFlow(stored.run.flow_id);
    const a = stored.run.assistant_id ? await getAssistant(stored.run.assistant_id).catch(() => null) : null;
    const state = stored.state;
    const seen = await seenKeys(state.notices.map((n) => n.key));
    for (const n of state.notices) {
      if (n.done) continue;
      if (!flow || seen.has(n.key) || Date.parse(n.until) <= now.getTime()) {
        n.done = true;
        continue;
      }
      const nudge = flowNudge(n, stored.run, flow, a ? { id: a.id, name: a.name, avatar: a.avatar } : null);
      const { pass, held: out } = gate([nudge], { now, tz, prefs, working: { days: hours.days, start: hours.start, end: hours.end }, quiet: deps.quiet, mutes, madeToday, seen: new Set() });
      if (!pass.length) {
        if (out[0]?.reason === "quiet") held++;
        else n.done = true;
        continue;
      }
      n.done = true;
      const kept = await recordNudge(nudge, today, now);
      if (!kept) continue;
      madeToday++;
      sent++;
      if (deps.canPush) {
        try {
          await deps.send({ title: nudge.title, body: nudge.body, url: nudge.url!, tag: `nudge:${nudge.key}` });
          await markPushed(kept.id);
        } catch (error) {
          console.error("Athena flows: push failed", (error as Error).message?.slice(0, 120));
        }
      }
    }
    await saveRun(stored.run.id, stored.version, { state }).catch(() => false);
  }
  return { sent, held };
}
