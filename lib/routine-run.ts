/**
 * One run of a routine (lib/routines.ts), and delivering it.
 *
 * The question goes to Ask's one loop (lib/answer.ts runAsk) with today's
 * context, exactly as if the owner had asked it, but in "propose" mode
 * (lib/ask-plans.ts): nobody is watching, so nothing is written. A routine
 * that asks for changes gets them back as a plan card the owner taps Go on,
 * in the same reply as its answer. The run is kept as an Ask conversation
 * (ask_threads), so it's on every device.
 *
 * Delivery is a nudge (rule "routine", lib/proactive/): a push and a "From
 * Athena" card that opens the conversation, through the same gate as every
 * nudge, so the daily cap and quiet hours hold. A run in quiet hours keeps
 * its nudge (`pending`) until they end; one over the cap isn't pushed, and
 * its conversation is still in Ask.
 *
 * Per-run budget: the loop's longer limits (AnswerOptions.long: 10 model
 * calls, 24 lookups, wrap-up at 60 s, stop at 120 s; owner, 12 Nov 2026),
 * and, once it starts queuing changes, up to 14 model calls in four minutes.
 * Under five minutes of the background function's 15. reminders.ts claims
 * each slot once (claimSlot) and hands the run to a background function
 * (netlify/functions/routine-run.ts).
 */
import { randomUUID } from "node:crypto";
import type { AskReply } from "./answer";
import { stripCitations } from "./answer-text";
import { zonedToday } from "./dates";
import { gate } from "./proactive/gate";
import type { Nudge } from "./proactive/types";
import type { QuietHours } from "./nudges";
import type { PushPayload } from "./push";
import { claimSlot, dueSlot, listRoutines, markDelivered, pendingNudges, recordRun, scheduleWords, setPending, type Routine } from "./routines";

/** A routine's card stays on Home this long. */
const CARD_HOURS = 20;

export interface RoutineRunDeps {
  /** Ask's one loop with the real sources, proposing only (lib/answer.ts runAsk with plan "propose"): it reads, and any change it would make comes back as a plan. */
  ask: (question: string, opts: { now: Date; tz: string; routine_id: string; thread_id: string }) => Promise<AskReply>;
  /** Keep the conversation (lib/ask-threads.ts saveAskThread). */
  saveThread: (id: string, input: Record<string, unknown>) => Promise<unknown>;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}…`;
};

/** The run's conversation: the routine's question, then Ask's reply, with the plan it proposed if it did. Pure. */
export function routineMessages(r: Pick<Routine, "prompt">, at: string, a: AskReply): unknown[] {
  return [
    { role: "me", text: r.prompt, at },
    {
      role: "answer",
      at,
      question: r.prompt,
      text: a.text,
      sources: a.sources.map((s) => ({ n: s.n, kind: s.kind, id: s.id, url: s.url, date: s.date, account: s.account, ...(s.id ? {} : { title: s.title }) })),
      related: a.related.map((x) => ({ kind: x.kind, id: x.id })),
      searched: a.searched,
      skipped: a.skipped,
      found: a.found,
      flagged: a.flagged,
      sample: false,
      note: null,
      fallback: null,
      ...(a.next?.length ? { next: a.next } : {}),
      // Proposals only: whatever came back, nothing in a routine's reply is a change that happened.
      ...(a.plan ? { plan: a.plan } : {}),
    },
  ];
}

/** The nudge a run makes: the routine's name, the answer's first line, and a card that opens the conversation. Pure. */
export function routineNudge(r: Pick<Routine, "id" | "title" | "days" | "time">, slot: Date, threadId: string, text: string, planned: number): Nudge {
  const said = clip(stripCitations(text), 140) || "It's ready in Ask.";
  return {
    rule: "routine",
    key: `routine:${r.id}:${slot.toISOString()}`,
    title: r.title,
    body: planned ? `${said} ${planned === 1 ? "One change is" : `${planned} changes are`} waiting for your approval.` : said,
    why: [`You set this up to run ${scheduleWords(r).replace(/^Every/, "every").replace(/^Weekdays/, "on weekdays").replace(/^Weekends/, "at weekends")}.`, planned ? "Nothing has changed: a routine only suggests changes, and you approve them." : "It only read your own data to answer."],
    context: `${r.title}, from your routine.`,
    prompt: "",
    about: [],
    actions: [],
    thread_id: threadId,
    expires_at: new Date(slot.getTime() + CARD_HOURS * 3_600_000).toISOString(),
  };
}

/** Run one routine for its slot: ask (reading, and proposing any change), keep the conversation, and keep its nudge to deliver. */
export async function runRoutine(r: Routine, slot: Date, deps: RoutineRunDeps, opts: { now?: Date; tz: string }): Promise<{ thread_id: string; nudge: Nudge; plan: boolean }> {
  const now = opts.now ?? new Date();
  const threadId = randomUUID();
  const at = now.toISOString();
  const reply = await deps.ask(r.prompt, { now, tz: opts.tz, routine_id: r.id, thread_id: threadId });
  const planned = reply.plan?.steps.length ?? 0;
  await deps.saveThread(threadId, { title: r.title, messages: routineMessages(r, at, reply), created_at: at, updated_at: at });
  await recordRun(r.id, threadId, now);
  const nudge = routineNudge(r, slot, threadId, reply.text, planned);
  await setPending(r.id, nudge);
  return { thread_id: threadId, nudge, plan: planned > 0 };
}

/** The routines due now (those not yet moved to Team), each with its slot claimed: at most one run per routine per slot. */
export async function claimDueRoutines(now: Date, tz: string): Promise<Array<{ routine: Routine; slot: Date }>> {
  const out: Array<{ routine: Routine; slot: Date }> = [];
  // A routine that's now a Team assistant (lib/team-migrate.ts) runs as that assistant, never twice.
  const moved = await (await import("./team-migrate")).migratedRoutineIds();
  for (const r of await listRoutines()) {
    if (!r.prompt || moved.has(r.id)) continue;
    const slot = dueSlot(r, now, tz);
    if (slot && (await claimSlot(r.id, slot))) out.push({ routine: r, slot });
  }
  return out;
}

export interface DeliverDeps {
  canPush: boolean;
  send: (p: PushPayload) => Promise<unknown>;
  quiet: QuietHours | null;
}

/**
 * Send each run's nudge that's waiting, through the shared gate: quiet hours
 * hold it for a later pass; past the cap, muted or switched off, it's let go
 * (the conversation is still in Ask).
 */
export async function deliverRoutines(now: Date, tz: string, deps: DeliverDeps): Promise<{ sent: number; held: number }> {
  const waiting = await pendingNudges();
  if (!waiting.length) return { sent: 0, held: 0 };
  const [{ loadProactivePrefs, loadMutes, madeOn, seenKeys, recordNudge, markPushed }, { loadWorkingHours }, { nudgeUrl }] = await Promise.all([import("./proactive/store"), import("./scheduling"), import("./proactive/urls")]);
  const [prefs, mutes, hours] = await Promise.all([loadProactivePrefs(), loadMutes(), loadWorkingHours()]);
  const today = zonedToday(now, tz);
  let madeToday = await madeOn(today);
  let sent = 0;
  let held = 0;
  for (const w of waiting) {
    const n = w.nudge as Nudge;
    const { pass, held: out } = gate([n], { now, tz, prefs, working: { days: hours.days, start: hours.start, end: hours.end }, quiet: deps.quiet, mutes, madeToday, seen: await seenKeys([n.key]) });
    if (!pass.length) {
      if (out[0]?.reason === "quiet") held++;
      else await markDelivered(w.id);
      continue;
    }
    const kept = await recordNudge(n, today, now);
    await markDelivered(w.id);
    if (!kept) continue;
    madeToday++;
    sent++;
    if (deps.canPush) {
      try {
        await deps.send({ title: n.title, body: n.body, url: nudgeUrl(kept.id), tag: `nudge:${n.key}` });
        await markPushed(kept.id);
      } catch (error) {
        console.error("Athena routines: push failed", (error as Error).message?.slice(0, 120));
      }
    }
  }
  return { sent, held };
}

export const ROUTINE_RUN_PATH = "/.netlify/functions/routine-run";

/** Hand one claimed run to the background function. Throws when it can't be reached. */
export async function handOffRoutine(origin: string, routineId: string, slot: Date, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get("MCP_BEARER_TOKEN") ?? process.env.MCP_BEARER_TOKEN;
  if (!token) throw new Error("MCP_BEARER_TOKEN isn't set");
  const res = await fetchImpl(new URL(ROUTINE_RUN_PATH, origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ routine_id: routineId, slot: slot.toISOString() }),
  });
  if (!res.ok) throw new Error(`background function answered ${res.status}`);
}
