/**
 * Flows (lib/flows.ts, lib/flow-run.ts; the contract is lib/flow-types.ts):
 *
 *   GET    /api/flows                       → FlowListResponse
 *   POST   /api/flows            FlowInput  → { flow } (201)
 *   GET    /api/flows/catalog               → { entries }
 *   GET    /api/flows/:id                   → { flow, runs }
 *   PATCH  /api/flows/:id        FlowInput  → { flow }
 *   DELETE /api/flows/:id                   → { ok: true }
 *   POST   /api/flows/:id/run    { dry? }   → { run } (202): queued and handed to the background function. dry: a try
 *                                           on the last thing that matched its trigger; nothing is changed
 *   POST   /api/flows/:id/hand   { assistant_id: string | "new" } → { flow }: "new" makes an assistant for it
 *   POST   /api/flows/:id/take-back         → { flow }: a plain flow again
 *   POST   /api/flows/:id/export { edits?, fine?, download? } → FlowExport (lib/flow-share-store.ts); with download
 *                                           and nothing flagged or blocked, the zip; otherwise 409 with what's left
 *   GET    /api/flows/runs/:runId           → { run }
 *   POST   /api/flows/runs/:runId/answer  { step_id, choice } → { run }
 *   POST   /api/flows/runs/:runId/go      { step_id } → { run }: the waiting change runs through Ask's plan code
 *   POST   /api/flows/runs/:runId/skip    { step_id } → { run }
 *   POST   /api/flows/runs/:runId/stop      → { run }
 *
 * /api/flows/draft and /api/flows/suggestions are drafting's and suggestions' (null here, so their routes answer).
 * Behind the same bearer token as the rest of the API.
 */
import { AthenaInputError, q } from "../../lib/db";
import { FLOW_LIMITS, type Flow, type FlowListResponse, type FlowRun } from "../../lib/flow-types";
import { flowCatalog } from "../../lib/flow-catalog";
import { createFlow, deleteFlow, getFlow, getRun, insertRun, latestRuns, listFlows, listRuns, saveRun, setFlowAssistant, updateFlow } from "../../lib/flows";
import { settleRun, stopRun, type FlowEffects, type Settle } from "../../lib/flow-run";
import { clip } from "../../lib/flow-steps";
import type { EventFilter } from "../../lib/team-types";
import type { TeamEventRow } from "../../lib/team-events";
import { unansweredWords } from "../../lib/flow-share";

type Json = (data: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FlowRouteDeps {
  /** The run's effects (lib/flow-effects.ts flowEffects), made when a route needs them. */
  effects: () => Promise<FlowEffects>;
  /** Hand a queued run to the background function. Throws when it can't. */
  handOff: (runId: string) => Promise<void>;
}

/** Ids a body names: a step's, as the run page sends it. */
const stepIdOf = (b: Record<string, unknown>): string => {
  if (typeof b.step_id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(b.step_id)) throw new AthenaInputError("step_id: the waiting step's id");
  return b.step_id;
};

/** The newest team_events row that matches a trigger's filter, for a try (team_events keeps seven days). */
async function lastMatching(f: EventFilter): Promise<TeamEventRow | null> {
  const { matchesFilter, toEventRow } = await import("../../lib/team-triggers");
  // q, not qRaw: facets are sealed (lib/team-events.ts); toEventRow parses them.
  const rows = (await q<Parameters<typeof toEventRow>[0]>(`SELECT id, kind, ref_id, ref_kind, facets, created_at FROM team_events ORDER BY id DESC LIMIT 1000`)).map(toEventRow);
  return rows.find((r) => matchesFilter(f, { kind: r.kind, facets: r.facets })) ?? null;
}

/** What a run starts from: Run now's words and values, or a try's on the last thing that matched, with the values a real run would get. */
async function startFrom(flow: Flow, dry: boolean, tz: string, now: Date): Promise<{ label: string; values: Record<string, unknown>; event_ids?: string[] }> {
  const { pickValues, scheduleValues, eventValues } = await import("../../lib/flow-triggers");
  if (flow.trigger.kind === "schedule") return { label: dry ? "A try, as if it were today" : "Run now", values: pickValues(flow.trigger, scheduleValues(now, tz)) };
  if (flow.trigger.kind === "manual") {
    const { zonedToday } = await import("../../lib/dates");
    return { label: "Run now", values: { date: zonedToday(now, tz) } };
  }
  if (!dry) return { label: "Run now", values: {} };
  if (flow.trigger.kind === "event") {
    const ev = await lastMatching(flow.trigger.event);
    if (!ev) throw new AthenaInputError("Nothing has matched this trigger in the last week, so there's nothing to try it on yet.");
    const [{ runLabel }, { dbItemValues }] = await Promise.all([import("../../lib/team-run"), import("../../lib/flow-triggers-db")]);
    const more = await dbItemValues(ev).catch(() => ({}));
    return { label: `A try on: ${runLabel(null, [ev])}`, values: pickValues(flow.trigger, { ...eventValues([ev]), ...more }), event_ids: [ev.id] };
  }
  return { label: "A try on past data", values: {} };
}

export async function handleFlowRoutes(req: Request, segments: string[], body: () => Promise<Record<string, unknown> | null>, json: Json, deps: FlowRouteDeps): Promise<Response | null> {
  const [, second, third, fourth] = segments;
  const method = req.method;
  const nope = () => json({ error: "Method not allowed" }, 405);
  // Drafting's and suggestions' (netlify/lib/flow-draft-routes.ts, flow-suggest-routes.ts).
  if (second === "draft" || second === "suggestions") return null;
  if (segments.length > 4) return null;

  if (!second) {
    if (method === "GET") {
      const [flows, latest] = await Promise.all([listFlows(), latestRuns()]);
      return json({ flows, latest, max: FLOW_LIMITS.flows } satisfies FlowListResponse);
    }
    if (method === "POST") return json({ flow: await createFlow((await body()) ?? {}) }, 201);
    return nope();
  }

  if (second === "catalog" && !third) {
    if (method !== "GET") return nope();
    return json({ entries: flowCatalog() });
  }

  if (second === "runs") {
    if (!third || !UUID.test(third)) return json({ error: "Not found" }, 404);
    if (!fourth) {
      if (method !== "GET") return nope();
      const r = await getRun(third);
      return r ? json({ run: r.run }) : json({ error: "Not found" }, 404);
    }
    if (method !== "POST") return nope();
    const b = (await body()) ?? {};
    const fx = await deps.effects();
    let s: Settle | null = null;
    if (fourth === "answer") {
      if (!Number.isInteger(b.choice)) throw new AthenaInputError("choice: the number of the choice, from 0");
      s = { kind: "answer", step_id: stepIdOf(b), choice: b.choice as number };
    } else if (fourth === "go") s = { kind: "go", step_id: stepIdOf(b) };
    else if (fourth === "skip") s = { kind: "skip", step_id: stepIdOf(b) };
    else if (fourth === "stop") return json({ run: await stopRun(third, { fx }) });
    else return json({ error: "Not found" }, 404);
    const out = await settleRun(third, s, { fx });
    if (out.queued) {
      // Carries on in the background function; a hand-off that fails leaves it queued for the next reminders pass.
      await deps.handOff(out.run.id).catch((e) => console.error("Athena flows: couldn't hand off a run", e instanceof Error ? e.message.slice(0, 120) : e));
    }
    return json({ run: out.run });
  }

  if (!UUID.test(second)) return json({ error: "Not found" }, 404);

  if (!third) {
    if (method === "GET") {
      const flow = await getFlow(second);
      return flow ? json({ flow, runs: await listRuns(flow.id) }) : json({ error: "Not found" }, 404);
    }
    if (method === "PATCH") return json({ flow: await updateFlow(second, (await body()) ?? {}) });
    if (method === "DELETE") return (await deleteFlow(second)) ? json({ ok: true }) : json({ error: "Not found" }, 404);
    return nope();
  }

  if (method !== "POST") return nope();
  const flow = await getFlow(second);
  if (!flow) return json({ error: "Not found" }, 404);

  if (third === "run") {
    // A flow added from a file runs only once its questions are answered: a run would leave its blanks empty.
    const unanswered = unansweredWords(flow.unfilled);
    if (unanswered) return json({ error: unanswered }, 409);
    const b = (await body()) ?? {};
    const dry = b.dry === true;
    const fx = await deps.effects();
    const from = await startFrom(flow, dry, fx.tz, fx.now());
    const made = await insertRun(flow, { label: from.label, values: { trigger: from.values as never }, event_ids: from.event_ids, dry, byHand: true });
    if (!made) throw new AthenaInputError("That run couldn't be queued. Try again.");
    try {
      await deps.handOff(made.run.id);
    } catch (error) {
      console.error("Athena flows: couldn't start a run", (error as Error).message?.slice(0, 120));
      const line = "It couldn't start. Try again in a minute.";
      await saveRun(made.run.id, made.version, { status: "failed", error: line, summary: line, finished: true });
      return json({ run: (await getRun(made.run.id))!.run, error: line }, 503);
    }
    return json({ run: made.run satisfies FlowRun }, 202);
  }

  if (third === "hand") {
    const b = (await body()) ?? {};
    const want = b.assistant_id;
    const { createAssistant, listAssistants } = await import("../../lib/team");
    let assistantId: string;
    if (want === "new") {
      // A fresh seed gives it a name, a face and a voice; its job says what it's for.
      const made = await createAssistant({ job: clip(`Runs the flow “${flow.name}”`, 140) });
      assistantId = made.id;
    } else {
      if (typeof want !== "string" || !UUID.test(want)) throw new AthenaInputError('assistant_id: an assistant\'s id, or "new"');
      // A guest works on its assignment only (lib/assignments.ts): only the team's own can take a flow.
      if (!(await listAssistants()).some((a) => a.id === want)) throw new AthenaInputError("That assistant isn't on your team", 404);
      assistantId = want;
    }
    return json({ flow: await setFlowAssistant(flow.id, assistantId) });
  }

  if (third === "take-back") return json({ flow: await setFlowAssistant(flow.id, null) });

  if (third === "export") {
    const b = (await body()) ?? {};
    const { exportFlowFor, flowZip } = await import("../../lib/flow-share-store");
    const { ownHosts } = await import("../../lib/team-share-store");
    const made = await exportFlowFor(flow.id, { body: b, hosts: ownHosts(new URL(req.url).origin) });
    if (b.download !== true) return json(made);
    if (made.findings.length || made.blocked.length) return json({ error: made.blocked.length ? "A step can't be shared yet. See the sheet for which." : "Check what's flagged first: edit it out, or say it's fine to share.", findings: made.findings, blocked: made.blocked }, 409);
    return new Response(Buffer.from(flowZip(made)), { status: 200, headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${made.slug}.zip"`, "Cache-Control": "no-store" } });
  }

  return json({ error: "Not found" }, 404);
}
