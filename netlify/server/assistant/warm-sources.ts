/**
 * Ask's connected accounts, kept open between answers. As a function every
 * answer opened each account again (answer-sources.ts): a connection, an MCP
 * handshake and a tool listing per account before the first lookup. Here an
 * account opened for one answer is kept for the next ones in this instance.
 *
 * A kept account is only reused while nothing about it has changed and it's
 * recent:
 *  - its row is as it was when it opened (`updated_at`: a new sign-in, a
 *    refreshed or rotated token, a changed allowlist or switch all move it);
 *  - it opened less than MAX_AGE_MS ago, so a custom server's tools are
 *    re-listed and re-checked against what the owner approved at least that
 *    often (SECURITY.md §9).
 * Otherwise it's closed and opened afresh with the stored sign-in.
 *
 * A kept connection can still have gone stale: the platform closes outbound
 * connections after 60 quiet seconds, a server forgets a session, a token
 * runs out mid-way. So a lookup that fails on a kept account opens the
 * account again and is made once more; only that second failure reaches the
 * answer. Every tool here is a read (listAllowedTools drops writes), so
 * asking twice changes nothing.
 */
import { AthenaInputError } from "../../../lib/db";
import type { Connector } from "../../../lib/connectors";
import type { AnswerSourceDeps } from "../../lib/connectors/answer-sources";
import { callTool, ConnectorNeedsSignIn, listAllowedTools, openConnector, type ListedTool, type OpenConnector } from "../../lib/connectors/mcp-client";

export const MAX_AGE_MS = 10 * 60_000;

interface Kept {
  open: OpenConnector;
  stamp: string;
  at: number;
  /** Opened for an earlier answer, so it may have gone stale since. */
  reused: boolean;
  tools?: Promise<ListedTool[]>;
}

const stampOf = (row: Connector | undefined) => (row ? `${row.updated_at}|${row.status}|${row.allowed_tools.join(",")}` : "");

export function warmSources(deps: {
  open?: (id: string) => Promise<OpenConnector>;
  tools?: (open: OpenConnector) => Promise<ListedTool[]>;
  call?: (open: OpenConnector, tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  now?: () => number;
} = {}) {
  const open = deps.open ?? openConnector;
  const tools = deps.tools ?? listAllowedTools;
  const call = deps.call ?? callTool;
  const now = deps.now ?? Date.now;
  const kept = new Map<string, Promise<Kept>>();
  /** What an answer holds for an account: not the connection itself, so closing it closes nothing. */
  const handles = new WeakMap<OpenConnector, { id: string; row?: Connector; k: Kept }>();
  const stats = { opened: 0, reused: 0, reopened: 0 };

  function fresh(id: string, row: Connector | undefined): Promise<Kept> {
    stats.opened++;
    const entry = open(id).then((o): Kept => ({ open: o, stamp: stampOf(row), at: now(), reused: false }));
    kept.set(id, entry);
    entry.catch(() => kept.get(id) === entry && kept.delete(id));
    return entry;
  }

  const drop = (id: string, entry: Promise<Kept>) => {
    if (kept.get(id) === entry) kept.delete(id);
    void entry.then((k) => k.open.close()).catch(() => undefined);
  };

  /** A kept account failed: the one another answer has reopened since, or a new one. */
  async function reopen(h: { id: string; row?: Connector; k: Kept }): Promise<Kept> {
    const entry = kept.get(h.id);
    const current = entry ? await entry.catch(() => null) : null;
    if (current && current !== h.k) return (h.k = current);
    stats.reopened++;
    if (entry) drop(h.id, entry);
    return (h.k = await fresh(h.id, h.row));
  }

  /** Worth another go on a new connection: it was kept from an earlier answer, and the failure isn't the owner's to fix. */
  const stale = (k: Kept, error: unknown) => k.reused && !(error instanceof ConnectorNeedsSignIn) && !(error instanceof AthenaInputError);

  const source: Pick<AnswerSourceDeps, "open" | "tools" | "call"> = {
    async open(id, row) {
      const entry = kept.get(id);
      let k = entry ? await entry.catch(() => null) : null;
      if (k && k.stamp === stampOf(row) && now() - k.at < MAX_AGE_MS) {
        k.reused = true;
        stats.reused++;
      } else {
        if (entry) drop(id, entry);
        k = await fresh(id, row);
      }
      const handle = { ...k.open, close: async () => undefined } as OpenConnector;
      handles.set(handle, { id, row, k });
      return handle;
    },
    async tools(handle) {
      const h = handles.get(handle);
      if (!h) return tools(handle);
      const k = h.k;
      k.tools ??= tools(k.open);
      try {
        return await k.tools;
      } catch (error) {
        k.tools = undefined;
        if (!stale(k, error)) throw error;
        const again = await reopen(h);
        again.tools ??= tools(again.open);
        return again.tools.catch((e) => {
          again.tools = undefined;
          throw e;
        });
      }
    },
    async call(handle, tool, args) {
      const h = handles.get(handle);
      if (!h) return call(handle, tool, args);
      const k = h.k;
      try {
        return await call(k.open, tool, args);
      } catch (error) {
        if (!stale(k, error)) throw error;
        // An idle connection closed, a session or a token gone: open it again and ask once more.
        return call((await reopen(h)).open, tool, args);
      }
    },
  };

  return {
    source,
    stats,
    /** Shutdown: close every kept account. */
    async close(): Promise<void> {
      const all = [...kept.values()];
      kept.clear();
      await Promise.all(all.map((entry) => entry.then((k) => k.open.close()).catch(() => undefined)));
    },
  };
}
