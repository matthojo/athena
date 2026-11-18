/**
 * The live channel's connection (server: netlify/server/routes/live.ts).
 * One fetch-streamed Server-Sent Events response, read with the app's bearer
 * token in the Authorization header (EventSource can't send one). Open only
 * while the app is visible, online and signed in; closed as soon as it's
 * hidden, so the server can stop when nobody is looking. A broken stream is
 * retried with backoff. Nothing here touches the DOM: index.ts wires it up.
 */

export interface LiveEvent {
  event: string;
  data: string;
}

/** Reads a text/event-stream body piece by piece. `feed` returns the events completed by that piece; comment lines (heartbeats) are dropped. */
export function sseReader(): { feed: (chunk: string) => LiveEvent[] } {
  let buffer = "";
  return {
    feed(chunk) {
      buffer += chunk.replace(/\r\n?/g, "\n");
      const events: LiveEvent[] = [];
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) events.push({ event, data: data.join("\n") });
      }
      return events;
    },
  };
}

/** How long to wait before try number `attempt` (0 = the first retry): 1 s doubling to a minute, with jitter so it never settles into a beat. */
export function backoffMs(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 10)) * (0.5 + random / 2));
}

export interface LiveEnv {
  fetch: typeof fetch;
  token: () => string | null;
  visible: () => boolean;
  online: () => boolean;
  /** A kind changed somewhere else; `ids` may be empty (a delete, or a change made while the stream was closed). */
  onChange: (kind: string, ids: string[]) => void;
  url?: string;
  random?: () => number;
  /** Silence longer than this means the stream is dead (the server sends a heartbeat every 15 s). */
  quietMs?: number;
}

export function createLiveClient(env: LiveEnv) {
  const url = env.url ?? "/api/live/events";
  const quietMs = env.quietMs ?? 45_000;
  /** The server's mark per kind, as last heard: a different one on reconnect means that kind changed while we were away. */
  const marks = new Map<string, string>();
  let ctrl: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  /** The server refused the token: don't loop; the next visibility or network change tries again. */
  let refused = false;

  const wanted = () => env.visible() && env.online() && !!env.token();

  function handle(e: LiveEvent) {
    let body: { marks?: Record<string, string>; kind?: string; ids?: string[]; mark?: string };
    try {
      body = JSON.parse(e.data);
    } catch {
      return;
    }
    if (e.event === "ready") {
      attempt = 0;
      for (const [kind, mark] of Object.entries(body.marks ?? {})) {
        if (marks.has(kind) && marks.get(kind) !== mark) env.onChange(kind, []);
        marks.set(kind, mark);
      }
    } else if (e.event === "change" && typeof body.kind === "string") {
      if (body.mark) marks.set(body.kind, body.mark);
      env.onChange(body.kind, Array.isArray(body.ids) ? body.ids : []);
    }
  }

  /** One connection, start to finish. Resolves with the wait before the next try, or null to stop until something changes. */
  async function run(signal: AbortSignal, abort: () => void): Promise<number | null> {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await env.fetch(url, { headers: { Authorization: `Bearer ${env.token()}`, Accept: "text/event-stream" }, cache: "no-store", signal });
      if (res.status === 401 || res.status === 403) {
        refused = true;
        return null;
      }
      if (!res.ok || !res.body) {
        const after = Number(res.headers.get("Retry-After")) * 1000;
        return Math.max(Number.isFinite(after) ? after : 0, backoffMs(attempt++, env.random?.()));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const sse = sseReader();
      for (;;) {
        clearTimeout(quiet);
        quiet = setTimeout(abort, quietMs);
        const { value, done } = await reader.read();
        if (done) break;
        for (const e of sse.feed(decoder.decode(value, { stream: true }))) handle(e);
      }
    } catch {
      // Aborted, offline, or cut off: all the same from here.
    } finally {
      clearTimeout(quiet);
    }
    return backoffMs(attempt++, env.random?.());
  }

  function disconnect() {
    clearTimeout(retry);
    retry = undefined;
    const open = ctrl;
    ctrl = null;
    open?.abort();
  }

  /** Bring the connection in line with the world: call on visibility, network and sign-in changes. */
  function sync(changed = true) {
    if (changed) refused = false;
    if (!wanted() || refused) return disconnect();
    if (ctrl || retry) return;
    const mine = (ctrl = new AbortController());
    void run(mine.signal, () => mine.abort()).then((wait) => {
      if (ctrl !== mine) return;
      ctrl = null;
      if (wait === null || !wanted()) return;
      retry = setTimeout(() => {
        retry = undefined;
        sync(false);
      }, wait);
    });
  }

  return {
    sync,
    stop: disconnect,
    get connected() {
      return ctrl !== null;
    },
  };
}
