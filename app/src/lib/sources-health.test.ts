// Run: npx tsx --test app/src/lib/sources-health.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { Connector, ConnectorsState } from "../types";

// The module pulls in styles through its components: load .css as nothing.
register("data:text/javascript," + encodeURIComponent(`export async function load(url, ctx, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, ctx); }`));
const g = globalThis as Record<string, unknown>;
g.window ??= { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, localStorage: { getItem: () => null, setItem() {} } };
g.localStorage ??= (g.window as { localStorage: unknown }).localStorage;
const { sourcesHealth } = await import("./sources-health");

const now = new Date().toISOString();
const connector = (more: Partial<Connector>): Connector => ({
  id: "c1", name: "Jellyfin", provider: "jellyfin", account_label: "", url: "https://jelly.example.com", auth_type: "token", scope: "personal",
  status: "connected", status_detail: "", tools: [], allowed_tools: [], tools_checked_at: now, last_used_at: now, server_info: {}, oauth: {},
  has_token: true, has_own_client: false, has_client_secret: false, created_at: now, updated_at: now, ...more,
});
const state = (connectors: Connector[]): ConnectorsState => ({ connectors, collections: [], setup: { encryption: true, ai: true, callback_url: "" } });

test("a server that's down: the headline doesn't repeat the card below it", () => {
  const h = sourcesHealth(state([connector({ status: "error", status_detail: "The server didn't answer." })]));
  const down = h.problems.find((p) => p.tone === "info");
  assert.ok(down, "a server that's down is something to wait for, not to fix");
  assert.equal(h.tone, "good");
  assert.equal(h.line, "Nothing needs you");
  assert.notEqual(h.line, down.title);
  assert.ok(!h.sub.includes("Nothing else needs you"));
});

test("connected, nothing collecting yet", () => {
  assert.equal(sourcesHealth(state([connector({})])).short, "Ready to collect");
});
