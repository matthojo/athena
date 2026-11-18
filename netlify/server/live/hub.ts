/**
 * The live channel's open streams. Each client holds one Server-Sent Events
 * response; while at least one is open the hub polls the database's
 * watermarks (watch.ts) and tells every client which kinds changed. With no
 * client there is no timer and no query.
 *
 * Events:
 *   event: ready   data: {"marks":{<kind>:<mark>},"poll":<ms>}   once, on connect
 *   event: change  data: {"kind":<kind>,"ids":[…],"mark":<mark>} when a kind changed
 *   : hb                                                          every 15 s
 * Kinds, ids and opaque marks only; the app pulls the content through /api/*.
 */
import type { Change, LiveKind, Reading } from "./watch";

export interface HubOptions {
  /** The current watermarks. */
  read: () => Promise<Reading>;
  /** What changed between two readings. */
  changes: (prev: Reading, next: Reading) => Promise<Change[]>;
  pollMs?: number;
  heartbeatMs?: number;
  /** Open streams allowed at once: each takes one of the instance's concurrent requests. */
  maxClients?: number;
}

interface Client {
  send: (text: string) => void;
  close: () => void;
}

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createHub(options: HubOptions) {
  const pollMs = options.pollMs ?? 3000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxClients = options.maxClients ?? 8;
  const clients = new Set<Client>();
  let reading: Reading | null = null;
  let inFlight: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;
  let warnedAt = 0;

  const broadcast = (text: string) => clients.forEach((c) => c.send(text));

  /** One poll: read the watermarks and tell every client what moved since the last one. Never overlaps itself. */
  function tick(): Promise<void> {
    inFlight ??= (async () => {
      try {
        const next = await options.read();
        if (!clients.size) return;
        const prev = reading;
        reading = next;
        if (!prev) return;
        const changed = Object.keys(next.kinds).some((k) => prev.kinds[k as LiveKind] !== next.kinds[k as LiveKind]);
        if (!changed) return;
        for (const c of await options.changes(prev, next)) broadcast(frame("change", { kind: c.kind, ids: c.ids, mark: next.kinds[c.kind] }));
      } catch (error) {
        // The next poll tries again; say so at most once a minute, and never with a query's text.
        if (Date.now() - warnedAt > 60_000) {
          warnedAt = Date.now();
          console.warn("Athena live: reading watermarks failed:", error instanceof Error ? error.name : "unknown error");
        }
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function start() {
    if (pollTimer) return;
    pollTimer = setInterval(() => void tick(), pollMs);
    beatTimer = setInterval(() => broadcast(": hb\n\n"), heartbeatMs);
    // The open streams keep the instance up, not these timers.
    pollTimer.unref?.();
    beatTimer.unref?.();
  }

  function stop() {
    clearInterval(pollTimer);
    clearInterval(beatTimer);
    pollTimer = beatTimer = undefined;
    reading = null;
  }

  function drop(client: Client) {
    if (clients.delete(client) && !clients.size) stop();
  }

  /** A new stream, or null when the hub is full. `signal` is the request's: it aborts when the client goes away. */
  function open(signal?: AbortSignal): Response | null {
    if (clients.size >= maxClients) return null;
    let client: Client;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = {
          send(text) {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              drop(client);
            }
          },
          close() {
            drop(client);
            try {
              controller.close();
            } catch {}
          },
        };
        clients.add(client);
        start();
        signal?.addEventListener("abort", () => client.close(), { once: true });
        // A reading under one poll old is fresh enough; otherwise take one now.
        void (reading ? Promise.resolve() : tick()).then(() => {
          if (clients.has(client)) client.send(frame("ready", { marks: reading?.kinds ?? {}, poll: pollMs }));
        });
      },
      cancel() {
        drop(client);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
    });
  }

  /** End every stream (shutdown): clients reconnect and reach the next instance. */
  function closeAll() {
    for (const c of [...clients]) c.close();
  }

  return {
    open,
    closeAll,
    tick,
    get size() {
      return clients.size;
    },
    get polling() {
      return pollTimer !== undefined;
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
