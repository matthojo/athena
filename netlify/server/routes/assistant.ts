/**
 * /api/assistant and /api/assistant/* — Ask. The handling is still the REST
 * dispatcher in netlify/functions/api.ts (auth included: the capture key for
 * /api/assistant/capture, the token or a full key for the rest). 20 requests
 * a minute per IP: every request spends AI Gateway credits.
 *
 * What the server adds (docs/netlify-server-ask.md):
 *  - Runs that outlive the app. A streamed reply sent with X-Ask-Run: <uuid>
 *    runs under context.waitUntil and is kept (../assistant/runs.ts), so the
 *    same request sent again, or GET /api/assistant/runs/<id>, follows it or
 *    replays how it ended; it never runs twice. DELETE stops it.
 *  - POST /api/assistant/warm, sent when Ask opens: wakes the instance and
 *    gets the connected accounts, today's context and the travel keys ready.
 *  - Connected accounts stay open between answers (../assistant/warm-sources.ts).
 */
import { onShutdown, type Context } from "@netlify/server";
import api from "../../functions/api";
import { askContext } from "../../../lib/ask-context";
import { listConnectors } from "../../../lib/connectors";
import { answerSourcesWith, useAnswerSources } from "../../lib/connectors/answer-sources";
import { primeTravelKeys } from "../../lib/travel-key";
import { runHost } from "../assistant/host";
import { createRuns, RunUnchecked } from "../assistant/runs";
import { blobRunStore, probeBlobs } from "../assistant/store";
import { warmSources } from "../assistant/warm-sources";
import { jsonResponse, rateLimit, requireAuth, warm } from "../shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };

const runs = () => warm("assistant:runs", () => createRuns({ store: blobRunStore() }));
const accounts = () => warm("assistant:accounts", () => warmSources(), (w) => w.close());
const sources = answerSourcesWith({ list: listConnectors, ...accounts().source });
useAnswerSources(sources);

/** The store couldn't say whether an instruction had already run, so it wasn't started: 503, in words Ask shows. */
const unchecked = (error: unknown): Response => {
  if (error instanceof RunUnchecked) return jsonResponse({ error: error.message }, 503);
  throw error;
};

/** The request each hosted run came in on, for its waitUntil. */
const contexts = new WeakMap<Request, Context>();

runHost.current = (req, work, headers) => {
  const id = req.headers.get("x-ask-run") ?? "";
  if (!UUID_RE.test(id)) return null;
  return (async () => {
    // One kind of run now: Ask's one loop (lib/answer.ts runAsk).
    const opened = await runs().open(id.toLowerCase(), "ask", work).catch(unchecked);
    if (opened instanceof Response) return opened;
    // The run carries on after the app goes away, and keeps the instance up until it ends.
    if (opened?.background) contexts.get(req)?.waitUntil(opened.background);
    return new Response(opened!.stream, { status: 200, headers: { ...NDJSON, ...headers, "X-Ask-Run": id.toLowerCase() } });
  })();
};

// Work in progress gets its 90 seconds; whatever is still going then is stopped and its record says so.
onShutdown(async ({ drained }) => {
  const going = runs().running();
  await drained;
  const left = runs().running();
  await runs().interruptAll();
  console.log(`Athena ask: instance shutting down; ${going} runs were going, ${left} stopped part-way and marked`);
});

/** Once per instance, on its first Ask request: say in the logs whether runs can be kept here. */
let probed: Promise<void> | null = null;
const probe = () =>
  (probed ??= probeBlobs().then(
    (r) => console.log(`Athena ask runs: Blobs ${r.ok ? "ok" : "read back wrong"} from the server in ${r.ms} ms; records ${blobRunStore() ? "kept, sealed" : "not kept (no data key here)"}`),
    (error) => console.warn("Athena ask runs: Blobs failed from the server:", error instanceof Error ? error.message : error),
  ));

/** Today's context is built for the minute it's asked in (lib/ask-context.ts): build this one, and the next two as they start. */
let contextTimers: Array<ReturnType<typeof setTimeout>> = [];
function keepContextWarm() {
  for (const t of contextTimers) clearTimeout(t);
  const toNextMinute = 60_000 - (Date.now() % 60_000) + 250;
  contextTimers = [0, toNextMinute, toNextMinute + 60_000].map((ms) => {
    const t = setTimeout(() => void askContext().catch(() => undefined), ms);
    t.unref?.();
    return t;
  });
}

/** Ask opened: have everything a first question needs ready. Each part fails quietly; a question opens what's missing. */
async function warmUp(): Promise<{ accounts: number; ms: number }> {
  const started = Date.now();
  keepContextWarm();
  const [opened] = await Promise.all([
    sources.open({ timeoutMs: 6_000 }).then(
      async (o) => {
        await o.close();
        return o.accounts.length;
      },
      () => 0,
    ),
    askContext().catch(() => ""),
    primeTravelKeys().catch(() => undefined),
  ]);
  return { accounts: opened, ms: Date.now() - started };
}

export async function handleAssistant(req: Request, context: Context): Promise<Response> {
  const limited = rateLimit(`assistant:${context.ip}`, 20);
  if (limited) return limited;
  await probe();
  const [, , third, fourth, ...rest] = new URL(req.url).pathname.split("/").filter(Boolean);
  if (req.method !== "OPTIONS" && third === "warm" && !fourth) {
    const denied = await requireAuth(req);
    if (denied) return denied;
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const warming = warmUp();
    context.waitUntil(warming.then((w) => console.log(`Athena ask warm: ${w.accounts} accounts in ${w.ms} ms`, accounts().stats)));
    // `wait` is for measuring (docs/netlify-server-ask.md); the app doesn't wait.
    return jsonResponse({ ok: true, runs: true, ...(new URL(req.url).searchParams.has("wait") ? { ...(await warming), ...accounts().stats } : {}) });
  }
  if (req.method !== "OPTIONS" && third === "runs") {
    const denied = await requireAuth(req);
    if (denied) return denied;
    if (!fourth || rest.length || !UUID_RE.test(fourth)) return jsonResponse({ error: "Not found" }, 404);
    const id = fourth.toLowerCase();
    if (req.method === "DELETE") return jsonResponse({ ok: true, stopped: runs().stop(id) });
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    const opened = await runs().open(id, null, null).catch(unchecked);
    if (opened instanceof Response) return opened;
    return opened ? new Response(opened.stream, { status: 200, headers: { ...NDJSON, "X-Ask-Run": id } }) : jsonResponse({ error: "Not found" }, 404);
  }
  contexts.set(req, context);
  const answered = api(req, context as never);
  // A reply that isn't streamed (an import, a plan's Go) also finishes if the app goes away.
  context.waitUntil(answered.then(() => undefined, () => undefined));
  return answered;
}
