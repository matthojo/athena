/**
 * M3: Sign out removes the key, the offline database, every athena-* cache,
 * the push subscription and the service worker.
 * Run: npx tsx --test app/src/db/sign-out.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
const { wipeDevice } = await import("./sign-out");
type Env = NonNullable<Parameters<typeof wipeDevice>[0]>;

function device(over: Partial<Env> = {}) {
  const log: string[] = [];
  const cacheNames = new Set(["athena-shell-v6", "athena-files-v1", "athena-share", "athena-link-previews-v1", "someone-elses"]);
  const sub = {
    endpoint: "https://push.example/abc",
    unsubscribe: async () => (log.push("push:unsubscribe"), true),
  };
  const env: Env = {
    localStorage: { clear: () => void log.push("localStorage:clear") },
    sessionStorage: { clear: () => void log.push("sessionStorage:clear") },
    caches: {
      keys: async () => [...cacheNames],
      delete: async (name: string) => (log.push(`cache:${name}`), cacheNames.delete(name)),
    },
    serviceWorker: {
      getRegistrations: async () => [{ pushManager: { getSubscription: async () => sub } as any, unregister: async () => (log.push("worker:unregister"), true) }],
    },
    forgetPush: async (endpoint) => void log.push(`server:forget ${endpoint}`),
    removeKey: async () => void log.push("server:remove-key"),
    deleteDatabases: async () => void log.push("db:delete"),
    ...over,
  };
  return { env, log, cacheNames };
}

test("removes the key, database, athena-* caches, push subscription and worker", async () => {
  const { env, log, cacheNames } = device();
  await wipeDevice(env);
  for (const step of ["server:remove-key", "server:forget https://push.example/abc", "push:unsubscribe", "localStorage:clear", "sessionStorage:clear", "db:delete", "worker:unregister"]) assert.ok(log.includes(step), step);
  assert.deepEqual([...cacheNames], ["someone-elses"], "every athena-* cache is gone, and nothing else");
});

test("the server forgets the push endpoint while the key is still here", async () => {
  const { env, log } = device();
  await wipeDevice(env);
  assert.ok(log.indexOf("server:forget https://push.example/abc") < log.indexOf("localStorage:clear"));
  assert.ok(log.indexOf("push:unsubscribe") < log.indexOf("worker:unregister"));
});

test("the server removes this device's key after the push endpoint and before the key is dropped here", async () => {
  const { env, log } = device();
  await wipeDevice(env);
  assert.ok(log.indexOf("server:forget https://push.example/abc") < log.indexOf("server:remove-key"));
  assert.ok(log.indexOf("server:remove-key") < log.indexOf("localStorage:clear"));
});

test("one failing step doesn't stop the rest", async () => {
  const { env, log, cacheNames } = device({
    forgetPush: async () => {
      throw new Error("offline");
    },
    removeKey: async () => {
      throw new Error("offline");
    },
    deleteDatabases: async () => {
      throw new Error("blocked");
    },
  });
  await wipeDevice(env);
  assert.ok(log.includes("push:unsubscribe"));
  assert.ok(log.includes("localStorage:clear"));
  assert.ok(log.includes("worker:unregister"));
  assert.deepEqual([...cacheNames], ["someone-elses"]);
});

test("a browser with no worker or Cache Storage still loses its key and database", async () => {
  const { env, log } = device({ caches: undefined, serviceWorker: undefined });
  await wipeDevice(env);
  assert.deepEqual(log, ["server:remove-key", "localStorage:clear", "sessionStorage:clear", "db:delete"]);
});
